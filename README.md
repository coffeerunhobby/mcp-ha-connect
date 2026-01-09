# MCP-HA-Connect

A production-ready Model Context Protocol (MCP) server for Home Assistant integration with AI assistants like Claude.

## Features

- Direct Home Assistant API integration
- Long-lived access token authentication
- Entity state management
- Service call support
- Advanced entity search
- AI-powered sensor analysis with Ollama
- Multiple transport modes (stdio, SSE, Streamable HTTP)
- HTTP server with health checks
- CORS support for browser-based clients
- Structured logging with pino (plain, JSON, GCP-JSON formats)
- Comprehensive configuration validation with Zod
- Full type safety with TypeScript
- Stateful and stateless session support

## Available Tools

### MCP Tools

| Tool | Description |
|------|-------------|
| `getStates` | Get all entity states from Home Assistant |
| `getState` | Get the state of a specific entity by entity_id |
| `callService` | Call any Home Assistant service (turn on lights, etc) |
| `getEntitiesByDomain` | Get all entities for a specific domain (lights, sensors, etc) |
| `searchEntities` | Search for entities by name or entity_id |
| `getAllSensors` | Get all sensor and binary_sensor entities |
| `analyzeSensors` | AI-powered sensor analysis using Ollama |
| `getHistory` | Get historical data for an entity |
| `getVersion` | Get Home Assistant version and configuration info |
| `entityAction` | Simple turn_on/turn_off/toggle actions (auto-detects domain) |
| `listEntities` | List entities with filtering (domain, state, search, limit) |
| `getDomainSummary` | Get summary statistics for a domain |
| `listAutomations` | List all automations with status and last triggered time |
| `restartHomeAssistant` | Restart the Home Assistant server |
| `getSystemLog` | Get system log entries from the Home Assistant logbook |
| `checkUpdates` | Check for available updates for Home Assistant Core, Supervisor, and OS |

### MCP Resources

| Resource URI | Description |
|--------------|-------------|
| `hass://entities` | List all entities grouped by domain |
| `hass://entities/{entity_id}` | Get state of a specific entity |
| `hass://entities/{entity_id}/detailed` | Get detailed entity info with all attributes |
| `hass://entities/domain/{domain}` | Get all entities for a domain |
| `hass://search/{query}/{limit}` | Search entities with result limit |

## AI-Powered Sensor Analysis (Optional)

The `analyzeSensors` tool uses a local AI model to analyze sensor data. This feature is optional and requires a running AI provider.

### Tested Models

- phi4:14b
- qwen3:14b
- ministral-3:14b
- codellama:13b-instruct
- qwen3:8b
- mistral:7b

### Configuration

```bash
AI_PROVIDER=ollama              # ollama or openai (for OpenAI-compatible APIs)
AI_URL=http://localhost:11434   # Provider URL
AI_MODEL=phi4:14b               # Model name
AI_TIMEOUT=60000                # Timeout in ms
AI_API_KEY=                     # Optional API key
```

## Transport Modes

This server supports three MCP transport modes:

### 1. Stdio Transport (Default)
- **Use Case:** Claude Desktop integration
- **Protocol:** Standard input/output
- **Best For:** Desktop AI assistants

### 2. SSE (Server-Sent Events)
- **Use Case:** Legacy MCP protocol (2024-11-05)
- **Protocol:** HTTP with Server-Sent Events
- **Best For:** Browser-based MCP clients

### 3. Streamable HTTP
- **Use Case:** Modern MCP protocol (2025-03-26)
- **Protocol:** HTTP with streaming responses
- **Best For:** Web applications and modern MCP clients
- **Features:** Health checks, CORS, session management

## Prerequisites

- **Node.js 20+** (tested with v20.19.6)
- **npm 10.8+** (tested with v10.8.2)
- Home Assistant instance with long-lived access token
- Network access to your Home Assistant instance
- (Optional) Ollama for AI-powered analysis
- (Optional) Docker for containerized deployment



## Configuration

### Getting Long-Lived Access Token

