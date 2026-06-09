### 1.5.3
**Fix — allow the `x-session-id` request header in CORS so Open WebUI tool calls work.**
Open WebUI sends an `x-session-id` header on every OpenAPI tool call. The REST bridge's
CORS preflight only advertised `Access-Control-Allow-Headers: Content-Type, Authorization`,
so the browser's preflight check failed on the unlisted header and blocked the request
before it was sent — surfacing (yet again) as *"NetworkError when attempting to fetch
resource."* `Access-Control-Allow-Headers` now includes `x-session-id`. This was the final
piece: combined with v1.5.1 (https scheme) and v1.5.2 (CORS on 401/429), Open WebUI tool
calls against the `/api/*` bridge now complete.

### 1.5.2
**Fix — CORS headers on `/api/*` and `/openapi.json` rejections (401 / 429) so auth
failures stop masquerading as "NetworkError".**
The REST-bridge CORS headers were applied only *inside* the route handlers, which run
**after** the auth and rate-limit middleware. So a `401 Unauthorized` (bad/missing token)
or a `429` (rate limited) on a browser-facing endpoint went back with **no**
`Access-Control-Allow-Origin` header. A browser that receives a cross-origin response
without that header discards it and reports the generic *"NetworkError when attempting to
fetch resource"* — completely hiding the real `401`. This made an Open WebUI auth
misconfiguration look identical to a network/tunnel failure.

CORS headers for the browser-facing REST surface (`/openapi.json`, `/api/*`, the SSE
events path) are now applied **before** rate limiting and authentication, so every
rejection carries `Access-Control-Allow-Origin` and the browser surfaces the true status.
The path test is extracted into the `isRestApiCorsPath()` helper (shared by the preflight
and the new early-CORS step); `addRestApiCors()` is unchanged. No behavior change for a
successful (200) request — it already carried CORS.

### 1.5.1
**Fix — `/openapi.json` now advertises the correct scheme behind a TLS-terminating proxy.**
The OpenAPI document's `servers[0].url` was built with a hardcoded `http://`. Behind the
Cloudflare tunnel (which terminates TLS and forwards to the origin over plain HTTP), the
spec therefore advertised an `http://` server URL even though the public endpoint is
`https://`. An OpenAPI tool client loaded on an **https** page (e.g. Open WebUI) then
refused to call any tool, because the browser blocks `http://` subresource fetches from an
https origin as **mixed content** — surfacing as *"NetworkError when attempting to fetch
resource."*

The handler now honors the `X-Forwarded-Proto` header (set by Cloudflare / reverse
proxies) when constructing the advertised base URL, so a TLS-terminated deployment
advertises `https://`. The new `resolveForwardedProto()` helper validates the header
against an allowlist — anything other than a literal `https` falls back to `http`, and
comma-separated proxy chains take the first hop — so a spoofed value can't inject an
arbitrary scheme into the spec. No behavior change for plain-HTTP deployments.

### 1.5.0
**Feature — Omada resource graph: Tier 4 read coverage (VPN · profiles · schedules · backup · audit).**
Extends graph mode with the *home-relevant* slice of the previously zero-coverage Omada
categories — still at the same two-tool surface (`omada_browse` + `omada_read`), zero
tool-schema cost. Every node is grounded in the reference TP-Link Omada API client's actual
paths and required params, backed by the existing `OmadaClient.readResource()` primitive (no
new client code):

- *VPN status* (`/vpn`) — `/vpn/site-to-site` (list, or a single tunnel via `id`),
  `/vpn/client-to-site/servers`, `/vpn/client-to-site/clients`, `/vpn/wireguard`, and the
  paginated `/vpn/ipsec-stats`.
- *Profiles* (`/profiles`) — `/profiles/ppsk` (per-device Wi-Fi keys; **requires** `params.type`:
  0 = without RADIUS, 1 = with RADIUS) and `/profiles/time-range`.
