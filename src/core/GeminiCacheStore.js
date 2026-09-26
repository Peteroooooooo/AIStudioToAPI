/**
 * Persistent index for Gemini explicit-cache resources. The index never stores
 * prompt text: it maps hashes of complete request prefixes to resource names.
 */
const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("crypto");

const INDEX_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 256;

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item ?? null)).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value)
            .filter(key => value[key] !== undefined)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function timestamp(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    return Date.parse(value);
}

class GeminiCacheStore {
    constructor({ dataDir, logger, config } = {}) {
        this.config = config || {};
        this.logger = logger || { warn() {} };
        this.filePath = path.join(dataDir || path.join(process.cwd(), "data"), "gemini-cache-index.json");
        this.entries = new Map();
        this.evictedEntries = [];
        this.pendingDeletes = new Map();
        this.pending = Promise.resolve();
        this.hitFlushTimer = null;
        this._load();
    }

    _maxEntries() {
        const limit = this.config.cacheMaxEntries;
        return Number.isSafeInteger(limit) && limit >= 0 ? limit : DEFAULT_MAX_ENTRIES;
    }

    _identity(accountKey, model) {
        if ((typeof accountKey !== "string" && typeof accountKey !== "number") || !String(accountKey)) {
            throw new TypeError("A nonempty accountKey is required for Gemini cache isolation.");
        }
        if (typeof model !== "string" || !model) {
            throw new TypeError("A nonempty model is required for Gemini cache isolation.");
        }
        return { accountKey: String(accountKey), model };
    }

    _contents(googleRequest) {
        if (!googleRequest || !Array.isArray(googleRequest.contents)) {
            throw new TypeError("Gemini cache request must include a contents array.");
        }
        return googleRequest.contents;
    }

    _prefixHashes(accountKey, model, googleRequest, maxPrefixLength) {
        const suffix = `],"model":${canonical(model)},"systemInstruction":${canonical(
            googleRequest.systemInstruction ?? null
        )},"toolConfig":${canonical(googleRequest.toolConfig ?? null)},"tools":${canonical(googleRequest.tools ?? null)}}`;
        const prefix = createHash("sha256").update(`{"accountKey":${canonical(accountKey)},"contents":[`);
        const hashes = [];
        for (let index = 0; index <= maxPrefixLength; index++) {
            hashes.push(prefix.copy().update(suffix).digest("hex"));
            if (index < maxPrefixLength) {
                if (index > 0) prefix.update(",");
                prefix.update(canonical(googleRequest.contents[index]));
            }
        }
        return hashes;
    }

    _prune(entries, now = Date.now()) {
        const evicted = [];
        for (const [hash, entry] of entries) {
            if (timestamp(entry.expireTime) <= now) {
                evicted.push({ ...entry });
                entries.delete(hash);
            }
        }
        const limit = this._maxEntries();
        if (entries.size <= limit) return evicted;
        const oldest = [...entries.values()].sort(
            (left, right) =>
                timestamp(left.lastUsedAt) - timestamp(right.lastUsedAt) ||
                timestamp(left.createdAt) - timestamp(right.createdAt) ||
                left.hash.localeCompare(right.hash)
        );
        for (let index = 0; index < oldest.length - limit; index++) {
            evicted.push({ ...oldest[index] });
            entries.delete(oldest[index].hash);
        }
        return evicted;
    }

    _deleteKey(entry) {
        return `${entry.accountKey}:${entry.name}`;
    }

    _rememberEvicted(pendingDeletes, evicted) {
        for (const entry of evicted) {
            if (timestamp(entry.expireTime) > Date.now()) pendingDeletes.set(this._deleteKey(entry), { ...entry });
        }
    }

    _prunePendingDeletes(pendingDeletes) {
        for (const [key, entry] of pendingDeletes) {
            if (timestamp(entry.expireTime) <= Date.now()) pendingDeletes.delete(key);
        }
    }

