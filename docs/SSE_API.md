# SSE Event Subscription API

The MCP-HA-Connect server includes a powerful Server-Sent Events (SSE) system that provides real-time updates from your Home Assistant instance.

## Overview

The SSE endpoint allows HTTP clients to subscribe to real-time events from Home Assistant, including:

- **State Changes**: Get instant notifications when any device state changes
- **Automation Triggers**: Monitor when automations are triggered
- **Service Calls**: Track service call executions
- **Domain-Specific Events**: Filter events by specific domains (lights, sensors, etc.)

## Configuration

### Environment Variables

```bash
# Enable SSE event subscription (default: true)
MCP_SSE_EVENTS_ENABLED=true

# SSE endpoint path (default: /subscribe_events)
MCP_SSE_EVENTS_PATH=/subscribe_events
```

## Endpoint

```
GET /subscribe_events
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `domain` | string | Filter events by domain (e.g., `light`, `sensor`, `switch`) |
| `entity_id` | string | Filter events for a specific entity |
| `event_types` | string | Comma-separated list of event types to subscribe to |
| `token` | string | Optional authentication token (for future use) |

### Examples

#### Subscribe to all state changes

```bash
curl -N "http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events"
```

#### Subscribe to light changes only

```bash
curl -N "http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events?domain=light"
```

#### Subscribe to a specific entity

```bash
curl -N "http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events?entity_id=sensor.temperature"
```

#### Subscribe to multiple event types

```bash
curl -N "http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events?event_types=state_changed,call_service"
```

## SSE Event Format

### Connection Established

When the connection is established, you'll receive a `connected` event:

```
event: connected
data: {"client_id":"sse_1234567890_abc123","message":"Connected to Home Assistant event stream","filters":{"domain":"light"},"timestamp":"2026-01-09T12:00:00.000Z"}
```

### State Changed Events

```
event: state_changed
data: {
  "event_type": "state_changed",
  "entity_id": "light.living_room",
  "old_state": {
    "entity_id": "light.living_room",
    "state": "off",
    "attributes": {"brightness": 0},
    "last_changed": "2026-01-09T11:00:00.000Z",
    "last_updated": "2026-01-09T11:00:00.000Z"
  },
  "new_state": {
    "entity_id": "light.living_room",
    "state": "on",
    "attributes": {"brightness": 255},
    "last_changed": "2026-01-09T12:00:00.000Z",
    "last_updated": "2026-01-09T12:00:00.000Z"
  },
  "time_fired": "2026-01-09T12:00:00.000Z",
  "context": {
    "id": "abc123",
    "parent_id": null,
    "user_id": null
  }
}
```

### Service Call Events

```
event: call_service
data: {
  "event_type": "call_service",
  "domain": "light",
  "service": "turn_on",
  "service_data": {"brightness": 255},
  "time_fired": "2026-01-09T12:00:00.000Z"
}
```

### Keep-Alive Comments

The server sends periodic keep-alive comments to maintain the connection:

```
: keepalive 2026-01-09T12:00:30.000Z
```

### Error Events

```
event: error
data: {"error":"Connection lost","message":"WebSocket disconnected"}
```

### Disconnect Events

```
event: disconnect
data: {"reason":"Server shutdown"}
```

## JavaScript Client Example

### Basic Usage

```javascript
const eventSource = new EventSource(
  'http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events?domain=light'
);

// Handle connection
eventSource.addEventListener('connected', (event) => {
  const data = JSON.parse(event.data);
  console.log('Connected:', data.client_id);
});

// Handle state changes
eventSource.addEventListener('state_changed', (event) => {
  const data = JSON.parse(event.data);
  console.log('State changed:', data.entity_id);
  console.log('  Old state:', data.old_state?.state);
  console.log('  New state:', data.new_state?.state);
});

// Handle errors
eventSource.onerror = (error) => {
  console.error('SSE error:', error);
  // EventSource will automatically reconnect
};

// Close connection when done
// eventSource.close();
```

### React Hook Example

```javascript
import { useEffect, useState } from 'react';

