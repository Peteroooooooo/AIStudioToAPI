const test = require("node:test");
const assert = require("node:assert/strict");

const ProxyServerSystem = require("../src/core/ProxyServerSystem");
const RequestHandler = require("../src/core/RequestHandler");

test("caller API key identity is stable across supported headers without storing the key", () => {
    const handler = Object.create(RequestHandler.prototype);
    handler.config = { apiKeys: ["sample-local-key"], sessionSecret: "stable-local-salt" };
    const fromBearer = handler._getCallerApiKeyId({ headers: { authorization: "Bearer sample-local-key" } });
    const fromGoogle = handler._getCallerApiKeyId({ headers: { "x-goog-api-key": "sample-local-key" } });
    const fromQuery = handler._getCallerApiKeyId({ headers: {}, query: { key: "sample-local-key" } });

    assert.match(fromBearer, /^[0-9a-f]{64}$/);
    assert.equal(fromBearer, fromGoogle);
    assert.equal(fromBearer, fromQuery);
    assert.equal(fromBearer.includes("sample-local-key"), false);
    assert.equal(handler._getCallerApiKeyId({ headers: { "x-api-key": "invalid" } }), null);
});

test("valid x-api-key is accepted and identified when Bearer is invalid", () => {
    const system = Object.create(ProxyServerSystem.prototype);
    system.config = { apiKeys: ["sample-local-key"] };
    system.logger = { info() {}, warn() {} };
    system.webRoutes = { authRoutes: { getClientIP: () => "127.0.0.1" } };

    const handler = Object.create(RequestHandler.prototype);
    handler.config = { apiKeys: system.config.apiKeys, sessionSecret: "stable-local-salt" };

    const req = {
        headers: { authorization: "Bearer invalid-bearer", "x-api-key": "sample-local-key" },
        path: "/v1/messages",
        query: {},
    };
    const res = {
        status() {
            throw new Error("Valid x-api-key was rejected");
        },
    };
    let nextCalls = 0;

    system._createAuthMiddleware()(req, res, () => nextCalls++);

    assert.equal(nextCalls, 1);
    assert.equal(
        handler._getCallerApiKeyId(req),
        handler._getCallerApiKeyId({ headers: { "x-api-key": "sample-local-key" } })
    );
});

test("invalid Bearer and invalid x-api-key are denied and have no caller identity", () => {
    const system = Object.create(ProxyServerSystem.prototype);
    system.config = { apiKeys: ["sample-local-key"] };
    system.logger = { info() {}, warn() {} };
    system.webRoutes = { authRoutes: { getClientIP: () => "127.0.0.1" } };

    const handler = Object.create(RequestHandler.prototype);
    handler.config = { apiKeys: system.config.apiKeys, sessionSecret: "stable-local-salt" };

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
});
