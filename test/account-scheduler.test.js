const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AccountScheduler = require("../src/core/AccountScheduler");
const RequestHandler = require("../src/core/RequestHandler");

function fixture(options = {}) {
    const healthy = new Set([1, 2, 3]);
    const ready = new Set([1, 2, 3]);
    const grace = new Set();
    let matches = [];
    const tracked = new Map();
    const handler = {
        _updateTrackedRequest: (id, patch) => tracked.set(id, { ...tracked.get(id), ...patch }),
        authSource: { health: { isAvailable: index => healthy.has(index) } },
        browserManager: {
            ensureAccountPoolReady: async () => {},
            getReadyAccountIndices: () => [...ready],
            isAccountReady: index => ready.has(index),
            notifyAccountIdle() {},
        },
        cacheManager: { findOwnerCandidates: () => matches },
        connectionRegistry: { isInGracePeriod: index => grace.has(index) },
        logger: { warn() {} },
        timeouts: { FAKE_STREAM: 500 },
    };
    const scheduler = new AccountScheduler(handler, options);
    handler.accountScheduler = scheduler;
    const proxy = (id, contents = [{ parts: [{ text: id }], role: "user" }]) => ({
        body: JSON.stringify({ contents }),
        is_generative: true,
        method: "POST",
        path: "/v1beta/models/gemini-x:generateContent",
        request_id: id,
    });
    return {
        grace,
        handler,
        healthy,
        proxy,
        ready,
        scheduler,
        setMatches: value => {
            matches = value;
        },
        tracked,
    };
}

test("conversation IDs use the same explicit contract for every client", () => {
    const handler = Object.create(RequestHandler.prototype);
    for (const name of [
        "x-conversation-id",
        "x-thread-id",
        "x-session-id",
        "conversation-id",
        "thread-id",
        "session-id",
    ])
        assert.equal(handler._getConversationSessionId({ headers: { [name]: " chat " } }), "chat");
    for (const name of ["conversation_id", "thread_id", "session_id"])
        assert.equal(handler._getConversationSessionId({ body: { metadata: { [name]: "chat" } } }), "chat");
    assert.equal(
        handler._getConversationSessionId({
            body: { metadata: { session_id: "metadata-session" } },
            headers: { "session-id": "cache-affinity", "thread-id": "conversation" },
        }),
        "conversation"
    );
    assert.equal(
        handler._getConversationSessionId({
            body: { metadata: { session_id: "valid" } },
            headers: { "x-session-id": ["invalid"], "x-thread-id": " " },
        }),
        "valid"
    );
    assert.equal(
        handler._getConversationSessionId({
            body: {
                metadata: { account_id: "account", user_id: '{"session_id":"private-client-format"}' },
                prompt_cache_key: "shared-cache-key",
                user: "user_device_account_account_session_private-client-format",
            },
            headers: { "x-client-request-id": "request", "x-user-id": "account" },
        }),
        null
    );
});

test("local conversation headers are not sent to the Google backend", () => {
    const handler = Object.create(RequestHandler.prototype);
    let sent;
    Object.assign(handler, {
        _getUsageStatsService: () => null,
        _updateTrackedRequest() {},
        cacheManager: { prepare: request => request },
        connectionRegistry: { getConnectionByAuth: () => ({ send: message => (sent = JSON.parse(message)) }) },
        logger: { debug() {} },
    });
    const headers = { "content-type": "application/json" };
    for (const name of [
        "x-conversation-id",
        "x-thread-id",
        "x-session-id",
        "conversation-id",
        "thread-id",
        "session-id",
    ])
        headers[name] = "local-chat";
    handler._forwardRequest({ headers, request_id: "r" }, 1);
    assert.deepEqual(sent.headers, { "content-type": "application/json" });
    assert.equal(headers["x-session-id"], "local-chat");
});

