#!/usr/bin/env bash
# Boot-test an mcp-ha-connect image: run it against a mock Home Assistant and
# require /health to answer. Used by CI for every push (docker-smoke) and for the
# exact image a release publishes (publish-image), so no image is ever published
# without having booted.
#
# Usage: scripts/ci/smoke.sh <image>
IMAGE="${1:?usage: smoke.sh <image>}"
set -eu
docker network create smoke
# Mock HA: 200 {"message":"API running."} — the same body the real
# /api/ startup check (checkApi) expects.
docker run -d --name mockha --network smoke node:24-alpine \
  node -e 'require("http").createServer((q,s)=>{s.writeHead(200,{"Content-Type":"application/json"});s.end(JSON.stringify({message:"API running."}))}).listen(8123,()=>console.log("mock HA up"))'
# HA_STRICT_SSL=false mirrors the REAL NAS config — the exact combination
# (http HA + strictSsl=false) that crash-looped v1.5.5 on a node:26 base
# (npm-undici-6 dispatcher passed to Node's built-in fetch -> "invalid
# onError method" -> "fetch failed"). The smoke must boot with it forever.
docker run -d --name mcp --network smoke \
  -e MCP_SERVER_USE_HTTP=true \
  -e MCP_HTTP_PORT=3000 -e MCP_HTTP_BIND_ADDR=0.0.0.0 \
  -e MCP_HTTP_ENABLE_HEALTHCHECK=true -e MCP_HTTP_HEALTHCHECK_PATH=/health \
  -e MCP_AUTH_METHOD=bearer -e MCP_AUTH_SECRET=ci-smoke-dummy-secret-0123456789 \
  -e HA_PLUGIN_ENABLED=true -e HA_URL=http://mockha:8123 -e HA_TOKEN=ci-dummy \
  -e HA_STRICT_SSL=false \
  -e AI_PLUGIN_ENABLED=false -e OMADA_PLUGIN_ENABLED=false \
  "$IMAGE"
for _ in $(seq 1 15); do
  if docker run --rm --network smoke curlimages/curl:latest -sf http://mcp:3000/health >/dev/null 2>&1; then
    echo "smoke OK: image boots, startup HA check passes, /health answers"
    exit 0
  fi
  sleep 2
done
echo "SMOKE FAILED — container logs:"
docker logs mcp
exit 1
