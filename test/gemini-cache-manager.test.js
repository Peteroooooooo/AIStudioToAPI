const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GeminiCacheManager = require("../src/core/GeminiCacheManager");

function googleRequest(messages, system = "shared system instructions") {
    return {
        contents: messages.map((text, index) => ({
            parts: [{ text }],
            role: index % 2 === 0 ? "user" : "model",
        })),
        generationConfig: { maxOutputTokens: 64 },
        systemInstruction: { parts: [{ text: system }] },
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        tools: [{ functionDeclarations: [{ name: "read_file", parameters: { type: "OBJECT" } }] }],
    };
}

function proxyRequest(body, model = "gemini-3.8-flash") {
    return {
        body: JSON.stringify(body),
        is_generative: true,
        method: "POST",
        path: `/v1beta/models/${model}:generateContent`,
    };
}

function fixture(dataDir, overrides = {}, browserOptions = {}) {
    const config = {
        cacheCheckpointTokens: 20,
        cacheEnabled: true,
        cacheMaxEntries: 20,
        cacheMinTokens: 20,
        cacheRenewWindowSeconds: 0,
        cacheTtlSeconds: 3600,
        sessionSecret: "test-only-account-key",
        ...overrides,
    };
    const requests = [];
    const queues = new Map();
    let requestNumber = 0;
    const handler = {
        _forwardRequest(request, authIndex) {
            requests.push({ authIndex, request });
            const messages = queues.get(request.request_id);
            assert.ok(messages);
            if (request.method === "DELETE" && browserOptions.deleteStartsWithEnd) {
                messages.push({ type: "STREAM_END" });
                return;
            }
            if (request.method === "DELETE" && browserOptions.deleteStatus) {
                messages.push({ event_type: "headers", status: browserOptions.deleteStatus }, { type: "STREAM_END" });
                return;
            }
            let payload;
            if (request.path.endsWith(":countTokens")) {
                payload = { totalTokens: browserOptions.countTokens?.(request) ?? 200 };
            } else if (request.path === "/v1beta/cachedContents") {
                payload = {
                    expireTime: new Date(Date.now() + 3_600_000).toISOString(),
                    name: `cachedContents/test-${requests.length}`,
                };
            } else if (request.method === "PATCH" && request.path.startsWith("/v1beta/cachedContents/")) {
                payload = {
                    expireTime: new Date(Date.now() + 3_600_000).toISOString(),
                    name: request.path.slice("/v1beta/".length),
                };
            } else if (request.method === "DELETE" && request.path.startsWith("/v1beta/cachedContents/")) {
                payload = {};
            } else {
                assert.fail(`Unexpected browser resource path: ${request.path}`);
            }
            messages.push(
                { event_type: "headers", status: 200 },
                { data: JSON.stringify(payload), event_type: "chunk" },
                { type: "STREAM_END" }
            );
        },
        _generateRequestId() {
            requestNumber++;
            return `cache-resource-${requestNumber}`;
        },
        _initializeProxyRequestAttempt(request) {
            request.request_attempt_id = `${request.request_id}-attempt-1`;
        },
        authSource: {
            accountNameMap: new Map([
                [0, "account-one"],
                [1, "account-two"],
            ]),
            availableIndices: [0, 1],
            getRotationIndices() {
                return [0, 1];
            },
            health: {
                isAvailable(index) {
                    return !browserOptions.unhealthyAccounts?.has(index);
                },
            },
        },
        config,
        connectionRegistry: {
            createMessageQueue(id) {
                const messages = [];
                queues.set(id, messages);
                return {
                    async dequeue() {
                        assert.ok(messages.length, `No browser response queued for ${id}`);
                        return messages.shift();
                    },
                };
            },
            getConnectionByAuth(index) {
                if (browserOptions.disconnectedAccounts?.has(index)) return null;
                return { readyState: 1 };
            },
            removeMessageQueue(id) {
                queues.delete(id);
            },
        },
        logger: { info() {}, warn() {} },
    };
    return { config, handler, manager: new GeminiCacheManager(handler, dataDir), requests };
}

function tempDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-cache-manager-"));
}

async function seed(manager, request, authIndex, prefixLength, name) {
    return manager.store.put({
        accountKey: manager._accountKey(authIndex),
        expireTime: new Date(Date.now() + 3_600_000).toISOString(),
        googleRequest: request,
        model: "gemini-3.8-flash",
        name,
        prefixLength,
        tokenCount: 200,
    });
}

