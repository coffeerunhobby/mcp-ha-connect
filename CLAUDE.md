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

```powershell
$token = [Environment]::GetEnvironmentVariable('NPM_MCP_HA_TOKEN', 'User')
Set-Content "C:\Users\User5\.npmrc" "//registry.npmjs.org/:_authToken=$token"
cd C:\workspace\mcp
npm publish --access public
# Do NOT run npm logout after this
```

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

## Never assume. Always verify.

- **Cloudflare 502**: check the container is running (`docker compose ps`) and
  `MCP_HTTP_BIND_ADDR=0.0.0.0` is set.
- **MCP client connects but tools fail**: check `MCP_HTTP_ALLOWED_ORIGINS` includes
  the Cloudflare domain in both bare and `https://` form.
- **npm publish returns 404 on PUT**: token likely has per-package scope instead of
  scope-level access, or "Bypass 2FA" is not ticked. Delete token and recreate.
- **Omada auth error -44106**: check `OMADA_OMADAC_ID` first, not just credentials —
  this error code covers both cases.
- **Before a release**: always run `npm test` and `npm run build` clean.
