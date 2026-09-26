const test = require("node:test");
const assert = require("node:assert/strict");

const FormatConverter = require("../src/core/FormatConverter");
const RequestHandler = require("../src/core/RequestHandler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const converter = new FormatConverter(logger, { config: {} });

test("Responses usage forwards upstream cached input tokens", () => {
    const converted = converter.convertGoogleToResponseAPINonStream(
        {
            candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }],
            usageMetadata: {
                cachedContentTokenCount: 8,
                candidatesTokenCount: 2,
                promptTokenCount: 12,
                totalTokenCount: 14,
            },
        },
        "gemini-test"
    );
    assert.equal(converted.usage.input_tokens, 12);
    assert.equal(converted.usage.input_tokens_details.cached_tokens, 8);
    assert.equal(converted.usage.total_tokens, 14);
});

test("tool schemas omit unsupported JSON Schema keywords while preserving property names", () => {
    const schema = converter._convertSchemaToGemini({
        allOf: [
            { properties: { value: { default: "x", type: "string" } }, required: ["value"] },
            { properties: { default: { type: "boolean" } }, required: ["default"] },
        ],
        properties: {
            result: { oneOf: [{ type: "string" }, { type: "null" }] },
        },
        type: "object",
    });
    assert.deepEqual(schema.required, ["value", "default"]);
    assert.ok(schema.properties.default);
    assert.equal(schema.properties.value.default, undefined);
    assert.equal(schema.allOf, undefined);
    assert.equal(schema.properties.result.oneOf, undefined);
});

test("OpenAI tool outputs always become Gemini response objects", async () => {
    const { googleRequest } = await converter.translateOpenAIToGoogle({
        messages: [
            { content: "hello", role: "user" },
            { content: "42", name: "lookup", role: "tool", tool_call_id: "call-1" },
            { content: "[1,2]", name: "lookup", role: "tool", tool_call_id: "call-2" },
        ],
        model: "gemini-2.5-flash",
    });
    const responses = googleRequest.contents
        .flatMap(content => content.parts)
        .filter(part => part.functionResponse)
        .map(part => part.functionResponse.response);
    assert.deepEqual(responses, [{ result: 42 }, { result: "[1,2]" }]);
});

test("Responses API primitive function output becomes an object", async () => {
    const { googleRequest } = await converter.translateOpenAIResponseToGoogle({
        input: [{ call_id: "call-1", name: "lookup", output: "true", type: "function_call_output" }],
        model: "gemini-2.5-flash",
    });
    const response = googleRequest.contents.flatMap(content => content.parts).find(part => part.functionResponse)
        ?.functionResponse.response;
    assert.deepEqual(response, { result: true });
});

test("Gemini 3.8 Flash defaults to HIGH across Chat, Responses, and Claude requests", async () => {
    const chat = await converter.translateOpenAIToGoogle({
        messages: [{ content: "hello", role: "user" }],
        model: "gemini-3.8-flash",
    });
    const responses = await converter.translateOpenAIResponseToGoogle({
        input: "hello",
        model: "gemini-3.8-flash",
    });
    const claude = await converter.translateClaudeToGoogle({
        max_tokens: 100,
        messages: [{ content: "hello", role: "user" }],
        model: "gemini-3.8-flash",
    });
    for (const result of [chat, responses, claude]) {
        assert.equal(result.googleRequest.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    }
});

test("reasoning effort overrides the default, while the model suffix overrides effort", async () => {
    const chat = await converter.translateOpenAIToGoogle({
        messages: [{ content: "hello", role: "user" }],
        model: "gemini-3.8-flash",
        reasoning_effort: "medium",
    });
    assert.equal(chat.googleRequest.generationConfig.thinkingConfig.thinkingLevel, "MEDIUM");

    const responses = await converter.translateOpenAIResponseToGoogle({
        input: "hello",
        model: "gemini-3.8-flash",
        reasoning: { effort: "medium" },
    });
    assert.equal(responses.googleRequest.generationConfig.thinkingConfig.thinkingLevel, "MEDIUM");

    const suffix = await converter.translateOpenAIResponseToGoogle({
        input: "hello",
        model: "gemini-3.8-flash(low)-real",
        reasoning: { effort: "high" },
    });
    assert.equal(suffix.cleanModelName, "gemini-3.8-flash");
    assert.equal(suffix.modelStreamingMode, "real");
    assert.equal(suffix.googleRequest.generationConfig.thinkingConfig.thinkingLevel, "LOW");
});

test("Codex high efforts map to HIGH while explicit thought visibility is retained", async () => {
    for (const effort of ["high", "xhigh", "max", "ultra"]) {
        const response = await converter.translateOpenAIResponseToGoogle({
            input: "hello",
            model: "gemini-3.8-flash",
            reasoning: { effort },
        });
        assert.equal(response.googleRequest.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    }

    const chat = await converter.translateOpenAIToGoogle({
        extra_body: { thinkingConfig: { includeThoughts: false, thinkingLevel: "LOW" } },
        messages: [{ content: "hello", role: "user" }],
        model: "gemini-3.8-flash",
        reasoning_effort: "medium",
    });
    assert.deepEqual(chat.googleRequest.generationConfig.thinkingConfig, {
        includeThoughts: false,
        thinkingLevel: "MEDIUM",
    });
});

test("the HIGH default is limited to Gemini 3.8 Flash and unsupported levels fail clearly", async () => {
    const other = await converter.translateOpenAIResponseToGoogle({ input: "hello", model: "gemini-3.6-flash" });
    assert.equal(other.googleRequest.generationConfig.thinkingConfig, undefined);

    await assert.rejects(
        converter.translateOpenAIResponseToGoogle({
            input: "hello",
            model: "gemini-3.8-flash",
            reasoning: { effort: "minimal" },
        }),
        /does not support thinking level MINIMAL/
    );
    await assert.rejects(
        converter.translateOpenAIResponseToGoogle({
            input: "hello",
            model: "gemini-3.8-flash",
            reasoning: { effort: "none" },
        }),
        /Unsupported reasoning effort: none/
    );
});

test("native Gemini requests use the same default and preserve explicit settings", () => {
    const config = { safetySettingsThreshold: "OFF", streamingMode: "real" };
    const handler = new RequestHandler({ config }, {}, logger, {}, config, {});
    const build = (model, thinkingConfig) => {
        const body = { contents: [{ parts: [{ text: "hello" }], role: "user" }] };
        if (thinkingConfig) body.generationConfig = { thinkingConfig };
        const request = handler._buildProxyRequest(
            {
                body,
                headers: {},
                method: "POST",
                path: `/v1beta/models/${model}:generateContent`,
            },
            "test-request"
        );
        return { body: JSON.parse(request.body), path: request.path };
    };

    assert.equal(build("gemini-3.8-flash").body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    const explicit = build("gemini-3.8-flash", { includeThoughts: false, thinkingLevel: "MEDIUM" });
    assert.deepEqual(explicit.body.generationConfig.thinkingConfig, {
        includeThoughts: false,
        thinkingLevel: "MEDIUM",
    });
    const suffix = build("gemini-3.8-flash(low)", { thinkingLevel: "MEDIUM" });
    assert.equal(suffix.path, "/v1beta/models/gemini-3.8-flash:generateContent");
    assert.equal(suffix.body.generationConfig.thinkingConfig.thinkingLevel, "LOW");
});
