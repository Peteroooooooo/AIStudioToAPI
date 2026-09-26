const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../data/config.json"), "utf8"));
const key = config.startup.apiKeys?.[0];
const baseUrl = `http://127.0.0.1:${config.startup.httpPort}`;
const salt = randomUUID().slice(0, 8);
const systemText = Array.from(
    { length: 420 },
    (_, index) =>
        `Shared instruction reference ${salt}-${index}: amber cobalt violet zircon prism cadence archive lantern orchard compass. ` +
        "This numbered line is fixed for every independent session."
).join("\n");

async function request(route, method, body) {
    const response = await fetch(`${baseUrl}${route}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        method,
        signal: AbortSignal.timeout(120000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = result.error || {};
        throw new Error(`${method} ${route}: HTTP ${response.status}, ${error.status || error.code || "unknown"}`);
    }
    return result;
}

async function main() {
    if (!key) throw new Error("Missing local API key.");
    const model = "gemini-3.8-flash";
    const systemInstruction = { parts: [{ text: systemText }] };
    let name;
    try {
        try {
            const count = await request(`/v1beta/models/${model}:countTokens`, "POST", {
                generateContentRequest: {
                    contents: [{ parts: [{ text: "." }], role: "user" }],
                    model: `models/${model}`,
                    systemInstruction,
                },
            });
            console.log(`system-only countTokens=${count.totalTokens || 0}`);
        } catch (error) {
            console.log(`system-only countTokens unavailable: ${error.message}`);
        }
        const cache = await request("/v1beta/cachedContents", "POST", {
            model: `models/${model}`,
            systemInstruction,
            ttl: "60s",
        });
        name = cache.name;
        const generated = await request(`/v1beta/models/${model}:generateContent`, "POST", {
            cachedContent: name,
            contents: [{ parts: [{ text: "Reply exactly SHARED." }], role: "user" }],
            generationConfig: { maxOutputTokens: 96, thinkingConfig: { thinkingLevel: "LOW" } },
        });
        const cached = generated.usageMetadata?.cachedContentTokenCount || 0;
        console.log(`system-only cachedTokens=${cached}`);
        if (cached < 4096) throw new Error("System-only cache was not used.");
        const renewed = await request(`/v1beta/${name}?updateMask=ttl`, "PATCH", { ttl: "3600s" });
        if (Date.parse(renewed.expireTime) - Date.now() < 3_500_000) {
            throw new Error("Upstream cache TTL was not renewed.");
        }
        console.log("PASS system-only shared prefix");
    } finally {
        if (name) await request(`/v1beta/${name}`, "DELETE").catch(() => {});
    }

    const indexFile = path.resolve(__dirname, "../../data/gemini-cache-index.json");
    const previousSharedCount = JSON.parse(fs.readFileSync(indexFile, "utf8")).entries.filter(
        entry => entry.prefixLength === 0
    ).length;
    const first = await request(`/v1beta/models/${model}:generateContent`, "POST", {
        contents: [{ parts: [{ text: "Reply exactly APPLE." }], role: "user" }],
        generationConfig: { maxOutputTokens: 96, thinkingConfig: { thinkingLevel: "LOW" } },
        systemInstruction,
    });
    if (!first.candidates?.[0]?.content) throw new Error("First independent session returned no answer.");
    const until = Date.now() + 120000;
    let sharedCreated = false;
    while (Date.now() < until) {
        const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
        if (index.entries?.filter(entry => entry.prefixLength === 0).length > previousSharedCount) {
            sharedCreated = true;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!sharedCreated) throw new Error("Automatic shared prefix cache was not created.");
    const second = await request(`/v1beta/models/${model}:generateContent`, "POST", {
        contents: [{ parts: [{ text: "Reply exactly PEAR." }], role: "user" }],
        generationConfig: { maxOutputTokens: 96, thinkingConfig: { thinkingLevel: "LOW" } },
        systemInstruction,
    });
    const sharedTokens = second.usageMetadata?.cachedContentTokenCount || 0;
    console.log(`independent-session cachedTokens=${sharedTokens}`);
    if (sharedTokens < 4096) throw new Error("Second independent session did not use shared prefix.");
    console.log("PASS automatic shared prefix across new sessions");
}

main().catch(error => {
    console.error(`FAIL system-only probe: ${error.message}`);
    process.exitCode = 1;
});