- *Schedules* (`/schedules`) — `/schedules/poe`, `/schedules/port`, `/schedules/upgrade`.
  (Reboot schedules are site-template-scoped enterprise config and are intentionally omitted.)
- *Backup status* (`/backup`) — `/backup/files` and `/backup/result`.
- *Audit logs* (`/audit`) — **ADMIN-gated** (like `/security`): `/audit/site` (site-scoped) and
  `/audit/global` (controller-wide, not site-scoped). Both paginated, with optional epoch-ms
  `startTime`/`endTime` + `searchKey` filters via the new `auditFilters` helper.

This is the first subtree beyond `/security` to require ADMIN, further exercising per-path RBAC.
Suite grew by the corresponding namespace wiring + `auditFilters` tests.

### 1.4.0
**Feature — Omada resource graph expanded to broad read coverage (no tool-schema cost).**
Because `graph` mode keeps the tool surface at two tools (`omada_browse` + `omada_read`)
regardless of how many resources the manifest declares, the namespace was widened from ~33
to **54 readable nodes** with zero increase in the tool-schema budget — the "breadth without
bloat" payoff of progressive disclosure. Every new node is grounded in the controller's own
OpenAPI spec (required params verified) and the reference TP-Link Omada API client, then
backed by the existing generic `OmadaClient.readResource()` primitive (no new client code):

- *Completed the typed-read parity set* — `/devices/search` (global device search) and
  `/network/load-balance` (multi-WAN status) close the last gaps so every typed Omada read
  getter now has a graph node.
- *Tier 2 (network insight)* — `/devices/cable-test` (`/ports`, `/results`, `/logs`; requires
  `switchMac`), `/network/port-forwarding/rules` (the full NAT rule list, vs. status only),
  `/network/dhcp-leases` (active leases), and dashboard analytics
  `/dashboard/client-distribution`, `/dashboard/traffic-distribution`,
  `/dashboard/traffic-activities` (the latter two default to a last-24h epoch-seconds window).
- *Tier 3 (curated home-relevant subset)* — selected from the controller's ~900-endpoint
  long tail, skipping enterprise gear (fiber/OLT, site-templates, RADIUS/LDAP, enterprise
  VPN): `/devices/poe`, `/devices/lldp`, `/network/dhcp-reservations`, `/network/static-routes`,
  `/network/ip-mac-binding`, `/network/attack-defense`, `/network/acls/{gateway,switch,eap}`,
  `/network/url-filters/{gateway,eap}`, `/network/mac-filters/{allow,deny}`, and
  `/wifi/band-steering`. All read-only and QUERY-gated, consistent with `/network/firewall`.

Paginated nodes forward a single `page`/`pageSize` to one GET (no page-walking). Suite grew
by the corresponding namespace wiring tests.

### 1.3.4
**Feature — Omada resource-graph tool registration (`MCP_TOOL_REGISTRATION_MODE`).**
Implements the previously-designed-but-unbuilt registration-mode switch as a *resource
graph* for the Omada plugin. `MCP_TOOL_REGISTRATION_MODE=graph` registers two discovery
tools — `omada_browse` (navigate a permission-filtered tree of resource **types**, never
instances) and `omada_read` (generic, per-path-RBAC data fetch with single-page
pagination) — plus the 5 typed write/action tools, in place of the ~21 individual read
getters. `eager` (default) is unchanged. A single `OmadaClient.readResource()` primitive
(path-template driven) backs newly-exposed endpoints (gateway WAN/health, AP speed-test,
rogue-AP/WIDS, event/alert logs, dashboard CPU/memory, firmware info + controller-wide
critical-firmware) with no per-endpoint client code. `graph` mode is now a **complete
superset** of `eager` reads: the ADMIN-gated IDS/IPS threat-management log is exposed at
`/security/threats`, with its mandatory epoch time-window enforced via required
`params.startTime`/`params.endTime` (epoch seconds) validated before any controller call —
the first node to require a higher permission bit (ADMIN) than QUERY, demonstrating the
per-path RBAC. New manifest (`namespace.ts`) + tools (`graph.ts`); `getCallerPermissions()`
extracted in `tools/common.ts` and reused for per-path checks. Suite grew by 47 unit tests
(namespace + graph + config parsing).

