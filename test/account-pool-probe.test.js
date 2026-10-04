const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AccountHealth = require("../src/auth/AccountHealth");
const AccountScheduler = require("../src/core/AccountScheduler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function fixture(t, indices = [0, 1]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "account-probe-"));
    const clock = { value: 1_700_000_000_000 };
    const health = new AccountHealth(logger, path.join(directory, "health.json"), () => clock.value, {
        rateLimitCooldownSeconds: 1,
    });
    const handler = {
        authSource: { health },
        browserManager: { getReadyAccountIndices: () => indices, isAccountReady: index => indices.includes(index) },
        cacheManager: { findOwnerCandidates: () => [] },
        logger,
        timeouts: { FAKE_STREAM: 5000 },
    };
    const scheduler = new AccountScheduler(handler, { clock: () => clock.value });
    t.after(() => {
        for (const requestId of [...scheduler.requests.keys()]) scheduler.release(requestId);
        fs.rmSync(directory, { force: true, recursive: true });
    });
    return { clock, health, scheduler };
}

function request(id, text = id) {
    return {
        body: { contents: [{ parts: [{ text }], role: "user" }] },
        is_generative: true,
        path: "/v1beta/models/gemini:generateContent",
        request_id: id,
    };
}

test("an automatically enabled account takes one slot while a new conversation runs elsewhere", async t => {
    const { clock, health, scheduler } = fixture(t);
    health.recordFailure(0, 429, "old-failure");
    clock.value += 1000;
    const first = await scheduler.acquire(request("probe"), { sessionId: "conversation-A" });
    assert.equal(first.authIndex, 0);
    assert.equal(health.getStatus(0).enabled, true);
    assert.equal(scheduler.getAccountLoad(0).inFlight, 1);
    const second = await scheduler.acquire(request("parallel"), { sessionId: "conversation-B" });
    assert.equal(second.authIndex, 1);
    assert.equal(scheduler.getSnapshot().inFlight, 2);
    health.recordSuccess(0, "late-old-success");
    assert.equal(health.getStatus(0).probeRequired, false);
    health.recordSuccess(0, "probe");
    assert.equal(health.getStatus(0).probeRequired, false);
    scheduler.release("probe");
    scheduler.release("parallel");
});

test("a same-conversation request waits behind the running request then keeps its enabled owner", async t => {
    const { clock, health, scheduler } = fixture(t, [0]);
    health.recordFailure(0, 429, "old-failure");
    clock.value += 1000;
    await scheduler.acquire(request("probe"), { sessionId: "same" });
    let resolved = false;
    const queued = scheduler.acquire(request("next"), { sessionId: "same" }).then(lease => {
        resolved = true;
        return lease;
    });
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.deepEqual(scheduler.getAccountLoad(0), { conversations: 1, inFlight: 1, waiting: 1 });
    health.recordSuccess(0, "unrelated-success");
    scheduler.notifyAccountChange(0);
    await Promise.resolve();
    assert.equal(resolved, false);
    health.recordSuccess(0, "probe");
    scheduler.release("probe");
    assert.equal((await queued).authIndex, 0);
    assert.equal(health.getStatus(0).probeRequired, false);
    scheduler.release("next");
});

test("a fresh quota failure after automatic enable migrates its queued conversation and preserves the new timer", async t => {
    const { clock, health, scheduler } = fixture(t);
    health.recordFailure(0, 429, "old-failure");
    clock.value += 1000;
    await scheduler.acquire(request("probe"), { sessionId: "same" });
    const queued = scheduler.acquire(request("next"), { sessionId: "same" });
    health.recordFailure(0, 429, "probe");
    const until = health.getStatus(0).until;
    scheduler.notifyAccountChange(0);
    const migrated = await queued;
    assert.equal(migrated.authIndex, 1);
    assert.equal(health.getStatus(0).probeRequired, false);
    assert.equal(health.getStatus(0).mode, "disabled");
    assert.equal(health.getStatus(0).disabledBy, "auto");
    health.recordSuccess(0, "old-success");
    health.recordFailure(0, 429, "old-second-failure");
    assert.equal(health.getStatus(0).until, until);
    scheduler.release("probe");
    scheduler.release("next");
});

test("cancelling a request after automatic enable releases its slot for the queued continuation", async t => {
    const { clock, health, scheduler } = fixture(t, [0]);
    health.recordFailure(0, 429, "old-failure");
    clock.value += 1000;
    await scheduler.acquire(request("cancelled"), { sessionId: "same" });
    const queued = scheduler.acquire(request("replacement"), { sessionId: "same" });
    scheduler.cancel("cancelled");
    assert.equal((await queued).authIndex, 0);
    assert.equal(scheduler.getAccountLoad(0).inFlight, 1);
    health.recordSuccess(0, "cancelled");
    assert.equal(health.getStatus(0).enabled, true);
    health.recordSuccess(0, "replacement");
    scheduler.release("replacement");
    assert.equal(health.getStatus(0).probeRequired, false);
    assert.equal(scheduler.getSnapshot().inFlight, 0);
});
