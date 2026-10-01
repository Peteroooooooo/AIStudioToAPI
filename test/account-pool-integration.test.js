const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const AccountScheduler = require("../src/core/AccountScheduler");
const BrowserManager = require("../src/core/BrowserManager");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const RequestHandler = require("../src/core/RequestHandler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const flush = async () => {
    for (let index = 0; index < 40; index++) await Promise.resolve();
};

class Response extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.chunks = [];
        this.endCount = 0;
        this.headersSent = false;
        this.socket = { destroyed: false, writable: true };
        this.statusCode = 200;
        this.writableEnded = false;
        this.writable = true;
    }
    end() {
        this.endCount++;
        this.headersSent = true;
        this.writableEnded = true;
        this.emit("finish");
        return this;
    }
    get(name) {
        return this.headers[name.toLowerCase()];
    }
    getHeader(name) {
        return this.get(name);
    }
    json(value) {
        this.body = value;
        return this.end();
    }
    send(value) {
        this.body = value;
        return this.end();
    }
    set(value, item) {
        if (typeof value === "string") {
            this.setHeader(value, item);
            return this;
        }
        for (const [key, item] of Object.entries(value)) this.setHeader(key, item);
        return this;
    }
    setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
    }
    status(value) {
        this.statusCode = value;
        return this;
    }
    type(value) {
        this.setHeader("Content-Type", value);
        return this;
    }
    write(value) {
        assert.equal(this.writableEnded, false, "response must not receive output after ending");
        this.headersSent = true;
        this.chunks.push(String(value));
        return true;
    }
    abort() {
        this.destroyed = true;
        this.socket.destroyed = true;
        this.emit("close");
    }
}

function fixture(t) {
    const handler = Object.create(RequestHandler.prototype);
    const browser = Object.create(BrowserManager.prototype);
    const healthy = new Set([1, 2]);
    const authSource = {
        accountNameMap: new Map([
            [1, "account-a"],
            [2, "account-b"],
        ]),
        getRotationIndices: () => [1, 2].filter(index => healthy.has(index)),
        health: { isAvailable: index => healthy.has(index), releaseProbe() {}, tryAcquireProbe: () => true },
        isExpired: () => false,
        pendingRefreshIndices: new Set(),
    };
    Object.assign(browser, {
        _currentAuthIndex: -1,
        authSource,
        config: { maxContexts: 2 },
        contexts: new Map([
            [1, { page: { isClosed: () => false } }],
            [2, { page: { isClosed: () => false } }],
        ]),
        initializingContexts: new Set(),
        logger,
        pendingContextClosures: new Map(),
    });
    // The test uses real readiness, ownership and routing; browser launch and
    // optional page maintenance stay outside this in-memory transport.
    browser.rebalanceContextPool = async () => {};
    browser.notifyAccountIdle = () => {};
    const registry = new ConnectionRegistry(logger, null, () => browser.currentAuthIndex, browser);
    browser.connectionRegistry = registry;
    let requestSequence = 0;
    Object.assign(handler, {
        authSource,
        authSwitcher: { currentAuthIndex: -1, failureCount: 0, isSystemBusy: true },
        browserManager: browser,
        config: {
            fakeStreamTimeoutMs: 500,
            maxRetries: 3,
            retryDelay: 0,
            sessionSecret: "test-scope",
            streamingMode: "fake",
        },
        connectionRegistry: registry,
        logger,
        serverSystem: {},
    });
    handler._generateRequestId = () => `request-${++requestSequence}`;
    handler._startTrackedRequest = () => {};
    handler._updateTrackedRequest = () => {};
    handler._getCallerApiKeyId = req => req.caller;
    handler.cacheManager = {
        attachResponse() {},
        canFallback: () => false,
        findOwnerCandidates: () => [],
        prepare: request => request,
        recordAccountUse: () => 1,
    };
    const convert = body => ({ cleanModelName: "test-model", googleRequest: { contents: body.contents } });
    handler.formatConverter = {
        convertGoogleToClaudeNonStream: value => value,
        convertGoogleToOpenAINonStream: value => value,
        convertGoogleToResponseAPINonStream: value => value,
        translateClaudeToGoogle: async body => convert(body),
        translateOpenAIResponseToGoogle: async body => convert(body),
        translateOpenAIToGoogle: async body => convert(body),
    };
    handler._buildProxyRequest = (req, id) => ({
        body: JSON.stringify(req.body),
        headers: req.headers,
        is_generative: true,
        method: "POST",
        path: req.path,
        query_params: req.query,
        request_id: id,
        streaming_mode: handler.config.streamingMode,
    });
    handler.accountScheduler = new AccountScheduler(handler);
    const sent = [];
    const cancellations = [];
    for (const index of [1, 2]) {
        const socket = new EventEmitter();
        socket.readyState = 1;
        socket.close = () => {};
        socket.send = raw => {
            const request = JSON.parse(raw);
            if (request.event_type === "proxy_request") sent.push({ authIndex: index, request });
            if (request.event_type === "cancel_request") cancellations.push({ authIndex: index, request });
        };
        registry.addConnection(socket, { authIndex: index });
    }
    const receive = (dispatch, message) => {
        const ids = {
            request_attempt_id: dispatch.request.request_attempt_id,
            request_id: dispatch.request.request_id,
        };
        registry._handleIncomingMessage(JSON.stringify({ ...message, ...ids }), dispatch.authIndex);
    };
    const finish = (dispatch, { body, headers = {} } = {}) => {
        for (const message of [
            {
                event_type: "response_headers",
                headers: { "content-type": "application/json", ...headers },
                status: 200,
            },
            {
                data: JSON.stringify(
                    body || {
                        candidates: [{ content: { parts: [{ text: "reply" }], role: "model" } }],
                        usageMetadata: {},
                    }
                ),
                event_type: "chunk",
            },
            { event_type: "stream_close" },
        ])
            receive(dispatch, message);
    };
    const start = (method, sessionId, caller = "caller-a", overrides = {}) => {
        const res = new Response();
        const req = {
            body: { contents: [{ parts: [{ text: sessionId }], role: "user" }], model: "test-model", stream: false },
            caller,
            headers: { "x-session-id": sessionId },
            method: "POST",
            path: "/v1beta/models/test-model:generateContent",
            query: {},
            ...overrides,
        };
        return { done: handler[method](req, res), res };
    };
    t.after(() => {
        for (const id of [...handler.accountScheduler.requests.keys()]) handler.accountScheduler.cancel(id);
        for (const id of [...registry.messageQueues.keys()]) registry.removeMessageQueue(id, "test_complete");
        for (const timer of registry.reconnectGraceTimers.values()) clearTimeout(timer);
        registry.reconnectGraceTimers.clear();
    });
    return { browser, cancellations, finish, handler, healthy, receive, registry, sent, start };
}