1. Log into your Home Assistant
2. Click on your profile (bottom left)
3. Scroll down to "Long-Lived Access Tokens"
4. Click "Create Token"
5. Give it a name (e.g., "MCP Server")
6. Copy the token (shown only once!)

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Home Assistant Connection
HA_URL=http://127.0.0.1:8123
HA_TOKEN=your_long_lived_access_token_here
HA_STRICT_SSL=false
HA_TIMEOUT=30000

# MCP Server Configuration
MCP_SERVER_LOG_LEVEL=info                # debug, info, warn, error
MCP_SERVER_LOG_FORMAT=plain              # plain, json, gcp-json
MCP_SERVER_USE_HTTP=false                # true for HTTP mode, false for stdio
MCP_SERVER_STATEFUL=false                # Enable stateful sessions in HTTP mode

# HTTP Configuration (when MCP_SERVER_USE_HTTP=true)
MCP_HTTP_PORT=3000
MCP_HTTP_TRANSPORT=stream                # stream or sse
MCP_HTTP_BIND_ADDR=127.0.0.1
MCP_HTTP_PATH=/mcp                       # /mcp for stream, /sse for SSE
MCP_HTTP_ENABLE_HEALTHCHECK=true
MCP_HTTP_HEALTHCHECK_PATH=/health
MCP_HTTP_ALLOW_CORS=true
MCP_HTTP_ALLOWED_ORIGINS=127.0.0.1,localhost  # Comma-separated list or * for all

# AI Configuration (optional)
AI_PROVIDER=ollama
AI_URL=http://localhost:11434
AI_MODEL=phi4:14b
AI_TIMEOUT=60000
```

## Usage

### Mode 1: Claude Desktop (Stdio Transport)

Add to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "node",
      "args": [
        "--env-file=.env",
        "C:\\path\\to\\mcp-ha-connect\\dist\\index.js"
      ]
    }
  }
}
```

Or specify environment variables directly:

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "node",
      "args": [
        "C:\\path\\to\\mcp-ha-connect\\dist\\index.js"
      ],
      "env": {
        "HA_URL": "http://127.0.0.1:8123",
        "HA_TOKEN": "your_long_lived_access_token",
        "HA_STRICT_SSL": "false",
        "MCP_SERVER_LOG_LEVEL": "info",
        "AI_URL": "http://localhost:11434",
        "AI_MODEL": "phi4:14b"
      }
    }
  }
}
```

### Mode 1B: Claude Desktop with Docker (Stdio Transport)

If you prefer to run the MCP server in Docker and connect Claude Desktop to it via stdio, you can use `docker exec`.

**Prerequisites:**
- Docker container running with MCP server
- Container must be running in stdio mode (not HTTP)

**Step 1: Start Docker Container**

```bash
# Build image
docker build -t mcp-ha-connect .

# Run container in stdio mode (detached, but ready for exec)
docker run -d --name mcp-ha-connect \
  -e HA_URL=http://127.0.0.1:8123 \
  -e HA_TOKEN=your_token \
  -e AI_URL=http://127.0.0.1:11434 \
  -e AI_MODEL=phi4:14b \
  -e MCP_SERVER_USE_HTTP=false \
  mcp-ha-connect \
  tail -f /dev/null
```

**Note:** The `tail -f /dev/null` keeps the container running. The MCP server will be executed via `docker exec` by Claude Desktop.

**Step 2: Configure Claude Desktop**

Add to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "docker",
      "args": [
        "exec",
        "-i",
        "mcp-ha-connect",
        "node",
        "dist/index.js"
      ],
      "env": {
        "HA_URL": "http://127.0.0.1:8123",
        "HA_TOKEN": "your_long_lived_access_token",
        "AI_URL": "http://127.0.0.1:11434",
        "AI_MODEL": "phi4:14b",
        "MCP_SERVER_LOG_LEVEL": "info"
      }
    }
  }
}
```

**Important Notes:**
- The `-i` flag (interactive) is required for stdio communication
- Environment variables are passed through the `env` object
- The Docker container must already be running
- The container name is `mcp-ha-connect` (change if different)

**Step 3: Restart Claude Desktop**

Close and reopen Claude Desktop for the configuration to take effect.

**Verification:**

```bash
# Check if container is running
docker ps | grep mcp-ha-connect

# Test stdio communication
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | docker exec -i mcp-ha-connect node dist/index.js
```

**Troubleshooting:**

If Claude Desktop can't connect:

