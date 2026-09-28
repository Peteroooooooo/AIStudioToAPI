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

test("Responses allowed_tools preserves selected function schemas and maps auto/required modes", async () => {
    const spawnAgent = {
        description: "Start a child agent",
        name: "spawn_agent",
        parameters: {
            properties: { message: { type: "string" }, task_name: { type: "string" } },
            required: ["task_name", "message"],
            type: "object",
        },
        type: "function",
    };
    const otherTool = { name: "other_tool", parameters: { type: "object" }, type: "function" };

    for (const [mode, geminiMode] of [
        ["auto", "AUTO"],
        ["required", "ANY"],
    ]) {
        const { googleRequest } = await converter.translateOpenAIResponseToGoogle({
            input: "Delegate this task.",
            model: "gemini-3.8-flash",
            tool_choice: { mode, tools: [{ name: "spawn_agent", type: "function" }], type: "allowed_tools" },
            tools: [spawnAgent, otherTool],
        });

        assert.deepEqual(googleRequest.tools, [
            {
                functionDeclarations: [
                    {
                        description: "Start a child agent",
                        name: "spawn_agent",
                        parameters: {
                            properties: { message: { type: "STRING" }, task_name: { type: "STRING" } },
                            required: ["task_name", "message"],
                            type: "OBJECT",
                        },
                    },
                ],
            },
        ]);
        assert.deepEqual(googleRequest.toolConfig, { functionCallingConfig: { mode: geminiMode } });
    }
});

