/** A real local file tool. Only this generated fixture can be read. */
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const declaration = {
    description: "Read the verification token from a fixture on the operator's local computer.",
    name: "read_local_probe",
    parameters: {
        properties: { id: { enum: ["probe"], type: "string" } },
        required: ["id"],
        type: "object",
    },
};
const prompt =
    'Call read_local_probe with id="probe". You do not know the token. After receiving the tool result, reply with that exact token only.';

async function createProbe(directory, label) {
    await fs.mkdir(directory, { recursive: true });
    const fixture = path.join(directory, `${label}-${crypto.randomUUID()}.json`);
    await fs.writeFile(fixture, JSON.stringify({ token: `LOCAL_${crypto.randomBytes(16).toString("hex")}` }), {
        mode: 0o600,
    });
    let executions = 0;
    return {
        async close() {
            await fs.unlink(fixture);
        },
        async execute(call) {
            if (call.name !== declaration.name || call.args?.id !== "probe") {
                throw new Error("The model did not request the permitted local fixture tool.");
            }
            executions++;
            return JSON.parse(await fs.readFile(fixture, "utf8"));
        },
        get executions() {
            return executions;
        },
        async verify(text) {
            const value = JSON.parse(await fs.readFile(fixture, "utf8"));
            return executions > 0 && String(text).trim() === value.token;
        },
    };
}

async function runGeminiRoundTrip(generate, probe, model) {
    const body = {
        contents: [{ parts: [{ text: prompt }], role: "user" }],
        generationConfig: { maxOutputTokens: 1024 },
        toolConfig: { functionCallingConfig: { allowedFunctionNames: [declaration.name], mode: "ANY" } },
        tools: [{ functionDeclarations: [declaration] }],
    };
    const first = await generate(body, model);
    if (first.status !== 200)
        return {
            error: first.error,
            http: first.status,
            localExecutions: probe.executions,
            passed: false,
            stage: "first_generation",
        };
    const modelContent = first.body?.candidates?.[0]?.content;
    const call = modelContent?.parts?.find(part => part.functionCall)?.functionCall;
    if (!call) return { error: "No functionCall returned.", nativeToolCall: false, stage: "first_generation" };
    const result = await probe.execute(call);
    const second = await generate(
        {
            ...body,
            contents: [
                ...body.contents,
                modelContent,
                {
                    parts: [
                        {
                            functionResponse: {
                                name: call.name,
                                response: result,
                                ...(call.id ? { id: call.id } : {}),
                            },
                        },
                    ],
                    role: "user",
                },
            ],
            toolConfig: { functionCallingConfig: { mode: "NONE" } },
        },
        model
    );
    const answer = second.body?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    return {
        error: second.error,
        http: second.status,
        localExecutions: probe.executions,
        nativeToolCall: true,
        passed: second.status === 200 && (await probe.verify(answer)),
        stage: "tool_result_generation",
    };
}

module.exports = { createProbe, declaration, prompt, runGeminiRoundTrip };
