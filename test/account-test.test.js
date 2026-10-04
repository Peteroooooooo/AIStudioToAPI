const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AccountTestService = require("../src/core/AccountTestService");
const AccountScheduler = require("../src/core/AccountScheduler");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const UsageStatsService = require("../src/core/UsageStatsService");
const StatusRoutes = require("../src/routes/StatusRoutes");
const AccountHealth = require("../src/auth/AccountHealth");
const ProxyServerSystem = require("../src/core/ProxyServerSystem");
const RequestHandler = require("../src/core/RequestHandler");
const FormatConverter = require("../src/core/FormatConverter");
const testDirectories = [];
const testUsages = [];
test.after(async () => {
    await Promise.all(testUsages.map(usage => usage.appendPromise));
    for (const directory of testDirectories) fs.rmSync(directory, { force: true, recursive: true });
});

function fixture() {
    const logger = { debug() {}, error() {}, info() {}, warn() {} };
    const healthy = new Set([1, 2, 3]);
    const ready = new Set([1, 2]);
    const modes = new Map();
    const auth = {
        accountNameMap: new Map([
            [1, "one@example.com"],
            [2, "two@example.com"],
            [3, "three@example.com"],
        ]),
        availableIndices: [1, 2, 3],
        getRotationIndices: () => [...healthy],
        health: {
            getEpoch: () => 0,
            getStatus: index => ({ mode: modes.get(index) || "active" }),
            isAvailable: index => healthy.has(index),
            releaseProbe() {},
            tryAcquireProbe: () => true,
        },
        isExpired: () => false,
        pendingRefreshIndices: new Set(),
    };
    const browserManager = {
        contexts: new Map(),
        ensureAccountPoolReady: async () => {},
        getReadyAccountIndices: () => [...ready],
        initializingContexts: new Set(),
        isAccountReady: index => ready.has(index),
        notifyAccountIdle() {},
        withAccountTestConnection: async (index, callback) => callback(),
    };
    const registry = new ConnectionRegistry(
        logger,
        null,
        () => 1,
        browserManager,
        () => 0
    );
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-account-test-"));
    testDirectories.push(dataDir);
    const usage = new UsageStatsService(auth, logger, dataDir, true);
    testUsages.push(usage);
    registry.on("backendChunk", ({ requestId, requestAttemptId, data }) =>
        usage.recordBackendChunk(requestId, requestAttemptId, data)
    );
    registry.on("backendAttemptEvent", event => usage.recordBackendAttemptEvent(event));
    const sent = [],
        cancelled = [],
        outcomes = [];
    registry.on("backendOutcome", event => outcomes.push(event));
    let messages = [
        { event_type: "response_headers", status: 200 },
        {
            data: JSON.stringify({
                candidates: [{ content: { parts: [{ text: "OK" }] } }],
                usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 5, totalTokenCount: 6 },
            }),
            event_type: "chunk",
        },
        { event_type: "stream_close" },
    ];
    for (const index of auth.availableIndices) registry.connectionsByAuth.set(index, { readyState: 1 });
    let id = 0,
        epoch = 0;
    const handler = {
        _cancelBrowserRequest: (...args) => cancelled.push(args),
        _forwardRequest: (proxy, index) => {
            sent.push({ index, proxy });
            registry.markRequestDispatched(proxy.request_id, index, proxy.request_attempt_id);
            usage.recordAttempt(proxy.request_id, index, auth.accountNameMap.get(index), proxy.request_attempt_id);
            for (const message of messages)
                registry._handleIncomingMessage(
                    JSON.stringify({
                        ...message,
                        request_attempt_id: proxy.request_attempt_id,
                        request_id: proxy.request_id,
                    }),
                    index
                );
        },
        _generateRequestId: () => `req_${++id}`,
        _initializeProxyRequestAttempt: proxy => {
            proxy.request_attempt_id = `${proxy.request_id}_attempt_1`;
        },
        authSource: auth,
        browserManager,
        connectionRegistry: registry,
        logger,
        timeouts: { FAKE_STREAM: 100 },
    };
    handler.accountScheduler = new AccountScheduler(handler);
    const system = {
        authSource: auth,
        browserManager,
        config: { forceThinking: false },
        connectionRegistry: registry,
        getAuthCredentialEpoch: () => epoch,
        logger,
        modelCatalogStore: {
            getAdminState: () => ({ models: [{ enabled: true, id: "gemini-test", probeSupported: true }] }),
            getEffectiveThinkingPolicy: () => null,
        },
        requestHandler: handler,
        usageStatsService: usage,
    };
    const service = new AccountTestService(system);
    handler.config = system.config;
    handler.formatConverter = new FormatConverter(logger, system);
    handler.createOpenAIProxyRequest = RequestHandler.prototype.createOpenAIProxyRequest;
    service.requestTimeoutMs = 25;
    return {
        auth,
        browserManager,
        cancelled,
        handler,
        healthy,
        modes,
        outcomes,
        ready,
        registry,
        sent,
        service,
        setEpoch: value => {
            epoch = value;
        },
        setMessages: value => {
            messages = value;
        },
        system,
        usage,
    };
}

