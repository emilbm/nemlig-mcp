import type { IncomingHttpHeaders } from 'node:http';
import { config, type NemligCredentials } from './config.js';

export class MissingCredentialsError extends Error {
  constructor() {
    super(
      'No Nemlig credentials. Set NEMLIG_USERNAME and NEMLIG_PASSWORD on the server, ' +
        'or send X-Nemlig-Username and X-Nemlig-Password headers from the MCP client.',
    );
    this.name = 'MissingCredentialsError';
  }
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single && single.trim() ? single.trim() : undefined;
}

/**
 * Credentials come from the container's environment by default; a client may
 * override them per request. Header credentials are read once per HTTP request
 * and never written to disk — only the resulting token is stored, and that is
 * filed under a hash of the username.
 */
export function credentialsFrom(headers: IncomingHttpHeaders): NemligCredentials {
  if (config.allowHeaderCredentials) {
    const username = header(headers, 'x-nemlig-username');
    const password = header(headers, 'x-nemlig-password');
    if (username && password) return { username, password };
  }
  if (config.defaultCredentials) return config.defaultCredentials;
  throw new MissingCredentialsError();
}
