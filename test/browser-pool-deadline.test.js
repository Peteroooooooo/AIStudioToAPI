const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const BrowserManager = require("../src/core/BrowserManager");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const never = () => new Promise(() => {});
const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fixture(t, indices = [1, 4, 13, 14, 21]) {
    const connected = new Set();
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, {
        _accountReadyTasks: new Map(),
        _accountTestSettleMs: 0,
        _authUpdateSuspended: new Set(),
        _authUpdateTasks: new Map(),
        _backgroundPreloadAbort: false,
        _backgroundPreloadTask: null,
        _cleanupTimeoutMs: 5,
        _closingPendingContexts: new Map(),
        _contextInitTimeoutMs: 80,
        _currentAuthIndex: -1,
        _webSocketInitTimeoutMs: 20,
        _wsInitState: new Map(),
        abortedContexts: new Set(),
        authSource: {
            getAuth: () => ({ cookies: [], origins: [] }),
            getCanonicalIndex: index => index,
            getRotationIndices: () => indices,
            health: { getStatus: () => ({ mode: "active" }), isAvailable: () => true },
            initialIndices: indices,
            isExpired: () => false,
            pendingRefreshIndices: new Set(),
        },
        browser: {},
        config: { maxContexts: 4 },
        connectionRegistry: {
            closeMessageQueuesForAuth() {},
            getConnectionByAuth: index => (connected.has(index) ? {} : null),
            hasMessageQueueForAuth: () => false,
            isAccountConnected: index => connected.has(index),
        },
        contexts: new Map(),
        initializingContexts: new Set(),
        logger,
        pendingContextClosures: new Map(),
        stickyProxyManager: { getProxyForAuth: () => null },
    });
    manager._getPrivacyProtectionScript = () => "";
    manager._navigateAndWakeUpPage = async () => {};
    manager._checkPageStatusAndErrors = async () => {};
    manager._saveDebugArtifacts = never;
    manager._updateAuthFile = async () => {};
    manager._startHealthMonitor = () => {};
    manager._startBackgroundWakeup = () => {};
    manager._sendActiveTrigger = () => {};
    manager._clickLaunchButtonIfVisible = async () => false;
    t.after(() => {
        manager._stopPoolMaintenance();
        for (const token of manager._initializationTokens?.values() || []) token.cancel?.();
    });
    return { connected, manager };
}

function contextFixture() {
    const callbacks = new Map();
    const page = {
        close: async () => {},
        evaluate: never,
        isClosed: () => false,
        on: (event, callback) => callbacks.set(event, callback),
        title: async () => "AI Studio",
        url: () => "https://aistudio.google.com/apps",
    };
    let closed = 0;
    const context = {
        addInitScript: async () => {},
        close: async () => closed++,
        newPage: async () => page,
    };
    return {
        callbacks,
        get closed() {
            return closed;
        },
        context,
        page,
    };
}

test("standby request tests use one temporary browser without evicting or joining the serving pool", async t => {
    const { connected, manager } = fixture(t);
    const temp = contextFixture();
    manager.config.maxContexts = 1;
    manager.contexts.set(1, { context: {}, page: { isClosed: () => false } });
    connected.add(1);
    manager._ensureBrowser = async () => {};
    manager.browser.newContext = async () => temp.context;
    manager._installHostedClient = async () => {};
    manager._waitForWebSocketInit = async () => {
        connected.add(4);
        return true;
    };
    manager.connectionRegistry.closeConnectionByAuth = index => connected.delete(index);
    const result = await manager.withAccountTestConnection(4, async () => {
        assert.equal(manager.contexts.has(1), true);
        assert.equal(manager.contexts.has(4), false);
        assert.equal(manager.isAccountReady(4), false);
        assert.deepEqual(manager.getReadyAccountIndices(), [1]);
        assert.equal(manager.isConnectionGenerationCurrent(4, manager._accountTestConnection.generation), true);
        assert.equal(await manager.ensureAccountReady(4), false);
        return "OK";
    });
    assert.equal(result, "OK");
    assert.equal(temp.closed, 1);
    assert.equal(connected.has(4), false);
    assert.equal(manager._accountTestConnection, null);
    assert.deepEqual(manager.getReadyAccountIndices(), [1]);
});

