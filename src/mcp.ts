import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { NemligCredentials } from './config.js';
import {
  addToBasket,
  getFavouriteProducts,
  getFavouritesOnOffer,
  removeFromBasket,
  searchProducts,
} from './nemlig/commands.js';
import type { SessionManager } from './sessions.js';

export const SERVER_NAME = 'nemlig';
export const SERVER_VERSION = '1.0.0';

export const INSTRUCTIONS = [
  'Tools for shopping groceries at Nemlig.com on the account this server is configured with.',
  '',
  'A session is reused across calls and refreshes its own login when it needs to, so keep',
  'using the same sessionId for a whole shopping trip. Omitting sessionId reuses the most',
  'recent session, or starts one — call new_session only for a deliberately fresh context.',
  '',
  'Typical flow: get_favourite_products to see what the household usually buys, search_products',
  'to find anything else, then add_to_basket with the product id. Prices are in DKK.',
].join('\n');

const sessionIdSchema = z
  .string()
  .optional()
  .describe('Session id from new_session. Omit to reuse the most recent session, or start one.');

/**
 * Tools are registered per HTTP request so each one closes over the credentials
 * that request carried — the session manager and its logins are shared.
 */
export function createMcpServer(sessions: SessionManager, credentials: NemligCredentials): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'new_session',
    {
      title: 'Start a new Nemlig session',
      description:
        'Logs in to Nemlig and returns a sessionId to pass to the other tools. Logging in drives a real browser and takes a few seconds, so start one session and keep using it.',
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async () => {
      const sessionId = await sessions.create(credentials);
      return json({ sessionId });
    },
  );

  server.registerTool(
    'get_basket',
    {
      title: 'Get the current basket',
      description: 'Returns the current Nemlig basket, including its delivery slot and what is already in it.',
      inputSchema: { sessionId: sessionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sessionId }) => {
      const id = await sessions.resolve(sessionId, credentials);
      const basket = await sessions.withClient(id, credentials, (client) => sessions.basketFor(id, client));
      return json({ sessionId: id, basket });
    },
  );

  server.registerTool(
    'search_products',
    {
      title: 'Search Nemlig products',
      description:
        'Searches the Nemlig catalogue so you can pick a product id to add to the basket. The search term is Danish, e.g. "tomater" or "letmælk".',
      inputSchema: {
        sessionId: sessionIdSchema,
        searchterm: z.string().min(1).describe('The product to search for, in Danish, e.g. "Tomater".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sessionId, searchterm }) => {
      const id = await sessions.resolve(sessionId, credentials);
      const products = await sessions.withClient(id, credentials, async (client) => {
        const basket = await sessions.basketFor(id, client);
        return searchProducts(client, basket, searchterm);
      });
      return json({ sessionId: id, searchterm, products });
    },
  );

  server.registerTool(
    'get_favourite_products',
    {
      title: 'Get frequently bought products',
      description:
        "Returns the account's frequently bought products — the best way to pick the brand and size the household actually buys, rather than guessing from a search.",
      inputSchema: { sessionId: sessionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sessionId }) => {
      const id = await sessions.resolve(sessionId, credentials);
      const products = await sessions.withClient(id, credentials, async (client) => {
        const basket = await sessions.basketFor(id, client);
        return getFavouriteProducts(client, basket);
      });
      return json({ sessionId: id, products });
    },
  );

  server.registerTool(
    'get_favourites_on_offer',
    {
      title: 'Get frequently bought products that are on offer',
      description:
        "The account's frequently bought products that are currently on promotion — Nemlig's \"Favoritter på tilbud\". The best place to start a shop: things the household actually buys, at a discount. Each product carries an `offer` describing the promotion, e.g. \"3 for 15 kr\" or \"40% off\". Note that multi-buy offers only apply at their `minQuantity`.",
      inputSchema: { sessionId: sessionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sessionId }) => {
      const id = await sessions.resolve(sessionId, credentials);
      const products = await sessions.withClient(id, credentials, async (client) => {
        const basket = await sessions.basketFor(id, client);
        return getFavouritesOnOffer(client, basket);
      });
      return json({ sessionId: id, products });
    },
  );

  server.registerTool(
    'add_to_basket',
    {
      title: 'Add a product to the basket',
      description:
        'Adds a product to the Nemlig basket. This changes a real basket on a real account — use a product id from search_products or get_favourite_products.',
      inputSchema: {
        sessionId: sessionIdSchema,
        productId: z.string().min(1).describe('The product id to add, as returned by search or favourites.'),
        quantity: z.number().int().positive().describe('How many to add.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ sessionId, productId, quantity }) => {
      const id = await sessions.resolve(sessionId, credentials);
      const result = await sessions.withClient(id, credentials, (client) => addToBasket(client, productId, quantity));
      // The basket's contents and totals just changed.
      sessions.invalidateBasket(id);
      return json({ sessionId: id, added: result });
    },
  );

  server.registerTool(
    'remove_from_basket',
    {
      title: 'Remove a product from the basket',
      description:
        'Takes a product back out of the Nemlig basket. Omit quantity to remove the whole line; give one to take out just that many. Removing more than the basket holds simply empties the line rather than going negative.',
      inputSchema: {
        sessionId: sessionIdSchema,
        productId: z.string().min(1).describe('The product id to remove, as it appears in the basket.'),
        quantity: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('How many to take out. Omit to remove all of them.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ sessionId, productId, quantity }) => {
      const id = await sessions.resolve(sessionId, credentials);
      const result = await sessions.withClient(id, credentials, (client) =>
        removeFromBasket(client, productId, quantity),
      );
      sessions.invalidateBasket(id);
      return json({ sessionId: id, removed: result });
    },
  );

  server.registerTool(
    'end_session',
    {
      title: 'End a Nemlig session',
      description: 'Forgets a session and its stored token. The basket itself is untouched — it lives on the account.',
      inputSchema: { sessionId: z.string().describe('The session to forget.') },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ sessionId }) => {
      await sessions.end(sessionId);
      return json({ sessionId, ended: true });
    },
  );

  return server;
}

function json(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
