# MCP-HA-Connect

A production-ready Model Context Protocol (MCP) server for Home Assistant integration with AI assistants like Claude and LM Studio.

[![npm version](https://badge.fury.io/js/%40coffeerunhobby%2Fmcp-ha-connect.svg)](https://www.npmjs.com/package/@coffeerunhobby/mcp-ha-connect)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/coffeerunhobby/mcp-ha-connect/pkgs/container/mcp-ha-connect)

## Quick Start

Choose your preferred installation method:

### Option 1: npx (Recommended - No Installation Required)

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "npx",
      "args": ["-y", "@coffeerunhobby/mcp-ha-connect"],
      "env": {
        "HA_URL": "http://homeassistant.10.0.0.19.nip.io:8123",
        "HA_TOKEN": "your_long_lived_access_token"
      }
    }
  }
}
```

### Option 2: Global npm Install

```bash
npm install -g @coffeerunhobby/mcp-ha-connect
```

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "mcp-ha-connect",
      "env": {
        "HA_URL": "http://homeassistant.10.0.0.19.nip.io:8123",
        "HA_TOKEN": "your_token"
      }
    }
  }
}
```

### Option 3: Docker

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e", "HA_URL=http://host.docker.internal:8123",
        "-e", "HA_TOKEN=your_token",
        "ghcr.io/coffeerunhobby/mcp-ha-connect:latest"
      ]
    }
  }
}
```

### Option 4: Local Development

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "node",
      "args": ["C:\\workspace\\mcp-homeassistant\\dist\\index.js"],
      "env": {
        "HA_URL": "http://homeassistant.10.0.0.19.nip.io:8123",
        "HA_TOKEN": "your_token"
      }
    }
  }
}
```

## Configuration Locations

### Claude Desktop
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

### LM Studio
- **Windows:** `%USERPROFILE%\.lmstudio\config.json`
- **macOS:** `~/Library/Application Support/LM Studio/config.json`
- **Linux:** `~/.config/lmstudio/config.json`

## Autonomous Safety Monitoring System

1. **JS Pre-filter**: Tier A triggers + basic anomaly detection
2. **Issue Objects**: Structured alerts (entity, area, threshold, observed, last_changed)
3. **LLM Decision**: Single JSON verdict from local model
4. **Smart Notifications**: Dedupe + cooldown to prevent alert fatigue
5. **Acknowledgment**: HA notification, Telegram, mobile app action, or voice
6. **Auto-Response**: Water/gas shutoff via HA valves/switches

See [docs/SSE_API.md](docs/SSE_API.md) for complete documentation of the SSE system.

## Key Features

### Core Functionality

- **Smart Device Control**
  - Lights: Brightness, color temperature, RGB color, transitions
  - Climate: Temperature, HVAC modes, fan modes, humidity
  - Covers: Position and tilt control
  - Switches: On/off control
  - Sensors & Contacts: State monitoring
  - Media Players: Playback control, volume, source selection
  - Fans: Speed, oscillation, direction
  - Locks: Lock/unlock control
  - Vacuums: Start, stop, return to base
  - Cameras: Motion detection, snapshots

### Automation Management

- List all automations with status
- Trigger automations manually with variables
- Enable/disable/toggle automations
- Create new automations via API
- Delete automations
- View automation execution traces
- Reload automations from configuration

### System Features

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

## Available Tools (37 Total)

### State & Entity Tools

| Tool | Description |
|------|-------------|
| `getStates` | Get all entity states from Home Assistant |
| `getState` | Get the state of a specific entity by entity_id |
| `getEntitiesByDomain` | Get all entities for a specific domain |
| `searchEntities` | Search for entities by name or entity_id |
| `getAllSensors` | Get all sensor and binary_sensor entities |
| `listEntities` | List entities with filtering (domain, state, search, limit) |
| `getDomainSummary` | Get summary statistics for a domain |
| `getHistory` | Get historical data for an entity |
| `listPersons` | List all household members with location state (home/away) |

### Service & Control Tools

| Tool | Description |
|------|-------------|
| `callService` | Call any Home Assistant service |
| `entityAction` | Simple turn_on/turn_off/toggle actions |

### Device Control Tools

| Tool | Description |
|------|-------------|
| `controlLight` | Control lights with brightness, color, temperature |
| `controlClimate` | Control thermostats with temperature, HVAC mode |
| `controlMediaPlayer` | Control media players with playback, volume |
| `controlCover` | Control covers/blinds with position, tilt |
| `controlFan` | Control fans with speed, oscillation, direction |
| `activateScene` | Activate a Home Assistant scene |
| `runScript` | Run a Home Assistant script |
| `sendNotification` | Send notifications with full mobile app support (actions, priority, images) |
| `listNotificationTargets` | Discover available mobile app notification targets |