function useHomeAssistantEvents(domain) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const url = domain
      ? `http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events?domain=${domain}`
      : 'http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events';

    const eventSource = new EventSource(url);

    eventSource.addEventListener('connected', () => {
      setConnected(true);
    });

    eventSource.addEventListener('state_changed', (event) => {
      const data = JSON.parse(event.data);
      setEvents(prev => [...prev.slice(-99), data]);
    });

    eventSource.onerror = () => {
      setConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, [domain]);

  return { events, connected };
}

// Usage in component
function LightMonitor() {
  const { events, connected } = useHomeAssistantEvents('light');

  return (
    <div>
      <p>Status: {connected ? 'Connected' : 'Disconnected'}</p>
      <ul>
        {events.map((event, i) => (
          <li key={i}>
            {event.entity_id}: {event.new_state?.state}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Node.js Client Example

```javascript
import EventSource from 'eventsource';

const es = new EventSource('http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events');

es.addEventListener('connected', (event) => {
  console.log('Connected to Home Assistant');
});

es.addEventListener('state_changed', (event) => {
  const data = JSON.parse(event.data);
  console.log(`${data.entity_id}: ${data.old_state?.state} -> ${data.new_state?.state}`);
});

es.onerror = (error) => {
  console.error('Error:', error);
};
```

## Event Types

| Event Type | Description |
|------------|-------------|
| `state_changed` | Entity state has changed |
| `call_service` | A service was called |
| `automation_triggered` | An automation was triggered |
| `script_started` | A script was started |
| `homeassistant_start` | Home Assistant has started |
| `homeassistant_stop` | Home Assistant is stopping |

## Health Check

The health endpoint includes SSE-related information:

```bash
curl http://mcpserver.10.0.0.18.nip.io:3000/health
```

Response:
```json
{
  "status": "healthy",
  "version": "0.8.0",
  "sseEventsEnabled": true,
  "sseEventsPath": "/subscribe_events",
  "sseConnectedClients": 3
}
```

## Rate Limiting

The SSE endpoint is subject to the same rate limiting as other endpoints:

- Default: 100 requests per minute per IP
- Configurable via `MCP_RATE_LIMIT_MAX_REQUESTS` and `MCP_RATE_LIMIT_WINDOW_MS`

Note: Once an SSE connection is established, it remains open and does not count against rate limits.

## CORS Support

CORS is enabled for the SSE endpoint to allow browser-based clients:

```javascript
// Browser clients from any origin can connect
const eventSource = new EventSource(
  'http://mcpserver.10.0.0.18.nip.io:3000/subscribe_events'
);
```

## Troubleshooting

### Connection keeps disconnecting

- Check that your Home Assistant instance is accessible
- Verify the `HA_URL` and `HA_TOKEN` are correct
- Check the server logs for WebSocket errors

### No events received

- Verify that events are actually occurring in Home Assistant
- Check that your domain/entity filters are correct
- Try subscribing without filters first

### CORS errors in browser

- Ensure `MCP_HTTP_ALLOW_CORS=true` is set
- Check that your origin is in `MCP_HTTP_ALLOWED_ORIGINS` or use `*`

### High memory usage

- Limit the number of concurrent SSE connections
- Use domain/entity filters to reduce event volume
- Consider using the rate limiter to prevent abuse

## Best Practices

1. **Use filters**: Subscribe only to the events you need to reduce bandwidth and processing
2. **Handle reconnection**: EventSource automatically reconnects, but handle the reconnection gracefully
3. **Debounce updates**: If updating UI frequently, consider debouncing to prevent performance issues
4. **Clean up**: Always close the EventSource when the component unmounts or when done
5. **Error handling**: Implement proper error handling for network issues

## Security Considerations

1. The SSE endpoint does not currently require authentication (relies on network security)
2. Run the server on a private network or behind a reverse proxy with authentication
3. Use HTTPS in production to encrypt event data
4. Consider using the `token` parameter for future authentication implementations
