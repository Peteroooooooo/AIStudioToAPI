const AI_STUDIO_HOSTS = new Set(["aistudio.google.com", "ai.studio"]);
const AUTH_COOKIE_HOSTS = new Set(["google.com", "accounts.google.com", "aistudio.google.com", "ai.studio"]);

export function isRelevantCookieDomain(value) {
    return typeof value === "string" && AUTH_COOKIE_HOSTS.has(value.replace(/^\./, "").toLowerCase());
}

export function isAiStudioUrl(value) {
    try {
        return AI_STUDIO_HOSTS.has(new URL(value).hostname);
    } catch {
        return false;
    }
}

export function toPlaywrightCookie(cookie) {
    if (!cookie?.name || typeof cookie.value !== "string" || !cookie.domain) return null;
    const sameSite = { lax: "Lax", no_restriction: "None", strict: "Strict", unspecified: "Lax" };
    return {
        domain: cookie.domain,
        expires: cookie.session ? -1 : Number(cookie.expirationDate ?? -1),
        httpOnly: Boolean(cookie.httpOnly),
        name: cookie.name,
        path: cookie.path || "/",
        sameSite: sameSite[cookie.sameSite] || "Lax",
        secure: Boolean(cookie.secure),
        value: cookie.value,
    };
}

export function buildStorageState(pageState, cookieGroups) {
    const accountName = pageState?.accountName;
    if (typeof accountName !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountName)) {
        throw new Error("无法确认当前登录的账号，请在 AI Studio 页面完成登录后重试");
    }
    if (!isAiStudioUrl(pageState.origin)) {
        throw new Error("请先切换到已经登录的 AI Studio 标签页");
    }

    const cookies = new Map();
    for (const group of cookieGroups) {
        for (const cookie of group) {
            // Firefox/Playwright cannot restore Chrome's partition key.
            if (cookie.partitionKey) continue;
            const normalized = toPlaywrightCookie(cookie);
            if (normalized) {
                cookies.set(`${normalized.name}\u0000${normalized.domain}\u0000${normalized.path}`, normalized);
            }
        }
    }
    if (cookies.size === 0 || ![...cookies.values()].some(cookie => cookie.domain.endsWith("google.com"))) {
        throw new Error("没有找到可导出的 Google 登录 Cookie");
    }

    return {
        accountName,
        cookies: [...cookies.values()],
        origins: [
            {
                localStorage: Array.isArray(pageState.localStorage) ? pageState.localStorage : [],
                origin: pageState.origin,
            },
        ],
    };
}
