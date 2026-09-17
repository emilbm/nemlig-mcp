import { config, type NemligCredentials } from './config.js';
import { NemligClient, TokenExpiredError } from './nemlig/client.js';
import { getBasket } from './nemlig/commands.js';
import { refreshSession, type LoginFn } from './nemlig/login.js';
import type { Basket, NemligToken } from './nemlig/types.js';
import { hashAccount, newSessionId, SessionStore } from './store.js';

export class UnknownSessionError extends Error {
  constructor(id: string) {
    super(`No session "${id}". Call new_session to start one.`);
    this.name = 'UnknownSessionError';
  }
}

export type RefreshFn = (token: NemligToken) => Promise<NemligToken>;

export interface SessionManagerOptions {
  store: SessionStore;
  login: LoginFn;
  /** Mints a fresh token from stored cookies. Injectable so tests need no network. */
  refresh?: RefreshFn;
  ttlMs: number;
  /** Cap on browsers running at once; a login is by far the heaviest thing here. */
  maxConcurrentLogins?: number;
}

/**
 * Owns the expensive half of the system: one browser login per session, reused
 * for every subsequent call, re-run only when Nemlig says the token is done.
 */
export class SessionManager {
  private readonly store: SessionStore;
  private readonly login: LoginFn;
  private readonly refresh: RefreshFn;
  private readonly ttlMs: number;
  private readonly loginQueue: LoginQueue;

  /** Per-session in-flight logins, so parallel tool calls share one browser launch. */
  private readonly pendingLogins = new Map<string, Promise<NemligClient>>();
  /** Basket per session — volatile, so it stays in memory and never reaches the file. */
  private readonly baskets = new Map<string, Basket>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.login = options.login;
    this.refresh = options.refresh ?? refreshSession;
    this.ttlMs = options.ttlMs;
    this.loginQueue = new LoginQueue(options.maxConcurrentLogins ?? 1);
  }

  /** Starts a fresh session, logging in immediately so failures surface here and not mid-shop. */
  async create(credentials: NemligCredentials): Promise<string> {
    const id = newSessionId();
    await this.authenticate(id, credentials);
    return id;
  }

  /**
   * Resolves the session a call should use: the one asked for, the account's most
   * recent one, or a brand new one. Keeping this implicit is what lets a client
   * call a tool without threading a session id through every prompt.
   */
  async resolve(sessionId: string | undefined, credentials: NemligCredentials): Promise<string> {
    if (sessionId) {
      const existing = this.store.get(sessionId);
      if (!existing) throw new UnknownSessionError(sessionId);
      if (existing.accountHash !== hashAccount(credentials.username)) throw new UnknownSessionError(sessionId);
      return sessionId;
    }
    const newest = this.store.newestFor(hashAccount(credentials.username));
    return newest ? newest.id : this.create(credentials);
  }

  /**
   * Runs `work` with an authenticated client. A token that expired mid-session is
   * replaced and the call retried once — from the caller's side the session just
   * keeps working for as long as they use it.
   */
  async withClient<T>(
    sessionId: string,
    credentials: NemligCredentials,
    work: (client: NemligClient, sessionId: string) => Promise<T>,
  ): Promise<T> {
    let client = await this.clientFor(sessionId, credentials);

    // Checked up front, because Nemlig answers an expired token as an anonymous
    // visitor rather than with a 401 — the call would otherwise "succeed" against
    // the wrong identity, returning an empty basket or adding to a stray one.
    if (client.isExpired(config.login.refreshMarginMs)) {
      this.baskets.delete(sessionId);
      client = await this.authenticate(sessionId, credentials);
    }

    try {
      const result = await work(client, sessionId);
      await this.store.touch(sessionId);
      return result;
    } catch (error) {
      if (!(error instanceof TokenExpiredError)) throw error;
      this.baskets.delete(sessionId);
      const refreshed = await this.authenticate(sessionId, credentials);
      const result = await work(refreshed, sessionId);
      await this.store.touch(sessionId);
      return result;
    }
  }

  /** The session's basket, fetched once and cached — search and favourites both need it. */
  async basketFor(sessionId: string, client: NemligClient): Promise<Basket> {
    const cached = this.baskets.get(sessionId);
    if (cached) return cached;
    const basket = await getBasket(client);
    this.baskets.set(sessionId, basket);
    return basket;
  }

  invalidateBasket(sessionId: string): void {
    this.baskets.delete(sessionId);
  }

  async end(sessionId: string): Promise<void> {
    this.baskets.delete(sessionId);
    this.pendingLogins.delete(sessionId);
    await this.store.delete(sessionId);
  }

  async prune(): Promise<number> {
    const removed = await this.store.prune(this.ttlMs);
    for (const id of [...this.baskets.keys()]) {
      if (!this.store.get(id)) this.baskets.delete(id);
    }
    return removed;
  }

  private async clientFor(sessionId: string, credentials: NemligCredentials): Promise<NemligClient> {
    const stored = this.store.get(sessionId);
    if (stored) return new NemligClient(stored.token);
    return this.authenticate(sessionId, credentials);
  }

  /**
   * A new token, as cheaply as the situation allows. The JWT is a service-account
   * credential the site hands out on request; the customer is identified by the
   * cookies, which last a year. So an expiring token is one GET, and only a lapsed
   * or missing cookie jar costs a browser launch.
   */
  private async mintToken(sessionId: string, credentials: NemligCredentials): Promise<NemligToken> {
    const stored = this.store.get(sessionId);
    if (stored?.token.cookieHeader) {
      try {
        return await this.refresh(stored.token);
      } catch (error) {
        // Falling back is the point: cookies do expire, and the browser still works.
        console.warn(`[session ${sessionId}] refresh failed, logging in again: ${(error as Error).message}`);
      }
    }
    return this.loginQueue.run(() => this.login(credentials));
  }

  private authenticate(sessionId: string, credentials: NemligCredentials): Promise<NemligClient> {
    const inFlight = this.pendingLogins.get(sessionId);
    if (inFlight) return inFlight;

    const attempt = this.mintToken(sessionId, credentials)
      .then(async (token) => {
        const existing = this.store.get(sessionId);
        await this.store.put({
          id: sessionId,
          accountHash: hashAccount(credentials.username),
          token,
          createdAt: existing?.createdAt ?? Date.now(),
          lastUsedAt: Date.now(),
        });
        return new NemligClient(token);
      })
      .finally(() => {
        this.pendingLogins.delete(sessionId);
      });

    this.pendingLogins.set(sessionId, attempt);
    return attempt;
  }
}

/** Minimal FIFO semaphore — browsers are heavy and a container has finite memory. */
class LoginQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
