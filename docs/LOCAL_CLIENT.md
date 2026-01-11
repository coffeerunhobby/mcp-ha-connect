# Local MCP Client Configuration

Complete guide for configuring MCP-HA-Connect with Claude Desktop, LM Studio, and other MCP clients.

## Configuration File Locations

### Claude Desktop
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

### LM Studio
- **Windows:** `%USERPROFILE%\.lmstudio\config.json`
- **macOS:** `~/Library/Application Support/LM Studio/config.json`
- **Linux:** `~/.config/lmstudio/config.json`

---

## Installation Options

### Option 1: npx (Recommended)

**Advantages:**
- No installation required
- Always uses latest version (or pin with `@version`)
- Cross-platform
- Simple configuration

**Basic Configuration:**

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

**With AI Analysis (Ollama):**

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

**Pin to Specific Version:**

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "npx",
      "args": ["-y", "@coffeerunhobby/mcp-ha-connect@0.7.0"],
      "env": {
        "HA_URL": "http://homeassistant.10.0.0.19.nip.io:8123",
        "HA_TOKEN": "your_token"
      }
    }
  }
}
```

---

### Option 2: Global npm Install

**Advantages:**
- Faster startup (no download)
- Works offline
- Version control

**Installation:**

```bash
npm install -g @coffeerunhobby/mcp-ha-connect
```

**Configuration:**

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

**Update to Latest:**

```bash
npm update -g @coffeerunhobby/mcp-ha-connect
```

---

### Option 3: Docker

**Advantages:**
- Isolated environment
- Consistent across systems
- No Node.js required

**Basic Configuration:**

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

**With .env File:**

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--env-file",
        "C:\\path\\to\\.env",
        "ghcr.io/coffeerunhobby/mcp-ha-connect:latest"
      ]
    }
  }
}
```

**Linux with host.docker.internal:**

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

**Pin to Specific Version:**

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
        "ghcr.io/coffeerunhobby/mcp-ha-connect:0.7.0"
      ]
    }
  }
}
```

---

### Option 4: Local Development

**Advantages:**
- For development
- Fastest for testing changes
- Direct access to source

**Prerequisites:**
- Clone repository
- Run `npm install` and `npm run build`

**Configuration:**

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

**With .env File (Node.js 20.6+):**

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "node",
      "args": [
        "--env-file=.env",
        "C:\\path\\to\\mcp-ha-connect\\dist\\index.js"
      ]
    }
  }
}
```

---

## Common Configuration Patterns

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

### Enable Debug Logging

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "npx",
      "args": ["-y", "@coffeerunhobby/mcp-ha-connect"],
      "env": {
        "HA_URL": "http://homeassistant.10.0.0.19.nip.io:8123",
        "HA_TOKEN": "your_token",
        "MCP_SERVER_LOG_LEVEL": "debug"
      }
    }
  }
}
```

### Custom Ollama Configuration

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
        "AI_MODEL": "phi4:14b",
        "AI_TIMEOUT": "120000"
      }
    }
  }
}
```

### HTTPS Home Assistant

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "npx",
      "args": ["-y", "@coffeerunhobby/mcp-ha-connect"],
      "env": {
        "HA_URL": "https://ha.yourdomain.com",
        "HA_TOKEN": "your_token",
        "HA_STRICT_SSL": "true"
      }
    }
  }
}
```

---

## Advanced Docker Configurations

### Docker Compose for Development

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  mcp-ha-connect:
    image: ghcr.io/coffeerunhobby/mcp-ha-connect:latest
    container_name: mcp-ha-connect-stdio
    restart: unless-stopped
    environment:
      - HA_URL=http://homeassistant.10.0.0.19.nip.io:8123
      - HA_TOKEN=${HA_TOKEN}
      - AI_PROVIDER=ollama
      - AI_URL=http://ollama.10.0.0.17.nip.io:11434
      - AI_MODEL=llama2
      - MCP_SERVER_LOG_LEVEL=info
    command: tail -f /dev/null
    networks:
      - home-automation

networks:
  home-automation:
    driver: bridge
```

Create `.env`:

```bash
HA_TOKEN=your_long_lived_access_token_here
```