test("account test uses exactly the selected account and logs one actual attempt and tokens", async () => {
    const f = fixture();
    const result = await f.service.test(2, "gemini-test");
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(result.responseText, "OK");
    assert.equal(result.upstreamStatusCode, 200);
    assert.deepEqual(
        f.sent.map(item => item.index),
        [2]
    );
    const record = f.usage.getRequest(result.requestId);
    assert.equal(record.requestCategory, "account_test");
    assert.equal(record.attemptCount, 1);
    assert.equal(record.finalAuthIndex, 2);
    assert.equal(record.attempts[0].outcome, "success");
    assert.equal(record.tokenUsage.totalTokens, 6);
    assert.equal(f.registry.messageQueues.size, 0);
    assert.equal(f.handler.accountScheduler.requests.size, 0);
    assert.equal(f.handler.accountScheduler.owners.size, 0);
});

test("429 on the selected account fails without a second account attempt", async () => {
    const f = fixture();
    f.setMessages([{ event_type: "error", message: "Quota exceeded.", status: 429, upstream_status: 429 }]);
    const result = await f.service.test(2, "gemini-test");
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "rate_limited");
    assert.equal(result.upstreamStatusCode, 429);
    assert.equal(result.error, "Quota exceeded.");
    assert.deepEqual(
        f.sent.map(item => item.index),
        [2]
    );
    assert.equal(f.usage.getRequest(result.requestId).attempts[0].statusCode, 429);
});

test("account tests use the downstream converter, thinking policy, tools and runtime timeout", async () => {
    const f = fixture();
    f.system.config.forceThinking = true;
    f.system.config.forceWebSearch = true;
    f.system.config.forceUrlContext = true;
    f.system.modelCatalogStore.getEffectiveThinkingPolicy = () => ({ thinkingLevel: "HIGH" });
    f.system.modelCatalogStore.getAdminState = () => ({
        models: [{ enabled: true, id: "gemini-3.8-flash", probeSupported: true }],
    });
    delete f.service._requestTimeoutMs;
    f.handler.timeouts.FAKE_STREAM = 90000;
    const result = await f.service.test(2, "gemini-3.8-flash");
    const { proxyRequest: normal } = await f.handler.createOpenAIProxyRequest(
        {
            messages: [{ content: "Reply with OK only.", role: "user" }],
            model: "gemini-3.8-flash",
            stream: false,
        },
        "normal"
    );
    assert.equal(result.status, "success");
    assert.equal(result.requestTimeoutMs, 90000);
    assert.deepEqual(JSON.parse(f.sent[0].proxy.body), JSON.parse(normal.body));
    assert.equal(f.sent[0].proxy.is_generative, true);
    assert.equal(f.sent[0].proxy.path, normal.path);
    assert.equal(JSON.parse(normal.body).generationConfig.maxOutputTokens, undefined);
    assert.deepEqual(JSON.parse(normal.body).tools, [{ googleSearch: {} }, { urlContext: {} }]);
    f.handler.timeouts.FAKE_STREAM = 60000;
    assert.equal(f.service.requestTimeoutMs, 60000);
});