**Fix — `OMADA_SITE_ID` is validated against the live controller at startup.** The Omada
controller's site list is now treated as the source of truth; `OMADA_SITE_ID` is only a
selector against it. At boot (reusing the existing `listSites()` connection test) a
configured `OMADA_SITE_ID` that is **not** present on the controller — e.g. a site id that
drifted after a controller migration, the same way `OMADA_OMADAC_ID` does — now disables the
**Omada plugin** with a clear, actionable error that names the bad value and lists the valid
sites, instead of silently scoping every site-scoped read to a dead site and surfacing later
as a confusing "user does not have permissions to access this site" error. The failure is
scoped to the Omada plugin only — Home Assistant and Local AI keep working (graceful
degradation preserved). Default-site auto-resolution for site-scoped reads is otherwise
unchanged: callers still need not pass `siteId` when a valid default is configured. New pure
`checkConfiguredSite()` helper + 4 unit tests.

**Fix — graph reads that require query parameters now send them (events/alerts, dashboard
CPU/memory, rogue-AP/WIDS, pending devices).** Seven graph nodes were authored from endpoint
paths alone and never sent the query parameters the controller requires, so every call
returned a bare framework `400 Bad Request` (rejected before reaching the Omada handler — no
`errorCode`/`msg` envelope). Verified against the live controller's own OpenAPI spec and
fixed:
- `/events` and `/events/alerts` now send the mandatory `filters.timeStart`/`filters.timeEnd`
  window (epoch **milliseconds**). The window is optional to the caller and **defaults to the
  last 7 days**, so a bare `omada_read('/events')` works; override via `params.startTime` /
  `params.endTime`, with optional `params.module` (and `params.resolved` for alerts).
- `/dashboard/cpu` and `/dashboard/memory` now send the mandatory `start`/`end` window
  (epoch **seconds**), defaulting to the **last 24 h**; override via `params.startTime` /
  `params.endTime`.
- `/wifi/rogue`, `/wifi/wids`, and `/devices/pending` are now declared `paginated` so they
  forward `page`/`pageSize` (all three are paginated list endpoints). `/wifi/wids` is
  documented as Omada **Pro-only** — on a standard controller it returns a clear "Pro only"
  message rather than data.
Two pure, unit-tested window helpers (`resolveLogWindowMs`, `resolveUsageWindowSec`) back the
defaults. Also surfaces the controller's own `errorCode`/`msg` in `RequestHandler`'s thrown
HTTP-error message (when present) so a rejected request explains itself instead of collapsing
to `"400 "` — internal hostnames/headers are still kept out of the message. Suite grew by 10
unit tests (window helpers + fixed-node wiring).

### 1.3.1
**Patch — RBAC role-name case-insensitivity.** Follow-up to the v1.3.0 fail-closed
permission change. `getUserPermissions` now resolves both the per-user `role` and the
`defaultRole` fall-back case-insensitively: a lowercase `"operator"` / `"admin"` in
`MCP_PERMISSIONS_CONFIG` (a common real-world spelling) maps to the correct mask instead
of silently collapsing to an empty (no-permission) mask. Unknown role names still fail
closed to `NONE`. Regression tests added under `tests/permissions/`.

### 1.3.0
**Security hardening release.** A full OWASP-aligned audit (API Top 10 2023 + Top 10 2021)
drove fixes across access control, authentication, injection, transport, configuration,
resource limits, logging, design, and dependencies. Every fix ships with regression tests
under `tests/security/` (organized by OWASP category). The server's external behavior is
unchanged for correctly-configured deployments; the changes close bypasses and tighten
defaults. Suite grew to 908 unit tests; `npm audit --omit=dev` is clean.

