const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const PUBLIC_CATALOG_URLS = Object.freeze([
    "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json",
    "https://models.router-for.me/models.json",
]);
const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const NATIVE_MODELS_URL =
    "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListModels";
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LEVELS = Object.freeze(["MINIMAL", "LOW", "MEDIUM", "HIGH"]);
const NATIVE_LEVEL_CODES = Object.freeze({ 1: "LOW", 2: "MEDIUM", 3: "HIGH", 4: "MINIMAL" });
const MAX_MODELS = 2000;
const MAX_PROBES_PER_MODEL = 256;
const PROBE_STALE_MS = 24 * 60 * 60 * 1000;

// These IDs are retained only to migrate catalogs written before AI Studio's
// ListModels metadata was available. They are never used for new sync results.
const LEGACY_LEVELS = Object.freeze({
    "gemini-3.1-flash-lite-image": ["MINIMAL", "HIGH"],
    "gemini-3.1-pro-preview": ["LOW", "MEDIUM", "HIGH"],
    "gemini-3.5-flash-lite": ["MINIMAL", "LOW", "MEDIUM", "HIGH"],
    "gemini-3.6-flash": ["MINIMAL", "LOW", "MEDIUM", "HIGH"],
    "gemini-3.7-flash": ["LOW", "MEDIUM", "HIGH"],
    "gemini-3.8-flash": ["LOW", "MEDIUM", "HIGH"],
    "gemini-3-flash-preview": ["MINIMAL", "LOW", "MEDIUM", "HIGH"],
});
const KNOWN_BUDGET_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"]);
const KNOWN_NO_THINKING_MODELS = new Set(["gemini-2.5-flash-image"]);
const METADATA_FIELDS = Object.freeze([
    "version",
    "displayName",
    "description",
    "inputTokenLimit",
    "outputTokenLimit",
    "supportedGenerationMethods",
    "temperature",
    "topP",
    "topK",
    "maxTemperature",
]);

class ModelCatalogError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = "ModelCatalogError";
        this.status = status;
    }
}

function normalizeModelId(value) {
    if (typeof value !== "string") return null;
    const id = value.trim().replace(/^models\//i, "");
    return MODEL_ID_PATTERN.test(id) ? id : null;
}

function modelNameCandidates(value) {
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    const prefix = /^models\//i.test(trimmed) ? trimmed.slice(0, 7) : "";
    const originalId = trimmed.slice(prefix.length);
    if (!originalId) return [];
    const candidates = [{ id: originalId, suffix: "" }];
    let remaining = originalId;
    let match = remaining.match(/^(.+)-(search|code)$/i);
    while (match) {
        remaining = match[1];
        candidates.push({ id: remaining, suffix: originalId.slice(remaining.length) });
        match = remaining.match(/^(.+)-(search|code)$/i);
    }
    match = remaining.match(/^(.+)-(real|fake)$/i);
    if (match) {
        remaining = match[1];
        candidates.push({ id: remaining, suffix: originalId.slice(remaining.length) });
    }
    match = remaining.match(/^(.+)(\((?:minimal|low|medium|high)\)|-(?:minimal|low|medium|high))$/i);
    if (match) {
        remaining = match[1];
        candidates.push({ id: remaining, suffix: originalId.slice(remaining.length) });
    }
    return candidates.filter(candidate => MODEL_ID_PATTERN.test(candidate.id));
}

function safeMetadata(raw) {
    const metadata = {};
    for (const key of METADATA_FIELDS) {
        const value = raw[key];
        if (typeof value === "string" && value.length <= 2000) metadata[key] = value;
        else if (typeof value === "number" && Number.isFinite(value) && value >= 0) metadata[key] = value;
        else if (key === "supportedGenerationMethods" && Array.isArray(value)) {
            metadata[key] = value.filter(item => typeof item === "string" && item.length <= 80).slice(0, 30);
        }
    }
    return metadata;
}

function validateNativeThinking(value) {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ModelCatalogError("Invalid native thinking metadata.");
    }
    const levels = value.levels;
    if (
        !Array.isArray(levels) ||
        levels.length < 1 ||
        levels.length > LEVELS.length ||
        levels.some(level => !LEVELS.includes(level)) ||
        new Set(levels).size !== levels.length
    ) {
        throw new ModelCatalogError("Invalid native thinking levels.");
    }
    const defaultLevel = value.defaultLevel ?? null;
    if (defaultLevel !== null && !levels.includes(defaultLevel)) {
        throw new ModelCatalogError("Invalid native default thinking level.");
    }
    return { defaultLevel, levels: [...levels] };
}

