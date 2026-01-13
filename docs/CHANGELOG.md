### 0.9.0
- **Streamable HTTP Only**: Removed deprecated SSE transport, keeping only Streamable HTTP
  - Real-time HA event subscriptions still available at `/subscribe_events`
- **Autonomic Priority System**: New tiered response architecture for home automation
  - `Priority` enum with bitwise flags: REFLEX (1), SUPERVISED (32), INFORMATIONAL (64), LOG (128)
  - `PriorityMask` for filtering: CRITICAL, ACTIONABLE, USER_FACING, ALL
  - Helper functions: `matchesPriority`, `getPriorityTier`, `bypassesQuietHours`, etc.
  - Based on MOQT priority model adapted for home automation tiers
- Preparing for future QUIC transport (Node.js 25+ experimental support)
- All 660 tests passing

### 0.8.0
- **Bearer Token Authentication**: Secure HTTP endpoints with bearer tokens
  - `MCP_AUTH_METHOD`: Set to `bearer` to enable authentication
  - `MCP_AUTH_TOKEN`: Comma-separated tokens for multiple clients
  - `WWW-Authenticate` header on 401 responses
  - Health check and OpenAPI endpoints skip authentication
- **Server-Timing Header**: Response timing on all HTTP responses
  - `Server-Timing: total;dur=X` header (integer milliseconds)
  - Visible in browser DevTools Network tab
- **Modular Auth Middleware**: Clean separation in `src/server/auth.ts`
- All 648 tests passing

### 0.7.0
- **Calendar Tools**: Access Home Assistant calendar entities
  - `listCalendars`: Get all calendar entities
  - `getCalendarEvents`: Get events from one or all calendars with date filtering
- **Person Tracking Tool**: Track household members
  - `listPersons`: List all person entities with location state (home/away)
  - Optimized description for small LLM tool selection
  - Returns onsite/away counts and linked device trackers
- Total tools increased from 34 to 37

### 0.6.0
- **Mobile App Notifications**: Full support for Home Assistant mobile app notifications
  - `sendNotification`: Enhanced with action buttons, priority, images, videos
  - `listNotificationTargets`: Discover available mobile app notification targets
  - Android-specific options: priority, channel, LED color, vibration patterns
  - iOS-specific options: interruption level, badge count, critical alerts
  - Sticky and persistent notification support
- **Fixed Automation API**: `createAutomation` now works correctly
  - Uses correct endpoint: `POST /config/automation/config/{id}`
  - Auto-generates timestamp-based IDs (like HA UI)
  - Auto-reloads automations after creation
  - Added optional `id` field to AutomationConfig type
- **Refactored Tools Architecture**: Split monolithic registry into individual tool files
  - Each tool now in its own file under `src/tools/`
  - Improved maintainability and code organization
  - Shared schemas and utilities in `src/tools/common.ts`
- Switched to NodeNext module resolution for TypeScript
- All 310 tests passing

### 0.5.0
- **Real-time SSE Event Subscription**: Subscribe to Home Assistant events via Server-Sent Events
  - Filter by domain, entity_id, or event types
  - Automatic WebSocket connection to Home Assistant
  - Keep-alive support for persistent connections
- **Enhanced Automation Management**: Full automation lifecycle support
  - `triggerAutomation`: Manually trigger automations with variables
  - `enableAutomation`/`disableAutomation`/`toggleAutomation`: Control automation state
  - `createAutomation`: Create new automations via API
  - `deleteAutomation`: Remove automations
  - `reloadAutomations`: Reload from configuration
  - `getAutomationTrace`: View execution history
- **Advanced Device Control Tools**:
  - `controlLight`: Brightness, color, color temperature, transitions
  - `controlClimate`: Temperature, HVAC mode, fan mode, presets
  - `controlMediaPlayer`: Playback, volume, mute controls
  - `controlCover`: Position and tilt control
  - `controlFan`: Speed, oscillation, direction
  - `activateScene`: Scene activation
  - `runScript`: Script execution with variables
  - `sendNotification`: Send notifications through Home Assistant
- **Rate Limiting**: Built-in token bucket rate limiter
  - Configurable window and request limits
  - Per-IP tracking with automatic cleanup
  - Skip paths for health checks
- **New Configuration Options**:
  - `MCP_SSE_EVENTS_ENABLED`: Enable/disable SSE
  - `MCP_SSE_EVENTS_PATH`: Customize SSE endpoint
  - `MCP_RATE_LIMIT_ENABLED`: Enable/disable rate limiting
  - `MCP_RATE_LIMIT_WINDOW_MS`: Rate limit window
  - `MCP_RATE_LIMIT_MAX_REQUESTS`: Max requests per window
- Total tools increased from 16 to 33

### 0.4.0
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

### 0.3.0
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

### 0.2.0
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

### 0.1.0
- Basic Home Assistant integration
- 5 core tools (getStates, getState, callService, getEntitiesByDomain, searchEntities)
- Multiple transport modes (stdio, SSE, HTTP streaming)
- Full TypeScript support