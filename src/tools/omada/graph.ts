/**
 * Omada resource-graph tools: `omada_browse` + `omada_read`.
 *
 * These two tools replace dozens of per-endpoint getters when
 * `MCP_TOOL_REGISTRATION_MODE=graph`. The model navigates a discoverable
 * namespace (browse → read) instead of selecting from a flat list of ~25 tool
 * schemas, which keeps the tool-schema budget small for low-context models while
 * still exposing every read endpoint.
 *
 * Authorization mirrors `wrapToolHandler`:
 *  - `omada_browse` requires QUERY to use, and additionally filters the children
 *    it advertises by the caller's mask (so sensitive subtrees stay invisible).
 *  - `omada_read` declares NO static tool permission; instead it enforces the
 *    per-path permission from the manifest, so each path can require a different
 *    bit. Unknown / container / under-privileged paths fail closed.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../../omadaClient/index.js';
import { hasPermission, getPermissionNames } from '../../permissions/index.js';
import { toToolResult, wrapToolHandler, getCallerPermissions, Permission, type ToolExtra } from '../common.js';
import { childrenOf, getResourceNode, normalizePath, type ReadArgs, type ResourceNode } from './namespace.js';

/** Compact, model-friendly metadata for a node (used in browse output). */
function nodeSummary(node: ResourceNode): Record<string, unknown> {
  return {
    path: node.path,
    kind: node.kind,
    permission: getPermissionNames(node.permission).join(',') || 'NONE',
    description: node.description,
    readable: node.fetch !== undefined,
    ...(node.estimatedSize ? { estimatedSize: node.estimatedSize } : {}),
    ...(node.paginated ? { supportsPagination: true, defaultPageSize: node.defaultPageSize ?? 50 } : {}),
    ...(node.params && node.params.length > 0 ? { params: node.params } : {}),
  };
}

const browseSchema = z.object({
  path: z
    .string()
    .default('/')
    .describe('Resource path to explore (default "/"). e.g. "/", "/gateway", "/wifi", "/network".'),
});

const readSchema = z.object({
  path: z.string().describe('Resource path discovered via omada_browse, e.g. "/gateway/wan", "/clients", "/events".'),
  siteId: z.string().min(1).optional().describe('Site ID (optional; uses the default site if not set).'),
  id: z.string().min(1).optional().describe('Look up a single member of a collection by id/MAC (where supported).'),
  params: z
    .record(z.string())
    .optional()
    .describe('Path parameters some resources require (see omada_browse "params"), e.g. {"gatewayMac":"AA-BB-CC-DD-EE-FF"}.'),
  page: z.number().int().min(1).optional().describe('Page number for paginated resources (e.g. "/events").'),
  pageSize: z.number().int().min(1).max(200).optional().describe('Page size for paginated resources (max 200).'),
});

/**
 * Register the resource-graph tools. Returns the number of tools registered (2).
 */
export function registerOmadaGraphTools(server: McpServer, client: OmadaClient): number {
  server.registerTool(
    'omada_browse',
    {
      description:
        'Discover the Omada network resource graph. Returns the children and metadata at a path (resource TYPES, not ' +
        'instances — no MAC enumeration), so navigate from "/" downward, then call omada_read at a readable node to fetch ' +
        'data. This replaces dozens of individual getters with one discoverable namespace.',
      inputSchema: browseSchema.shape,
    },
    wrapToolHandler(
      'omada_browse',
      async ({ path }: z.infer<typeof browseSchema>, extra: ToolExtra): Promise<ReturnType<typeof toToolResult>> => {
        const norm = normalizePath(path);
        const node = getResourceNode(norm);
        if (!node) {
          return toToolResult(
            { error: 'Unknown path', message: `No Omada resource at '${norm}'. Start at '/' and browse downward.` },
            true
          );
        }
        const mask = getCallerPermissions(extra);
        const children = childrenOf(norm)
          .filter((child) => hasPermission(mask, child.permission))
          .map(nodeSummary);
        return toToolResult({
          path: norm,
          kind: node.kind,
          description: node.description,
          readable: node.fetch !== undefined,
          ...(node.params && node.params.length > 0 ? { params: node.params } : {}),
          ...(node.paginated ? { supportsPagination: true, defaultPageSize: node.defaultPageSize ?? 50 } : {}),
          children,
        });
      },
      Permission.QUERY
    )
  );

  server.registerTool(
    'omada_read',
    {
      description:
        'Read data from an Omada resource path discovered via omada_browse. Handles single resources (e.g. "/gateway/wan"), ' +
        'collections (e.g. "/clients", optionally id=<MAC> for one member), and paginated logs (e.g. "/events" with ' +
        'page/pageSize). Authorization is enforced per-path.',
      inputSchema: readSchema.shape,
    },
    // No static permission: each path declares its own, enforced below (fail-closed).
    wrapToolHandler(
      'omada_read',
      async (args: z.infer<typeof readSchema>, extra: ToolExtra): Promise<ReturnType<typeof toToolResult>> => {
        const norm = normalizePath(args.path);
        const node = getResourceNode(norm);
        if (!node) {
          return toToolResult(
            { error: 'Unknown path', message: `No Omada resource at '${norm}'. Use omada_browse to discover valid paths.` },
            true
          );
        }
        if (!node.fetch) {
          return toToolResult(
            { error: 'Not readable', message: `'${norm}' is a container. Use omada_browse to list its children.` },
            true
          );
        }

        const mask = getCallerPermissions(extra);
        if (!hasPermission(mask, node.permission)) {
          const required = getPermissionNames(node.permission);
          const has = getPermissionNames(mask);
          return toToolResult(
            { error: 'Permission denied', message: `Reading '${norm}' requires permission: ${required.join(', ')}`, required, has },
            true
          );
        }

        // Validate required path parameters before touching the controller.
        const missing = (node.params ?? [])
          .filter((p) => p.required && !args.params?.[p.name])
          .map((p) => p.name);
        if (missing.length > 0) {
          return toToolResult(
            { error: 'Missing parameters', message: `'${norm}' requires: ${missing.join(', ')}. Pass them in "params".`, missing },
            true
          );
        }

        const readArgs: ReadArgs = {
          siteId: args.siteId,
          id: args.id,
          params: args.params,
          page: args.page,
          pageSize: args.pageSize,
        };
        return toToolResult(await node.fetch(client, readArgs));
      }
    )
  );

  return 2;
}
