/**
 * File: src/utils/ConfigLoader.js
 * Description: Loads the single persisted config, with legacy environment values used only for initial migration
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const LoggingService = require("./LoggingService");
const { getProxyBypass, getProxyBypassFromEnv, getProxySummary } = require("./ProxyUtils");

const isValidStartupValue = (key, value) => {
    switch (key) {
        case "apiKeys":
            return (
                Array.isArray(value) &&
                value.length > 0 &&
                value.every(item => typeof item === "string" && item.trim().length > 0)
            );
        case "httpPort":
            return Number.isInteger(value) && value >= 1 && value <= 65535;
        case "initialAuthIndex":
            return value === null || (Number.isInteger(value) && value >= 0);
        case "rateLimitMaxAttempts":
            return Number.isInteger(value) && value >= 0 && value <= 1000;
        case "rateLimitWindowMinutes":
            return Number.isInteger(value) && value >= 1 && value <= 1440;
        case "immediateSwitchStatusCodes":
            return Array.isArray(value) && value.every(code => Number.isInteger(code) && code >= 400 && code <= 599);
        case "enableUsageStats":
        case "secureCookies":
            return typeof value === "boolean";
        case "browserExecutablePath":
        case "proxyUrl":
        case "webConsolePassword":
        case "webConsoleUsername":
            return value === null || typeof value === "string";
        case "host":
        case "iconUrl":
        case "proxyBypass":
        case "sessionSecret":
        case "timezone":
            return typeof value === "string" && value.length > 0;
        default:
            return false;
    }
};

const STARTUP_KEYS = [
    "apiKeys",
    "browserExecutablePath",
    "enableUsageStats",
    "host",
    "httpPort",
    "iconUrl",
    "immediateSwitchStatusCodes",
    "initialAuthIndex",
    "proxyBypass",
    "proxyUrl",
    "rateLimitMaxAttempts",
    "rateLimitWindowMinutes",
    "secureCookies",
    "sessionSecret",
    "timezone",
    "webConsolePassword",
    "webConsoleUsername",
];
const REQUIRED_STARTUP_KEYS = ["apiKeys", "host", "httpPort", "sessionSecret", "webConsolePassword"];

const validateStartup = startup => {
    if (!startup || typeof startup !== "object" || Array.isArray(startup)) {
        throw new Error("Missing startup settings in data/config.json.");
    }
    for (const key of REQUIRED_STARTUP_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(startup, key)) {
            throw new Error(`Missing required startup setting ${key} in data/config.json.`);
        }
    }
    for (const key of STARTUP_KEYS) {
        if (Object.prototype.hasOwnProperty.call(startup, key) && !isValidStartupValue(key, startup[key])) {
            throw new Error(`Invalid startup setting ${key} in data/config.json.`);
        }
    }
    return startup;
};

/**
 * Configuration Loader Module
 * Responsible for loading startup configuration and seeding the persisted config
 */
class ConfigLoader {
    constructor(logger) {
        this.logger = logger;
    }

