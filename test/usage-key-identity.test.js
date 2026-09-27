const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ProxyServerSystem = require("../src/core/ProxyServerSystem");
const RequestHandler = require("../src/core/RequestHandler");
const { ManagedApiKeyStore } = require("../src/utils/ManagedApiKeyStore");

function withStore(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-key-identity-"));
    const store = new ManagedApiKeyStore({ info() {}, warn() {} }, directory, ["sample-local-key"]);
    try {
        const system = Object.create(ProxyServerSystem.prototype);
        system.apiKeyStore = store;
        system.config = { sessionSecret: "stable-local-salt" };
        system.logger = { error() {}, info() {}, warn() {} };
        system.webRoutes = { authRoutes: { getClientIP: () => "127.0.0.1" } };

        const handler = Object.create(RequestHandler.prototype);
        handler.config = system.config;
        handler.serverSystem = system;
        return run({ handler, store, system });
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
}

test("caller identity stays stable across supported headers and migration", () =>
    withStore(({ handler }) => {
        const fromBearer = handler._getCallerApiKeyId({ headers: { authorization: "Bearer sample-local-key" } });
        const fromGoogle = handler._getCallerApiKeyId({ headers: { "x-goog-api-key": "sample-local-key" } });
        const fromQuery = handler._getCallerApiKeyId({ headers: {}, query: { key: "sample-local-key" } });
        const historicalId = crypto.createHmac("sha256", "stable-local-salt").update("sample-local-key").digest("hex");

        assert.equal(fromBearer, historicalId);
        assert.equal(fromBearer, fromGoogle);
        assert.equal(fromBearer, fromQuery);
        assert.equal(fromBearer.includes("sample-local-key"), false);
        assert.equal(handler._getCallerApiKeyId({ headers: { "x-api-key": "invalid" } }), null);
    }));

test("valid x-api-key is accepted and identified when Bearer is invalid", () =>
    withStore(({ handler, system }) => {
        const req = {
            headers: { authorization: "Bearer invalid-bearer", "x-api-key": "sample-local-key" },
            path: "/v1/messages",
            query: {},
        };
        const res = {
            status: () => {
                throw new Error("Valid x-api-key was rejected");
            },
        };
        let nextCalls = 0;

        system._createAuthMiddleware()(req, res, () => nextCalls++);

        assert.equal(nextCalls, 1);
        assert.equal(
            handler._getCallerApiKeyId(req),
            handler._getCallerApiKeyId({
                headers: { "x-api-key": "sample-local-key" },
            })
        );
    }));

test("query API key is removed before forwarding while usage identity remains", () =>
    withStore(({ handler, system }) => {
        const req = { headers: {}, path: "/v1beta/models", query: { key: "sample-local-key" } };
        let nextCalls = 0;
        system._createAuthMiddleware()(req, {}, () => nextCalls++);
        assert.equal(nextCalls, 1);
        assert.equal(Object.hasOwn(req.query, "key"), false);
        assert.match(handler._getCallerApiKeyId(req), /^[0-9a-f]{64}$/);
    }));

test("invalid Bearer and invalid x-api-key are denied and have no caller identity", () =>
    withStore(({ handler, system }) => {
        const req = {
            headers: { authorization: "Bearer invalid-bearer", "x-api-key": "invalid-claude-key" },
            path: "/v1/messages",
            query: {},
        };
        const res = {
            json(body) {
                this.body = body;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
        };
        let nextCalls = 0;

        system._createAuthMiddleware()(req, res, () => nextCalls++);

        assert.equal(nextCalls, 0);
        assert.equal(res.statusCode, 401);
        assert.match(res.body.error.message, /valid API key/);
        assert.equal(handler._getCallerApiKeyId(req), null);
    }));
