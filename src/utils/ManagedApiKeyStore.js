const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY_PREFIX = "sk-aistudio-";
const MAX_KEYS = 200;

class ManagedApiKeyValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ManagedApiKeyValidationError";
    }
}

class ManagedApiKeyConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "ManagedApiKeyConflictError";
    }
}

function maskKey(key, source) {
    if (source === "legacy") {
        return key.length >= 16 ? `${key.slice(0, 2)}…${key.slice(-2)}` : "••••";
    }
    return `${KEY_PREFIX}…${key.slice(-4)}`;
}

function makeRecord(key, name, source) {
    const record = {
        createdAt: new Date().toISOString(),
        id: crypto.randomUUID(),
        key,
        name,
        source,
    };
    return record;
}

function publicRecord(record) {
    return {
        createdAt: record.createdAt,
        id: record.id,
        name: record.name,
        prefix: maskKey(record.key, record.source),
        source: record.source,
    };
}

class ManagedApiKeyStore {
    constructor(logger, dataDir = path.join(process.cwd(), "data"), legacyKeys = []) {
        this.logger = logger;
        this.filePath = path.join(dataDir, "api-keys.json");
        this.records = [];
        this.revision = 0;
        this.lastAppliedContent = null;
        const uniqueKeys = [
            ...new Set(legacyKeys.filter(key => typeof key === "string" && key.trim()).map(key => key.trim())),
        ];

        try {
            this._reloadFromDisk();
            if (uniqueKeys.some(key => !this.match(key))) {
                throw new Error(
                    "Existing data/api-keys.json is missing an API key from startup configuration. Resolve the migration mismatch before starting."
                );
            }
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            this.records = uniqueKeys.map((key, index) => makeRecord(key, `Imported key ${index + 1}`, "legacy"));
            if (this.records.length > MAX_KEYS) {
                throw new Error(`Too many legacy API keys (maximum ${MAX_KEYS}).`);
            }
            this._save();
            this.logger.info(`[Auth] Migrated ${this.records.length} API key(s) to data/api-keys.json.`);
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
            } catch (error) {
                this.logger.warn(`[Auth] API key file change ignored: ${error.message}`);
            }
        };
        fs.watchFile(this.filePath, { interval: 1000, persistent: false }, this._watchListener);
    }

    _parse(content) {
        const saved = JSON.parse(content);
        if (
            saved.version !== 1 ||
            !Number.isSafeInteger(saved.revision) ||
            saved.revision < 0 ||
            !Array.isArray(saved.keys)
        ) {
            throw new Error("Unsupported API key file format.");
        }
        if (saved.keys.length > MAX_KEYS) throw new Error("API key file exceeds its key limit.");
        const ids = new Set();
        const keys = new Set();
        for (const record of saved.keys) {
            if (
                !record ||
                typeof record.id !== "string" ||
                !/^[0-9a-f-]{36}$/i.test(record.id) ||
                typeof record.name !== "string" ||
                !record.name.trim() ||
                record.name.length > 80 ||
                typeof record.createdAt !== "string" ||
                !Number.isFinite(Date.parse(record.createdAt)) ||
                !["managed", "legacy"].includes(record.source) ||
                typeof record.key !== "string" ||
                !record.key ||
                record.key.length > 4096 ||
                ids.has(record.id) ||
                keys.has(record.key)
            ) {
                throw new Error("Invalid API key file record.");
            }
            ids.add(record.id);
            keys.add(record.key);
        }
        return saved;
    }

    _reloadFromDisk() {
        const content = fs.readFileSync(this.filePath, "utf8");
        if (process.platform !== "win32" && (fs.statSync(this.filePath).mode & 0o077) !== 0) {
            fs.chmodSync(this.filePath, 0o600);
        }
        if (content === this.lastAppliedContent) return;
        const saved = this._parse(content);
        this.records = saved.keys;
        this.revision = saved.revision;
        this.lastAppliedContent = content;
    }

    _save() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const nextRevision = this.revision + 1;
        const content = `${JSON.stringify({ keys: this.records, revision: nextRevision, version: 1 }, null, 2)}\n`;
        const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporaryPath, content, { mode: 0o600 });
            fs.renameSync(temporaryPath, this.filePath);
        } finally {
            fs.rmSync(temporaryPath, { force: true });
        }
        this.revision = nextRevision;
        this.lastAppliedContent = content;
    }

    list() {
        return { count: this.records.length, keys: this.records.map(publicRecord) };
    }

    getSecret(id) {
        return this.records.find(record => record.id === id)?.key || null;
    }

    getSecretsForLogRedaction() {
        return this.records.map(record => record.key);
    }

    create(name) {
        this._reloadFromDisk();
        if (name !== undefined && (typeof name !== "string" || name.trim().length > 80)) {
            throw new ManagedApiKeyValidationError("Key name must contain at most 80 characters.");
        }
        if (this.records.length >= MAX_KEYS) {
            throw new ManagedApiKeyValidationError(`Maximum of ${MAX_KEYS} API keys reached.`);
        }
        const key = `${KEY_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
        const record = makeRecord(key, name?.trim() || `API key ${this.records.length + 1}`, "managed");
        this.records = [...this.records, record];
        try {
            this._save();
        } catch (error) {
            this.records = this.records.filter(item => item.id !== record.id);
            throw error;
        }
        return { key, record: publicRecord(record) };
    }

    revoke(id, keepLegacyConsoleAccess = false) {
        this._reloadFromDisk();
        const target = this.records.find(record => record.id === id);
        if (
            keepLegacyConsoleAccess &&
            target?.source === "legacy" &&
            this.records.filter(record => record.source === "legacy").length === 1
        ) {
            throw new ManagedApiKeyConflictError(
                "Set a web console password before revoking the last key that can log in to the console."
            );
        }
        const remaining = this.records.filter(record => record.id !== id);
        if (remaining.length === this.records.length) return false;
        const previous = this.records;
        this.records = remaining;
        try {
            this._save();
        } catch (error) {
            this.records = previous;
            throw error;
        }
        return true;
    }

    match(key) {
        if (typeof key !== "string" || !key || key.length > 4096) return null;
        const candidate = Buffer.from(key);
        for (const record of this.records) {
            const stored = Buffer.from(record.key);
            if (candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored)) {
                return publicRecord(record);
            }
        }
        return null;
    }

    close() {
        fs.unwatchFile(this.filePath, this._watchListener);
    }
}

module.exports = { ManagedApiKeyConflictError, ManagedApiKeyStore, ManagedApiKeyValidationError };