test("a model exhausting its output budget is reported distinctly from an empty response", async () => {
    const f = fixture();
    f.setMessages([
        { event_type: "response_headers", status: 200 },
        {
            data: JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }),
            event_type: "chunk",
        },
        { event_type: "stream_close" },
    ]);
    const result = await f.service.test(1, "gemini-test");
    assert.equal(result.reason, "output_limit");
    assert.equal(result.upstreamStatusCode, 200);
    assert.equal(f.service.running.size, 0);
});

test("empty or thought-only output is not reported as generation success", async () => {
    const f = fixture();
    f.setMessages([
        { event_type: "response_headers", status: 200 },
        {
            data: JSON.stringify({ candidates: [{ content: { parts: [{ text: "thought", thought: true }] } }] }),
            event_type: "chunk",
        },
        { event_type: "stream_close" },
    ]);
    const result = await f.service.test(1, "gemini-test");
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "empty_response");
    assert.equal(result.upstreamStatusCode, 200);
});

test("a silent connected browser times out, cancels and releases its slot", async () => {
    const f = fixture();
    f.setMessages([]);
    const result = await f.service.test(2, "gemini-test");
    assert.equal(result.reason, "request_timeout");
    assert.equal(result.status, "failed");
    assert.equal(f.cancelled[0][1], 2);
    assert.equal(f.registry.messageQueues.size, 0);
    assert.equal(f.handler.accountScheduler.requests.size, 0);
    assert.equal(f.outcomes[0].authIndex, 2);
    assert.equal(f.outcomes[0].transportFailure, true);
    assert.equal(f.usage.getRequest(result.requestId).attempts[0].localStatusCode, 504);
});

test("disabled, expired, cooling or busy accounts are refused without sending a request", async () => {
    const cases = [
        ["disabled", f => f.modes.set(1, "disabled")],
        [
            "needs_login",
            f => {
                f.auth.isExpired = () => true;
            },
        ],
        ["disabled", f => f.healthy.delete(1)],
        ["busy", f => f.browserManager.initializingContexts.add(1)],
    ];
    for (const [reason, prepare] of cases) {
        const f = fixture();
        prepare(f);
        const result = await f.service.test(1, "gemini-test");
        assert.equal(result.status, "not_tested");
        assert.equal(result.reason, reason);
        assert.equal(f.sent.length, 0);
    }
});

