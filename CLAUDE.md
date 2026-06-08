# mcp-ha-connect -- Claude Code Agent

## Identity & Scope

This agent owns the **mcp-ha-connect MCP server** — a Model Context Protocol server for
Home Assistant, TP-Link Omada, and Local AI integration.

**Repo:** `github.com/coffeerunhobby/mcp-ha-connect`
**npm:** `@coffeerunhobby/mcp-ha-connect`
**Docker:** `ghcr.io/coffeerunhobby/mcp-ha-connect`
**Live endpoint:** Cloudflare domain → NAS Docker port 3000 (domain in NAS `.env`)

**Working directory:** `C:\workspace\mcp` — this is the canonical copy.
`W:\mcp-homeassistant` is a stale export at v0.8.0 — ignore it.

---

## Stack

- **Runtime:** Node.js 20+ (dev machine uses nvm)
- **Language:** TypeScript, compiled to `dist/` via `tsc`
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Transport:** Streamable HTTP (port 3000, path `/mcp`)
- **Auth:** JWT bearer tokens with RBAC permission system
- **Plugins:** Home Assistant · TP-Link Omada SDN · Local AI (Ollama/OpenAI-compat)
- **Tests:** Vitest (829 unit tests) + integration tests in `tests/integration/`
- **Container:** Alpine Node image, deployed on Synology NAS via Docker Compose

---

## Infrastructure

| Resource | Address | Notes |
|---|---|---|
| **MCP server** | `mcpserver.10.0.0.18.nip.io:3000` | NAS Docker container |
| **Home Assistant** | `homeassistant.10.0.0.19.nip.io:8123` | |
| **Omada controller** | `omada.10.0.0.18.nip.io:8043` | HTTPS, self-signed cert |
| **Ollama** | `ollama.10.0.0.17.nip.io:11434` | model `phi4:14b` |
| **n8n** | `n8n.10.0.0.18.nip.io:5678` | also exposed via Cloudflare |
| **NAS Docker path** | `/volume1/docker/mcp-ha-connect/` | compose.yaml + .env |
| **Cloudflare** | proxies public domain → NAS port 3000 | domain stored in `.env` |

---

## Secrets & Credentials

All secrets live in the NAS `.env` file and as **Windows User environment variables**.
Never store token values in source files, commit messages, or this file.

| Variable | Purpose |
|---|---|
| `NPM_MCP_HA_TOKEN` | npm Granular token for publishing |
| `GHCR_TOKEN` | GitHub PAT with `write:packages` scope |

### Retrieve for use

```powershell
$npmToken  = [Environment]::GetEnvironmentVariable('NPM_MCP_HA_TOKEN', 'User')
$ghcrToken = [Environment]::GetEnvironmentVariable('GHCR_TOKEN', 'User')
```

### npm token requirements

The npm token must be **Granular type** with:
- Scope `@coffeerunhobby` → **Read and write** (scope-level, not per-package)
- **Bypass two-factor authentication** ✅ checked

Create at: npmjs.com → Access Tokens → Generate New Token → Granular Access Token

**Critical:** Never run `npm logout` — it revokes the token server-side and deletes it
from npmjs.com. If the token disappears from the web UI, that's why.

---

## Release Process

### 1. Pre-flight

```powershell
cd C:\workspace\mcp
npm test          # all tests must pass
npm run build     # must compile clean
npm run lint      # ZERO errors AND zero warnings (see Code Quality policy)
```

### 2. Version bump

Update **both** files to the new version:
- `package.json` → `"version": "X.Y.Z"`
- `src/version.ts` → `export const VERSION = 'X.Y.Z';`

Update `docs/CHANGELOG.md` with the new version section.

### 3. Commit & tag

```powershell
git add .
git commit -m "vX.Y.Z - <short description>"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

Create the GitHub Release at:
`https://github.com/coffeerunhobby/mcp-ha-connect/releases/new?tag=vX.Y.Z`

### 4. npm publish

**Preferred: interactive login (browser).** Granular tokens keep getting revoked, so the
reliable path is an interactive `npm login`, which opens the browser for auth. The agent
**cannot** complete this alone — it MUST ask the user to run/confirm the browser login,
then publish together:

```powershell
cd C:\workspace\mcp
npm login                  # opens browser — USER completes this, agent waits
npm whoami                 # must print the account name, not 403
npm publish --access public
```

**Do NOT run `npm logout`** afterward — it revokes any granular token server-side.

> Agent rule: when a release reaches this step, STOP and ask the user to help with
> `npm login` and `npm publish --access public` (browser-based). Do not silently fall
> back to a stored token — if `npm whoami` returns 403, the token is dead.

### 5. Docker build & push

Docker Desktop must be running.

