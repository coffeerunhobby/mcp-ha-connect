# Local Client

## Mode: Standalone Node JS version

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
        "HA_URL": "http://homeassistant.10.0.0.19.nip.io:8123",
        "HA_TOKEN": "your_long_lived_access_token",
        "HA_STRICT_SSL": "false",
        "MCP_SERVER_LOG_LEVEL": "info",
        "AI_URL": "http://ollama.10.0.0.1.nip.io:11434",
        "AI_MODEL": "phi4:14b"
      }
    }
  }
}
```

### Mode: Docker container with .env

You need docker runtime installed locally

```json
{
  "mcpServers": {
    "mcp-ha-connect": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--env-file",
        "C:\\path\\to\\mcp-ha-connect\\.env",
        "ghcr.io/coffeerunhobby/mcp-ha-connect:latest"
      ]
    }
  }
}
```

### Mode: UVX proxy to a working mcp-ha-connect server

You can use mcp-remote via uvx to proxy to your remote MCP server.

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "uvx",
      "args": [
        "mcp-remote",
        "http://mcp-ha.10.0.0.1.nip.io:3000/mcp"
      ]
    }
  }
}
```

**nip.io Examples:**

[nip.io](https://nip.io) provides wildcard DNS for any IP address. Supported formats:

| Format | Example | Resolves To |
|--------|---------|-------------|
| Dot notation | `mcp.10.0.0.1.nip.io` | 10.0.0.1 |
| Dash notation | `mcp-10-0-0-1.nip.io` | 10.0.0.1 |
| Hex notation | `mcp-0a000001.nip.io` | 10.0.0.1 |
| With subdomain | `ha.mcp.10.0.0.1.nip.io` | 10.0.0.1 |

Replace `10.0.0.1` with your actual server IP address.

### Mode: Claude Desktop with Docker (Stdio Transport)

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
  -e HA_URL=http://homeassistant.10.0.0.19.nip.io:8123 \
  -e HA_TOKEN=your_token \
  -e AI_URL=http://ollama.10.0.0.17.nip.io:11434 \
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
        "HA_URL": "http://homeassistant.10.0.0.19.nip.io:8123",
        "HA_TOKEN": "your_long_lived_access_token",
        "AI_URL": "http://ollama.10.0.0.17.nip.io:11434",
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
docker exec mcp-ha-connect curl http://homeassistant.10.0.0.19.nip.io:8123/api/

# Verify environment variables are set
docker exec mcp-ha-connect env | grep HA_
```

### Mode: Claude Desktop with Docker Compose

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
      - HA_URL=http://homeassistant.10.0.0.19.nip.io:8123
      - HA_TOKEN=${HA_TOKEN}  # Load from .env file
      - AI_URL=http://ollama.10.0.0.17.nip.io:11434
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
- Easy updates: `docker-compose pull && docker-compose up -d`