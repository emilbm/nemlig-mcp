import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFakeLogin, createFakeRefresh, startFakeNemlig } from './fake-nemlig.mjs';

/** Tool results are JSON in a text block; unwrap that once here. */
function payload(result) {
  assert.equal(result.isError, undefined, `tool returned an error: ${JSON.stringify(result.content)}`);
  return JSON.parse(result.content[0].text);
}

describe('nemlig-mcp over streamable HTTP', () => {
  let nemlig;
  let login;
  let refresh;
  let app;
  let sessions;
  let dataDir;
  let endpoint;

  before(async () => {
    nemlig = await startFakeNemlig();
    dataDir = await mkdtemp(join(tmpdir(), 'nemlig-mcp-test-'));

    // config.ts reads the environment once, at import time.
    process.env.NEMLIG_WEB_BASE_URL = nemlig.baseUrl;
    process.env.NEMLIG_SEARCH_BASE_URL = nemlig.baseUrl;
    process.env.NEMLIG_BFF_BASE_URL = nemlig.baseUrl;
    process.env.NEMLIG_DATA_DIR = dataDir;
    process.env.NEMLIG_USERNAME = 'shopper@example.com';
    process.env.NEMLIG_PASSWORD = 'hunter2';
    process.env.LOG_LEVEL = 'silent';

    const { SessionStore } = await import('../dist/src/store.js');
    const { SessionManager } = await import('../dist/src/sessions.js');
    const { createHttpServer } = await import('../dist/src/server.js');

    login = createFakeLogin(nemlig);
    refresh = createFakeRefresh(nemlig, login);
    sessions = new SessionManager({ store: await SessionStore.open(dataDir), login, refresh, ttlMs: 60_000 });
    app = createHttpServer(sessions);
    await app.listen({ host: '127.0.0.1', port: 0 });
    endpoint = new URL('/mcp', `http://127.0.0.1:${app.server.address().port}`);
  });

  after(async () => {
    await app?.close();
    await nemlig?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function connect(headers) {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(endpoint, headers ? { requestInit: { headers } } : undefined));
    return client;
  }

  it('advertises the ported tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'add_to_basket',
      'end_session',
      'get_basket',
      'get_favourite_products',
      'get_favourites_on_offer',
      'new_session',
      'remove_from_basket',
      'search_products',
      'set_basket_quantity',
    ]);
    await client.close();
  });

  it('logs in once per session and reuses the token across calls', async () => {
    const client = await connect();
    const before = login.count;

    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    assert.match(sessionId, /^[0-9a-f]{12}$/);
    assert.equal(login.count, before + 1);

    await client.callTool({ name: 'get_basket', arguments: { sessionId } });
    await client.callTool({ name: 'search_products', arguments: { sessionId, searchterm: 'tomater' } });
    assert.equal(login.count, before + 1, 'a second call must not trigger another browser login');

    await client.close();
  });

  it('searches with the basket delivery slot so prices and stock are real', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    const result = payload(
      await client.callTool({ name: 'search_products', arguments: { sessionId, searchterm: 'tomater' } }),
    );

    assert.equal(result.products.length, 1);
    assert.deepEqual(result.products[0], {
      id: '5012345',
      name: 'tomater økologiske 500g',
      price: 24.95,
      inStock: true,
      deliverable: true,
      labels: ['Økologi'],
    });

    const search = nemlig.pathsHit('/searchgateway/api/search').at(-1);
    assert.equal(search.query.timeslotUtc, '2026-09-20T10:00:00Z');
    assert.equal(search.query.deliveryZoneId, '7');
    assert.equal(search.query.TimeSlotId, 'slot-42');
    await client.close();
  });

  it('returns every favourite from the productbff, deduped across sections', async () => {
    const client = await connect();
    const result = payload(await client.callTool({ name: 'get_favourite_products', arguments: {} }));

    // Hvidløg appears in both the on-offer and the category section; it should
    // surface once, and the full-price Banan from the category section should be there.
    const ids = result.products.map((p) => p.id).sort();
    assert.deepEqual(ids, ['100160', '2301138', '5046029', '5069520']);

    const banan = result.products.find((p) => p.id === '2301138');
    assert.equal(banan.name, 'Banan');
    assert.equal(banan.price, 2.5, 'øre are converted to kroner');
    assert.equal(banan.offer, undefined, 'a full-price product carries no offer');

    const soldOut = result.products.find((p) => p.id === '5069520');
    assert.equal(soldOut.inStock, false, 'availability type SoldOut maps to out of stock');

    // The request really went to the bff with the basket's timeslot.
    const hit = nemlig.pathsHit('/productbff/api/web/page').at(-1);
    assert.equal(hit.query.path, '/favoritter');
    assert.equal(hit.query.timeslotId, 'slot-42');
    await client.close();
  });

  it('returns the on-offer favourites with the shelf-edge wording from Nemlig', async () => {
    const client = await connect();
    const offers = payload(await client.callTool({ name: 'get_favourites_on_offer', arguments: {} }));

    assert.equal(offers.products.length, 3, 'the "Favoritter på tilbud" section, and only it');
    assert.ok(offers.products.every((p) => p.offer), 'every product on the list carries its offer');

    const described = Object.fromEntries(offers.products.map((p) => [p.name, p.offer]));
    // Multi-buy: the description is Nemlig's shelf text, with the quantity parsed out.
    assert.equal(described['Hvidløg øko.'].description, '3 stk. 15,-');
    assert.equal(described['Hvidløg øko.'].minQuantity, 3);
    assert.equal(described['Hvidløg øko.'].offer, undefined);
    // Percent discount: percent and the discounted unit price come through as numbers.
    assert.equal(described['Farfalle'].description, 'Spar 40 procent');
    assert.equal(described['Farfalle'].percent, 40);
    assert.equal(described['Farfalle'].savings, 12.7);
    assert.equal(described['Farfalle'].offerPrice, 19.05);
    // Straight discount.
    assert.equal(described['Kyllingebrystfilet'].description, 'Spar 32,95 kroner');
    assert.equal(described['Kyllingebrystfilet'].savings, 32.95);
    await client.close();
  });

  it('adds to the basket and refreshes the cached basket afterwards', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));

    payload(await client.callTool({ name: 'get_basket', arguments: { sessionId } }));
    const added = payload(
      await client.callTool({ name: 'add_to_basket', arguments: { sessionId, productId: '5012345', quantity: 2 } }),
    );
    assert.deepEqual(added.added, { productId: '5012345', added: 2, quantity: 2 });

    const refreshed = payload(await client.callTool({ name: 'get_basket', arguments: { sessionId } }));
    assert.equal(refreshed.basket.Lines.at(-1).ProductId, '5012345');
    assert.equal(refreshed.basket.Lines.at(-1).Quantity, 2, 'a stale cached basket must not be served after a write');
    await client.close();
  });

  it('sets a line to an exact quantity, and clears it at zero', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    const qty = async () => {
      const basket = payload(await client.callTool({ name: 'get_basket', arguments: { sessionId } })).basket;
      return basket.Lines.find((l) => l.Id === '700020')?.Quantity ?? 0;
    };

    const set3 = payload(
      await client.callTool({ name: 'set_basket_quantity', arguments: { sessionId, productId: '700020', quantity: 3 } }),
    );
    assert.deepEqual({ was: set3.line.was, quantity: set3.line.quantity }, { was: 0, quantity: 3 });
    assert.equal(await qty(), 3);

    // Setting is absolute, so asking for 1 when there are 3 means one, not four.
    const set1 = payload(
      await client.callTool({ name: 'set_basket_quantity', arguments: { sessionId, productId: '700020', quantity: 1 } }),
    );
    assert.deepEqual({ was: set1.line.was, quantity: set1.line.quantity }, { was: 3, quantity: 1 });
    assert.equal(await qty(), 1);

    payload(
      await client.callTool({ name: 'set_basket_quantity', arguments: { sessionId, productId: '700020', quantity: 0 } }),
    );
    assert.equal(await qty(), 0, 'zero clears the line');
    await client.close();
  });

  it('skips the write when the quantity already matches', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    await client.callTool({ name: 'set_basket_quantity', arguments: { sessionId, productId: '700021', quantity: 2 } });
    const before = nemlig.pathsHit('/webapi/basket/AddToBasket').length;

    await client.callTool({ name: 'set_basket_quantity', arguments: { sessionId, productId: '700021', quantity: 2 } });
    assert.equal(nemlig.pathsHit('/webapi/basket/AddToBasket').length, before, 'a no-op set should not write');
    await client.close();
  });

  it('adds cumulatively, even though the endpoint underneath sets an absolute quantity', async () => {
    // Nemlig's AddToBasket assigns the quantity rather than incrementing it, so
    // calling add(1) twice used to leave one item. Read-then-set fixes that.
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));

    const first = payload(
      await client.callTool({ name: 'add_to_basket', arguments: { sessionId, productId: '700009', quantity: 1 } }),
    );
    assert.deepEqual(first.added, { productId: '700009', added: 1, quantity: 1 });

    const second = payload(
      await client.callTool({ name: 'add_to_basket', arguments: { sessionId, productId: '700009', quantity: 1 } }),
    );
    assert.equal(second.added.quantity, 2, 'a second add must build on what was already there');

    const basket = payload(await client.callTool({ name: 'get_basket', arguments: { sessionId } })).basket;
    assert.equal(basket.Lines.find((l) => l.Id === '700009').Quantity, 2);

    // And the absolute value really did go over the wire, not a delta.
    const sent = JSON.parse(nemlig.pathsHit('/webapi/basket/AddToBasket').at(-1).body);
    assert.equal(sent.Quantity, 2);
    await client.close();
  });

  it('removes part of a line, and the whole line when no quantity is given', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    const lines = async () =>
      payload(await client.callTool({ name: 'get_basket', arguments: { sessionId } })).basket.Lines;

    await client.callTool({ name: 'add_to_basket', arguments: { sessionId, productId: '700001', quantity: 3 } });

    const partial = payload(
      await client.callTool({ name: 'remove_from_basket', arguments: { sessionId, productId: '700001', quantity: 1 } }),
    );
    assert.equal(partial.removed.removed, 1);
    assert.equal(partial.removed.remaining, 2);
    assert.equal((await lines()).find((l) => l.Id === '700001').Quantity, 2);

    // No quantity means take the whole line out, however many are on it.
    const all = payload(
      await client.callTool({ name: 'remove_from_basket', arguments: { sessionId, productId: '700001' } }),
    );
    assert.equal(all.removed.removed, 2);
    assert.equal(all.removed.remaining, 0);
    assert.equal(
      (await lines()).find((l) => l.Id === '700001'),
      undefined,
      'the line should be gone from the basket',
    );
    await client.close();
  });

  it('clamps an over-large removal instead of driving the quantity negative', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    await client.callTool({ name: 'add_to_basket', arguments: { sessionId, productId: '700002', quantity: 2 } });

    const result = payload(
      await client.callTool({ name: 'remove_from_basket', arguments: { sessionId, productId: '700002', quantity: 99 } }),
    );
    assert.equal(result.removed.removed, 2, 'only what was actually in the basket comes out');
    assert.equal(result.removed.remaining, 0);

    const sent = nemlig.pathsHit('/webapi/basket/AddToBasket').at(-1);
    assert.ok(sent, 'a removal should still reach Nemlig');
    await client.close();
  });

  it('refuses to remove something that is not in the basket', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'remove_from_basket',
      arguments: { productId: 'not-in-basket' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not in the basket/);
    await client.close();
  });

  it('carries both the bearer token and the login cookies', async () => {
    const client = await connect();
    await client.callTool({ name: 'get_basket', arguments: {} });
    const request = nemlig.pathsHit('/webapi/basket/GetBasket').at(-1);
    assert.match(request.headers.authorization, /^Bearer token-\d+$/);
    assert.match(request.headers.cookie, /^sid=cookie-\d+$/);
    await client.close();
  });

  it('re-authenticates and retries when Nemlig rejects the token mid-call', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    const logins = login.count;
    const refreshes = refresh.count;

    nemlig.expireTokens();
    const result = payload(
      await client.callTool({ name: 'search_products', arguments: { sessionId, searchterm: 'agurk' } }),
    );

    assert.equal(refresh.count, refreshes + 1, 'a rejected token is replaced from cookies');
    assert.equal(login.count, logins, 'which costs no browser launch');
    assert.equal(result.products.length, 1, 'and the call succeeds on the retry rather than surfacing the 401');
    await client.close();
  });

  it('re-authenticates before the token expires, without waiting for a 401', async () => {
    // Nemlig answers an expired token as an anonymous visitor: 200, empty basket,
    // empty favourites. Nothing ever returns 401, so expiry has to be caught from
    // the JWT's own exp before the call goes out.
    const client = await connect();
    login.lifetimeMs = 10_000; // inside the refresh margin, so already due
    try {
      const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
      const before = refresh.count;

      payload(await client.callTool({ name: 'get_basket', arguments: { sessionId } }));

      assert.equal(refresh.count, before + 1, 'a token inside the refresh margin must be replaced up front');
    } finally {
      login.lifetimeMs = 5 * 60 * 1000;
      await client.close();
    }
  });

  it('refreshes an expired token from cookies, without launching a browser', async () => {
    // The JWT is a service-account credential; the cookies identify the customer
    // and last a year. So expiry should cost one GET, not a Chromium launch.
    const client = await connect();
    login.lifetimeMs = 10_000;
    try {
      const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
      const logins = login.count;
      const refreshes = refresh.count;

      payload(await client.callTool({ name: 'get_basket', arguments: { sessionId } }));

      assert.equal(refresh.count, refreshes + 1, 'expiry should refresh');
      assert.equal(login.count, logins, 'and must not launch a browser');
    } finally {
      login.lifetimeMs = 5 * 60 * 1000;
      await client.close();
    }
  });

  it('falls back to a browser login when the cookies have lapsed', async () => {
    const client = await connect();
    login.lifetimeMs = 10_000;
    refresh.cookiesExpired = true;
    try {
      const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
      const logins = login.count;

      const result = payload(await client.callTool({ name: 'get_basket', arguments: { sessionId } }));

      assert.equal(login.count, logins + 1, 'a failed refresh must fall back to logging in');
      assert.equal(result.sessionId, sessionId, 'and the session id survives');
    } finally {
      refresh.cookiesExpired = false;
      login.lifetimeMs = 5 * 60 * 1000;
      await client.close();
    }
  });

  it('reuses the newest session when the caller omits sessionId', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    const before = login.count;

    const result = payload(await client.callTool({ name: 'get_basket', arguments: {} }));
    assert.equal(result.sessionId, sessionId);
    assert.equal(login.count, before, 'reusing a session must not log in again');
    await client.close();
  });

  it('rejects a session id belonging to a different account', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    await client.close();

    const other = await connect({ 'X-Nemlig-Username': 'someone-else@example.com', 'X-Nemlig-Password': 'pw' });
    const result = await other.callTool({ name: 'get_basket', arguments: { sessionId } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No session/);
    await other.close();
  });

  it('uses per-request header credentials when the client sends them', async () => {
    const client = await connect({ 'X-Nemlig-Username': 'guest@example.com', 'X-Nemlig-Password': 'guest-pw' });
    await client.callTool({ name: 'new_session', arguments: {} });
    assert.deepEqual(login.calls.at(-1), { username: 'guest@example.com', password: 'guest-pw' });
    await client.close();
  });

  it('forgets a session on end_session', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    payload(await client.callTool({ name: 'end_session', arguments: { sessionId } }));

    const result = await client.callTool({ name: 'get_basket', arguments: { sessionId } });
    assert.equal(result.isError, true);
    await client.close();
  });

  it('keeps a session working across a restart, re-authenticating from credentials', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    await client.close();

    const { SessionStore } = await import('../dist/src/store.js');
    const { SessionManager } = await import('../dist/src/sessions.js');
    const { createHttpServer } = await import('../dist/src/server.js');

    // A fresh process reads the metadata file back, but the secret was in memory
    // only — so the sessionId still resolves and transparently authenticates again.
    const restarted = new SessionManager({
      store: await SessionStore.open(dataDir),
      login,
      refresh,
      ttlMs: 60_000,
    });
    const restartedApp = createHttpServer(restarted);
    await restartedApp.listen({ host: '127.0.0.1', port: 0 });
    const before = login.count;

    const reconnected = new Client({ name: 'test', version: '1.0.0' });
    await reconnected.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', `http://127.0.0.1:${restartedApp.server.address().port}`)),
    );
    const result = payload(await reconnected.callTool({ name: 'get_basket', arguments: { sessionId } }));

    assert.equal(result.sessionId, sessionId, 'the same sessionId keeps working');
    assert.equal(login.count, before + 1, 'with no cookies on disk, the restart re-logs in once');
    await reconnected.close();
    await restartedApp.close();
  });

  it('never writes the token or cookies to the session file', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));

    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const raw = await readFile(join(dataDir, 'sessions.json'), 'utf8');
    const parsed = JSON.parse(raw);

    assert.equal(parsed.version, 2);
    const stored = parsed.sessions.find((s) => s.id === sessionId);
    assert.ok(stored, 'the session metadata is persisted');
    assert.deepEqual(Object.keys(stored).sort(), ['accountHash', 'createdAt', 'id', 'lastUsedAt']);
    // Nothing anywhere in the file should resemble a token or a cookie.
    assert.doesNotMatch(raw, /token|cookie|ASPXAUTH/i, 'no credential material may reach disk');
    await client.close();
  });
});
