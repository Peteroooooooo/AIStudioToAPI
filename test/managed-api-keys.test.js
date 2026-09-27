const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const AuthRoutes = require("../src/routes/AuthRoutes");
const StatusRoutes = require("../src/routes/StatusRoutes");
const { ManagedApiKeyStore } = require("../src/utils/ManagedApiKeyStore");

function temporaryStore(legacyKeys = []) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-managed-keys-"));
    const messages = [];
    const logger = {
        error: message => messages.push(message),
        info: message => messages.push(message),
        warn: message => messages.push(message),
    };
    const store = new ManagedApiKeyStore(logger, directory, legacyKeys);
    return { directory, logger, messages, store };
}

test("managed keys persist, copy on demand, and revoke without reimporting old keys", () => {
    const { directory, logger, store } = temporaryStore(["old-client-key"]);
    let restarted;
    try {
        const created = store.create("Claude client");
        assert.match(store.create("").record.name, /^API key /);
        assert.match(created.key, /^sk-aistudio-[A-Za-z0-9_-]{43}$/);
        assert.equal(store.getSecret(created.record.id), created.key);
        assert.equal(store.match(created.key)?.id, created.record.id);
        assert.equal(store.match("old-client-key")?.source, "legacy");
        assert.equal(JSON.stringify(store.list()).includes(created.key), false);
        assert.equal(JSON.stringify(store.list()).includes("old-client-key"), false);
        assert.equal(fs.readFileSync(store.filePath, "utf8").includes(created.key), true);
        if (process.platform !== "win32") {
            assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
        }

        store.close();
        assert.throws(
            () => new ManagedApiKeyStore(logger, directory, ["unwanted-env-key"]),
            /missing an API key from startup configuration/
        );
        restarted = new ManagedApiKeyStore(logger, directory);
        assert.equal(restarted.getSecret(created.record.id), created.key);
        assert.equal(restarted.match("unwanted-env-key"), null);
        assert.equal(restarted.revoke(created.record.id), true);
        assert.equal(restarted.getSecret(created.record.id), null);
        assert.equal(restarted.match(created.key), null);
        assert.equal(restarted.revoke(created.record.id), false);
        assert.throws(() => restarted.revoke(restarted.list().keys[0].id, true), /web console password/);
    } finally {
        restarted?.close();
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("two store instances preserve overlapping changes and hot reload revocation", async () => {
    const { directory, logger, store } = temporaryStore();
    const other = new ManagedApiKeyStore(logger, directory);
    try {
        const first = store.create("First");
        const second = other.create("Second");
        assert.equal(store.list().count, 1);
        const third = store.create("Third");
        assert.equal(store.list().count, 3);
        assert.equal(store.match(second.key)?.id, second.record.id);
        assert.equal(other.revoke(first.record.id), true);
        const deadline = Date.now() + 4000;
        while (store.match(first.key) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(store.match(first.key), null);
        assert.equal(store.match(third.key)?.id, third.record.id);
    } finally {
        other.close();
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("generated client keys cannot log in to the console when legacy fallback is active", () => {
    const { directory, logger, store } = temporaryStore(["legacy-console-key"]);
    try {
        const generated = store.create("Client");
        const config = { webConsolePassword: null, webConsoleUsername: null };
        const routes = Object.create(AuthRoutes.prototype);
        routes.serverSystem = { apiKeyStore: store, config };
        routes.config = config;
        routes.logger = logger;
        routes.rateLimitEnabled = false;
        routes.rateLimitWindow = 15;
        routes.rateLimitMaxAttempts = 5;
        routes.getClientIP = () => "127.0.0.1";
        const handlers = new Map();
        const app = {
            delete() {},
            get() {},
            post(route, handler) {
                handlers.set(route, handler);
            },
        };
        routes.setupRoutes(app);
        const login = handlers.get("/login");
        const attempt = apiKey => {
            const req = {
                body: { apiKey },
                session: {
                    regenerate(callback) {
                        callback(null);
                    },
                },
            };
            const res = {
                redirect(target) {
                    this.target = target;
                },
            };
            login(req, res);
            return { authenticated: req.session.isAuthenticated === true, target: res.target };
        };
        assert.deepEqual(attempt(generated.key), { authenticated: false, target: "/login?error=1" });
        assert.deepEqual(attempt("legacy-console-key"), { authenticated: true, target: "/" });
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("settings API requires a console session and never includes a key in its list", async () => {
    const { directory, logger, messages, store } = temporaryStore(["legacy-console-key"]);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { isAuthenticated: req.headers["x-test-console-session"] === "yes" };
        next();
    });
    const config = { webConsolePassword: "console-password" };
    const serverSystem = {
        apiKeyStore: store,
        config,
        distIndexPath: "",
        logger,
    };
    const authRoutes = Object.create(AuthRoutes.prototype);
    new StatusRoutes(serverSystem).setupRoutes(app, authRoutes.isAuthenticated.bind(authRoutes));
    const server = app.listen(0, "127.0.0.1");
    try {
        await new Promise(resolve => server.once("listening", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const unauthenticated = await fetch(`${base}/api/settings/api-keys`, {
            headers: { accept: "application/json" },
        });
        assert.equal(unauthenticated.status, 401);

        const headers = { "content-type": "application/json", "x-test-console-session": "yes" };
        const createdResponse = await fetch(`${base}/api/settings/api-keys`, {
            body: JSON.stringify({ name: "New client" }),
            headers,
            method: "POST",
        });
        assert.equal(createdResponse.status, 201);
        assert.equal(createdResponse.headers.get("cache-control"), "no-store");
        const created = await createdResponse.json();
        assert.equal(store.match(created.key)?.id, created.record.id);

        const listResponse = await fetch(`${base}/api/settings/api-keys`, { headers });
        const listText = await listResponse.text();
        assert.equal(listResponse.headers.get("cache-control"), "no-store");
        assert.equal(listText.includes(created.key), false);
        assert.equal(listText.includes("legacy-console-key"), false);
        assert.equal(JSON.parse(listText).count, 2);

        const secretUrl = `${base}/api/settings/api-keys/${created.record.id}/secret`;
        const deniedSecret = await fetch(secretUrl, { headers: { accept: "application/json" } });
        assert.equal(deniedSecret.status, 401);
        const secretResponse = await fetch(secretUrl, { headers });
        assert.equal(secretResponse.headers.get("cache-control"), "no-store");
        assert.deepEqual(await secretResponse.json(), { key: created.key });

        const legacyId = store.list().keys.find(record => record.source === "legacy").id;
        const legacySecret = await fetch(`${base}/api/settings/api-keys/${legacyId}/secret`, { headers });
        assert.deepEqual(await legacySecret.json(), { key: "legacy-console-key" });
        config.webConsolePassword = null;
        for (const [url, method] of [
            [`${base}/api/settings/api-keys`, "GET"],
            [secretUrl, "GET"],
            [`${base}/api/settings/api-keys`, "POST"],
            [`${base}/api/settings/api-keys/${legacyId}`, "DELETE"],
        ]) {
            const denied = await fetch(url, { headers, method });
            assert.equal(denied.status, 403);
            assert.equal(denied.headers.get("cache-control"), "no-store");
            assert.match((await denied.json()).error, /web console password/);
        }
        config.webConsolePassword = "console-password";
        const lastLegacy = await fetch(`${base}/api/settings/api-keys/${legacyId}`, { headers, method: "DELETE" });
        assert.equal(lastLegacy.status, 204);
        const revoked = await fetch(`${base}/api/settings/api-keys/${created.record.id}`, {
            headers,
            method: "DELETE",
        });
        assert.equal(revoked.status, 204);
        assert.equal((await fetch(secretUrl, { headers })).status, 404);
        assert.equal(messages.join("\n").includes(created.key), false);
    } finally {
        await new Promise(resolve => server.close(resolve));
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});
