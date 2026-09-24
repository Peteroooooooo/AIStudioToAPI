const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const loadCore = () => import(pathToFileURL(path.join(__dirname, "../tools/chrome-auth-sync/core.mjs")));

test("only AI Studio and Google sign-in cookie domains are included", async () => {
    const { isRelevantCookieDomain } = await loadCore();
    assert.equal(isRelevantCookieDomain(".google.com"), true);
    assert.equal(isRelevantCookieDomain("accounts.google.com"), true);
    assert.equal(isRelevantCookieDomain("aistudio.google.com"), true);
    assert.equal(isRelevantCookieDomain("www.google.com"), false);
});

test("browser cookies become Playwright storageState without partitioned or duplicate cookies", async () => {
    const { buildStorageState } = await loadCore();
    const cookie = {
        domain: ".google.com",
        expirationDate: 1800000000,
        httpOnly: true,
        name: "SID",
        path: "/",
        sameSite: "no_restriction",
        secure: true,
        value: "example",
    };
    const state = buildStorageState(
        {
            accountName: "user@example.com",
            localStorage: [{ name: "setting", value: "1" }],
            origin: "https://aistudio.google.com",
        },
        [[cookie], [cookie, { ...cookie, partitionKey: { topLevelSite: "https://example.com" } }]]
    );
    assert.equal(state.cookies.length, 1);
    assert.equal(state.cookies[0].sameSite, "None");
    assert.equal(state.cookies[0].expires, 1800000000);
    assert.deepEqual(state.origins, [
        { localStorage: [{ name: "setting", value: "1" }], origin: "https://aistudio.google.com" },
    ]);
});

test("unidentified account and empty Google cookies never export", async () => {
    const { buildStorageState } = await loadCore();
    assert.throws(() => buildStorageState({ origin: "https://aistudio.google.com" }, [[]]));
    assert.throws(() =>
        buildStorageState({ accountName: "user@example.com", origin: "https://aistudio.google.com" }, [[]])
    );
});
