import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyInstance, type RouteHandlerMethod } from 'fastify';
import { config } from './config.js';
import { credentialsFrom, MissingCredentialsError } from './credentials.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './mcp.js';
import type { SessionManager } from './sessions.js';

/** JSON-RPC error code for an unhandled server-side failure. */
const INTERNAL_ERROR = -32_603;

export function createHttpServer(sessions: SessionManager): FastifyInstance {
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

  app.get('/health', async () => ({
    status: 'ok',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    credentials: config.defaultCredentials ? 'configured' : 'header-only',
  }));

  /**
   * Stateless streamable HTTP: a transport and MCP server per request. The state
   * worth keeping — the Nemlig login — lives in the session manager and on disk,
   * so a client reconnecting, or the container restarting, costs nothing.
   */
  app.post('/mcp', async (request, reply) => {
    let credentials;
    try {
      credentials = credentialsFrom(request.headers);
    } catch (error) {
      if (!(error instanceof MissingCredentialsError)) throw error;
      await reply.code(401).send(rpcError(error.message));
      return;
    }

    const mcpServer = createMcpServer(sessions, credentials);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    reply.raw.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify(rpcError('Internal server error')));
      }
    }
  });

  // Stateless mode has no stream to resume and no session to delete.
  const methodNotAllowed: RouteHandlerMethod = async (_request, reply) =>
    reply.code(405).send(rpcError('Method not allowed. This server is stateless; send requests as HTTP POST.'));
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

function rpcError(message: string) {
  return { jsonrpc: '2.0', error: { code: INTERNAL_ERROR, message }, id: null };
}
