# nemlig-mcp

An MCP server that shops groceries at [Nemlig.com](https://www.nemlig.com). It runs
as a plain Docker container on the homelab and speaks MCP over streamable HTTP, so
any MCP client on the LAN — Claude Code, Claude Desktop, or the shopping app that
comes later — can point at one URL and use it.

This is a port of an Azure Functions prototype. Same idea, none of the Azure.

## How it works

Nemlig has no public API and no way to get a token with an HTTP call: logging in
means running their JavaScript login form. So the server drives a headless
Chromium once, catches the JWT that the form's token request returns, keeps the
cookies it set alongside it, and calls it a **session**.

Everything after that is ordinary `fetch` against Nemlig's web API, reusing that
token. Sessions are written to `/data/sessions.json` (mode `0600`), so a container
restart does not cost a fresh login either.

Two things about that login are worth knowing, because both cost real debugging:

**A token is not a session.** Nemlig issues the JWT *before* it finishes
establishing the website session that account-scoped endpoints read. Snapshot the
cookies in between and you get a token that authenticates while the basket and
favourites come back empty — as an anonymous visitor, with no error. So login is
not considered done until a page reports a `Settings.UserId`. That check also
yields everything else that used to be hardcoded — the customer id, the
cache-busting build stamp, and the favourites list id — from the one request we
were already making.

**Tokens last five minutes, and expiry does not fail loudly.** An expired token
gets the same silent anonymous treatment: `200`, empty basket, nothing wrong on
the wire. Waiting for a `401` would never fire, so expiry is read from the JWT's
own `exp` and the token is replaced before the call goes out.

**Refreshing needs no browser.** The JWT is a *service-account* credential —
`preferred_username` is `service-account-sitecore`, and the `/webapi/Token`
endpoint hands one out to anyone. The account is identified by a cookie, not the
token: `.ASPXAUTH`, an ordinary forms-auth ticket good for a year. So an expiring
token costs one GET carrying the stored cookies, and only a lapsed cookie jar
falls back to a Chromium launch. Measured: ~280 ms versus ~6–10 s.

```
MCP client ──HTTP──► /mcp ──► session manager ──► Nemlig web API (fetch + JWT)
                                     │
                                     └─ first call only ─► Playwright ─► login form
```

## Tools

| Tool | What it does |
| --- | --- |
| `new_session` | Logs in and returns a `sessionId`. |
| `get_basket` | The current basket, including its delivery slot. |
| `search_products` | Searches the catalogue (Danish terms) for a product id. |
| `get_favourite_products` | The account's frequently bought products. |
| `get_favourites_on_offer` | Those of them currently on promotion, with the offer described. |
| `set_basket_quantity` | Sets a line to an exact quantity; 0 removes it. The primitive. |
| `add_to_basket` | Adds on top of whatever is already there. |
| `remove_from_basket` | Takes items back out; omit the quantity to clear the line. |
| `end_session` | Forgets a session and its stored token. |

`sessionId` is optional everywhere except `end_session`: omit it and the server
reuses the account's most recent session, or starts one. Search and favourites
both need the basket's delivery slot to return real prices and stock, so the
server fetches the basket once per session and caches it — `add_to_basket`
invalidates that cache.

`get_favourites_on_offer` is derived from the favourites list rather than from
Nemlig's site-wide `/tilbud` page: that page is every offer in the shop and says
nothing about whether this household buys the product. Each result carries an
`offer` with a shelf-edge description ("3 for 15 kr", "40% off") plus the
structured `minQuantity` / `offerPrice` / `savings`, because multi-buy offers only
apply at their quantity — a single item is still full price.

**`AddToBasket` sets, it does not add.** Posting `Quantity: 3` makes the line three
however many were on it before, and anything at or below zero removes it — the name
is a lie, measured against the live API. So both basket tools read the current
quantity first and send the absolute value they want. Without that, `add_to_basket(1)`
twice leaves you with one item and no error, which is exactly what it used to do.

Nothing here checks out an order. The basket is as far as it goes, on purpose.

## Configuration

Credentials come from the container's environment by default, and an MCP client
may override them per request with `X-Nemlig-Username` / `X-Nemlig-Password`. Only
the resulting token is ever written to disk, filed under a hash of the username —
a session started by one account is never handed to another.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEMLIG_USERNAME` / `NEMLIG_PASSWORD` | — | The default account. Omit both to make the server header-only. |
| `NEMLIG_ALLOW_HEADER_CREDENTIALS` | `true` | Set `false` to pin the server to the env account. |
| `NEMLIG_HEADLESS` | `true` | See *Headless and bot checks* below. |
| `NEMLIG_LOGIN_TIMEOUT_MS` | `60000` | How long to wait for the token response. |
| `NEMLIG_SESSION_READY_TIMEOUT_MS` | `20000` | How long to wait for the site to stop treating us as anonymous. |
| `NEMLIG_REFRESH_MARGIN_MS` | `45000` | Re-authenticate this long before the five-minute token expires. |
| `NEMLIG_SESSION_TTL_MS` | `604800000` (7 days) | Untouched sessions are pruned hourly. |
| `NEMLIG_DATA_DIR` | `/data` | Where `sessions.json` lives. |
| `NEMLIG_FAVOURITES_HEADING` | `favoritter` | Pattern matching the favourites list's heading on the probe page. |
| `NEMLIG_FAVOURITES_GROUP_ID` | — | Pins the favourites list id and skips discovery. Escape hatch only. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address. |

`.env.example` has the rest.

## Running it

```bash
cp .env.example .env   # fill in NEMLIG_USERNAME and NEMLIG_PASSWORD
docker compose up -d --build
```

The endpoint is then `http://<host>:8089/mcp`, with `/health` alongside it. To run
the image CI publishes instead of building locally, use `deploy/docker-compose.yml`.

There is **no authentication on the MCP endpoint** — it is LAN-only by design. Put
a Cloudflare tunnel with Access in front of it if it ever needs to leave the house.

### Pointing a client at it

```bash
claude mcp add --transport http nemlig http://<host>:8089/mcp
```

Or, to use a different account than the container's:

```bash
claude mcp add --transport http nemlig http://<host>:8089/mcp \
  --header "X-Nemlig-Username: you@example.com" \
  --header "X-Nemlig-Password: ..."
```

### Developing

```bash
npm install
npx playwright install chromium   # only needed to exercise a real login
npm run dev
npm test
```

The tests run every tool end to end over streamable HTTP against a fake Nemlig,
with the browser login stubbed — including token expiry, the retry, and a
restart. No network and no browser required.

## Known fragility

This talks to a private API by pretending to be the website, so it breaks when
the website changes. The two places that will go first:

- **The login flow.** `src/nemlig/login.ts` fills `[name='userEmail']` and
  `[name='userPassword']` and waits for `POST /webapi/Token`. If Nemlig redesigns
  the login page, that is the file to fix.
- **The favourites list's heading.** The list is found on the probe page by its
  heading — "Har du husket dine favoritter?" — rather than by its Sitecore id,
  because the id is the thing that changes on a republish. Discovery runs on every
  login, so a new id heals itself within one token lifetime. If Nemlig rewrites the
  Danish copy instead, login fails with the headings it actually found; set
  `NEMLIG_FAVOURITES_HEADING` to match the new wording, or
  `NEMLIG_FAVOURITES_GROUP_ID` to pin the id and skip discovery.

### Headless and bot checks

The original prototype ran real Chrome with a visible window, which is the most
likely thing to survive a bot check. A container has no display, so this runs
headless Chromium with a normal user agent. If Nemlig ever refuses that, the
options are `NEMLIG_HEADLESS=false` with an X server in the container, or running
the login on a machine that has a display. It has not been a problem so far, but
it is the assumption most likely to break.

### The session file is a credential

`/data/sessions.json` stores each session's `.ASPXAUTH` cookie, which is a
year-long authenticator for the account — functionally as sensitive as the
password. It is written `0600`, but treat the data volume accordingly: anyone who
can read that file can act as the account until the cookie expires or the password
changes. This is also why credentials themselves are never written: only the
resulting cookie is, filed under a hash of the username.

## Upgrading Playwright

`package.json` pins Playwright exactly and the Dockerfile pins the matching
`mcr.microsoft.com/playwright:v<version>-noble` base image. Bump both in the same
commit, or the container will try to download a browser it has no room for.
