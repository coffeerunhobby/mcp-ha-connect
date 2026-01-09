#!/usr/bin/env node
/**
 * HTTP Wrapper for Home Assistant MCP Server
 * Provides REST API endpoints that call MCP tools under the hood
 * Compatible with legacy mcp-wrapper.js behavior
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use relative path from wrapper location
const MCP_PATH = path.join(__dirname, 'index.js');
const PORT = parseInt(process.env.PORT || '3000', 10);

// ====== FAIL EARLY VALIDATION ======
function validateConfig(): string[] {
  const errors: string[] = [];

  if (!process.env.HA_URL) errors.push('ERROR: HA_URL environment variable not set');
  if (!process.env.HA_TOKEN) errors.push('ERROR: HA_TOKEN environment variable not set');

  if (process.env.HA_URL && !process.env.HA_URL.startsWith('http')) {
    errors.push('ERROR: HA_URL must start with http:// or https://');
  }

  if (!existsSync(MCP_PATH)) errors.push(`ERROR: MCP script not found at: ${MCP_PATH}`);

  const nodeVersion = process.versions.node.split('.')[0];
  if (parseInt(nodeVersion) < 18) {
    errors.push(`ERROR: Node.js 18+ required, found: ${process.versions.node}`);
  }

  return errors;
}

const configErrors = validateConfig();
if (configErrors.length > 0) {
  console.error('\nConfiguration Errors:\n');
  configErrors.forEach(err => console.error(err));
  console.error('\nFix these issues before starting:');
  console.error('export HA_URL=http://homeassistant.10.0.0.19.nip.io:8123');
  console.error('export HA_TOKEN=your_long_lived_access_token\n');
  process.exit(1);
}

// ====== CORS ======
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:8282",
  "http://localhost:8282"
]);

function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    // LAN/dev friendly. Tighten if you expose this publicly.
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ====== HELPERS ======
interface McpResult {
  result?: {
    content?: Array<{ text?: string }>;
  };
}

function extractText(result: McpResult): string | undefined {
  return result?.result?.content?.[0]?.text;
}

function tryParseJson(text: string | undefined): any {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, statusCode: number, obj: any): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!body.trim()) return resolve(null);
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${(e as Error).message}`));
      }
    });
  });
}

// This runs the MCP stdio script once per request
function runMcpWithJsonInput(jsonObj: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const mcp = spawn('node', [MCP_PATH], {
      env: {
        ...process.env,
        HA_URL: process.env.HA_URL!,
        HA_TOKEN: process.env.HA_TOKEN!,
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let mcpOutput = '';
    let mcpError = '';
    let headerSeen = false;

    mcp.stdout.on('data', (data) => {
      const str = data.toString();
      if (str.includes('Home Assistant MCP server running') || str.includes('MCP server connected and ready')) {
        headerSeen = true;
        return;
      }
      if (headerSeen) mcpOutput += str;
    });

    mcp.stderr.on('data', (data) => {
      const str = data.toString();
      if (!str.includes('Home Assistant MCP server running') && !str.includes('MCP server connected and ready')) {
        mcpError += str;
      } else {
        headerSeen = true;
      }
    });

    mcp.stdin.write(JSON.stringify(jsonObj) + '\n');
    mcp.stdin.end();

    const timeout = setTimeout(() => {
      mcp.kill();
      reject(new Error('MCP timeout after 30s'));
    }, 30000);

    mcp.on('close', (code) => {
      clearTimeout(timeout);

      if (!mcpOutput.trim()) {
        reject(new Error(`No output from MCP (exit=${code}). stderr=${mcpError}`));
        return;
      }

      try {
        const parsed = JSON.parse(mcpOutput.trim());
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Invalid JSON from MCP: ${(e as Error).message}. raw=${mcpOutput}`));
      }
    });

    mcp.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function callMcpTool(name: string, argumentsObj?: any): Promise<any> {
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: argumentsObj ?? {} }
  };
  return runMcpWithJsonInput(request);
}

// ====== SERVER ======
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      mcp_path: MCP_PATH,
      ha_url: process.env.HA_URL,
      token_configured: !!process.env.HA_TOKEN,
    });
    return;
  }

  // OpenAPI served from disk
  if (req.method === 'GET' && (req.url === '/openapi.json' || req.url === '/openapi')) {
    try {
      const openApiPath = path.join(__dirname, '..', 'openapi.json');
      const { readFileSync } = await import('fs');
      const content = readFileSync(openApiPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(content);
    } catch (e) {
      sendJson(res, 500, {
        error: "Failed to read openapi.json",
        details: (e as Error).message
      });
    }
    return;
  }

  // ===== Pretty REST endpoints =====
  if (req.method === 'POST' && req.url === '/get_all_sensors') {
    try {
      const raw = await callMcpTool('getStates', {});
      const text = extractText(raw);
      const parsed = tryParseJson(text);

      if (!parsed || !Array.isArray(parsed.entities)) {
        sendJson(res, 502, { error: "Unexpected MCP response format", raw });
        return;
      }

      // Filter to sensors only to match legacy behavior
      const sensors = parsed.entities.filter((e: any) =>
        e.entity_id?.startsWith('sensor.')
      );

      sendJson(res, 200, { count: sensors.length, sensors, raw });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/get_sensor_state') {
    try {
      const body = await readBody(req);
      const entity_id = body?.entity_id;
      if (!entity_id || typeof entity_id !== 'string') {
        sendJson(res, 400, { error: "Missing required field: entity_id (string)" });
        return;
      }

      const raw = await callMcpTool('getState', { entity_id });
      const text = extractText(raw);
      const entity = tryParseJson(text);

      if (!entity || typeof entity !== 'object') {
        sendJson(res, 502, { error: "Unexpected MCP response format", raw });
        return;
      }

      sendJson(res, 200, { entity, raw });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/control_device') {
    try {
      const body = await readBody(req);
      const domain = body?.domain;
      const service = body?.service;
      const data = body?.data ?? {};

      if (!domain || typeof domain !== 'string') {
        sendJson(res, 400, { error: "Missing required field: domain (string)" });
        return;
      }
      if (!service || typeof service !== 'string') {
        sendJson(res, 400, { error: "Missing required field: service (string)" });
        return;
      }
      if (typeof data !== 'object' || Array.isArray(data) || data === null) {
        sendJson(res, 400, { error: "Field 'data' must be an object" });
        return;
      }

      const raw = await callMcpTool('callService', {
        domain,
        service,
        service_data: data,
      });
      const text = extractText(raw);
      const parsed = tryParseJson(text);

      sendJson(res, 200, { ok: true, result: parsed ?? text ?? null, raw });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  // ===== Raw passthrough endpoint (for n8n compatibility) =====
  if (req.method === 'POST' && req.url === '/') {
    try {
      const body = await readBody(req);
      if (!body) {
        sendJson(res, 400, { error: "Empty JSON body" });
        return;
      }
      const result = await runMcpWithJsonInput(body);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('MCP Wrapper started successfully!');
  console.log(`Listening on 0.0.0.0:${PORT}`);
  console.log(`MCP script: ${MCP_PATH}`);
  console.log(`Home Assistant: ${process.env.HA_URL}`);
  console.log(`Token: ${process.env.HA_TOKEN ? '***configured***' : 'MISSING'}`);
  console.log(`\nTest with: curl http://localhost:${PORT}/health\n`);
});
