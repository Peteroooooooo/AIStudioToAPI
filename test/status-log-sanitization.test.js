const test = require("node:test");
const assert = require("node:assert/strict");

const StatusRoutes = require("../src/routes/StatusRoutes");
const { sanitizeStatusLogs } = require("../src/utils/LogSanitizer");

test("status log sanitizer removes configured and common credential shapes", () => {
    const config = {
        apiKeys: ["local-test-api-key"],
        sessionSecret: "local-session-secret",
        startup: {
            proxyUrl: "http://proxy-user:proxy-pass@localhost:8080",
            webConsolePassword: "local-console-password",
        },
    };
    const savedStartup = { apiKeys: ["pending-test-api-key"] };
    const raw = [
        "[ERROR] 2026-09-26 12:00:00.000 [UTC] [System] - request failed",
        "Authorization: Bearer dynamic-token-value",
        "Authorization: Basic ZmFrZTpmYWtl",
        "Cookie: sid=private-cookie; other=private-value",
        "apiKey=another-dynamic-key password=plain-password access_token=oauth-token",
        "apiKeys: [key-one, key-two]",
        "AIzaabcdefghijklmnopqrstuvwx sk-abcdefghijklmnop",
        "local-test-api-key local-session-secret local-console-password pending-test-api-key",
        "http://proxy-user:proxy-pass@localhost:8080",
    ].join("\n");
    const sanitized = sanitizeStatusLogs(raw, config, savedStartup);
    assert.match(sanitized, /request failed/);
    for (const secret of [
        "dynamic-token-value",
        "ZmFrZTpmYWtl",
        "private-cookie",
        "private-value",
        "another-dynamic-key",
        "plain-password",
        "oauth-token",
        "key-one",
        "key-two",
        "AIzaabcdefghijklmnopqrstuvwx",
        "sk-abcdefghijklmnop",
        "local-test-api-key",
        "local-session-secret",
        "local-console-password",
        "pending-test-api-key",
        "proxy-pass",
    ]) {
        assert.equal(sanitized.includes(secret), false, `raw secret remained: ${secret}`);
    }
});

test("status response emits only sanitized log text", () => {
    const logger = {
        displayLimit: 10,
        logBuffer: ["[ERROR] 2026-09-26 12:00:00.000 [UTC] [System] - key=local-test-api-key"],
    };
    const config = {
        apiKeys: ["local-test-api-key"],
        failureThreshold: 3,
        immediateSwitchStatusCodes: [429, 503],
        switchOnUses: 40,
    };
    const serverSystem = {
        authSource: {
            accountNameMap: new Map(),
            availableIndices: [],
            getRotationIndices: () => [],
            initialIndices: [],
        },
        browserManager: { contexts: new Map() },
        config,
        connectionRegistry: { getConnectionByAuth: () => null },
        distIndexPath: "",
        logger,
        requestHandler: { currentAuthIndex: -1, failureCount: 0, isSystemBusy: false, usageCount: 0 },
        runtimeConfig: { fileExtras: { startup: {} } },
    };
    const response = new StatusRoutes(serverSystem)._getStatusData();
    assert.equal(response.logCount, 1);
    assert.equal(response.logs.includes("local-test-api-key"), false);
    assert.match(response.logs, /\[REDACTED\]/);
});

test("malformed proxy credential escaping cannot break the status response", () => {
    assert.equal(
        sanitizeStatusLogs("Request failed", { startup: { proxyUrl: "http://bad%GG:secret@localhost:8080" } }),
        "Request failed"
    );
});
