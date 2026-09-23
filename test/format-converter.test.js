const test = require("node:test");
const assert = require("node:assert/strict");

const FormatConverter = require("../src/core/FormatConverter");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const converter = new FormatConverter(logger, { config: {} });

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
