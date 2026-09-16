import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NemligToken } from './nemlig/types.js';

export interface StoredSession {
  id: string;
  /** Hash of the account this session logged in as, so one account's session is never handed to another. */
  accountHash: string;
  token: NemligToken;
  createdAt: number;
  lastUsedAt: number;
}

interface FileShape {
  version: 1;
  sessions: StoredSession[];
}

/**
 * Sessions are a handful of short-lived bearer tokens, rewritten in full on every
 * login — a JSON file on the data volume is the right size for that, and it keeps
 * the container free of a database it would never grow into. The file is written
 * 0600 because its contents are, in effect, the account's credentials.
 */
export class SessionStore {
  private sessions = new Map<string, StoredSession>();
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {}

  static async open(dataDir: string): Promise<SessionStore> {
    const path = join(dataDir, 'sessions.json');
    mkdirSync(dirname(path), { recursive: true });
    const store = new SessionStore(path);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as FileShape;
      for (const session of parsed.sessions ?? []) this.sessions.set(session.id, session);
    } catch (error) {
      // A missing file is the normal first boot; a corrupt one should not stop
      // the server, since everything in it can be recreated by logging in again.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[store] ignoring unreadable session file at ${this.path}: ${(error as Error).message}`);
      }
    }
  }

  get(id: string): StoredSession | undefined {
    return this.sessions.get(id);
  }

  /** The newest live session for an account, so a client that omits a session id reuses its login. */
  newestFor(accountHash: string): StoredSession | undefined {
    let newest: StoredSession | undefined;
    for (const session of this.sessions.values()) {
      if (session.accountHash !== accountHash) continue;
      if (!newest || session.lastUsedAt > newest.lastUsedAt) newest = session;
    }
    return newest;
  }

  async put(session: StoredSession): Promise<void> {
    this.sessions.set(session.id, session);
    await this.flush();
  }

  async touch(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastUsedAt = Date.now();
    await this.flush();
  }

  async delete(id: string): Promise<void> {
    if (this.sessions.delete(id)) await this.flush();
  }

  /** Drops sessions untouched for longer than the TTL. Returns how many went. */
  async prune(ttlMs: number): Promise<number> {
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.lastUsedAt < cutoff) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed) await this.flush();
    return removed;
  }

  /** Serialised writes: concurrent tool calls must not interleave into a torn file. */
  private flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const payload: FileShape = { version: 1, sessions: [...this.sessions.values()] };
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writing;
  }
}

export function hashAccount(username: string): string {
  return createHash('sha256').update(username.trim().toLowerCase()).digest('hex').slice(0, 16);
}

export function newSessionId(): string {
  // Short enough to stay cheap in a prompt, wide enough not to collide in a household.
  return randomUUID().replaceAll('-', '').slice(0, 12);
}
