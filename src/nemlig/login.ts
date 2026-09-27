import { config, type NemligCredentials } from '../config.js';
import type { NemligToken } from './types.js';

export type LoginFn = (credentials: NemligCredentials) => Promise<NemligToken>;

export class LoginError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LoginError';
  }
}

/**
 * Logs in with a plain HTTP POST — no browser.
 *
 * Nemlig's login page is a JavaScript form, but all it does is POST `/webapi/login`
 * with a small JSON body, and that call sets the `.ASPXAUTH` cookie directly. No
 * XSRF token is required, and the JSON API — unlike the HTML `/login` page — has no
 * cookie-priming redirect loop or waiting room to clear from a cold client. After
 * that, `/webapi/Token` with the cookie mints the debitorId-bearing token: the
 * customer lives in the cookie, not the token (see refreshSession).
 *
 * The merge flags are all false so logging in never touches the account's basket.
 */
export const login: LoginFn = async (credentials) => {
  const response = await fetch(`${config.nemlig.webBaseUrl}/webapi/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': config.nemlig.userAgent,
    },
    body: JSON.stringify({
      Username: credentials.username,
      Password: credentials.password,
      CheckForExistingProducts: false,
      DoMerge: false,
      AppInstalled: false,
      SaveExistingBasket: false,
    }),
  });

  if (response.status !== 200) {
    // Nemlig returns a clean Danish message for bad credentials; surface it.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { ErrorMessage?: string };
      if (body.ErrorMessage) detail = body.ErrorMessage;
    } catch {
      /* keep the status line */
    }
    throw new LoginError(`Nemlig rejected the login: ${detail}`);
  }

  const cookieHeader = cookiesFromResponse(response);
  if (!/(^|;\s*)\.ASPXAUTH=/.test(cookieHeader)) {
    throw new LoginError('Login returned 200 but set no .ASPXAUTH cookie — the login flow may have changed.');
  }

  return waitForCustomerToken(cookieHeader);
};

/** Collects the `name=value` of every Set-Cookie on a response into a Cookie header. */
function cookiesFromResponse(response: Response): string {
  const jar = new Map<string, string>();
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Mints the token from the login cookies, retrying until it carries a debitorId —
 * i.e. until `.ASPXAUTH` has taken effect. In practice the first attempt already has
 * it; the loop only covers the rare beat where the cookie is a moment behind.
 */
async function waitForCustomerToken(cookieHeader: string): Promise<NemligToken> {
  const deadline = Date.now() + config.login.sessionTimeoutMs;
  let lastDebitor: string | null = null;

  for (;;) {
    const token = await buildToken(cookieHeader);
    if (token.debitorId) return token;
    lastDebitor = token.debitorId;
    if (Date.now() >= deadline) break;
    await sleep(500);
  }

  throw new LoginError(
    'Logged in but the token stayed anonymous (no debitorId). ' +
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
 * expiry costs one GET, not a full re-login — and a token that comes back without
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
