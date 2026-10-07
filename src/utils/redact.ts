/**
 * Redaction of secrets in tool responses.
 *
 * Home Assistant and Omada return secrets inside ordinary read results: the
 * Wi-Fi password (Omada `pskSetting.securityKey`), RADIUS / CoA / SNMP secrets,
 * PPSK and VPN keys, portal passwords, camera access tokens in image URLs. A tool
 * response goes to an AI client and from there into transcripts, so every tool
 * response is passed through `redactSecrets` (see toToolResult).
 *
 * Only non-empty string values under secret-looking names are replaced, with
 * "<redacted>": an empty value stays empty (so "is a password set?" is still
 * answerable), and booleans or numbers under similar names (`hidePwd`,
 * `encryptionPsk`) are left alone. `token=` / `access_token=` query values inside
 * URLs are masked as well. The input is never modified.
 *
 * Applied at the response boundary only, never inside the API clients: internal
 * read-modify-write paths (SSID schedule, site NTP) must see real values.
 */

export const REDACTED = '<redacted>';

/**
 * Secret-looking field names, matched on the whole name or its ending
 * (case-insensitive), from the Omada Open API and Home Assistant responses.
 */
const SECRET_NAME =
  /(^key$|password|passwd|pwd$|secret|token$|passphrase|presharedkey|privatekey|securitykey|communitystring|^psk$|md5key|simplekey|authcode|devicekey)/i;

/** Credentials inside URLs, e.g. /api/camera_proxy/camera.door?token=abc123 */
const URL_SECRET = /([?&](?:access_token|token|key|password|secret)=)[^&#\s"]+/gi;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function redactSecrets<T>(value: T): T {
  return redact(value, new WeakSet()) as T;
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value.includes('=') ? value.replace(URL_SECRET, `$1${REDACTED}`) : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    out[key] = typeof field === 'string' && field !== '' && isSecretName(key) ? REDACTED : redact(field, seen);
  }
  return out;
}
