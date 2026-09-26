/**
 * Hot settings live in one persistent file. On first boot, existing environment
 * values seed that file for compatibility with existing deployments.
 */
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { CACHE_DEFAULTS, validateStartup } = require("./ConfigLoader");

const SAFETY_THRESHOLDS = new Set([
    "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
    "BLOCK_LOW_AND_ABOVE",
    "BLOCK_MEDIUM_AND_ABOVE",
    "BLOCK_ONLY_HIGH",
    "BLOCK_NONE",
    "OFF",
]);

const NUMERIC_LIMITS = Object.freeze({
    cacheCheckpointTokens: [1024, 100000],
    cacheMaxEntries: [1, 1000],
    cacheMinTokens: [1024, 100000],
    cacheRenewWindowSeconds: [0, 86400],
    cacheTtlSeconds: [60, 604800],
    failureThreshold: [0, 10000],
    fakeStreamTimeoutMs: [1, 300000],
    maxContexts: [0, 32],
    maxRetries: [1, 10],
    retryDelay: [50, 60000],
    streamTimeoutMs: [1, 300000],
    switchOnUses: [0, 10000],
});
const BOOLEAN_FIELDS = new Set([
    "cacheEnabled",
    "checkUpdate",
    "enableAuthUpdate",
    "forceCodeExecution",
    "forceThinking",
    "forceUrlContext",
    "forceWebSearch",
]);
const FIELDS = Object.freeze([
    ...Object.keys(NUMERIC_LIMITS),
    ...BOOLEAN_FIELDS,
    "logLevel",
    "safetySettingsThreshold",
    "streamingMode",
]);
const FIELD_SET = new Set(FIELDS);

class RuntimeConfigValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "RuntimeConfigValidationError";
    }
}

class RuntimeConfigStore {
    constructor(config, logger, dataDir = path.join(process.cwd(), "data"), onChange = () => {}) {
        this.config = config;
        this.logger = logger;
        this.filePath = path.join(dataDir, "config.json");
        this.onChange = onChange;
        this.defaults = Object.fromEntries(FIELDS.map(key => [key, config[key] ?? CACHE_DEFAULTS[key]]));
        this.settings = { ...this.defaults };
        this.fileExtras = {};
        this.revision = 0;
        this.pending = Promise.resolve();
        this.lastAppliedContent = null;
        this.watchTimer = null;
        this._loadAtStartup();
        fs.watchFile(this.filePath, { interval: 1000, persistent: false }, (current, previous) => {
            if (
                current.mtimeMs === previous.mtimeMs &&
                current.ctimeMs === previous.ctimeMs &&
                current.size === previous.size
            ) {
                return;
            }
            clearTimeout(this.watchTimer);
            this.watchTimer = setTimeout(() => {
                this._queue(() => this._reloadFromDisk()).catch(error => {
                    this.logger.warn(`[Config] Runtime settings file ignored: ${error.message}`);
                });
            }, 150);
            this.watchTimer.unref?.();
        });
    }

    _validatePatch(patch) {
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
            throw new RuntimeConfigValidationError("Settings must be a JSON object.");
        }

