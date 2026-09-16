import { config } from './config.js';
import { playwrightLogin } from './nemlig/login.js';
import { createHttpServer } from './server.js';
import { SessionManager } from './sessions.js';
import { SessionStore } from './store.js';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const store = await SessionStore.open(config.dataDir);
const sessions = new SessionManager({
  store,
  login: playwrightLogin,
  ttlMs: config.sessionTtlMs,
  maxConcurrentLogins: config.login.maxConcurrent,
});

const app = createHttpServer(sessions);

const prune = setInterval(() => {
  void sessions.prune().then((removed) => {
    if (removed) app.log.info(`pruned ${removed} expired session(s)`);
  });
}, PRUNE_INTERVAL_MS);
prune.unref();

await app.listen({ host: config.host, port: config.port });
app.log.info(
  `nemlig-mcp listening on http://${config.host}:${config.port}/mcp ` +
    `(credentials: ${config.defaultCredentials ? 'from environment' : 'from client headers only'})`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(prune);
    void app.close().then(() => process.exit(0));
  });
}
