const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AccountHealth = require("../src/auth/AccountHealth");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const ProxyServerSystem = require("../src/core/ProxyServerSystem");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function fixture(t, config = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "account-health-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const clock = { value: 1_700_000_000_000 };
    const filePath = path.join(directory, "health.json");
    return { clock, filePath, health: new AccountHealth(logger, filePath, () => clock.value, config) };
}

test("only repeated independent 401 failures require reauthentication", t => {
    const { health } = fixture(t);
    health.recordFailure(15, 400, "bad-request");
    health.recordFailure(15, 403, "permission");
    assert.equal(health.getStatus(15).mode, "active");
    health.recordFailure(15, 401, "request-1");
    health.recordFailure(15, 401, "request-1");
    assert.equal(health.getStatus(15).mode, "active");
    health.recordFailure(15, 401, "request-2");
    assert.equal(health.getStatus(15).mode, "reauth");
    assert.equal(health.isAvailable(15), false);
    health.reset(15);
    assert.equal(health.getStatus(15).mode, "active");
});

test("429 turns the switch off and restores it on the persisted deadline", t => {
    const { clock, filePath, health } = fixture(t);
    health.recordFailure(2, 429, "first");
    const until = clock.value + 5 * 60 * 60_000;
    assert.equal(health.getStatus(2).enabled, false);
    assert.equal(health.getStatus(2).disabledBy, "auto");
    assert.equal(health.getStatus(2).until, until);
    const restored = new AccountHealth(logger, filePath, () => clock.value);
    assert.equal(restored.getStatus(2).mode, "disabled");
    clock.value = until;
    assert.equal(restored.isAvailable(2), true);
    assert.equal(restored.getStatus(2).until, null);
    assert.equal(restored.getStatus(2).probeRequired, false);
    assert.equal(new AccountHealth(logger, filePath, () => clock.value).isAvailable(2), true);
});

test("manual on cancels the old timer, and manual off never automatically enables", t => {
    const { clock, filePath, health } = fixture(t, { rateLimitCooldownSeconds: 30 });
    health.recordFailure(2, 429, "quota");
    health.setDisabled(2, false);
    assert.equal(health.getStatus(2).enabled, true);
    assert.equal(health.getStatus(2).until, null);
    health.setDisabled(2, true);
    clock.value += 60_000;
    const restored = new AccountHealth(logger, filePath, () => clock.value);
    assert.equal(restored.getStatus(2).disabledBy, "manual");
    assert.equal(restored.isAvailable(2), false);
    assert.equal(restored.getStatus(2).until, null);
});

test("late outcomes cannot override manual enable or a timer-based enable", t => {
    const { clock, health } = fixture(t, { rateLimitCooldownSeconds: 30 });
    const epoch = health.getEpoch(2);
    health.recordFailure(2, 429, "first", epoch);
    const until = health.getStatus(2).until;
    clock.value += 10_000;
    health.recordFailure(2, 429, "late", epoch);
    health.recordSuccess(2, "late-success", epoch);
    assert.equal(health.getStatus(2).until, until);
    clock.value = until;
    health.recordFailure(2, 429, "very-late", epoch);
    assert.equal(health.getStatus(2).enabled, true);
    const current = health.getEpoch(2);
    health.setDisabled(2, false);
    health.recordFailure(2, 429, "before-manual", current);
    assert.equal(health.getStatus(2).enabled, true);
});

test("a new 429 after manual enable starts a new configured restore plan", t => {
    const config = { rateLimitCooldownSeconds: 30 };
    const { clock, health } = fixture(t, config);
    health.recordFailure(2, 429, "first");
    const until = health.getStatus(2).until;
    config.rateLimitCooldownSeconds = 90;
    assert.equal(health.getStatus(2).until, until);
    health.setDisabled(2, false);
    health.recordFailure(2, 429, "new", health.getEpoch(2));
    assert.equal(health.getStatus(2).disabledBy, "auto");
    assert.equal(health.getStatus(2).until, clock.value + 90_000);
});