        const result = {};
        for (const [key, value] of Object.entries(patch)) {
            if (!FIELD_SET.has(key)) {
                throw new RuntimeConfigValidationError(`Unknown runtime setting: ${key}`);
            }
            if (Object.hasOwn(NUMERIC_LIMITS, key)) {
                const [min, max] = NUMERIC_LIMITS[key];
                if (!Number.isInteger(value) || value < min || value > max) {
                    throw new RuntimeConfigValidationError(`${key} must be an integer from ${min} to ${max}.`);
                }
            } else if (BOOLEAN_FIELDS.has(key)) {
                if (typeof value !== "boolean") {
                    throw new RuntimeConfigValidationError(`${key} must be a boolean.`);
                }
            } else if (key === "streamingMode" && !["real", "fake"].includes(value)) {
                throw new RuntimeConfigValidationError("streamingMode must be real or fake.");
            } else if (key === "logLevel" && !["INFO", "DEBUG"].includes(value)) {
                throw new RuntimeConfigValidationError("logLevel must be INFO or DEBUG.");
            } else if (key === "safetySettingsThreshold" && !SAFETY_THRESHOLDS.has(value)) {
                throw new RuntimeConfigValidationError("Invalid safetySettingsThreshold.");
            }
            result[key] = value;
        }
        return result;
    }

    _validateComplete(settings) {
        const validated = this._validatePatch(settings);
        const missing = FIELDS.find(key => !Object.hasOwn(validated, key));
        if (missing) throw new RuntimeConfigValidationError(`Missing runtime setting: ${missing}`);
        return validated;
    }

    _parseFile(content) {
        const saved = JSON.parse(content);
        if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0) {
            throw new RuntimeConfigValidationError("Unsupported config file format.");
        }
        validateStartup(saved.startup);
        // Add newly managed fields without changing values already saved by the user.
        const previousLogLevel = saved.startup?.logLevel ?? this.config.logLevel;
        const cacheDefaults = Object.fromEntries(Object.keys(CACHE_DEFAULTS).map(key => [key, this.defaults[key]]));
        const defaults = this._validateComplete({
            ...cacheDefaults,
            logLevel: previousLogLevel,
            ...saved.resetDefaults,
        });
        const settings = this._validateComplete({ ...cacheDefaults, logLevel: previousLogLevel, ...saved.settings });
        const fileExtras = Object.fromEntries(
            Object.entries(saved).filter(([key]) => !["version", "revision", "resetDefaults", "settings"].includes(key))
        );
        return { defaults, fileExtras, revision: saved.revision, settings };
    }

    _makeContent(settings, revision) {
        return `${JSON.stringify(
            { resetDefaults: this.defaults, revision, settings, version: 1, ...this.fileExtras },
            null,
            2
        )}\n`;
    }

    _loadAtStartup() {
        try {
            const content = fs.readFileSync(this.filePath, "utf8");
            const saved = this._parseFile(content);
            this.defaults = saved.defaults;
            this.settings = saved.settings;
            this.fileExtras = saved.fileExtras;
            this.revision = saved.revision;
            this._apply(saved.settings);
            const previousStartup = this.fileExtras.startup || {};
            const completedStartup = { ...(this.config.startup || {}), ...previousStartup };
            const previousFile = JSON.parse(content);
            const missingManagedFields = [...Object.keys(CACHE_DEFAULTS), "logLevel"].some(
                key => !Object.hasOwn(previousFile.settings, key) || !Object.hasOwn(previousFile.resetDefaults, key)
            );
            if (JSON.stringify(completedStartup) !== JSON.stringify(previousStartup) || missingManagedFields) {
                // Expand files created by an older release once. Values already
                // present in the file always win over the startup seed.
                this.fileExtras.startup = completedStartup;
                this.revision++;
                const migratedContent = this._makeContent(this.settings, this.revision);
                const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
                try {
                    fs.writeFileSync(temporaryPath, migratedContent, { mode: 0o600 });
                    fs.renameSync(temporaryPath, this.filePath);
                } finally {
                    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath);
                }
                this.lastAppliedContent = migratedContent;
            } else {
                this.lastAppliedContent = content;
            }
            this.logger.info("[Config] Loaded hot settings from data/config.json.");
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw new Error(`[Config] Invalid data/config.json: ${error.message}`);
            }
            // First run: capture the effective legacy settings once. Later changes
            // to the environment cannot silently overwrite the saved settings.
            this.defaults = this._validateComplete(this.defaults);
            this.settings = { ...this.defaults };
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
            this.fileExtras.startup = { ...this.config.startup };
            validateStartup(this.fileExtras.startup);
            const content = this._makeContent(this.settings, this.revision);
            try {
                fs.writeFileSync(temporaryPath, content, { mode: 0o600 });
                fs.renameSync(temporaryPath, this.filePath);
            } finally {
                if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath);
            }
            this.lastAppliedContent = content;
            this.logger.info("[Config] Created data/config.json from startup settings.");
        }
    }

    _apply(settings) {
        for (const key of FIELDS) {
            this.config[key] = settings[key];
        }
    }

    async _reloadFromDisk() {
        let content;
        try {
            content = await fs.promises.readFile(this.filePath, "utf8");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            content = null;
        }
        if (content === this.lastAppliedContent) return;

        if (content === null) {
            throw new RuntimeConfigValidationError("Config file was removed; current settings remain active.");
        }
        const saved = this._parseFile(content);

        const before = this.getState().effective;
        this.defaults = saved.defaults;
        this.settings = saved.settings;
        this.fileExtras = saved.fileExtras;
        this.revision = Math.max(this.revision + 1, saved.revision);
        this.lastAppliedContent = content;
        this._apply(saved.settings);
        this._notifyChange(before);
        this.logger.info(
            "[Config] Hot-loaded runtime settings from data/config.json; startup changes require restart."
        );
    }

    _notifyChange(before) {
        const changed = FIELDS.filter(key => before[key] !== this.config[key]);
        if (changed.length === 0) return;
        try {
            this.onChange(changed);
        } catch (error) {
            this.logger.error(`[Config] Could not apply runtime setting side effects: ${error.message}`);
        }
    }

    getState() {
        const activeStartup = this.config.startup || {};
        const savedStartup = this.fileExtras.startup || activeStartup;
        const restartRequired = Object.keys({ ...activeStartup, ...savedStartup }).some(
            key => JSON.stringify(activeStartup[key]) !== JSON.stringify(savedStartup[key])
        );
        return {
            configPath: this.filePath,
            defaults: { ...this.defaults },
            effective: Object.fromEntries(FIELDS.map(key => [key, this.config[key]])),
            revision: this.revision,
            startup: {
                apiKeyCount: Array.isArray(activeStartup.apiKeys) ? activeStartup.apiKeys.length : 0,
                consolePasswordConfigured: Boolean(activeStartup.webConsolePassword),
                consoleUsernameConfigured: Boolean(activeStartup.webConsoleUsername),
                host: activeStartup.host || this.config.host,
                httpPort: activeStartup.httpPort ?? this.config.httpPort,
                proxyConfigured: Boolean(activeStartup.proxyUrl),
                restartRequired,
            },
        };
    }

    async _save(settings) {
        const nextRevision = this.revision + 1;
        const directory = path.dirname(this.filePath);
        const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        await fs.promises.mkdir(directory, { recursive: true });
        const content = this._makeContent(settings, nextRevision);
        try {
            await fs.promises.writeFile(temporaryPath, content, { mode: 0o600 });
            await fs.promises.rename(temporaryPath, this.filePath);
        } finally {
            await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        }

        const before = this.getState().effective;
        this.settings = settings;
        this.revision = nextRevision;
        this.lastAppliedContent = content;
        this._apply(settings);
        this._notifyChange(before);
        return this.getState();
    }

    _queue(operation) {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => {});
        return result;
    }

    update(patch) {
        const validated = this._validatePatch(patch);
        return this._queue(async () => {
            await this._reloadFromDisk();
            if (Object.keys(validated).length === 0) return this.getState();
            return this._save({ ...this.settings, ...validated });
        });
    }

    toggle(key) {
        if (!BOOLEAN_FIELDS.has(key)) {
            throw new RuntimeConfigValidationError(`Cannot toggle runtime setting: ${key}`);
        }
        return this._queue(async () => {
            await this._reloadFromDisk();
            return this._save({ ...this.settings, [key]: !this.config[key] });
        });
    }

    reset() {
        return this._queue(async () => {
            await this._reloadFromDisk();
            return this._save({ ...this.defaults });
        });
    }

    close() {
        clearTimeout(this.watchTimer);
        fs.unwatchFile(this.filePath);
    }
}

module.exports = { RuntimeConfigStore, RuntimeConfigValidationError };