### Automation Tools

| Tool | Description |
|------|-------------|
| `listAutomations` | List all automations with status |
| `triggerAutomation` | Manually trigger an automation |
| `enableAutomation` | Enable a disabled automation |
| `disableAutomation` | Disable an automation |
| `toggleAutomation` | Toggle automation state |
| `reloadAutomations` | Reload automations from config |
| `createAutomation` | Create a new automation |
| `deleteAutomation` | Delete an automation |
| `getAutomationTrace` | Get automation execution history |

### System Tools

| Tool | Description |
|------|-------------|
| `getVersion` | Get Home Assistant version and config info |
| `restartHomeAssistant` | Restart the Home Assistant server |
| `getSystemLog` | Get system log entries from logbook |
| `checkUpdates` | Check for available updates |
| `analyzeSensors` | AI-powered sensor analysis using Ollama |

### Calendar Tools

| Tool | Description |
|------|-------------|
| `listCalendars` | List all calendar entities |
| `getCalendarEvents` | Get events from one or all calendars |

### MCP Resources

| Resource URI | Description |
|--------------|-------------|
| `hass://entities` | List all entities grouped by domain |
| `hass://entities/{entity_id}` | Get state of a specific entity |
| `hass://entities/{entity_id}/detailed` | Get detailed entity info with all attributes |
| `hass://entities/domain/{domain}` | Get all entities for a domain |
| `hass://search/{query}/{limit}` | Search entities with result limit |

## Prerequisites

- **Node.js 20+** (tested with v20.19.6) - for npm/npx methods
- **npm 10.8+** (tested with v10.8.2) - for npm/npx methods
- **Docker** (optional) - for Docker method
- Home Assistant instance with long-lived access token
- Network access to your Home Assistant instance
- (Optional) Ollama for AI-powered analysis

## Getting Your Home Assistant Token

1. Log into your Home Assistant instance
2. Click on your profile (bottom left)
3. Scroll down to "Long-Lived Access Tokens"
4. Click "Create Token"
5. Give it a name (e.g., "MCP Server")
6. Copy the token (shown only once!)

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `HA_URL` | Home Assistant URL | `http://homeassistant.10.0.0.19.nip.io:8123` |
| `HA_TOKEN` | Long-lived access token | `eyJhbGciOiJIUzI1NiIsInR5cCI...` |

### Optional - Home Assistant

| Variable | Default | Description |
|----------|---------|-------------|
| `HA_STRICT_SSL` | `true` | Validate SSL certificates |
| `HA_TIMEOUT` | `30000` | API request timeout (ms) |

### Optional - MCP Server

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SERVER_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `MCP_SERVER_LOG_FORMAT` | `plain` | Log format: `plain`, `json`, `gcp-json` |
| `MCP_SERVER_USE_HTTP` | `false` | Enable HTTP mode (vs stdio) |
| `MCP_SERVER_STATEFUL` | `false` | Enable stateful sessions in HTTP mode |

### Optional - HTTP Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_HTTP_PORT` | `3000` | HTTP server port |
| `MCP_HTTP_TRANSPORT` | `stream` | Transport: `stream` or `sse` |
| `MCP_HTTP_BIND_ADDR` | `127.0.0.1` | Bind address |
| `MCP_HTTP_PATH` | `/mcp` | MCP endpoint path |
| `MCP_HTTP_ENABLE_HEALTHCHECK` | `true` | Enable health check endpoint |
| `MCP_HTTP_HEALTHCHECK_PATH` | `/health` | Health check path |
| `MCP_HTTP_ALLOW_CORS` | `true` | Enable CORS |
| `MCP_HTTP_ALLOWED_ORIGINS` | `127.0.0.1,localhost` | Allowed CORS origins |

### Optional - SSE Events

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SSE_EVENTS_ENABLED` | `false` | Enable real-time SSE events |
| `MCP_SSE_EVENTS_PATH` | `/subscribe_events` | SSE endpoint path |

### Optional - Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_RATE_LIMIT_ENABLED` | `false` | Enable rate limiting |
| `MCP_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `MCP_RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |

### Optional - AI Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `ollama` | AI provider: `ollama`, `openai`, or `none` |
| `AI_URL` | `http://ollama.10.0.0.17.nip.io:11434` | AI server URL (Ollama) |
| `AI_MODEL` | `llama2` | AI model name |
| `AI_TIMEOUT` | `60000` | AI request timeout (ms) |

