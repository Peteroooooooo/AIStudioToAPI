const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { RuntimeConfigStore } = require("../src/utils/RuntimeConfigStore");
const RequestHandler = require("../src/core/RequestHandler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function initialConfig() {
    return {
        checkUpdate: true,
        enableAuthUpdate: true,
        failureThreshold: 3,
        fakeStreamTimeoutMs: 300000,
        forceCodeExecution: false,
        forceThinking: false,
        forceUrlContext: false,
        forceWebSearch: false,
        immediateSwitchStatusCodes: [429, 503],
        logLevel: "INFO",
        maxContexts: 2,
        maxRetries: 3,
        retryDelay: 2000,
        safetySettingsThreshold: "OFF",
        startup: {
            apiKeys: ["fake-test-key"],
            host: "127.0.0.1",
            httpPort: 7860,
            sessionSecret: "test-session-secret",
            webConsolePassword: "test-console-password",
        },
        streamingMode: "real",
        streamTimeoutMs: 60000,
        switchOnUses: 40,
    };
}

function temporaryStore(config = initialConfig(), onChange = () => {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-runtime-test-"));
    const store = new RuntimeConfigStore(config, logger, directory, onChange);
    return { config, directory, store };
}

async function waitFor(check, timeoutMs = 3000) {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for file hot reload");
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

test("file is seeded once, page edits persist, and reset uses the saved initial values", async () => {
    const { config, directory, store } = temporaryStore();
    try {
        const initial = store.getState();
        assert.equal(initial.effective.maxContexts, 2);
        assert.equal(initial.defaults.maxContexts, 2);
        assert.equal(initial.revision, 0);
        assert.equal(JSON.stringify(initial).includes("fake-test-key"), false);

        await store.update({ forceThinking: true, logLevel: "DEBUG", maxContexts: 1, maxRetries: 4 });
        assert.equal(config.maxContexts, 1);
        assert.equal(config.maxRetries, 4);
        assert.equal(config.forceThinking, true);
        assert.equal(config.logLevel, "DEBUG");
        const saved = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        assert.equal(saved.settings.maxContexts, 1);
        assert.deepEqual(saved.startup.apiKeys, ["fake-test-key"]);

        store.close();
        const changedEnvironment = initialConfig();
        changedEnvironment.maxContexts = 9;
        const restarted = new RuntimeConfigStore(changedEnvironment, logger, directory);
        try {
            assert.equal(changedEnvironment.maxContexts, 1);
            assert.equal(changedEnvironment.logLevel, "DEBUG");
            assert.equal(restarted.getState().defaults.maxContexts, 2);
            await restarted.reset();
            assert.equal(changedEnvironment.maxContexts, 2);
            assert.deepEqual(restarted.getState().effective, restarted.getState().defaults);
        } finally {
            restarted.close();
        }
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("invalid edits leave the effective and saved settings unchanged", async () => {
    const { config, directory, store } = temporaryStore();
    try {
        const content = fs.readFileSync(store.filePath, "utf8");
        assert.throws(() => store.update({ maxContexts: -1 }), /maxContexts/);
        assert.throws(() => store.update({ apiKeys: ["should-not-save"] }), /Unknown runtime setting/);
        assert.equal(config.maxContexts, 2);
        assert.equal(fs.readFileSync(store.filePath, "utf8"), content);
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("out-of-range legacy settings fail before creating the first config file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-runtime-test-"));
    const config = initialConfig();
    config.maxContexts = 33;
    try {
        assert.throws(() => new RuntimeConfigStore(config, logger, directory), /maxContexts/);
        assert.equal(fs.existsSync(path.join(directory, "config.json")), false);
    } finally {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("a failed file write does not change the active settings", async () => {
    const { config, directory, store } = temporaryStore();
    const before = fs.readFileSync(store.filePath, "utf8");
    const originalRename = fs.promises.rename;
    try {
        fs.promises.rename = async () => {
            throw new Error("simulated write failure");
        };
        await assert.rejects(store.update({ maxContexts: 5 }), /simulated write failure/);
        assert.equal(config.maxContexts, 2);
        assert.equal(fs.readFileSync(store.filePath, "utf8"), before);
    } finally {
        fs.promises.rename = originalRename;
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("manual config file saves hot-load valid settings and reject invalid files", async () => {
    const changed = [];
    const { config, directory, store } = temporaryStore(initialConfig(), keys => changed.push(...keys));
    try {
        const saved = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        saved.settings.retryDelay = 750;
        fs.writeFileSync(store.filePath, JSON.stringify(saved));
        await waitFor(() => config.retryDelay === 750);
        assert.ok(changed.includes("retryDelay"));

        const revision = store.getState().revision;
        saved.settings.maxRetries = 0;
        fs.writeFileSync(store.filePath, JSON.stringify(saved));
        await new Promise(resolve => setTimeout(resolve, 1400));
        assert.equal(config.maxRetries, 3);
        assert.equal(store.getState().revision, revision);

        saved.settings.maxRetries = 3;
        saved.settings.retryDelay = 800;
        saved.startup.host = 42;
        fs.writeFileSync(store.filePath, JSON.stringify(saved));
        await new Promise(resolve => setTimeout(resolve, 1400));
        assert.equal(config.retryDelay, 750);
        assert.equal(store.getState().revision, revision);
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("invalid config file stops startup instead of silently reverting to environment values", () => {
    const { directory, store } = temporaryStore();
    try {
        store.close();
        const saved = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        delete saved.settings.switchOnUses;
        fs.writeFileSync(store.filePath, JSON.stringify(saved));
        assert.throws(() => new RuntimeConfigStore(initialConfig(), logger, directory), /Missing runtime setting/);
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("request timeouts use current config, while a retry budget stays fixed per request", async () => {
    const config = initialConfig();
    const registry = { getAuthIndexForRequest: () => 1 };
    const browserManager = { currentAuthIndex: 1 };
    const authSource = { getRotationIndices: () => [1], health: { isAvailable: () => true } };
    const handler = new RequestHandler({}, registry, logger, browserManager, config, authSource);
    assert.equal(handler.timeouts.FAKE_STREAM, 300000);
    config.fakeStreamTimeoutMs = 90000;
    assert.equal(handler.timeouts.FAKE_STREAM, 90000);

    config.maxRetries = 2;
    config.retryDelay = 0;
    let forwarded = 0;
    handler._forwardRequest = () => forwarded++;
    handler._cancelCurrentAttemptBeforeRetry = () => {};
    handler._waitForSystemAndConnectionIfBusy = async () => true;
    const queue = {
        close() {},
        async dequeue() {
            config.maxRetries = 9;
            return { event_type: "error", message: "upstream error", status: 500 };
        },
    };
    registry.createMessageQueue = () => queue;
    const result = await handler._executeRequestWithRetries({ request_attempt_id: 0, request_id: "r" }, queue);
    assert.equal(result.success, false);
    assert.equal(forwarded, 2);
});

test("an immediate status retry counts toward the total attempt limit", async () => {
    const config = initialConfig();
    config.maxRetries = 2;
    const registry = { getAuthIndexForRequest: () => 1 };
    const browserManager = { currentAuthIndex: 1 };
    const authSource = { getRotationIndices: () => [1, 2], health: { isAvailable: () => true } };
    const handler = new RequestHandler({}, registry, logger, browserManager, config, authSource);
    let forwarded = 0;
    handler._forwardRequest = () => forwarded++;
    handler._cancelCurrentAttemptBeforeRetry = () => {};
    handler._prepareImmediateStatusRetry = async () => true;
    const queue = {
        close() {},
        async dequeue() {
            return { event_type: "error", message: "rate limited", status: 429 };
        },
    };
    registry.createMessageQueue = () => queue;
    const result = await handler._executeRequestWithRetries({ request_attempt_id: 0, request_id: "r" }, queue);
    assert.equal(result.success, false);
    assert.equal(forwarded, 2);
});
