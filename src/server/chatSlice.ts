/**
 * MCP_CHAT_TOOLS slice parsing — standalone module with zero imports so both
 * config.ts and the chat-face binding registry can use it without import cycles.
 *
 * Syntax (operator UX modeled on category:permission slicing):
 *   MCP_CHAT_TOOLS=ha-core:rw,ha-history:r,omada-read:r
 *
 * Unset -> undefined -> the chat face serves exactly the legacy 8 tools
 * (pre-v1.7 behavior). Set -> the slice governs which chat-ELIGIBLE bindings
 * are active; it can only narrow what the code marks eligible, never widen.
 */

/** Chat-face tool categories. Deliberately few — this is a curated surface. */
export const CHAT_CATEGORIES = [
  'ha-core',        // states, search, summaries, version + callService (write)
  'ha-history',     // entity history
  'ha-automations', // list automations
  'omada-read',     // omada_browse / omada_read (resource graph, read-only)
  'omada-write',    // reversible network writes (SSID on/off)
] as const;

export type ChatCategory = (typeof CHAT_CATEGORIES)[number];
export type ChatAccess = 'read' | 'write';

/** Operator-selected slice: category -> allowed access levels. */
export type ChatToolsSlice = Map<ChatCategory, Set<ChatAccess>>;

/**
 * Parse `MCP_CHAT_TOOLS`. Returns `undefined` when unset/blank (legacy default).
 * Throws on malformed input so a config typo fails loudly at startup (same
 * philosophy as parseRestActions).
 */
export function parseChatTools(raw: string | undefined): ChatToolsSlice | undefined {
  if (!raw || raw.trim() === '') {
    return undefined;
  }

  const slice: ChatToolsSlice = new Map();
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, access] = part.split(':').map((p) => p.trim());
    if (!(CHAT_CATEGORIES as readonly string[]).includes(name)) {
      throw new Error(
        `Invalid MCP_CHAT_TOOLS category '${name}'. Known categories: ${CHAT_CATEGORIES.join(', ')}`
      );
    }
    if (!access || !/^(r|w|rw)$/.test(access)) {
      throw new Error(
        `Invalid MCP_CHAT_TOOLS access '${access ?? ''}' for '${name}': use r, w, or rw (e.g. "${name}:r")`
      );
    }
    const levels = slice.get(name as ChatCategory) ?? new Set<ChatAccess>();
    if (access.includes('r')) levels.add('read');
    if (access.includes('w')) levels.add('write');
    slice.set(name as ChatCategory, levels);
  }
  return slice;
}