test("standby testing waits for an iframe socket replacement to settle before generation", async t => {
    const { connected, manager } = fixture(t);
    const temp = contextFixture();
    let socket = {},
        polls = 0;
    manager._accountTestSettleMs = 40;
    manager._ensureBrowser = async () => {};
    manager.browser.newContext = async () => temp.context;
    manager._installHostedClient = async () => {};
    manager._waitForWebSocketInit = async () => {
        connected.add(4);
        return true;
    };
    manager.connectionRegistry.getConnectionByAuth = () => socket;
    manager.connectionRegistry.closeConnectionByAuth = index => connected.delete(index);
    temp.page.waitForTimeout = async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        if (++polls === 1) socket = {};
    };
    await manager.withAccountTestConnection(4, async () => assert.ok(polls >= 3));
    assert.equal(temp.closed, 0);
    assert.equal(manager.contexts.get(4).context, temp.context);
});

test("standby testing handles Launch after the socket opens, before sending generation", async t => {
    const { connected, manager } = fixture(t);
    const temp = contextFixture();
    manager._accountTestSettleMs = 10;
    manager._ensureBrowser = async () => {};
    manager.browser.newContext = async () => temp.context;
    manager._installHostedClient = async () => {};
    const events = [];
    manager._waitForWebSocketInit = async () => {
        connected.add(4);
        events.push("socket");
        return true;
    };
    manager.connectionRegistry.getConnectionByAuth = () => socket;
    const socket = {};
    manager.connectionRegistry.closeConnectionByAuth = index => connected.delete(index);
    manager._sendActiveTrigger = (_prefix, page) => {
        assert.equal(page, temp.page);
        events.push("wake");
    };
    manager._clickLaunchButtonIfVisible = async page => {
        assert.equal(page, temp.page);
        events.push("launch");
        return true;
    };
    temp.page.waitForTimeout = async () => new Promise(resolve => setTimeout(resolve, 15));
    await manager.withAccountTestConnection(4, async () => events.push("generate"));
    assert.deepEqual(events, ["socket", "wake", "launch", "generate"]);
    assert.equal(temp.closed, 0);
    assert.equal(manager.contexts.get(4).context, temp.context);
});

test("standby test startup timeout closes its browser and clears the temporary reservation", async t => {
    const { manager } = fixture(t);
    const temp = contextFixture();
    manager._ensureBrowser = async () => {};
    manager.browser.newContext = async () => temp.context;
    manager._installHostedClient = async () => {};
    manager._navigateAndWakeUpPage = never;
    manager.connectionRegistry.closeConnectionByAuth = () => {};
    await assert.rejects(
        manager.withAccountTestConnection(4, () => assert.fail("No generation before readiness"), { timeoutMs: 15 }),
        error => error.reason === "startup_timeout"
    );
    assert.equal(temp.closed, 1);
    assert.equal(manager._accountTestConnection, null);
});

test("cancelling a standby test closes late context creation and prevents generation", async t => {
    const { manager } = fixture(t);
    const temp = contextFixture();
    let finishContext;
    manager._ensureBrowser = async () => {};
    manager.browser.newContext = () =>
        new Promise(resolve => {
            finishContext = resolve;
        });
    manager.connectionRegistry.closeConnectionByAuth = () => {};
    const controller = new AbortController();
    const pending = manager.withAccountTestConnection(4, () => assert.fail("Cancelled test must not dispatch"), {
        signal: controller.signal,
    });
    await flush();
    controller.abort();
    await assert.rejects(pending, error => error.reason === "cancelled");
    finishContext(temp.context);
    await flush();
    assert.equal(temp.closed, 1);
    assert.equal(manager._accountTestConnection, null);
});

