import type { Browser, Page } from 'playwright';
import { config, type NemligCredentials } from '../config.js';
import type { NemligToken, PageSettings, PageSpot } from './types.js';

/**
 * Logging in is the one thing we cannot do with plain HTTP: Nemlig's login is a
 * JavaScript form that ends in a token request. So we drive a real browser,
 * listen for that request, and keep both the JWT and the cookies it set.
 *
 * This is deliberately the only Playwright in the codebase — everything after
 * login is ordinary fetch.
 */
export type LoginFn = (credentials: NemligCredentials) => Promise<NemligToken>;

export class LoginError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LoginError';
  }
}

const TOKEN_URL = `${config.nemlig.webBaseUrl}/webapi/Token`;

export const playwrightLogin: LoginFn = async (credentials) => {
  // Imported lazily so the module graph — and the tests — do not need a browser.
  const { chromium } = await import('playwright');

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: config.login.headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({ userAgent: config.nemlig.userAgent, locale: 'da-DK' });
    const page = await context.newPage();

    // Arm the listener before navigating: the token response can arrive as soon
    // as the form is submitted.
    let resolveToken!: (value: string) => void;
    let rejectToken!: (reason: Error) => void;
    const interceptedToken = new Promise<string>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });

    page.on('response', (response) => {
      if (response.url() !== TOKEN_URL) return;
      void response
        .text()
        .then((body) => {
          const parsed = JSON.parse(body) as { access_token?: string; error_description?: string };
          if (parsed.access_token) resolveToken(parsed.access_token);
          else rejectToken(new LoginError(parsed.error_description ?? 'Nemlig returned no access_token'));
        })
        .catch((cause: unknown) => rejectToken(new LoginError('Could not read the token response', { cause })));
    });

    await page.goto(`${config.nemlig.webBaseUrl}/login`, { waitUntil: 'domcontentloaded' });

    // The consent banner covers the form. It may already be dismissed by a
    // stored preference, so a failure here is not fatal.
    await page.evaluate('CookieInformation.submitAllCategories()').catch(() => undefined);

    await page.fill("[name='userEmail']", credentials.username);
    await page.fill("[name='userPassword']", credentials.password);
    await page.click("button[type='submit']");

    // Awaited only to confirm the form succeeded and to surface a bad-credentials
    // error: this intercepted token is the pre-auth one, minted before .ASPXAUTH
    // exists and so missing the customer's debitorId. The token we keep is fetched
    // fresh below, once the authenticated session is established.
    await withTimeout(
      interceptedToken,
      config.login.timeoutMs,
      'Timed out waiting for Nemlig to return a token — the credentials may be wrong, or the login page may have changed',
    );

    /*
     * The token arriving does NOT mean we are logged in to the website. Nemlig
     * issues the JWT first and only then finishes establishing the Sitecore
     * session that account-scoped endpoints actually read. Snapshot the cookies
     * in between and you get a token that authenticates while the basket and
     * favourites quietly come back anonymous and empty.
     *
     * So we wait for the site itself to admit who we are: poll a page until its
     * Settings block carries a UserId. That is the real post-condition of login.
     */
    const { settings, spots } = await waitForAuthenticatedSession(page);

    // Only now are the cookies worth keeping — and only now does /webapi/Token
    // return a token carrying the customer's debitorId, because .ASPXAUTH is set.
    const cookies = await context.cookies();
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const accessToken = await fetchToken(cookieHeader);

    return {
      accessToken,
      cookieHeader,
      acquiredAt: Date.now(),
      expiresAt: expiryOf(accessToken),
      userId: settings.UserId!,
      debitorId: debitorIdOf(accessToken),
      buildStamp: settings.CombinedProductsAndSitecoreTimestamp,
      favouritesGroupId: pickFavouritesGroup(spots),
    };
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw new LoginError(`Nemlig login failed: ${(error as Error).message}`, { cause: error });
  } finally {
    await browser?.close().catch(() => undefined);
  }
};

/**
 * Polls a Sitecore page from inside the browser until it reports a UserId.
 * Fetching in the page context means the browser's own cookie jar is used, so
 * this measures exactly what a later fetch from Node will be able to reproduce.
 */
async function waitForAuthenticatedSession(page: Page): Promise<{ settings: PageSettings; spots: PageSpot[] }> {
  const deadline = Date.now() + config.login.sessionTimeoutMs;
  let last: PageSettings | null = null;

  while (Date.now() < deadline) {
    const probe = await page
      .evaluate(
        async (path) => {
          const response = await fetch(path, { headers: { Accept: 'application/json' } });
          if (!response.ok) return null;
          const body = (await response.json()) as { Settings?: unknown; content?: unknown };

          // The page nests its spots in ribbons of varying depth, so walk the whole
          // thing rather than assuming a shape that a redesign would change.
          const spots: Array<{ heading: string; productGroupId: string; totalProducts: number }> = [];
          const walk = (node: unknown): void => {
            if (Array.isArray(node)) return node.forEach(walk);
            if (!node || typeof node !== 'object') return;
            const record = node as Record<string, unknown>;
            if (typeof record['ProductGroupId'] === 'string') {
              spots.push({
                heading: typeof record['Heading'] === 'string' ? record['Heading'] : '',
                productGroupId: record['ProductGroupId'],
                totalProducts: typeof record['TotalProducts'] === 'number' ? record['TotalProducts'] : 0,
              });
            }
            Object.values(record).forEach(walk);
          };
          walk(body.content);

          return { settings: (body.Settings ?? null) as PageSettings | null, spots };
        },
        config.nemlig.sessionProbePath,
      )
      .catch(() => null);

    if (probe?.settings?.UserId) return { settings: probe.settings, spots: probe.spots };
    last = probe?.settings ?? last;
    await page.waitForTimeout(500);
  }

  throw new LoginError(
    'Nemlig issued a token but the website session stayed anonymous (Settings.UserId was null). ' +
      'Account-scoped calls would silently return nothing, so the login is being treated as failed. ' +
      `Last seen: ${JSON.stringify(last ?? 'no readable Settings')}`,
  );
}

