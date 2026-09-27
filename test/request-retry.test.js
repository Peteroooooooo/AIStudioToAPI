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

test("new requests switch away from an expired current account", async () => {
    const { handler, authSource, browserManager } = handlerWithQueue({});
    const errors = [];
    let switches = 0;
    authSource.isExpired = index => index === 1;
    authSource.getRotationIndices = () => [2];
    handler.authSwitcher.switchToNextAuth = async () => {
        switches++;
        browserManager.currentAuthIndex = 2;
        return { success: true };
    };
    handler.connectionRegistry.getConnectionByAuth = index => (index === 2 ? {} : null);
    handler._waitForSystemAndConnectionIfBusy = async () => true;
    handler._sendErrorResponse = (...args) => errors.push(args);
    browserManager.notifyUserActivity = () => {};

    const ready = await handler._ensureBrowserBackedRequestReady({});
    assert.equal(ready, true);
    assert.equal(switches, 1);
    assert.equal(errors.length, 0);
});

test("new requests never enter a current context pending reauthentication refresh", async () => {
    const { handler, authSource } = handlerWithQueue({});
    const errors = [];
    authSource.pendingRefreshIndices = new Set([1]);
    authSource.getRotationIndices = () => [];
    handler._sendErrorResponse = (...args) => errors.push(args);

    const ready = await handler._ensureBrowserBackedRequestReady({});
    assert.equal(ready, false);
    assert.equal(errors[0][1], 503);
});
