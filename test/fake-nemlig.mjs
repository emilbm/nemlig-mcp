import { createServer } from 'node:http';

/**
 * Stands in for Nemlig's web API. Records what it was asked and can be told to
 * start rejecting a token, which is how the expiry-and-retry path gets tested.
 */
export async function startFakeNemlig() {
  const state = {
    /** Tokens this server still accepts. The fake login mints "token-1", "token-2", ... */
    validTokens: new Set(['token-1']),
    requests: [],
    basketLines: [],
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers['authorization'] ?? '';
    const token = auth.replace(/^Bearer /, '');
    const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), token, headers: req.headers };
    state.requests.push(record);

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

    if (url.pathname === '/productbff/api/web/page') {
      // Shapes copied from real productbff responses: prices in øre, promotions as
      // campaignLines/campaignBadge, availability as a type. The first section is
      // Nemlig's "Favoritter på tilbud" (on-offer favourites); a second section
      // repeats a favourite by category and adds one full-price product, so the
      // all-favourites union has something the on-offer list does not.
      const onOffer = [
        {
          id: '100160',
          title: 'Hvidløg øko.',
          price: 550,
          priceOriginal: null,
          priceDiscount: null,
          certificates: [{ type: 'euOrganic', text: 'Øko (europæisk)' }],
          campaignLines: [{ text: '3 stk. 15,-', accessibilityText: '3 styk 15 kroner' }],
          campaignBadge: { primaryText: 'Køb flere, spar mere', secondaryText: null, accessibilityText: 'Køb flere, spar mere' },
          availability: { type: 'Available' },
          isFavorite: true,
        },
        {
          id: '5046029',
          title: 'Farfalle',
          price: 1905,
          priceOriginal: 3175,
          priceDiscount: 1270,
          certificates: [],
          campaignLines: [],
          campaignBadge: { primaryText: '40%', secondaryText: 'Spar', accessibilityText: 'Spar 40 procent' },
          availability: { type: 'Available' },
          isFavorite: true,
        },
        {
          id: '5069520',
          title: 'Kyllingebrystfilet',
          price: 8500,
          priceOriginal: 11795,
          priceDiscount: 3295,
          certificates: [{ type: 'refrigerated', text: 'Køl' }],
          campaignLines: [],
          campaignBadge: { primaryText: '32,95', secondaryText: 'Spar', accessibilityText: 'Spar 32,95 kroner' },
          availability: { type: 'SoldOut' },
          isFavorite: true,
        },
      ];
      const plain = {
        id: '2301138',
        title: 'Banan',
        price: 250,
        priceOriginal: null,
        priceDiscount: null,
        certificates: [],
        campaignLines: [],
        campaignBadge: null,
        availability: { type: 'Available' },
        isFavorite: true,
      };
      return send(200, {
        pageType: 'themePage',
        pageContent: [
          { contentType: 'ProductList', header: { title: 'Favoritter på tilbud' }, products: onOffer },
          // A category section repeating one on-offer favourite plus the plain one.
          { contentType: 'ProductList', header: { title: 'Frugt og grønt' }, products: [onOffer[0], plain] },
        ],
      });
    }

    if (url.pathname === '/webapi/basket/AddToBasket' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        record.body = body;
        // The real endpoint SETS the line quantity rather than incrementing it,
        // and anything at or below zero removes the line. Verified against the
        // live API — modelling it as an increment hid a real bug.
        const line = state.basketLines.find((candidate) => candidate.Id === parsed.ProductId);
        const target = parsed.Quantity;
        if (line && target <= 0) {
          state.basketLines.splice(state.basketLines.indexOf(line), 1);
        } else if (line) {
          line.Quantity = target;
          line.TotalPrice = 24.95 * target;
        } else if (target > 0) {
          state.basketLines.push({
            Id: parsed.ProductId,
            ProductId: parsed.ProductId,
            Name: `Product ${parsed.ProductId}`,
            Quantity: target,
            TotalPrice: 24.95 * target,
          });
        }
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
      debitorId: '2168977',
    };
  };
  login.lifetimeMs = 5 * 60 * 1000;
  login.calls = calls;
  Object.defineProperty(login, 'count', { get: () => issued });
  return login;
}

/**
 * Refresh without a browser: the real one GETs a service-account token and proves
 * the cookies still identify the account. Here it just mints the next token and
 * can be told the cookies have lapsed.
 */
export function createFakeRefresh(fakeNemlig, login) {
  let calls = 0;
  const refresh = async (token) => {
    calls++;
    if (refresh.cookiesExpired) throw new Error('cookies no longer identify the account');
    const next = `refreshed-${calls}`;
    fakeNemlig.accept(next);
    return { ...token, accessToken: next, acquiredAt: Date.now(), expiresAt: Date.now() + login.lifetimeMs, debitorId: token.debitorId ?? '2168977' };
  };
  refresh.cookiesExpired = false;
  Object.defineProperty(refresh, 'count', { get: () => calls });
  return refresh;
}
