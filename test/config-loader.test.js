const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ConfigLoader = require("../src/utils/ConfigLoader");
const { RuntimeConfigStore } = require("../src/utils/RuntimeConfigStore");
const { ManagedApiKeyStore } = require("../src/utils/ManagedApiKeyStore");
const ProxyServerSystem = require("../src/core/ProxyServerSystem");

const logger = { error() {}, info() {}, warn() {} };

test("legacy API_KEYS migrates once, stays usable, and leaves the general config", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-config-source-"));
    const originalDirectory = process.cwd();
    const envKeys = ["API_KEYS", "HOST", "PORT", "WEB_CONSOLE_PASSWORD", "MAX_RETRIES"];
    const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    let store;
    let keyStore;
    try {
        process.chdir(directory);
        process.env.API_KEYS = "initial-test-key";
        process.env.HOST = "127.0.0.1";
        process.env.PORT = "8765";
        process.env.WEB_CONSOLE_PASSWORD = "initial-test-password";
        process.env.MAX_RETRIES = "2";

        const initial = new ConfigLoader(logger).loadConfiguration();
        keyStore = new ManagedApiKeyStore(logger, path.join(directory, "data"), initial.apiKeys);
        initial.apiKeys = [];
        store = new RuntimeConfigStore(initial, logger);
        store.apiKeyStore = keyStore;
        assert.equal(initial.httpPort, 8765);
        assert.equal(initial.maxRetries, 2);
        assert.equal(initial.webConsolePassword, "initial-test-password");
        assert.equal(keyStore.match("initial-test-key")?.source, "legacy");
        assert.equal(store.getState().startup.apiKeyCount, 1);
        assert.equal(fs.readFileSync(store.filePath, "utf8").includes("initial-test-key"), false);
        store.close();
        keyStore.close();
        store = null;
        keyStore = null;

        process.env.API_KEYS = "later-env-key";
        process.env.HOST = "0.0.0.0";
        process.env.PORT = "9876";
        process.env.WEB_CONSOLE_PASSWORD = "later-env-password";
        process.env.MAX_RETRIES = "9";
        const restarted = new ConfigLoader(logger).loadConfiguration();
        keyStore = new ManagedApiKeyStore(logger, path.join(directory, "data"), restarted.apiKeys);
        restarted.apiKeys = [];
        store = new RuntimeConfigStore(restarted, logger);
        store.apiKeyStore = keyStore;
        assert.deepEqual(restarted.apiKeys, []);
        assert.equal(restarted.host, "127.0.0.1");
        assert.equal(restarted.httpPort, 8765);
        assert.equal(restarted.webConsolePassword, "initial-test-password");
        assert.equal(restarted.maxRetries, 2);
        assert.equal(keyStore.match("initial-test-key")?.source, "legacy");
        assert.equal(keyStore.match("later-env-key"), null);

        const saved = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        assert.equal(Object.hasOwn(saved.startup, "apiKeys"), false);
        saved.startup.apiKeys = "invalid";
        fs.writeFileSync(store.filePath, JSON.stringify(saved));
        assert.throws(() => new ConfigLoader(logger).loadConfiguration(), /apiKeys/);
        saved.startup.apiKeys = [];
        delete saved.startup.webConsolePassword;
        fs.writeFileSync(store.filePath, JSON.stringify(saved));
        assert.throws(() => new ConfigLoader(logger).loadConfiguration(), /webConsolePassword/);
    } finally {
        store?.close();
        keyStore?.close();
        process.chdir(originalDirectory);
        for (const key of envKeys) {
            if (originalEnv[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnv[key];
        }
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("old config keys migrate before the startup config is scrubbed", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-config-migration-"));
    const originalDirectory = process.cwd();
    let store;
    let keyStore;
    try {
        process.chdir(directory);
        const config = new ConfigLoader(logger).loadConfiguration();
        config.webConsolePassword = "console-password";
        config.startup.webConsolePassword = "console-password";
        store = new RuntimeConfigStore(config, logger);
        store.close();
        store = null;
        const filePath = path.join(directory, "data", "config.json");
        const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
        saved.startup.apiKeys = ["existing-client-key"];
        fs.writeFileSync(filePath, JSON.stringify(saved));

        const migrated = new ConfigLoader(logger).loadConfiguration();
        keyStore = new ManagedApiKeyStore(logger, path.join(directory, "data"), migrated.apiKeys);
        migrated.apiKeys = [];
        store = new RuntimeConfigStore(migrated, logger);
        assert.equal(keyStore.match("existing-client-key")?.source, "legacy");
        assert.equal(fs.readFileSync(filePath, "utf8").includes("existing-client-key"), false);
        assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).startup.apiKeys, undefined);
    } finally {
        store?.close();
        keyStore?.close();
        process.chdir(originalDirectory);
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("fresh boot without console credentials fails before persisting config", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-config-bootstrap-"));
    const originalDirectory = process.cwd();
    const originalApiKeys = process.env.API_KEYS;
    const originalPassword = process.env.WEB_CONSOLE_PASSWORD;
    try {
        process.chdir(directory);
        delete process.env.API_KEYS;
        delete process.env.WEB_CONSOLE_PASSWORD;
        assert.throws(() => new ProxyServerSystem(), /Set WEB_CONSOLE_PASSWORD before first start/);
        assert.equal(fs.existsSync(path.join(directory, "data", "config.json")), false);
        process.env.WEB_CONSOLE_PASSWORD = "bootstrap-password";
        assert.equal(new ConfigLoader(logger).loadConfiguration().webConsolePassword, "bootstrap-password");
    } finally {
        process.chdir(originalDirectory);
        if (originalApiKeys === undefined) delete process.env.API_KEYS;
        else process.env.API_KEYS = originalApiKeys;
        if (originalPassword === undefined) delete process.env.WEB_CONSOLE_PASSWORD;
        else process.env.WEB_CONSOLE_PASSWORD = originalPassword;
        fs.rmSync(directory, { force: true, recursive: true });
    }
});
