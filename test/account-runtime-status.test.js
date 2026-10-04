const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const AccountScheduler = require("../src/core/AccountScheduler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const labels = import(
    `data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(__dirname, "../ui/app/utils/runtimeLabels.js"), "utf8"))}`
);

function fixture() {
    const registry = new ConnectionRegistry(logger);
    const handler = {
        authSource: { health: { getStatus: () => ({}), isAvailable: () => true } },
        browserManager: { getReadyAccountIndices: () => [1], isAccountReady: () => true },
        config: {},
        connectionRegistry: registry,
        logger,
        timeouts: { FAKE_STREAM: 1000 },
    };
    const scheduler = new AccountScheduler(handler);
    const proxy = { body: "{}", is_generative: true, method: "POST", path: "/generateContent", request_id: "current" };
    return { proxy, registry, scheduler };
}

test("terminal queues and conversation ownership cannot leave an account generating", async () => {
    const { registry, scheduler, proxy } = fixture();
    await scheduler.acquire(proxy);
    registry.createMessageQueue("current", 1, "attempt");
    registry.markRequestDispatched("current", 1, "attempt");
    registry.endRequestAttempt("current", { healthFailure: false, outcome: "success", statusCode: 200 });
    assert.equal(registry.getAccountActivity(1).generation, 0);
    assert.equal(scheduler.getAccountRuntimeState(1).phase, "finishing");
    scheduler.release("current");
    const { accountStatus } = await labels;
    const account = {
        activity: registry.getAccountActivity(1),
        health: {},
        inFlight: 1,
        lastTest: { status: "success" },
        poolMember: true,
        runtime: { state: "ready" },
        slot: scheduler.getAccountRuntimeState(1),
    };
    assert.equal(accountStatus(account).state, "enabled");
    assert.equal(account.slot.conversations, 1);
    registry.removeMessageQueue("current");
});

test("a completed first request and its queued continuation have distinct live identities", async () => {
    const { registry, scheduler, proxy } = fixture();
    await scheduler.acquire(proxy, { sessionId: "chat" });
    const continuation = scheduler.acquire({ ...proxy, request_id: "next" }, { sessionId: "chat" });
    registry.createMessageQueue("current", 1, "a1");
    registry.markRequestDispatched("current", 1, "a1");
    const { accountExecution } = await labels;
    assert.equal(accountExecution({ slot: scheduler.getAccountRuntimeState(1) }).requestId, "current");
    registry.removeMessageQueue("current");
    scheduler.release("current");
    await continuation;
    registry.createMessageQueue("next", 1, "a2");
    registry.markRequestDispatched("next", 1, "a2");
    assert.equal(accountExecution({ slot: scheduler.getAccountRuntimeState(1) }).requestId, "next");
    scheduler.release("next");
    registry.removeMessageQueue("next");
});

test("test history does not override current activity or credential availability", async () => {
    const { accountStatus } = await labels;
    const account = { health: {}, lastTest: { status: "success" }, poolMember: true, runtime: { state: "ready" } };
    assert.equal(accountStatus(account).state, "enabled");
    assert.equal(accountStatus({ ...account, health: { mode: "disabled" } }).state, "disabled");
    assert.equal(accountStatus({ ...account, health: { mode: "cooldown" } }).state, "disabled");
    assert.equal(accountStatus({ ...account, health: { probeRequired: true } }).state, "enabled");
    assert.equal(accountStatus({ ...account, testRunning: true }).state, "processing");
    assert.equal(accountStatus({ ...account, lastTest: { status: "running" }, testRunning: false }).state, "enabled");
});

test("failed status refresh suppresses an old busy slot and marks the stale snapshot", async () => {
    const { accountStatus } = await labels;
    const account = {
        health: {},
        slot: { inFlight: 1, phase: "generating", requestId: "old" },
        statusStale: true,
    };
    assert.equal(accountStatus(account).state, "enabled");
    assert.equal(accountStatus({ ...account, statusStale: false }).state, "processing");
});

test("upstream stream completion stops generation accounting before response cleanup", () => {
    const { registry } = fixture();
    registry.createMessageQueue("current", 1, "attempt");
    registry.markRequestDispatched("current", 1, "attempt");
    registry._handleIncomingMessage(
        JSON.stringify({ event_type: "stream_close", request_attempt_id: "attempt", request_id: "current" }),
        1
    );
    assert.equal(registry.getAccountActivity(1).total, 0);
    registry.removeMessageQueue("current");
});

test("only three main states remain, with concise connection notes", async () => {
    const { accountStatus, accountEnabled } = await labels;
    const account = {
        hasContext: true,
        health: { enabled: true, mode: "active" },
        poolMember: true,
        runtime: { state: "ready" },
    };
    assert.equal(accountStatus(account).note, null);
    for (const [state, note] of [
        ["standby", "accountNote_waitingSlot"],
        ["initializing", "accountNote_connecting"],
        ["reconnecting", "accountNote_connecting"],
        ["stalled", "accountNote_connectionError"],
    ]) {
        assert.equal(accountStatus({ ...account, runtime: { state } }).state, "enabled");
        assert.equal(accountStatus({ ...account, runtime: { state } }).note, note);
    }
    const off = { ...account, health: { disabledBy: "auto", enabled: false, mode: "disabled", until: 1000 } };
    assert.equal(accountStatus(off).state, "disabled");
    assert.equal(accountStatus(off).note, "accountNote_autoDisabled");
    assert.equal(accountEnabled(off), false);
    assert.equal(accountStatus({ ...off, testRunning: true }).state, "processing");
    assert.equal(accountEnabled({ ...off, testRunning: true }), false);
    assert.equal(
        accountEnabled({ ...account, health: { ...account.health, probeInFlight: true }, isRotation: false }),
        true
    );
});
