/**
 * Live Gemini explicit-cache check against the locally running fork.
 * Reads the ignored local config and never prints credentials or prompt bodies.
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const dataDir = path.join(root, "data");
const startup = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).startup;
const apiKey = startup.apiKeys?.[0];
const baseUrl = `http://127.0.0.1:${startup.httpPort}`;
const indexFile = path.join(dataDir, "gemini-cache-index.json");
const model = "gemini-3.8-flash";

if (!apiKey) throw new Error("A local API key is required in data/config.json.");

function entries() {
    try {
        return JSON.parse(fs.readFileSync(indexFile, "utf8")).entries || [];
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

async function waitForEntries(count, label) {
    const until = Date.now() + 120000;
    while (Date.now() < until) {
        const current = entries();
        if (current.length >= count) return current;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`${label}: cache entry was not created within 120 seconds.`);
}

function longText(label, salt) {
    return Array.from(
        { length: 420 },
        (_, index) =>
            `Reference ${label}-${salt}-${index}: amber cobalt violet zircon prism cadence archive lantern orchard compass. ` +
            `This numbered line is stable context for later turns and must not be modified.`
    ).join("\n");
}

function textPart(text) {
    return { parts: [{ text }], role: "user" };
}

async function generate(contents, label) {
    const response = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent`, {
        body: JSON.stringify({
            contents,
            generationConfig: {
                maxOutputTokens: 256,
                thinkingConfig: { includeThoughts: false, thinkingLevel: "LOW" },
            },
        }),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(180000),
    });
    const body = await response.json();
    if (!response.ok) {
        const status = body.error?.status || body.error?.code || "unknown";
        throw new Error(`${label}: HTTP ${response.status}, upstream status ${status}.`);
    }
    const modelMessage = body.candidates?.[0]?.content;
    const answer = modelMessage?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();
    if (!answer) {
        const candidate = body.candidates?.[0] || {};
        throw new Error(
            `${label}: no model reply; keys=${Object.keys(body).join(",")}, finish=${candidate.finishReason || "none"}, ` +
                `parts=${candidate.content?.parts?.length || 0}.`
        );
    }
    const usage = body.usageMetadata || {};
    const cached = Number(usage.cachedContentTokenCount || 0);
    const prompt = Number(usage.promptTokenCount || 0);
    console.log(`${label}: HTTP 200, promptTokens=${prompt}, cachedTokens=${cached}, reply=${answer.slice(0, 24)}`);
    return { cached, message: modelMessage, prompt };
}

async function main() {
    const ready = await fetch(`${baseUrl}/health/ready`);
    if (!ready.ok) throw new Error(`Local browser is not ready (HTTP ${ready.status}).`);
    const startingEntries = entries().length;
    const startingNames = new Set(entries().map(entry => entry.name));
    const salt = randomUUID().slice(0, 8);
    const aFirst = textPart(`${longText("A", salt)}\nReply exactly ALPHA.`);
    const bFirst = textPart(`${longText("B", salt)}\nReply exactly BETA.`);

    const a1 = await generate([aFirst], "A1 cold");
    const afterA1 = await waitForEntries(startingEntries + 1, "A1");
    const firstCache = afterA1.find(entry => !startingNames.has(entry.name) && entry.prefixLength === 1);
    if (!firstCache) throw new Error("A1 cache resource was not identified.");
    const aSecond = textPart("Reply exactly ALPHA again.");
    const a2 = await generate([aFirst, a1.message, aSecond], "A2 same session");
    if (a2.cached < 4096) throw new Error("A2 did not use its session cache.");

    const b1 = await generate([bFirst], "B1 other session");
    await waitForEntries(startingEntries + 2, "B1");
    const bSecond = textPart("Reply exactly BETA again.");
    const b2 = await generate([bFirst, b1.message, bSecond], "B2 same session");
    if (b2.cached < 4096) throw new Error("B2 did not use its session cache.");

    const aThird = textPart("Reply exactly ALPHA once more.");
    const a3 = await generate([aFirst, a1.message, aSecond, a2.message, aThird], "A3 revisit after B");
    if (a3.cached < 4096) throw new Error("A3 did not reuse the earlier session cache.");
    const deleted = await fetch(`${baseUrl}/v1beta/${firstCache.name}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        method: "DELETE",
        signal: AbortSignal.timeout(30000),
    });
    if (!deleted.ok) throw new Error(`Could not delete a test cache resource (HTTP ${deleted.status}).`);
    await generate(
        [aFirst, a1.message, textPart("Reply exactly ALPHA after stale cache fallback.")],
        "A4 stale resource fallback"
    );
    if (entries().some(entry => entry.name === firstCache.name)) {
        throw new Error("Rejected cache resource was not removed from the local index.");
    }
    console.log(`PASS multi-session cache reuse; activeEntries=${entries().length}`);
}

main().catch(error => {
    console.error(`FAIL local cache E2E: ${error.message}`);
    process.exitCode = 1;
});