```powershell
$ghcrToken = [Environment]::GetEnvironmentVariable('GHCR_TOKEN', 'User')
$ghcrToken | docker login ghcr.io -u coffeerunhobby --password-stdin

cd C:\workspace\mcp
docker build --no-cache `
  -t ghcr.io/coffeerunhobby/mcp-ha-connect:X.Y.Z `
  -t ghcr.io/coffeerunhobby/mcp-ha-connect:latest .

docker push ghcr.io/coffeerunhobby/mcp-ha-connect:X.Y.Z
docker push ghcr.io/coffeerunhobby/mcp-ha-connect:latest
```

Use `docker build`, not `docker buildx build --platform`. The NAS is amd64 and a plain
build on a Windows/amd64 host produces the correct image.

### 6. Deploy to NAS

```bash
cd /volume1/docker/mcp-ha-connect
docker compose pull && docker compose up -d
docker compose logs --tail=30
```

---

## NAS `.env` — critical settings

```env
MCP_HTTP_BIND_ADDR=0.0.0.0
```

Must be `0.0.0.0`, not `127.0.0.1`. Docker port mapping requires the server to listen on
all interfaces inside the container — loopback only means Cloudflare gets a 502.

```env
MCP_HTTP_ALLOWED_ORIGINS=...,<cloudflare-domain>,https://<cloudflare-domain>
```

Must include both the bare hostname AND the `https://` form of the Cloudflare domain.
The MCP SDK checks the `host` header (no protocol) for DNS rebinding protection AND
the `origin` header (with protocol) for CORS.

---

## Omada SDN — known issues

**After upgrading the Omada controller version**, the `OMADA_OMADAC_ID` changes.
Error code `-44106` is returned for BOTH wrong credentials AND wrong `OMADA_OMADAC_ID` —
the API does not distinguish between them.

**To get the new Omada ID:**
Omada web UI → Settings → Open API → click the eye icon → copy **Omada ID**.

```bash
sed -i 's/OMADA_OMADAC_ID=.*/OMADA_OMADAC_ID=<new-id>/' /volume1/docker/mcp-ha-connect/.env
docker compose up -d
```

If Omada is unreachable or credentials are wrong, the server **gracefully degrades** —
Omada tools are disabled but HA and AI keep working. Set `OMADA_PLUGIN_ENABLED=false`
to disable Omada entirely while troubleshooting.