test("hosted app bundle is replaced locally and the actual client sends its generation", async t => {
    const { manager } = fixture(t);
    const sockets = [];
    class NativeWebSocket {
        constructor(...args) {
            sockets.push(args);
        }
        addEventListener(event, callback) {
            if (event === "open") queueMicrotask(callback);
        }
    }
    let handler;
    await manager._installHostedClient(
        {
            route: async (pattern, callback) => {
                assert.equal(pattern, "https://ais-*.run.app/assets/index-*.js");
                handler = callback;
            },
        },
        1,
        "generation-one"
    );
    let replacement;
    await handler({
        fulfill: async result => {
            replacement = result;
        },
        request: () => ({ resourceType: () => "script" }),
    });
    const classStart = replacement.body.indexOf("class ConnectionManager extends EventTarget");
    const classEnd = replacement.body.indexOf("class RequestProcessor", classStart);
    const window = {};
    const sandbox = {
        CustomEvent: class extends Event {},
        EventTarget,
        Logger: { debug() {}, output() {} },
        WebSocket: NativeWebSocket,
        window,
    };
    vm.runInNewContext(replacement.body.slice(0, replacement.body.indexOf("/**")), sandbox);
    const connection = vm.runInNewContext(
        replacement.body.slice(classStart, classEnd) + "\nnew ConnectionManager()",
        sandbox
    );
    await connection.establish();
    assert.equal(new URL(sockets[0][0]).searchParams.get("contextGeneration"), "generation-one");
    assert.equal(new URL(sockets[0][0]).searchParams.get("authIndex"), "1");
    assert.equal(replacement.contentType, "application/javascript");
    let continued = false;
    await handler({
        continue: async () => {
            continued = true;
        },
        request: () => ({ resourceType: () => "fetch" }),
    });
    assert.equal(continued, true);
});

test("client console success cannot complete initialization after server rejects its socket", async t => {
    const { manager } = fixture(t);
    const entry = contextFixture();
    manager._wsInitState.set(1, { success: true });
    await assert.rejects(manager._waitForWebSocketInit(entry.page, "[Context#1]", 10, 1, true), /deadline/);
    assert.equal(manager.connectionRegistry.isAccountConnected(1), false);
});

test("cancelling initialization during credential refresh stays standby without failure backoff", async t => {
    const { manager, connected } = fixture(t);
    const entry = contextFixture();
    manager.browser.newContext = async () => entry.context;
    manager._waitForWebSocketInit = async () => {
        connected.add(1);
        return true;
    };
    let saving;
    const reachedSave = new Promise(resolve => {
        saving = resolve;
    });
    let monitors = 0;
    manager._startHealthMonitor = () => monitors++;
    manager._updateAuthFile = () => {
        saving();
        return never();
    };
    manager.initializingContexts.add(1);
    const pending = manager._initializeContext(1, true);
    await reachedSave;
    manager._initializationTokens.get(1).cancel();
    await assert.rejects(pending, /cancelled/);
    connected.delete(1);
    assert.equal(manager.getAccountRuntimeState(1).state, "standby");
    assert.equal(manager.getAccountRuntimeState(1).nextRetryAt, null);
    assert.equal(manager._candidateFailures.has(1), false);
    assert.equal(monitors, 0);
});

test("a slow credential refresh retains the accepted browser connection", async t => {
    const { manager, connected } = fixture(t);
    const entry = contextFixture();
    manager.browser.newContext = async () => entry.context;
    manager._waitForWebSocketInit = async () => {
        connected.add(1);
        return true;
    };
    manager._updateAuthFile = never;
    manager.initializingContexts.add(1);
    await manager._initializeContext(1, true);
    assert.equal(manager.isAccountReady(1), true);
    assert.equal(entry.closed, 0);
});

test("WebSocket deadline exits even when a page evaluate never settles and cleanup hangs", async t => {
    const { manager } = fixture(t);
    const entry = contextFixture();
    entry.context.close = never;
    manager.browser.newContext = async () => entry.context;
    manager.initializingContexts.add(1);
    await assert.rejects(manager._initializeContext(1, true), /deadline/);
    assert.equal(manager.initializingContexts.has(1), false);
    assert.equal(manager.contexts.has(1), false);
    const runtime = manager.getAccountRuntimeState(1);
    assert.equal(runtime.state, "stalled");
    assert.equal(runtime.phase, "websocket_continue");
    assert.ok(runtime.nextRetryAt > Date.now());
});

test("a late context creation is closed and cannot overwrite its replacement generation", async t => {
    const { manager } = fixture(t);
    manager._contextInitTimeoutMs = 15;
    let releaseOld;
    manager.browser.newContext = () =>
        new Promise(resolve => {
            releaseOld = resolve;
        });
    await assert.rejects(manager._initializeContext(1, true), /deadline/);
    const old = contextFixture();
    const current = contextFixture();
    manager._contextInitTimeoutMs = 80;
    manager.browser.newContext = async () => current.context;
    manager._waitForWebSocketInit = async () => true;
    await manager._initializeContext(1, true);
    releaseOld(old.context);
    await flush();
    assert.equal(old.closed, 1);
    assert.equal(manager.contexts.get(1).context, current.context);
});