test("exact history remains available when a gateway drops a conversation ID", async () => {
    const { scheduler, proxy, tracked } = fixture();
    const history = [
        { parts: [{ text: "unique question" }], role: "user" },
        { parts: [{ text: "answer" }], role: "model" },
        { parts: [{ text: "followup" }], role: "user" },
    ];
    await scheduler.acquire(proxy("explicit", history), { scope: "caller", sessionId: "chat" });
    scheduler.release("explicit");
    await scheduler.acquire(
        proxy("without-id", [
            ...history,
            { parts: [{ text: "new answer" }], role: "model" },
            { parts: [{ text: "more" }], role: "user" },
        ]),
        { scope: "caller" }
    );
    assert.equal(tracked.get("without-id").conversationId, tracked.get("explicit").conversationId);
    assert.equal(tracked.get("without-id").conversationMatch, "history_match");
    scheduler.release("without-id");
});

test("shared history does not merge distinct conversations, including after restart", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambiguous-history-"));
    const original = fixture({ dataDir });
    t.after(() => {
        clearTimeout(original.scheduler.persistTimer);
        fs.rmSync(dataDir, { force: true, recursive: true });
    });
    const greeting = [{ parts: [{ text: "hi" }], role: "user" }];
    for (const id of ["one", "two"]) {
        await original.scheduler.acquire(original.proxy(id, greeting), { sessionId: id });
        original.scheduler.release(id);
    }
    assert.notEqual(original.tracked.get("one").conversationId, original.tracked.get("two").conversationId);
    await original.scheduler.flush();
    const restored = fixture({ dataDir });
    t.after(() => clearTimeout(restored.scheduler.persistTimer));
    await restored.scheduler.acquire(
        restored.proxy("unknown", [
            ...greeting,
            { parts: [{ text: "hello" }], role: "model" },
            { parts: [{ text: "followup" }], role: "user" },
        ])
    );
    assert.equal(restored.tracked.get("unknown").conversationMatch, "history_unmatched");
    for (const id of ["one", "two"])
        assert.notEqual(restored.tracked.get("unknown").conversationId, original.tracked.get(id).conversationId);
    restored.scheduler.release("unknown");
});

test("session identity survives tool/model changes, compressed history, day boundaries and restart", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stable-session-"));
    const first = fixture({ clock: () => Date.parse("2026-10-02T15:59:00Z"), dataDir });
    t.after(async () => {
        clearTimeout(first.scheduler.persistTimer);
        fs.rmSync(dataDir, { force: true, recursive: true });
    });
    const initial = first.proxy("initial");
    initial.body = JSON.stringify({
        contents: [{ parts: [{ text: "original" }], role: "user" }],
        tools: [{ googleSearch: {} }],
    });
    const lease = await first.scheduler.acquire(initial, { scope: "caller-a", sessionId: "chat" });
    first.scheduler.release("initial");
    await first.scheduler.flush();
    const restored = fixture({ clock: () => Date.parse("2026-10-03T01:00:00Z"), dataDir });
    t.after(() => clearTimeout(restored.scheduler.persistTimer));
    const next = restored.proxy("next");
    next.path = "/v1beta/models/another-model:generateContent";
    next.body = JSON.stringify({
        contents: [{ parts: [{ text: "summary and new question" }], role: "user" }],
        systemInstruction: { parts: [{ text: "new instructions" }] },
        tools: [],
    });
    const continuation = await restored.scheduler.acquire(next, { scope: "caller-a", sessionId: "chat" });
    assert.equal(continuation.authIndex, lease.authIndex);
    assert.equal(restored.tracked.get("next").conversationId, first.tracked.get("initial").conversationId);
    assert.equal(restored.tracked.get("next").conversationMatch, "session_match");
    assert.equal(restored.tracked.get("next").conversationConfigChanged, true);
    restored.scheduler.release("next");
});

