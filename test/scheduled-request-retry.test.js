const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const RequestHandler = require("../src/core/RequestHandler");
const AccountScheduler = require("../src/core/AccountScheduler");
const AccountHealth = require("../src/auth/AccountHealth");
const MessageQueue = require("../src/utils/MessageQueue");
const ProxyServerSystem = require("../src/core/ProxyServerSystem");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function fixture(t, responses, configOverrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-scheduled-retry-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const config = {
        cacheEnabled: false,
        immediateSwitchStatusCodes: [429, 503],
        maxRetries: 3,
        rateLimitCooldownSeconds: 18000,
        retryDelay: 0,
        ...configOverrides,
    };
    const health = new AccountHealth(logger, path.join(directory, "health.json"), Date.now, config);
    const connections = new Map([1, 2].map(index => [index, { readyState: 1, send() {} }]));
    const queues = new Map();
    const sent = [];
    const registry = {
        createMessageQueue(requestId, authIndex) {
            const queue = new MessageQueue();
            queues.set(requestId, { authIndex, healthEpoch: health.getEpoch(authIndex), queue });
            return queue;
        },
        getAuthIndexForRequest: requestId => queues.get(requestId)?.authIndex ?? null,
        getConnectionByAuth: authIndex => connections.get(authIndex),
        isInGracePeriod: () => false,
        isReconnectingInProgress: () => false,
        removeMessageQueue: requestId => queues.delete(requestId),
    };
    const browser = {
        currentAuthIndex: 1,
        ensureAccountReady: async () => false,
        getReadyAccountIndices: () => [1, 2].filter(index => connections.has(index)),
        isAccountReady: index => connections.has(index),
        rebalanceContextPool: async () => {},
    };
    const auth = {
        accountNameMap: new Map([
            [1, "A"],
            [2, "B"],
        ]),
        getRotationIndices: () => [1, 2],
        health,
    };
    const handler = new RequestHandler({}, registry, logger, browser, config, auth);
    handler.accountScheduler = new AccountScheduler(handler);
    handler.cacheManager = {
        _releaseAttempt() {},
        canFallback: () => false,
        consumeCachedAttemptOutcome: () => false,
        findOwnerCandidates: () => [],
        invalidateAndBypass: async () => true,
    };
    handler.authSwitcher.handleRequestFailureAndSwitch = () =>
        assert.fail("Scheduled requests must not use global switching");
    handler._waitForSystemAndConnectionIfBusy = () => assert.fail("Scheduled requests must not wait on global current");
    const system = Object.assign(Object.create(ProxyServerSystem.prototype), {
        authCredentialEpochs: new Map(),
        authSource: auth,
        browserManager: browser,
        logger,
        requestHandler: handler,
    });
    handler._forwardRequest = (proxy, authIndex) => {
        sent.push({ attempt: proxy.request_attempt_number, authIndex });
        const response = responses[sent.length - 1];
        if (typeof response === "function")
            return response({ authIndex, connections, handler, proxy, queue: queues.get(proxy.request_id).queue });
        for (const message of Array.isArray(response) ? response : [response]) {
            const entry = queues.get(proxy.request_id);
            // The real registry emits the backend outcome before enqueuing the
            // error. The handler only schedules retries after that health event.
            if (message.event_type === "error")
                system._recordBackendOutcome({
                    authCredentialEpoch: 0,
                    authIndex,
                    healthEpoch: entry.healthEpoch,
                    requestAttemptId: proxy.request_attempt_id,
                    requestId: proxy.request_id,
                    status: message.status,
                    success: false,
                });
            entry.queue.enqueue(message);
        }
    };
    const request = async (requestId = "r", sessionId = "session", options = {}) => {
        const proxy = {
            body: JSON.stringify({ contents: [{ parts: [{ text: "hello" }], role: "user" }] }),
            is_generative: true,
            method: "POST",
            path: "/v1beta/models/gemini-3.8-flash:generateContent",
            request_id: requestId,
        };
        handler._initializeProxyRequestAttempt(proxy);
        const lease = await handler.accountScheduler.acquire(proxy, { scope: "caller", sessionId, ...options });
        const queue = registry.createMessageQueue(requestId, lease.authIndex, proxy.request_attempt_id);
        return { proxy, queue };
    };
    t.after(() => {
        for (const requestId of handler.accountScheduler.requests.keys()) handler.accountScheduler.cancel(requestId);
    });
    return { browser, config, connections, handler, health, registry, request, sent };
}