test("late console events from a timed out page cannot mark the new initialization successful", async t => {
    const { manager } = fixture(t);
    const old = contextFixture();
    manager.browser.newContext = async () => old.context;
    await assert.rejects(manager._initializeContext(1, true), /deadline/);
    const current = contextFixture();
    manager.browser.newContext = async () => current.context;
    manager._waitForWebSocketInit = async () => true;
    await manager._initializeContext(1, true);
    manager._wsInitState.set(1, { failed: false, success: false });
    old.callbacks.get("console")({ text: () => "Connection successful", type: () => "info" });
    assert.equal(manager._wsInitState.get(1).success, false);
});

test("a running preload uses updated candidates after failure and fills four healthy accounts", async t => {
    const { manager, connected } = fixture(t);
    let failFirst;
    const attempted = [];
    manager._initializeContext = async index => {
        attempted.push(index);
        if (index === 1)
            await new Promise((_, reject) => {
                failFirst = reject;
            });
        connected.add(index);
        manager.contexts.set(index, { context: {}, page: { isClosed: () => false } });
        manager.initializingContexts.delete(index);
    };
    await manager._preloadBackgroundContexts([1], 4);
    const task = manager._backgroundPreloadTask;
    await flush();
    await manager._preloadBackgroundContexts([1, 4, 13, 14, 21], 4);
    failFirst(new Error("candidate failed"));
    await task;
    assert.deepEqual(attempted, [1, 4, 13, 14, 21]);
    assert.deepEqual(manager.getReadyAccountIndices(), [4, 13, 14, 21]);
    assert.equal(manager.getPoolSnapshot().shortfall, 0);
});

test("close proceeds when page identity, saved auth, and browser context close cannot settle", async t => {
    const { manager } = fixture(t);
    const entry = contextFixture();
    entry.page.title = never;
    entry.context.close = never;
    manager._updateAuthFile = never;
    manager.contexts.set(1, { context: entry.context, page: entry.page });
    manager.contexts.set(4, { context: {}, page: { isClosed: () => false } });
    await manager.closeContext(1);
    assert.equal(manager.contexts.has(1), false);
    assert.equal(manager.contexts.has(4), true);
    assert.equal(manager._contextCloseTasks.size, 0);
});

test("a disconnected resident does not prevent replacements from filling four service slots", async t => {
    const { manager, connected } = fixture(t);
    manager.contexts.set(1, { context: {}, page: { isClosed: () => false } });
    manager.contexts.set(4, { context: {}, page: { isClosed: () => false } });
    connected.add(4);
    manager.closeContext = async index => manager.contexts.delete(index);
    manager._initializeContext = async index => {
        manager.contexts.set(index, { context: {}, page: { isClosed: () => false } });
        connected.add(index);
        manager.initializingContexts.delete(index);
    };
    await manager.rebalanceContextPool();
    await manager._backgroundPreloadTask;
    assert.equal(manager.contexts.has(1), false);
    assert.equal(manager.getReadyAccountIndices().length, 4);
});

test("transport failure immediately excludes an OPEN connection and keeps generation drain intact", async t => {
    const { manager, connected } = fixture(t);
    connected.add(1);
    manager.contexts.set(1, { context: {}, page: { isClosed: () => false } });
    manager.connectionRegistry.hasMessageQueueForAuth = index => index === 1;
    manager.browser = null;
    manager.markAccountTransportFailure(1, "no response");
    assert.equal(manager.isAccountReady(1), false);
    assert.equal(manager.pendingContextClosures.get(1), "transport_failure");
    assert.equal(manager.contexts.has(1), true);
});

test("pool maintenance refills after time-based health changes and stops during browser cleanup", async t => {
    const { manager } = fixture(t);
    t.mock.timers.enable({ apis: ["setInterval"] });
    let rebalances = 0;
    manager.rebalanceContextPool = async () => rebalances++;
    manager._startPoolMaintenance();
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(rebalances, 1);
    manager._cleanupAllContexts();
    t.mock.timers.tick(20000);
    await flush();
    assert.equal(rebalances, 1);
});

