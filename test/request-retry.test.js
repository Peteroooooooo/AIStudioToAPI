const test = require("node:test");
const assert = require("node:assert/strict");

const RequestHandler = require("../src/core/RequestHandler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function handlerWithQueue(message) {
    let forwarded = 0;
    const browserManager = { currentAuthIndex: 1 };
    const authSource = {
        getRotationIndices: () => [1],
        health: { isAvailable: () => true },
    };
    const registry = { getAuthIndexForRequest: () => 1 };
    const config = {
        immediateSwitchStatusCodes: [429, 503],
        maxRetries: 3,
        retryDelay: 0,
    };
    const handler = new RequestHandler({}, registry, logger, browserManager, config, authSource);
    handler._forwardRequest = () => {
        forwarded++;
    };
    handler._cancelCurrentAttemptBeforeRetry = () => {};
    const queue = { dequeue: async () => message };
    return { authSource, browserManager, getForwarded: () => forwarded, handler, queue };
}

test("request format errors are returned after one backend attempt", async () => {
    const { handler, queue, getForwarded } = handlerWithQueue({
        authIndex: 1,
        event_type: "error",
        message: "Invalid argument",
        status: 400,
    });
    const result = await handler._executeRequestWithRetries(
        { path: "/models/x:generateContent", request_id: "r" },
        queue
    );
    assert.equal(result.success, false);
    assert.equal(result.error.skipAccountSwitch, true);
    assert.equal(getForwarded(), 1);
});

test("no available account ends immediate retry without a switch", async () => {
    const { handler, authSource } = handlerWithQueue({});
    authSource.getRotationIndices = () => [];
    const result = await handler._performImmediateSwitchRetry(
        { status: 429 },
        "r",
        handler._createImmediateSwitchTracker(1)
    );
    assert.equal(result, false);
});

test("a late error from another account does not switch the current account", async () => {
    const { handler } = handlerWithQueue({});
    await handler.authSwitcher.handleRequestFailureAndSwitch({ authIndex: 2, status: 503 }, null);
    assert.equal(handler.authSwitcher.failureCount, 0);
});
