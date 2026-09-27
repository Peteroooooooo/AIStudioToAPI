const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CreateAuth = require("../src/auth/CreateAuth");
const AuthSource = require("../src/auth/AuthSource");

const logger = { error() {}, info() {}, warn() {} };

function fakePage(email, url = "https://aistudio.google.com/", appsUrl = null, unrelatedScriptEmail = null) {
    let currentUrl = url;
    const emails = Array.isArray(email) ? email : email ? [email] : [];
    return {
        async goto(target) {
            currentUrl = target.endsWith("/apps") && appsUrl ? appsUrl : target;
        },
        locator: selector => {
            if (selector === 'script[type="application/json"]') {
                return {
                    count: async () => (unrelatedScriptEmail ? 1 : 0),
                    nth: () => ({ textContent: async () => JSON.stringify({ email: unrelatedScriptEmail }) }),
                };
            }
            assert.equal(selector, "button.account-switcher-button[aria-label]");
            return {
                count: async () => (emails.length ? 1 : 0),
                first: () => ({
                    getAttribute: async () => `Google Account: Test User (${emails.join(", ")})`,
                }),
            };
        },
        title: async () => "Google AI Studio",
        url: () => currentUrl,
        async waitForTimeout() {},
    };
}

function setup(t, { email = "person@example.test", oldExpired = true, refreshError = null } = {}) {
    const originalCwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-reauth-test-"));
    fs.mkdirSync(path.join(directory, "configs", "auth"), { recursive: true });
    process.chdir(directory);
    t.after(() => {
        process.chdir(originalCwd);
        fs.rmSync(directory, { force: true, recursive: true });
    });
    const authFile = path.join(directory, "configs", "auth", "auth-3.json");
    fs.writeFileSync(
        authFile,
        JSON.stringify({
            accountName: email,
            cookies: [{ name: "old", value: "old-test-value" }],
            expired: oldExpired,
            extra: "preserved",
            origins: [],
        })
    );
    const authSource = new AuthSource(logger);
    const calls = [];
    let writesSuspended = false;
    const browserManager = {
        async refreshContextAfterReauth(index) {
            calls.push(`refresh:${index}`);
            if (refreshError) throw refreshError;
            writesSuspended = false;
            return { deferred: false };
        },
        resumeAuthUpdates(index) {
            calls.push(`resume:${index}`);
            writesSuspended = false;
        },
        async suspendAuthUpdates(index) {
            calls.push(`suspend:${index}`);
            writesSuspended = true;
        },
    };
    const createAuth = new CreateAuth({ authSource, browserManager, logger });
    const session = {
        context: {
            storageState: async options => {
                assert.equal(options.indexedDB, true);
                return { cookies: [{ name: "fresh", value: "new-test-value" }], origins: [] };
            },
        },
        expectedAccountName: email,
        page: fakePage(email),
        sessionId: "opaque-test-session",
        targetAuthIndex: 3,
    };
    createAuth.vncSession = session;
    return { authFile, authSource, calls, createAuth, session, writesSuspended: () => writesSuspended };
}

test("reauthentication replaces the same index and preserves manual disable", async t => {
    const { authFile, authSource, calls, createAuth, session } = setup(t);
    authSource.health.setDisabled(3, true);

    const result = await createAuth._saveReauthenticatedAccount(session);

    const saved = JSON.parse(fs.readFileSync(authFile, "utf8"));
    assert.equal(result.reauthenticatedAuthIndex, 3);
    assert.equal(result.message, "vncAuthReauthSuccess");
    assert.equal(saved.expired, false);
    assert.equal(saved.extra, "preserved");
    assert.equal(saved.cookies[0].name, "fresh");
    assert.equal(authSource.health.getStatus(3).mode, "disabled");
    assert.equal(authSource.expiredIndices.includes(3), false);
    assert.deepEqual(calls, ["suspend:3", "refresh:3"]);
    assert.equal(fs.readdirSync(path.dirname(authFile)).length, 1);
});