for (const method of [
    "processRequest",
    "processOpenAIRequest",
    "processOpenAIResponseRequest",
    "processClaudeRequest",
]) {
    test(`${method}: two sessions run on two real registry routes; continuation waits for owner and releases`, async t => {
        const { finish, handler, sent, start } = fixture(t);
        const a = start(method, "session-a");
        const b = start(method, "session-b");
        await flush();
        assert.deepEqual(
            sent.map(item => item.authIndex),
            [1, 2]
        );
        const continuation = start(method, "session-a");
        await flush();
        assert.equal(sent.length, 2);
        assert.equal(handler.accountScheduler.getAccountLoad(1).waiting, 1);
        finish(sent[0]);
        await a.done;
        await flush();
        assert.equal(sent.length, 3);
        assert.equal(sent[2].authIndex, 1);
        assert.equal(sent[0].request.headers["x-session-id"], undefined);
        finish(sent[1]);
        finish(sent[2]);
        await Promise.all([b.done, continuation.done]);
        assert.equal(a.res.statusCode, 200);
        assert.equal(b.res.statusCode, 200);
        assert.equal(continuation.res.statusCode, 200);
        assert.equal(handler.accountScheduler.getSnapshot().inFlight, 0);
    });

    test(`${method}: cancelling queued continuation never forwards it`, async t => {
        const { finish, handler, sent, start } = fixture(t);
        const first = start(method, "same-session");
        await flush();
        const cancelled = start(method, "same-session");
        await flush();
        assert.equal(handler.accountScheduler.getAccountLoad(1).waiting, 1);
        cancelled.res.abort();
        await cancelled.done;
        finish(sent[0]);
        await first.done;
        await flush();
        assert.equal(sent.length, 1);
        assert.equal(handler.accountScheduler.getSnapshot().waiting, 0);
    });

    test(`${method}: identical session headers from different callers do not share an owner lock`, async t => {
        const { finish, sent, start } = fixture(t);
        const first = start(method, "same-id", "caller-a");
        const second = start(method, "same-id", "caller-b");
        await flush();
        assert.deepEqual(
            sent.map(item => item.authIndex),
            [1, 2]
        );
        finish(sent[0]);
        finish(sent[1]);
        await Promise.all([first.done, second.done]);
    });
}

test("preflight uses any serving account while current is absent and another account is reconnecting", async t => {
    const { browser, finish, handler, registry, sent, start } = fixture(t);
    registry.reconnectingAccounts.set(1, true);
    assert.equal(handler.currentAuthIndex, -1);
    assert.equal(handler.isSystemBusy, true);
    assert.deepEqual(browser.getReadyAccountIndices(), [2]);
    const request = start("processRequest", "healthy-backup");
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].authIndex, 2);
    finish(sent[0]);
    await request.done;
    assert.equal(request.res.statusCode, 200);
});