test("legacy cooldowns migrate to automatic off without losing remaining time", t => {
    const { clock, filePath } = fixture(t);
    fs.writeFileSync(
        filePath,
        JSON.stringify({
            accounts: {
                2: { lastStatus: 429, mode: "cooldown", until: clock.value + 30_000 },
                3: { mode: "disabled" },
            },
            version: 1,
        })
    );
    const health = new AccountHealth(logger, filePath, () => clock.value);
    assert.equal(health.getStatus(2).mode, "disabled");
    assert.equal(health.getStatus(2).disabledBy, "auto");
    assert.equal(health.getStatus(3).disabledBy, "manual");
    clock.value += 30_000;
    assert.equal(health.isAvailable(2), true);
    assert.equal(health.isAvailable(3), false);
});

test("testing an off account preserves switch and restore time for success, failure and cancellation", t => {
    const { health } = fixture(t);
    health.recordFailure(2, 429, "quota", undefined, { model: "model-1" });
    const until = health.getStatus(2).until;
    for (const [requestId, result] of [
        ["passed", { success: true }],
        ["failed", { status: 429 }],
        ["permission-error", { status: 403 }],
        ["cancelled", {}],
    ]) {
        assert.equal(health.beginManualProbe(2, requestId, "model-1"), true);
        assert.equal(health.tryAcquireProbe(2, requestId), true);
        assert.equal(health.tryAcquireProbe(2, "ordinary"), false);
        health.finishManualProbe(2, requestId, result);
        assert.equal(health.getStatus(2).enabled, false);
        assert.equal(health.getStatus(2).until, until);
        assert.equal(health.getStatus(2).disabledStatus, 429);
    }
    health.setDisabled(2, true);
    health.beginManualProbe(2, "manual-off-test", "model-1");
    health.finishManualProbe(2, "manual-off-test", { success: true });
    assert.equal(health.getStatus(2).disabledBy, "manual");
    assert.equal(health.getStatus(2).enabled, false);
});

test("manual action during a test wins over its eventual failure", t => {
    const { health } = fixture(t);
    health.beginManualProbe(2, "test", "model-1");
    health.setDisabled(2, false);
    health.finishManualProbe(2, "test", { status: 429 });
    assert.equal(health.getStatus(2).enabled, true);
});

test("an expiring restore timer waits for the manual test to release its reservation", t => {
    const { clock, health } = fixture(t, { rateLimitCooldownSeconds: 1 });
    health.recordFailure(2, 429, "quota");
    health.beginManualProbe(2, "test", "model");
    clock.value += 1000;
    assert.equal(health.getStatus(2).enabled, false);
    assert.equal(health.isManualProbe(2, "test"), true);
    health.finishManualProbe(2, "test", { success: true });
    assert.equal(health.isAvailable(2), true);
});

test("three transient failures temporarily turn off, while a successful request resets their streak", t => {
    const { clock, health } = fixture(t);
    health.recordFailure(3, 503, "one");
    health.recordFailure(3, 503, "two");
    assert.equal(health.isAvailable(3), true);
    health.recordSuccess(3, "success");
    health.recordFailure(3, 503, "three");
    assert.equal(health.isAvailable(3), true);
    health.recordFailure(3, 503, "four");
    health.recordFailure(3, 503, "five");
    assert.equal(health.getStatus(3).disabledBy, "auto");
    clock.value = health.getStatus(3).until;
    assert.equal(health.isAvailable(3), true);
});

test("backend outcome belongs to its queue account and stale responses are ignored", t => {
    const { health } = fixture(t);
    const registry = new ConnectionRegistry(logger);
    registry.on("backendOutcome", outcome => {
        if (outcome.success) health.recordSuccess(outcome.authIndex);
        else health.recordFailure(outcome.authIndex, outcome.status, outcome.requestId);
    });
    registry.createMessageQueue("request-1", 1, "attempt-1");
    registry._handleIncomingMessage(
        JSON.stringify({
            event_type: "error",
            request_attempt_id: "attempt-1",
            request_id: "request-1",
            status: 429,
        }),
        2
    );
    assert.equal(health.isAvailable(1), true);
    registry._handleIncomingMessage(
        JSON.stringify({
            event_type: "error",
            request_attempt_id: "old-attempt",
            request_id: "request-1",
            status: 429,
        }),
        1
    );
    assert.equal(health.isAvailable(1), true);
    registry._handleIncomingMessage(
        JSON.stringify({
            event_type: "error",
            request_attempt_id: "attempt-1",
            request_id: "request-1",
            status: 429,
        }),
        1
    );
    assert.equal(health.isAvailable(1), false);
    assert.equal(health.isAvailable(2), true);
});