test("exact history keeps its conversation through configuration changes but edited history remains unlinked", async () => {
    const { scheduler, proxy, tracked } = fixture();
    const contents = [
        { parts: [{ text: "question" }], role: "user" },
        { parts: [{ text: "answer" }], role: "model" },
        { parts: [{ text: "followup" }], role: "user" },
    ];
    await scheduler.acquire(proxy("first", contents), { scope: "caller-a" });
    scheduler.release("first");
    const next = proxy("next", [
        ...contents,
        { parts: [{ text: "response" }], role: "model" },
        { parts: [{ text: "more" }], role: "user" },
    ]);
    next.body = JSON.stringify({
        ...JSON.parse(next.body),
        systemInstruction: { parts: [{ text: "changed environment" }] },
        tools: [],
    });
    await scheduler.acquire(next, { scope: "caller-a" });
    assert.equal(tracked.get("next").conversationId, tracked.get("first").conversationId);
    assert.equal(tracked.get("next").conversationConfigChanged, true);
    scheduler.release("next");
    await scheduler.acquire(
        proxy("edited", [{ parts: [{ text: "different question" }], role: "user" }, ...contents.slice(1)]),
        { scope: "caller-a" }
    );
    assert.notEqual(tracked.get("edited").conversationId, tracked.get("first").conversationId);
    assert.equal(tracked.get("edited").conversationMatch, "history_unmatched");
    scheduler.release("edited");
    await scheduler.acquire(proxy("other-caller", contents), { scope: "caller-b" });
    assert.notEqual(tracked.get("other-caller").conversationId, tracked.get("first").conversationId);
    scheduler.release("other-caller");
});

test("identical standalone greetings remain separate without a session ID", async () => {
    const { scheduler, proxy, tracked } = fixture();
    const greeting = [{ parts: [{ text: "hi" }], role: "user" }];
    await scheduler.acquire(proxy("one", greeting));
    scheduler.release("one");
    await scheduler.acquire(proxy("two", greeting));
    assert.notEqual(tracked.get("one").conversationId, tracked.get("two").conversationId);
    assert.equal(tracked.get("two").conversationReused, false);
    scheduler.release("two");
});

test("legacy session owner is adopted and then survives changed configuration", async () => {
    const { scheduler, proxy, tracked } = fixture();
    const original = proxy("old");
    const { base } = scheduler._identity(original, "caller", "session");
    const key = scheduler._hash({ base, sessionId: "session" });
    scheduler.owners.set(key, { authIndex: 2, conversationId: "chat_9", lastUsed: Date.now(), version: 1 });
    await scheduler.acquire(original, { scope: "caller", sessionId: "session" });
    scheduler.release("old");
    const changed = proxy("new");
    changed.body = JSON.stringify({ ...JSON.parse(changed.body), tools: [{ googleSearch: {} }] });
    await scheduler.acquire(changed, { scope: "caller", sessionId: "session" });
    assert.equal(tracked.get("new").conversationId, "chat_9");
    assert.equal(scheduler.owners.size, 1);
    scheduler.release("new");
});

test("simultaneous new conversations reserve different serving accounts atomically", async () => {
    const { scheduler, proxy } = fixture();
    const [a, b, c] = await Promise.all(["A", "B", "C"].map(id => scheduler.acquire(proxy(id))));
    assert.deepEqual([a.authIndex, b.authIndex, c.authIndex], [1, 2, 3]);
    assert.equal(scheduler.getSnapshot().inFlight, 3);
    for (const id of ["A", "B", "C"]) scheduler.release(id);
});

test("a busy conversation owner queues its continuation even with idle alternatives", async () => {
    const { scheduler, proxy } = fixture();
    const a = await scheduler.acquire(proxy("first"), { sessionId: "conversation" });
    let started = false;
    const pending = scheduler.acquire(proxy("second"), { sessionId: "conversation" }).then(lease => {
        started = true;
        return lease;
    });
    await Promise.resolve();
    assert.equal(started, false);
    assert.deepEqual(scheduler.getAccountLoad(1), { conversations: 1, inFlight: 1, waiting: 1 });
    scheduler.release("first");
    const second = await pending;
    assert.equal(second.authIndex, a.authIndex);
    scheduler.release("second");
});

test("expired or absent cache does not change a conversation's account", async () => {
    const { scheduler, proxy, setMatches } = fixture();
    const first = await scheduler.acquire(proxy("one"), { sessionId: "s" });
    scheduler.release("one");
    setMatches([{ authIndex: 3, prefixLength: 4 }]);
    const next = await scheduler.acquire(proxy("two"), { sessionId: "s" });
    assert.equal(next.authIndex, first.authIndex);
    scheduler.release("two");
});