test("reauthentication rejects another Google account without touching the file", async t => {
    const { authFile, calls, createAuth, session } = setup(t);
    const before = fs.readFileSync(authFile, "utf8");
    session.page = fakePage("someone-else@example.test", "https://aistudio.google.com/", null, "person@example.test");

    await assert.rejects(createAuth._saveReauthenticatedAccount(session), error => {
        assert.equal(error.messageKey, "errorVncReauthAccountMismatch");
        return true;
    });
    assert.equal(fs.readFileSync(authFile, "utf8"), before);
    assert.deepEqual(calls, []);
});

test("the account switcher decides identity even when project JSON contains another email", async t => {
    const { createAuth, session } = setup(t);
    session.page = fakePage("person@example.test", "https://aistudio.google.com/", null, "unrelated@example.test");

    const result = await createAuth._saveReauthenticatedAccount(session);
    assert.equal(result.message, "vncAuthReauthSuccess");
});

test("reauthentication refuses ambiguous account identity", async t => {
    const { authFile, calls, createAuth, session } = setup(t);
    const before = fs.readFileSync(authFile, "utf8");
    session.page = fakePage(["unrelated@example.test", "person@example.test"]);

    await assert.rejects(createAuth._saveReauthenticatedAccount(session), error => {
        assert.equal(error.messageKey, "errorVncReauthNotAuthenticated");
        return true;
    });
    assert.equal(fs.readFileSync(authFile, "utf8"), before);
    assert.deepEqual(calls, []);
});

test("reauthentication refuses a sign-in redirect from AI Studio apps", async t => {
    const { authFile, calls, createAuth, session } = setup(t);
    const before = fs.readFileSync(authFile, "utf8");
    session.page = fakePage("person@example.test", undefined, "https://accounts.google.com/ServiceLogin");

    await assert.rejects(createAuth._saveReauthenticatedAccount(session), error => {
        assert.equal(error.messageKey, "errorVncReauthNotAuthenticated");
        return true;
    });
    assert.equal(fs.readFileSync(authFile, "utf8"), before);
    assert.deepEqual(calls, []);
});

test("a stale tab cannot save or extend a newer VNC session", async t => {
    const { authFile, calls, createAuth } = setup(t);
    const before = fs.readFileSync(authFile, "utf8");
    const response = () => ({
        code: 200,
        json(value) {
            this.body = value;
            return this;
        },
        status(code) {
            this.code = code;
            return this;
        },
    });
    const saveResponse = response();
    await createAuth.saveAuthFile({ body: { sessionId: "old-tab-session" } }, saveResponse);
    assert.equal(saveResponse.code, 409);
    assert.equal(saveResponse.body.message, "errorVncSessionMismatch");
    const heartbeatResponse = response();
    createAuth.touchVncSession({ body: { sessionId: "old-tab-session" } }, heartbeatResponse);
    assert.equal(heartbeatResponse.code, 409);
    assert.equal(fs.readFileSync(authFile, "utf8"), before);
    assert.deepEqual(calls, []);
});

test("reauthentication rolls back if the replaced file cannot be reloaded", async t => {
    const { authFile, authSource, calls, createAuth, session } = setup(t);
    const before = fs.readFileSync(authFile, "utf8");
    const realReload = authSource.reloadAuthSources.bind(authSource);
    let reloads = 0;
    authSource.reloadAuthSources = (...args) => {
        if (++reloads === 1) throw new Error("synthetic reload failure");
        return realReload(...args);
    };

    await assert.rejects(createAuth._saveReauthenticatedAccount(session), /synthetic reload failure/);
    assert.equal(fs.readFileSync(authFile, "utf8"), before);
    assert.equal(authSource.expiredIndices.includes(3), true);
    assert.deepEqual(calls, ["suspend:3", "resume:3"]);
    assert.equal(fs.readdirSync(path.dirname(authFile)).length, 1);
});

test("validated credential survives a transient browser refresh failure", async t => {
    const { authFile, calls, createAuth, session, writesSuspended } = setup(t, {
        refreshError: new Error("synthetic refresh failure"),
    });

    const result = await createAuth._saveReauthenticatedAccount(session);
    const saved = JSON.parse(fs.readFileSync(authFile, "utf8"));
    assert.equal(result.refreshPending, true);
    assert.equal(saved.expired, false);
    assert.equal(saved.cookies[0].name, "fresh");
    assert.deepEqual(calls, ["suspend:3", "refresh:3"]);
    assert.equal(writesSuspended(), true);
});
