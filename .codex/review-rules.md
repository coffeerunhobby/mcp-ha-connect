# Hard rules for reviewing mcp-ha-connect

This server controls real devices (Home Assistant, TP-Link Omada) and is exposed publicly.

1. **No untested code ships.** Every behavior change needs a test that would fail without it.
2. **Authorization fails closed.** A missing or unknown permission mask means NO access, never full
   access. Every tool is gated by `wrapToolHandler(..., Permission.X)` or, for `omada_read`/`omada_browse`,
   per resource path. The model is not a security boundary.
3. **Never share an `McpServer` or transport across clients** (GHSA-345p-7cg4-v4c7): fresh server +
   transport per request (stateless) or per session (stateful).
4. **No generic write verbs.** Writes stay typed and individually gated; never add an arbitrary
   service-call/URL/request passthrough tool.
5. **Secrets never in logs or client responses.** No raw `error.message` to clients; no tokens,
   `Authorization` headers or secrets in logs.
6. **Scoped TLS only.** Never `NODE_TLS_REJECT_UNAUTHORIZED=0`; use per-client undici dispatchers.
7. **Encode every path segment** built from tool input.