test("scheduled 503 retries the same conversation owner while B remains ready", async t => {
    const { handler, request, sent } = fixture(t, [
        { event_type: "error", message: "Model busy", status: 503 },
        { event_type: "headers", status: 200 },
    ]);
    const { proxy, queue } = await request();
    const result = await handler._executeRequestWithRetries(proxy, queue);
    assert.equal(result.success, true);
    assert.deepEqual(
        sent.map(item => item.authIndex),
        [1, 1]
    );
    assert.equal(handler.accountScheduler.getLease("r").authIndex, 1);
});

test("scheduled 429 cools A and migrates the conversation to B without global switching", async t => {
    const { handler, health, request, sent } = fixture(t, [
        { event_type: "error", message: "Quota exceeded", status: 429 },
        { event_type: "headers", status: 200 },
    ]);
    const { proxy, queue } = await request();
    const result = await handler._executeRequestWithRetries(proxy, queue);
    assert.equal(result.success, true);
    assert.deepEqual(
        sent.map(item => item.authIndex),
        [1, 2]
    );
    assert.equal(health.getStatus(1).mode, "disabled");
    assert.equal(health.getStatus(1).disabledBy, "auto");
    assert.ok(health.getStatus(1).until >= Date.now() + 17_990_000);
    handler.accountScheduler.release("r");
    const followup = await request("r-next");
    assert.equal(followup.proxy.account_lease.authIndex, 2);
});

test("cached-resource fallback and quota migration share the snapshotted attempt budget", async t => {
    const { config, handler, request, sent } = fixture(
        t,
        [
            { event_type: "error", message: "Cached resource gone", status: 404 },
            { event_type: "error", message: "Quota exceeded", status: 429 },
            { event_type: "headers", status: 200 },
        ],
        { maxRetries: 2 }
    );
    let cached = true;
    handler.cacheManager.canFallback = (_proxy, error) => cached && error.status === 404;
    handler.cacheManager.invalidateAndBypass = async () => {
        cached = false;
        return true;
    };
    const { proxy, queue } = await request();
    config.maxRetries = 10;
    const result = await handler._executeRequestWithRetries(proxy, queue);
    assert.equal(result.success, false);
    assert.equal(result.error.status, 429);
    assert.deepEqual(sent, [
        { attempt: 1, authIndex: 1 },
        { attempt: 2, authIndex: 1 },
    ]);
    assert.equal(proxy.request_attempt_number, 2);
});

test("a rejected cache on the last attempt is invalidated without an extra generation", async t => {
    const { handler, request, sent } = fixture(
        t,
        [{ event_type: "error", message: "Cached resource gone", status: 404 }],
        { maxRetries: 1 }
    );
    let invalidated = false;
    handler.cacheManager.canFallback = () => true;
    handler.cacheManager.invalidateAndBypass = async () => {
        invalidated = true;
        return true;
    };
    const { proxy, queue } = await request();
    const result = await handler._executeRequestWithRetries(proxy, queue);
    assert.equal(result.success, false);
    assert.equal(invalidated, true);
    assert.equal(sent.length, 1);
});

test("confirmed transport loss recovers only A, with its failed slot released before reload", async t => {
    const { browser, connections, handler, request, sent } = fixture(t, [
        ({ connections, queue }) => {
            connections.delete(1);
            queue.close("page_closed");
        },
        { event_type: "headers", status: 200 },
    ]);
    const recovered = [];
    browser.ensureAccountReady = async index => {
        recovered.push(index);
        assert.equal(handler.accountScheduler.getAccountLoad(index).inFlight, 0);
        connections.set(index, { readyState: 1, send() {} });
        return true;
    };
    const { proxy, queue } = await request();
    const result = await handler._executeRequestWithRetries(proxy, queue);
    assert.equal(result.success, true);
    assert.deepEqual(recovered, [1]);
    assert.deepEqual(
        sent.map(item => item.authIndex),
        [1, 1]
    );
});

