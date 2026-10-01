const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AccountScheduler = require("../src/core/AccountScheduler");

function fixture(options = {}) {
    const healthy = new Set([1, 2, 3]);
    const ready = new Set([1, 2, 3]);
    const grace = new Set();
    let matches = [];
    const handler = {
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
    };
}

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
    const { scheduler, proxy } = fixture();
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
    scheduler.release("r2");
});

test("owner index persists hashes only and callers with same session ID stay isolated", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-owners-"));
    t.after(() => fs.rmSync(dataDir, { force: true, recursive: true }));
    const { scheduler, proxy } = fixture({ dataDir });
    const a = await scheduler.acquire(proxy("private prompt"), { scope: "caller-a", sessionId: "s" });
    scheduler.release("private prompt");
    const b = await scheduler.acquire(proxy("b"), { scope: "caller-b", sessionId: "s" });
    assert.notEqual(a.key, b.key);
    scheduler.release("b");
    await scheduler.flush();
    const file = fs.readFileSync(path.join(dataDir, "conversation-owners.json"), "utf8");
    assert.equal(file.includes("private prompt"), false);
    assert.equal(file.includes("caller-a"), false);
    const restored = fixture({ dataDir });
    const afterRestart = await restored.scheduler.acquire(restored.proxy("r2"), { scope: "caller-a", sessionId: "s" });
    assert.equal(afterRestart.authIndex, a.authIndex);
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
