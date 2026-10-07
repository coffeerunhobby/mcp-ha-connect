### 2.2.1
- **Security — secrets are redacted from every tool response.** Omada read tools returned the household Wi-Fi password in plain text (`pskSetting.securityKey` in the SSID detail, via `omada_getSsidDetail` and `omada_read /wifi/ssids`), and other paths could do the same for RADIUS / CoA / SNMP secrets, PPSK and VPN keys, portal passwords and tokens. Every tool response now passes through one redaction step (in `toToolResult`, so MCP and the REST bridge alike): non-empty text values under secret-looking names become `"<redacted>"` (empty values stay empty; flags and numbers with similar names such as `hidePwd` or `encryptionPsk` are untouched), and `token=` / `access_token=` values inside URLs (Home Assistant camera images) are masked. Internal read-modify-write paths are unaffected; redaction happens only at the response.
- **Fix — `omada_unblockClient` on clients the controller no longer treats as current.** Omada's unblock endpoint fails with "This client does not exist" once a blocked (and therefore offline) client drops out of the controller's current set. The tool now checks the known-clients list: if the client is there and no longer blocked (e.g. unblocked in the web UI), it reports success; otherwise it returns a clear error saying what to do. A client the controller has no record of is never reported as unblocked, because its access points may still refuse it (an orphaned block). This works whether the controller reports the error with HTTP 200 or an HTTP error status (controller errors now carry their `errorCode`).
- **New: `omada_listBlockedClients`** (QUERY) lists blocked clients from the known-clients list, offline ones included, so automations can check block state. Graph mode gets `omada_read /clients/known` instead: one page of known clients with their `block` field (the controller cannot filter by block state, so a single-page "blocked" view would miss entries).
- **New: `omada_deleteClient`** (**CONFIGURE**) deletes the controller's record of a client (name, history, block state), to clear a block the unblock endpoint can no longer reach.
- `omada_blockClient`'s description now warns that a long block can become impossible to undo through the API and recommends a controller-side time-range rule for schedules such as a curfew.
- README: the two new Omada tools are listed (32).
- +30 tests (redaction across SSID, RADIUS, PPSK, VPN, SNMP, portal, webhook and camera shapes, and through `omada_read`; the unblock fallback including the orphaned-record case and a record without block state; the blocked list; deleteClient and its permission; mutation-checked).