/**
 * Picks the favourites list out of the spots on the page. Matched on its heading
 * rather than its id, because the id is exactly the thing that changes; an explicit
 * id override stays available for when the Danish copy changes instead.
 */
export function pickFavouritesGroup(spots: PageSpot[]): string {
  const override = config.nemlig.favouritesProductGroupId;
  if (override) return override;

  const match = spots.find((spot) => config.nemlig.favouritesHeadingPattern.test(spot.heading));
  if (match) return match.productGroupId;

  throw new LoginError(
    `Could not find the favourites list on ${config.nemlig.sessionProbePath}: no spot's heading matched ` +
      `${config.nemlig.favouritesHeadingPattern}. Found ${
        spots.length ? spots.map((s) => `"${s.heading}" (${s.productGroupId}, ${s.totalProducts})`).join('; ') : 'no spots at all'
      }. Set NEMLIG_FAVOURITES_GROUP_ID to pin it, or NEMLIG_FAVOURITES_HEADING to match the new wording.`,
  );
}

/**
 * GETs a token from `/webapi/Token` with the given cookies.
 *
 * The cookies matter for more than identity: when `.ASPXAUTH` is present the
 * endpoint enriches the token with the customer's `debitorId`, and the new
 * `productbff` API resolves favourites from exactly that claim. Without cookies —
 * or when captured mid-login before `.ASPXAUTH` is set — the token is a bare
 * service-account credential with no customer, which is why an early version of
 * this login could not read favourites from the bff.
 */
export async function fetchToken(cookieHeader: string): Promise<string> {
  const response = await fetch(`${config.nemlig.webBaseUrl}/webapi/Token`, {
    headers: { Cookie: cookieHeader, Accept: 'application/json', 'User-Agent': config.nemlig.userAgent },
  });
  if (!response.ok) throw new LoginError(`Token request failed: ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new LoginError('Token request returned no access_token');
  return body.access_token;
}

/** Reads the customer id the bff needs out of the token, or null on a service-account token. */
export function debitorIdOf(jwt: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as {
      authorization?: { permissions?: Array<{ claims?: { debitorId?: string[] } }> };
    };
    return claims.authorization?.permissions?.[0]?.claims?.debitorId?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Reads `exp` out of the JWT. Nemlig's tokens last five minutes, so this is not optional. */
export function expiryOf(jwt: string): number {
  const segment = jwt.split('.')[1];
  if (!segment) throw new LoginError('Nemlig returned a token that is not a JWT');
  try {
    const claims = JSON.parse(Buffer.from(segment, 'base64url').toString()) as { exp?: number };
    if (!claims.exp) throw new Error('no exp claim');
    return claims.exp * 1000;
  } catch (cause) {
    throw new LoginError('Could not read the token expiry', { cause });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LoginError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/**
 * Mints a fresh token without a browser.
 *
 * The JWT turns out to be a service-account credential — `preferred_username` is
 * `service-account-sitecore`, and the endpoint hands one out to anyone who asks.
 * The customer is identified by the cookies instead, and `.ASPXAUTH` is good for a
 * year. So a five-minute expiry costs one GET, not a Chromium launch.
 *
 * The cookies are still sent, and the result is verified against the same page the
 * login uses: if `.ASPXAUTH` has lapsed we would otherwise slide back into the
 * silent-anonymous state that made the original bug so hard to see.
 */
export async function refreshSession(token: NemligToken): Promise<NemligToken> {
  const accessToken = await fetchToken(token.cookieHeader);

  // Prove the cookies still identify the account, and pick up any republished ids
  // from the same request while we are here.
  const probe = await fetch(`${config.nemlig.webBaseUrl}${config.nemlig.sessionProbePath}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Cookie: token.cookieHeader,
      Accept: 'application/json',
      'User-Agent': config.nemlig.userAgent,
    },
  });
  if (!probe.ok) throw new LoginError(`Token refresh could not verify the session: HTTP ${probe.status}`);

  const page = (await probe.json()) as { Settings?: PageSettings; content?: unknown };
  const settings = page.Settings;
  if (!settings?.UserId) {
    throw new LoginError('Refreshed token but the cookies no longer identify the account — a new login is needed.');
  }

  const spots: PageSpot[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record['ProductGroupId'] === 'string') {
      spots.push({
        heading: typeof record['Heading'] === 'string' ? record['Heading'] : '',
        productGroupId: record['ProductGroupId'],
        totalProducts: typeof record['TotalProducts'] === 'number' ? record['TotalProducts'] : 0,
      });
    }
    Object.values(record).forEach(walk);
  };
  walk(page.content);

  return {
    accessToken,
    cookieHeader: token.cookieHeader,
    acquiredAt: Date.now(),
    expiresAt: expiryOf(accessToken),
    userId: settings.UserId,
    debitorId: debitorIdOf(accessToken),
    buildStamp: settings.CombinedProductsAndSitecoreTimestamp,
    favouritesGroupId: spots.length ? pickFavouritesGroup(spots) : token.favouritesGroupId,
  };
}
