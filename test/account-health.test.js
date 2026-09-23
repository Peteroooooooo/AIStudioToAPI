const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AccountHealth = require("../src/auth/AccountHealth");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "account-health-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const clock = { value: 1_700_000_000_000 };
    const filePath = path.join(directory, "health.json");
    return { clock, filePath, health: new AccountHealth(logger, filePath, () => clock.value) };
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

test("429 cooldown persists, expires, and can be disabled manually", t => {
    const { clock, filePath, health } = fixture(t);
    health.recordFailure(2, 429, "r1");
    assert.equal(health.getStatus(2).until, clock.value + 5 * 60_000);
    const restored = new AccountHealth(logger, filePath, () => clock.value);
    assert.equal(restored.getStatus(2).mode, "cooldown");
    restored.recordFailure(2, 429, "r2");
    assert.equal(restored.getStatus(2).until, clock.value + 10 * 60_000);
    clock.value += 10 * 60_000 + 1;
    assert.equal(restored.getStatus(2).mode, "active");
    restored.recordSuccess(2);
    restored.setDisabled(2, true);
    assert.equal(restored.isAvailable(2), false);
    restored.setDisabled(2, false);
    assert.equal(restored.isAvailable(2), true);
});

test("transient 503 failures need three attempts before cooldown", t => {
    const { health } = fixture(t);
    health.recordFailure(3, 503, "r1");
    health.recordFailure(3, 503, "r2");
    assert.equal(health.isAvailable(3), true);
    health.recordFailure(3, 503, "r3");
    assert.equal(health.getStatus(3).mode, "cooldown");
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