```bash
# Check container logs
docker logs mcp-ha-connect

# Test docker exec manually
docker exec -i mcp-ha-connect node dist/index.js

# Ensure container has access to Home Assistant
docker exec mcp-ha-connect curl http://127.0.0.1:8123/api/

# Verify environment variables are set
docker exec mcp-ha-connect env | grep HA_
```

### Mode 1C: Claude Desktop with Docker Compose

For a more robust Docker setup, use Docker Compose:

**Step 1: Create docker-compose.yml**

```yaml
version: '3.8'

services:
  mcp-ha-connect:
    build: .
    container_name: mcp-ha-connect
    restart: unless-stopped
    environment:
      - HA_URL=http://127.0.0.1:8123
      - HA_TOKEN=${HA_TOKEN}  # Load from .env file
      - AI_URL=http://127.0.0.1:11434
      - AI_MODEL=phi4:14b
      - MCP_SERVER_USE_HTTP=false
      - MCP_SERVER_LOG_LEVEL=info
    command: tail -f /dev/null
    networks:
      - home-automation

networks:
  home-automation:
    driver: bridge
```

**Step 2: Create .env file**

```bash
HA_TOKEN=your_long_lived_access_token_here
```

**Step 3: Start with Docker Compose**

```bash
# Start container
docker-compose up -d

# Check status
docker-compose ps
```

**Step 4: Configure Claude Desktop**

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "docker",
      "args": [
        "exec",
        "-i",
        "mcp-ha-connect",
        "node",
        "dist/index.js"
      ]
    }
  }
}
```

**Note:** Environment variables are already set in the container via Docker Compose, so you don't need to specify them again in Claude Desktop config.

**Advantages of Docker Compose:**
- Easy multi-container management
- Automatic restart on failure
- Environment variable management via .env
- Network isolation
- Easy updates: `docker-compose pull && docker-compose up -d
```


#### Streamable HTTP Transport (Recommended)

Configure your MCP client to use:
- **URL:** `http://127.0.0.1:3000/mcp`
- **Transport:** Streamable HTTP (MCP 2025-03-26)
- **Session:** Send `Mcp-Session-Id` header for stateful mode

#### SSE Transport (Legacy)

Set `MCP_HTTP_TRANSPORT=sse` in your `.env` file:

```bash
MCP_HTTP_TRANSPORT=sse
MCP_HTTP_PATH=/sse
```

Configure your MCP client to use:
- **Connection URL:** `http://127.0.0.1:3000/sse` (GET)
- **Message URL:** `http://127.0.0.1:3000/message` (POST)
- **Session Header:** `Mcp-Session-Id` (provided in connection response)


## Running the Server

### Stdio Mode (Default)

```bash
npm start
```

Logs to stderr to avoid interfering with MCP protocol on stdout.

### HTTP Mode

```bash
npm run start:http
```

Or set `MCP_SERVER_USE_HTTP=true` in `.env` and run `npm start`.

### Production Deployment

#### Docker (Recommended)

```bash
# Build image
docker build -t mcp-ha-connect .

# Run container
docker run -d --name mcp-ha-connect \
  -e HA_URL=http://127.0.0.1:8123 \
  -e HA_TOKEN=your_token \
  -e AI_URL=http://127.0.0.1:11434 \
  -e AI_MODEL=phi4:14b \
  -e MCP_SERVER_USE_HTTP=true \
  -p 3000:3000 \
  mcp-ha-connect
```

#### Systemd Service

```bash
# Copy to system location
sudo cp mcp-ha-connect.service /etc/systemd/system/

# Enable and start
sudo systemctl enable mcp-ha-connect
sudo systemctl start mcp-ha-connect

# Check status
sudo systemctl status mcp-ha-connect
```

## Development

### Running Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

### Type Checking

```bash
npm run type-check
```

### Linting

```bash
npm run lint
```

### Building

```bash
npm run build
```

## Logging

The server uses pino for structured logging with three output formats:

### Plain Format (Default)
```bash
MCP_SERVER_LOG_FORMAT=plain
```
Human-readable logs with uppercase level names.

### JSON Format
```bash
MCP_SERVER_LOG_FORMAT=json
```
Standard JSON logs for log aggregation systems.