function parseNativeThinking(descriptor) {
    if (!Array.isArray(descriptor) || !Array.isArray(descriptor[6])) return null;
    const levels = descriptor[6].map(code => NATIVE_LEVEL_CODES[code]);
    if (levels.length < 1 || levels.some(level => !level) || new Set(levels).size !== levels.length) {
        return null;
    }
    const defaultLevel = NATIVE_LEVEL_CODES[descriptor[5]] || null;
    return validateNativeThinking({ defaultLevel, levels });
}

function parseNativeCatalog(response) {
    const models = new Map();
    function walk(value, depth = 0) {
        if (!Array.isArray(value) || depth > 5) return;
        const id = typeof value[0] === "string" && /^models\//i.test(value[0]) ? normalizeModelId(value[0]) : null;
        if (id && value.length >= 72) {
            if (!models.has(id)) {
                models.set(id, {
                    description: value[4],
                    displayName: value[3],
                    inputTokenLimit: value[5],
                    name: `models/${id}`,
                    nativeThinking: parseNativeThinking(value[71]),
                    outputTokenLimit: value[6],
                    supportedGenerationMethods: value[7],
                    temperature: value[8],
                    topK: value[10],
                    topP: value[9],
                });
            }
            return;
        }
        for (const child of value) walk(child, depth + 1);
    }
    walk(response);
    if (models.size === 0 || models.size > MAX_MODELS) {
        throw new ModelCatalogError("AI Studio ListModels returned no valid model rows.", 502);
    }
    return [...models.values()];
}

function capabilityFor(record) {
    if (record.nativeThinking) {
        return { kind: "level", levels: [...record.nativeThinking.levels] };
    }
    if (record.capabilityOverride) return { ...record.capabilityOverride };
    if (record.thinkingPolicy?.mode === "force" && LEVELS.includes(record.thinkingPolicy.level)) {
        return { kind: "level", levels: [record.thinkingPolicy.level] };
    }
    if (KNOWN_BUDGET_MODELS.has(record.id)) return { kind: "budget", levels: [] };
    if (KNOWN_NO_THINKING_MODELS.has(record.id) || /embedding|\btts\b/i.test(record.id)) {
        return { kind: "none", levels: [] };
    }
    return { kind: "unknown", levels: [] };
}

function supportsTextProbe(record) {
    if (/embedding|\btts\b|image|computer-use|robotics/i.test(record.id)) return false;
    const methods = record.metadata?.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes("generateContent")) return false;
    return /^(gemini|gemma)-/i.test(record.id);
}

function validateProbes(probes) {
    if (!Array.isArray(probes) || probes.length > MAX_PROBES_PER_MODEL) {
        throw new ModelCatalogError("Invalid model probe records.");
    }
    const accounts = new Set();
    return probes.map(probe => {
        if (
            !probe ||
            !/^[0-9]{1,6}$/.test(probe.accountKey) ||
            accounts.has(probe.accountKey) ||
            !["available", "unavailable", "unknown"].includes(probe.status) ||
            (probe.httpStatus !== null &&
                (!Number.isInteger(probe.httpStatus) || probe.httpStatus < 100 || probe.httpStatus > 599)) ||
            typeof probe.checkedAt !== "string" ||
            !Number.isFinite(Date.parse(probe.checkedAt))
        ) {
            throw new ModelCatalogError("Invalid model probe record.");
        }
        accounts.add(probe.accountKey);
        return {
            accountKey: probe.accountKey,
            checkedAt: probe.checkedAt,
            httpStatus: probe.httpStatus,
            status: probe.status,
        };
    });
}

