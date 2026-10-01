const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const BrowserManager = require("../src/core/BrowserManager");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const AuthSwitcher = require("../src/auth/AuthSwitcher");
const StatusRoutes = require("../src/routes/StatusRoutes");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

function managerFixture() {
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, {
        _accountReadyTasks: new Map(),
        _authUpdateSuspended: new Set(),
        _backgroundPreloadTask: null,
        _closingPendingContexts: new Map(),
        _currentAuthIndex: 0,
        _poolReadyTask: null,
        _rebalanceTask: null,
        authSource: {
            getCanonicalIndex: index => index,
            getRotationIndices: () => [0, 1, 2, 3],
            health: { isAvailable: () => true },
            isExpired: () => false,
            pendingRefreshIndices: new Set(),
            setPendingRefresh(index, pending) {
                if (pending) this.pendingRefreshIndices.add(index);
                else this.pendingRefreshIndices.delete(index);
            },
        },
        browser: {},
        config: { maxContexts: 4 },
        contexts: new Map(),
        initializingContexts: new Set(),
        logger,
        pendingContextClosures: new Map(),
    });
    manager.connectionRegistry = new ConnectionRegistry(logger, null, () => manager.currentAuthIndex, manager);
    return manager;
}

function addReady(manager, index, page = {}) {
    manager.contexts.set(index, { context: {}, page: { isClosed: () => false, ...page } });
    const socket = new EventEmitter();
    socket.readyState = 1;
    socket.close = () => {};
    manager.connectionRegistry.addConnection(socket, { authIndex: index });
    return socket;
}

test("all pool members stay ready independently of the compatibility current and another account reconnect", () => {
    const manager = managerFixture();
    for (let index = 0; index < 4; index++) addReady(manager, index);
    manager._currentAuthIndex = 0;
    manager._isSystemBusyProvider = () => true;
    manager.connectionRegistry.reconnectingAccounts.set(0, true);
    assert.deepEqual(manager.getReadyAccountIndices(), [1, 2, 3]);
    assert.equal(manager.connectionRegistry.isReconnectingInProgress(1), false);
    assert.equal(manager.connectionRegistry.isAccountConnected(2), true);
});

test("ready accounts answer without waiting for slow background pool launches", async () => {
    const manager = managerFixture();
    addReady(manager, 1);
    manager.rebalanceContextPool = () => new Promise(() => {});
    assert.deepEqual(await manager.ensureAccountPoolReady(), [1]);
});

