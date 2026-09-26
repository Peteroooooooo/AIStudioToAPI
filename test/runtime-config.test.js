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
        cacheCheckpointTokens: 1024,
        cacheEnabled: true,
        cacheMaxEntries: 100,
        cacheMinTokens: 1024,
        cacheRenewWindowSeconds: 0,
        cacheTtlSeconds: 3600,
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

test("startup status reports effective values and pending restart without credential values", async () => {
    const config = initialConfig();
    config.startup.proxyUrl = "http://proxy-user:proxy-password@127.0.0.1:8080";
    config.startup.webConsoleUsername = "console-user";
    const { directory, store } = temporaryStore(config);
    try {
        const current = store.getState();
        assert.deepEqual(current.startup, {
            apiKeyCount: 1,
            consolePasswordConfigured: true,
            consoleUsernameConfigured: true,
            host: "127.0.0.1",
            httpPort: 7860,
            proxyConfigured: true,
            restartRequired: false,
        });
        for (const secret of [
            "fake-test-key",
            "test-console-password",
            "test-session-secret",
            "proxy-password",
            "console-user",
        ]) {
            assert.equal(JSON.stringify(current).includes(secret), false);
        }

        const saved = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        saved.startup.host = "0.0.0.0";
        saved.startup.apiKeys = ["next-test-key"];
        fs.writeFileSync(store.filePath, JSON.stringify(saved));
        await store._reloadFromDisk();
        const pending = store.getState();
        assert.equal(pending.startup.host, "127.0.0.1");
        assert.equal(pending.startup.apiKeyCount, 1);
        assert.equal(pending.startup.restartRequired, true);
        assert.equal(JSON.stringify(pending).includes("next-test-key"), false);
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
        saved.settings.cacheTtlSeconds = 1800;
        saved.settings.cacheEnabled = false;
        fs.writeFileSync(store.filePath, JSON.stringify(saved));
        await waitFor(() => config.retryDelay === 750 && config.cacheTtlSeconds === 1800);
        assert.equal(config.cacheEnabled, false);
        assert.ok(changed.includes("retryDelay"));
        assert.ok(changed.includes("cacheEnabled"));

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

test("older config files gain cache settings without losing saved values", () => {
    const { directory, store } = temporaryStore();
    try {
        store.close();
        const saved = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        saved.settings.maxContexts = 7;
        for (const key of [
            "cacheCheckpointTokens",
            "cacheEnabled",
            "cacheMaxEntries",
            "cacheMinTokens",
            "cacheRenewWindowSeconds",
            "cacheTtlSeconds",
        ]) {
            delete saved.settings[key];
            delete saved.resetDefaults[key];
        }
        fs.writeFileSync(store.filePath, JSON.stringify(saved));

        const config = initialConfig();
        const restarted = new RuntimeConfigStore(config, logger, directory);
        try {
            assert.equal(config.maxContexts, 7);
            assert.equal(config.cacheEnabled, true);
            assert.equal(config.cacheTtlSeconds, 3600);
            const migrated = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
            assert.equal(migrated.settings.maxContexts, 7);
            assert.equal(migrated.settings.cacheEnabled, true);
            assert.equal(migrated.resetDefaults.cacheTtlSeconds, 3600);
        } finally {
            restarted.close();
        }
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("cache controls validate ranges and apply immediately", async () => {
    const { config, directory, store } = temporaryStore();
    try {
        assert.throws(() => store.update({ cacheMinTokens: 1023 }), /cacheMinTokens/);
        assert.throws(() => store.update({ cacheCheckpointTokens: 1023 }), /cacheCheckpointTokens/);
        assert.throws(() => store.update({ cacheEnabled: "yes" }), /cacheEnabled/);
        await store.update({
            cacheCheckpointTokens: 1024,
            cacheEnabled: false,
            cacheMaxEntries: 12,
            cacheMinTokens: 1024,
            cacheTtlSeconds: 3600,
        });
        assert.equal(config.cacheEnabled, false);
        assert.equal(config.cacheMinTokens, 1024);
        assert.equal(config.cacheCheckpointTokens, 1024);
        assert.equal(config.cacheTtlSeconds, 3600);
        assert.equal(config.cacheMaxEntries, 12);
        assert.equal(store.getState().effective.cacheEnabled, false);
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
