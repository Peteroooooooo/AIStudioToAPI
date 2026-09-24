const test = require("node:test");
const assert = require("node:assert/strict");

const { getProxySummary, parseProxyConfig, withoutLegacyProxyEnv } = require("../src/utils/ProxyUtils");
const StickyProxyManager = require("../src/utils/StickyProxyManager");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("configured proxy URL and bypass are parsed for Playwright without exposing credentials", () => {
    const proxyUrl = "http://alice:secret@proxy.example:8080";
    assert.deepEqual(parseProxyConfig(proxyUrl, "example.org,localhost"), {
        bypass: "localhost,127.0.0.1,::,::1,0.0.0.0,example.org",
        password: "secret",
        server: "http://proxy.example:8080",
        username: "alice",
    });
    assert.deepEqual(getProxySummary(proxyUrl), { enabled: true, server: "http://proxy.example:8080" });
    assert.equal(getProxySummary("alice:secret@proxy.example:8080").server, "***@proxy.example:8080");
    assert.equal(parseProxyConfig(null, null), null);
});

test("browser child environment drops migrated proxy variables", () => {
    const browserEnv = withoutLegacyProxyEnv({
        DISPLAY: ":1",
        http_proxy: "http://legacy.example:8080",
        HTTPS_PROXY: "http://legacy.example:8080",
        no_proxy: "legacy.internal",
        NO_PROXY: "legacy.internal",
    });
    assert.deepEqual(browserEnv, { DISPLAY: ":1" });
});

test("sticky proxy bypass comes from the configured value", () => {
    const manager = new StickyProxyManager(logger, null, { proxyBypass: "configured.internal" });
    assert.equal(
        manager.parseProxy("proxy.example:8080").bypass,
        "localhost,127.0.0.1,::,::1,0.0.0.0,configured.internal"
    );
});