## Advanced Configuration Examples

### With AI Analysis (Ollama)

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "npx",
      "args": ["-y", "@coffeerunhobby/mcp-ha-connect"],
      "env": {
        "HA_URL": "http://homeassistant.10.0.0.19.nip.io:8123",
        "HA_TOKEN": "your_token",
        "AI_PROVIDER": "ollama",
        "AI_URL": "http://ollama.10.0.0.17.nip.io:11434",
        "AI_MODEL": "llama2"
      }
    }
  }
}
```

### Disable AI Features

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "npx",
      "args": ["-y", "@coffeerunhobby/mcp-ha-connect"],
      "env": {
        "HA_URL": "http://homeassistant.10.0.0.19.nip.io:8123",
        "HA_TOKEN": "your_token",
        "AI_PROVIDER": "none"
      }
    }
  }
}
```

### Docker with Network Configuration

For Linux, you may need to add `host.docker.internal`:

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--add-host=host.docker.internal:host-gateway",
        "-e", "HA_URL=http://host.docker.internal:8123",
        "-e", "HA_TOKEN=your_token",
        "ghcr.io/coffeerunhobby/mcp-ha-connect:latest"
      ]
    }
  }
}
```

## Usage Modes

### Mode 1: MCP Client (Claude Desktop / LM Studio)

Default stdio mode for MCP clients. See [Quick Start](#quick-start) section for configuration.

For detailed configuration options, see [docs/LOCAL_CLIENT.md](docs/LOCAL_CLIENT.md).

### Mode 2: HTTP Server

Start as standalone HTTP server for web applications:

```bash
# Using npx
npx @coffeerunhobby/mcp-ha-connect

# Or with environment variables
MCP_SERVER_USE_HTTP=true \
MCP_HTTP_PORT=3000 \
HA_URL=http://homeassistant.10.0.0.19.nip.io:8123 \
HA_TOKEN=your_token \
npx @coffeerunhobby/mcp-ha-connect
```

#### Streamable HTTP Transport

Configure your MCP client to use:
- **URL:** `http://localhost:3000/mcp`
- **Transport:** Streamable HTTP (MCP 2025-03-26)

#### SSE Event Subscription

Subscribe to real-time events:

```javascript
const eventSource = new EventSource(
  'http://localhost:3000/subscribe_events?domain=light&entity_id=light.living_room'
);

eventSource.addEventListener('state_changed', (event) => {
  const data = JSON.parse(event.data);
  console.log('Entity changed:', data.entity_id, data.new_state);
});
```

See [docs/SSE_API.md](docs/SSE_API.md) for complete SSE documentation.

### Mode 3: Docker Standalone

```bash
# Pull image
docker pull ghcr.io/coffeerunhobby/mcp-ha-connect:latest

# Run in HTTP mode
docker run -d --name mcp-ha-connect \
  -e HA_URL=http://homeassistant.10.0.0.19.nip.io:8123 \
  -e HA_TOKEN=your_token \
  -e MCP_SERVER_USE_HTTP=true \
  -p 3000:3000 \
  ghcr.io/coffeerunhobby/mcp-ha-connect:latest
```

### Mode 4: Docker Compose

```yaml
version: '3.8'

services:
  mcp-ha-connect:
    image: ghcr.io/coffeerunhobby/mcp-ha-connect:latest
    container_name: mcp-ha-connect
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - HA_URL=http://homeassistant.10.0.0.19.nip.io:8123
      - HA_TOKEN=${HA_TOKEN}
      - MCP_SERVER_USE_HTTP=true
      - MCP_HTTP_BIND_ADDR=0.0.0.0
    networks:
      - home-automation

networks:
  home-automation:
    driver: bridge
```

## Integration Examples

### With Claude Desktop

Once configured, you can ask Claude:

- "Show me all lights in my house"
- "Turn on the kitchen lights to 50% brightness"
- "Set the living room temperature to 72 degrees"
- "Create an automation that turns off all lights at midnight"
- "What automations are currently enabled?"
- "Trigger the morning routine automation"
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

### With Web Applications

Use the HTTP transport with your MCP-compatible web client:

1. Start server in HTTP mode
2. Configure client to use `http://localhost:3000/mcp`
3. Set transport to Streamable HTTP (MCP 2025-03-26)
4. Enable CORS by adding your origin to `MCP_HTTP_ALLOWED_ORIGINS`

### With Remote MCP Proxy (uvx)