test("late outcomes from the old credential do not quarantine a reauthenticated account", t => {
    const { health } = fixture(t);
    const system = Object.create(ProxyServerSystem.prototype);
    system.authCredentialEpochs = new Map();
    system.authSource = { health };
    system.browserManager = { rebalanceContextPool: async () => {} };
    system.logger = logger;
    system.requestHandler = { cacheManager: { consumeCachedAttemptOutcome: () => false } };

    const registry = new ConnectionRegistry(logger, null, null, null, index => system.getAuthCredentialEpoch(index));
    registry.on("backendOutcome", outcome => system._recordBackendOutcome(outcome));
    registry.createMessageQueue("old-1", 3, "old-attempt-1");
    registry.createMessageQueue("old-2", 3, "old-attempt-2");

    system.advanceAuthCredentialEpoch(3);
    health.reset(3);
    for (const [requestId, requestAttemptId] of [
        ["old-1", "old-attempt-1"],
        ["old-2", "old-attempt-2"],
    ]) {
        registry._handleIncomingMessage(
            JSON.stringify({
                event_type: "error",
                request_attempt_id: requestAttemptId,
                request_id: requestId,
                status: 401,
            }),
            3
        );
    }
    assert.equal(health.getStatus(3).mode, "active");

    registry.createMessageQueue("new-1", 3, "new-attempt-1");
    registry._handleIncomingMessage(
        JSON.stringify({ event_type: "error", request_attempt_id: "new-attempt-1", request_id: "new-1", status: 429 }),
        3
    );
    assert.equal(health.getStatus(3).mode, "disabled");
});

test("cache maintenance only quarantines on current-credential 429 and never opens a recovery gate", async t => {
    const { clock, health } = fixture(t, { rateLimitCooldownSeconds: 1 });
    const system = Object.create(ProxyServerSystem.prototype);
    system.authCredentialEpochs = new Map();
    system.authSource = { health };
    const notifications = [];
    let rebalances = 0;
    system.browserManager = { rebalanceContextPool: async () => rebalances++ };
    system.logger = logger;
    system.requestHandler = {
        accountScheduler: { notifyAccountChange: index => notifications.push(index) },
        cacheManager: { consumeCachedAttemptOutcome: () => false },
    };
    const outcome = { authCredentialEpoch: 0, authIndex: 2, requestId: "cache_resource_1" };
    health.recordFailure(2, 503, "generation-failure");
    system._recordBackendOutcome({ ...outcome, success: true });
    system._recordBackendOutcome({ ...outcome, status: 401, success: false });
    system._recordBackendOutcome({ ...outcome, status: 503, success: false });
    assert.equal(health.getStatus(2).consecutiveFailures, 1);
    assert.equal(health.getStatus(2).mode, "active");
    system.advanceAuthCredentialEpoch(2);
    system._recordBackendOutcome({ ...outcome, status: 429, success: false });
    assert.equal(health.getStatus(2).mode, "active");
    system._recordBackendOutcome({ ...outcome, authCredentialEpoch: 1, status: 429, success: false });
    assert.equal(health.getStatus(2).mode, "disabled");
    assert.deepEqual(notifications, [2]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rebalances, 1);
    clock.value += 1000;
    assert.equal(health.tryAcquireProbe(2, "business-probe"), true);
    system._recordBackendOutcome({ ...outcome, authCredentialEpoch: 1, success: true });
    assert.equal(health.getStatus(2).probeRequired, false);
    system._recordBackendOutcome({
        ...outcome,
        authCredentialEpoch: 1,
        requestId: "business-probe",
        success: true,
    });
    assert.equal(health.getStatus(2).probeRequired, false);
    assert.deepEqual(notifications, [2]);
});

