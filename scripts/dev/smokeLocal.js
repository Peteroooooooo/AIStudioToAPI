/**
 * A small end-to-end check against a locally running development server.
 * Reads the API key from the ignored .env.development file; never prints it.
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env.development") });

const args = process.argv.slice(2);
const option = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};
const model = option("--model") || "gemini-3.8-flash";
const effort = option("--effort");
const useResponses = args.includes("--responses");
const port = Number(process.env.PORT || 7860);
const baseUrl = `http://127.0.0.1:${port}`;
const apiKey = process.env.API_KEYS?.split(",")[0]?.trim();
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 130000);

if (!apiKey || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeoutMs)) {
    console.error("Local smoke check needs a valid API_KEYS and PORT in .env.development.");
    process.exit(2);
}

const requestJson = async (route, options = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...options.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    return { body, status: response.status };
};

const main = async () => {
    const ready = await requestJson("/health/ready");
    if (ready.status !== 200 || ready.body.ready !== true) {
        throw new Error(`Local browser is not ready (HTTP ${ready.status}).`);
    }

    const models = await requestJson("/v1/models");
    if (models.status !== 200 || !models.body.data?.some(item => item.id === model.replace(/\((.*?)\)$/, ""))) {
        throw new Error(`Model list did not contain ${model} (HTTP ${models.status}).`);
    }

    const prompt = "Reply with the single word OK.";
    const route = useResponses ? "/v1/responses" : "/v1/chat/completions";
    const payload = useResponses
        ? { input: prompt, max_output_tokens: 64, model, stream: false }
        : { max_tokens: 64, messages: [{ content: prompt, role: "user" }], model, stream: false };
    if (effort) {
        if (useResponses) payload.reasoning = { effort };
        else payload.reasoning_effort = effort;
    }

    const result = await requestJson(route, { body: JSON.stringify(payload), method: "POST" });
    if (result.status !== 200) {
        const message = result.body.error?.message || result.body.message || "Unknown API error";
        throw new Error(`${route} returned HTTP ${result.status}: ${String(message).slice(0, 240)}`);
    }
    const content = useResponses
        ? result.body.output_text ||
          result.body.output
              ?.flatMap(item => item.content || [])
              .map(item => item.text || "")
              .join("")
        : result.body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
        throw new Error(`${route} returned HTTP 200 without text output.`);
    }
    console.log(`PASS ${route}: model=${model}, output=${JSON.stringify(content.trim().slice(0, 120))}`);
};

main().catch(error => {
    console.error(`FAIL local smoke: ${error.message}`);
    process.exitCode = 1;
});
