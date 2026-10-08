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
 * "<redacted>" (so are a SIM PIN/PUK and, inside dial-up and VPN sections, account
 * user names): an empty value stays empty (so "is a password set?" is still
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
  /(^key$|password|passwd|pwd$|secret|token$|passphrase|presharedkey|privatekey|securitykey|communitystring|^psk$|md5key|simplekey|authcode|devicekey|^(sim)?pin(code)?$|^puk\d?(code)?$)/i;

/**
 * Account names that identify a subscription (the ISP PPPoE login, the LTE APN
 * user, VPN users). Redacted only inside dial-up and VPN sections, so ordinary
 * names (Home Assistant users, device names) stay readable.
 */
const ACCOUNT_NAME = /^(user_?name|username|account)$/i;
const ACCOUNT_SECTION = /(pppoe|l2tp|pptp|lte|manuallyconfig|apn|dialup|vpn)/i;

/** Credentials inside URLs, e.g. /api/camera_proxy/camera.door?token=abc123 */
const URL_SECRET = /([?&](?:access_token|token|key|password|secret)=)[^&#\s"]+/gi;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Whether a name (an object key, or a resource path such as "/vpn/client-to-site/clients") is a dial-up or VPN section. */
export function isAccountSection(name: string): boolean {
  return ACCOUNT_SECTION.test(name);
}

/**
 * `accountSection`: the value as a whole comes from a dial-up or VPN section (e.g. an
 * unwrapped list of VPN users), so account names are redacted from the top level on.
 */
export function redactSecrets<T>(value: T, options: { accountSection?: boolean } = {}): T {
  return redact(value, new WeakSet(), options.accountSection === true) as T;
}

/** `inAccountSection`: an enclosing key names a dial-up or VPN section. */
function redact(value: unknown, seen: WeakSet<object>, inAccountSection: boolean): unknown {
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
    return value.map((item) => redact(item, seen, inAccountSection));
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    const secret = isSecretName(key) || (inAccountSection && ACCOUNT_NAME.test(key));
    out[key] = typeof field === 'string' && field !== '' && secret ? REDACTED : redact(field, seen, inAccountSection || ACCOUNT_SECTION.test(key));
  }
  return out;
}