- **Access control (SEC-AC)**
  - REST `/api/*` routes are now gated by the same RBAC permission bits as their MCP-tool
    twins — a valid token no longer implies full Home Assistant control. Insufficient
    permissions return `403`.
  - SSE `/subscribe_events` now requires the `QUERY` permission; the dead `?token=` query
    param was removed and SSE CORS is constrained to the configured allowlist.
- **Authentication (SEC-AUTHN)**
  - New optional `MCP_AUTH_REQUIRE_EXP` rejects tokens lacking an `exp` claim (defaults
    **off** for backward compatibility; emits a one-time startup warning when a no-exp token
    is accepted).
  - Optional `MCP_AUTH_ISSUER` / `MCP_AUTH_AUDIENCE` validation plus `nbf` and clock-skew checks.
  - The JWT signing secret must be ≥32 chars when `MCP_AUTH_METHOD=bearer` — startup fails fast otherwise.
- **Injection / SSRF (SEC-INJ / SEC-SSRF)**
  - Every interpolated Home Assistant API path segment is now `encodeURIComponent`-encoded and
    schema-validated (entity/domain/service patterns), closing path-traversal and
    endpoint-redirection against the HA base URL.
- **Cryptographic & transport (SEC-CRYPTO)**
  - Removed the process-global `NODE_TLS_REJECT_UNAUTHORIZED=0` race; self-signed trust is now
    a per-client `undici` dispatcher used only when `strictSsl=false`. SSE client IDs use
    `randomUUID()` instead of `Math.random()`.
- **Configuration (SEC-CONFIG)**
  - `MCP_AUTH_METHOD=none` now throws at startup on a non-loopback bind (loopback dev still works);
    loud warning whenever `none` is active.
  - Opt-in DNS-rebinding Host validation via a new `MCP_HTTP_ALLOWED_HOSTS` env: leave it unset
    (default) and Host validation stays off so the server works everywhere; set it to the exact
    host(s) clients use to reach the server (its LAN IP:port and/or public domain) to enforce a
    `403` on any other `Host` header. Origin/CORS handling is unchanged. Removed the
    `ALLOWED_ORIGINS=*` wildcard from the shipped compose file. Container runs as non-root
    (`USER node`). Standard security headers
    (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) on every response.
- **Resource consumption (SEC-DOS)**
  - Rate-limit keying is spoof-proof: client forwarding headers (`CF-Connecting-IP` /
    `X-Forwarded-For` / `X-Real-IP`) are honored only when the immediate peer is a configured
    `MCP_RATE_LIMIT_TRUSTED_PROXIES` entry; otherwise the socket address is used, so forged
    headers can neither evade the limit nor exhaust memory.
  - Request bodies are capped at 1 MB (`413` on overflow, socket destroyed immediately) and the
    HTTP server enforces `headersTimeout`/`requestTimeout`/`keepAliveTimeout` against slow-loris
    (intake-only — long-lived SSE streams are unaffected).
- **Logging & disclosure (SEC-LOG)**
  - Client-facing `500`/SSE errors return a generic message; full detail is logged server-side only.
  - `/health` now returns `{ "status": "healthy" }` only — version, auth method, AI provider/URL,
    and client counts are no longer disclosed to unauthenticated callers.
- **Insecure design (SEC-DESIGN)**
  - Tool authorization fails **closed**: a missing permission mask denies (was `0xFF` allow-all).
    stdio (Claude Desktop) opts into local full-trust explicitly; HTTP always carries an explicit mask.
- **Dependencies (SEC-DEPS)**
  - Bumped `@modelcontextprotocol/sdk` → `^1.29.0` and `ws` → `^8.21.0`, clearing 8 production
    advisories (5 high) in the transitive tree. A CI gate test asserts zero high/critical from
    `npm audit --omit=dev`.

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