test("disabled accounts do not retain an old recovery error or retry countdown", t => {
    const { manager } = fixture(t);
    manager._ensurePoolState();
    manager.authSource.getRotationIndices = () => [1];
    manager.authSource.health.getStatus = index => ({ mode: index === 4 ? "disabled" : "active" });
    manager._transportFailedAccounts.add(4);
    manager._runtime(4, "stalled", "old timeout", "close_unresponsive_context", Date.now() + 30000);
    const status = manager.getAccountRuntimeState(4);
    assert.equal(status.state, "unavailable");
    assert.equal(status.reason, "disabled");
    assert.equal(status.phase, null);
    assert.equal(status.nextRetryAt, null);
    assert.equal(manager.getPoolSnapshot().stalled, 0);
});

test("pool counts follow the current configured limit after shrinking a busy resident pool", t => {
    const { manager, connected } = fixture(t);
    for (const index of [1, 4, 13, 14]) {
        connected.add(index);
        manager.contexts.set(index, { context: {}, page: { isClosed: () => false } });
    }
    manager.config.maxContexts = 2;
    assert.equal(manager.getPoolSnapshot().ready, 2);
    assert.equal(manager.getPoolSnapshot().target, 2);
    assert.equal(manager.getPoolSnapshot().shortfall, 0);
});

test("socket loss cannot retain the recorded ready label", t => {
    const { manager, connected } = fixture(t);
    manager.contexts.set(1, { context: {}, page: { isClosed: () => false } });
    connected.add(1);
    manager._runtime(1, "ready", null);
    assert.equal(manager.getAccountRuntimeState(1).state, "ready");
    connected.delete(1);
    assert.equal(manager.getAccountRuntimeState(1).state, "stalled");
});

test("real initialization skips a hung page and reaches four ready replacements", async t => {
    const { manager, connected } = fixture(t);
    let creatingIndex;
    manager.authSource.getAuth = index => {
        creatingIndex = index;
        return { cookies: [], origins: [] };
    };
    manager.browser.newContext = async () => {
        const index = creatingIndex;
        const entry = contextFixture();
        entry.page.evaluate = index === 1 ? never : async () => false;
        if (index !== 1) {
            manager._wsInitState.get(index).success = true;
            connected.add(index);
        }
        return entry.context;
    };
    await manager._preloadBackgroundContexts([1, 4, 13, 14, 21], 4);
    await manager._backgroundPreloadTask;
    assert.deepEqual(manager.getReadyAccountIndices(), [4, 13, 14, 21]);
    assert.equal(manager.initializingContexts.size, 0);
    assert.equal(manager.getPoolSnapshot().shortfall, 0);
});

test("connection generations reject old and missing handshakes while allowing current reconnects", async t => {
    const { manager } = fixture(t);
    const first = contextFixture();
    manager.browser.newContext = async () => first.context;
    manager._waitForWebSocketInit = async () => true;
    await manager._initializeContext(1, true);
    const original = manager._initializationTokens.get(1).generation;
    assert.equal(manager.isConnectionGenerationCurrent(1, original), true);
    assert.equal(manager.isConnectionGenerationCurrent(1, null), false);
    const replacement = contextFixture();
    manager.browser.newContext = async () => replacement.context;
    await manager._initializeContext(1, true);
    const current = manager._initializationTokens.get(1).generation;
    assert.notEqual(current, original);
    assert.equal(manager.isConnectionGenerationCurrent(1, original), false);
    assert.equal(manager.isConnectionGenerationCurrent(1, current), true);
    assert.equal(manager.isConnectionGenerationCurrent(1, current), true);
    manager._initializationTokens.get(1).cancel();
    assert.equal(manager.isConnectionGenerationCurrent(1, current), false);
});

test("closing the last cooled account keeps the maintenance browser for automatic refill", async t => {
    const { manager } = fixture(t);
    manager.authSource.availableIndices = [1];
    manager.authSource.getRotationIndices = () => [];
    const entry = contextFixture();
    manager.contexts.set(1, { context: entry.context, page: entry.page });
    let browserClosed = false;
    manager.closeBrowser = async () => {
        browserClosed = true;
    };
    await manager.closeContext(1);
    assert.equal(browserClosed, false);
    assert.equal(manager.contexts.size, 0);
    assert.ok(manager.browser);
});

