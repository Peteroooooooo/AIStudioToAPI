/**
 * File: src/utils/ProxyUtils.js
 * Description: Utility functions for parsing configured proxy settings and legacy environment variables
 *
 * Author: iBenzene, bbbugg
 */

const PROXY_SERVER_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy"];
const DEFAULT_BYPASS = ["localhost", "127.0.0.1", "::", "::1", "0.0.0.0"];
const LEGACY_PROXY_ENV_KEYS = [...PROXY_SERVER_ENV_KEYS, ...NO_PROXY_ENV_KEYS];

const _getFirstEnvValue = envKeys => {
    const envKey = envKeys.find(key => process.env[key] && String(process.env[key]).trim());
    return envKey
        ? {
              envKey,
              value: String(process.env[envKey]).trim(),
          }
        : null;
};

const _getProxyServerEnv = () => _getFirstEnvValue(PROXY_SERVER_ENV_KEYS);

const getProxyBypass = value => {
    const userBypass = value
        ? String(value)
              .split(",")
              .map(s => s.trim())
              .filter(Boolean)
        : [];

    return [...new Set([...DEFAULT_BYPASS, ...userBypass])].join(",");
};

const getProxyBypassFromEnv = () => getProxyBypass(_getFirstEnvValue(NO_PROXY_ENV_KEYS)?.value);

const withoutLegacyProxyEnv = env => {
    const browserEnv = { ...env };
    for (const key of LEGACY_PROXY_ENV_KEYS) delete browserEnv[key];
    return browserEnv;
};

// Redact credentials in proxy strings, without needing valid URL parsing.
// - `scheme://user:pass@host` -> `scheme://***@host`
// - `user:pass@host:port` -> `***@host:port`
const _redactProxyCredentials = serverRaw => {
    const raw = String(serverRaw);
    const withScheme = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]+)@/i, "$1***@");
    if (withScheme !== raw) return withScheme;
    return raw.replace(/^([^@/]+)@/, "***@");
};

/** Parse a configured proxy URL into Playwright's launch/context format. */
const parseProxyConfig = (proxyUrl, proxyBypass) => {
    if (!proxyUrl || !String(proxyUrl).trim()) return null;

    const serverRaw = String(proxyUrl).trim();
    const bypass = getProxyBypass(proxyBypass);

    // Playwright expects: { server, bypass?, username?, password? }
    // server examples: "http://127.0.0.1:7890", "socks5://127.0.0.1:7890"
    try {
        const u = new URL(serverRaw);
        if (!u.host) throw new Error("Proxy URL has no host");
        const proxy = {
            bypass,
            server: `${u.protocol}//${u.host}`,
        };

        if (u.username) proxy.username = decodeURIComponent(u.username);
        if (u.password) proxy.password = decodeURIComponent(u.password);

        return proxy;
    } catch {
        // If URL parsing fails, use raw value directly
        return {
            bypass,
            server: serverRaw,
        };
    }
};

/** Only used when importing an existing environment into the persistent config. */
const parseProxyFromEnv = () => {
    const proxyEnv = _getProxyServerEnv();
    return parseProxyConfig(proxyEnv?.value, _getFirstEnvValue(NO_PROXY_ENV_KEYS)?.value);
};

/**
 * Get a safe summary of a configured proxy URL.
 * This is intended for logging/UI display and avoids leaking credentials.
 *
 * @returns {{enabled: boolean, server?: string}}
 */
const getProxySummary = proxyUrl => {
    if (!proxyUrl || !String(proxyUrl).trim()) return { enabled: false };

    const serverRaw = String(proxyUrl).trim();

    try {
        const u = new URL(serverRaw);
        if (!u.host) throw new Error("Proxy URL has no host");
        return {
            enabled: true,
            server: `${u.protocol}//${u.host}`,
        };
    } catch {
        // If URL parsing fails, at least redact obvious `user:pass@` patterns
        return {
            enabled: true,
            server: _redactProxyCredentials(serverRaw),
        };
    }
};

/** Only used when importing an existing environment into the persistent config. */
const getProxySummaryFromEnv = () => {
    const proxyEnv = _getProxyServerEnv();
    if (!proxyEnv) return { enabled: false };
    return { ...getProxySummary(proxyEnv.value), envKey: proxyEnv.envKey };
};

module.exports = {
    getProxyBypass,
    getProxyBypassFromEnv,
    getProxySummary,
    getProxySummaryFromEnv,
    parseProxyConfig,
    parseProxyFromEnv,
    withoutLegacyProxyEnv,
};