test("owner grace period waits without moving to an idle backup and resumes on reconnection", async t => {
    const { finish, handler, registry, sent, start } = fixture(t);
    const initial = start("processRequest", "stable-owner");
    await flush();
    finish(sent[0]);
    await initial.done;
    const previous = registry.connectionsByAuth.get(1);
    registry.connectionsByAuth.delete(1);
    registry.reconnectGraceTimers.set(1, 0);
    const pending = start("processRequest", "stable-owner");
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(handler.accountScheduler.getAccountLoad(1).waiting, 1);
    registry.addConnection(previous, { authIndex: 1 });
    await flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].authIndex, 1);
    finish(sent[1]);
    await pending.done;
    assert.equal(handler.accountScheduler.getAccountLoad(1).waiting, 0);
});

test("an owner waiting only in the scheduler migrates after registry grace expiry", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const { finish, handler, registry, sent, start } = fixture(t);
    handler.config.fakeStreamTimeoutMs = 30000;
    const initial = start("processRequest", "expired-grace-owner");
    await flush();
    finish(sent[0]);
    await initial.done;
    registry._removeConnection(registry.connectionsByAuth.get(1));
    const pending = start("processRequest", "expired-grace-owner");
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(handler.accountScheduler.getAccountLoad(1).waiting, 1);
    assert.equal(registry.messageQueues.size, 0);
    t.mock.timers.tick(10100);
    await flush();
    assert.equal(registry.isInGracePeriod(1), false);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].authIndex, 2);
    finish(sent[1]);
    await pending.done;
    assert.equal(pending.res.statusCode, 200);
});

test("a queued owner resumes when initialization ends after its socket already connected", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const { browser, finish, handler, registry, sent, start } = fixture(t);
    const initial = start("processRequest", "initializing-owner");
    await flush();
    finish(sent[0]);
    await initial.done;
    browser.initializingContexts.add(1);
    registry.reconnectingAccounts.set(1, true);
    const pending = start("processRequest", "initializing-owner");
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(handler.accountScheduler.getAccountLoad(1).waiting, 1);
    registry.reconnectingAccounts.delete(1);
    browser.initializingContexts.delete(1);
    t.mock.timers.tick(100);
    await flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].authIndex, 1);
    finish(sent[1]);
    await pending.done;
});

for (const status of [429, 503]) {
    test(`upload receiving ${status} reports the failure once without replaying or migrating`, async t => {
        const { handler, registry, sent } = fixture(t);
        const outcomes = [];
        let duplicateHealthWrites = 0;
        handler.authSource.health.recordFailure = () => duplicateHealthWrites++;
        registry.on("backendOutcome", outcome => outcomes.push(outcome));
        const res = new Response();
        const done = handler.processUploadRequest(
            {
                headers: {},
                method: "POST",
                path: "/upload/v1beta/files",
                query: {},
                rawBody: Buffer.from("file bytes"),
            },
            res
        );
        await flush();
        assert.equal(sent.length, 1);
        assert.equal(sent[0].request.is_upload, true);
        registry._handleIncomingMessage(
            JSON.stringify({
                event_type: "error",
                message: "Upload failed after the browser dispatched it.",
                request_attempt_id: sent[0].request.request_attempt_id,
                request_id: sent[0].request.request_id,
                status,
            }),
            sent[0].authIndex
        );
        await done;
        assert.equal(sent.length, 1);
        assert.equal(res.statusCode, status);
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].status, status);
        assert.equal(duplicateHealthWrites, 0);
        assert.equal(handler.accountScheduler.getSnapshot().inFlight, 0);
    });
}

test("the total deadline cancels a partially written live stream without replaying its generation", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
    const { cancellations, handler, receive, registry, sent, start } = fixture(t);
    handler.config.streamingMode = "real";
    const stream = start("processRequest", "deadline-stream", "caller-a", {
        path: "/v1beta/models/test-model:streamGenerateContent",
    });
    await flush();
    assert.equal(sent.length, 1);
    receive(sent[0], { event_type: "response_headers", headers: { "content-type": "text/event-stream" }, status: 200 });
    receive(sent[0], { data: 'data: {"text":"partial one"}\n\n', event_type: "chunk" });
    await flush();
    assert.equal(stream.res.headersSent, true);
    assert.equal(stream.res.writableEnded, false);
    assert.equal(handler.accountScheduler.getSnapshot().inFlight, 1);
    t.mock.timers.tick(250);
    receive(sent[0], { data: 'data: {"text":"partial two"}\n\n', event_type: "chunk" });
    await flush();
    t.mock.timers.tick(249);
    await flush();
    assert.equal(stream.res.writableEnded, false);
    t.mock.timers.tick(1);
    await stream.done;
    assert.equal(stream.res.__usageTrackingErrorStatus, 504);
    assert.match(stream.res.chunks.join(""), /partial one/);
    assert.match(stream.res.chunks.join(""), /partial two/);
    assert.match(stream.res.chunks.join(""), /DEADLINE_EXCEEDED/);
    assert.equal(stream.res.endCount, 1);
    assert.equal(sent.length, 1);
    assert.equal(cancellations.length, 1);
    assert.equal(cancellations[0].authIndex, sent[0].authIndex);
    assert.equal(cancellations[0].request.request_attempt_id, sent[0].request.request_attempt_id);
    assert.equal(registry.messageQueues.size, 0);
    assert.equal(handler.accountScheduler.requests.size, 0);
    assert.equal(handler.accountScheduler.getSnapshot().inFlight, 0);
});