    loadConfiguration() {
        const configPath = path.join(process.cwd(), "data", "config.json");
        const importLegacyEnv = !fs.existsSync(configPath);
        const legacyEnv = importLegacyEnv ? process.env : {};
        const config = {
            apiKeys: [],
            apiKeySource: "Not set",
            browserExecutablePath: null,
            checkUpdate: true,
            enableAuthUpdate: true,
            enableUsageStats: true,
            failureThreshold: 3,
            fakeStreamTimeoutMs: 300000,
            forceCodeExecution: false,
            forceThinking: false,
            forceUrlContext: false,
            forceWebSearch: false,
            host: "0.0.0.0",
            httpPort: 7860,
            iconUrl: "/AIStudio_logo.svg",
            immediateSwitchStatusCodes: [429, 503],
            initialAuthIndex: null,
            logLevel: "INFO",
            maxContexts: 1,
            maxRetries: 3,
            proxyBypass: importLegacyEnv ? getProxyBypassFromEnv() : getProxyBypass(),
            proxyUrl: null,
            rateLimitMaxAttempts: 5,
            rateLimitWindowMinutes: 15,
            retryDelay: 2000,
            safetySettingsThreshold: "OFF",
            secureCookies: false,
            sessionSecret: crypto.randomBytes(32).toString("hex"),
            streamingMode: "real",
            streamTimeoutMs: 60000,
            switchOnUses: 40,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            webConsolePassword: null,
            webConsoleUsername: null,
            wsPort: 9998,
        };

        // Environment variable overrides
        if (legacyEnv.PORT) {
            const parsed = parseInt(legacyEnv.PORT, 10);
            config.httpPort = Number.isFinite(parsed) ? parsed : config.httpPort;
        }
        if (legacyEnv.HOST) config.host = legacyEnv.HOST;
        if (legacyEnv.STREAMING_MODE) config.streamingMode = legacyEnv.STREAMING_MODE;
        if (legacyEnv.FAILURE_THRESHOLD) {
            const parsed = parseInt(legacyEnv.FAILURE_THRESHOLD, 10);
            config.failureThreshold = Number.isFinite(parsed) ? Math.max(0, parsed) : config.failureThreshold;
        }
        if (legacyEnv.SWITCH_ON_USES) {
            const parsed = parseInt(legacyEnv.SWITCH_ON_USES, 10);
            config.switchOnUses = Number.isFinite(parsed) ? Math.max(0, parsed) : config.switchOnUses;
        }
        if (legacyEnv.MAX_RETRIES) {
            const parsed = parseInt(legacyEnv.MAX_RETRIES, 10);
            config.maxRetries = Number.isFinite(parsed) ? Math.max(1, parsed) : config.maxRetries;
        }
        if (legacyEnv.RETRY_DELAY) {
            const parsed = parseInt(legacyEnv.RETRY_DELAY, 10);
            config.retryDelay = Number.isFinite(parsed) ? Math.max(50, parsed) : config.retryDelay;
        }
        if (legacyEnv.STREAM_TIMEOUT_MS) {
            const parsed = parseInt(legacyEnv.STREAM_TIMEOUT_MS, 10);
            config.streamTimeoutMs = Number.isFinite(parsed)
                ? Math.min(300000, Math.max(1, parsed))
                : config.streamTimeoutMs;
        }
        if (legacyEnv.FAKE_STREAM_TIMEOUT_MS) {
            const parsed = parseInt(legacyEnv.FAKE_STREAM_TIMEOUT_MS, 10);
            config.fakeStreamTimeoutMs = Number.isFinite(parsed)
                ? Math.min(300000, Math.max(1, parsed))
                : config.fakeStreamTimeoutMs;
        }
        if (legacyEnv.WS_PORT) {
            // WS_PORT environment variable is no longer supported
            this.logger.error(
                `[Config] ❌ WS_PORT environment variable is deprecated and no longer supported. ` +
                    `The WebSocket port is now fixed at 9998. Please remove WS_PORT from your .env file.`
            );
            // Do not modify config.wsPort - keep it at default 9998
        }
        if (legacyEnv.MAX_CONTEXTS) {
            const parsed = parseInt(legacyEnv.MAX_CONTEXTS, 10);
            config.maxContexts = Number.isFinite(parsed) ? Math.max(0, parsed) : config.maxContexts;
        }
        if (legacyEnv.CAMOUFOX_EXECUTABLE_PATH) config.browserExecutablePath = legacyEnv.CAMOUFOX_EXECUTABLE_PATH;
        if (legacyEnv.API_KEYS) {
            config.apiKeys = legacyEnv.API_KEYS.split(",");
        }
        if (legacyEnv.CHECK_UPDATE) config.checkUpdate = legacyEnv.CHECK_UPDATE.toLowerCase() !== "false";
        if (legacyEnv.FORCE_THINKING) config.forceThinking = legacyEnv.FORCE_THINKING.toLowerCase() === "true";
        if (legacyEnv.FORCE_CODE_EXECUTION)
            config.forceCodeExecution = legacyEnv.FORCE_CODE_EXECUTION.toLowerCase() === "true";
        if (legacyEnv.FORCE_WEB_SEARCH) config.forceWebSearch = legacyEnv.FORCE_WEB_SEARCH.toLowerCase() === "true";
        if (legacyEnv.FORCE_URL_CONTEXT) config.forceUrlContext = legacyEnv.FORCE_URL_CONTEXT.toLowerCase() === "true";
        if (legacyEnv.SAFETY_SETTINGS_THRESHOLD) {
            const rawThreshold = String(legacyEnv.SAFETY_SETTINGS_THRESHOLD).trim().toUpperCase();
            const allowedThresholds = new Set([
                "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
                "BLOCK_LOW_AND_ABOVE",
                "BLOCK_MEDIUM_AND_ABOVE",
                "BLOCK_ONLY_HIGH",
                "BLOCK_NONE",
                "OFF",
            ]);
            if (allowedThresholds.has(rawThreshold)) {
                config.safetySettingsThreshold = rawThreshold;
            } else {
                this.logger.warn(
                    `[Config] Invalid SAFETY_SETTINGS_THRESHOLD "${legacyEnv.SAFETY_SETTINGS_THRESHOLD}", falling back to ${config.safetySettingsThreshold}.`
                );
            }
        }
        if (legacyEnv.ENABLE_AUTH_UPDATE)
            config.enableAuthUpdate = legacyEnv.ENABLE_AUTH_UPDATE.toLowerCase() !== "false";
        if (legacyEnv.ENABLE_USAGE_STATS)
            config.enableUsageStats = legacyEnv.ENABLE_USAGE_STATS.toLowerCase() !== "false";

        let rawCodes = legacyEnv.IMMEDIATE_SWITCH_STATUS_CODES;
        let codesSource = importLegacyEnv ? "legacy environment" : "config file/default value";

        if (
            rawCodes === undefined &&
            config.immediateSwitchStatusCodes &&
            Array.isArray(config.immediateSwitchStatusCodes)
        ) {
            rawCodes = config.immediateSwitchStatusCodes.join(",");
            codesSource = "default value";
        }

        if (rawCodes && typeof rawCodes === "string") {
            config.immediateSwitchStatusCodes = rawCodes
                .split(",")
                .map(code => parseInt(String(code).trim(), 10))
                .filter(code => !isNaN(code) && code >= 400 && code <= 599);
        } else {
            config.immediateSwitchStatusCodes = [];
        }
        if (config.immediateSwitchStatusCodes.length > 0) {
            this.logger.info(`[System] Loaded "immediate switch status codes" from ${codesSource}.`);
        }
        if (Array.isArray(config.apiKeys)) {
            config.apiKeys = config.apiKeys.map(k => String(k).trim()).filter(k => k);
        } else {
            config.apiKeys = [];
        }

        // One-time migration source for startup settings. Existing data/config.json
        // always wins over these values on later starts.
        config.webConsoleUsername = legacyEnv.WEB_CONSOLE_USERNAME || null;
        config.webConsolePassword = legacyEnv.WEB_CONSOLE_PASSWORD || null;
        config.secureCookies = legacyEnv.SECURE_COOKIES?.toLowerCase() === "true";
        config.sessionSecret = legacyEnv.SESSION_SECRET || config.sessionSecret;
        config.iconUrl = legacyEnv.ICON_URL || config.iconUrl;
        config.timezone = legacyEnv.TZ || config.timezone;
        config.logLevel = legacyEnv.LOG_LEVEL?.toUpperCase() === "DEBUG" ? "DEBUG" : "INFO";
        const initialAuthIndex = Number(legacyEnv.INITIAL_AUTH_INDEX);
        if (legacyEnv.INITIAL_AUTH_INDEX && Number.isInteger(initialAuthIndex) && initialAuthIndex >= 0) {
            config.initialAuthIndex = initialAuthIndex;
        }
        const rateLimitMaxAttempts = Number(legacyEnv.RATE_LIMIT_MAX_ATTEMPTS);
        if (legacyEnv.RATE_LIMIT_MAX_ATTEMPTS === "0") {
            config.rateLimitMaxAttempts = 0;
        } else if (Number.isInteger(rateLimitMaxAttempts) && rateLimitMaxAttempts > 0) {
            config.rateLimitMaxAttempts = rateLimitMaxAttempts;
        }
        const rateLimitWindowMinutes = Number(legacyEnv.RATE_LIMIT_WINDOW_MINUTES);
        if (Number.isInteger(rateLimitWindowMinutes) && rateLimitWindowMinutes > 0) {
            config.rateLimitWindowMinutes = rateLimitWindowMinutes;
        }
        for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
            if (legacyEnv[key]?.trim()) {
                config.proxyUrl = legacyEnv[key].trim();
                break;
            }
        }

