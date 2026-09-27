# nemlig-mcp

An MCP server that shops groceries at [Nemlig.com](https://www.nemlig.com). It runs
as a plain Docker container on the homelab and speaks MCP over streamable HTTP, so
any MCP client on the LAN — Claude Code, Claude Desktop, or the shopping app that
comes later — can point at one URL and use it.

This is a port of an Azure Functions prototype. Same idea, none of the Azure.

## How it works

Nemlig has no public API. The website's login looks like a JavaScript form, but
all it does is `POST /webapi/login` with a small JSON body — which sets an
`.ASPXAUTH` cookie — so the server logs in with a plain `fetch`, no browser. From
there it's ordinary `fetch` against Nemlig's web API. A login plus the resulting
token and cookies is a **session**.

The token and its cookies live in memory, keyed by session id; only non-secret
metadata is written to `/data/sessions.json`, so the session id keeps working
across a restart even though the credential itself does not persist.

Two things about the token are worth knowing, because both cost real debugging:

**The token carries the customer, and the cookie carries the token.** The JWT is a
service-account credential — `preferred_username` is `service-account-sitecore`,
and `/webapi/Token` hands one out to anyone. Only when it is fetched with the
`.ASPXAUTH` cookie does it gain the customer's `debitorId`, and the `productbff`
API resolves favourites from exactly that claim. So login fetches the token until
it comes back carrying a `debitorId`: that claim is both the proof the session is
really authenticated and the thing the bff needs. Without it every account-scoped
call comes back empty, as an anonymous visitor, with no error.

**Tokens last five minutes, and expiry does not fail loudly.** An expired token
gets that same silent anonymous treatment: `200`, empty basket, nothing wrong on
the wire. Waiting for a `401` would never fire, so expiry is read from the JWT's
own `exp` and the token is refreshed before the call goes out. Refreshing is just
another `/webapi/Token` GET with the stored `.ASPXAUTH` (good for a year), so it
costs one request; only a lapsed cookie forces a full re-login.

```
MCP client ──HTTP──► /mcp ──► session manager ──► Nemlig web API (fetch + JWT)
                                     │
                                     └─ first call only ─► POST /webapi/login
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

Favourites come from Nemlig's `productbff` API — the customer-aware backend the new
site uses — which returns the whole favourites page. `get_favourite_products` is
every favourite across its category sections, de-duplicated; `get_favourites_on_offer`
is the "Favoritter på tilbud" section, Nemlig's own curation of which favourites are
discounted. Each offer's `description` is Nemlig's shelf-edge wording verbatim, in
Danish ("3 stk. 15,-", "Spar 40 procent"), alongside structured `minQuantity`,
`offerPrice`, `savings` and `percent` for a caller that would rather compute than
read. Multi-buy deals only reach their price at `minQuantity`.

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
| `NEMLIG_SESSION_READY_TIMEOUT_MS` | `20000` | How long to keep re-minting the token after login while the `debitorId` appears. |
| `NEMLIG_REFRESH_MARGIN_MS` | `45000` | Re-authenticate this long before the five-minute token expires. |
| `NEMLIG_SESSION_TTL_MS` | `604800000` (7 days) | Untouched sessions are pruned hourly. |
| `NEMLIG_DATA_DIR` | `/data` | Where `sessions.json` lives. |
| `NEMLIG_BFF_BASE_URL` | `https://webapi.prod.knl.nemlig.it` | Host of the productbff favourites API. |
| `NEMLIG_BFF_FAVOURITES_PATH` | `/favoritter` | Page path the favourites are read from. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address. |

`.env.example` has the rest.

## Running it

```bash
cp .env.example .env   # fill in NEMLIG_USERNAME and NEMLIG_PASSWORD
docker compose up -d --build
```

That builds from this working copy and publishes the server directly on
`http://<host>:8089/mcp`, with `/health` alongside it — the short path for
developing on the image.

On the homelab it publishes no port at all. `deploy/docker-compose.yml` runs the
image CI builds, joins the shared `apps-net` network, and is reached only through
the Caddy reverse proxy that fronts that host:

```bash
docker network create apps-net   # once per host
docker compose -f deploy/docker-compose.yml up -d
```

The endpoint is then `https://<host>/nemlig/mcp`. Keeping the port unpublished is
the point: MCP clients require HTTPS even on the LAN, and a published port would
leave the plaintext endpoint reachable beside the encrypted one.

There is **no authentication on the MCP endpoint** — it is LAN-only by design, and
the proxy adds TLS, not access control. Put a Cloudflare tunnel with Access in
front of it if it ever needs to leave the house.

### Behind the proxy

Caddy terminates TLS with its own internal CA and strips the path prefix, so the
server still sees `/mcp`:

```caddyfile
<host> {
	tls internal

	handle_path /nemlig/* {
		reverse_proxy nemlig-mcp:8080 {
			# Streamable HTTP holds an SSE channel open; never buffer it.
			flush_interval -1
		}
	}
}
```

`flush_interval -1` is not optional. Without it the proxy buffers the SSE channel
and the client connects and then hangs, with no error on either side.

Because that CA is Caddy's own, clients have to be told to trust its root. Export
it once from the host's Caddy:

```bash
docker cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

### Pointing a client at it

```bash
claude mcp add --transport http nemlig https://<host>/nemlig/mcp
```

MCP clients here run on Node, which does not read the OS trust store by default, so
the root has to be named explicitly: `NODE_EXTRA_CA_CERTS=/path/to/caddy-root.crt`
in the client's environment. In Claude Desktop that goes in the server's own `env`
block in `claude_desktop_config.json` — which is also what makes a separate CA per
host workable, since the variable takes a single file path and not a list.

Or, to use a different account than the container's:

```bash
claude mcp add --transport http nemlig https://<host>/nemlig/mcp \
  --header "X-Nemlig-Username: you@example.com" \
  --header "X-Nemlig-Password: ..."
```

### Developing

```bash
npm install
npm run dev
npm test
```

The tests run every tool end to end over streamable HTTP against a fake Nemlig —
including the HTTP login, token expiry, the refresh, and a restart. No network, no
browser, nothing to install beyond the npm dependencies.

## Known fragility

This talks to a private API by pretending to be the website, so it breaks when
the website changes. The places that will go first:

- **The login call.** `src/nemlig/login.ts` posts `/webapi/login` with
  `{Username, Password, …}` and expects an `.ASPXAUTH` cookie back. If Nemlig
  changes that endpoint — or fronts it with a bot check — that is the file to fix,
  and the point where a browser-driven login might have to come back.
- **The `debitorId` in the token.** Favourites only resolve because `/webapi/Token`,
  called with `.ASPXAUTH`, embeds the customer's `debitorId`, which the bff reads.
  Login treats a token without a `debitorId` as a failed login rather than pressing
  on anonymously. If Nemlig stops enriching the token, favourites break loudly here
  rather than silently returning nothing.
- **The `productbff` favourites shape.** `src/nemlig/bff.ts` reads `pageContent`
  sections of products with `price` (øre), `certificates`, `campaignLines` and
  `campaignBadge`. A redesign of that response is what would break favourites next.

### The credential stays in memory

The `.ASPXAUTH` cookie is a year-long authenticator for the account — as sensitive
as the password — so it is never written to disk. It is held in memory, keyed by
session id, alongside the short-lived token. `/data/sessions.json` holds only
`{id, accountHash, createdAt, lastUsedAt}`: enough to keep a session id valid, and
useless to anyone who reads the file.

The cost is that a container restart drops the in-memory secret, so the next call
on each session logs in again (from the env credentials, or from the client's
headers). That is one HTTP login per active account per restart — a fraction of a
second, and a fair price for keeping a year-long credential off the volume.

An older `sessions.json` that still holds cookies is detected by its version and
scrubbed on startup, so upgrading to this version removes any credential the
previous one had left on disk.
