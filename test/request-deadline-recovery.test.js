const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const AccountHealth = require("../src/auth/AccountHealth");
const AccountScheduler = require("../src/core/AccountScheduler");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const ProxyServerSystem = require("../src/core/ProxyServerSystem");
const RequestHandler = require("../src/core/RequestHandler");
const UsageStatsService = require("../src/core/UsageStatsService");
const GeminiCacheManager = require("../src/core/GeminiCacheManager");
const { listRequests, parseUsageQuery } = require("../src/core/UsageAnalytics");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-deadline-"));
    const clock = { value: Date.now() };
    const config = { fakeStreamTimeoutMs: 25, maxRetries: 1, rateLimitCooldownSeconds: 1 };
    const health = new AccountHealth(logger, path.join(directory, "health.json"), () => clock.value, config);
    const auth = {
        accountNameMap: new Map([
            [1, "A"],
            [2, "B"],
        ]),
        getRotationIndices: () => [1, 2],
        health,
    };
    const stalled = new Set();
    const browser = {
        authSource: auth,
        contexts: new Map(),
        ensureAccountPoolReady: async () => {},
        getReadyAccountIndices: () => [1, 2].filter(index => !stalled.has(index)),
        isAccountReady: index => !stalled.has(index),
        markAccountTransportFailure: index => stalled.add(index),
        rebalanceContextPool: async () => {},
    };
    const registry = new ConnectionRegistry(logger, null, null, browser, () => 0);
    for (const index of [1, 2]) registry.connectionsByAuth.set(index, { readyState: 1, send() {} });
    const stats = new UsageStatsService(auth, logger, directory, true);
    stats.connectionRegistry = registry;
    const handler = Object.assign(Object.create(RequestHandler.prototype), {
        authSource: auth,
        authSwitcher: { currentAuthIndex: 1 },
        browserManager: browser,
        cacheManager: {
            consumeCachedAttemptOutcome: () => false,
            findOwnerCandidates: () => [],
            prepare: proxy => proxy,
        },
        config,
        connectionRegistry: registry,
        logger,
        serverSystem: { usageStatsService: stats, webRoutes: { authRoutes: { getClientIP: () => "10.10.10.50" } } },
    });
    handler.accountScheduler = new AccountScheduler(handler);
    handler._handleRequestError = (error, res) => {
        handler._markTrackedResponseError(res, error.message, error.statusCode || error.status);
        res.statusCode = error.statusCode || error.status;
        res.writableEnded = true;
    };
    const system = Object.assign(Object.create(ProxyServerSystem.prototype), {
        authCredentialEpochs: new Map(),
        authSource: auth,
        browserManager: browser,
        logger,
        requestHandler: handler,
    });
    const outcomes = [];
    registry.on("backendOutcome", outcome => {
        outcomes.push(outcome);
        system._recordBackendOutcome(outcome);
    });
    registry.on("backendAttemptEvent", event => stats.recordBackendAttemptEvent(event));
    t.after(async () => {
        registry.closeAllMessageQueues();
        for (const id of handler.accountScheduler.requests.keys()) handler.accountScheduler.release(id);
        await stats.appendPromise;
        fs.rmSync(directory, { force: true, recursive: true });
    });
    return { clock, config, handler, health, outcomes, registry, stalled, stats };
}

function proxy(handler, id) {
    const request = {
        body: "{}",
        method: "POST",
        path: "/v1beta/models/gemini-3.8-flash:generateContent",
        request_id: id,
    };
    handler._initializeProxyRequestAttempt(request);
    return request;
}