**`OMADA_SITE_ID` is validated at startup against the live site list** (the controller is
the source of truth; the env var is only a selector). If `OMADA_SITE_ID` is set but **not**
present on the controller — a site id can drift after a controller migration, exactly like
`OMADA_OMADAC_ID` — the **Omada plugin is disabled** at boot with a `logger.error` that
names the bad value and lists the valid sites (HA + AI stay up). This turns the old failure
mode (a silent default scoping every read to a dead site → later "user does not have
permissions to access this site") into a loud, self-diagnosing startup error. Fix by setting
`OMADA_SITE_ID` to one of the listed ids. Validation lives in `checkConfiguredSite()`
(`src/omadaClient/site.ts`); a *valid* default still auto-resolves, so site-scoped reads need
no explicit `siteId`.

---

## Code Quality — fix every error and warning

**Always fix errors AND warnings. Never label something "pre-existing debt" and move on.**

- `npm run lint`, `npm run build`, and `npm test` must all be **completely clean** —
  zero errors, zero warnings — before a change is considered done.
- If you touch a file (or a release surfaces lint output) and find existing errors or
  warnings, they are now yours to fix. "It was already broken" is not an acceptable
  reason to leave it.
- **Exception — release timing:** do not cut a patch release *solely* to clean up lint.
  If quality issues are found right after a release has shipped, fold the fixes into the
  **next feature's** commit rather than churning a `vX.Y.(Z+1)`. Outstanding cleanup of
  this kind is tracked in `.claude/NEXT-SESSION.md` so it isn't forgotten.

> Currently outstanding: `Function`-type lint warnings in the test mock helpers
> (`tests/tools/**/handlers.test.ts`). Fix these as part of the next feature change —
> NOT as a standalone patch release.

---

## Development

```powershell
cd C:\workspace\mcp
npm run dev             # tsx watch with .env
npm test                # vitest (excludes integration)
npm run test:watch      # watch mode
npm run lint            # eslint
npm run build           # tsc compile to dist/
npm run generate:jwt    # generate a test JWT token
```

### Integration tests (requires live .env)

```powershell
npm run test:integration
```

---

## Live testing against the running server

The dev machine can exercise the deployed MCP server two ways:

1. **Connected `homeassistant` MCP in Claude Desktop** — this agent has the live server
   wired in as an MCP connection, so HA/Omada tools can be invoked directly (no curl, no
   manual token; the configured bearer is used). **Caveat:** the MCP client caches the tool
   list at *connection time*. After flipping `MCP_TOOL_REGISTRATION_MODE` (eager ⇄ graph)
   and redeploying, that cached list is **stale** — Claude Desktop must reconnect (restart)
   before the new tool surface (`omada_browse`/`omada_read`, or the typed getters) shows up.
   Until it reconnects, calling a tool the live server no longer registers will fail.

2. **Direct `/mcp` curl** — generate a token with
   `npm run generate:jwt -- --sub <user> --exp 1h` (signs with the local `.env`
   `MCP_AUTH_SECRET`, which currently matches the NAS), then POST JSON-RPC to the server's
   `/mcp` with headers `Authorization: Bearer <tok>`, `Content-Type: application/json`,
   `Accept: application/json, text/event-stream`. Responses come back as SSE
   (`data: {...}` lines). `tools/list` and `tools/call` work **without** an initialize
   handshake in stateless mode. The reachable server address lives in
   `.claude/NEXT-SESSION.md` (gitignored — never put the real IP/domain here).

Permissions are resolved **server-side** from the token's `sub` via `MCP_PERMISSIONS_CONFIG`
(they are NOT carried in the token). Pick a `sub` whose mapped role has the bit you need —
e.g. the ADMIN-gated `/security/threats` node needs a `sub` mapped to an ADMIN role. The NAS
role map differs from the local `.env`, so don't assume `sub=admin` is actually ADMIN there.

---

## Never assume. Always verify.

- **Cloudflare 502**: check the container is running (`docker compose ps`) and
  `MCP_HTTP_BIND_ADDR=0.0.0.0` is set.
- **MCP client connects but tools fail**: check `MCP_HTTP_ALLOWED_ORIGINS` includes
  the Cloudflare domain in both bare and `https://` form.
- **Claude Desktop shows "Server disconnected" but `/health` is 200**: the client's
  mcp-remote auth header is malformed. A `"Authorization: Bearer ${MCP_AUTH_TOKEN}"`
  placeholder does NOT expand on Windows (`cmd /c` uses `%VAR%`, mcp-remote doesn't
  substitute `${VAR}`) → literal text is sent → server 401 → mcp-remote drops into a
  failing OAuth flow. Fix: inline the literal JWT in `claude_desktop_config.json`'s
  `--header` arg, and add `-y` to `npx` so first run doesn't hang. Verify the server
  side first with a direct `curl` POST to `/mcp` carrying the token.
- **npm publish returns 404 on PUT**: token likely has per-package scope instead of
  scope-level access, or "Bypass 2FA" is not ticked. Delete token and recreate.
- **Omada auth error -44106**: check `OMADA_OMADAC_ID` first, not just credentials —
  this error code covers both cases.
- **Before a release**: always run `npm test` and `npm run build` clean.
- **On release, bump the version everywhere**: `package.json`, `src/version.ts`,
  `docs/CHANGELOG.md`, AND `openapi.json` (`info.version`) — the last one drifts easily.

---

## Tool registration modes (`MCP_TOOL_REGISTRATION_MODE`)

Implemented as a **resource-graph** mode for the Omada plugin (config parses the var;
`config.toolRegistrationMode` threads through `createServer` → `registerAllTools` →
`registerOmadaTools`). Values:

- **`eager`** (default) — register every typed tool (~26 Omada tools). Today's behavior;
  fully backwards-compatible.
- **`graph`** — register only `omada_browse` + `omada_read` + the 5 typed write/action
  tools. Reads collapse into a discoverable resource graph (`src/tools/omada/namespace.ts`
  manifest + `src/tools/omada/graph.ts`), shrinking the tool-schema budget for low-context
  models while still exposing every read endpoint.

Design invariants (don't regress these):
- **browse returns TYPES, not instances** — `omada_browse(path)` lists permission-filtered
  child resource types + metadata (kind, permission, pagination, params). It never
  enumerates MACs or calls the controller.
- **read is per-path RBAC, fail-closed** — `omada_read` declares NO static tool permission;
  each manifest node declares its own bit (most reads = QUERY; the `/security/*` subtree =
  ADMIN). Unknown / container / under-privileged / missing-required-param paths all return a
  clean error and never fetch.
- **single-page pagination** — paginated nodes forward one page/pageSize to a single GET via
  `OmadaClient.readResource()`; they never walk every page.
- **graph is a complete superset of eager reads** — every eager read getter has a graph node,
  including the ADMIN-gated IDS/IPS threat-management log at `/security/threats`. Its mandatory
  epoch time-window is enforced via required `params.startTime`/`params.endTime` (epoch seconds),
  validated by `omada_read` before any controller call.

HA and AI plugins are unaffected (still eager). Writes stay typed + individually gated in
both modes — generic write verbs were deliberately rejected (prompt-injection / hallucination
surface).

---

## Security

This server controls real devices (HA, Omada) and is exposed publicly via Cloudflare, so
treat it as security-sensitive. A full audit (2026-06-07) with file/line findings is in
`.claude/NEXT-SESSION.md`; this section is the **durable policy** distilled from it.

### Dependencies — update, don't rewrite

- Runtime deps are intentionally tiny: `@modelcontextprotocol/sdk`, `ws`, `zod`.
  **Do not hand-roll replacements** for these (or for transitive libs like `hono`,
  `ajv`, `path-to-regexp`). A homegrown version loses community review and adds more
  bugs than it removes. Zod and the MCP SDK earn their keep.
- The alarming `npm audit` list (`hono`, `@hono/node-server`, `fast-uri`, `ajv`,
  `path-to-regexp`, `qs`) is **entirely transitive under the SDK**:
  `@modelcontextprotocol/sdk → @hono/node-server → hono`. **Bumping the SDK fixes most
  of them.** `ws` is the one direct dep to bump on its own.
- Triage with `npm audit --omit=dev` — dev-only vulns (vitest/esbuild/tsx) don't ship.
  The question is *reachability in production*, not the raw count.
- Remediate on a branch: `npm install @modelcontextprotocol/sdk@latest ws@latest`, then
  `npm test && npm run build && npm audit --omit=dev`. Commit `package-lock.json`;
  CI/Docker use `npm ci`, not `npm install`. Widen version ranges only intentionally.

### MCP transport invariant (the SDK "cross-client data leak" advisory)

GHSA-345p-7cg4-v4c7 is about **sharing one `McpServer`/transport instance across
clients**. Our HTTP layer MUST create a **fresh server + transport per request**
(stateless mode, current behavior) or per session keyed by `Mcp-Session-Id` (stateful) —
never a single global transport handling every `/mcp` POST. Re-verify this after any SDK
upgrade or transport refactor. Bumping the SDK is necessary but not sufficient if the
architecture shares instances.

### Our attack surface (higher-leverage than CVEs)

1. **Auth stays on.** NAS `.env` must keep `MCP_AUTH_METHOD=bearer`. `none` =
   unauthenticated full admin (fail-open default). Never put the JWT on public channels;
   tokens should carry an `exp` (the current prod token does not — fix when convenient).
2. **Authorization is per-tool.** Every MCP tool is gated via
   `wrapToolHandler(..., Permission.X)`. The REST `/api/*` bridge is **not** permission-
   gated — keep it disabled or treat it as full-trust until it enforces the same masks.
   Prompt injection via the AI path ("ignore previous instructions, unlock the door") is
   contained only by these authorization checks — the model is not a security boundary.
3. **Scoped TLS only.** Never use the process-global `NODE_TLS_REJECT_UNAUTHORIZED=0` —
   it disables cert validation for *all* concurrent outbound HTTPS (HA token + AI key at
   MITM risk), not just Omada. Use a per-client `undici` dispatcher, or pin the Omada
   self-signed cert as a CA so verification stays on.
4. **Encode every path segment** built from tool input. The Omada client does
   (`encodeURIComponent` throughout); the HA client interpolates raw — fix when touched.
5. **Secrets never in logs.** Redact tokens / secrets / `Authorization` headers / API
   keys, and **sanitize `error.message`/`error.stack` before logging** — HTTP libraries
   embed auth headers and token-bearing URLs inside thrown errors. Don't return raw
   `error.message` to clients (leaks internal hostnames).
6. **HTTP hardening when `useHttp`:** request body-size limit, rate limiting keyed on a
   trusted-proxy IP (Cloudflare `CF-Connecting-IP`, not the spoofable `X-Forwarded-For`),
   and static security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options`,
   `Referrer-Policy`, CSP where applicable).

### Confirmed safe — don't re-litigate

- **JWT:** HS256 is pinned (the token's `alg` header is ignored), signature compared with
  `crypto.timingSafeEqual` — not vulnerable to alg-confusion or timing attacks. (Still
  add `exp` enforcement, and `iss`/`aud` if it ever becomes multi-issuer.)
- **Omada client** encodes every path segment; query params via `URLSearchParams`.
- **No** `eval` / `new Function` / dynamic `require`; the only child process is
  `spawn('node', [fixedPath])` — no shell, no user-controlled argv.
- **No arbitrary-URL SSRF via tool args** — HA/Omada/AI base URLs come only from config.
- **Git hygiene clean** — `.env` is never tracked; no hardcoded real secrets in src/tests.

### Insecure defaults to flip when next touched

`config.ts` defaults `MCP_AUTH_METHOD=none`; `.env.example` ships `none` +
`HA_STRICT_SSL=false`; `docker-compose.yml` hardcodes `MCP_HTTP_ALLOWED_ORIGINS=*`.
None of these reflect the (secure) live deployment — make the secure values the defaults.