test("old maintenance failures cannot quarantine an account after its automatic restore", async t => {
    const { clock, health } = fixture(t, { rateLimitCooldownSeconds: 1 });
    const system = Object.create(ProxyServerSystem.prototype);
    system.authCredentialEpochs = new Map();
    system.authSource = { health };
    system.browserManager = { authSource: { health }, rebalanceContextPool: async () => {} };
    system.logger = logger;
    system.requestHandler = { cacheManager: { consumeCachedAttemptOutcome: () => false } };
    const registry = new ConnectionRegistry(logger, null, null, system.browserManager);
    registry.on("backendOutcome", outcome => system._recordBackendOutcome(outcome));
    const send = (requestId, eventType, status) =>
        registry._handleIncomingMessage(JSON.stringify({ event_type: eventType, request_id: requestId, status }), 2);
    registry.createMessageQueue("cache_resource_old", 2);
    registry.createMessageQueue("generation-429", 2);
    assert.equal(registry.messageQueues.get("generation-429").healthEpoch, 0);
    send("generation-429", "error", 429);
    assert.equal(health.getEpoch(2), 1);
    clock.value += 1000;
    assert.equal(health.tryAcquireProbe(2, "probe"), true);
    registry.createMessageQueue("probe", 2);
    assert.equal(registry.messageQueues.get("probe").healthEpoch, 2);
    send("probe", "stream_close");
    assert.equal(health.getEpoch(2), 2);
    assert.equal(health.getStatus(2).probeRequired, false);
    send("cache_resource_old", "error", 429);
    assert.equal(health.getStatus(2).mode, "active");
    assert.equal(health.getEpoch(2), 2);
    registry.createMessageQueue("new-generation", 2);
    send("new-generation", "error", 429);
    assert.equal(health.getStatus(2).mode, "disabled");
    assert.equal(health.getEpoch(2), 3);
    for (const requestId of [...registry.messageQueues.keys()]) registry.removeMessageQueue(requestId);
    await new Promise(resolve => setImmediate(resolve));
});

test("manual changes invalidate old outcomes without resetting epoch on account removal", t => {
    const { health } = fixture(t);
    const originalEpoch = health.getEpoch(2);
    health.setDisabled(2, true);
    health.setDisabled(2, false);
    health.recordFailure(2, 429, "old", originalEpoch);
    assert.equal(health.getStatus(2).mode, "active");
    const beforeReset = health.getEpoch(2);
    health.reset(2);
    health.recordFailure(2, 429, "before-reset", beforeReset);
    assert.equal(health.getStatus(2).mode, "active");
    const beforeRemoval = health.getEpoch(2);
    health.remove(2);
    health.recordFailure(2, 429, "before-removal", beforeRemoval);
    assert.equal(health.getStatus(2).mode, "active");
    assert.equal(health.getEpoch(2), beforeRemoval + 1);
});

test("token chunks from a stale or wrong-account attempt are discarded", () => {
    const registry = new ConnectionRegistry(logger);
    const chunks = [];
    registry.on("backendChunk", chunk => chunks.push(chunk));
    registry.createMessageQueue("request-token", 1, "attempt-2");
    const message = {
        data: 'data: {"usageMetadata":{"totalTokenCount":7}}\n\n',
        event_type: "chunk",
        request_attempt_id: "attempt-2",
        request_id: "request-token",
    };
    registry._handleIncomingMessage(JSON.stringify(message), 2);
    registry._handleIncomingMessage(JSON.stringify({ ...message, request_attempt_id: "attempt-1" }), 1);
    assert.equal(chunks.length, 0);
    registry._handleIncomingMessage(JSON.stringify(message), 1);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].requestAttemptId, "attempt-2");
    registry.removeMessageQueue("request-token");
});
