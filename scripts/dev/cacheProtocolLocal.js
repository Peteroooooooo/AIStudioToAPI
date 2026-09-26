/**
 * Live cache check for the local Responses and Claude-compatible endpoints.
 * Run with `node scripts/dev/cacheProtocolLocal.js` while the local fork is ready.
 * Credentials and conversation content stay in memory; only counts are printed.
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const dataDir = path.resolve(__dirname, "../../data");
const startup = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).startup;
const apiKey = startup.apiKeys?.[0];
const baseUrl = `http://127.0.0.1:${startup.httpPort}`;
const indexFile = path.join(dataDir, "gemini-cache-index.json");
const usageFile = path.join(dataDir, "usage-stats.jsonl");
const model = "gemini-3.8-flash(low)";

if (!apiKey) throw new Error("A local API key is required in data/config.json.");

function cacheEntries() {
    try {
        return JSON.parse(fs.readFileSync(indexFile, "utf8")).entries || [];
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

function usageRecords() {
    try {
        return fs
            .readFileSync(usageFile, "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line));
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

async function waitForNewEntry(previousNames, label) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        const added = cacheEntries().filter(entry => !previousNames.has(entry.name));
        if (added.length) return added[0];
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`${label}: no new Gemini cache resource was indexed within 120 seconds.`);
}

async function waitForUsage(afterSequence, format, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const record = usageRecords().findLast(
            item => item.sequence > afterSequence && item.apiFormat === format && item.requestCategory === "generation"
        );
        if (record) return record;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${label}: request usage record was not written within 15 seconds.`);
}

function lastSequence() {
    return usageRecords().at(-1)?.sequence || 0;
}

function longText(label, salt) {
    return Array.from(
        { length: 420 },
        (_, index) =>
            `Reference ${label}-${salt}-${index}: amber cobalt violet zircon prism cadence archive lantern orchard compass. ` +
            "This numbered line is stable context for later turns and must not be modified."
    ).join("\n");
}

async function send(pathname, body, format, label) {
    const beforeSequence = lastSequence();
    const response = await fetch(`${baseUrl}${pathname}`, {
        body: JSON.stringify(body),
        headers: {
            "anthropic-version": "2023-06-01",
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(180000),
    });
    const result = await response.json();
    if (!response.ok) {
        const code = result.error?.type || result.error?.code || result.error?.status || "unknown";
        throw new Error(`${label}: HTTP ${response.status}, error code ${code}.`);
    }
    const record = await waitForUsage(beforeSequence, format, label);
    const cached = record.tokenUsage?.cachedInputTokens ?? null;
    const input = record.tokenUsage?.inputTokens ?? null;
    console.log(`${label}: HTTP ${response.status}, inputTokens=${input}, cachedTokens=${cached}`);
    return { record, result };
}

async function responsesTurn(input, label) {
    const { result, record } = await send(
        "/v1/responses",
        { input, max_output_tokens: 512, model, reasoning: { effort: "low" }, stream: false },
        "response_api",
        label
    );
    const answer = result.output
        ?.flatMap(item => item.content || [])
        .filter(item => item.type === "output_text")
        .map(item => item.text || "")
        .join("")
        .trim();
    if (!answer) throw new Error(`${label}: Responses returned no answer text.`);
    const clientCached = result.usage?.input_tokens_details?.cached_tokens;
    const upstreamCached = record.tokenUsage?.cachedInputTokens ?? null;
    if (upstreamCached !== null && clientCached !== upstreamCached) {
        throw new Error(`${label}: Responses cached token usage disagrees with upstream tracking.`);
    }
    return { answer, cached: upstreamCached };
}

async function claudeTurn(messages, label) {
    const { result, record } = await send(
        "/v1/messages",
        { max_tokens: 512, messages, model, stream: false },
        "claude",
        label
    );
    const answer = result.content
        ?.filter(item => item.type === "text")
        .map(item => item.text || "")
        .join("")
        .trim();
    if (!answer) throw new Error(`${label}: Claude protocol returned no answer text.`);
    const upstreamInput = record.tokenUsage?.inputTokens ?? null;
    const upstreamCached = record.tokenUsage?.cachedInputTokens ?? 0;
    if (
        result.usage?.cache_read_input_tokens !== upstreamCached ||
        (upstreamInput !== null && result.usage.input_tokens + upstreamCached !== upstreamInput)
    ) {
        throw new Error(`${label}: Claude cache token usage disagrees with upstream tracking.`);
    }
    return { answer, cached: record.tokenUsage?.cachedInputTokens ?? null };
}

async function main() {
    const ready = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(15000) });
    if (!ready.ok) throw new Error(`Local fork is not ready (HTTP ${ready.status}).`);
    const salt = randomUUID().slice(0, 8);

    const responsesFirstMessage = { content: `${longText("R", salt)}\nReply exactly ALPHA.`, role: "user" };
    const rNames = new Set(cacheEntries().map(entry => entry.name));
    const r1 = await responsesTurn([responsesFirstMessage], "Responses cold");
    await waitForNewEntry(rNames, "Responses cold");
    const r2 = await responsesTurn(
        [
            responsesFirstMessage,
            { content: r1.answer, role: "assistant" },
            { content: "Reply exactly ALPHA again.", role: "user" },
        ],
        "Responses second turn"
    );
    if (r2.cached < 4096) throw new Error("Responses second turn did not reuse its Gemini cached prefix.");

    const claudeFirstMessage = { content: `${longText("C", salt)}\nReply exactly BETA.`, role: "user" };
    const cNames = new Set(cacheEntries().map(entry => entry.name));
    const c1 = await claudeTurn([claudeFirstMessage], "Claude cold");
    await waitForNewEntry(cNames, "Claude cold");
    const c2 = await claudeTurn(
        [
            claudeFirstMessage,
            { content: c1.answer, role: "assistant" },
            { content: "Reply exactly BETA again.", role: "user" },
        ],
        "Claude second turn"
    );
    if (c2.cached < 4096) throw new Error("Claude second turn did not reuse its Gemini cached prefix.");

    const r3 = await responsesTurn(
        [
            responsesFirstMessage,
            { content: r1.answer, role: "assistant" },
            { content: "Reply exactly ALPHA after the other session.", role: "user" },
        ],
        "Responses revisit after Claude"
    );
    if (r3.cached < 4096) throw new Error("Responses session did not reuse its cache after the Claude session.");
    console.log("PASS Responses and Claude protocol multi-turn, multi-session cache reuse.");
}

main().catch(error => {
    console.error(`FAIL protocol cache E2E: ${error.message}`);
    process.exitCode = 1;
});
