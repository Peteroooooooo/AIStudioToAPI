const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BrowserManager = require("../src/core/BrowserManager");
const AuthSource = require("../src/auth/AuthSource");
const { detectAccountEmail } = require("../src/auth/AuthPageIdentity");
const { isAuthExpiredError } = require("../src/utils/CustomErrors");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function loginPage(redirectAfterRetry) {
    let url = "https://accounts.google.com/ServiceLogin";
    return {
        goto: async () => {
            if (redirectAfterRetry) url = "https://ai.studio/apps/test";
        },
        title: async () => (url.includes("accounts.google.com") ? "Sign in" : "AI Studio"),
        url: () => url,
        waitForTimeout: async () => {},
    };
}

function identityPage(email) {
    let url = "https://ai.studio/apps/test";
    return {
        goto: async () => {
            url = "https://aistudio.google.com/apps";
        },
        locator: () => ({
            count: async () => 1,
            first: () => ({ getAttribute: async () => `Google Account: ${email}` }),
        }),
        on() {},
        title: async () => "Google AI Studio",
        url: () => url,
        waitForTimeout: async () => {},
    };
}

test("a transient Google sign-in redirect does not permanently expire an account", async () => {
    let marks = 0;
    const manager = Object.create(BrowserManager.prototype);
    manager.logger = logger;
    manager.targetUrl = "https://ai.studio/apps/test";
    manager._authUpdateSuspended = new Set();
    manager._markExpiredTasks = new Map();
    manager.authSource = {
        markAsExpired: async () => {
            marks++;
        },
    };
    await manager._checkPageStatusAndErrors(loginPage(true), "[Test]", 15);
    assert.equal(marks, 0);
});

test("persistent sign-in after retry marks the account expired once", async () => {
    let marks = 0;
    const manager = Object.create(BrowserManager.prototype);
    manager.logger = logger;
    manager.targetUrl = "https://ai.studio/apps/test";
    manager._authUpdateSuspended = new Set();
    manager._markExpiredTasks = new Map();
    manager.authSource = {
        markAsExpired: async () => {
            marks++;
        },
    };
    await assert.rejects(manager._checkPageStatusAndErrors(loginPage(false), "[Test]", 15), isAuthExpiredError);
    assert.equal(marks, 1);
});