test("Responses namespace functions round-trip through Gemini and full-history tool output", async () => {
    const tools = [
        {
            description: "Coordinate child agents",
            name: "collaboration",
            tools: [
                {
                    description: "Start a child agent",
                    name: "spawn_agent",
                    parameters: {
                        properties: { message: { encrypted: true, type: "string" }, task_name: { type: "string" } },
                        required: ["task_name", "message"],
                        type: "object",
                    },
                    type: "function",
                },
                { name: "wait_agent", parameters: { type: "object" }, type: "function" },
            ],
            type: "namespace",
        },
    ];
    const { googleRequest } = await converter.translateOpenAIResponseToGoogle({
        input: "Start an agent.",
        model: "gemini-3.8-flash",
        tool_choice: "auto",
        tools,
    });
    assert.deepEqual(
        googleRequest.tools[0].functionDeclarations.map(tool => tool.name),
        ["collaboration__spawn_agent", "collaboration__wait_agent"]
    );
    assert.deepEqual(googleRequest.tools[0].functionDeclarations[0].parameters, {
        properties: { message: { type: "STRING" }, task_name: { type: "STRING" } },
        required: ["task_name", "message"],
        type: "OBJECT",
    });
    const selected = await converter.translateOpenAIResponseToGoogle({
        input: "Start an agent.",
        model: "gemini-3.8-flash",
        tool_choice: {
            mode: "required",
            tools: [{ name: "spawn_agent", namespace: "collaboration", type: "function" }],
            type: "allowed_tools",
        },
        tools,
    });
    assert.deepEqual(
        selected.googleRequest.tools[0].functionDeclarations.map(tool => tool.name),
        ["collaboration__spawn_agent"]
    );
    assert.deepEqual(selected.googleRequest.toolConfig, { functionCallingConfig: { mode: "ANY" } });

    const googleResponse = {
        candidates: [
            {
                content: {
                    parts: [
                        {
                            functionCall: {
                                args: { message: "Investigate", task_name: "probe" },
                                name: "collaboration__spawn_agent",
                            },
                        },
                    ],
                    role: "model",
                },
                finishReason: "STOP",
            },
        ],
    };
    const nonStream = converter.convertGoogleToResponseAPINonStream(googleResponse, "gemini-3.8-flash", { tools });
    const functionCall = nonStream.output.find(item => item.type === "function_call");
    assert.equal(functionCall.name, "spawn_agent");
    assert.equal(functionCall.namespace, "collaboration");

    const streamState = { responseDefaults: { tools } };
    const events = converter.translateGoogleToResponseAPIStream(
        JSON.stringify(googleResponse),
        "gemini-3.8-flash",
        streamState
    );
    const doneItem = events
        .split("\n\n")
        .filter(Boolean)
        .map(frame => JSON.parse(frame.split("\ndata: ")[1]))
        .find(event => event.type === "response.output_item.done" && event.item.type === "function_call");
    assert.equal(doneItem.item.name, "spawn_agent");
    assert.equal(doneItem.item.namespace, "collaboration");

    const continuation = await converter.translateOpenAIResponseToGoogle({
        input: [
            {
                arguments: functionCall.arguments,
                call_id: functionCall.call_id,
                name: functionCall.name,
                namespace: functionCall.namespace,
                type: "function_call",
            },
            { call_id: functionCall.call_id, output: "OK", type: "function_call_output" },
        ],
        model: "gemini-3.8-flash",
        tools,
    });
    assert.equal(continuation.googleRequest.contents[0].parts[0].functionCall.name, "collaboration__spawn_agent");
    assert.equal(continuation.googleRequest.contents[1].parts[0].functionResponse.name, "collaboration__spawn_agent");
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

test("the saved Gemini 3.8 Flash level overrides every request format and updates immediately", async () => {
    const config = { gemini38FlashThinkingLevel: "LOW", safetySettingsThreshold: "OFF", streamingMode: "real" };
    const forcedConverter = new FormatConverter(logger, { config });
    const handler = new RequestHandler({ config }, {}, logger, {}, config, {});

    for (const level of ["LOW", "MEDIUM", "HIGH"]) {
        config.gemini38FlashThinkingLevel = level;
        const chat = await forcedConverter.translateOpenAIToGoogle({
            extra_body: { thinkingConfig: { includeThoughts: false, thinkingLevel: "HIGH" } },
            messages: [{ content: "hello", role: "user" }],
            model: "gemini-3.8-flash(minimal)",
            reasoning_effort: "unsupported",
        });
        assert.deepEqual(chat.googleRequest.generationConfig.thinkingConfig, {
            includeThoughts: false,
            thinkingLevel: level,
        });

        const responses = await forcedConverter.translateOpenAIResponseToGoogle({
            input: "hello",
            model: "gemini-3.8-flash(low)",
            reasoning: { effort: "minimal" },
        });
        assert.equal(responses.googleRequest.generationConfig.thinkingConfig.thinkingLevel, level);

        const claude = await forcedConverter.translateClaudeToGoogle({
            max_tokens: 100,
            messages: [{ content: "hello", role: "user" }],
            model: "gemini-3.8-flash(high)",
            thinking: { type: "enabled" },
        });
        assert.equal(claude.googleRequest.generationConfig.thinkingConfig.thinkingLevel, level);

        for (const [path, expectedPath] of [
            ["/v1beta/models/gemini-3.8-flash(low):generateContent", "/v1beta/models/gemini-3.8-flash:generateContent"],
            ["/v1/models/gemini-3.8-flash:streamGenerateContent", "/v1/models/gemini-3.8-flash:streamGenerateContent"],
        ]) {
            const native = handler._buildProxyRequest(
                {
                    body: {
                        contents: [{ parts: [{ text: "hello" }], role: "user" }],
                        generationConfig: {
                            thinkingConfig: { includeThoughts: false, thinkingBudget: 1000, thinkingLevel: "HIGH" },
                        },
                    },
                    headers: {},
                    method: "POST",
                    path,
                },
                "test-request"
            );
            assert.equal(native.path, expectedPath);
            assert.deepEqual(JSON.parse(native.body).generationConfig.thinkingConfig, {
                includeThoughts: false,
                thinkingLevel: level,
            });
        }
    }

    const other = await forcedConverter.translateOpenAIResponseToGoogle({
        input: "hello",
        model: "gemini-3.6-flash(low)",
        reasoning: { effort: "high" },
    });
    assert.equal(other.googleRequest.generationConfig.thinkingConfig.thinkingLevel, "LOW");
});
