import type { Browser } from 'playwright';
import { config, type NemligCredentials } from '../config.js';
import type { NemligToken } from './types.js';

/**
 * Logging in is the one thing we cannot do with plain HTTP: Nemlig's login is a
 * JavaScript form that ends in a token request. So we drive a real browser to
 * submit it, keep the cookies it sets, and from then on everything is fetch.
 *
 * This is deliberately the only Playwright in the codebase.
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

    // Arm the listener before navigating: a wrong password fails here, and this is
    // the cheapest place to turn it into a clear error.
    let rejectToken!: (reason: Error) => void;
    const loginFormPosted = new Promise<void>((resolve, reject) => {
      rejectToken = reject;
      page.on('response', (response) => {
        if (response.url() !== TOKEN_URL) return;
        void response
          .text()
          .then((body) => {
            const parsed = JSON.parse(body) as { access_token?: string; error_description?: string };
            if (parsed.access_token) resolve();
            else reject(new LoginError(parsed.error_description ?? 'Nemlig rejected the login'));
          })
          .catch((cause: unknown) => reject(new LoginError('Could not read the login response', { cause })));
      });
    });

    await page.goto(`${config.nemlig.webBaseUrl}/login`, { waitUntil: 'domcontentloaded' });

    // The consent banner covers the form. It may already be dismissed by a stored
    // preference, so a failure here is not fatal.
    await page.evaluate('CookieInformation.submitAllCategories()').catch(() => undefined);

    await page.fill("[name='userEmail']", credentials.username);
    await page.fill("[name='userPassword']", credentials.password);
    await page.click("button[type='submit']");

    await withTimeout(
      loginFormPosted,
      config.login.timeoutMs,
      'Timed out submitting the Nemlig login — the credentials may be wrong, or the login page may have changed',
    );

    /*
     * A token by itself does not mean we are logged in: Nemlig hands out a bare
     * service-account token to anyone, and only stamps it with the customer's
     * debitorId once the .ASPXAUTH cookie is established. That cookie lands a beat
     * after the form posts, so poll — re-reading the jar and re-minting the token —
     * until the token carries a debitorId. That claim is the real post-condition of
     * login, and the exact thing the productbff needs.
     */
    const authed = await waitForCustomerToken(() => context.cookies());
    return authed;
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw new LoginError(`Nemlig login failed: ${(error as Error).message}`, { cause: error });
  } finally {
    await browser?.close().catch(() => undefined);
  }
};

type Cookie = { name: string; value: string };

/**
 * Polls the token endpoint with the browser's current cookies until the token
 * comes back carrying a debitorId — i.e. until `.ASPXAUTH` has taken effect.
 */
async function waitForCustomerToken(readCookies: () => Promise<Cookie[]>): Promise<NemligToken> {
  const deadline = Date.now() + config.login.sessionTimeoutMs;
  let lastDebitor: string | null = null;

  while (Date.now() < deadline) {
    const cookieHeader = (await readCookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    if (/(^|;\s*)\.ASPXAUTH=/.test(cookieHeader)) {
      const token = await buildToken(cookieHeader);
      if (token.debitorId) return token;
      lastDebitor = token.debitorId;
    }
    await sleep(500);
  }

  throw new LoginError(
    'Login completed but the session stayed anonymous (no debitorId on the token). ' +
      'Account-scoped calls would silently return nothing, so this is treated as a failed login. ' +
      `Last debitorId seen: ${JSON.stringify(lastDebitor)}`,
  );
}

/**
 * GETs a token from `/webapi/Token` with the given cookies and packages it.
 *
 * The cookies do more than authenticate the request: when `.ASPXAUTH` is present
 * the endpoint enriches the token with the customer's `debitorId`, which the
 * productbff API resolves favourites from. Without it the token is a bare
 * service-account credential the bff treats as anonymous.
 */
export async function buildToken(cookieHeader: string): Promise<NemligToken> {
  const response = await fetch(`${config.nemlig.webBaseUrl}/webapi/Token`, {
    headers: { Cookie: cookieHeader, Accept: 'application/json', 'User-Agent': config.nemlig.userAgent },
  });
  if (!response.ok) throw new LoginError(`Token request failed: ${response.status} ${response.statusText}`);

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new LoginError('Token request returned no access_token');

  return {
    accessToken: body.access_token,
    cookieHeader,
    acquiredAt: Date.now(),
    expiresAt: expiryOf(body.access_token),
    debitorId: debitorIdOf(body.access_token),
  };
}

/**
 * Mints a fresh token without a browser. The token is a five-minute service-account
 * credential; the customer lives in `.ASPXAUTH`, which is good for a year. So an
 * expiry costs one GET, not a Chromium launch — and a token that comes back without
 * a debitorId means the cookie has finally lapsed and a real login is due.
 */
export async function refreshSession(token: NemligToken): Promise<NemligToken> {
  const refreshed = await buildToken(token.cookieHeader);
  if (!refreshed.debitorId) {
    throw new LoginError('Refreshed token but the cookies no longer identify the account — a new login is needed.');
  }
  return refreshed;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