        if (fs.existsSync(configPath)) {
            const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
            if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0) {
                throw new Error("Unsupported data/config.json format.");
            }
            validateStartup(saved.startup);
            for (const key of STARTUP_KEYS) {
                if (Object.prototype.hasOwnProperty.call(saved.startup, key)) {
                    config[key] = saved.startup[key];
                }
            }
        }
        config.apiKeys = Array.isArray(config.apiKeys)
            ? config.apiKeys.map(key => String(key).trim()).filter(Boolean)
            : [];
        if (config.apiKeys.length > 0) {
            config.apiKeySource = "Custom";
        } else if (importLegacyEnv) {
            config.apiKeys = ["123456"];
            config.apiKeySource = "Default";
            this.logger.info("[System] No API key set, using default password: 123456");
        } else {
            throw new Error("data/config.json must configure at least one API key.");
        }
        config.startup = Object.fromEntries(STARTUP_KEYS.map(key => [key, config[key]]));
        LoggingService.setLevel(config.logLevel);
        LoggingService.setTimezone(config.timezone);

        // Load model list
        const modelsPath = path.join(process.cwd(), "configs", "models.json");
        try {
            if (fs.existsSync(modelsPath)) {
                const modelsFileContent = fs.readFileSync(modelsPath, "utf-8");
                const modelsData = JSON.parse(modelsFileContent);
                if (modelsData && modelsData.models) {
                    config.modelList = modelsData.models;
                    this.logger.info(
                        `[System] Successfully loaded ${config.modelList.length} models from models.json.`
                    );
                } else {
                    this.logger.warn(`[System] models.json is not in the expected format, using default model list.`);
                    config.modelList = [{ name: "models/gemini-2.5-flash-lite" }];
                }
            } else {
                this.logger.warn(`[System] models.json file not found, using default model list.`);
                config.modelList = [{ name: "models/gemini-2.5-flash-lite" }];
            }
        } catch (error) {
            this.logger.error(
                `[System] Failed to read or parse models.json: ${error.message}, using default model list.`
            );
            config.modelList = [{ name: "models/gemini-2.5-flash-lite" }];
        }

        return config;
    }

    _printConfiguration(config) {
        this.logger.info("================ [ Active Configuration ] ================");
        this.logger.info(`  HTTP Server Port: ${config.httpPort}`);
        this.logger.info(`  Listening Address: ${config.host}`);
        this.logger.info(`  Streaming Mode: ${config.streamingMode}`);
        this.logger.info(`  Stream Timeout: ${config.streamTimeoutMs}ms`);
        this.logger.info(`  Fake/Non-Stream Timeout: ${config.fakeStreamTimeoutMs}ms`);
        this.logger.info(`  Force Thinking: ${config.forceThinking}`);
        this.logger.info(`  Force Code Execution: ${config.forceCodeExecution}`);
        this.logger.info(`  Force Web Search: ${config.forceWebSearch}`);
        this.logger.info(`  Force URL Context: ${config.forceUrlContext}`);
        this.logger.info(`  Check Update: ${config.checkUpdate}`);
        this.logger.info(`  Default Safety Threshold: ${config.safetySettingsThreshold}`);
        this.logger.info(`  Auto Update Auth: ${config.enableAuthUpdate}`);
        this.logger.info(`  Usage Stats: ${config.enableUsageStats}`);
        this.logger.info(`  Max Contexts: ${config.maxContexts === 0 ? "Unlimited" : config.maxContexts}`);
        this.logger.info(
            `  Usage-based Switch Threshold: ${
                config.switchOnUses > 0 ? `Switch after every ${config.switchOnUses} requests` : "Disabled"
            }`
        );
        this.logger.info(
            `  Failure-based Switch: ${
                config.failureThreshold > 0 ? `Switch after ${config.failureThreshold} failures` : "Disabled"
            }`
        );
        this.logger.info(
            `  Immediate Switch Status Codes: ${
                config.immediateSwitchStatusCodes.length > 0 ? config.immediateSwitchStatusCodes.join(", ") : "Disabled"
            }`
        );
        this.logger.info(`  Max Retries per Request: ${config.maxRetries} times`);
        this.logger.info(`  Retry Delay: ${config.retryDelay}ms`);
        this.logger.info(`  API Key Source: ${config.apiKeySource}`);

        const proxySummary = getProxySummary(config.proxyUrl);
        if (!proxySummary.enabled) {
            this.logger.info("  Proxy: Disabled");
        } else {
            this.logger.info("  Proxy: Enabled (config file)");
            this.logger.info(`  Proxy Server: ${proxySummary.server}`);
        }
        this.logger.info("=============================================================");
    }
}

module.exports = ConfigLoader;
module.exports.validateStartup = validateStartup;
