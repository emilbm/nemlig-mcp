import type { Browser, Page } from 'playwright';
import { config, type NemligCredentials } from '../config.js';
import type { NemligToken, PageSettings } from './types.js';

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
    const accessToken = new Promise<string>((resolve, reject) => {
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

    const token = await withTimeout(
      accessToken,
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
    const settings = await waitForAuthenticatedSession(page);

    // Only now are the cookies worth keeping.
    const cookies = await context.cookies();
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

    return {
      accessToken: token,
      cookieHeader,
      acquiredAt: Date.now(),
      expiresAt: expiryOf(token),
      userId: settings.UserId!,
      buildStamp: settings.CombinedProductsAndSitecoreTimestamp,
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
async function waitForAuthenticatedSession(page: Page): Promise<PageSettings> {
  const deadline = Date.now() + config.login.sessionTimeoutMs;
  let last: PageSettings | undefined;

  while (Date.now() < deadline) {
    const settings = await page
      .evaluate(
        async (path) => {
          const response = await fetch(path, { headers: { Accept: 'application/json' } });
          if (!response.ok) return null;
          const body = (await response.json()) as { Settings?: unknown };
          return (body.Settings ?? null) as PageSettings | null;
        },
        config.nemlig.sessionProbePath,
      )
      .catch(() => null);

    if (settings?.UserId) return settings;
    last = settings ?? last;
    await page.waitForTimeout(500);
  }

  throw new LoginError(
    'Nemlig issued a token but the website session stayed anonymous (Settings.UserId was null). ' +
      'Account-scoped calls would silently return nothing, so the login is being treated as failed. ' +
      `Last seen: ${JSON.stringify(last ?? 'no readable Settings')}`,
  );
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
