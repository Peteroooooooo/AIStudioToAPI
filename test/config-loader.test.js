const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ConfigLoader = require("../src/utils/ConfigLoader");
const { RuntimeConfigStore } = require("../src/utils/RuntimeConfigStore");

const logger = { error() {}, info() {}, warn() {} };

test("legacy environment is imported only once into the single config file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-config-source-"));
    const originalDirectory = process.cwd();
    const envKeys = ["API_KEYS", "HOST", "PORT", "WEB_CONSOLE_PASSWORD", "MAX_RETRIES"];
    const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    let store;
    try {
        process.chdir(directory);
        process.env.API_KEYS = "initial-test-key";
        process.env.HOST = "127.0.0.1";
        process.env.PORT = "8765";
        process.env.WEB_CONSOLE_PASSWORD = "initial-test-password";
        process.env.MAX_RETRIES = "2";

        const initial = new ConfigLoader(logger).loadConfiguration();
        store = new RuntimeConfigStore(initial, logger);
        assert.equal(initial.httpPort, 8765);
        assert.equal(initial.maxRetries, 2);
        assert.equal(initial.webConsolePassword, "initial-test-password");
        store.close();
        store = null;

        process.env.API_KEYS = "later-env-key";
        process.env.HOST = "0.0.0.0";
        process.env.PORT = "9876";
        process.env.WEB_CONSOLE_PASSWORD = "later-env-password";
        process.env.MAX_RETRIES = "9";
        const restarted = new ConfigLoader(logger).loadConfiguration();
        store = new RuntimeConfigStore(restarted, logger);
        assert.deepEqual(restarted.apiKeys, ["initial-test-key"]);
        assert.equal(restarted.host, "127.0.0.1");
        assert.equal(restarted.httpPort, 8765);
        assert.equal(restarted.webConsolePassword, "initial-test-password");
        assert.equal(restarted.maxRetries, 2);

        store.close();
        store = null;
        const filePath = path.join(directory, "data", "config.json");
        const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
        saved.startup.apiKeys = [];
        fs.writeFileSync(filePath, JSON.stringify(saved));
        assert.throws(() => new ConfigLoader(logger).loadConfiguration(), /apiKeys/);
        saved.startup.apiKeys = ["valid-key"];
        delete saved.startup.webConsolePassword;
        fs.writeFileSync(filePath, JSON.stringify(saved));
        assert.throws(() => new ConfigLoader(logger).loadConfiguration(), /webConsolePassword/);
    } finally {
        store?.close();
        process.chdir(originalDirectory);
        for (const key of envKeys) {
            if (originalEnv[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnv[key];
        }
        fs.rmSync(directory, { force: true, recursive: true });
    }
});
