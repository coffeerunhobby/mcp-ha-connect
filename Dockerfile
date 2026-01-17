# syntax=docker/dockerfile:1.7

FROM node:25-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install

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
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "--experimental-quic", "dist/index.js"]
