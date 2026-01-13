# Quick Start Guide

Get MCP-HA-Connect running in minutes. Choose your preferred installation method.

## Prerequisites

- **Node.js 20+** - for npm/npx methods
- **Docker** (optional) - for Docker method
- Home Assistant instance with long-lived access token

## Getting Your Home Assistant Token

1. Log into your Home Assistant instance
2. Click on your profile (bottom left)
3. Scroll down to "Long-Lived Access Tokens"
4. Click "Create Token"
5. Give it a name (e.g., "MCP Server")
6. Copy the token (shown only once!)

## Installation Options

### Option 1: npx (Recommended - No Installation Required)

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "npx",
      "args": ["-y", "@coffeerunhobby/mcp-ha-connect"],
      "env": {
        "HA_URL": "http://homeassistant.local:8123",
        "HA_TOKEN": "your_ha_long_lived_access_token"
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
        "HA_URL": "http://homeassistant.local:8123",
        "HA_TOKEN": "your_ha_long_lived_access_token"
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
      "args": ["/path/to/mcp-homeassistant/dist/index.js"],
      "env": {
        "HA_URL": "http://homeassistant.local:8123",
        "HA_TOKEN": "your_ha_long_lived_access_token"
      }
    }
  }
}
```

### Option 5: Remote MCP Server (Claude Code on Windows)

Connect to a remote HTTP MCP server without Docker or npx. Uses a Node.js one-liner as a stdio-to-HTTP bridge:

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "node",
      "args": [
        "-e",
        "const http=require('http');const readline=require('readline');const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:false});rl.on('line',(line)=>{const url=new URL(process.env.MCP_URL);const options={method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':'Bearer '+process.env.MCP_AUTH_TOKEN,'Content-Length':Buffer.byteLength(line)}};const req=http.request(url,options,(res)=>{let buffer='';const processLine=(l)=>{l=l.trim();if(l.startsWith('data: ')){const data=l.substring(6).trim();if(data&&data!=='[DONE]'){try{const json=JSON.parse(data);console.log(JSON.stringify(json));}catch(e){}}}};res.on('data',(chunk)=>{buffer+=chunk.toString();let newlineIndex;while((newlineIndex=buffer.indexOf('\\n'))!==-1){const line=buffer.substring(0,newlineIndex);buffer=buffer.substring(newlineIndex+1);processLine(line);}});res.on('end',()=>{if(buffer.trim()){processLine(buffer);}});});req.on('error',(e)=>console.error(JSON.stringify({jsonrpc:'2.0',error:{code:-1,message:e.message}})));req.write(line);req.end();});"
      ],
      "env": {
        "MCP_URL": "http://mcpserver.10.0.0.18.nip.io:3000/mcp",
        "MCP_AUTH_TOKEN": "your_bearer_auth_token_not_ha"
      }
    }
  }
}
```

This bridges stdio to your remote MCP HTTP server - useful when you can't run Docker or npx locally.

## Configuration File Locations

### Claude Desktop
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

### LM Studio
- **Windows:** `%USERPROFILE%\.lmstudio\config.json`
- **macOS:** `~/Library/Application Support/LM Studio/config.json`
- **Linux:** `~/.config/lmstudio/config.json`

## HTTP Server Mode

Start as standalone HTTP server for web applications or n8n:

```bash
MCP_SERVER_USE_HTTP=true \
MCP_HTTP_PORT=3000 \
MCP_HTTP_BIND_ADDR=0.0.0.0 \
HA_URL=http://homeassistant.local:8123 \
HA_TOKEN=your_token \
npx @coffeerunhobby/mcp-ha-connect
```

### Docker Compose

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
      - HA_URL=http://homeassistant.local:8123
      - HA_TOKEN=${HA_TOKEN}
      - MCP_SERVER_USE_HTTP=true
      - MCP_HTTP_BIND_ADDR=0.0.0.0
```

### With Bearer Token Authentication

```yaml
environment:
  - MCP_AUTH_METHOD=bearer
  - MCP_AUTH_TOKEN=your_secret_token
```

Then connect with:
```
Authorization: Bearer your_secret_token
```

## n8n Integration

![n8n MCP Client](n8n_mcp_client.png)

1. Add **MCP Client** node in n8n
2. Configure connection:
   - **SSE URL:** `http://your-server:3000/mcp`
   - **Authentication:** Bearer Token (if enabled)
3. Call tools like `getVersion`, `listEntities`, `getSystemLog`

## Verify It's Working

### Test with curl

```bash
# Health check
curl http://localhost:3000/health

# Call getVersion (with auth)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer your_token" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"getVersion","arguments":{}}}'
```

### Test with Claude Desktop

Once configured, ask Claude:
- "Show me all lights in my house"
- "What's the temperature in the living room?"
- "Who's home right now?"

## Next Steps

- [Environment Variables](../README.md#environment-variables) - Full configuration reference
- [Available Tools](../README.md#available-tools-37-total) - All 37 tools documented
- [Changelog](CHANGELOG.md) - Version history
