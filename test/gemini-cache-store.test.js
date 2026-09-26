const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const GeminiCacheStore = require("../src/core/GeminiCacheStore");

const logger = { warn() {} };

function temporaryStore(config = { cacheMaxEntries: 10 }) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-gemini-cache-"));
    return { config, dataDir, store: new GeminiCacheStore({ config, dataDir, logger }) };
}

function request(system, messages = ["A1", "R1", "A2"]) {
    return {
        contents: messages.map((text, index) => ({
            parts: [{ text }],
            role: index % 2 === 0 ? "user" : "model",
        })),
        systemInstruction: { parts: [{ text: system }] },
        tools: [{ functionDeclarations: [{ name: "read_file", parameters: { type: "OBJECT" } }] }],
    };
}

function cacheArguments(googleRequest, overrides = {}) {
    return {
        accountKey: "account-1",
        expireTime: new Date(Date.now() + 60_000).toISOString(),
        googleRequest,
        model: "gemini-3.8-flash",
        name: "cachedContents/example",
        prefixLength: googleRequest.contents.length - 1,
        tokenCount: 6000,
        ...overrides,
    };
}

test("matches the longest exact complete-message prefix across sessions and isolates accounts and models", async () => {
    const { dataDir, store } = temporaryStore();
    try {
        const conversationA = request("private shared instructions", ["A1", "R1", "A2"]);
        await store.put(cacheArguments(conversationA, { name: "cachedContents/a" }));
        await store.put(cacheArguments(conversationA, { name: "cachedContents/short", prefixLength: 1 }));
        const continuedA = request("private shared instructions", ["A1", "R1", "A3"]);
        const found = store.findLongest({
            accountKey: "account-1",
            googleRequest: continuedA,
            model: "gemini-3.8-flash",
        });
        assert.equal(found.prefixLength, 2);
        assert.equal(found.entry.name, "cachedContents/a");

        const changedHistory = request("private shared instructions", ["A1 changed", "R1", "A3"]);
        assert.equal(
            store.findLongest({ accountKey: "account-1", googleRequest: changedHistory, model: "gemini-3.8-flash" }),
            null
        );
        assert.equal(
            store.findLongest({ accountKey: "account-2", googleRequest: continuedA, model: "gemini-3.8-flash" }),
            null
        );
        assert.equal(
            store.findLongest({ accountKey: "account-1", googleRequest: continuedA, model: "gemini-3.7-flash" }),
            null
        );

        const reordered = {
            contents: [
                { parts: [{ text: "A1" }], role: "user" },
                { parts: [{ text: "R1" }], role: "model" },
                { parts: [{ text: "A4" }], role: "user" },
            ],
            systemInstruction: conversationA.systemInstruction,
            tools: conversationA.tools,
        };
        assert.equal(
            store.findLongest({ accountKey: "account-1", googleRequest: reordered, model: "gemini-3.8-flash" })
                .prefixLength,
            2
        );

        const newSession = request("private shared instructions", ["B1"]);
        await store.put(cacheArguments(newSession, { name: "cachedContents/shared", prefixLength: 0 }));
        const anotherSession = request("private shared instructions", ["C1"]);
        assert.equal(
            store.findLongest({ accountKey: "account-1", googleRequest: anotherSession, model: "gemini-3.8-flash" })
                .entry.name,
            "cachedContents/shared"
        );
        anotherSession.tools[0].functionDeclarations[0].name = "write_file";
        assert.equal(
            store.findLongest({ accountKey: "account-1", googleRequest: anotherSession, model: "gemini-3.8-flash" }),
            null
        );

        const onDisk = fs.readFileSync(store.filePath, "utf8");
        assert.equal(onDisk.includes("private shared instructions"), false);
        assert.equal(onDisk.includes("A1"), false);
        assert.equal(onDisk.includes("read_file"), false);
    } finally {
        await store.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("survives restart, rejects expired resources, and only removes the matching resource version", async () => {
    const { dataDir, config, store } = temporaryStore();
    const conversation = request("system", ["A1", "R1", "A2"]);
    try {
        const original = await store.put(cacheArguments(conversation, { name: "cachedContents/old" }));
        const replacement = await store.put(cacheArguments(conversation, { name: "cachedContents/new" }));
        assert.deepEqual(
            replacement.evicted.map(entry => entry.name),
            ["cachedContents/old"]
        );
        assert.equal(await store.remove(original), false);
        assert.equal(await store.recordHit(replacement), true);
        await store.close();

        const restarted = new GeminiCacheStore({ config, dataDir, logger });
        try {
            const found = restarted.findLongest({
                accountKey: "account-1",
                googleRequest: request("system", ["A1", "R1", "A3"]),
                model: "gemini-3.8-flash",
            });
            assert.equal(found.entry.name, "cachedContents/new");
            assert.equal(found.entry.hitCount, 1);
            assert.equal(
                restarted.findLongest({
                    accountKey: "account-1",
                    googleRequest: conversation,
                    model: "gemini-3.8-flash",
                    now: Date.now() + 120_000,
                }),
                null
            );
            assert.equal(await restarted.remove(found.entry), true);
            assert.equal(restarted.stats().entryCount, 0);
        } finally {
            await restarted.close();
        }
    } finally {
        await store.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("hot capacity limit keeps recently used entries and prunes old ones on disk", async () => {
    const { dataDir, config, store } = temporaryStore({ cacheMaxEntries: 3 });
    try {
        const a = request("system A", ["A1"]);
        const b = request("system B", ["B1"]);
        const c = request("system C", ["C1"]);
        const entryA = await store.put(cacheArguments(a, { name: "cachedContents/a", prefixLength: 0 }));
        await new Promise(resolve => setTimeout(resolve, 5));
        await store.put(cacheArguments(b, { name: "cachedContents/b", prefixLength: 0 }));
        await new Promise(resolve => setTimeout(resolve, 5));
        await store.put(cacheArguments(c, { name: "cachedContents/c", prefixLength: 0 }));
        await new Promise(resolve => setTimeout(resolve, 5));
        await store.recordHit(entryA);

        config.cacheMaxEntries = 2;
        assert.equal(
            store.findLongest({ accountKey: "account-1", googleRequest: a, model: "gemini-3.8-flash" }).entry.name,
            "cachedContents/a"
        );
        assert.equal(store.findLongest({ accountKey: "account-1", googleRequest: b, model: "gemini-3.8-flash" }), null);
        assert.equal(
            store.findLongest({ accountKey: "account-1", googleRequest: c, model: "gemini-3.8-flash" }).entry.name,
            "cachedContents/c"
        );
        await store.close();
        assert.ok(store.takeEvicted().some(entry => entry.name === "cachedContents/b"));

        const restarted = new GeminiCacheStore({ config, dataDir, logger });
        try {
            assert.equal(restarted.stats().entryCount, 2);
            assert.equal(
                restarted.findLongest({ accountKey: "account-1", googleRequest: b, model: "gemini-3.8-flash" }),
                null
            );
            config.cacheMaxEntries = 0;
            assert.equal(
                restarted.findLongest({ accountKey: "account-1", googleRequest: a, model: "gemini-3.8-flash" }),
                null
            );
            await restarted.close();
            assert.equal(JSON.parse(fs.readFileSync(restarted.filePath, "utf8")).entries.length, 0);
        } finally {
            await restarted.close();
        }
    } finally {
        await store.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("a complete background snapshot matches a later turn while generation leaves the newest message dynamic", async () => {
    const { dataDir, store } = temporaryStore();
    try {
        const googleRequest = request("system", ["A1", "R1"]);
        await assert.rejects(
            store.put(cacheArguments(googleRequest, { prefixLength: 3 })),
            /complete contents message boundary/
        );
        await store.put(cacheArguments(googleRequest, { prefixLength: 2 }));
        assert.equal(store.findLongest({ accountKey: "account-1", googleRequest, model: "gemini-3.8-flash" }), null);
        assert.equal(
            store.findLongest({
                accountKey: "account-1",
                googleRequest,
                maxPrefixLength: 2,
                model: "gemini-3.8-flash",
            }).prefixLength,
            2
        );
        const continued = request("system", ["A1", "R1", "A2"]);
        assert.equal(
            store.findLongest({ accountKey: "account-1", googleRequest: continued, model: "gemini-3.8-flash" })
                .prefixLength,
            2
        );
    } finally {
        await store.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});

test("a new history checkpoint retires its ancestors but preserves shared instructions and other sessions", async () => {
    const { dataDir, config, store } = temporaryStore();
    try {
        const first = request("shared", ["A1", "R1", "A2", "R2"]);
        const other = request("shared", ["B1", "R1", "B2"]);
        await store.put(cacheArguments(first, { name: "cachedContents/static", prefixLength: 0 }));
        await store.put(cacheArguments(first, { name: "cachedContents/ancestor", prefixLength: 2 }));
        await store.put(cacheArguments(other, { name: "cachedContents/other", prefixLength: 2 }));

        const checkpoint = await store.put(
            cacheArguments(first, { name: "cachedContents/new", prefixLength: 4, retireAncestors: true })
        );
        assert.deepEqual(
            checkpoint.evicted.map(entry => entry.name),
            ["cachedContents/ancestor"]
        );
        assert.deepEqual(
            store.pendingDeleteEntries().map(entry => entry.name),
            ["cachedContents/ancestor"]
        );
        assert.equal(
            store.findLongest({ accountKey: "account-1", googleRequest: other, model: "gemini-3.8-flash" }).entry.name,
            "cachedContents/other"
        );
        assert.equal(
            store.findLongest({
                accountKey: "account-1",
                googleRequest: request("shared", ["C1"]),
                model: "gemini-3.8-flash",
            }).entry.name,
            "cachedContents/static"
        );

        await store.close();
        const restarted = new GeminiCacheStore({ config, dataDir, logger });
        try {
            assert.deepEqual(
                restarted.pendingDeleteEntries().map(entry => entry.name),
                ["cachedContents/ancestor"]
            );
            assert.equal(await restarted.markDeleted(checkpoint.evicted[0]), true);
            assert.deepEqual(restarted.pendingDeleteEntries(), []);
        } finally {
            await restarted.close();
        }
    } finally {
        await store.close();
        fs.rmSync(dataDir, { force: true, recursive: true });
    }
});