### GCP JSON Format
```bash
MCP_SERVER_LOG_FORMAT=gcp-json
```
Google Cloud Platform compatible logs with `severity` field.

### Log Levels
```bash
MCP_SERVER_LOG_LEVEL=debug  # Verbose debugging
MCP_SERVER_LOG_LEVEL=info   # General information (default)
MCP_SERVER_LOG_LEVEL=warn   # Warnings
MCP_SERVER_LOG_LEVEL=error  # Errors only
```

## Integration Examples

### With Claude Desktop

Once configured, you can ask Claude:

- "Show me all lights in my house"
- "What's the current temperature of sensor.living_room_temperature?"
- "Turn on the kitchen lights"
- "Search for entities with 'bedroom' in their name"
- "Get all climate entities"
- "Analyze my sensors for any issues" (requires Ollama)
- "Check the history of my thermostat"

### With n8n Workflows

The server can be integrated with n8n for automated home monitoring. Pre-built workflows are available in the `n8n/` directory:

1. **ai-agent-safety-monitor** - Critical safety monitoring every 5 minutes

#### Importing Workflows

**Method 1: n8n UI**
1. Open n8n: `http://127.0.0.1:5678`
2. Click **Workflows** → **Import from File**
3. Select JSON file from `n8n-files/`
4. Activate the workflow

**Method 2: Docker CLI**
```bash
# Copy workflow to n8n container
docker cp "n8n-files/AI Agent Safety Monitor - Updated.json" n8n:/files/workflow.json

# Import using n8n CLI
docker exec -it n8n n8n import:workflow --input=/files/workflow.json

# Verify import
docker exec -it n8n n8n list:workflow
```

For detailed n8n integration, see the [n8n Workflows Reference](docs/n8n-workflows-reference.md).

### With Web Applications

Use the HTTP transport with your MCP-compatible web client:

1. Configure client to use `http://127.0.0.1:3000/mcp`
2. Set transport to Streamable HTTP (MCP 2025-03-26)
3. Enable CORS by adding your origin to `MCP_HTTP_ALLOWED_ORIGINS`

### With Stateful Sessions

Enable session persistence:

```bash
MCP_SERVER_STATEFUL=true
```

Your MCP client should:
1. Include `Mcp-Session-Id` header in requests
2. Reuse the same session ID for related requests
3. Session state is maintained server-side

## Security

### Network Security

**Network Segmentation:**
- Run MCP server on private LAN only (192.168.0.0/24)
- Use Docker networks for container isolation
- Consider VLAN for IoT devices
- Never expose MCP server directly to internet

**Best Practices:**
- Store `.env` securely (contains access token)
- Never commit `.env` to version control
- Set `.env` permissions: `chmod 600 .env`
- Use `HA_STRICT_SSL=true` for HTTPS in production
- Rotate access tokens periodically
- Restrict `MCP_HTTP_ALLOWED_ORIGINS` (avoid wildcard)
- Bind to `127.0.0.1` for local-only access
- Use proper network security when exposing HTTP mode

**AI Provider Issues:**
- Ensure provider is running (e.g., `ollama serve`)
- Check model is available (e.g., `ollama list`)
- Increase timeout for slow responses: `AI_TIMEOUT=120000`

**Environment Variable Issues:**
Ensure you're using Node.js --env-file flag or loading .env manually:

```bash
node --env-file=.env dist/index.js
```

**Port Already in Use:**
Change `MCP_HTTP_PORT` if port 3000 is already in use:

```bash
MCP_HTTP_PORT=3001
```

**CORS Errors:**
Add your client's origin to allowed origins:

```bash
MCP_HTTP_ALLOWED_ORIGINS=http://localhost:3000,http://your-app.com
```


## License

MIT

## Author

Coffee Run Hobby (github.com/coffeerunhobby)

## Version

0.4.0

## Changelog

### 0.4.0 (January 2026)
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

### 0.3.0 (January 2026)
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

### 0.2.0 (January 2026)
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

### 0.1.0 (Initial Release)
- Basic Home Assistant integration
- 5 core tools (getStates, getState, callService, getEntitiesByDomain, searchEntities)
- Multiple transport modes (stdio, SSE, HTTP streaming)
- Full TypeScript support
