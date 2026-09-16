/** Process-wide configuration, read once from the environment at startup. */

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export interface NemligCredentials {
  username: string;
  password: string;
}

const envUsername = str('NEMLIG_USERNAME', '');
const envPassword = str('NEMLIG_PASSWORD', '');

export const config = {
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 8080),

  /** Everything that must outlive the container lands here. */
  dataDir: str('NEMLIG_DATA_DIR', 'data'),

  /**
   * The account used when a client does not send its own credentials. Optional:
   * a deployment can be header-only, in which case a client that sends nothing
   * gets a clear error rather than a silent fallback.
   */
  defaultCredentials:
    envUsername && envPassword ? ({ username: envUsername, password: envPassword } as NemligCredentials) : null,

  /** Let a client override the account per request via X-Nemlig-Username/-Password. */
  allowHeaderCredentials: bool('NEMLIG_ALLOW_HEADER_CREDENTIALS', true),

  login: {
    /** Real Chrome, headful, is the most likely to survive Nemlig's bot checks — but a container has no display. */
    headless: bool('NEMLIG_HEADLESS', true),
    timeoutMs: int('NEMLIG_LOGIN_TIMEOUT_MS', 60_000),
    /** Kept short by default: a browser launch per session is the expensive part we are caching away. */
    maxConcurrent: int('NEMLIG_LOGIN_MAX_CONCURRENT', 1),
  },

  /** A session is forgotten once untouched for this long; its next use logs in again. */
  sessionTtlMs: int('NEMLIG_SESSION_TTL_MS', 7 * 24 * 60 * 60 * 1000),

  nemlig: {
    webBaseUrl: str('NEMLIG_WEB_BASE_URL', 'https://www.nemlig.com'),
    searchBaseUrl: str('NEMLIG_SEARCH_BASE_URL', 'https://webapi.prod.knl.nemlig.it'),
    /**
     * Opaque segment in the favourites URL that Nemlig bakes into its own
     * frontend build. If favourites start 404-ing, read a fresh one off a
     * request in the browser's network tab and set it here.
     */
    webapiBuildId: str('NEMLIG_WEBAPI_BUILD_ID', 'a2CUwjmB-wDTdpgqB'),
    favouritesProductGroupId: str('NEMLIG_FAVOURITES_GROUP_ID', 'c33e7d8a-f1d5-49ee-a39f-4f670612524e'),
    searchPageSize: int('NEMLIG_SEARCH_PAGE_SIZE', 20),
    userAgent: str(
      'NEMLIG_USER_AGENT',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ),
  },
} as const;

export type Config = typeof config;