test("upload response binds its session and file to its account through real response handling", async t => {
    const { finish, handler, healthy, registry, sent, start } = fixture(t);
    const uploadUrl = "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=owned-upload";
    const file = {
        name: "files/owned-file",
        uri: "https://generativelanguage.googleapis.com/v1beta/files/owned-file",
    };
    const upload = overrides => {
        const res = new Response();
        const req = {
            caller: "caller-a",
            headers: { host: "proxy.example" },
            method: "POST",
            path: "/upload/v1beta/files",
            query: {},
            rawBody: Buffer.from("file bytes"),
            ...overrides,
        };
        return { done: handler.processUploadRequest(req, res), res };
    };
    const first = upload({});
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].authIndex, 1);
    finish(sent[0], { body: { file }, headers: { "x-goog-upload-url": uploadUrl } });
    await first.done;
    assert.equal(first.res.statusCode, 200);
    assert.equal(first.res.get("x-goog-upload-url"), "http://proxy.example/upload/v1beta/files?upload_id=owned-upload");
    assert.equal(handler.accountScheduler.resources.size, 3);
    assert.ok([...handler.accountScheduler.resources.values()].every(binding => binding.authIndex === 1));
    assert.equal(handler.accountScheduler.getAccountLoad(2).inFlight, 0);

    const continued = upload({ query: { upload_id: "owned-upload" } });
    await flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].authIndex, 1);
    finish(sent[1], { body: { file } });
    await continued.done;
    const fileBody = {
        contents: [{ parts: [{ fileData: { fileUri: file.uri, mimeType: "text/plain" } }], role: "user" }],
    };
    const generated = start("processRequest", "uses-uploaded-file", "caller-a", { body: fileBody });
    await flush();
    assert.equal(sent.length, 3);
    assert.equal(sent[2].authIndex, 1);
    finish(sent[2]);
    await generated.done;

    healthy.delete(1);
    const unavailableUpload = upload({ query: { upload_id: "owned-upload" } });
    const unavailableFile = start("processRequest", "owner-cooled", "caller-a", { body: fileBody });
    await Promise.all([unavailableUpload.done, unavailableFile.done]);
    for (const response of [unavailableUpload.res, unavailableFile.res]) {
        assert.equal(response.statusCode, 503);
        assert.equal(response.endCount, 1);
    }
    assert.equal(sent.length, 3, "account-owned resources must not replay on the idle backup");
    assert.equal(registry.messageQueues.size, 0);
    assert.equal(handler.accountScheduler.requests.size, 0);
});

test("unknown upload sessions and Google files return one 409 response without allocating a slot", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const { handler, registry, sent, start } = fixture(t);
    const uploadResponse = new Response();
    const unknownUpload = handler.processUploadRequest(
        {
            caller: "caller-a",
            headers: {},
            method: "POST",
            path: "/upload/v1beta/files",
            query: { upload_id: "unknown-upload" },
            rawBody: Buffer.from("file bytes"),
        },
        uploadResponse
    );
    const unknownFile = start("processRequest", "unknown-file", "caller-a", {
        body: {
            contents: [{ parts: [{ fileData: { fileUri: "files/unknown-file" } }], role: "user" }],
        },
    });
    await Promise.all([unknownUpload, unknownFile.done]);
    t.mock.timers.tick(1000);
    await flush();
    for (const response of [uploadResponse, unknownFile.res]) {
        assert.equal(response.statusCode, 409);
        assert.equal(response.endCount, 1);
        assert.equal(response.__usageTrackingErrorStatus, 409);
    }
    assert.equal(sent.length, 0);
    assert.equal(registry.messageQueues.size, 0);
    assert.equal(handler.accountScheduler.requests.size, 0);
    assert.equal(handler.accountScheduler.owners.size, 0);
    assert.equal(handler.accountScheduler.getSnapshot().inFlight, 0);
    assert.equal(handler.accountScheduler.getSnapshot().waiting, 0);
});
