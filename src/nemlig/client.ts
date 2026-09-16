import { config } from '../config.js';
import type { NemligToken } from './types.js';

/** Thrown when Nemlig rejects the token — the signal to log in again and retry. */
export class TokenExpiredError extends Error {
  constructor() {
    super('The Nemlig token has expired.');
    this.name = 'TokenExpiredError';
  }
}

export class NemligApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'NemligApiError';
  }
}

/**
 * A thin authenticated fetch. Nemlig wants both the bearer token and the cookie
 * jar from the login, so we send the cookies as a header we control rather than
 * letting anything try to manage a jar for us.
 */
export class NemligClient {
  constructor(readonly token: NemligToken) {}

  get(url: string, headers?: Record<string, string>): Promise<Response> {
    return this.request(url, { method: 'GET', headers });
  }

  post(url: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
    return this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  private async request(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token.accessToken}`,
        Accept: 'application/json, text/plain, */*',
        'User-Agent': config.nemlig.userAgent,
        ...(this.token.cookieHeader ? { Cookie: this.token.cookieHeader } : {}),
        ...init.headers,
      },
    });
    if (response.status === 401 || response.status === 403) throw new TokenExpiredError();
    return response;
  }
}

/** Reads a JSON body, turning anything Nemlig is unhappy about into a usable error. */
export async function readJson<T>(response: Response, what: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) {
    throw new NemligApiError(`Failed to ${what}: ${response.status} ${response.statusText} — ${body.slice(0, 500)}`, response.status, body);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new NemligApiError(`Failed to ${what}: response was not JSON — ${body.slice(0, 200)}`, response.status, body);
  }
}
