import type { Browser } from 'playwright';
import { config, type NemligCredentials } from '../config.js';
import type { NemligToken } from './types.js';

/**
 * Logging in is the one thing we cannot do with plain HTTP: Nemlig's login is a
 * JavaScript form that ends in a token request. So we drive a real browser,
 * listen for that request, and keep both the JWT and the cookies it set.
 *
 * This is deliberately the only Playwright in the codebase — everything after
 * login is ordinary fetch, which is why one login can serve a whole session.
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
    // as the form is submitted, and a fixed sleep afterwards is a race.
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
    await page
      .evaluate('CookieInformation.submitAllCategories()')
      .catch(() => undefined);

    await page.fill("[name='userEmail']", credentials.username);
    await page.fill("[name='userPassword']", credentials.password);
    await page.click("button[type='submit']");

    const token = await withTimeout(
      accessToken,
      config.login.timeoutMs,
      'Timed out waiting for Nemlig to return a token — the credentials may be wrong, or the login page may have changed',
    );

    // Cookies are read after the token lands, so they include the session the
    // token request itself established.
    const cookies = await context.cookies();
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

    return { accessToken: token, cookieHeader, acquiredAt: Date.now() };
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw new LoginError(`Nemlig login failed: ${(error as Error).message}`, { cause: error });
  } finally {
    await browser?.close().catch(() => undefined);
  }
};

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