    _load() {
        let saved;
        try {
            saved = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") {
                this.logger.warn(`[Cache] Ignoring invalid cache index: ${error.message}`);
            }
            return;
        }
        if (saved.version !== INDEX_VERSION || !Array.isArray(saved.entries)) {
            this.logger.warn("[Cache] Ignoring unsupported cache index format.");
            return;
        }
        for (const entry of saved.entries) {
            if (
                !entry ||
                typeof entry.hash !== "string" ||
                !/^[a-f0-9]{64}$/.test(entry.hash) ||
                typeof entry.name !== "string" ||
                !entry.name.startsWith("cachedContents/") ||
                typeof entry.accountKey !== "string" ||
                typeof entry.model !== "string" ||
                !Number.isSafeInteger(entry.prefixLength) ||
                entry.prefixLength < 0 ||
                !Number.isFinite(timestamp(entry.expireTime)) ||
                !Number.isFinite(timestamp(entry.createdAt)) ||
                !Number.isFinite(timestamp(entry.lastUsedAt))
            ) {
                continue;
            }
            this.entries.set(entry.hash, { ...entry });
        }
        const savedPendingDeletes = Array.isArray(saved.pendingDeletes) ? saved.pendingDeletes : [];
        for (const entry of savedPendingDeletes) {
            if (
                entry &&
                typeof entry.accountKey === "string" &&
                typeof entry.name === "string" &&
                entry.name.startsWith("cachedContents/") &&
                Number.isFinite(timestamp(entry.expireTime)) &&
                timestamp(entry.expireTime) > Date.now()
            ) {
                this.pendingDeletes.set(this._deleteKey(entry), { ...entry });
            }
        }
        const previousSize = this.entries.size;
        const evicted = this._prune(this.entries);
        this.evictedEntries.push(...evicted);
        this._rememberEvicted(this.pendingDeletes, evicted);
        if (
            this.entries.size !== saved.entries.length ||
            this.entries.size !== previousSize ||
            this.pendingDeletes.size !== savedPendingDeletes.length
        ) {
            this._enqueue(() => this._persist(this.entries)).catch(error => {
                this.logger.warn(`[Cache] Could not prune persisted index: ${error.message}`);
            });
        }
    }

    _enqueue(action) {
        const task = this.pending.then(action);
        this.pending = task.catch(() => {});
        return task;
    }

    async _persist(entries, pendingDeletes = this.pendingDeletes) {
        const directory = path.dirname(this.filePath);
        await fs.promises.mkdir(directory, { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        const content = `${JSON.stringify({ entries: [...entries.values()], pendingDeletes: [...pendingDeletes.values()], version: INDEX_VERSION })}\n`;
        try {
            await fs.promises.writeFile(temporaryPath, content, { mode: 0o600 });
            await fs.promises.rename(temporaryPath, this.filePath);
        } finally {
            await fs.promises.rm(temporaryPath, { force: true });
        }
    }

    _scheduleMaintenance() {
        this._enqueue(async () => {
            const next = new Map(this.entries);
            const evicted = this._prune(next);
            if (next.size === this.entries.size) return;
            const nextPending = new Map(this.pendingDeletes);
            this._rememberEvicted(nextPending, evicted);
            await this._persist(next, nextPending);
            this.entries = next;
            this.pendingDeletes = nextPending;
            this.evictedEntries.push(...evicted);
        }).catch(error => {
            this.logger.warn(`[Cache] Could not prune cache index: ${error.message}`);
        });
    }

    findLongest({ accountKey, model, googleRequest, now = Date.now(), maxPrefixLength }) {
        const identity = this._identity(accountKey, model);
        const contents = this._contents(googleRequest);
        const nowMs = timestamp(now);
        const searchLimit = maxPrefixLength === undefined ? contents.length - 1 : maxPrefixLength;
        if (!Number.isSafeInteger(searchLimit) || searchLimit < 0 || searchLimit > contents.length) {
            if (maxPrefixLength === undefined && contents.length === 0) return null;
            throw new RangeError("maxPrefixLength must identify a complete contents prefix.");
        }
        if (!Number.isFinite(nowMs)) return null;

        const limit = this._maxEntries();
        if (limit === 0) {
            if (this.entries.size) this._scheduleMaintenance();
            return null;
        }
        const valid = [...this.entries.values()]
            .filter(entry => timestamp(entry.expireTime) > nowMs)
            .sort((left, right) => timestamp(right.lastUsedAt) - timestamp(left.lastUsedAt))
            .slice(0, limit);
        if (valid.length !== this.entries.size) this._scheduleMaintenance();
        const allowed = new Set(valid.map(entry => entry.hash));

        const hashes = this._prefixHashes(identity.accountKey, identity.model, googleRequest, searchLimit);
        for (let prefixLength = searchLimit; prefixLength >= 0; prefixLength--) {
            const hash = hashes[prefixLength];
            const entry = this.entries.get(hash);
            if (entry && allowed.has(hash)) return { entry: { ...entry }, prefixLength };
        }
        return null;
    }

    async put({
        accountKey,
        model,
        googleRequest,
        prefixLength,
        name,
        expireTime,
        tokenCount = null,
        retireAncestors = false,
        canRetireAncestor = () => true,
    }) {
        const identity = this._identity(accountKey, model);
        const contents = this._contents(googleRequest);
        if (!Number.isSafeInteger(prefixLength) || prefixLength < 0 || prefixLength > contents.length) {
            throw new RangeError("Cache prefix must end at a complete contents message boundary.");
        }
        if (typeof name !== "string" || !name.startsWith("cachedContents/")) {
            throw new TypeError("A Gemini cachedContents resource name is required.");
        }
        const expiryMs = timestamp(expireTime);
        if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
            throw new RangeError("Cache expireTime must be in the future.");
        }
        if (tokenCount !== null && (!Number.isSafeInteger(tokenCount) || tokenCount < 0)) {
            throw new RangeError("Cache tokenCount must be a nonnegative integer.");
        }
        const hashes = this._prefixHashes(identity.accountKey, identity.model, googleRequest, prefixLength);
        const hash = hashes[prefixLength];
        return this._enqueue(async () => {
            const now = new Date().toISOString();
            const previous = this.entries.get(hash);
            const entry = {
                accountKey: identity.accountKey,
                createdAt: previous?.createdAt || now,
                expireTime: new Date(expiryMs).toISOString(),
                hash,
                hitCount: previous?.hitCount || 0,
                lastUsedAt: now,
                model: identity.model,
                name,
                prefixLength,
                tokenCount,
            };
            const next = new Map(this.entries);
            next.set(hash, entry);
            const retired = [];
            if (retireAncestors) {
                // The zero-message resource is shared across independent conversations.
                for (const ancestorHash of hashes.slice(1, prefixLength)) {
                    const ancestor = next.get(ancestorHash);
                    if (ancestor && canRetireAncestor(ancestor)) {
                        retired.push({ ...ancestor });
                        next.delete(ancestorHash);
                    }
                }
            }
            const evicted = this._prune(next);
            evicted.push(...retired);
            if (previous && previous.name !== name) evicted.push({ ...previous });
            const nextPending = new Map(this.pendingDeletes);
            this._rememberEvicted(nextPending, evicted);
            await this._persist(next, nextPending);
            this.entries = next;
            this.pendingDeletes = nextPending;
            this.evictedEntries.push(...evicted);
            return { ...entry, evicted };
        });
    }

    async remove(entry) {
        if (!entry?.hash) return false;
        return this._enqueue(async () => {
            const current = this.entries.get(entry.hash);
            if (!current || current.name !== entry.name) return false;
            const next = new Map(this.entries);
            next.delete(entry.hash);
            await this._persist(next);
            this.entries = next;
            return true;
        });
    }

    async retire(entry, canRetire = () => true) {
        if (!entry?.hash || entry.prefixLength === 0) return false;
        return this._enqueue(async () => {
            const current = this.entries.get(entry.hash);
            if (!current || current.name !== entry.name || !canRetire(current)) return false;
            const next = new Map(this.entries);
            next.delete(entry.hash);
            const nextPending = new Map(this.pendingDeletes);
            this._rememberEvicted(nextPending, [current]);
            await this._persist(next, nextPending);
            this.entries = next;
            this.pendingDeletes = nextPending;
            this.evictedEntries.push({ ...current });
            return true;
        });
    }

    hasCurrent(entry) {
        if (!entry?.hash) return false;
        const current = this.entries.get(entry.hash);
        return Boolean(current && current.name === entry.name && timestamp(current.expireTime) > Date.now());
    }

    async recordHit(entry) {
        if (!entry?.hash) return false;
        return this._enqueue(() => {
            const current = this.entries.get(entry.hash);
            if (!current || current.name !== entry.name) return false;
            current.hitCount = (current.hitCount || 0) + 1;
            current.lastUsedAt = new Date().toISOString();
            if (!this.hitFlushTimer) {
                this.hitFlushTimer = setTimeout(() => {
                    this.hitFlushTimer = null;
                    this._enqueue(() => this._persist(this.entries)).catch(error => {
                        this.logger.warn(`[Cache] Could not save cache hits: ${error.message}`);
                    });
                }, 5000);
                this.hitFlushTimer.unref?.();
            }
            return true;
        });
    }

    pendingDeleteEntries() {
        return [...this.pendingDeletes.values()].map(entry => ({ ...entry }));
    }

    async markDeleted(entry) {
        return this._enqueue(async () => {
            const key = this._deleteKey(entry);
            if (!this.pendingDeletes.has(key)) return false;
            const nextPending = new Map(this.pendingDeletes);
            nextPending.delete(key);
            await this._persist(this.entries, nextPending);
            this.pendingDeletes = nextPending;
            return true;
        });
    }

    stats() {
        const now = Date.now();
        const active = [...this.entries.values()].filter(entry => timestamp(entry.expireTime) > now);
        return {
            entryCount: Math.min(active.length, this._maxEntries()),
            hitCount: active.reduce((sum, entry) => sum + (entry.hitCount || 0), 0),
            maxEntries: this._maxEntries(),
        };
    }

    takeEvicted() {
        const evicted = this.evictedEntries;
        this.evictedEntries = [];
        return evicted;
    }

    async close() {
        if (this.hitFlushTimer) {
            clearTimeout(this.hitFlushTimer);
            this.hitFlushTimer = null;
        }
        return this._enqueue(async () => {
            const next = new Map(this.entries);
            const evicted = this._prune(next);
            const nextPending = new Map(this.pendingDeletes);
            this._rememberEvicted(nextPending, evicted);
            this._prunePendingDeletes(nextPending);
            await this._persist(next, nextPending);
            this.entries = next;
            this.pendingDeletes = nextPending;
            this.evictedEntries.push(...evicted);
        });
    }
}

module.exports = GeminiCacheStore;