### 2.2.0
- **New: owner questions — approve or deny from the phone.** `askOwner` sends a sticky, persistent notification with 1-3 buttons (default Approve / Deny) and returns a `requestId` at once; `getOwnerAnswer` waits up to 50 s per call and returns `answered` (button index and label, `answeredAt`, the HA user who tapped), `pending`, `timeout`, `cancelled` or `unknown`; `cancelOwnerQuestion` withdraws a question and marks the notification "Cancelled". Two calls rather than one long one because Cloudflare cuts requests at ~100 s. Questions stay open up to 7 days (default 10 min); the phone removes the notification at expiry by itself.
  - **No database, restart-proof:** the requestId carries the question, buttons, target, expiry and asking client, signed with a key derived from `MCP_AUTH_SECRET`; each button's action id is signed separately and cannot be derived from the requestId. After a restart the server still recognises open questions and the taps on them. Only a tap during the restart itself is lost (the question then expires as NO).
  - **Security:** a tap counts only with origin REMOTE and a user (the mobile app webhook), so an automation firing a fake `mobile_app_notification_action` cannot approve anything; tampered ids, extended expiries and swapped button indexes are rejected; only the asking token `sub` can read or cancel; at most 3 open questions and 30 per hour per client; first tap wins; late taps are ignored. Needs `NOTIFY`.
  - **Plain text only:** question at most 256 characters (line breaks allowed), title 60, button labels 20. Text is NFC-normalized (Romanian diacritics are fine), then emoji, control and invisible characters (zero-width joiners, bidi overrides), variation selectors and stacked combining marks are refused with the offending character named — never silently stripped or cut.
  - **`MCP_OWNER_QUESTIONS_HA_USERS`**: comma-separated HA user ids allowed to answer (the `answeredBy` of an answer); unset = any HA user, with a startup warning.
  - Known limit, accepted: cancellations and answers are kept in memory only. After a restart, someone with a Home Assistant login could re-send an old button id through HA's API and answer a question that had been cancelled or denied (the phone no longer shows its buttons; that access already controls the house).
  - Needs HTTP mode, an **admin** Home Assistant token (button taps are not on HA's non-admin event allowlist) and `MCP_AUTH_SECRET`. If Home Assistant refuses the tap subscription at startup, the three tools are not offered (logged); if it refuses later, `askOwner` returns an error saying so instead of sending questions nobody can answer. New `MCP_OWNER_QUESTIONS_ENABLED` (default `true`).
- **Fix — `getAutomationTrace` always answered "Not Found".** Home Assistant has no REST trace endpoint; traces exist only over the WebSocket (`trace/list`, admin-only) and are keyed by the automation's `id` attribute, not its entity id. The tool now uses a one-off WebSocket command, returns the newest runs first (new `limit`, default 5, max 20) with trigger, state and errors, and explains when an automation defined in YAML without an `id` has no traces.
- **Fix — Home Assistant events stopped after an HA restart.** The WebSocket client reconnected but never re-sent its subscriptions (HA forgets them with the connection), so `/subscribe_events` went silent after every HA restart. Subscriptions are now restored on reconnect; the client keeps retrying with the delay capped at 60 s instead of giving up after 10 attempts; commands are matched to their results by id (they were matched in arrival order); connecting has a deadline and fails at once if HA closes before authenticating; and a subscription made while Home Assistant is unreachable (also at server startup) is queued and sent once HA is back, instead of failing (an SSE client stays connected and receives events when HA returns; previously owner questions and SSE stayed unavailable until a server restart). Unsubscribing works while HA is offline (the subscription is forgotten for good, never restored on reconnect), and a subscription cancelled before HA confirmed it is cancelled on HA's side too. A subscription HA refuses (e.g. a non-admin token) is reported and dropped; one whose confirmation is lost is cancelled and retried (no duplicate subscriptions on HA); and an event HA sends right after confirming a subscription is no longer dropped. Errors from these WebSocket commands reach callers and logs as HA's error code only (e.g. `Home Assistant rejected 'trace/list' (unauthorized)`), never HA's free text or the internal address; the detail stays in the server log. The WebSocket connections now follow `HA_STRICT_SSL` like the REST client.
- **Fix — duplicate events.** With two subscriptions to the same event type, each received every event twice (HA sends one copy per subscription). Each copy now goes only to its own subscription.
- **Logging — tool arguments are logged at debug level only.** The info-level `Tool invoked` line now carries just the tool and session; the arguments (message and question text, entity names, MAC addresses) appear only with `LOG_LEVEL=debug`.
- README: `MCP_SSE_EVENTS_ENABLED` defaults to `true` (the README said `false`).
- +88 tests (owner question service and tools incl. a real MCP round trip and concurrent rate limits, plain-text validation, WebSocket client against a fake HA server incl. reconnects, deadlines and the TLS policy, trace lookup; the security checks are mutation-tested).

### 2.1.1
- **Fix — `omada_setSiteNtpServers` was rejected by the controller on sites with daylight saving off.** Omada returns the DST start/end as empty objects when DST is off, but rejects them on write ("Daylight saving parameter [month] should not be null"). The site update now sends DST start/end only when complete; with DST on and an incomplete start/end it refuses to write. The rejected 2.1.0 call changed nothing (the controller validates before saving).
- +2 tests (the live DST-off shape; DST on with an incomplete start/end).

### 2.1.0
- **New: site NTP tools for Omada.** `omada_getSiteNtpStatus` (QUERY; also `omada_read /network/ntp` in graph mode) reads the NTP configuration and status. `omada_setSiteNtpServers` (**CONFIGURE**, not CONTROL: it changes site-wide configuration) replaces the site NTP server list (hostnames or IPv4, at most 5) and can turn NTP on or off. Omada has no NTP-only write: NTP lives in the site settings, so the tool reads the site, changes only the NTP fields and writes the whole site back (`PUT /sites/{siteId}`), translating the read and write shapes (servers are strings on read, `{ address }` objects on write; read-only DST fields are dropped). It refuses to write if the site lacks a required field, validates every address before contacting the controller, supports `dryRun` to preview the exact request, and reports the before/after lists as the controller holds them. The controller has no conditional update, so writes are serialized per site and the site is re-read just before the PUT: if a non-NTP setting changed in between, nothing is written and the call fails with a conflict. Not exposed on the Open WebUI REST bridge.
- README: the Omada tool list was stale (said 24, missed the block/unblock, PoE and SSID action tools); it now lists all 30.
- +42 tests (address validation, the update body, dry run, read-modify-write, conflict refusal, per-site serialization, controller rejection, the `/network/ntp` graph read, and RBAC: a CONTROL token cannot change NTP; mutation-checked).

### 2.0.0
- **Major version for the two major dependency upgrades below (MCP SDK v2, zod 4).** No configuration changes are needed and MCP clients are unaffected: same tools, same protocol versions, same auth.
- **MCP SDK v2 (split packages).** `@modelcontextprotocol/sdk` 1.x → `@modelcontextprotocol/server` 2.2 + `@modelcontextprotocol/node` 2.1. The production dependency tree shrinks from **95 packages to 8**: Express, body-parser, qs, cors, cross-spawn (Socket "shell access"), ajv (Socket "uses eval"), eventsource and the long tail of unmaintained Express helpers are gone. `npm audit` (incl. dev) reports 0. Client compatibility is unchanged: v2 still negotiates `2025-11-25` and older protocol versions (verified with `mcp-remote`, the Claude Desktop client, plus raw `2025-06-18` initialize). Applied with the official codemod, then by hand: tool `inputSchema`s pass schema objects (raw shapes are deprecated), and the REST bridge's synthetic request context moved to the v2 shape (`http.authInfo`) — without that, Open WebUI's tool calls would have been denied.
- **zod 3 → 4** (SDK v2 requires zod ≥ 4.2). `zodToOpenApiSchema` was ported to zod 4 internals (the generated OpenAPI spec is byte-identical). The JSON Schemas in `tools/list` change only cosmetically (key order, explicit safe-integer `maximum`, no top-level `additionalProperties: false`), except `createAutomation` now correctly advertises `trigger` and `action` as required.
- **Performance — schema conversion is memoized.** SDK v2 converts every tool schema to JSON Schema inside `registerTool`; with the stateless per-request server that made a full request ~60% slower (2.2 → 3.6 ms). `memoizeJsonSchema` caches each schema's conversion for the process (deep-cloned results, validation untouched, `tools/list` byte-identical), bringing a full request to **1.9 ms — faster than on v1**.
- **New: `npm run bench`** — vitest benchmarks of the per-request hot paths (server build, full `createServer`+`tools/list` round trip, JWT verify, argument validation), used to catch and fix the regression above.
- +6 tests (memoization, mutation-checked); test mocks moved to the v2 context shape.

### 1.7.6
- **`omada_read` is hidden from callers who can read no Omada resource.** It has no single static permission (it checks per resource path), so 1.7.5 still listed it to every caller, including unmapped tokens that could read nothing. A new per-tool visibility rule lists it only when the caller holds the permission of at least one readable node (e.g. a `QUERY` or an `ADMIN`-only mask); a `NONE`/`NOTIFY`-only caller no longer sees it. Per-path checks are unchanged.
- **CI: `actions/checkout` and `actions/setup-node` v4 → v7** (Node 24 runtime; v4 targeted the deprecated Node 20 action runtime). No workflow changes were needed: the breaking changes in v5–v7 concern automatic caching (not triggered — no `packageManager` field) and credential persistence (CI never pushes with git).
- `AGENTS.md`: the GHCR push token is fetched from the maintainer's password manager at push time — never stored as an environment variable.
- +4 tests (`omada_read` visibility for NONE / QUERY / ADMIN-only / NOTIFY-only masks).

### 1.7.5
- **Security — `tools/list` is filtered by the caller's permissions.** A token is only offered the tools it may call (e.g. a `readonly` token no longer sees `restartHomeAssistant`, `deleteAutomation`, `invokeAction` or the Omada write tools). Previously every valid token was shown all tools; calls were already denied, but LLM clients planned around tools they could not use and the admin surface was disclosed. Each tool's static permission is recorded by `wrapToolHandler`; `createServer({ callerPermissions })` disables the rest, so the SDK omits them from the list and rejects calls to them. Per-call RBAC is unchanged; stdio (local trust) is unfiltered; `omada_read`/`omada_browse` stay listed (they gate per resource path).
- **Fix — control tools no longer report success for a non-existent entity.** Home Assistant silently ignores service calls to unknown `entity_id`s, so `entityAction`, `controlLight`, `controlClimate`, `controlFan`, `controlCover`, `controlMediaPlayer`, `activateScene` and `runScript` returned `success: true` for typos. They now check existence first and return `isError` "Entity not found" ("No action was performed") without calling the service.
- **Warning — permissive `defaultRole`.** With bearer auth, the server logs a startup warning when `MCP_PERMISSIONS_CONFIG` `defaultRole` grants anything, since it applies to every valid token with an unmapped `sub`. README now recommends `defaultRole: NONE` plus one `users` entry per client (and fixes the `ADMIN` role row, which wrongly said "all except AI").
- **Fix — `generate:jwt` prints the token once.** stdout carries only the bare token; details go to stderr, so `TOKEN=$(npm run -s generate:jwt -- ...)` captures exactly one token.
- Added `.codex/review-rules.md` (the repo's hard rules for pre-release code review).
- +26 tests: permission-filtered `tools/list` over an MCP client and over the real HTTP path (bearer auth → stream transport, incl. interleaved callers), the entity guard for all eight tools, `defaultRoleWarning` and its wiring in the auth middleware, and the `generate:jwt` stdout contract (subprocess).

### 1.7.4
- **Security — cleared every advisory in the dependency tree** (`npm audit` and `npm audit --omit=dev` both report 0). Runtime range declarations are unchanged; all fixes are in-range lockfile bumps:
  - Production: `undici` 6.28.0→6.29.0 (WebSocket DoS ×2, retry-interceptor response splitting), `fast-uri` 3.1.6→3.1.8 (authority injection / host confusion; via ajv), `hono` 4.13.3→4.13.11, `ip-address` 10.5.0→10.7.2, `qs` 6.15.3→6.16.0 (all three transitive under the SDK's express stack).
  - Dev-only: `vitest` + `@vitest/coverage-v8` 4.1.10→4.1.11 (devDependency floor raised to `^4.1.11`), `brace-expansion`, `js-yaml`, `nanoid`, `postcss`; `esbuild` pinned back to 0.27.2 (the advisory covers 0.27.3–0.28.0).
  - None of the production advisories were reachable here — the vulnerable surfaces (undici's WebSocket/retry interceptor, hono/express/qs request parsing, ip-address) are never imported by this server — but they failed the `npm audit` CI gate.
- **Image rebuilt on the current base**: Node 24.19.0→24.21.0 (bundled OpenSSL 3.5.7→3.5.8, bundled undici 7.29.0→7.29.1), Alpine 3.24.1→3.24.2, `curl` 8.21.0→8.22.0, `libssl3`/`libcrypto3` 3.5.8. No source changes.

### 1.7.3
- **Fix — stateless `GET /mcp` now returns `405 Method Not Allowed` instead of hanging forever.** In stateless mode every request gets a fresh transport, so the SDK's standalone SSE GET opened a stream that never emitted a byte and never ended. That eternal zero-byte response pinned the Cloudflare→origin keep-alive socket, and HTTP/1.1 serial semantics stalled every request queued behind it — mcp-remote's own `WWW-Authenticate` probe GET poisoned the socket its `initialize` POST was then queued on, surfacing as intermittent "Request timed out" (and occasional CF 502) for Claude Desktop / Cowork sessions. Also fixes the resource leak (each hung GET pinned a socket + a full McpServer instance). Stateful mode is unchanged. +4 regression tests (`isStatelessMcpGet`).
- Removed `src/wrapper.ts` — a dead legacy HTTP wrapper (unauthenticated, spawn-per-request) that nothing referenced but still compiled into the shipped image. Verified unused: n8n calls the native `/mcp` endpoint; the live server already 404'd the wrapper's `POST /` route.
- `openapi.json`: dropped the stale `POST /` "raw JSON-RPC passthrough" advertisement (the endpoint 404s; n8n uses `/mcp`).
- Removed the unused `customRequestSchema` export (never registered as a tool).
- `parsePermissionsConfig` now logs a warning when `MCP_PERMISSIONS_CONFIG` is invalid JSON instead of silently resolving every caller to NONE (still fail-closed).
- Track `AGENTS.md` (agent instructions for the repo), updated to the current release process (CI OIDC npm publish, WSL Docker build) and current facts (REST bridge is RBAC-gated).

### 1.7.2
- Fix: a malformed JSON request body now returns `400 Bad Request` (was `500`) — `parseBody` tags the parse failure and the handler returns the parse detail; oversize bodies still `413`, genuine faults still `500`.
- Security: cleared every high/moderate advisory in the production tree via already-in-range bumps (no `overrides`, no hard-dep downgrades, `package.json` unchanged; `npm audit --omit=dev` now 0): `ip-address` 10.2.0→10.5.0 (SSRF), `fast-uri` 3.1.3→3.1.6, `@hono/node-server` 1.19.14→1.19.17 (serve-static path traversal), `hono` 4.12.29→4.13.3 (middleware DoS), `undici` 6.27.0→6.28.0.
- Remaining `npm audit` findings are dev-only tooling (esbuild/vitest/tsx) that never ships.

### 1.7.1
- Per-action cooldown on `invokeAction`: a minimum interval between firings (default 60s, 0 disables) so an injected model can't loop a *legitimate* remote-hands action into a deploy storm / endpoint DoS. Check-and-claim runs before the fetch; a failed call still consumes the slot.
- Fix: undici pairing — dispatcher requests now use undici's own `fetch`. An npm-undici-6 `Agent` passed to Node's built-in fetch broke on Node 26 ("invalid onError method" → "fetch failed"); the real root cause of the v1.5.5 crash-loop.
- README npm badge → shields.io (badge.fury.io served a stale cached version).

### 1.7.0
- Unified chat-face registry: one source generates the OpenAPI spec and the `MCP_CHAT_TOOLS` slice; Omada tools made chat-eligible.
- Fix two stale OC200-v6 integration tests (totalTraffic rename, required threat-list params).

### 1.6.0
- Remote-hands actions: `invokeAction` fires pre-registered REST actions (`MCP_REST_ACTIONS`) — deploy triggers / webhooks, each individually gated (name-only lookup, no arbitrary URLs).
- package.json: add repository / homepage / bugs metadata.

### 1.5.6
- Runtime base → `node:24-alpine` LTS (node:26 broke the old-kernel NAS's first fetch); npm stripped from the runtime image.
- CI: boot-test the built image (mock HA + `/health`) so a release is never the image's first run; auto-create the GitHub Release on `v*` tags; tokenless npm publish via OIDC trusted publishing; also test on Node 26 (the image runtime).

### 1.5.5
- CVE patch: refresh dependencies, `node:26` base (node:25 EOL), `apk upgrade`, drop unused `--experimental-quic`.
- Fix: regenerate the lockfile on Linux — a Windows-generated lock omitted `@emnapi/*` optional deps, failing `npm ci` in the Docker/CI build.

### 1.5.4
- Actionable error hints so agents self-correct: `getState` / `entityAction` / `hass://entities/{id}` return a `hint` toward `searchEntities` on a missing/malformed `entity_id`; Omada `resolveSiteId` with no site hints to `omada_browse /`; corrected stale Omada SSID getter refs to graph paths (`omada_read /wifi/groups`, `/wifi/ssids`). Additive — error text only, no API/behavior change.

### 1.5.3
- Fix: add `x-session-id` to `Access-Control-Allow-Headers` so Open WebUI's OpenAPI tool calls pass CORS preflight (the browser was blocking every call on the unlisted header → "NetworkError"). Final piece with v1.5.1 (https scheme) + v1.5.2 (CORS on 401/429) to make `/api/*` calls complete.

### 1.5.2
- Fix: apply REST-bridge CORS (`/openapi.json`, `/api/*`, SSE path) **before** auth / rate-limit, so a `401` / `429` still carries `Access-Control-Allow-Origin`. A browser discards a header-less cross-origin response and reports "NetworkError", hiding the real `401` — making an auth misconfig look like a tunnel failure. Path test extracted to `isRestApiCorsPath()`; 200s unchanged.

### 1.5.1
- Fix: `/openapi.json` honors `X-Forwarded-Proto` so `servers[0].url` advertises `https` behind the TLS-terminating Cloudflare tunnel (was hardcoded `http://`, blocked as mixed content on an https page → "NetworkError"). New `resolveForwardedProto()` validates against an allowlist (spoof-safe; first hop of a comma chain). No change for plain-HTTP.

### 1.5.0
- Feature — Omada resource graph Tier 4 reads (still just `omada_browse` + `omada_read`, zero tool-schema cost), grounded in the reference API client, over the existing `OmadaClient.readResource()`:
  - VPN (`/vpn`): `/site-to-site` (list or single via `id`), `/client-to-site/servers`, `/client-to-site/clients`, `/wireguard`, paginated `/ipsec-stats`.
  - Profiles (`/profiles`): `/ppsk` (**requires** `params.type` 0/1) and `/time-range`.
  - Schedules (`/schedules`): `/poe`, `/port`, `/upgrade`.
  - Backup (`/backup`): `/files`, `/result`.
  - Audit (`/audit`) — **ADMIN-gated**: `/site` and `/global`, paginated with optional epoch-ms `startTime`/`endTime` + `searchKey` (new `auditFilters` helper).
  - First ADMIN subtree beyond `/security`, further exercising per-path RBAC.

### 1.4.0
- Feature — Omada resource graph widened from ~33 to **54 readable nodes** at the same two-tool surface (`omada_browse` + `omada_read`), zero tool-schema cost; every node grounded in the controller OpenAPI spec + reference client, over `OmadaClient.readResource()`:
  - Typed-read parity: `/devices/search`, `/network/load-balance` — every typed getter now has a graph node.
  - Tier 2 (insight): `/devices/cable-test` (requires `switchMac`), `/network/port-forwarding/rules`, `/network/dhcp-leases`, dashboard `/client-distribution`, `/traffic-distribution`, `/traffic-activities`.
  - Tier 3 (home subset, skipping enterprise gear): `/devices/poe`, `/lldp`, `/network/dhcp-reservations`, `/static-routes`, `/ip-mac-binding`, `/attack-defense`, `/acls/{gateway,switch,eap}`, `/url-filters/{gateway,eap}`, `/mac-filters/{allow,deny}`, `/wifi/band-steering` — all read-only, QUERY-gated.
  - Paginated nodes forward one `page`/`pageSize` (no page-walking).

### 1.3.4
- Feature — Omada resource-graph tool registration (`MCP_TOOL_REGISTRATION_MODE=graph`): registers `omada_browse` (permission-filtered tree of resource **types**) + `omada_read` (per-path-RBAC fetch, single-page pagination) + the 5 typed write/action tools, replacing ~21 read getters; `eager` (default) unchanged. One `OmadaClient.readResource()` primitive backs the newly-exposed endpoints. `graph` is now a complete superset of `eager` reads, incl. the ADMIN-gated IDS/IPS log at `/security/threats` (required epoch `startTime`/`endTime`) — first node above QUERY. New `namespace.ts`/`graph.ts`, `getCallerPermissions()` extracted; +47 tests.
- Fix — `OMADA_SITE_ID` validated against the live controller at startup: an id not present on the controller (drift after migration, like `OMADA_OMADAC_ID`) now disables the Omada plugin with an error naming the bad value + valid sites, instead of silently scoping reads to a dead site (later "user does not have permissions to access this site"). HA/AI keep working; valid default still auto-resolves. New `checkConfiguredSite()` + 4 tests.
- Fix — graph reads that require query params now send them: `/events` + `/events/alerts` send `filters.timeStart`/`timeEnd` (epoch ms, default last 7d, `params.module`/`resolved` optional); `/dashboard/cpu` + `/memory` send `start`/`end` (epoch s, default last 24h); `/wifi/rogue`, `/wifi/wids` (Pro-only), `/devices/pending` marked paginated. Surfaces the controller's `errorCode`/`msg` in thrown HTTP errors (was a bare `400`). Window helpers `resolveLogWindowMs`/`resolveUsageWindowSec`; +10 tests.

### 1.3.1
- Patch — RBAC role-name case-insensitivity (follow-up to v1.3.0 fail-closed change): `getUserPermissions` resolves per-user `role` and `defaultRole` case-insensitively, so lowercase `"operator"`/`"admin"` in `MCP_PERMISSIONS_CONFIG` map correctly instead of collapsing to an empty mask; unknown roles still fail closed to `NONE`. Tests under `tests/permissions/`.

### 1.3.0
- **Security hardening release** — OWASP-aligned audit (API Top 10 2023 + Top 10 2021), every fix with regression tests under `tests/security/`; external behavior unchanged for correct configs. Suite → 908 tests; `npm audit --omit=dev` clean.
  - Access control: REST `/api/*` gated by the same RBAC bits as their MCP twins (`403` on insufficient perms); SSE `/subscribe_events` requires `QUERY`, dead `?token=` removed, SSE CORS constrained to the allowlist.
  - Authentication: opt-in `MCP_AUTH_REQUIRE_EXP` (reject no-`exp` tokens, default off + startup warning); optional `MCP_AUTH_ISSUER`/`AUDIENCE` + `nbf`/clock-skew; signing secret must be ≥32 chars for `bearer` (fail-fast).
  - Injection/SSRF: every interpolated HA path segment `encodeURIComponent`-encoded and schema-validated.
  - Crypto/transport: removed process-global `NODE_TLS_REJECT_UNAUTHORIZED=0` (per-client `undici` dispatcher only when `strictSsl=false`); SSE IDs via `randomUUID()`.
  - Configuration: `MCP_AUTH_METHOD=none` throws on non-loopback bind; opt-in DNS-rebinding Host validation via `MCP_HTTP_ALLOWED_HOSTS` (unset = off); removed `ALLOWED_ORIGINS=*` from compose; container runs non-root (`USER node`); static security headers on every response.
  - Resource limits: rate-limit keying trusts forwarding headers only from `MCP_RATE_LIMIT_TRUSTED_PROXIES` peers (else socket addr); 1 MB body cap (`413` + socket destroy); slow-loris headers/request/keep-alive timeouts.
  - Logging: client-facing `500`/SSE errors generic (detail server-side only); `/health` returns only `{"status":"healthy"}`.
  - Design: tool authz fails **closed** (missing mask denies, was `0xFF`); stdio opts into local full-trust explicitly.
  - Dependencies: bumped `@modelcontextprotocol/sdk`→`^1.29.0`, `ws`→`^8.21.0` (cleared 8 prod advisories, 5 high); CI gate asserts zero high/critical.

### 1.2.0
- **Omada Client Block/Unblock**: Block or unblock a network client by MAC address
  - New tool `omada_blockClient`: denies a client all network access until unblocked
  - New tool `omada_unblockClient`: restores a previously blocked client's access
  - Backed by the Omada Open API `POST .../clients/{mac}/block` and `/unblock` endpoints
  - Both require the `CONTROL` permission and return a `{ mac, siteId, blocked }` status object
  - Total Omada tools: 23 → 25
- All tests passing

### 1.1.0
- **Performance: Paginated Entity Queries**: Reduced response sizes by ~98% for entity queries
  - New `LightweightEntity` type returns only essential fields (entity_id, state, friendly_name, unit_of_measurement, last_changed)
  - Default response size reduced from ~800KB-1MB to ~15KB for typical queries
  - Pagination with configurable page size (1-200, default 50)
  - Tools updated: `getStates`, `getAllSensors`, `searchEntities`, `getEntitiesByDomain`, `listEntities`
  - New parameters: `page`, `pageSize`, `includeAttributes` (set `includeAttributes=true` for full entity data)
  - Backward compatible: tools work without parameters using sensible defaults
- **MCP Server Instructions**: Added server instructions for improved LLM tool selection
  - Instructions are sent during MCP initialization to guide LLMs on optimal tool usage
  - Dynamically generated based on enabled plugins (HA, Omada, AI)
  - Covers entity queries, device control, automation workflows, Omada operations, and cross-plugin integration
  - Follows MCP best practices for concise, actionable guidance
- **Fix: Graceful Omada startup degradation**: Server no longer crashes when Omada credentials are invalid or controller is unreachable
  - Omada plugin disables itself with a warning instead of taking down the whole server
  - Home Assistant and AI plugins continue working normally
- **Fix: Omada auth error clarity**: Error code `-44106` now explicitly hints to check `OMADA_OMADAC_ID` in addition to client credentials, since Omada returns the same code for both invalid credentials and an incorrect controller ID (e.g. after a controller version upgrade)
- All 829 tests passing

### 1.0.0
- **TP-Link Omada Network Integration**: Full support for Omada SDN controller
  - 24 new tools for network management (total tools: 60)
  - Site management: `omada_listSites`
  - Device management: `omada_listDevices`, `omada_getDevice`, `omada_searchDevices`, `omada_getSwitchStackDetail`, `omada_listDevicesStats`
  - Client management: `omada_listClients`, `omada_getClient`, `omada_listMostActiveClients`, `omada_listClientsActivity`, `omada_listClientsPastConnections`
  - Rate limiting: `omada_getRateLimitProfiles`, `omada_setClientRateLimit`, `omada_setClientRateLimitProfile`, `omada_disableClientRateLimit`
  - Security: `omada_getThreatList`
  - Network config: `omada_getInternetInfo`, `omada_getPortForwardingStatus`, `omada_getLanNetworkList`, `omada_getLanProfileList`, `omada_getWlanGroupList`, `omada_getSsidList`, `omada_getSsidDetail`, `omada_getFirewallSetting`
  - OAuth2 authentication with automatic token refresh
  - New environment variables: `OMADA_PLUGIN_ENABLED`, `OMADA_BASE_URL`, `OMADA_CLIENT_ID`, `OMADA_CLIENT_SECRET`, `OMADA_OMADAC_ID`, `OMADA_SITE_ID`, `OMADA_STRICT_SSL`, `OMADA_TIMEOUT`
- **JWT Authentication**: Replaced static bearer tokens with JWT-based authentication
  - `MCP_AUTH_SECRET`: JWT signing secret (min 32 chars, HS256 algorithm)
  - Token validation with expiration support (`exp` claim)
  - User identification via `sub` claim for permission lookup
- **Permission System**: Role-based access control with binary masks
  - Permission binary masks: ADMIN (1), CONFIGURE (2), CONTROL (4), QUERY (8), NOTIFY (16), AI (32) (sorted by criticality)
  - Role presets: NONE, READONLY, OPERATOR, CONTRIBUTOR, ADMIN, SUPERUSER
  - User-to-role mapping with id/sub based authentication
  - `MCP_PERMISSIONS_CONFIG` environment variable for configuration
  - Case-insensitive role lookup in configuration
- **MCP SDK AuthInfo Integration**: Proper integration with MCP SDK authentication
  - Permissions passed via `authInfo.extra.permissions` to tool handlers
  - Tools enforce permission requirements (e.g., READONLY users denied CONTROL tools)
- **Plugin Architecture**: Modular plugin system for extensibility
  - Home Assistant plugin (`HA_PLUGIN_ENABLED`)
  - Local AI plugin (`AI_PLUGIN_ENABLED`)
  - Omada network plugin (`OMADA_PLUGIN_ENABLED`)
- **Environment Variable Cleanup**: Standardized naming conventions
  - Renamed `LOCALAI_PLUGIN_ENABLED` to `AI_PLUGIN_ENABLED`
  - Deprecated `MCP_SERVER_MODE`, `MCP_SERVER_PORT`, `MCP_SERVER_HOST`
- **Minimal Logger**: Replaced pino with lightweight built-in logger
  - Supports plain, JSON, and GCP-JSON log formats
  - Zero external logging dependencies
- All 688 unit tests + 44 integration tests passing

### 0.9.0
- **Streamable HTTP Only**: Removed deprecated SSE transport, keeping only Streamable HTTP
  - Real-time HA event subscriptions still available at `/subscribe_events`
- Preparing for future QUIC transport (Node.js 25+ experimental support)
- All 648 tests passing

### 0.8.0
- **Bearer Token Authentication**: Secure HTTP endpoints with bearer tokens
  - `MCP_AUTH_METHOD`: Set to `bearer` to enable authentication
  - `MCP_AUTH_TOKEN`: Comma-separated tokens for multiple clients
  - `WWW-Authenticate` header on 401 responses
  - Health check and OpenAPI endpoints skip authentication
- **Server-Timing Header**: Response timing on all HTTP responses
  - `Server-Timing: total;dur=X` header (integer milliseconds)
  - Visible in browser DevTools Network tab
- **Modular Auth Middleware**: Clean separation in `src/server/auth.ts`
- All 648 tests passing

### 0.7.0
- **Calendar Tools**: Access Home Assistant calendar entities
  - `listCalendars`: Get all calendar entities
  - `getCalendarEvents`: Get events from one or all calendars with date filtering
- **Person Tracking Tool**: Track household members
  - `listPersons`: List all person entities with location state (home/away)
  - Optimized description for small LLM tool selection
  - Returns onsite/away counts and linked device trackers
- Total tools increased from 34 to 37

### 0.6.0
- **Mobile App Notifications**: Full support for Home Assistant mobile app notifications
  - `sendNotification`: Enhanced with action buttons, priority, images, videos
  - `listNotificationTargets`: Discover available mobile app notification targets
  - Android-specific options: priority, channel, LED color, vibration patterns
  - iOS-specific options: interruption level, badge count, critical alerts
  - Sticky and persistent notification support
- **Fixed Automation API**: `createAutomation` now works correctly
  - Uses correct endpoint: `POST /config/automation/config/{id}`
  - Auto-generates timestamp-based IDs (like HA UI)
  - Auto-reloads automations after creation
  - Added optional `id` field to AutomationConfig type
- **Refactored Tools Architecture**: Split monolithic registry into individual tool files
  - Each tool now in its own file under `src/tools/`
  - Improved maintainability and code organization
  - Shared schemas and utilities in `src/tools/common.ts`
- Switched to NodeNext module resolution for TypeScript
- All 310 tests passing

### 0.5.0
- **Real-time SSE Event Subscription**: Subscribe to Home Assistant events via Server-Sent Events
  - Filter by domain, entity_id, or event types
  - Automatic WebSocket connection to Home Assistant
  - Keep-alive support for persistent connections
- **Enhanced Automation Management**: Full automation lifecycle support
  - `triggerAutomation`: Manually trigger automations with variables
  - `enableAutomation`/`disableAutomation`/`toggleAutomation`: Control automation state
  - `createAutomation`: Create new automations via API
  - `deleteAutomation`: Remove automations
  - `reloadAutomations`: Reload from configuration
  - `getAutomationTrace`: View execution history
- **Advanced Device Control Tools**:
  - `controlLight`: Brightness, color, color temperature, transitions
  - `controlClimate`: Temperature, HVAC mode, fan mode, presets
  - `controlMediaPlayer`: Playback, volume, mute controls
  - `controlCover`: Position and tilt control
  - `controlFan`: Speed, oscillation, direction
  - `activateScene`: Scene activation
  - `runScript`: Script execution with variables
  - `sendNotification`: Send notifications through Home Assistant
- **Rate Limiting**: Built-in token bucket rate limiter
  - Configurable window and request limits
  - Per-IP tracking with automatic cleanup
  - Skip paths for health checks
- **New Configuration Options**:
  - `MCP_SSE_EVENTS_ENABLED`: Enable/disable SSE
  - `MCP_SSE_EVENTS_PATH`: Customize SSE endpoint
  - `MCP_RATE_LIMIT_ENABLED`: Enable/disable rate limiting
  - `MCP_RATE_LIMIT_WINDOW_MS`: Rate limit window
  - `MCP_RATE_LIMIT_MAX_REQUESTS`: Max requests per window
- Total tools increased from 16 to 33

### 0.4.0
- **Extensible AI Provider System**: Refactored AI client to support multiple providers
  - New `src/localAI/` folder with provider-based architecture
  - Supports Ollama (native API) and OpenAI-compatible APIs (LocalAI, LM Studio, vLLM)
  - New environment variables: `AI_PROVIDER`, `AI_URL`, `AI_MODEL`, `AI_TIMEOUT`, `AI_API_KEY`
- Refactored `haClient.ts` into modular folder structure (`src/haClient/`)
- Split monolithic client into dedicated operation classes:
  - `request.ts` - HTTP request handler
  - `states.ts` - State operations (getStates, getState, getAllSensors)
  - `services.ts` - Service operations (callService, restartServer)
  - `entities.ts` - Entity operations (getEntitiesByDomain, searchEntities, listEntities, getDomainSummary)
  - `automations.ts` - Automation operations (getAutomations)
  - `history.ts` - History operations (getHistory, getSystemLog)
  - `updates.ts` - Update operations (getAvailableUpdates)
  - `config.ts` - Config operations (getVersion, getConfig, checkApi)
  - `index.ts` - Main HaClient class composing all operations
- Improved code organization following modular architecture pattern
- No changes to public API or tools - fully backward compatible
- All 325 tests pass

### 0.3.0
- Added 8 new tools: `getVersion`, `entityAction`, `listEntities`, `getDomainSummary`, `listAutomations`, `restartHomeAssistant`, `getSystemLog`, `checkUpdates`
- Added MCP Resources support with 5 URI-based endpoints (`hass://entities`, etc.)
- Added `entityAction` tool for simplified turn_on/turn_off/toggle operations
- Added `listEntities` tool with domain, state, search, and limit filtering
- Added `getDomainSummary` tool for domain statistics
- Added `listAutomations` tool for automation management
- Added `restartHomeAssistant` tool for server control
- Added `getSystemLog` tool for viewing logbook entries (events, state changes)
- Added `checkUpdates` tool to check for available updates (Core, Supervisor, OS, add-ons)
- Total tools increased from 8 to 16
- Enhanced type definitions for Automation, DomainSummary, HaVersion, LogbookEntry, UpdateInfo

### 0.2.0
- Added AI-powered sensor analysis with Ollama
- Added `getAllSensors` tool
- Added `analyzeSensors` tool
- Added `getHistory` tool
- Added phi4:14b as recommended model (9.5/10, 6.65s avg)
- Added qwen3:14b support (10/10 accuracy, 12.5s avg)
- Added comprehensive security documentation
- Added UFW firewall configuration guide
- Added n8n workflow examples and import instructions
- Updated to Node.js 20+ (v20.19.6) and npm 10.8+
- Updated installation instructions with verified versions
- Added Docker CLI workflow import method
- Enhanced troubleshooting with network/firewall diagnostics

### 0.1.0
- Basic Home Assistant integration
- 5 core tools (getStates, getState, callService, getEntitiesByDomain, searchEntities)
- Multiple transport modes (stdio, SSE, HTTP streaming)
- Full TypeScript support