function validateCapabilityOverride(value) {
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ModelCatalogError("Capability override must be an object or null.");
    }
    if (!["level", "budget", "none", "unknown"].includes(value.kind)) {
        throw new ModelCatalogError("Invalid thinking capability kind.");
    }
    const levels = value.kind === "level" ? value.levels : [];
    if (
        value.kind === "level" &&
        (!Array.isArray(levels) ||
            levels.length < 1 ||
            levels.length > LEVELS.length ||
            levels.some(level => !LEVELS.includes(level)) ||
            new Set(levels).size !== levels.length)
    ) {
        throw new ModelCatalogError("Thinking levels must be unique MINIMAL, LOW, MEDIUM or HIGH values.");
    }
    return { kind: value.kind, levels: value.kind === "level" ? [...levels] : [] };
}

function validateThinkingPolicy(value, capability, allowLegacyInherit = false) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ModelCatalogError("Thinking policy must be an object.");
    }
    if (!["respect_client", "force", ...(allowLegacyInherit ? ["inherit"] : [])].includes(value.mode)) {
        throw new ModelCatalogError("Thinking policy mode must be respect_client or force.");
    }
    const level = value.level ?? null;
    if (level !== null && !LEVELS.includes(level)) {
        throw new ModelCatalogError("Invalid thinking level.");
    }
    if (value.mode === "force" && (capability.kind !== "level" || !capability.levels.includes(level))) {
        throw new ModelCatalogError("This model does not support the selected thinking level.");
    }
    return { level: value.mode === "force" ? level : null, mode: value.mode };
}

function validateLegacyGlobalPolicy(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ModelCatalogError("Global thinking policy must be an object.");
    }
    if (!["respect_client", "force"].includes(value.mode) || !["LOW", "MEDIUM", "HIGH"].includes(value.level)) {
        throw new ModelCatalogError("Global thinking policy needs respect_client or force and LOW, MEDIUM or HIGH.");
    }
    return { level: value.level, mode: value.mode };
}

function publicModel(record, publicId) {
    return { name: `models/${publicId}`, ...record.metadata };
}

class ModelCatalogStore {
    constructor(config, logger, dataDir = path.join(process.cwd(), "data")) {
        this.config = config;
        this.logger = logger;
        this.filePath = path.join(dataDir, "model-catalog.json");
        this.pending = Promise.resolve();
        this.lastAppliedContent = null;
        this.nativeCatalogFetcher = null;
        this.state = null;

        try {
            this._reloadFromDisk();
        } catch (error) {
            if (error.code !== "ENOENT") throw new Error(`[Models] Invalid model catalog: ${error.message}`);
            this.state = this._initialState(config.modelList);
            this._saveSync(this.state);
            this.logger.info(`[Models] Migrated ${this.state.models.length} models to data/model-catalog.json.`);
        }

        this._watchListener = (current, previous) => {
            if (
                current.mtimeMs === previous.mtimeMs &&
                current.ctimeMs === previous.ctimeMs &&
                current.size === previous.size
            ) {
                return;
            }
            try {
                this._reloadFromDisk();
                this.logger.info("[Models] Hot-loaded data/model-catalog.json.");
            } catch (error) {
                this.logger.warn(`[Models] Model catalog change ignored: ${error.message}`);
            }
        };
        fs.watchFile(this.filePath, { interval: 1000, persistent: false }, this._watchListener);
    }

    _initialState(models) {
        const seen = new Set();
        const records = [];
        for (const raw of Array.isArray(models) ? models : []) {
            const id = normalizeModelId(raw?.name);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const record = {
                alias: null,
                capabilityOverride: null,
                enabled: true,
                id,
                lastSeenAt: null,
                metadata: safeMetadata(raw),
                nativeThinking: null,
                probes: [],
                source: "local",
                thinkingPolicy: { level: null, mode: "respect_client" },
            };
            if (
                id === "gemini-3.8-flash" &&
                ["LOW", "MEDIUM", "HIGH"].includes(this.config.gemini38FlashThinkingLevel)
            ) {
                record.thinkingPolicy = { level: this.config.gemini38FlashThinkingLevel, mode: "force" };
            }
            records.push(record);
        }
        if (records.length === 0) {
            records.push({
                alias: null,
                capabilityOverride: null,
                enabled: true,
                id: "gemini-2.5-flash-lite",
                lastSeenAt: null,
                metadata: {},
                nativeThinking: null,
                probes: [],
                source: "local",
                thinkingPolicy: { level: null, mode: "respect_client" },
            });
        }
        return {
            lastSyncedAt: null,
            models: records,
            revision: 0,
            source: "local",
            sourceUrl: null,
            version: 1,
        };
    }