test("pool rebalance cannot close a resident manual test before its generation slot is acquired", async t => {
    const { manager, connected } = fixture(t, [1]);
    manager.authSource.rotationIndices = [1];
    manager.authSource.getRotationIndices = () => [];
    manager.authSource.health.isAvailable = () => false;
    manager.authSource.health.isManualProbe = (_index, requestId) => requestId === "manual";
    manager.authSource.health.getStatus = () => ({ mode: "active", probeInFlight: true });
    const entry = contextFixture();
    connected.add(1);
    manager.contexts.set(1, { context: entry.context, page: entry.page });
    const result = await manager.withAccountTestConnection(
        1,
        async () => {
            await manager.rebalanceContextPool();
            assert.equal(manager.contexts.has(1), true);
            assert.equal(entry.closed, 0);
            assert.equal(await manager._closeContextForPoolIfPossible(1, "rebalance"), false);
            manager.pendingContextClosures.set(1, "rebalance");
            assert.equal(await manager._closePendingContextIfIdle(1), false);
            manager.pendingContextClosures.delete(1);
            return "OK";
        },
        { requestId: "manual" }
    );
    assert.equal(result, "OK");
    assert.equal(manager._accountTestReservations.size, 0);
});

test("stopped pages stay open with spare capacity and yield their place to enabled accounts", async t => {
    const { manager, connected } = fixture(t, [1, 4]);
    manager.authSource.rotationIndices = [1, 4];
    manager.authSource.getRotationIndices = () => [1];
    manager.authSource.health.getStatus = index => ({ mode: index === 4 ? "disabled" : "active" });
    manager.authSource.health.isAvailable = index => index === 1;
    for (const index of [1, 4]) {
        const entry = contextFixture();
        manager.contexts.set(index, { context: entry.context, page: entry.page });
        connected.add(index);
    }
    await manager.rebalanceContextPool();
    assert.equal(manager.contexts.has(4), true);
    assert.deepEqual(manager.getReadyAccountIndices(), [1]);
    manager.config.maxContexts = 1;
    manager.connectionRegistry.closeConnectionByAuth = index => connected.delete(index);
    await manager.rebalanceContextPool();
    assert.equal(manager.contexts.has(4), false);
    assert.equal(manager.contexts.has(1), true);
});

test("a stopped account's successful temporary test becomes reusable when capacity is spare", async t => {
    const { manager, connected } = fixture(t, [4]);
    manager.authSource.rotationIndices = [4];
    manager.authSource.getRotationIndices = () => [];
    manager.authSource.health.getStatus = () => ({ mode: "disabled" });
    manager.authSource.health.isAvailable = () => false;
    manager.authSource.health.isManualProbe = (_index, requestId) => requestId === "manual";
    manager._ensurePoolState();
    manager._initializationTokens.set(4, { cancelled: true, generation: "old" });
    const entry = contextFixture();
    let creations = 0;
    manager._ensureBrowser = async () => {};
    manager._installHostedClient = async () => {};
    manager.browser.newContext = async () => {
        creations++;
        return entry.context;
    };
    manager.connectionRegistry.closeConnectionByAuth = index => connected.delete(index);
    manager._waitForWebSocketInit = async () => {
        connected.add(4);
        return true;
    };
    assert.equal(await manager.withAccountTestConnection(4, async () => "OK", { requestId: "manual" }), "OK");
    const generation = manager.contexts.get(4).generation;
    assert.equal(entry.closed, 0);
    assert.equal(manager.isConnectionGenerationCurrent(4, generation), true);
    assert.equal(manager.isConnectionGenerationCurrent(4, "old"), false);
    await manager.rebalanceContextPool();
    assert.equal(
        await manager.withAccountTestConnection(4, async () => "OK again", { requestId: "manual" }),
        "OK again"
    );
    assert.equal(creations, 1);
    manager._initializationTokens.set(4, { cancelled: false, generation: "replacement" });
    assert.equal(manager.isConnectionGenerationCurrent(4, generation), false);
    assert.equal(manager.isConnectionGenerationCurrent(4, "replacement"), true);
    manager._initializationTokens.delete(4);
});

test("a stopped but disconnected page is reclaimed rather than reported as reusable", async t => {
    const { manager } = fixture(t, [4]);
    manager.authSource.rotationIndices = [4];
    manager.authSource.getRotationIndices = () => [];
    manager.authSource.health.getStatus = () => ({ mode: "disabled" });
    const entry = contextFixture();
    manager.contexts.set(4, { context: entry.context, page: entry.page });
    manager.connectionRegistry.closeConnectionByAuth = () => {};
    await manager.rebalanceContextPool();
    assert.equal(manager.contexts.has(4), false);
});