test("failed recovery migrates the conversation and never waits on another account's global state", async t => {
    const { handler, request, sent } = fixture(t, [
        ({ connections, queue }) => {
            connections.delete(1);
            queue.close("context_closed");
        },
        { event_type: "headers", status: 200 },
    ]);
    const { proxy, queue } = await request();
    const result = await handler._executeRequestWithRetries(proxy, queue);
    assert.equal(result.success, true);
    assert.deepEqual(
        sent.map(item => item.authIndex),
        [1, 2]
    );
});

test("all attempts use the original absolute deadline", async t => {
    const observed = [];
    const { handler, registry, request } = fixture(t, [
        { event_type: "error", message: "Busy", status: 503 },
        { event_type: "headers", status: 200 },
    ]);
    const originalCreate = registry.createMessageQueue;
    registry.createMessageQueue = (...args) => {
        const queue = originalCreate(...args);
        const dequeue = queue.dequeue.bind(queue);
        queue.dequeue = timeout => {
            observed.push(timeout);
            return dequeue(timeout);
        };
        return queue;
    };
    const { proxy, queue } = await request("r", "session", { deadline: Date.now() + 1000 });
    const result = await handler._executeRequestWithRetries(proxy, queue);
    assert.equal(result.success, true);
    assert.equal(observed.length, 2);
    assert.ok(observed.every(timeout => timeout > 0 && timeout <= 1000));
    assert.ok(observed[1] <= observed[0]);
});

test("client cancellation prevents retries and frees the serving slot", async t => {
    const controller = new AbortController();
    const { handler, request, sent } = fixture(t, [
        ({ queue }) => {
            controller.abort();
            queue.enqueue({ event_type: "error", message: "Busy", status: 503 });
        },
    ]);
    const { proxy, queue } = await request("r", "session", { signal: controller.signal });
    const result = await handler._executeRequestWithRetries(proxy, queue);
    assert.equal(result.success, false);
    assert.equal(result.error.isUserAborted, true);
    assert.equal(sent.length, 1);
    assert.equal(handler.accountScheduler.getAccountLoad(1).inFlight, 0);
});

test("native real streams use the scheduled first-message retry path", async t => {
    const { handler, request, sent } = fixture(t, [
        { event_type: "error", message: "Quota exceeded", status: 429 },
        [{ event_type: "headers", status: 200 }, { type: "STREAM_END" }],
    ]);
    const { proxy, queue } = await request();
    const res = new EventEmitter();
    Object.assign(res, {
        end() {
            this.finished = true;
        },
        get: () => "text/event-stream",
        statusCode: 200,
        type() {},
        write() {},
    });
    handler._setResponseHeaders = () => {};
    await handler._handleRealStreamResponse(proxy, queue, {}, res);
    assert.deepEqual(
        sent.map(item => item.authIndex),
        [1, 2]
    );
    assert.equal(res.finished, true);
});

test("native real streams never replay a generation after response output begins", async t => {
    const { handler, request, sent } = fixture(t, [
        [
            { event_type: "headers", status: 200 },
            { data: "partial output", event_type: "chunk" },
            { event_type: "error", message: "Model busy", status: 503 },
        ],
    ]);
    const { proxy, queue } = await request();
    const chunks = [];
    const res = new EventEmitter();
    Object.assign(res, {
        end() {
            this.finished = true;
        },
        get: () => "text/event-stream",
        socket: { writable: true },
        statusCode: 200,
        type() {},
        writable: true,
        write(chunk) {
            chunks.push(chunk);
        },
    });
    handler._setResponseHeaders = () => {};
    await handler._handleRealStreamResponse(proxy, queue, {}, res);
    assert.equal(sent.length, 1);
    assert.ok(chunks.some(chunk => String(chunk).includes("partial output")));
});
