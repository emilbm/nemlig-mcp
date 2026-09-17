import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * What survives a restart, and it is deliberately NOT secret: an id, which account
 * it belongs to, and when it was last used. The credential that would let someone
 * act as the account — the `.ASPXAUTH` cookie, good for a year — is held only in
 * memory, keyed by this id, and never written here. So the worst a leak of this
 * file can reveal is that an account has a session, not how to use it.
 */
export interface StoredSession {
  id: string;
  /** Hash of the account this session logged in as, so one account's session is never handed to another. */
  accountHash: string;
  createdAt: number;
  lastUsedAt: number;
}

/** Bumped when the on-disk shape changes; a mismatch is scrubbed rather than read. */
const FILE_VERSION = 2;

interface FileShape {
  version: number;
  sessions: StoredSession[];
}

/**
 * The non-secret half of a session, persisted so a client's sessionId keeps working
 * across a restart. A JSON file on the data volume is the right size for a handful
 * of these, and keeps the container free of a database it would never grow into.
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
      const parsed = JSON.parse(raw) as FileShape & { sessions?: Array<StoredSession & { token?: unknown }> };

      // An older file held the token and cookies inline. Do not read them, and
      // rewrite the file at once so the credential does not linger on disk.
      if (parsed.version !== FILE_VERSION) {
        console.warn(`[store] session file is v${parsed.version}, expected v${FILE_VERSION}; discarding and scrubbing it.`);
        await this.flush();
        return;
      }

      for (const session of parsed.sessions ?? []) {
        this.sessions.set(session.id, {
          id: session.id,
          accountHash: session.accountHash,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
        });
      }
    } catch (error) {
      // A missing file is the normal first boot; a corrupt one should not stop the
      // server, since everything in it can be recreated by logging in again.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[store] ignoring unreadable session file at ${this.path}: ${(error as Error).message}`);
      }
    }
  }

  get(id: string): StoredSession | undefined {
    return this.sessions.get(id);
  }

  /** The newest session for an account, so a client that omits a session id reuses it. */
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
      const payload: FileShape = { version: FILE_VERSION, sessions: [...this.sessions.values()] };
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
