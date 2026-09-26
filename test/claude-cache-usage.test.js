const test = require("node:test");
const assert = require("node:assert/strict");

const FormatConverter = require("../src/core/FormatConverter");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const converter = new FormatConverter(logger, { config: {} });

function parseEvents(sse) {
    return sse
        .trim()
        .split("\n\n")
        .map(event => JSON.parse(event.split("\ndata: ")[1]));
}

test("Claude non-stream usage separates cached input from uncached input", () => {
    const response = converter.convertGoogleToClaudeNonStream({
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: {
            cachedContentTokenCount: 80,
            candidatesTokenCount: 3,
            promptTokenCount: 100,
            thoughtsTokenCount: 2,
            toolUsePromptTokenCount: 5,
        },
    });

    assert.deepEqual(response.usage, {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 80,
        input_tokens: 25,
        output_tokens: 5,
    });
});

test("Claude no-candidate response still reports cache usage", () => {
    const response = converter.convertGoogleToClaudeNonStream({
        usageMetadata: { cachedContentTokenCount: 8, promptTokenCount: 10 },
    });
    assert.equal(response.usage.cache_read_input_tokens, 8);
    assert.equal(response.usage.input_tokens, 2);
});

test("Claude stream reports cache usage in start and final delta when present in first chunk", () => {
    const state = {};
    const events = parseEvents(
        converter.translateGoogleToClaudeStream(
            JSON.stringify({
                candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                usageMetadata: {
                    cachedContentTokenCount: 80,
                    candidatesTokenCount: 3,
                    promptTokenCount: 100,
                    thoughtsTokenCount: 2,
                },
            }),
            "gemini-test",
            state
        )
    );

    const start = events.find(event => event.type === "message_start");
    const final = events.find(event => event.type === "message_delta");
    assert.equal(start.message.usage.input_tokens, 20);
    assert.equal(start.message.usage.cache_read_input_tokens, 80);
    assert.deepEqual(final.usage, {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 80,
        input_tokens: 20,
        output_tokens: 5,
    });
});

test("Claude stream includes late cache usage in the final delta", () => {
    const state = {};
    const first = parseEvents(
        converter.translateGoogleToClaudeStream(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
            "gemini-test",
            state
        )
    );
    assert.equal(first.find(event => event.type === "message_start").message.usage.cache_read_input_tokens, 0);

    const last = parseEvents(
        converter.translateGoogleToClaudeStream(
            JSON.stringify({
                candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
                usageMetadata: { cachedContentTokenCount: 80, candidatesTokenCount: 3, promptTokenCount: 100 },
            }),
            "gemini-test",
            state
        )
    );
    const final = last.find(event => event.type === "message_delta");
    assert.equal(final.usage.cache_read_input_tokens, 80);
    assert.equal(final.usage.input_tokens, 20);
    assert.equal(final.usage.output_tokens, 3);
});