test("cache hit sends only the dynamic suffix, and revisiting a session keeps its own prefix", async () => {
    const dataDir = tempDirectory();
    const { manager } = fixture(dataDir);
    try {
        const sessionA = googleRequest(["A1", "R1", "A2"]);
        const sessionB = googleRequest(["B1", "R1", "B2"]);
        await seed(manager, sessionA, 0, 2, "cachedContents/session-a");
        await seed(manager, sessionB, 0, 2, "cachedContents/session-b");

        const b = JSON.parse(manager.prepare(proxyRequest(sessionB), 0).body);
        assert.equal(b.cachedContent, "cachedContents/session-b");
        assert.deepEqual(b.contents, [sessionB.contents[2]]);

        const aOriginal = proxyRequest(googleRequest(["A1", "R1", "A3"]));
        const a = JSON.parse(manager.prepare(aOriginal, 0).body);
        assert.equal(a.cachedContent, "cachedContents/session-a");
        assert.deepEqual(a.contents, [JSON.parse(aOriginal.body).contents[2]]);
        assert.equal(a.generationConfig.maxOutputTokens, 64);
        for (const key of ["systemInstruction", "tools", "toolConfig"]) {
            assert.equal(Object.hasOwn(a, key), false, `${key} must not be sent twice`);
        }
        assert.equal(manager.stats().localHits, 2);

        const otherAccount = proxyRequest(googleRequest(["A1", "R1", "A3"]));
        assert.equal(manager.prepare(otherAccount, 1), otherAccount);
        const otherModel = proxyRequest(googleRequest(["A1", "R1", "A3"]), "gemini-3.7-flash");
        assert.equal(manager.prepare(otherModel, 0), otherModel);

        await seed(manager, sessionA, 0, 0, "cachedContents/shared");
        const newSession = googleRequest(["C1"]);
        const shared = JSON.parse(manager.prepare(proxyRequest(newSession), 0).body);
        assert.equal(shared.cachedContent, "cachedContents/shared");
        assert.deepEqual(shared.contents, newSession.contents);
        assert.equal(Object.hasOwn(shared, "systemInstruction"), false);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("after rotation, a connected healthy account with a longer cache prefix is selected", async () => {
    const dataDir = tempDirectory();
    const { manager } = fixture(dataDir);
    try {
        const body = googleRequest(["A1", "R1", "A2"]);
        const request = proxyRequest(body);
        await seed(manager, body, 1, 1, "cachedContents/current-short");
        await seed(manager, body, 0, 2, "cachedContents/previous-long");

        assert.equal(manager.chooseConnectedAccount(request, 1), 0);
        const forwarded = JSON.parse(manager.prepare(request, 0).body);
        assert.equal(forwarded.cachedContent, "cachedContents/previous-long");
        assert.deepEqual(forwarded.contents, [body.contents[2]]);

        await seed(manager, body, 1, 2, "cachedContents/current-tie");
        assert.equal(manager.chooseConnectedAccount(proxyRequest(body), 1), 1);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("cache affinity skips unhealthy, disconnected, or usage-exhausted accounts", async () => {
    const dataDir = tempDirectory();
    const browserOptions = { disconnectedAccounts: new Set(), unhealthyAccounts: new Set() };
    const { manager } = fixture(dataDir, { switchOnUses: 2 }, browserOptions);
    try {
        const body = googleRequest(["A1", "R1", "A2"]);
        await seed(manager, body, 0, 2, "cachedContents/previous-long");
        const request = proxyRequest(body);
        assert.equal(manager.chooseConnectedAccount(request, 1), 0);

        browserOptions.unhealthyAccounts.add(0);
        assert.equal(manager.chooseConnectedAccount(request, 1), 1);
        browserOptions.unhealthyAccounts.clear();

        browserOptions.disconnectedAccounts.add(0);
        assert.equal(manager.chooseConnectedAccount(request, 1), 1);
        browserOptions.disconnectedAccounts.clear();

        assert.equal(manager.recordAccountUse(0, 1), 1);
        assert.equal(manager.chooseConnectedAccount(request, 1), 0);
        assert.equal(manager.recordAccountUse(0, 1), 2);
        assert.equal(manager.chooseConnectedAccount(request, 1), 1);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("rejected cache resource is removed and the same request retries with its full body", async () => {
    const dataDir = tempDirectory();
    const { manager } = fixture(dataDir);
    try {
        const body = googleRequest(["A1", "R1", "A2"]);
        await seed(manager, body, 0, 2, "cachedContents/stale");
        const request = proxyRequest(body);
        assert.equal(JSON.parse(manager.prepare(request, 0).body).cachedContent, "cachedContents/stale");
        assert.equal(manager.canFallback(request, { status: 404 }), true);
        assert.equal(manager.canFallback(request, { status: 500 }), true);
        assert.equal(manager.canFallback(request, { status: 429 }), false);
        assert.equal(await manager.invalidateAndBypass(request), true);
        assert.equal(manager.prepare(request, 0), request);
        assert.deepEqual(JSON.parse(request.body), body);
        assert.equal(manager.canFallback(request, { status: 404 }), false);
        assert.equal(manager.stats().fallbacks, 1);
        assert.equal(manager.store.stats().entryCount, 0);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("a cached resource rejection does not count as an account health failure", async () => {
    const dataDir = tempDirectory();
    const { manager } = fixture(dataDir);
    try {
        const body = googleRequest(["A1", "R1", "A2"]);
        await seed(manager, body, 0, 2, "cachedContents/stale-health");
        const request = { ...proxyRequest(body), request_attempt_id: "attempt-one", request_id: "generation-one" };
        manager.prepare(request, 0);
        assert.equal(
            manager.consumeCachedAttemptOutcome({
                requestAttemptId: "attempt-one",
                requestId: "generation-one",
                status: 500,
                success: false,
            }),
            true
        );
        assert.equal(
            manager.consumeCachedAttemptOutcome({
                requestAttemptId: "attempt-one",
                requestId: "generation-one",
                status: 500,
                success: false,
            }),
            false
        );
        const uncached = { ...proxyRequest(body), request_attempt_id: "attempt-two", request_id: "generation-two" };
        manager.prepare(uncached, 1);
        assert.equal(
            manager.consumeCachedAttemptOutcome({
                requestAttemptId: "attempt-two",
                requestId: "generation-two",
                status: 500,
                success: false,
            }),
            false
        );
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("an almost expired resource is bypassed and cannot turn an ordinary error into cache fallback", async () => {
    const dataDir = tempDirectory();
    const { manager } = fixture(dataDir);
    try {
        const body = googleRequest(["A1", "R1", "A2"]);
        await manager.store.put({
            accountKey: manager._accountKey(0),
            expireTime: new Date(Date.now() + 5_000).toISOString(),
            googleRequest: body,
            model: "gemini-3.8-flash",
            name: "cachedContents/almost-expired",
            prefixLength: 2,
            tokenCount: 200,
        });
        const request = proxyRequest(body);
        assert.equal(manager.prepare(request, 0), request);
        assert.equal(manager.canFallback(request, { status: 400 }), false);
        assert.equal(manager.stats().localHits, 0);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("successful generation schedules countTokens and cachedContents creation, then survives restart", async () => {
    const dataDir = tempDirectory();
    const { handler, manager, requests } = fixture(
        dataDir,
        {},
        {
            countTokens(request) {
                const body = JSON.parse(request.body).generateContentRequest;
                return body.contents[0].parts[0].text === "." ? 200 : 500;
            },
        }
    );
    const body = googleRequest(["A1".repeat(100), "R1".repeat(100), "A2".repeat(100)]);
    try {
        const request = proxyRequest(body);
        assert.equal(manager.prepare(request, 0), request);
        const response = new EventEmitter();
        response.statusCode = 200;
        manager.attachResponse(response, request);
        response.emit("finish");
        await manager.background;

        assert.deepEqual(
            requests.map(item => item.request.path),
            ["/v1beta/models/gemini-3.8-flash:countTokens", "/v1beta/cachedContents"]
        );
        assert.deepEqual(JSON.parse(requests[0].request.body).generateContentRequest.contents, body.contents);
        const cacheBody = JSON.parse(requests[1].request.body);
        assert.deepEqual(cacheBody.contents, body.contents);
        assert.deepEqual(cacheBody.systemInstruction, body.systemInstruction);
        assert.deepEqual(cacheBody.tools, body.tools);
        assert.equal(JSON.parse(requests[1].request.body).ttl, "3600s");
        assert.equal(requests[0].authIndex, 0);
        assert.equal(requests[1].authIndex, 0);
        assert.equal(manager.stats().created, 1);
        assert.equal(manager.stats().entryCount, 1);
        await manager.close();

        const restarted = new GeminiCacheManager(handler, dataDir);
        try {
            const freshSession = googleRequest(["B1"]);
            const fresh = proxyRequest(freshSession);
            assert.equal(restarted.prepare(fresh, 0), fresh);

            const next = googleRequest([...body.contents.map(message => message.parts[0].text), "R2", "A3"]);
            const result = JSON.parse(restarted.prepare(proxyRequest(next), 0).body);
            assert.equal(result.cachedContent, "cachedContents/test-2");
            assert.deepEqual(result.contents, next.contents.slice(3));
        } finally {
            await restarted.close();
        }
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("zero checkpoint interval creates each distinct history prefix above the minimum", async () => {
    const dataDir = tempDirectory();
    const { manager, requests } = fixture(
        dataDir,
        { cacheCheckpointTokens: 0, cacheMinTokens: 1024 },
        {
            countTokens(request) {
                const body = JSON.parse(request.body).generateContentRequest;
                return 1024 + body.contents.length * 2;
            },
        }
    );
    const messages = ["long initial prompt ".repeat(100), "short answer", "next question"];
    const firstBody = { contents: googleRequest(messages.slice(0, 1)).contents };
    const nextBody = { contents: googleRequest(messages).contents };
    const finish = async body => {
        const request = proxyRequest(body);
        manager.prepare(request, 0);
        const response = new EventEmitter();
        response.statusCode = 200;
        manager.attachResponse(response, request);
        response.emit("finish");
        await manager.background;
    };
    try {
        await finish(firstBody);
        assert.equal(requests.filter(item => item.request.path === "/v1beta/cachedContents").length, 1);
        await finish(nextBody);
        assert.equal(requests.filter(item => item.request.path === "/v1beta/cachedContents").length, 2);
        await finish(nextBody);
        assert.equal(requests.filter(item => item.request.path === "/v1beta/cachedContents").length, 2);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("a reused near-expiry cache is renewed without discarding its prefix mapping", async () => {
    const dataDir = tempDirectory();
    const { manager, requests } = fixture(dataDir, { cacheRenewWindowSeconds: 120 });
    try {
        const body = googleRequest(["A1", "R1", "A2"]);
        await manager.store.put({
            accountKey: manager._accountKey(0),
            expireTime: new Date(Date.now() + 60_000).toISOString(),
            googleRequest: body,
            model: "gemini-3.8-flash",
            name: "cachedContents/renew-me",
            prefixLength: 2,
            tokenCount: 200,
        });
        const request = proxyRequest(body);
        assert.equal(JSON.parse(manager.prepare(request, 0).body).cachedContent, "cachedContents/renew-me");
        const response = new EventEmitter();
        response.statusCode = 200;
        manager.attachResponse(response, request);
        response.emit("finish");
        await manager.background;

        const renewal = requests.find(item => item.request.method === "PATCH");
        assert.ok(renewal);
        assert.equal(renewal.request.path, "/v1beta/cachedContents/renew-me");
        assert.deepEqual(renewal.request.query_params, { updateMask: "ttl" });
        assert.equal(JSON.parse(renewal.request.body).ttl, "3600s");
        assert.equal(manager.stats().renewals, 1);
        const next = proxyRequest(googleRequest(["A1", "R1", "A3"]));
        assert.equal(JSON.parse(manager.prepare(next, 0).body).cachedContent, "cachedContents/renew-me");
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("empty DELETE resource responses may end before a headers event", async () => {
    const dataDir = tempDirectory();
    const { manager } = fixture(dataDir, {}, { deleteStartsWithEnd: true });
    try {
        const result = await manager._resourceRequest(0, {
            method: "DELETE",
            path: "/v1beta/cachedContents/expired",
        });
        assert.deepEqual(result, {});
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("1024-token minimum and 1024-token growth replace only the previous history checkpoint", async () => {
    const dataDir = tempDirectory();
    const tokens = new Map([
        [1, 1024],
        [3, 1800],
        [5, 2048],
    ]);
    const { manager, requests } = fixture(
        dataDir,
        { cacheCheckpointTokens: 1024, cacheMinTokens: 1024 },
        {
            countTokens(request) {
                const contents = JSON.parse(request.body).generateContentRequest.contents;
                return contents[0].parts[0].text === "." ? 100 : tokens.get(contents.length);
            },
        }
    );
    const messages = ["A1 ".repeat(400), "R1", "A2", "R2", "A3"];
    const finish = async count => {
        const request = proxyRequest(googleRequest(messages.slice(0, count)));
        manager.prepare(request, 0);
        const response = new EventEmitter();
        response.statusCode = 200;
        manager.attachResponse(response, request);
        response.emit("finish");
        while (manager.queuedTasks > 0) await manager.background;
    };
    try {
        await finish(1);
        await finish(3);
        assert.equal(requests.filter(item => item.request.path === "/v1beta/cachedContents").length, 1);
        await finish(5);
        assert.equal(requests.filter(item => item.request.path === "/v1beta/cachedContents").length, 2);
        assert.equal(
            requests
                .filter(item => item.request.method === "DELETE")
                .map(item => item.request.path)
                .join(),
            "/v1beta/cachedContents/test-2"
        );
        assert.equal(manager.stats().entryCount, 1);
        assert.deepEqual(manager.store.pendingDeleteEntries(), []);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("a same-branch in-flight hit defers old resource deletion until the response closes", async () => {
    const dataDir = tempDirectory();
    const { manager, requests } = fixture(dataDir, {}, { countTokens: () => 2300 });
    const body = googleRequest(["A1", "R1", "A2"]);
    try {
        await seed(manager, body, 0, 1, "cachedContents/active-ancestor");
        const activeRequest = proxyRequest(body);
        manager.prepare(activeRequest, 0);
        const activeResponse = new EventEmitter();
        manager.attachResponse(activeResponse, activeRequest);

        await manager._create(
            {
                accountKey: manager._accountKey(0),
                authIndex: 0,
                googleRequest: googleRequest(["A1", "R1", "A2"]),
                model: "gemini-3.8-flash",
            },
            3
        );
        assert.equal(manager.stats().entryCount, 2);
        assert.equal(manager.deferredAncestors.size, 1);
        assert.equal(requests.filter(item => item.request.method === "DELETE").length, 0);
        assert.equal(
            manager.store.findLongest({
                accountKey: manager._accountKey(0),
                googleRequest: body,
                maxPrefixLength: 1,
                model: "gemini-3.8-flash",
            }).entry.name,
            "cachedContents/active-ancestor"
        );
        activeResponse.emit("close");
        while (manager.queuedTasks > 0) await manager.background;
        assert.equal(manager.stats().entryCount, 1);
        assert.equal(manager.deferredAncestors.size, 0);
        assert.equal(
            requests
                .filter(item => item.request.method === "DELETE")
                .map(item => item.request.path)
                .join(),
            "/v1beta/cachedContents/active-ancestor"
        );
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("a concurrent request that forks from an ancestor keeps that shared history resource", async () => {
    const dataDir = tempDirectory();
    const { manager, requests } = fixture(dataDir, {}, { countTokens: () => 2300 });
    const forkBody = googleRequest(["A1", "R1", "B2"]);
    try {
        await seed(manager, forkBody, 0, 1, "cachedContents/fork-root");
        const activeRequest = proxyRequest(forkBody);
        manager.prepare(activeRequest, 0);
        const activeResponse = new EventEmitter();
        manager.attachResponse(activeResponse, activeRequest);

        await manager._create(
            {
                accountKey: manager._accountKey(0),
                authIndex: 0,
                googleRequest: googleRequest(["A1", "R1", "A2"]),
                model: "gemini-3.8-flash",
            },
            3
        );
        assert.equal(manager.deferredAncestors.size, 1);
        activeResponse.emit("close");
        while (manager.queuedTasks > 0) await manager.background;
        assert.equal(manager.deferredAncestors.size, 0);
        assert.equal(manager.stats().entryCount, 2);
        assert.equal(requests.filter(item => item.request.method === "DELETE").length, 0);
        assert.equal(
            manager.store.findLongest({
                accountKey: manager._accountKey(0),
                googleRequest: forkBody,
                model: "gemini-3.8-flash",
            }).entry.name,
            "cachedContents/fork-root"
        );
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("deferred branch metadata clears when its old resource expires or is evicted", async () => {
    for (const removeBy of ["expiry", "capacity"]) {
        const dataDir = tempDirectory();
        const { manager } = fixture(
            dataDir,
            { cacheMaxEntries: removeBy === "capacity" ? 1 : 20 },
            { countTokens: () => 2300 }
        );
        const forkBody = googleRequest(["A1", "R1", "B2"]);
        try {
            const old = await seed(manager, forkBody, 0, 1, `cachedContents/${removeBy}-old`);
            const activeRequest = proxyRequest(forkBody);
            manager.prepare(activeRequest, 0);
            const activeResponse = new EventEmitter();
            manager.attachResponse(activeResponse, activeRequest);
            await manager._create(
                {
                    accountKey: manager._accountKey(0),
                    authIndex: 0,
                    googleRequest: googleRequest(["A1", "R1", "A2"]),
                    model: "gemini-3.8-flash",
                },
                3
            );
            if (removeBy === "expiry") {
                assert.equal(manager.deferredAncestors.size, 1);
                manager.store.entries.get(old.hash).expireTime = new Date(Date.now() - 1).toISOString();
                manager._deleteEvicted();
            }
            assert.equal(manager.deferredAncestors.size, 0, `${removeBy} must release the history reference`);
            activeResponse.emit("close");
        } finally {
            await manager.close();
            fs.rmSync(dataDir, { force: true, recursive: true });
        }
    }
});

test("a queued renewal cannot restore an ancestor retired by a newer checkpoint", async () => {
    const dataDir = tempDirectory();
    const { manager, requests } = fixture(dataDir, { cacheRenewWindowSeconds: 120 }, { countTokens: () => 2300 });
    const body = googleRequest(["A1", "R1", "A2"]);
    try {
        const old = await manager.store.put({
            accountKey: manager._accountKey(0),
            expireTime: new Date(Date.now() + 60_000).toISOString(),
            googleRequest: body,
            model: "gemini-3.8-flash",
            name: "cachedContents/renew-old",
            prefixLength: 1,
            tokenCount: 200,
        });
        await manager._create(
            { accountKey: manager._accountKey(0), authIndex: 0, googleRequest: body, model: "gemini-3.8-flash" },
            3
        );
        manager._maybeRenew({
            accountKey: manager._accountKey(0),
            authIndex: 0,
            googleRequest: body,
            hit: old,
            model: "gemini-3.8-flash",
        });
        while (manager.queuedTasks > 0) await manager.background;
        assert.equal(manager.stats().entryCount, 1);
        assert.equal(manager.stats().renewals, 0);
        assert.equal(requests.filter(item => item.request.method === "PATCH").length, 0);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("failed remote deletion stays on disk and clears when a retry finds it already gone", async () => {
    const dataDir = tempDirectory();
    const browserOptions = { countTokens: () => 2300, deleteStatus: 503 };
    const { handler, manager, requests } = fixture(dataDir, {}, browserOptions);
    try {
        const body = googleRequest(["A1", "R1", "A2"]);
        await seed(manager, body, 0, 1, "cachedContents/old");
        await manager._create(
            { accountKey: manager._accountKey(0), authIndex: 0, googleRequest: body, model: "gemini-3.8-flash" },
            3
        );
        await manager.close();
        assert.deepEqual(
            manager.store.pendingDeleteEntries().map(entry => entry.name),
            ["cachedContents/old"]
        );

        browserOptions.deleteStatus = 404;
        const restarted = new GeminiCacheManager(handler, dataDir);
        try {
            restarted.chooseConnectedAccount(proxyRequest(googleRequest(["B1"])), 0);
            while (restarted.queuedTasks > 0) await restarted.background;
            assert.deepEqual(restarted.store.pendingDeleteEntries(), []);
            assert.ok(requests.filter(item => item.request.method === "DELETE").length >= 2);
        } finally {
            await restarted.close();
        }
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("failed remote deletion backs off across requests and retries after observed reconnection", async () => {
    const dataDir = tempDirectory();
    const browserOptions = { countTokens: () => 2300, deleteStatus: 503, disconnectedAccounts: new Set() };
    const { manager, requests } = fixture(dataDir, {}, browserOptions);
    try {
        const body = googleRequest(["A1", "R1", "A2"]);
        await seed(manager, body, 0, 1, "cachedContents/backoff-old");
        await manager._create(
            { accountKey: manager._accountKey(0), authIndex: 0, googleRequest: body, model: "gemini-3.8-flash" },
            3
        );
        while (manager.queuedTasks > 0) await manager.background;
        assert.equal(requests.filter(item => item.request.method === "DELETE").length, 1);

        for (let index = 0; index < 5; index++) {
            manager.chooseConnectedAccount(proxyRequest(googleRequest(["B1"])), 0);
        }
        while (manager.queuedTasks > 0) await manager.background;
        assert.equal(requests.filter(item => item.request.method === "DELETE").length, 1);
        assert.equal(manager.store.pendingDeleteEntries().length, 1);

        browserOptions.disconnectedAccounts.add(0);
        manager.chooseConnectedAccount(proxyRequest(googleRequest(["B1"])), 0);
        browserOptions.disconnectedAccounts.delete(0);
        browserOptions.deleteStatus = null;
        manager.chooseConnectedAccount(proxyRequest(googleRequest(["B1"])), 0);
        while (manager.queuedTasks > 0) await manager.background;
        assert.equal(requests.filter(item => item.request.method === "DELETE").length, 2);
        assert.deepEqual(manager.store.pendingDeleteEntries(), []);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("a disconnected owner account keeps the pending deletion until it reconnects", async () => {
    const dataDir = tempDirectory();
    const browserOptions = { disconnectedAccounts: new Set() };
    const { manager, requests } = fixture(dataDir, {}, browserOptions);
    try {
        const body = googleRequest(["A1", "R1", "A2"]);
        await seed(manager, body, 0, 1, "cachedContents/disconnected-old");
        await manager.store.put({
            accountKey: manager._accountKey(0),
            expireTime: new Date(Date.now() + 3_600_000).toISOString(),
            googleRequest: body,
            model: "gemini-3.8-flash",
            name: "cachedContents/disconnected-new",
            prefixLength: 3,
            retireAncestors: true,
            tokenCount: 2300,
        });
        browserOptions.disconnectedAccounts.add(0);
        manager._deleteEvicted();
        assert.equal(requests.filter(item => item.request.method === "DELETE").length, 0);
        assert.deepEqual(
            manager.store.pendingDeleteEntries().map(entry => entry.name),
            ["cachedContents/disconnected-old"]
        );

        browserOptions.disconnectedAccounts.delete(0);
        manager.chooseConnectedAccount(proxyRequest(googleRequest(["B1"])), 0);
        while (manager.queuedTasks > 0) await manager.background;
        assert.equal(requests.filter(item => item.request.method === "DELETE").length, 1);
        assert.deepEqual(manager.store.pendingDeleteEntries(), []);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("retiring and near-expiry longest caches fall back to a shorter usable prefix", async () => {
    const dataDir = tempDirectory();
    const { manager } = fixture(dataDir);
    try {
        const body = googleRequest(["A1", "R1", "A2", "R2", "A3"]);
        await seed(manager, body, 0, 1, "cachedContents/usable-short");
        const retiring = await seed(manager, body, 0, 3, "cachedContents/retiring-long");
        manager.retiringCacheUses.add(manager._cacheUseKey(retiring));
        await manager.store.put({
            accountKey: manager._accountKey(0),
            expireTime: new Date(Date.now() + 5_000).toISOString(),
            googleRequest: body,
            model: "gemini-3.8-flash",
            name: "cachedContents/expiring-longest",
            prefixLength: 4,
            tokenCount: 200,
        });
        const candidates = manager.findOwnerCandidates(proxyRequest(body), [0, 1]);
        assert.deepEqual(
            candidates.map(({ authIndex, prefixLength }) => ({ authIndex, prefixLength })),
            [{ authIndex: 0, prefixLength: 1 }]
        );
        const prepared = JSON.parse(manager.prepare(proxyRequest(body), 0).body);
        assert.equal(prepared.cachedContent, "cachedContents/usable-short");
        assert.deepEqual(prepared.contents, body.contents.slice(1));
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("owner discovery is caller scoped and a shared template cannot establish conversation affinity", async () => {
    const dataDir = tempDirectory();
    const { handler, manager } = fixture(dataDir);
    const body = googleRequest(["private first", "answer", "new question"]);
    try {
        await manager.store.put({
            accountKey: manager._accountKey(1),
            expireTime: new Date(Date.now() + 3_600_000).toISOString(),
            googleRequest: body,
            model: "gemini-3.8-flash",
            name: "cachedContents/caller-one-history",
            prefixLength: 2,
            scopeKey: "caller-one",
            tokenCount: 200,
        });
        await seed(manager, body, 0, 0, "cachedContents/legacy-template");
        const scoped = { ...proxyRequest(body), cache_scope: "caller-one" };
        assert.deepEqual(
            manager.findOwnerCandidates(scoped, [0, 1]).map(item => item.authIndex),
            [1]
        );
        assert.equal(JSON.parse(manager.prepare(scoped, 1).body).cachedContent, "cachedContents/caller-one-history");
        const otherCaller = { ...proxyRequest(body), cache_scope: "caller-two" };
        assert.deepEqual(manager.findOwnerCandidates(otherCaller, [0, 1]), []);
        assert.equal(manager.prepare(otherCaller, 1), otherCaller);
        const unrelated = proxyRequest(googleRequest(["unrelated", "answer", "question"]));
        assert.deepEqual(manager.findOwnerCandidates(unrelated, [0, 1]), []);
        await manager.close();
        const restarted = new GeminiCacheManager(handler, dataDir);
        try {
            assert.deepEqual(
                restarted.findOwnerCandidates(scoped, [0, 1]).map(item => item.authIndex),
                [1]
            );
            assert.deepEqual(restarted.findOwnerCandidates(otherCaller, [0, 1]), []);
        } finally {
            await restarted.close();
        }
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("pending history creation identifies its owner and prevents a second healthy account from copying it", async () => {
    const dataDir = tempDirectory();
    const { manager, requests } = fixture(dataDir);
    let release;
    manager.background = new Promise(resolve => {
        release = resolve;
    });
    try {
        const body = googleRequest(["first", "answer"]);
        const first = manager._requestInfo({ ...proxyRequest(body), cache_scope: "caller" }, 0);
        manager._scheduleCreate(first);
        const continued = { ...proxyRequest(googleRequest(["first", "answer", "next"])), cache_scope: "caller" };
        assert.deepEqual(
            manager.findOwnerCandidates(continued, [0, 1]).map(({ authIndex, pending }) => ({ authIndex, pending })),
            [{ authIndex: 0, pending: true }]
        );
        manager._scheduleCreate(manager._requestInfo({ ...proxyRequest(body), cache_scope: "caller" }, 1));
        assert.equal(manager.pendingCreates.size, 1);
        release();
        await manager.background;
        assert.equal(requests.filter(item => item.request.path === "/v1beta/cachedContents").length, 1);
        assert.ok(requests.every(item => item.authIndex === 0));
        assert.equal(manager.pendingOwners.size, 0);
        // Already-created identical content is not duplicated on another account.
        manager._scheduleCreate(manager._requestInfo({ ...proxyRequest(body), cache_scope: "caller" }, 1));
        await manager.background;
        assert.equal(requests.filter(item => item.request.path === "/v1beta/cachedContents").length, 1);
    } finally {
        release?.();
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("migration cancels old queued creation and allows only the new owner to build", async () => {
    const dataDir = tempDirectory();
    const { handler, manager, requests } = fixture(dataDir);
    let owner = 0;
    handler.accountScheduler = {
        isAccountAvailable: () => true,
        isCurrentOwner: (lease, authIndex) => lease?.authIndex === owner && authIndex === owner,
        waitForMaintenance: async () => true,
    };
    let release;
    manager.background = new Promise(resolve => {
        release = resolve;
    });
    try {
        const body = googleRequest(["first", "answer"]);
        const first = { ...proxyRequest(body), account_lease: { authIndex: 0 }, cache_scope: "caller" };
        manager._scheduleCreate(manager._requestInfo(first, 0));
        owner = 1;
        const migrated = { ...proxyRequest(body), account_lease: { authIndex: 1 }, cache_scope: "caller" };
        manager._scheduleCreate(manager._requestInfo(migrated, 1));
        const continued = { ...proxyRequest(googleRequest(["first", "answer", "next"])), cache_scope: "caller" };
        assert.deepEqual(
            manager.findOwnerCandidates(continued, [0, 1]).map(item => item.authIndex),
            [1]
        );
        release();
        await manager.background;
        assert.equal(requests.filter(item => item.request.path === "/v1beta/cachedContents").length, 1);
        assert.ok(requests.every(item => item.authIndex === 1));
        assert.equal(manager.pendingOwners.size, 0);
    } finally {
        release?.();
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("the migrated owner may rebuild after A recovers without returning the conversation to A", async () => {
    const dataDir = tempDirectory();
    const { handler, manager, requests } = fixture(dataDir);
    handler.accountScheduler = {
        isAccountAvailable: () => true,
        isCurrentOwner: (lease, index) => lease?.key === "conversation" && lease?.version === 2 && index === 1,
        waitForMaintenance: async () => true,
    };
    try {
        const body = googleRequest(["first", "answer"]);
        await manager.store.put({
            accountKey: manager._accountKey(0),
            conversationKey: "conversation",
            expireTime: new Date(Date.now() + 3_600_000).toISOString(),
            googleRequest: body,
            model: "gemini-3.8-flash",
            name: "cachedContents/recovered-a",
            ownerVersion: 1,
            prefixLength: 2,
            scopeKey: "caller",
            tokenCount: 200,
        });
        const request = {
            ...proxyRequest(body),
            account_lease: { authIndex: 1, key: "conversation", version: 2 },
            cache_scope: "caller",
        };
        manager._scheduleCreate(manager._requestInfo(request, 1));
        await manager.background;
        assert.equal(requests.filter(item => item.request.path === "/v1beta/cachedContents").length, 1);
        assert.ok(requests.every(item => item.authIndex === 1));
        const next = { ...proxyRequest(googleRequest(["first", "answer", "next"])), cache_scope: "caller" };
        assert.ok(JSON.parse(manager.prepare(next, 1).body).cachedContent);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("a late cache creation response after migration is queued for deletion, never restored as usable", async () => {
    const dataDir = tempDirectory();
    const { handler, manager } = fixture(dataDir);
    let current = true;
    handler.accountScheduler = {
        isAccountAvailable: () => true,
        isCurrentOwner: () => current,
        waitForMaintenance: async () => true,
    };
    manager._resourceRequest = async (_index, request) => {
        if (request.path.endsWith(":countTokens")) return { totalTokens: 1000 };
        current = false;
        return { expireTime: new Date(Date.now() + 3_600_000).toISOString(), name: "cachedContents/late-old-owner" };
    };
    try {
        const body = googleRequest(["first", "answer"]);
        const info = manager._requestInfo({ ...proxyRequest(body), account_lease: { authIndex: 0 } }, 0);
        manager._deleteEvicted = () => {};
        await manager._create(info, 2);
        assert.equal(manager.stats().entryCount, 0);
        assert.deepEqual(
            manager.store.pendingDeleteEntries().map(item => item.name),
            ["cachedContents/late-old-owner"]
        );
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("short media URIs use countTokens rather than the JSON byte length", async () => {
    const dataDir = tempDirectory();
    const { manager, requests } = fixture(
        dataDir,
        { cacheCheckpointTokens: 1024, cacheMinTokens: 1024 },
        { countTokens: () => 4096 }
    );
    try {
        const body = {
            contents: [{ parts: [{ fileData: { fileUri: "files/a", mimeType: "video/mp4" } }], role: "user" }],
        };
        assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1024);
        await manager._create(manager._requestInfo(proxyRequest(body), 0), 1);
        assert.deepEqual(
            requests.map(item => item.request.path),
            ["/v1beta/models/gemini-3.8-flash:countTokens", "/v1beta/cachedContents"]
        );
        assert.equal(manager.stats().entryCount, 1);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("maintenance yields to generation and unsupported creation backs off without preventing generation", async () => {
    const dataDir = tempDirectory();
    const { handler, manager, requests } = fixture(dataDir);
    let maintenanceAllowed = false;
    handler.accountScheduler = {
        isAccountAvailable: () => true,
        isCurrentOwner: () => true,
        waitForMaintenance: async () => maintenanceAllowed,
    };
    try {
        const body = googleRequest(["first", "answer"]);
        const info = manager._requestInfo(proxyRequest(body), 0);
        manager._scheduleCreate(info);
        await manager.background;
        assert.equal(requests.length, 0);
        maintenanceAllowed = true;
        manager._resourceRequest = async () => {
            throw Object.assign(new Error("unsupported"), { status: 400 });
        };
        manager._scheduleCreate(info);
        await manager.background;
        assert.ok(manager.maintenanceRetryAfter.get(manager._maintenanceKey(info)) > Date.now() + 500_000);
        manager._scheduleCreate(info);
        assert.equal(manager.queuedTasks, 0);
        const generation = proxyRequest(body);
        assert.equal(manager.prepare(generation, 0), generation);
    } finally {
        await manager.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});