    _validateState(saved) {
        if (
            !saved ||
            saved.version !== 1 ||
            !Number.isSafeInteger(saved.revision) ||
            saved.revision < 0 ||
            !Array.isArray(saved.models) ||
            saved.models.length > MAX_MODELS
        ) {
            throw new ModelCatalogError("Unsupported model catalog format.");
        }
        if (saved.lastSyncedAt !== null && !Number.isFinite(Date.parse(saved.lastSyncedAt))) {
            throw new ModelCatalogError("Invalid last sync time.");
        }
        if (!["local", "public", "google", "native"].includes(saved.source)) {
            throw new ModelCatalogError("Invalid catalog source.");
        }
        const legacyGlobalPolicy = Object.hasOwn(saved, "globalThinkingPolicy")
            ? validateLegacyGlobalPolicy(saved.globalThinkingPolicy)
            : null;
        const seen = new Set();
        const aliases = new Set();
        const models = saved.models.map(raw => {
            const id = normalizeModelId(raw?.id);
            if (!id || id !== raw.id || seen.has(id)) throw new ModelCatalogError("Invalid or duplicate model ID.");
            seen.add(id);
            if (
                typeof raw.enabled !== "boolean" ||
                !["local", "public", "google", "native", "manual"].includes(raw.source)
            ) {
                throw new ModelCatalogError(`Invalid model entry: ${id}.`);
            }
            const alias = raw.alias ?? null;
            if (alias !== null && (!ALIAS_PATTERN.test(alias) || aliases.has(alias) || alias === id)) {
                throw new ModelCatalogError(`Invalid or duplicate model alias: ${id}.`);
            }
            if (alias !== null) aliases.add(alias);
            const capabilityOverride = validateCapabilityOverride(raw.capabilityOverride ?? null);
            const record = {
                alias,
                capabilityOverride,
                enabled: raw.enabled,
                id,
                lastSeenAt: raw.lastSeenAt ?? null,
                metadata: safeMetadata(raw.metadata || {}),
                nativeThinking: validateNativeThinking(raw.nativeThinking),
                probes: validateProbes(raw.probes ?? []),
                source: raw.source,
                thinkingPolicy: raw.thinkingPolicy,
            };
            const capability = capabilityFor(record);
            const policy = validateThinkingPolicy(raw.thinkingPolicy, capability, true);
            const legacyLevels = LEGACY_LEVELS[id];
            record.thinkingPolicy =
                policy.mode === "inherit"
                    ? legacyGlobalPolicy?.mode === "force" &&
                      ((capability.kind === "level" && capability.levels.includes(legacyGlobalPolicy.level)) ||
                          (legacyLevels && legacyLevels.includes(legacyGlobalPolicy.level)))
                        ? { level: legacyGlobalPolicy.level, mode: "force" }
                        : { level: null, mode: "respect_client" }
                    : policy;
            return record;
        });
        const byId = new Map(models.map(model => [model.id, model]));
        for (const model of models) {
            const target = model.alias ? byId.get(model.alias) : null;
            if (target?.enabled && model.enabled) {
                throw new ModelCatalogError(
                    `Model ${target.id} conflicts with the enabled alias of ${model.id}. Remove that alias or disable one model.`
                );
            }
        }
        return {
            lastSyncedAt: saved.lastSyncedAt,
            models,
            revision: saved.revision,
            source: saved.source,
            sourceUrl: typeof saved.sourceUrl === "string" ? saved.sourceUrl : null,
            version: 1,
        };
    }

