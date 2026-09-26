/** Keep credentials out of the authenticated status response's log text. */

function collectSecrets(config, savedStartup) {
    const secrets = new Set();
    for (const source of [config, config?.startup, savedStartup]) {
        if (!source) continue;
        for (const key of Array.isArray(source.apiKeys) ? source.apiKeys : []) {
            if (typeof key === "string" && key) secrets.add(key);
        }
        for (const field of ["webConsolePassword", "sessionSecret", "proxyUrl"]) {
            if (typeof source[field] === "string" && source[field]) secrets.add(source[field]);
        }
        if (typeof source.proxyUrl === "string" && source.proxyUrl) {
            try {
                const url = new URL(source.proxyUrl);
                for (const part of [url.username, url.password]) {
                    if (!part) continue;
                    secrets.add(part);
                    try {
                        secrets.add(decodeURIComponent(part));
                    } catch {
                        // Keep the encoded value when a proxy URL contains malformed escapes.
                    }
                }
            } catch {
                // A malformed proxy URL should not prevent safe log rendering.
            }
        }
    }
    return [...secrets].sort((a, b) => b.length - a.length);
}

function sanitizeStatusLogs(value, config, savedStartup) {
    let text = typeof value === "string" ? value : "";
    for (const secret of collectSecrets(config, savedStartup)) {
        text = text.replaceAll(secret, "[REDACTED]");
    }
    return text
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+={0,2}/gi, "Bearer [REDACTED]")
        .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
        .replace(/(\b(?:Set-Cookie|Cookie)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
        .replace(/((?:https?|socks5?):\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
        .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
        .replace(/(["']?apiKeys["']?\s*[:=]\s*)\[[^\]]*\]/gi, "$1[REDACTED]")
        .replace(
            /(["']?(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|session[_-]?secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
            "$1[REDACTED]"
        );
}

module.exports = { sanitizeStatusLogs };
