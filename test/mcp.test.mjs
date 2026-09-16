import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFakeLogin, startFakeNemlig } from './fake-nemlig.mjs';

/** Tool results are JSON in a text block; unwrap that once here. */
function payload(result) {
  assert.equal(result.isError, undefined, `tool returned an error: ${JSON.stringify(result.content)}`);
  return JSON.parse(result.content[0].text);
}

describe('nemlig-mcp over streamable HTTP', () => {
  let nemlig;
  let login;
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
    process.env.NEMLIG_DATA_DIR = dataDir;
    process.env.NEMLIG_USERNAME = 'shopper@example.com';
    process.env.NEMLIG_PASSWORD = 'hunter2';
    process.env.LOG_LEVEL = 'silent';

    const { SessionStore } = await import('../dist/src/store.js');
    const { SessionManager } = await import('../dist/src/sessions.js');
    const { createHttpServer } = await import('../dist/src/server.js');

    login = createFakeLogin(nemlig);
    sessions = new SessionManager({ store: await SessionStore.open(dataDir), login, ttlMs: 60_000 });
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
      'new_session',
      'search_products',
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

  it('fetches favourites with the referer Nemlig requires', async () => {
    const client = await connect();
    const result = payload(await client.callTool({ name: 'get_favourite_products', arguments: {} }));
    assert.equal(result.products[0].name, 'Letmælk 1L');
    assert.equal(result.products[0].deliverable, false);

    const favourites = nemlig.state.requests
      .filter((request) => request.path.endsWith('/Products/GetByProductGroupId'))
      .at(-1);
    assert.equal(favourites.headers.referer, `${nemlig.baseUrl}/mit-nemlig`);
    await client.close();
  });

  it('adds to the basket and refreshes the cached basket afterwards', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));

    payload(await client.callTool({ name: 'get_basket', arguments: { sessionId } }));
    const added = payload(
      await client.callTool({ name: 'add_to_basket', arguments: { sessionId, productId: '5012345', quantity: 2 } }),
    );
    assert.deepEqual(added.added, { productId: '5012345', quantity: 2 });

    const refreshed = payload(await client.callTool({ name: 'get_basket', arguments: { sessionId } }));
    assert.equal(refreshed.basket.Lines.at(-1).ProductId, '5012345');
    assert.equal(refreshed.basket.Lines.at(-1).Quantity, 2, 'a stale cached basket must not be served after a write');
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

  it('logs in again and retries when the token expires mid-session', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    const before = login.count;

    nemlig.expireTokens();
    const result = payload(
      await client.callTool({ name: 'search_products', arguments: { sessionId, searchterm: 'agurk' } }),
    );

    assert.equal(login.count, before + 1, 'expiry should cost exactly one new login');
    assert.equal(result.products.length, 1, 'the call should succeed on the retry, not surface the 401');
    await client.close();
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

  it('survives a restart without logging in again', async () => {
    const client = await connect();
    const { sessionId } = payload(await client.callTool({ name: 'new_session', arguments: {} }));
    await client.close();

    const { SessionStore } = await import('../dist/src/store.js');
    const { SessionManager } = await import('../dist/src/sessions.js');
    const { createHttpServer } = await import('../dist/src/server.js');

    // A fresh process would read the same file back off the data volume.
    const restarted = new SessionManager({ store: await SessionStore.open(dataDir), login, ttlMs: 60_000 });
    const restartedApp = createHttpServer(restarted);
    await restartedApp.listen({ host: '127.0.0.1', port: 0 });
    const before = login.count;

    const reconnected = new Client({ name: 'test', version: '1.0.0' });
    await reconnected.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', `http://127.0.0.1:${restartedApp.server.address().port}`)),
    );
    const result = payload(await reconnected.callTool({ name: 'get_basket', arguments: { sessionId } }));

    assert.equal(result.sessionId, sessionId);
    assert.equal(login.count, before, 'the stored token should survive a restart');
    await reconnected.close();
    await restartedApp.close();
  });
});