Connect to a remote MCP server using mcp-remote:

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "uvx",
      "args": [
        "mcp-remote",
        "http://your-server:3000/mcp"
      ]
    }
  }
}
```

## Network Configuration Notes

- **`host.docker.internal`** - Use this to access services on your host machine from Docker
  - Works on Windows and macOS by default
  - On Linux, add `--add-host=host.docker.internal:host-gateway` to docker args
- **Direct IP** - Use your machine's IP address (e.g., `http://10.0.0.19:8123`)
- **nip.io domains** - Use wildcard DNS for easy local development (e.g., `http://homeassistant.10.0.0.19.nip.io:8123`)

## Security Best Practices

### Network Security

- **Network Segmentation**: Run MCP server on private LAN only
- **Docker Networks**: Use Docker networks for container isolation
- **VLAN**: Consider VLAN for IoT devices
- **No Internet Exposure**: Never expose MCP server directly to internet

### Token & Configuration Security

- Store `.env` securely (contains access token)
- **Never** commit `.env` to version control
- Set `.env` permissions: `chmod 600 .env`
- Use `HA_STRICT_SSL=true` for HTTPS in production
- Rotate access tokens periodically
- Restrict `MCP_HTTP_ALLOWED_ORIGINS` (avoid wildcard `*`)
- Bind to `127.0.0.1` for local-only access
- Enable rate limiting in production (`MCP_RATE_LIMIT_ENABLED=true`)

### MCP Client Configuration Security

⚠️ **Important:** Storing tokens directly in MCP client config files (Claude Desktop, LM Studio) exposes them to anyone with filesystem access. Consider:

- Using `.env` files with restricted permissions for Docker/local deployments
- Setting file permissions on config files (e.g., `chmod 600`)
- Using environment variable substitution if supported by your client
- Never committing config files with real tokens to version control

## Troubleshooting

### Claude Desktop / LM Studio Not Connecting

1. **Check config file location** - Verify you're editing the correct file
2. **Restart the application** - Close and reopen after config changes
3. **Check logs** - Look for error messages in the application logs
4. **Test connection manually**:

```bash
# Test npx
npx @coffeerunhobby/mcp-ha-connect

# Test Docker
docker run --rm -i \
  -e HA_URL=http://homeassistant.10.0.0.19.nip.io:8123 \
  -e HA_TOKEN=your_token \
  ghcr.io/coffeerunhobby/mcp-ha-connect:latest
```

### Docker `host.docker.internal` Not Working (Linux)

Add host gateway:

```json
{
  "args": [
    "run",
    "--rm",
    "-i",
    "--add-host=host.docker.internal:host-gateway",
    "-e", "HA_URL=http://host.docker.internal:8123",
    ...
  ]
}
```

### Home Assistant Connection Issues

1. **Verify URL** - Try accessing `http://your-ha-url:8123/api/` in browser
2. **Check token** - Ensure it's a valid long-lived access token
3. **Network access** - Verify MCP server can reach Home Assistant
4. **SSL issues** - Try `HA_STRICT_SSL=false` for testing

### AI Analysis Not Working

1. **Verify Ollama is running** - `curl http://your-ollama-url:11434/api/tags`
2. **Check model is available** - Ensure model is pulled: `ollama pull llama2`
3. **Set AI_PROVIDER** - Must be set to `ollama` (not `none`)

## Development

### Setup

```bash
# Clone repository
git clone https://github.com/coffeerunhobby/mcp-ha-connect.git
cd mcp-ha-connect

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your Home Assistant details
nano .env

# Build
npm run build

# Run
npm start
```

### Available Scripts

```bash
npm run build      # Build TypeScript to dist/
npm run dev        # Run in development mode with watch
npm start          # Run built version
npm test           # Run tests
npm run lint       # Run ESLint
npm run format     # Format code with Prettier
```

## License

MIT

## Author

Coffee Run Hobby ([github.com/coffeerunhobby](https://github.com/coffeerunhobby))

## Version

0.7.0

## Links

- **GitHub**: [https://github.com/coffeerunhobby/mcp-ha-connect](https://github.com/coffeerunhobby/mcp-ha-connect)
- **npm**: [https://www.npmjs.com/package/@coffeerunhobby/mcp-ha-connect](https://www.npmjs.com/package/@coffeerunhobby/mcp-ha-connect)
- **Docker**: [https://github.com/coffeerunhobby/mcp-ha-connect/pkgs/container/mcp-ha-connect](https://github.com/coffeerunhobby/mcp-ha-connect/pkgs/container/mcp-ha-connect)

## Documentation

- [Changelog](docs/CHANGELOG.md)
- [Local Client Configuration](docs/LOCAL_CLIENT.md)
- [SSE Event API](docs/SSE_API.md)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