test("pending cache owner is preferred and subsequent requests do not build on idle accounts", async () => {
    const { scheduler, proxy, setMatches } = fixture();
    setMatches([{ authIndex: 2, pending: true, prefixLength: 1 }]);
    const first = await scheduler.acquire(proxy("one"));
    assert.equal(first.authIndex, 2);
    const pending = scheduler.acquire(proxy("two"));
    assert.equal(scheduler.getAccountLoad(2).waiting, 1);
    scheduler.release("one");
    assert.equal((await pending).authIndex, 2);
    scheduler.release("two");
});

test("429 migrates owner once and recovered account cannot take it back", async () => {
    const { scheduler, proxy, healthy } = fixture();
    const a = await scheduler.acquire(proxy("r1"), { sessionId: "s" });
    healthy.delete(a.authIndex);
    const b = await scheduler.retry("r1", { exclude: [a.authIndex], unavailable: true });
    assert.notEqual(a.authIndex, b.authIndex);
    assert.equal(scheduler.isCurrentOwner(a, a.authIndex), false);
    assert.equal(scheduler.isCurrentOwner(b, b.authIndex), true);
    scheduler.release("r1");
    healthy.add(a.authIndex);
    const next = await scheduler.acquire(proxy("r2"), { sessionId: "s" });
    assert.equal(next.authIndex, b.authIndex);
    scheduler.release("r2");
});

test("disabled account's queued continuations move to one replacement owner", async () => {
    const { scheduler, proxy, healthy } = fixture();
    const first = await scheduler.acquire(proxy("r1"), { sessionId: "s" });
    const second = scheduler.acquire(proxy("r2"), { sessionId: "s" });
    const third = scheduler.acquire(proxy("r3"), { sessionId: "s" });
    healthy.delete(first.authIndex);
    scheduler.notifyAccountChange(first.authIndex);
    const next = await second;
    assert.notEqual(next.authIndex, first.authIndex);
    assert.equal(scheduler.getAccountLoad(next.authIndex).waiting, 1);
    scheduler.release("r2");
    assert.equal((await third).authIndex, next.authIndex);
    scheduler.release("r3");
    scheduler.release("r1");
});

test("client abort removes queued work without dispatching it", async () => {
    const { scheduler, proxy } = fixture();
    await scheduler.acquire(proxy("r1"), { sessionId: "s" });
    const controller = new AbortController();
    const pending = scheduler.acquire(proxy("r2"), { sessionId: "s", signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.isUserAborted === true);
    assert.equal(scheduler.getAccountLoad(1).waiting, 0);
    scheduler.release("r1");
});

test("queue deadline does not reset when request changes accounts", async () => {
    const { scheduler, proxy } = fixture();
    await scheduler.acquire(proxy("r1"), { sessionId: "s" });
    const pending = scheduler.acquire(proxy("r2"), { deadline: Date.now() + 20, sessionId: "s" });
    await assert.rejects(pending, error => error.status === 504);
    assert.equal(scheduler.hasRequest("r2"), false);
    scheduler.release("r1");
});

test("full-history prefixes keep affinity without an explicit session ID", async () => {
    const { scheduler, proxy, tracked } = fixture();
    const contents = [{ parts: [{ text: "question" }], role: "user" }];
    const first = await scheduler.acquire(proxy("r1", contents), { scope: "caller-a" });
    scheduler.release("r1");
    const next = await scheduler.acquire(
        proxy("r2", [
            ...contents,
            { parts: [{ text: "answer" }], role: "model" },
            { parts: [{ text: "continue" }], role: "user" },
        ]),
        { scope: "caller-a" }
    );
    assert.equal(next.authIndex, first.authIndex);
    assert.equal(tracked.get("r1").conversationSource, "history");
    assert.equal(tracked.get("r1").conversationReused, false);
    assert.equal(tracked.get("r2").conversationReused, true);
    assert.equal(tracked.get("r2").conversationId, tracked.get("r1").conversationId);
    scheduler.release("r2");
});

test("owner index persists hashes only and callers with same session ID stay isolated", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-owners-"));
    t.after(() => fs.rmSync(dataDir, { force: true, recursive: true }));
    const { scheduler, proxy, tracked } = fixture({ dataDir });
    const a = await scheduler.acquire(proxy("private prompt"), { scope: "caller-a", sessionId: "s" });
    scheduler.release("private prompt");
    const b = await scheduler.acquire(proxy("b"), { scope: "caller-b", sessionId: "s" });
    assert.notEqual(a.key, b.key);
    assert.notEqual(tracked.get("private prompt").conversationId, tracked.get("b").conversationId);
    assert.equal(tracked.get("private prompt").conversationSource, "session");
    scheduler.release("b");
    await scheduler.flush();
    const file = fs.readFileSync(path.join(dataDir, "conversation-owners.json"), "utf8");
    assert.equal(file.includes("private prompt"), false);
    assert.equal(file.includes("caller-a"), false);
    const restored = fixture({ dataDir });
    const afterRestart = await restored.scheduler.acquire(restored.proxy("r2"), { scope: "caller-a", sessionId: "s" });
    assert.equal(afterRestart.authIndex, a.authIndex);
    assert.equal(restored.tracked.get("r2").conversationId, tracked.get("private prompt").conversationId);
    assert.equal(restored.tracked.get("r2").conversationReused, true);
    restored.scheduler.release("r2");
    clearTimeout(scheduler.persistTimer);
    clearTimeout(restored.scheduler.persistTimer);
});