Start container:

```bash
docker-compose up -d
```

Configure MCP client to use `docker exec`:

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "docker",
      "args": [
        "exec",
        "-i",
        "mcp-ha-connect-stdio",
        "node",
        "dist/index.js"
      ]
    }
  }
}
```

### Docker with Custom Network

```bash
# Create network
docker network create home-automation

# Run container
docker run -d --name mcp-ha-connect \
  --network home-automation \
  -e HA_URL=http://homeassistant:8123 \
  -e HA_TOKEN=your_token \
  ghcr.io/coffeerunhobby/mcp-ha-connect:latest \
  tail -f /dev/null
```

---

## Remote MCP Server

### Using uvx mcp-remote

Connect to a remote MCP-HA-Connect HTTP server:

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

---

## Environment Variables Reference

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
| `MCP_SERVER_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `MCP_SERVER_LOG_FORMAT` | `plain` | `plain`, `json`, `gcp-json` |

### Optional - AI Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `ollama` | `ollama`, `openai`, or `none` |
| `AI_URL` | `http://ollama.10.0.0.17.nip.io:11434` | AI server URL |
| `AI_MODEL` | `llama2` | AI model name |
| `AI_TIMEOUT` | `60000` | AI request timeout (ms) |

---

## Troubleshooting

### MCP Client Not Connecting

1. **Verify config location** - Check you're editing the correct file
2. **Restart client** - Close and reopen Claude Desktop / LM Studio
3. **Check JSON syntax** - Use a JSON validator
4. **Test manually**:

```bash
# Test npx
npx @coffeerunhobby/mcp-ha-connect

# Test Docker
docker run --rm -i \
  -e HA_URL=http://homeassistant.10.0.0.19.nip.io:8123 \
  -e HA_TOKEN=your_token \
  ghcr.io/coffeerunhobby/mcp-ha-connect:latest
```

### Home Assistant Connection Errors

1. **Test URL in browser** - Visit `http://your-ha-url:8123`
2. **Verify token** - Check it's a long-lived access token
3. **Check network** - Ensure MCP server can reach HA
4. **Try HTTP first** - Test with `http://` before `https://`
5. **Disable SSL validation** - Set `HA_STRICT_SSL=false` for testing

### Docker Issues

**`host.docker.internal` not working (Linux):**

Add `--add-host=host.docker.internal:host-gateway` to docker args.

**Permission denied:**

Ensure Docker is running and you have permissions:

```bash
# Check Docker is running
docker ps

# Test Docker connection
docker run hello-world
```

### AI Analysis Not Working

1. **Verify Ollama is running**:
   ```bash
   curl http://your-ollama-url:11434/api/tags
   ```

2. **Check model is pulled**:
   ```bash
   ollama list
   # If not present:
   ollama pull llama2
   ```

3. **Set correct provider**:
   ```json
   "AI_PROVIDER": "ollama"
   ```

### LM Studio Specific Issues

1. **Config file not found** - Check all possible locations
2. **MCP not enabled** - Verify LM Studio version supports MCP
3. **Integrations tab** - Some versions have MCP config in UI

---

## Security Best Practices

⚠️ **Important:** Config files contain sensitive tokens!

1. **File permissions**:
   ```bash
   # macOS/Linux
   chmod 600 ~/.config/Claude/claude_desktop_config.json
   
   # Windows (PowerShell)
   icacls "%APPDATA%\Claude\claude_desktop_config.json" /inheritance:r /grant:r "%USERNAME%:F"
   ```

2. **Never commit** config files with real tokens to version control

3. **Use .env files** for Docker deployments when possible

4. **Rotate tokens** periodically in Home Assistant

5. **Network isolation** - Keep MCP server on private network

---

## Getting Help

- **GitHub Issues**: [https://github.com/coffeerunhobby/mcp-ha-connect/issues](https://github.com/coffeerunhobby/mcp-ha-connect/issues)
- **Documentation**: See main [README.md](../README.md)
- **SSE Events**: See [SSE_API.md](SSE_API.md)
- **Changelog**: See [CHANGELOG.md](CHANGELOG.md)
