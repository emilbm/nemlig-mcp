import { createServer } from 'node:http';

/**
 * Stands in for Nemlig's web API. Records what it was asked and can be told to
 * start rejecting a token, which is how the expiry-and-retry path gets tested.
 */
export async function startFakeNemlig() {
  const state = {
    /** Tokens this server still accepts. The fake login mints "token-1", "token-2", ... */
    validTokens: new Set(['token-1']),
    favouritesStale: false,
    requests: [],
    basketLines: [],
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers['authorization'] ?? '';
    const token = auth.replace(/^Bearer /, '');
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), token, headers: req.headers });

    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (!state.validTokens.has(token)) return send(401, { message: 'token expired' });

    if (url.pathname === '/webapi/basket/GetBasket') {
      return send(200, {
        BasketGuid: 'basket-guid',
        TimeslotUtc: '2026-09-20T10:00:00Z',
        DeliveryZoneId: 7,
        DeliveryTimeSlot: { Id: 'slot-42' },
        TotalPrice: state.basketLines.reduce((sum, line) => sum + line.TotalPrice, 0),
        Lines: state.basketLines,
      });
    }

    if (url.pathname === '/searchgateway/api/search') {
      return send(200, {
        Products: {
          NumFound: 1,
          Products: [
            {
              Id: '5012345',
              Name: `${url.searchParams.get('query')} økologiske 500g`,
              Price: 24.95,
              Availability: { IsAvailableInStock: true, IsDeliveryAvailable: true },
              Labels: ['Økologi'],
            },
          ],
        },
      });
    }

    if (url.pathname.endsWith('/Products/GetByProductGroupId')) {
      // A stale group id gets a 200 with no Products array, not a 404 — which is
      // exactly how the real thing hid a broken favourites call as "none".
      if (state.favouritesStale) return send(200, { Message: 'Unknown product group', products: null });
      return send(200, {
        NumFound: 1,
        Products: [
          {
            Id: '9098765',
            Name: 'Letmælk 1L',
            Price: 12.5,
            Availability: { IsAvailableInStock: true, IsDeliveryAvailable: false },
            Labels: [],
          },
        ],
      });
    }

    if (url.pathname === '/webapi/basket/AddToBasket' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        state.basketLines.push({ ProductId: parsed.ProductId, Quantity: parsed.Quantity, TotalPrice: 24.95 * parsed.Quantity });
        send(200, { Success: true });
      });
      return;
    }

    send(404, { message: `no route for ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    state,
    expireTokens() {
      state.validTokens.clear();
    },
    staleFavourites(value = true) {
      state.favouritesStale = value;
    },
    accept(token) {
      state.validTokens.add(token);
    },
    pathsHit(path) {
      return state.requests.filter((request) => request.path === path);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A login that mints numbered tokens instead of launching a browser, and counts calls. */
export function createFakeLogin(fakeNemlig) {
  let issued = 0;
  const calls = [];
  const login = async (credentials) => {
    issued++;
    calls.push(credentials);
    const token = `token-${issued}`;
    fakeNemlig.accept(token);
    return {
      accessToken: token,
      cookieHeader: `sid=cookie-${issued}`,
      acquiredAt: Date.now(),
      // Real tokens last five minutes; `lifetimeMs` lets a test make one stale.
      expiresAt: Date.now() + login.lifetimeMs,
      userId: '2168977',
      buildStamp: `stamp-${issued}`,
      favouritesGroupId: 'discovered-group-id',
    };
  };
  login.lifetimeMs = 5 * 60 * 1000;
  login.calls = calls;
  Object.defineProperty(login, 'count', { get: () => issued });
  return login;
}