test("temporary socket grace waits for its owner, then resumes without migration", async () => {
    const { scheduler, proxy, ready, grace } = fixture();
    const a = await scheduler.acquire(proxy("r1"), { sessionId: "s" });
    scheduler.release("r1");
    ready.delete(a.authIndex);
    grace.add(a.authIndex);
    const pending = scheduler.acquire(proxy("r2"), { sessionId: "s" });
    assert.equal(scheduler.getAccountLoad(a.authIndex).waiting, 1);
    ready.add(a.authIndex);
    grace.delete(a.authIndex);
    scheduler.notifyAccountChange(a.authIndex);
    assert.equal((await pending).authIndex, a.authIndex);
    scheduler.release("r2");
});

test("known File API resource pins owner and cannot migrate during cooldown", async () => {
    const { scheduler, proxy, healthy } = fixture();
    scheduler.recordResource("caller", "files/one", 2);
    const request = proxy("r1");
    request.body = JSON.stringify({
        contents: [
            { parts: [{ fileData: { fileUri: "https://generativelanguage.googleapis.com/v1beta/files/one" } }] },
        ],
    });
    assert.equal((await scheduler.acquire(request, { scope: "caller" })).authIndex, 2);
    healthy.delete(2);
    await assert.rejects(scheduler.retry("r1", { unavailable: true }), /cannot migrate/);
    scheduler.release("r1");
});

test("a recovered old attempt follows a queued conversation's newer owner on retry", async () => {
    const { scheduler, proxy, healthy } = fixture();
    const first = await scheduler.acquire(proxy("r1"), { sessionId: "s" });
    const pending = scheduler.acquire(proxy("r2"), { sessionId: "s" });
    healthy.delete(first.authIndex);
    scheduler.notifyAccountChange();
    const migrated = await pending;
    healthy.add(first.authIndex);
    const retry = scheduler.retry("r1");
    assert.equal(scheduler.getLease("r1").authIndex, migrated.authIndex);
    scheduler.release("r2");
    assert.equal((await retry).authIndex, migrated.authIndex);
    scheduler.release("r1");
});

test("reused account index invalidates the old account's pinned resource", async () => {
    const { scheduler, handler, proxy } = fixture();
    handler.authSource.accountNameMap = new Map([[2, "old@gmail.com"]]);
    scheduler.recordResource("caller", "files/one", 2);
    handler.authSource.accountNameMap.set(2, "replacement@gmail.com");
    const request = proxy("r1");
    request.body = JSON.stringify({ contents: [{ parts: [{ fileData: { fileUri: "files/one" } }] }] });
    await assert.rejects(scheduler.acquire(request, { scope: "caller" }), error => error.status === 409);
});

test("queue admission failures release registry entries and cannot leave phantom load", async () => {
    const { scheduler, proxy } = fixture({ maxWaiting: 0 });
    await scheduler.acquire(proxy("r1"), { sessionId: "s" });
    await assert.rejects(scheduler.acquire(proxy("r2"), { sessionId: "s" }), /queue is full/);
    assert.equal(scheduler.hasRequest("r2"), false);
    assert.equal(scheduler.getAccountLoad(1).waiting, 0);
    scheduler.release("r1");
});