for (const scenario of [
    {
        body: { model: "gemini-3.8-flash", stream: false },
        method: "processOpenAIRequest",
        path: "/v1/chat/completions",
    },
    {
        body: { model: "gemini-3.8-flash", stream: true },
        method: "processOpenAIResponseRequest",
        path: "/v1/responses",
    },
    { body: {}, method: "processRequest", path: "/v1beta/models/gemini-3.8-flash:generateContent" },
]) {
    test(`${scenario.path} records model-filtered 503 before any account is assigned`, async t => {
        const { handler, registry, stats } = fixture(t);
        handler.browserManager.getReadyAccountIndices = () => [];
        registry.isInGracePeriod = () => false;
        registry.isReconnectingInProgress = () => false;
        const req = { body: scenario.body, headers: {}, method: "POST", path: scenario.path };
        const res = Object.assign(new EventEmitter(), {
            send(body) {
                this.body = JSON.parse(body);
                this.writableEnded = true;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            statusCode: 200,
            type() {
                return this;
            },
            writableEnded: false,
        });
        await handler[scenario.method](req, res);
        assert.equal(res.statusCode, 503);
        assert.match(res.body.error.message, /No serving account/);
        assert.equal(stats.activeRequests.size, 0);
        assert.equal(stats.records.length, 1);
        const record = stats.records[0];
        assert.equal(record.model, "gemini-3.8-flash");
        assert.equal(record.statusCode, 503);
        assert.equal(record.finalAuthIndex, null);
        assert.equal(record.attemptCount, 0);
        assert.deepEqual(record.attempts, []);
        const filters = { model: "gemini-3.8-flash", range: "all" };
        const clientPage = listRequests(
            stats.records,
            parseUsageQuery({ ...filters, view: "requests" }, Date.now(), true)
        );
        assert.equal(clientPage.totalMatched, 1);
        assert.equal(clientPage.items[0].requestId, record.requestId);
        const callsPage = listRequests(
            stats.records,
            parseUsageQuery({ ...filters, view: "attempts" }, Date.now(), true)
        );
        assert.equal(callsPage.totalMatched, 0);
    });
}

test("an OPEN socket with no response after automatic enable backs off and releases its slot", async t => {
    const { clock, health, registry, stats, handler, outcomes, stalled } = fixture(t);
    health.recordFailure(1, 429, "old-quota");
    clock.value += 1000;
    const request = proxy(handler, "deadline");
    stats.startRequest("deadline", { model: "gemini-3.8-flash" });
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false });
    const index = await handler._selectServingAccount(request, { headers: {} }, res);
    assert.equal(index, 1);
    registry.createMessageQueue("deadline", index, request.request_attempt_id);
    handler._forwardRequest(request, index);
    assert.equal(health.getStatus(1).enabled, true);
    await new Promise(resolve => setTimeout(resolve, 45));
    handler._finalizeTrackedRequest("deadline", res);
    assert.equal(res.statusCode, 504);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].transportFailure, true);
    assert.equal(health.getStatus(1).mode, "disabled");
    assert.equal(health.getStatus(1).probeInFlight, false);
    assert.ok(stalled.has(1));
    assert.equal(handler.accountScheduler.getAccountLoad(1).inFlight, 0);
    assert.equal(registry.getAccountActivity(1).total, 0);
    const record = stats.records.find(item => item.requestId === "deadline");
    assert.equal(record.attempts.length, 1);
    assert.equal(record.attempts[0].upstreamStatusCode, null);
    assert.equal(record.attempts[0].localStatusCode, 504);
    assert.equal(record.attempts[0].terminationReason, "request_deadline");
    assert.equal(record.attempts[0].tokenUsage, null);
    const next = proxy(handler, "next");
    assert.equal((await handler.accountScheduler.acquire(next)).authIndex, 2);
});

test("a local total deadline with recent Google progress does not quarantine the account", async t => {
    const { health, registry, stats, handler, outcomes, stalled } = fixture(t);
    const request = proxy(handler, "progressing");
    stats.startRequest("progressing", { model: "gemini-3.8-flash" });
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false });
    const index = await handler._selectServingAccount(request, { headers: {} }, res);
    registry.createMessageQueue(request.request_id, index, request.request_attempt_id);
    handler._forwardRequest(request, index);
    registry._handleIncomingMessage(
        JSON.stringify({
            event_type: "response_headers",
            request_attempt_id: request.request_attempt_id,
            request_id: request.request_id,
            status: 200,
        }),
        index
    );
    await new Promise(resolve => setTimeout(resolve, 45));
    handler._finalizeTrackedRequest(request.request_id, res);
    assert.equal(res.statusCode, 504);
    assert.equal(outcomes.length, 0);
    assert.equal(health.getStatus(index).mode, "active");
    assert.equal(stalled.has(index), false);
    assert.equal(handler.accountScheduler.getAccountLoad(index).inFlight, 0);
    assert.equal(registry.getAccountActivity(index).total, 0);
    assert.equal(stats.records[0].outcome, "error");
    assert.equal(stats.records[0].attempts[0].upstreamStatusCode, 200);
});

test("HTTP finish releases the slot and queue without waiting for the handler finally", async t => {
    const { registry, stats, handler } = fixture(t);
    const request = proxy(handler, "finished");
    stats.startRequest("finished", { model: "gemini-3.8-flash" });
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false });
    const index = await handler._selectServingAccount(request, { headers: {} }, res);
    registry.createMessageQueue(request.request_id, index, request.request_attempt_id);
    handler._forwardRequest(request, index);
    res.writableEnded = true;
    res.emit("finish");
    assert.equal(handler.accountScheduler.getAccountLoad(index).inFlight, 0);
    assert.equal(registry.getAccountActivity(index).total, 0);
    assert.equal(stats.records.length, 1);
    handler._finalizeTrackedRequest(request.request_id, res);
    assert.equal(stats.records.length, 1);
});

test("a queue timeout before dispatch neither creates a call nor penalizes its account", t => {
    const { health, registry, stats, outcomes } = fixture(t);
    stats.startRequest("waiting", {});
    registry.createMessageQueue("waiting", 1, "waiting-attempt");
    registry.removeMessageQueue("waiting", "request_deadline");
    stats.finishRequest("waiting", { outcome: "error", statusCode: 504 });
    assert.equal(outcomes.length, 0);
    assert.equal(health.getStatus(1).mode, "active");
    assert.equal(stats.records[0].attempts.length, 0);
});

