/**
 * Existence guard for entity-targeted control tools.
 *
 * Home Assistant silently ignores service calls whose target entity_id does not
 * exist: the call returns 200 with an empty change list. Without this guard the
 * tool would report `success: true` for an action that never happened, so an
 * LLM client would believe a typo'd light was switched on.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HaClient } from '../../haClient/index.js';
import { toToolResult } from '../common.js';

/**
 * Returns an error result when `entityId` does not exist in Home Assistant,
 * or `null` when it does (the caller should then proceed with the action).
 */
export async function entityNotFoundResult(client: HaClient, entityId: string): Promise<CallToolResult | null> {
  const state = await client.getState(entityId);
  if (state) {
    return null;
  }
  return toToolResult({
    error: 'Entity not found',
    entity_id: entityId,
    hint: 'No action was performed. Use the searchEntities tool with a keyword to find the correct entity_id',
  }, true);
}
