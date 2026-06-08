# syntax=docker/dockerfile:1.7

FROM node:25-alpine AS deps
WORKDIR /app
COPY package*.json ./
# npm ci installs exactly from the committed package-lock.json (reproducible) and
# fails if package.json and the lockfile have drifted. The `package*.json` COPY
# above pulls in package-lock.json, so the lockfile is present in this stage.
RUN npm ci

FROM node:25-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:25-alpine AS runtime

# OCI metadata labels
LABEL org.opencontainers.image.title="MCP-HA-Connect"
LABEL org.opencontainers.image.description="MCP server for Home Assistant + TP-Link Omada + Local AI integration"
LABEL org.opencontainers.image.authors="Coffee Run Hobby"
LABEL org.opencontainers.image.url="https://github.com/coffeerunhobby/mcp-ha-connect"
LABEL org.opencontainers.image.source="https://github.com/coffeerunhobby/mcp-ha-connect"
LABEL org.opencontainers.image.documentation="https://github.com/coffeerunhobby/mcp-ha-connect#readme"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache curl
COPY package*.json ./
# Reproducible prod-only install from the lockfile (drops devDependencies).
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# M10: drop root. The official node image ships a non-root `node` user (uid 1000).
# Built artifacts under /app are world-readable, so no chown is required; the
# server listens on 3000 (>1024) which needs no privileged capability.
USER node
CMD ["node", "--experimental-quic", "dist/index.js"]
