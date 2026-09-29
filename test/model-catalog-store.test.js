const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ModelCatalogStore, capabilityFor } = require("../src/utils/ModelCatalogStore");

function makeStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-models-"));
    const logger = { error() {}, info() {}, warn() {} };
    const config = {
        gemini38FlashThinkingLevel: "HIGH",
        modelList: [
            { displayName: "Gemini 3.8 Flash", inputTokenLimit: 1048576, name: "models/gemini-3.8-flash" },
            { displayName: "Gemini 2.5 Flash", name: "models/gemini-2.5-flash" },
        ],
    };
    const store = new ModelCatalogStore(config, logger, directory);
    return { config, directory, logger, store };
}

function nativeRow(id, defaultCode, supportedCodes, details = {}) {
    const row = Array(72).fill(null);
    row[0] = `models/${id}`;
    row[3] = details.displayName || id;
    row[4] = details.description || null;
    row[5] = details.inputTokenLimit || null;
    row[6] = details.outputTokenLimit || null;
    row[71] = supportedCodes ? [null, null, null, 0, null, defaultCode, supportedCodes] : null;
    return row;
}

test("model catalog migrates existing exposure and thinking, then hot policies control both model IDs and aliases", async () => {
    const { directory, logger, config, store } = makeStore();
    let restarted;
    try {
        store.setNativeCatalogFetcher(async () => [[[nativeRow("gemini-3.8-flash", 2, [1, 2, 3])]]]);
        await store.syncCatalog();
        assert.equal(store.getPublicModels().length, 2);
        assert.deepEqual(store.getEffectiveThinkingPolicy("gemini-3.8-flash"), {
            capability: { kind: "level", levels: ["LOW", "MEDIUM", "HIGH"] },
            level: "HIGH",
            mode: "force",
        });
        await store.updatePolicy("gemini-3.8-flash", { alias: "flash-fast" });
        assert.equal(store.getPublicModels().length, 3);
        assert.equal(store.resolveRequestModel("models/flash-fast(low)")?.upstreamModel, "models/gemini-3.8-flash");
        assert.equal(
            store.resolveRequestModel("flash-fast-low-search")?.upstreamRequestModel,
            "models/gemini-3.8-flash-low-search"
        );
        await store.updatePolicy("gemini-3.8-flash", { enabled: false });
        assert.equal(store.resolveRequestModel("gemini-3.8-flash"), null);
        assert.equal(store.resolveRequestModel("flash-fast"), null);
        assert.equal(store.getPublicModels().length, 1);
        await assert.rejects(store.updatePolicy("gemini-2.5-flash", { alias: "gemini-3.8-flash" }), /conflicts/);
        await assert.rejects(
            store.updatePolicy("gemini-2.5-flash", { thinkingPolicy: { level: "HIGH", mode: "force" } }),
            /does not support/
        );
        await store.updatePolicy("gemini-3.8-flash", {
            enabled: true,
            thinkingPolicy: { level: null, mode: "respect_client" },
        });
        assert.equal(store.getEffectiveThinkingPolicy("flash-fast").mode, "respect_client");
        assert.equal(store.getEffectiveThinkingPolicy("gemini-2.5-flash").mode, "respect_client");
        await store.updatePolicy("gemini-3.8-flash", { thinkingPolicy: { level: "MEDIUM", mode: "force" } });
        assert.equal(store.getEffectiveThinkingPolicy("flash-fast").level, "MEDIUM");
        await assert.rejects(
            store.updatePolicy("gemini-3.8-flash", { thinkingPolicy: { mode: "inherit" } }),
            /respect_client or force/
        );

        store.close();
        restarted = new ModelCatalogStore(config, logger, directory);
        assert.equal(restarted.resolveRequestModel("flash-fast")?.id, "gemini-3.8-flash");
        assert.equal(restarted.getEffectiveThinkingPolicy("flash-fast").level, "MEDIUM");
        assert.equal(fs.readFileSync(restarted.filePath, "utf8").includes("gemini-3.8-flash"), true);
    } finally {
        restarted?.close();
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("legacy global policy is materialized per model and removed from the persisted catalog", async () => {
    const { directory, logger, config, store } = makeStore();
    let restarted;
    try {
        await store.addModel({ id: "gemini-3.6-flash" });
        await store.addModel({ id: "gemini-3.1-pro-preview" });
        await store.updatePolicy("gemini-3.6-flash", { enabled: true });
        await store.updatePolicy("gemini-3.1-pro-preview", { enabled: true });
        const legacy = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        legacy.globalThinkingPolicy = { level: "MEDIUM", mode: "force" };
        legacy.models.find(model => model.id === "gemini-2.5-flash").thinkingPolicy = {
            level: null,
            mode: "inherit",
        };
        legacy.models.find(model => model.id === "gemini-3.6-flash").thinkingPolicy = {
            level: null,
            mode: "inherit",
        };
        legacy.models.find(model => model.id === "gemini-3.1-pro-preview").thinkingPolicy = {
            level: null,
            mode: "respect_client",
        };
        store.close();
        fs.writeFileSync(store.filePath, JSON.stringify(legacy));
        restarted = new ModelCatalogStore(config, logger, directory);
        assert.equal(restarted.getEffectiveThinkingPolicy("gemini-3.8-flash").level, "HIGH");
        assert.equal(restarted.getEffectiveThinkingPolicy("gemini-3.6-flash").level, "MEDIUM");
        const saved = JSON.parse(fs.readFileSync(restarted.filePath, "utf8"));
        assert.equal(Object.hasOwn(saved, "globalThinkingPolicy"), false);
        assert.equal(Object.hasOwn(restarted.getAdminState(), "globalThinkingPolicy"), false);
        assert.deepEqual(saved.models.find(model => model.id === "gemini-3.6-flash").thinkingPolicy, {
            level: "MEDIUM",
            mode: "force",
        });
        assert.deepEqual(saved.models.find(model => model.id === "gemini-2.5-flash").thinkingPolicy, {
            level: null,
            mode: "respect_client",
        });
        assert.equal(
            saved.models.find(model => model.id === "gemini-3.1-pro-preview").thinkingPolicy.mode,
            "respect_client"
        );
        assert.equal(saved.models.find(model => model.id === "gemini-3.8-flash").thinkingPolicy.level, "HIGH");
    } finally {
        restarted?.close();
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("manual model can be enabled with declared levels, then an external catalog edit hot loads", async () => {
    const { directory, store } = makeStore();
    try {
        const added = await store.addModel({ id: "models/gemini-future" });
        assert.equal(added.models.find(model => model.id === "gemini-future").enabled, false);
        assert.deepEqual(added.models.find(model => model.id === "gemini-future").thinkingPolicy, {
            level: null,
            mode: "respect_client",
        });
        await store.updatePolicy("gemini-future", {
            capabilityOverride: { kind: "level", levels: ["LOW", "HIGH"] },
            enabled: true,
            thinkingPolicy: { level: "HIGH", mode: "force" },
        });
        assert.equal(store.getEffectiveThinkingPolicy("gemini-future").level, "HIGH");
        assert.deepEqual(store.getAdminState().models.find(model => model.id === "gemini-future").builtinCapability, {
            kind: "unknown",
            levels: [],
        });
        const edited = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        edited.revision++;
        edited.models.find(model => model.id === "gemini-future").enabled = false;
        const temporaryPath = `${store.filePath}.external.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(edited));
        fs.renameSync(temporaryPath, store.filePath);
        const deadline = Date.now() + 4000;
        while (store.resolveRequestModel("gemini-future") && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(store.resolveRequestModel("gemini-future"), null);
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("public sync adds disabled candidates and preserves chosen model policy without storing a key", async () => {
    const { directory, store } = makeStore();
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        text: async () =>
            JSON.stringify({
                aistudio: [
                    { displayName: "Updated Flash", name: "models/gemini-3.8-flash" },
                    { displayName: "Future Gemini", name: "models/gemini-future" },
                ],
            }),
    });
    try {
        await store.updatePolicy("gemini-3.8-flash", { alias: "my-flash" });
        const synced = await store.syncCatalog({ source: "public" });
        assert.equal(synced.lastSync.added, 1);
        assert.equal(synced.models.find(model => model.id === "gemini-future").enabled, false);
        assert.equal(synced.models.find(model => model.id === "gemini-future").thinkingPolicy.mode, "respect_client");
        assert.equal(synced.models.find(model => model.id === "gemini-3.8-flash").alias, "my-flash");
        assert.equal(synced.models.find(model => model.id === "gemini-3.8-flash").thinkingPolicy.level, "HIGH");
        assert.equal(store.resolveRequestModel("gemini-future"), null);
        assert.equal(synced.models.find(model => model.id === "gemini-future").capability.kind, "unknown");
        assert.equal(fs.readFileSync(store.filePath, "utf8").includes("apiKey"), false);
    } finally {
        global.fetch = originalFetch;
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("new image models have unknown thinking support until native metadata arrives", () => {
    assert.deepEqual(capabilityFor({ id: "gemini-3.1-flash-image" }), { kind: "unknown", levels: [] });
    assert.deepEqual(capabilityFor({ id: "gemini-3.1-flash-lite-image" }), { kind: "unknown", levels: [] });
});

test("native AI Studio sync persists actual levels and defaults without guessing missing descriptors", async () => {
    const { directory, store } = makeStore();
    try {
        await store.updatePolicy("gemini-3.8-flash", {
            capabilityOverride: { kind: "level", levels: ["LOW", "HIGH"] },
        });
        store.setNativeCatalogFetcher(async () => [
            [
                ["models/gemini-3.8-flash"],
                nativeRow("gemini-3.8-flash", 2, [1, 2, 3], { displayName: "Gemini 3.8 Flash" }),
                nativeRow("gemini-3.1-flash-image", 4, [4, 3], { inputTokenLimit: 1048576 }),
                nativeRow("gemini-future", null, null),
            ],
        ]);
        const synced = await store.syncCatalog();
        assert.equal(synced.source, "native");
        assert.equal(synced.lastSync.added, 2);
        const flash = synced.models.find(model => model.id === "gemini-3.8-flash");
        assert.deepEqual(flash.nativeThinking, { defaultLevel: "MEDIUM", levels: ["LOW", "MEDIUM", "HIGH"] });
        assert.equal(flash.defaultThinkingLevel, "MEDIUM");
        assert.deepEqual(flash.capability, { kind: "level", levels: ["LOW", "MEDIUM", "HIGH"] });
        assert.equal(flash.capabilityOverride, null);
        assert.equal(flash.thinkingPolicy.level, "HIGH");
        await assert.rejects(
            store.updatePolicy("gemini-3.8-flash", {
                capabilityOverride: { kind: "level", levels: ["HIGH"] },
            }),
            /AI Studio provides/
        );
        const image = synced.models.find(model => model.id === "gemini-3.1-flash-image");
        assert.deepEqual(image.capability, { kind: "level", levels: ["MINIMAL", "HIGH"] });
        assert.equal(image.defaultThinkingLevel, "MINIMAL");
        assert.equal(image.inputTokenLimit, 1048576);
        assert.equal(image.enabled, false);
        const future = synced.models.find(model => model.id === "gemini-future");
        assert.deepEqual(future.capability, { kind: "unknown", levels: [] });
        assert.equal(future.defaultThinkingLevel, null);
        const saved = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        assert.deepEqual(saved.models.find(model => model.id === "gemini-3.1-flash-image").nativeThinking, {
            defaultLevel: "MINIMAL",
            levels: ["MINIMAL", "HIGH"],
        });
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("native AI Studio sync resets an old forced level that is no longer supported", async () => {
    const { directory, store } = makeStore();
    try {
        store.setNativeCatalogFetcher(async () => [[[nativeRow("gemini-3.8-flash", 2, [1, 2])]]]);
        const synced = await store.syncCatalog();
        assert.deepEqual(synced.lastSync.policiesReset, ["gemini-3.8-flash"]);
        assert.deepEqual(synced.models.find(model => model.id === "gemini-3.8-flash").thinkingPolicy, {
            level: null,
            mode: "respect_client",
        });
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("sync keeps a newly discovered model disabled when its ID is an existing alias", async () => {
    const { directory, store } = makeStore();
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        text: async () => JSON.stringify({ aistudio: [{ name: "models/gemini-future" }] }),
    });
    try {
        await store.updatePolicy("gemini-3.8-flash", { alias: "gemini-future" });
        const synced = await store.syncCatalog({ source: "public" });
        assert.equal(synced.lastSync.added, 1);
        assert.deepEqual(synced.lastSync.conflicts, [
            { aliasOwnerEnabled: true, aliasOwnerId: "gemini-3.8-flash", modelId: "gemini-future" },
        ]);
        assert.equal(synced.models.find(model => model.id === "gemini-future").enabled, false);
        assert.equal(store.resolveRequestModel("gemini-future")?.id, "gemini-3.8-flash");
        await assert.rejects(store.updatePolicy("gemini-future", { enabled: true }), /conflicts/);
        await store.updatePolicy("gemini-3.8-flash", { enabled: false });
        await store.updatePolicy("gemini-future", { enabled: true });
        assert.equal(store.resolveRequestModel("gemini-future")?.id, "gemini-future");
        await assert.rejects(store.updatePolicy("gemini-3.8-flash", { enabled: true }), /conflicts/);
        await store.updatePolicy("gemini-3.8-flash", { alias: null });
        await store.updatePolicy("gemini-3.8-flash", { enabled: true });
        assert.equal(store.resolveRequestModel("gemini-future")?.id, "gemini-future");
        assert.equal(store.getAdminState().nameConflicts.length, 0);
    } finally {
        global.fetch = originalFetch;
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("account probes persist only status metadata and become stale after a day", async () => {
    const { directory, store } = makeStore();
    try {
        const state = await store.recordProbe("gemini-3.8-flash", "1", {
            httpStatus: 200,
            status: "available",
        });
        const model = state.models.find(item => item.id === "gemini-3.8-flash");
        assert.equal(model.probeSupported, true);
        assert.deepEqual(
            model.probes.map(probe => [probe.accountKey, probe.status, probe.httpStatus, probe.stale]),
            [["1", "available", 200, false]]
        );
        assert.throws(
            () => store.recordProbe("gemini-3.8-flash", "user@example.com", { status: "available" }),
            /numeric account index/
        );
        assert.throws(
            () => store.recordProbe("gemini-3.8-flash", "1", { responseBody: "secret", status: "available" }),
            /only status/
        );
        const saved = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        const probe = saved.models.find(item => item.id === "gemini-3.8-flash").probes[0];
        probe.checkedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        fs.writeFileSync(store.filePath, JSON.stringify(saved));
        store._reloadFromDisk();
        assert.equal(store.getAdminState().models.find(item => item.id === "gemini-3.8-flash").probes[0].stale, true);
        assert.equal(fs.readFileSync(store.filePath, "utf8").includes("secret"), false);
    } finally {
        store.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});