test("late browser errors and repeated timeout notifications cannot settle one attempt twice", t => {
    const { registry, stats, outcomes, health } = fixture(t);
    stats.startRequest("once", {});
    registry.createMessageQueue("once", 1, "attempt-1");
    registry.markRequestDispatched("once", 1, "attempt-1");
    stats.recordAttempt("once", 1, "A", "attempt-1");
    assert.equal(registry.endRequestAttempt("once", { statusCode: 504, terminationReason: "execution_timeout" }), true);
    registry.endRequestAttempt("once", { statusCode: 504 });
    registry._handleIncomingMessage(
        JSON.stringify({ event_type: "error", request_attempt_id: "attempt-1", request_id: "once", status: 429 }),
        1
    );
    assert.equal(outcomes.length, 1);
    assert.equal(health.getStatus(1).lastStatus, 504);
    assert.equal(stats.activeRequests.get("once").attempts[0].terminationReason, "execution_timeout");
});

test("cancelled calls end without quarantining the account, preserving received upstream status", t => {
    const { registry, stats, outcomes, health } = fixture(t);
    stats.startRequest("cancel", {});
    registry.createMessageQueue("cancel", 1, "attempt-c");
    stats.recordAttempt("cancel", 1, "A", "attempt-c");
    registry._handleIncomingMessage(
        JSON.stringify({
            event_type: "response_headers",
            request_attempt_id: "attempt-c",
            request_id: "cancel",
            status: 200,
        }),
        1
    );
    registry.removeMessageQueue("cancel", "client_disconnect");
    const attempt = stats.activeRequests.get("cancel").attempts[0];
    assert.equal(attempt.outcome, "aborted");
    assert.equal(attempt.upstreamStatusCode, 200);
    assert.equal(outcomes.length, 0);
    assert.equal(health.isAvailable(1), true);
});

test("old credential timeouts cannot quarantine or stall the replacement credential", t => {
    const { registry, handler, stalled, health } = fixture(t);
    registry.getAuthCredentialEpoch = () => 1;
    registry.createMessageQueue("old", 1, "old-a");
    registry.markRequestDispatched("old", 1, "old-a");
    registry.endRequestAttempt("old", { statusCode: 504 });
    assert.equal(health.getStatus(1).mode, "active");
    assert.equal(stalled.has(1), false);
    assert.equal(handler.accountScheduler.getAccountLoad(1).inFlight, 0);
});

test("a timed-out context handshake cannot replace the new context socket", t => {
    const { registry, handler } = fixture(t);
    handler.browserManager.isConnectionGenerationCurrent = (_index, value) => value === "new-generation";
    const current = registry.connectionsByAuth.get(1);
    const rejected = [];
    const old = Object.assign(new EventEmitter(), { close: (...args) => rejected.push(args), readyState: 1 });
    registry.addConnection(old, { authIndex: 1, contextGeneration: "old-generation" });
    assert.equal(registry.connectionsByAuth.get(1), current);
    assert.equal(rejected[0][0], 1008);
    assert.equal(old.listenerCount("message"), 0);
});

test("cache maintenance has a total deadline even with periodic frames, cancels its browser operation", async t => {
    const { registry, handler } = fixture(t);
    const manager = Object.assign(Object.create(GeminiCacheManager.prototype), {
        activeMaintenance: new Map(),
        closing: false,
        handler,
        resourceTimeoutMs: 30,
    });
    const cancellations = [];
    handler._cancelBrowserRequest = (...args) => cancellations.push(args);
    handler._forwardRequest = request => {
        const queue = registry.messageQueues.get(request.request_id).queue;
        const interval = setInterval(() => queue.enqueue({ event_type: "response_headers", status: 200 }), 5);
        t.after(() => clearInterval(interval));
    };
    await assert.rejects(manager._resourceRequest(1, { method: "DELETE", path: "/v1beta/cachedContents/test" }));
    assert.ok(cancellations.length >= 1);
    assert.equal(registry.getAccountActivity(1).maintenance, 0);
    assert.equal(manager.activeMaintenance.size, 0);
});

test("disabling an account cancels its maintenance instead of leaving a hidden draining queue", async t => {
    const { registry, handler, health } = fixture(t);
    const manager = Object.assign(Object.create(GeminiCacheManager.prototype), {
        activeMaintenance: new Map(),
        closing: false,
        handler,
        resourceTimeoutMs: 1000,
    });
    handler.cacheManager = manager;
    handler._forwardRequest = () => {};
    const request = manager._resourceRequest(1, { method: "DELETE", path: "/v1beta/cachedContents/test" });
    assert.equal(registry.getAccountActivity(1).maintenance, 1);
    health.setDisabled(1, true);
    handler.accountScheduler.notifyAccountChange(1);
    await assert.rejects(request);
    assert.equal(registry.getAccountActivity(1).total, 0);
    assert.equal(manager.activeMaintenance.size, 0);
});