test("cancelled generation is not a health failure and cannot leave a test running", async () => {
    const f = fixture();
    f.setMessages([]);
    const controller = new AbortController();
    const pending = f.service.test(1, "gemini-test", { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    const result = await pending;
    assert.equal(result.status, "not_tested");
    assert.equal(result.reason, "cancelled");
    assert.equal(f.outcomes.length, 0);
    assert.equal(f.service.running.size, 0);
    assert.equal(f.registry.messageQueues.size, 0);
    assert.equal(f.handler.accountScheduler.requests.size, 0);
});

test("credential replacement invalidates the last test and in-progress result", async () => {
    const f = fixture();
    await f.service.test(1, "gemini-test");
    assert.equal(f.service.getResult(1).status, "success");
    f.setEpoch(1);
    assert.equal(f.service.getResult(1), null);
    f.browserManager.withAccountTestConnection = async (_index, callback) => {
        const result = await callback();
        f.setEpoch(2);
        return result;
    };
    assert.equal((await f.service.test(1, "gemini-test")).reason, "credentials_changed");
    assert.equal(f.service.getResult(1), null);
});

test("a pinned test can use a temporary connection that ordinary scheduling cannot select", async () => {
    const f = fixture();
    assert.equal(f.handler.accountScheduler.isAccountAvailable(3), false);
    assert.equal((await f.service.test(3, "gemini-test")).status, "success");
    assert.equal(f.sent[0].index, 3);
    assert.deepEqual(f.browserManager.getReadyAccountIndices(), [1, 2]);
});

test("a queued pinned test is rejected if its account disappears, without migration", async () => {
    const f = fixture();
    const first = { is_generative: false, request_id: "first" };
    await f.handler.accountScheduler.acquirePinned(first, 2);
    const pending = f.handler.accountScheduler.acquirePinned({ is_generative: false, request_id: "second" }, 2);
    f.healthy.delete(2);
    f.handler.accountScheduler._pump();
    await assert.rejects(pending, /not moved/);
    f.handler.accountScheduler.release("first");
    assert.equal(f.handler.accountScheduler.requests.size, 0);
});

test("account test route requires console authentication", async () => {
    const f = fixture();
    const app = express();
    app.use(express.json());
    new StatusRoutes(f.system).setupRoutes(app, (_req, res) => res.status(401).json({ error: "Sign in." }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/accounts/1/test`, {
            body: JSON.stringify({ model: "gemini-test" }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        assert.equal(response.status, 401);
        assert.equal(f.sent.length, 0);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

function recoveryFixture() {
    const f = fixture();
    f.auth.rotationIndices = [1, 2, 3];
    f.auth.health = new AccountHealth(f.system.logger, path.join(f.usage.dataDir, "health.json"));
    f.auth.getRotationIndices = () => f.auth.rotationIndices.filter(index => f.auth.health.isAvailable(index));
    f.browserManager.rebalanceContextPool = async () => {};
    f.registry.on("backendOutcome", outcome =>
        ProxyServerSystem.prototype._recordBackendOutcome.call(f.system, outcome)
    );
    return f;
}

test("manual test on an automatically stopped account stays isolated and preserves its switch", async () => {
    const f = recoveryFixture();
    f.auth.health.recordFailure(2, 429, "quota", undefined, { model: "gemini-test" });
    f.browserManager.withAccountTestConnection = async (index, callback) => {
        assert.equal(f.auth.health.getStatus(index).mode, "disabled");
        assert.equal(f.handler.accountScheduler.isAccountAvailable(index), false);
        assert.equal(f.auth.getRotationIndices().includes(index), false);
        return callback();
    };
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(result.recovered, false);
    assert.equal(f.auth.health.isAvailable(2), false);
    assert.equal(f.auth.health.manualProbes.size, 0);
    assert.deepEqual(
        f.sent.map(item => item.index),
        [2]
    );
});

test("local test timeout after fresh Google progress preserves upstream status and account health", async () => {
    const f = recoveryFixture();
    f.handler.timeouts.STREAM_CHUNK = 1000;
    f.setMessages([{ event_type: "response_headers", status: 200 }]);
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "request_timeout");
    assert.equal(result.upstreamStatusCode, 200);
    assert.equal(result.transportFailure, false);
    assert.ok(result.requestDurationMs >= 20);
    assert.equal(f.auth.health.getStatus(2).mode, "active");
    assert.equal(f.auth.health.getStatus(2).consecutiveFailures, 0);
    assert.equal(f.auth.health.manualProbes.size, 0);
    assert.equal(f.registry.messageQueues.size, 0);
    assert.equal(f.handler.accountScheduler.requests.size, 0);
});

test("an unresponsive temporary Preview reports authorization evidence without cooling the serving account", async () => {
    const f = recoveryFixture();
    f.setMessages([]);
    f.browserManager.withAccountTestConnection = async (_index, callback) =>
        callback({ previewAuth: { status: 401 }, temporary: true });
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "preview_auth_failed");
    assert.match(result.error, /GenerateAccessToken returned HTTP 401/);
    assert.equal(result.upstreamStatusCode, null);
    assert.equal(result.connectionMode, "temporary");
    assert.equal(result.transportFailure, false);
    assert.equal(f.auth.health.getStatus(2).mode, "active");
    assert.equal(f.auth.health.getStatus(2).consecutiveFailures, 0);
    assert.equal(f.registry.messageQueues.size, 0);
    assert.equal(f.handler.accountScheduler.requests.size, 0);
});

test("an auxiliary Preview authorization error cannot reject an actual successful generation", async () => {
    const f = recoveryFixture();
    f.browserManager.withAccountTestConnection = async (_index, callback) =>
        callback({ previewAuth: { status: 401 }, temporary: true });
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(result.status, "success");
    assert.equal(result.responseText, "OK");
    assert.equal(result.recovered, true);
});

test("repeated manual 429 updates failure history without extending the cooldown", async () => {
    const f = recoveryFixture();
    f.auth.health.recordFailure(2, 429, "quota", undefined, { model: "gemini-test" });
    const until = f.auth.health.getStatus(2).until;
    f.setMessages([{ event_type: "error", message: "Quota exceeded.", status: 429, upstream_status: 429 }]);
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(result.reason, "rate_limited");
    assert.equal(result.recovered, false);
    assert.equal(f.auth.health.getStatus(2).until, until);
    assert.equal(f.auth.health.accounts[2].lastRequestId, result.requestId);
    assert.equal(f.auth.health.manualProbes.size, 0);
});

test("passing a different model cannot clear the original quota cooldown", async () => {
    const f = recoveryFixture();
    f.auth.health.recordFailure(2, 429, "quota", undefined, { model: "original-model" });
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(result.status, "success");
    assert.equal(result.recovered, false);
    assert.equal(result.recoveryReason, undefined);
    assert.equal(f.auth.health.getStatus(2).mode, "disabled");
});

test("empty generation cannot recover and cancellation preserves the previous test", async () => {
    const f = recoveryFixture();
    f.auth.health.recordFailure(2, 429, "quota", undefined, { model: "gemini-test" });
    f.setMessages([
        { event_type: "response_headers", status: 200 },
        { data: "{}", event_type: "chunk" },
        { event_type: "stream_close" },
    ]);
    const failed = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(failed.reason, "empty_response");
    assert.equal(f.auth.health.getStatus(2).mode, "disabled");
    f.setMessages([]);
    const controller = new AbortController();
    const pending = f.service.test(2, "gemini-test", { recovery: true, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    assert.equal((await pending).reason, "cancelled");
    assert.equal(f.auth.health.manualProbes.size, 0);
    assert.equal(f.service.getResult(2).requestId, failed.requestId);
    assert.equal(f.auth.health.getStatus(2).mode, "disabled");
});

test("completed test details survive service restart", async () => {
    const f = recoveryFixture();
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    const restored = new AccountTestService(f.system);
    assert.equal(restored.getResult(2).requestId, result.requestId);
    assert.equal(restored.getResult(2).responseText, "OK");
});

test("manual success cannot undo an administrator disabling the account during a test", async () => {
    const f = recoveryFixture();
    f.auth.health.recordFailure(2, 429, "quota", undefined, { model: "gemini-test" });
    f.browserManager.withAccountTestConnection = async (_index, callback) => {
        const result = await callback();
        f.auth.health.setDisabled(2, true);
        return result;
    };
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(result.recovered, false);
    assert.equal(f.auth.health.getStatus(2).mode, "disabled");
    assert.equal(f.auth.health.manualProbes.size, 0);
});

test("a manual result from replaced credentials cannot restore the old cooldown", async () => {
    const f = recoveryFixture();
    f.auth.health.recordFailure(2, 429, "quota", undefined, { model: "gemini-test" });
    f.browserManager.withAccountTestConnection = async (_index, callback) => {
        const result = await callback();
        f.setEpoch(1);
        return result;
    };
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(result.reason, "credentials_changed");
    assert.equal(result.recovered, false);
    assert.equal(f.auth.health.getStatus(2).mode, "disabled");
    assert.equal(f.auth.health.manualProbes.size, 0);
});

test("a manually disabled account can pass a pinned test without enabling itself", async () => {
    const f = recoveryFixture();
    f.auth.health.setDisabled(2, true);
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(f.auth.health.getStatus(2).disabledBy, "manual");
    assert.equal(f.auth.health.isAvailable(2), false);
    assert.deepEqual(
        f.sent.map(item => item.index),
        [2]
    );
});

test("a new upstream 429 from a test on an enabled account turns its switch off", async () => {
    const f = recoveryFixture();
    f.setMessages([{ event_type: "error", message: "Quota exceeded.", status: 429, upstream_status: 429 }]);
    const result = await f.service.test(2, "gemini-test", { recovery: true });
    assert.equal(result.reason, "rate_limited");
    assert.equal(f.auth.health.getStatus(2).enabled, false);
    assert.equal(f.auth.health.getStatus(2).disabledBy, "auto");
    assert.ok(f.auth.health.getStatus(2).until > Date.now());
});
