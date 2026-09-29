const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const { createModelAccessMiddleware } = require("../src/core/ModelAccessMiddleware");
const FormatConverter = require("../src/core/FormatConverter");
const ModelRoutes = require("../src/routes/ModelRoutes");

function createApp() {
    const app = express();
    const catalog = {
        resolveRequestModel(rawModel) {
            const models = {
                "gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
                "gemini-3.8-flash": "gemini-3.8-flash",
                short: "gemini-3.8-flash",
            };
            const match = String(rawModel).match(/^(?:models\/)?([\w.-]+?)(\((?:low|medium|high)\))?$/);
            if (!match || !models[match[1]]) return null;
            return { suffix: match[2] || "", upstreamId: models[match[1]] };
        },
    };
    app.use(express.json());
    app.use(createModelAccessMiddleware(catalog));
    app.use((req, res) => res.json({ body: req.body, path: req.path }));
    return app;
}

async function withServer(callback) {
    const server = http.createServer(createApp());
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        await callback(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test("disabled models are rejected even when a client names them directly", async () => {
    await withServer(async base => {
        const paths = ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/embeddings"];
        for (const path of paths) {
            const response = await fetch(`${base}${path}`, {
                body: JSON.stringify({ model: "disabled-model" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });
            assert.equal(response.status, 404, path);
            assert.equal((await response.json()).error.code, "model_not_found");
        }
        const native = await fetch(`${base}/v1beta/models/disabled-model:generateContent`, { method: "POST" });
        assert.equal(native.status, 404);
    });
});

test("an enabled alias resolves in both body and Gemini path", async () => {
    await withServer(async base => {
        const openai = await fetch(`${base}/v1/responses`, {
            body: JSON.stringify({ model: "short(low)" }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        assert.equal((await openai.json()).body.model, "gemini-3.8-flash(low)");

        const native = await fetch(`${base}/v1beta/models/short(low):generateContent`, { method: "POST" });
        assert.equal((await native.json()).path, "/v1beta/models/gemini-3.8-flash(low):generateContent");
    });
});

test("managed model policy selects only supported thinking levels", () => {
    const forced = FormatConverter.resolveThinkingConfig({
        managedPolicy: {
            capability: { kind: "level", levels: ["LOW", "MEDIUM", "HIGH"] },
            level: "MEDIUM",
            mode: "force",
        },
        modelName: "gemini-3.8-flash",
        modelThinkingLevel: "LOW",
        reasoningEffort: "high",
    });
    assert.equal(forced.thinkingLevel, "MEDIUM");

    assert.throws(
        () =>
            FormatConverter.resolveThinkingConfig({
                managedPolicy: {
                    capability: { kind: "level", levels: ["MINIMAL", "HIGH"] },
                    level: null,
                    mode: "respect_client",
                },
                modelName: "gemini-3.1-flash-lite-image",
                reasoningEffort: "medium",
            }),
        { code: "INVALID_THINKING_LEVEL" }
    );

    const budget = FormatConverter.resolveThinkingConfig({
        includeThoughtsWhenReasoning: true,
        managedPolicy: { capability: { kind: "budget", levels: [] }, level: null, mode: "respect_client" },
        modelName: "gemini-2.5-flash",
        reasoningEffort: "high",
        thinkingConfig: { thinkingBudget: 1024 },
    });
    assert.deepEqual(budget, { includeThoughts: true, thinkingBudget: 1024 });
});

test("an admin can probe a disabled candidate on a selected connected account", async () => {
    const recorded = [];
    const forwarded = [];
    const catalog = {
        getAdminState: () => ({ models: [{ enabled: false, id: "gemini-new", probeSupported: true }] }),
        recordProbe: async (...args) => recorded.push(args),
    };
    const system = {
        authSource: { getRotationIndices: () => [1, 2] },
        browserManager: { currentAuthIndex: 1 },
        config: { forceThinking: false },
        connectionRegistry: { getConnectionByAuth: index => (index === 2 ? { readyState: 1 } : null) },
        logger: { error() {} },
        modelCatalogStore: catalog,
        requestHandler: {
            cacheManager: {
                _resourceRequest: async (index, request) => forwarded.push({ index, request }),
            },
        },
    };
    const app = express();
    app.use(express.json());
    new ModelRoutes(system).setupRoutes(app, (_req, _res, next) => next());
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const response = await fetch(`${base}/api/models/gemini-new/probe`, {
            body: JSON.stringify({ authIndex: 2 }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, "available");
        assert.equal(forwarded[0].index, 2);
        assert.equal(forwarded[0].request.path, "/v1beta/models/gemini-new:generateContent");
        assert.deepEqual(recorded[0], ["gemini-new", "2", { status: "available" }]);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
