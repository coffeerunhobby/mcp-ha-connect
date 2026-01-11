# MCP-HA-Connect

A production-ready Model Context Protocol (MCP) server for Home Assistant integration with AI assistants like Claude.

## Autonomous safety monitoring system:

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

## Available Tools (34 Total)

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

### MCP Resources

| Resource URI | Description |
|--------------|-------------|
| `hass://entities` | List all entities grouped by domain |
| `hass://entities/{entity_id}` | Get state of a specific entity |
| `hass://entities/{entity_id}/detailed` | Get detailed entity info with all attributes |
| `hass://entities/domain/{domain}` | Get all entities for a domain |
| `hass://search/{query}/{limit}` | Search entities with result limit |

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
HA_URL=http://homeassistant.10.0.0.19.nip.io:8123
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
MCP_HTTP_ALLOWED_ORIGINS=127.0.0.1,localhost

# SSE Event Subscription (real-time updates)
MCP_SSE_EVENTS_ENABLED=true              # Enable SSE event subscription
MCP_SSE_EVENTS_PATH=/subscribe_events    # SSE endpoint path

# Rate Limiting
MCP_RATE_LIMIT_ENABLED=true              # Enable rate limiting
MCP_RATE_LIMIT_WINDOW_MS=60000           # Time window in ms (default: 1 minute)
MCP_RATE_LIMIT_MAX_REQUESTS=100          # Max requests per window

# AI Configuration (optional)
AI_PROVIDER=ollama                       # ollama or openai
AI_URL=http://ollama.10.0.0.17.nip.io:11434
AI_MODEL=phi4:14b
AI_TIMEOUT=60000
```

## Usage

### Mode 1: Claude Desktop (Stdio Transport)

[`docs/LOCAL_CLIENT.md`](docs/LOCAL_CLIENT.md)

### Mode 2: HTTP Server

```bash
# Start HTTP server
MCP_SERVER_USE_HTTP=true npm start
```

#### Streamable HTTP Transport (Recommended)

Configure your MCP client to use:
- **URL:** `http://mcpserver.10.0.0.18.nip.io:3000/mcp`
- **Transport:** Streamable HTTP (MCP 2025-03-26)

#### SSE Event Subscription

Subscribe to real-time events:
- **URL:** `http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events`
- **Method:** GET
- **Query params:** `domain`, `entity_id`, `event_types`

### Mode 3: Docker

```bash
# Build image
docker build -t mcp-ha-connect .

# Run container
docker run -d --name mcp-ha-connect \
  -e HA_URL=http://homeassistant.10.0.0.19.nip.io:8123 \
  -e HA_TOKEN=your_token \
  -e MCP_SERVER_USE_HTTP=true \
  -p 3000:3000 \
  mcp-ha-connect
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

1. Configure client to use `http://mcpserver.10.0.0.18.nip.io:3000/mcp`
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

Connect to SSE for real-time updates

```javascript
const eventSource = new EventSource(
  'http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events?domain=light'
);

eventSource.addEventListener('state_changed', (event) => {
  const data = JSON.parse(event.data);
  updateUI(data.entity_id, data.new_state);
});
```

## Security

### Network Security

**Network Segmentation:**
- Run MCP server on private LAN only (192.168.0.0/24)
- Use Docker networks for container isolation
- Consider VLAN for IoT devices
- Never expose MCP server directly to internet

### Best Practices

- Store `.env` securely (contains access token)
- Never commit `.env` to version control
- Set `.env` permissions: `chmod 600 .env`
- Use `HA_STRICT_SSL=true` for HTTPS in production
- Rotate access tokens periodically
- Restrict `MCP_HTTP_ALLOWED_ORIGINS` (avoid wildcard)
- Bind to `127.0.0.1` for local-only access
- Enable rate limiting in production

## License

MIT

## Author

Coffee Run Hobby (github.com/coffeerunhobby)

## Version

0.6.0

## Changelog

[`docs/CHANGELOG.md`](docs/CHANGELOG.md)