test("two concurrent readiness calls initialize one account and preserve current", async () => {
    const manager = managerFixture();
    let initialized = 0;
    let release;
    manager._ensureBrowser = async () => {};
    manager._initializeContext = async index => {
        initialized++;
        await new Promise(resolve => {
            release = resolve;
        });
        addReady(manager, index);
    };
    const first = manager.ensureAccountReady(2);
    const second = manager.ensureAccountReady(2);
    await flush();
    assert.equal(initialized, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(manager.currentAuthIndex, 0);
});

test("account reconnect never navigates a page with generation or maintenance in flight", async () => {
    const manager = managerFixture();
    addReady(manager, 1);
    manager.connectionRegistry.createMessageQueue("cache-maintenance", 1);
    manager._navigateAndWakeUpPage = async () => assert.fail("active page navigated");
    assert.equal(await manager.attemptLightweightReconnect(1), false);
    manager.connectionRegistry.removeMessageQueue("cache-maintenance");
    manager.setAccountLoadProvider(index => ({ inFlight: index === 1 ? 1 : 0 }));
    assert.equal(await manager.attemptLightweightReconnect(1), false);
});

test("every resident page gets a health monitor, with active pages excluded from reload buttons", async t => {
    const manager = managerFixture();
    const visits = [];
    t.mock.timers.enable({ apis: ["setInterval"] });
    for (let index = 0; index < 3; index++) {
        addReady(manager, index, {
            evaluate: async () => visits.push(index),
            viewportSize: () => ({ height: 800, width: 1200 }),
        });
        manager._startHealthMonitor(index);
    }
    manager._simulateHumanMovement = async () => {};
    manager.connectionRegistry.createMessageQueue("generation", 1);
    t.mock.timers.tick(4000);
    await flush();
    assert.equal(visits.includes(0), true);
    assert.equal(visits.includes(2), true);
    assert.equal(visits.includes(1), false);
    for (const entry of manager.contexts.values()) clearInterval(entry.healthMonitorInterval);
});

test("wakeup loops serve non-current accounts and follow their own pages", async t => {
    const manager = managerFixture();
    const visits = [];
    t.mock.timers.enable({ apis: ["setTimeout"] });
    manager._simulateHumanMovement = async () => {};
    for (let index = 0; index < 2; index++) {
        addReady(manager, index, {
            bringToFront: async () => visits.push(index),
            evaluate: async () => ({ found: false }),
            viewportSize: () => ({ height: 800, width: 1200 }),
        });
    }
    const wakeups = [manager._startBackgroundWakeup(0), manager._startBackgroundWakeup(1)];
    t.mock.timers.tick(1500);
    await flush();
    assert.deepEqual(visits.sort(), [0, 1]);
    manager.contexts.clear();
    t.mock.timers.tick(1500);
    await Promise.all(wakeups);
});

test("pool rebalance retains healthy residents and defers unhealthy active current closure", async () => {
    const manager = managerFixture();
    for (let index = 0; index < 3; index++) addReady(manager, index);
    manager.authSource.getRotationIndices = () => [1, 2, 3];
    manager.connectionRegistry.createMessageQueue("generation", 0);
    manager._preloadBackgroundContexts = async () => {};
    manager.closeContext = async index => manager.contexts.delete(index);
    await manager.rebalanceContextPool();
    assert.equal(manager.contexts.has(0), true);
    assert.equal(manager.pendingContextClosures.has(0), true);
    manager.connectionRegistry.removeMessageQueue("generation");
    await manager._closePendingContextIfIdle(0);
    assert.equal(manager.contexts.has(0), false);
    assert.equal(manager.contexts.has(1), true);
});

test("late removal of a superseded websocket does not disconnect its replacement", () => {
    const manager = managerFixture();
    const oldSocket = addReady(manager, 1);
    const newSocket = addReady(manager, 1);
    manager.connectionRegistry._removeConnection(oldSocket);
    assert.equal(manager.connectionRegistry.getConnectionByAuth(1), newSocket);
    assert.equal(manager.connectionRegistry.isAccountConnected(1), true);
});

test("a cooled draining account does not prevent a replacement from filling serving capacity", async () => {
    const manager = managerFixture();
    manager.config.maxContexts = 2;
    addReady(manager, 0);
    addReady(manager, 1);
    manager.authSource.getRotationIndices = () => [1, 2];
    manager.connectionRegistry.createMessageQueue("old-generation", 0);
    let preload;
    manager._preloadBackgroundContexts = async (indices, cap) => {
        preload = { cap, indices };
    };
    await manager.rebalanceContextPool();
    assert.equal(manager.contexts.has(0), true);
    assert.deepEqual(preload, { cap: 2, indices: [2] });
    assert.equal(manager._getServingPoolOccupancy(), 1);
});

test("use thresholds do not trigger healthy multi-account session migrations", () => {
    const authSource = { getRotationIndices: () => [0, 1] };
    const switcher = new AuthSwitcher(logger, { switchOnUses: 50 }, authSource, { currentAuthIndex: 0 });
    switcher.usageCount = 100;
    assert.equal(switcher.shouldSwitchByUsage(), false);
});

function routesFixture() {
    const manager = managerFixture();
    const routes = Object.create(StatusRoutes.prototype);
    const handlers = new Map();
    const changes = [];
    const removed = [];
    const closed = [];
    const scheduler = {
        getAccountLoad: index => ({ inFlight: index === 1 ? 1 : 0 }),
        notifyAccountChange: index => changes.push(index),
    };
    manager.authSource.availableIndices = [0, 1, 2];
    manager.authSource.initialIndices = [0, 1, 2];
    manager.authSource.removeAuth = index => removed.push(index);
    manager.authSource.reloadAuthSources = () => false;
    manager.authSource.health.setDisabled = () => ({});
    manager.abortBackgroundPreload = async () => {};
    manager.rebalanceContextPool = async () => {};
    manager.closeContext = async index => closed.push(index);
    routes.serverSystem = {
        accountScheduler: scheduler,
        authSource: manager.authSource,
        browserManager: manager,
        connectionRegistry: manager.connectionRegistry,
        requestHandler: { currentAuthIndex: 0, isSystemBusy: false },
    };
    routes.logger = logger;
    routes.config = {};
    const app = {};
    for (const method of ["get", "post", "put", "delete"])
        app[method] = (path, ...callbacks) => handlers.set(`${method} ${path}`, callbacks.at(-1));
    routes.setupRoutes(app, () => {});
    const response = {
        json(value) {
            this.body = value;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
    };
    return { changes, closed, handlers, removed, response, routes };
}

test("deleting a busy non-current account requires force and preserves its running requests", async () => {
    const { handlers, removed, closed, response } = routesFixture();
    await handlers.get("delete /api/accounts/:index")({ params: { index: "1" }, query: {} }, response);
    assert.equal(response.statusCode, 409);
    assert.deepEqual(removed, []);
    assert.deepEqual(closed, []);
});

test("forced deletion notifies queued sessions and only closes the selected account", async () => {
    const { changes, handlers, removed, closed, response, routes } = routesFixture();
    await handlers.get("delete /api/accounts/:index")({ params: { index: "1" }, query: { force: "true" } }, response);
    assert.deepEqual(removed, [1]);
    assert.deepEqual(changes, [1]);
    assert.deepEqual(closed, [1]);
    assert.equal(routes.serverSystem.requestHandler.isSystemBusy, false);
});

test("disabling a busy account changes eligibility without switching or cancelling other accounts", async () => {
    const { changes, handlers, closed, response, routes } = routesFixture();
    routes.serverSystem.requestHandler._switchToNextAuth = () => assert.fail("global switch");
    await handlers.get("put /api/accounts/:index/health")(
        { body: { action: "disable" }, params: { index: "1" } },
        response
    );
    assert.deepEqual(changes, [1]);
    assert.deepEqual(closed, []);
});

test("batch deletion of any busy pool member requires force", async () => {
    const { handlers, closed, removed, response } = routesFixture();
    await handlers.get("delete /api/accounts/batch")({ body: { indices: [1, 2] } }, response);
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body.busyIndices, [1]);
    assert.deepEqual(removed, []);
    assert.deepEqual(closed, []);
});

test("reauthentication drains generation before closing and refreshes only its account", async () => {
    const manager = managerFixture();
    addReady(manager, 1);
    let inFlight = 1;
    const changes = [];
    const closed = [];
    manager.setAccountLoadProvider(() => ({ inFlight }));
    manager.setAccountChangeNotifier(index => changes.push(index));
    manager.rebalanceContextPool = async () => {};
    manager.closeContext = async index => {
        closed.push(index);
        manager.contexts.delete(index);
    };
    assert.deepEqual(await manager.refreshContextAfterReauth(1), { deferred: true });
    assert.equal(manager.isAccountReady(1), false);
    assert.deepEqual(closed, []);
    assert.deepEqual(changes, [1]);
    inFlight = 0;
    await manager._closePendingContextIfIdle(1);
    assert.deepEqual(closed, [1]);
    assert.equal(manager.authSource.pendingRefreshIndices.has(1), false);
});