test("expired recheck keeps loaded contexts and restores only after app readiness", async t => {
    const originalCwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auth-recheck-"));
    t.after(() => {
        process.chdir(originalCwd);
        fs.rmSync(directory, { force: true, recursive: true });
    });
    fs.mkdirSync(path.join(directory, "configs", "auth"), { recursive: true });
    const filePath = path.join(directory, "configs", "auth", "auth-15.json");
    fs.writeFileSync(
        filePath,
        JSON.stringify({ accountName: "account@example.com", cookies: [{ name: "old" }], expired: true, origins: [] })
    );
    process.chdir(directory);

    const authSource = Object.create(AuthSource.prototype);
    authSource.logger = logger;
    authSource.availableIndices = [1, 2, 15];
    authSource.expiredIndices = [15];
    authSource._buildRotationIndices = () => {};
    authSource.health = { getStatus: () => ({ mode: "active" }) };

    let evicted = null;
    let temporaryClosed = false;
    let poolRebalanced = false;
    const page = identityPage("account@example.com");
    const context = {
        addInitScript: async () => {},
        close: async () => {
            temporaryClosed = true;
        },
        newPage: async () => page,
    };
    const manager = Object.create(BrowserManager.prototype);
    manager._backgroundPreloadTask = null;
    manager._currentAuthIndex = 1;
    manager._expiredRecheckDueAt = new Map();
    manager._expiredRecheckFailures = new Map();
    manager._expiredRecheckAborted = false;
    manager._expiredRecheckIndex = null;
    manager._expiredRecheckTask = null;
    manager._wsInitState = new Map();
    manager.authSource = authSource;
    manager.browser = { newContext: async () => context };
    manager.config = { maxContexts: 2 };
    manager.contexts = new Map([
        [1, {}],
        [2, {}],
    ]);
    manager.initializingContexts = new Set();
    manager.logger = logger;
    manager.stickyProxyManager = { getProxyForAuth: () => null };
    manager._isSystemBusy = () => false;
    manager._hasActiveQueueForAuth = () => false;
    manager._navigateAndWakeUpPage = async () => {};
    manager._checkPageStatusAndErrors = async () => {};
    manager._waitForWebSocketInit = async () => true;
    manager._captureStorageState = async () => ({ cookies: [{ name: "renewed" }], origins: [] });
    manager._getPrivacyProtectionScript = () => "";
    manager.closeContext = async index => {
        evicted = index;
        manager.contexts.delete(index);
    };
    manager.rebalanceContextPool = async () => {
        poolRebalanced = true;
    };

    const result = await manager.recheckExpiredAccount(15);
    assert.deepEqual(result, { reason: "recovered", recovered: true });
    assert.equal(evicted, null);
    assert.equal(manager.contexts.has(1), true);
    assert.equal(manager.contexts.has(2), true);
    assert.equal(manager.contexts.has(15), false);
    assert.equal(temporaryClosed, true);
    assert.equal(poolRebalanced, true);
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf-8")).expired, undefined);
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf-8")).cookies[0].name, "renewed");
    if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("expired recheck leaves the account excluded while a request is active", async () => {
    const manager = Object.create(BrowserManager.prototype);
    manager._backgroundPreloadTask = null;
    manager._currentAuthIndex = 1;
    manager._expiredRecheckDueAt = new Map();
    manager._expiredRecheckFailures = new Map();
    manager._hasActiveQueueForAuth = () => true;
    manager._isSystemBusy = () => false;
    manager.authSource = { availableIndices: [1, 15], isExpired: () => true };
    manager.config = { maxContexts: 1 };
    manager.contexts = new Map([[1, {}]]);
    manager.initializingContexts = new Set();
    manager.logger = logger;
    const result = await manager.recheckExpiredAccount(15);
    assert.deepEqual(result, { reason: "busy", recovered: false });
    assert.equal(manager.contexts.has(1), true);
});

test("single-context pool can use one temporary idle probe without evicting the current account", async t => {
    const originalCwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auth-recheck-single-"));
    t.after(() => {
        process.chdir(originalCwd);
        fs.rmSync(directory, { force: true, recursive: true });
    });
    fs.mkdirSync(path.join(directory, "configs", "auth"), { recursive: true });
    fs.writeFileSync(
        path.join(directory, "configs", "auth", "auth-15.json"),
        JSON.stringify({ accountName: "account@example.com", expired: true })
    );
    process.chdir(directory);

    let temporaryClosed = false;
    let currentClosed = false;
    const page = identityPage("account@example.com");
    const manager = Object.create(BrowserManager.prototype);
    manager._backgroundPreloadTask = null;
    manager._currentAuthIndex = 1;
    manager._expiredRecheckDueAt = new Map();
    manager._expiredRecheckFailures = new Map();
    manager._wsInitState = new Map();
    manager.authSource = {
        availableIndices: [1, 15],
        health: { getStatus: () => ({ mode: "active" }) },
        isExpired: index => index === 15,
        unmarkAsExpired: async () => true,
    };
    manager.browser = {
        newContext: async () => ({
            addInitScript: async () => {},
            close: async () => {
                temporaryClosed = true;
            },
            newPage: async () => page,
        }),
    };
    manager.config = { maxContexts: 1 };
    manager.contexts = new Map([[1, {}]]);
    manager.initializingContexts = new Set();
    manager.logger = logger;
    manager.stickyProxyManager = { getProxyForAuth: () => null };
    manager._isSystemBusy = () => false;
    manager._hasActiveQueueForAuth = () => false;
    manager._navigateAndWakeUpPage = async () => {};
    manager._checkPageStatusAndErrors = async () => {};
    manager._waitForWebSocketInit = async () => true;
    manager._captureStorageState = async () => ({ cookies: [], origins: [] });
    manager._getPrivacyProtectionScript = () => "";
    manager.closeContext = async () => {
        currentClosed = true;
    };
    manager.rebalanceContextPool = async () => {};

    assert.deepEqual(await manager.recheckExpiredAccount(15), { reason: "recovered", recovered: true });
    assert.equal(currentClosed, false);
    assert.equal(temporaryClosed, true);
    assert.equal(manager.contexts.has(1), true);
});

test("expired recheck does not recover a different signed-in account", async t => {
    const originalCwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auth-recheck-identity-"));
    t.after(() => {
        process.chdir(originalCwd);
        fs.rmSync(directory, { force: true, recursive: true });
    });
    fs.mkdirSync(path.join(directory, "configs", "auth"), { recursive: true });
    const filePath = path.join(directory, "configs", "auth", "auth-15.json");
    fs.writeFileSync(filePath, JSON.stringify({ accountName: "original@example.com", expired: true }));
    process.chdir(directory);

    const page = identityPage("other@example.com");
    const manager = Object.create(BrowserManager.prototype);
    manager._backgroundPreloadTask = null;
    manager._currentAuthIndex = -1;
    manager._expiredRecheckDueAt = new Map();
    manager._expiredRecheckFailures = new Map();
    manager._wsInitState = new Map();
    manager.authSource = { availableIndices: [15], isExpired: () => true };
    manager.browser = {
        newContext: async () => ({ addInitScript: async () => {}, close: async () => {}, newPage: async () => page }),
    };
    manager.config = { maxContexts: 2 };
    manager.contexts = new Map();
    manager.initializingContexts = new Set();
    manager.logger = logger;
    manager.stickyProxyManager = { getProxyForAuth: () => null };
    manager._isSystemBusy = () => false;
    manager._hasActiveQueueForAuth = () => false;
    manager._navigateAndWakeUpPage = async () => {};
    manager._checkPageStatusAndErrors = async () => {};
    manager._waitForWebSocketInit = async () => true;
    manager._getPrivacyProtectionScript = () => "";
    manager.rebalanceContextPool = async () => {};

    assert.deepEqual(await manager.recheckExpiredAccount(15), { reason: "unavailable", recovered: false });
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf-8")).expired, true);
});

test("account identity detection rejects an ambiguous switcher label", async () => {
    const page = {
        locator: () => ({
            count: async () => 1,
            first: () => ({ getAttribute: async () => "Google Account: one@example.com two@example.com" }),
        }),
    };
    assert.equal(await detectAccountEmail(page), null);
});

test("pending reauthentication excludes duplicate auth files for the same account", () => {
    const source = Object.create(AuthSource.prototype);
    source.logger = logger;
    source.availableIndices = [1, 2, 3];
    source.expiredIndices = [];
    source.pendingRefreshIndices = new Set();
    source.health = { isAvailable: () => true };
    source.accountNameMap = new Map([
        [1, "same@example.com"],
        [2, "same@example.com"],
        [3, "other@example.com"],
    ]);
    source.canonicalIndexMap = new Map();

    source.setPendingRefresh(2, true);
    assert.deepEqual(source.getRotationIndices(), [3]);
    source.setPendingRefresh(2, false);
    assert.deepEqual(source.getRotationIndices(), [2, 3]);
});

test("pool cleanup finishes a deferred reauthentication and clears its exclusion", async () => {
    const pending = new Set([2]);
    const manager = Object.create(BrowserManager.prototype);
    manager._authUpdateSuspended = new Set([2]);
    manager._closingPendingContexts = new Map();
    manager._currentAuthIndex = 1;
    manager.authSource = {
        isExpired: () => false,
        setPendingRefresh: (index, active) => {
            if (active) pending.add(index);
            else pending.delete(index);
        },
    };
    manager.contexts = new Map([[2, {}]]);
    manager.initializingContexts = new Set();
    manager.logger = logger;
    manager.pendingContextClosures = new Map([[2, "reauth"]]);
    manager._hasActiveQueueForAuth = () => false;
    manager._isSystemBusy = () => true;
    manager._closeContextImpl = async index => {
        manager.pendingContextClosures.delete(index);
        manager.contexts.delete(index);
    };

    assert.equal(await manager._closeContextForPoolIfPossible(2, "rebalance"), true);
    assert.equal(manager.pendingContextClosures.has(2), false);
    assert.equal(manager._authUpdateSuspended.has(2), false);
    assert.equal(pending.has(2), false);
});

test("direct context close also releases a pending reauthentication", async () => {
    const pending = new Set([2]);
    const manager = Object.create(BrowserManager.prototype);
    manager._authUpdateSuspended = new Set([2]);
    manager.authSource = {
        setPendingRefresh: (index, active) => {
            if (active) pending.add(index);
            else pending.delete(index);
        },
    };
    manager.contexts = new Map([[2, {}]]);
    manager.initializingContexts = new Set();
    manager.pendingContextClosures = new Map([[2, "reauth"]]);
    manager._closeContextImpl = async index => {
        manager.pendingContextClosures.delete(index);
        manager.contexts.delete(index);
    };

    await manager.closeContext(2);
    assert.equal(manager.pendingContextClosures.has(2), false);
    assert.equal(manager._authUpdateSuspended.has(2), false);
    assert.equal(pending.has(2), false);
});

test("credential replacement waits for an in-flight expiration write", async () => {
    let finishMark;
    let settled = false;
    const manager = Object.create(BrowserManager.prototype);
    manager._authUpdateSuspended = new Set();
    manager._authUpdateTasks = new Map();
    manager._markExpiredTasks = new Map();
    manager.authSource = {
        markAsExpired: () =>
            new Promise(resolve => {
                finishMark = resolve;
            }),
        setPendingRefresh: () => {},
    };

    const marking = manager._markAccountExpired(2);
    const suspending = manager.suspendAuthUpdates(2).then(() => {
        settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    finishMark(true);
    await Promise.all([marking, suspending]);
    assert.equal(settled, true);
    assert.equal(manager._authUpdateSuspended.has(2), true);
});

test("failed complete storage snapshot never overwrites existing IndexedDB credentials", async t => {
    const originalCwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auth-snapshot-"));
    t.after(() => {
        process.chdir(originalCwd);
        fs.rmSync(directory, { force: true, recursive: true });
    });
    fs.mkdirSync(path.join(directory, "configs", "auth"), { recursive: true });
    const filePath = path.join(directory, "configs", "auth", "auth-5.json");
    const original = JSON.stringify({
        accountName: "account@example.com",
        cookies: [{ name: "old" }],
        origins: [{ indexedDB: [{ name: "auth" }], origin: "https://ai.studio" }],
    });
    fs.writeFileSync(filePath, original);
    process.chdir(directory);

    let calls = 0;
    const manager = Object.create(BrowserManager.prototype);
    manager._authUpdateSuspended = new Set();
    manager._authUpdateTasks = new Map();
    manager.authSource = { getAuth: () => JSON.parse(fs.readFileSync(filePath, "utf-8")) };
    manager.config = { enableAuthUpdate: true };
    manager.contexts = new Map([
        [
            5,
            {
                context: {
                    storageState: async options => {
                        calls++;
                        assert.deepEqual(options, { indexedDB: true });
                        throw new Error("snapshot unavailable");
                    },
                },
            },
        ],
    ]);
    manager.logger = logger;

    await manager._updateAuthFile(5);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(filePath, "utf-8"), original);
});

test("browser close uses its captured instance after a disconnect callback clears the field", async () => {
    let closed = false;
    const browser = {
        close: async () => {
            closed = true;
        },
    };
    const manager = Object.create(BrowserManager.prototype);
    manager._authUpdateSuspended = new Set();
    manager.authSource = { isExpired: () => false, pendingRefreshIndices: new Set() };
    manager.browser = browser;
    manager.contexts = new Map([[1, { page: { isClosed: () => false } }]]);
    manager.initializingContexts = new Set();
    manager.logger = logger;
    manager._cleanupAllContexts = () => {};
    manager._readPageIdentity = async () => ({ currentUrl: "https://ai.studio/apps/test", pageTitle: "AI Studio" });
    manager._updateAuthFile = async () => {
        manager.browser = null;
    };

    await manager.closeBrowser();
    assert.equal(closed, true);
});