    _reloadFromDisk() {
        const content = fs.readFileSync(this.filePath, "utf8");
        if (content === this.lastAppliedContent) return;
        const saved = JSON.parse(content);
        const state = this._validateState(saved);
        if (
            Object.hasOwn(saved, "globalThinkingPolicy") ||
            saved.models.some(model => model?.thinkingPolicy?.mode === "inherit")
        ) {
            this._writeSync(state);
            return;
        }
        this.state = state;
        this.lastAppliedContent = content;
    }

    _writeSync(state) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const content = `${JSON.stringify(state, null, 2)}\n`;
        const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporaryPath, content, { mode: 0o600 });
            fs.renameSync(temporaryPath, this.filePath);
        } finally {
            fs.rmSync(temporaryPath, { force: true });
        }
        this.state = state;
        this.lastAppliedContent = content;
    }

    _saveSync(state) {
        const validated = this._validateState(state);
        this._writeSync(validated);
    }

    async _save(state) {
        const validated = this._validateState({ ...state, revision: this.state.revision + 1 });
        const content = `${JSON.stringify(validated, null, 2)}\n`;
        const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await fs.promises.writeFile(temporaryPath, content, { mode: 0o600 });
            await fs.promises.rename(temporaryPath, this.filePath);
        } finally {
            await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        }
        this.state = validated;
        this.lastAppliedContent = content;
        return this.getAdminState();
    }

    _queue(operation) {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => {});
        return result;
    }

    setNativeCatalogFetcher(fetcher) {
        if (typeof fetcher !== "function") throw new TypeError("Native model fetcher must be a function.");
        this.nativeCatalogFetcher = fetcher;
    }

    getPublicModels() {
        return this.state.models.flatMap(record => {
            if (!record.enabled) return [];
            const result = [publicModel(record, record.id)];
            if (record.alias) result.push(publicModel(record, record.alias));
            return result;
        });
    }

    resolveRequestModel(rawModel) {
        for (const candidate of modelNameCandidates(rawModel)) {
            const record =
                this.state.models.find(model => model.enabled && model.id === candidate.id) ||
                this.state.models.find(model => model.enabled && model.alias === candidate.id);
            if (!record) {
                if (this.state.models.some(model => model.id === candidate.id || model.alias === candidate.id)) {
                    return null;
                }
                continue;
            }
            return {
                capability: capabilityFor(record),
                id: record.id,
                model: publicModel(record, record.id),
                publicId: candidate.id,
                suffix: candidate.suffix,
                thinkingPolicy: { ...record.thinkingPolicy },
                upstreamId: record.id,
                upstreamModel: `models/${record.id}`,
                upstreamRequestModel: `models/${record.id}${candidate.suffix}`,
            };
        }
        return null;
    }

    getEffectiveThinkingPolicy(rawModel) {
        const resolved = this.resolveRequestModel(rawModel);
        if (!resolved) return null;
        const { thinkingPolicy, capability } = resolved;
        if (thinkingPolicy.mode === "force") {
            return { capability, level: thinkingPolicy.level, mode: "force" };
        }
        return { capability, level: null, mode: "respect_client" };
    }

    getAdminState() {
        const state = this.state;
        const aliasOwners = new Map(state.models.filter(model => model.alias).map(model => [model.alias, model]));
        const nameConflicts = state.models
            .filter(model => aliasOwners.has(model.id))
            .map(model => ({
                aliasOwnerEnabled: aliasOwners.get(model.id).enabled,
                aliasOwnerId: aliasOwners.get(model.id).id,
                modelId: model.id,
            }));
        const conflictsById = new Map(nameConflicts.map(conflict => [conflict.modelId, conflict]));
        return {
            lastSyncedAt: state.lastSyncedAt,
            models: state.models.map(record => {
                const conflict = conflictsById.get(record.id);
                return {
                    alias: record.alias,
                    defaultThinkingLevel: record.nativeThinking?.defaultLevel ?? null,
                    enabled: record.enabled,
                    id: record.id,
                    lastSeenAt: record.lastSeenAt,
                    nameConflict: conflict || null,
                    nativeThinking: record.nativeThinking
                        ? { ...record.nativeThinking, levels: [...record.nativeThinking.levels] }
                        : null,
                    probes: record.probes.map(probe => ({
                        ...probe,
                        stale: Date.now() - Date.parse(probe.checkedAt) > PROBE_STALE_MS,
                    })),
                    probeSupported: supportsTextProbe(record),
                    source: record.source,
                    ...record.metadata,
                    builtinCapability: capabilityFor({
                        ...record,
                        capabilityOverride: null,
                        thinkingPolicy: { level: null, mode: "respect_client" },
                    }),
                    capability: capabilityFor(record),
                    capabilityOverride: record.capabilityOverride,
                    thinkingPolicy: { ...record.thinkingPolicy },
                };
            }),
            nameConflicts,
            revision: state.revision,
            source: state.source,
            sourceUrl: state.sourceUrl,
        };
    }

    updatePolicy(id, patch) {
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
            throw new ModelCatalogError("Model update must be a JSON object.");
        }
        const fields = Object.keys(patch);
        if (fields.some(field => !["enabled", "alias", "thinkingPolicy", "capabilityOverride"].includes(field))) {
            throw new ModelCatalogError("Unknown model setting.");
        }
        const normalizedId = normalizeModelId(id);
        if (!normalizedId) throw new ModelCatalogError("Invalid model ID.");
        return this._queue(async () => {
            this._reloadFromDisk();
            const index = this.state.models.findIndex(model => model.id === normalizedId);
            if (index < 0) throw new ModelCatalogError("Model not found.", 404);
            const record = { ...this.state.models[index] };
            if (Object.hasOwn(patch, "enabled")) {
                if (typeof patch.enabled !== "boolean") throw new ModelCatalogError("enabled must be a boolean.");
                record.enabled = patch.enabled;
            }
            if (Object.hasOwn(patch, "alias")) {
                if (patch.alias !== null && (typeof patch.alias !== "string" || !ALIAS_PATTERN.test(patch.alias))) {
                    throw new ModelCatalogError(
                        "Alias must be 1–100 ASCII letters, digits, dots, hyphens or underscores."
                    );
                }
                if (patch.alias && this.state.models.some(model => model.id === patch.alias)) {
                    throw new ModelCatalogError(`Alias conflicts with a model ID: ${patch.alias}.`);
                }
                record.alias = patch.alias;
            }
            if (Object.hasOwn(patch, "capabilityOverride")) {
                if (record.nativeThinking && patch.capabilityOverride !== null) {
                    throw new ModelCatalogError("AI Studio provides the supported thinking levels for this model.");
                }
                record.capabilityOverride = validateCapabilityOverride(patch.capabilityOverride);
            }
            if (Object.hasOwn(patch, "thinkingPolicy")) {
                record.thinkingPolicy = validateThinkingPolicy(
                    { ...record.thinkingPolicy, ...patch.thinkingPolicy },
                    capabilityFor(record)
                );
            } else {
                record.thinkingPolicy = validateThinkingPolicy(record.thinkingPolicy, capabilityFor(record));
            }
            const models = [...this.state.models];
            models[index] = record;
            return this._save({ ...this.state, models });
        });
    }

    addModel(input) {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new ModelCatalogError("New model must be a JSON object.");
        }
        if (Object.keys(input).some(key => !["id", "displayName", "description"].includes(key))) {
            throw new ModelCatalogError("Unknown model field.");
        }
        const id = normalizeModelId(input.id);
        if (!id) throw new ModelCatalogError("Invalid model ID.");
        for (const key of ["displayName", "description"]) {
            if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length > 2000)) {
                throw new ModelCatalogError(`${key} must be text with at most 2000 characters.`);
            }
        }
        return this._queue(async () => {
            this._reloadFromDisk();
            if (this.state.models.some(model => model.id === id || model.alias === id)) {
                throw new ModelCatalogError("Model ID already exists.", 409);
            }
            if (this.state.models.length >= MAX_MODELS) throw new ModelCatalogError("Model catalog is full.", 400);
            const models = [
                ...this.state.models,
                {
                    alias: null,
                    capabilityOverride: null,
                    enabled: false,
                    id,
                    lastSeenAt: null,
                    metadata: {
                        displayName: input.displayName?.trim() || id,
                        ...(input.description ? { description: input.description.trim() } : {}),
                    },
                    nativeThinking: null,
                    probes: [],
                    source: "manual",
                    thinkingPolicy: { level: null, mode: "respect_client" },
                },
            ];
            return this._save({ ...this.state, models });
        });
    }

    recordProbe(id, accountKey, result) {
        const normalizedId = normalizeModelId(id);
        if (!normalizedId) throw new ModelCatalogError("Invalid model ID.");
        const key = String(accountKey);
        if (!/^[0-9]{1,6}$/.test(key)) {
            throw new ModelCatalogError("Probe account key must be a numeric account index.");
        }
        if (
            !result ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            Object.keys(result).some(field => !["status", "httpStatus"].includes(field)) ||
            !["available", "unavailable", "unknown"].includes(result.status)
        ) {
            throw new ModelCatalogError("Probe result must contain only status and optional HTTP status.");
        }
        const httpStatus = result.httpStatus ?? null;
        if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
            throw new ModelCatalogError("Probe HTTP status must be 100–599 or null.");
        }
        return this._queue(async () => {
            this._reloadFromDisk();
            const index = this.state.models.findIndex(model => model.id === normalizedId);
            if (index < 0) throw new ModelCatalogError("Model not found.", 404);
            const record = this.state.models[index];
            if (!supportsTextProbe(record)) {
                throw new ModelCatalogError("This model does not support the text availability probe.");
            }
            const probe = {
                accountKey: key,
                checkedAt: new Date().toISOString(),
                httpStatus,
                status: result.status,
            };
            const probes = record.probes.filter(existing => existing.accountKey !== key);
            probes.push(probe);
            const models = [...this.state.models];
            models[index] = { ...record, probes: probes.slice(-MAX_PROBES_PER_MODEL) };
            return this._save({ ...this.state, models });
        });
    }

    async _fetchJson(url, apiKey = null) {
        let response;
        try {
            response = await fetch(url, {
                headers: apiKey ? { "x-goog-api-key": apiKey } : undefined,
                signal: AbortSignal.timeout(15000),
            });
        } catch {
            throw new ModelCatalogError("Could not reach the model catalog source.", 502);
        }
        if (!response.ok) {
            throw new ModelCatalogError(`Model catalog source returned HTTP ${response.status}.`, 502);
        }
        const text = await response.text();
        if (text.length > 10000000) throw new ModelCatalogError("Model catalog response is too large.", 502);
        try {
            return JSON.parse(text);
        } catch {
            throw new ModelCatalogError("Model catalog source returned invalid JSON.", 502);
        }
    }

    async _fetchPublicCatalog() {
        let lastError;
        for (const url of PUBLIC_CATALOG_URLS) {
            try {
                const result = await this._fetchJson(url);
                if (!Array.isArray(result.aistudio) || result.aistudio.length === 0) {
                    throw new ModelCatalogError("Public catalog has no AI Studio models.", 502);
                }
                return { models: result.aistudio, url };
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new ModelCatalogError("Could not fetch the public AI Studio model catalog.", 502);
    }

    async _fetchGoogleCatalog(apiKey) {
        if (typeof apiKey !== "string" || !apiKey.trim()) {
            throw new ModelCatalogError("An official Gemini API key is required for Google models.list.");
        }
        const models = [];
        let pageToken = "";
        for (let page = 0; page < 20; page++) {
            const url = new URL(GOOGLE_MODELS_URL);
            url.searchParams.set("pageSize", "1000");
            if (pageToken) url.searchParams.set("pageToken", pageToken);
            const result = await this._fetchJson(url.toString(), apiKey.trim());
            if (!Array.isArray(result.models)) {
                throw new ModelCatalogError("Google models.list returned no model array.", 502);
            }
            models.push(...result.models);
            if (models.length > MAX_MODELS) throw new ModelCatalogError("Google returned too many models.", 502);
            pageToken = typeof result.nextPageToken === "string" ? result.nextPageToken : "";
            if (!pageToken) return { models, url: GOOGLE_MODELS_URL };
        }
        throw new ModelCatalogError("Google models.list exceeded the page limit.", 502);
    }

    async _fetchNativeCatalog() {
        if (!this.nativeCatalogFetcher) {
            throw new ModelCatalogError("AI Studio model discovery is not connected to a browser.", 503);
        }
        let response;
        try {
            response = await this.nativeCatalogFetcher();
        } catch (error) {
            if (error instanceof ModelCatalogError) throw error;
            throw new ModelCatalogError("Could not fetch AI Studio's model list from a signed-in browser.", 502);
        }
        return { models: parseNativeCatalog(response), url: NATIVE_MODELS_URL };
    }

    async syncCatalog(options = {}) {
        if (!options || typeof options !== "object" || Array.isArray(options)) {
            throw new ModelCatalogError("Sync options must be a JSON object.");
        }
        const source = options.source || "native";
        if (!["public", "google", "native"].includes(source)) {
            throw new ModelCatalogError("Catalog source must be native, public or google.");
        }
        const fetched =
            source === "native"
                ? await this._fetchNativeCatalog()
                : source === "google"
                  ? await this._fetchGoogleCatalog(options.apiKey)
                  : await this._fetchPublicCatalog();
        const candidates = new Map();
        for (const raw of fetched.models) {
            const id = normalizeModelId(raw?.name || raw?.id);
            if (!id || candidates.has(id)) continue;
            candidates.set(id, {
                metadata: safeMetadata(raw),
                nativeThinking: source === "native" ? validateNativeThinking(raw.nativeThinking) : undefined,
            });
        }
        if (candidates.size === 0 || candidates.size > MAX_MODELS) {
            throw new ModelCatalogError("Model source returned no valid models.", 502);
        }
        return this._queue(async () => {
            this._reloadFromDisk();
            const now = new Date().toISOString();
            const existing = new Map(this.state.models.map(model => [model.id, model]));
            const models = [...this.state.models];
            let added = 0;
            let updated = 0;
            const policiesReset = [];
            for (const [id, candidate] of candidates) {
                const { metadata, nativeThinking } = candidate;
                const previous = existing.get(id);
                if (previous) {
                    const index = models.findIndex(model => model.id === id);
                    const thinkingPolicy =
                        source === "native" &&
                        previous.thinkingPolicy.mode === "force" &&
                        !nativeThinking?.levels.includes(previous.thinkingPolicy.level)
                            ? { level: null, mode: "respect_client" }
                            : previous.thinkingPolicy;
                    if (thinkingPolicy !== previous.thinkingPolicy) policiesReset.push(id);
                    models[index] = {
                        ...previous,
                        capabilityOverride: source === "native" ? null : previous.capabilityOverride,
                        lastSeenAt: now,
                        metadata: { ...previous.metadata, ...metadata },
                        nativeThinking: source === "native" ? nativeThinking : previous.nativeThinking,
                        source,
                        thinkingPolicy,
                    };
                    updated++;
                } else {
                    models.push({
                        alias: null,
                        capabilityOverride: null,
                        enabled: false,
                        id,
                        lastSeenAt: now,
                        metadata,
                        nativeThinking: source === "native" ? nativeThinking : null,
                        probes: [],
                        source,
                        thinkingPolicy: { level: null, mode: "respect_client" },
                    });
                    added++;
                }
            }
            if (models.length > MAX_MODELS) throw new ModelCatalogError("Model catalog exceeds its limit.", 400);
            const state = await this._save({
                ...this.state,
                lastSyncedAt: now,
                models,
                source,
                sourceUrl: fetched.url,
            });
            return {
                ...state,
                lastSync: {
                    added,
                    conflicts: state.nameConflicts.filter(conflict => candidates.has(conflict.modelId)),
                    policiesReset,
                    retained: models.length - added - updated,
                    updated,
                },
            };
        });
    }

    close() {
        fs.unwatchFile(this.filePath, this._watchListener);
    }
}

module.exports = { capabilityFor, ModelCatalogError, ModelCatalogStore, normalizeModelId };
