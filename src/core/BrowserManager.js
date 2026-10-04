/**
 * File: src/core/BrowserManager.js
 * Description: Browser manager for launching and controlling headless Firefox instances with authentication contexts
 *
 * Author: Ellinav, iBenzene, bbbugg, 挈挈
 */

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { firefox } = require("playwright");
const os = require("os");

const { getProxySummary, parseProxyConfig, withoutLegacyProxyEnv } = require("../utils/ProxyUtils");
const StickyProxyManager = require("../utils/StickyProxyManager");
const { detectAccountEmail } = require("../auth/AuthPageIdentity");
const {
    AuthExpiredError,
    isAuthExpiredError,
    ContextAbortedError,
    isContextAbortedError,
} = require("../utils/CustomErrors");

const WS_INIT_TIMEOUT_MS = 120000;
const CONTEXT_INIT_TIMEOUT_MS = 300000;
const BROWSER_RPC_TIMEOUT_MS = 15000;
const CONTEXT_CLEANUP_TIMEOUT_MS = 5000;
const POOL_REFILL_INTERVAL_MS = 10000;
const LOGIN_CONFIRM_WAIT_MS = 1500;
const EXPIRED_RECHECK_SCHEDULER_MS = 60 * 1000;
const EXPIRED_RECHECK_INTERVAL_MS = 15 * 60 * 1000;
const EXPIRED_RECHECK_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const EXPIRED_RECHECK_WS_TIMEOUT_MS = 60000;
const AUTH_IDENTITY_URL = "https://aistudio.google.com/apps";
const NATIVE_MODELS_RPC_PATH = "MakerSuiteService/ListModels";
const FIREFOX_DOH_DISABLED_PREFS = {
    "network.trr.mode": 5,
    "network.trr.uri": "",
};

/**
 * Browser Manager Module
 * Responsible for launching, managing, and switching browser contexts
 */
class BrowserManager {
    constructor(logger, config, authSource) {
        this.logger = logger;
        this.config = config;
        this.authSource = authSource;
        this.stickyProxyManager = new StickyProxyManager(logger, authSource, { proxyBypass: config.proxyBypass });
        this.stickyProxyManager.isEnabled();
        this.browser = null;
        this._browserLaunchTask = null;

        // Multi-context architecture: Store all initialized contexts
        // Map: authIndex -> {context, page, healthMonitorInterval}
        this.contexts = new Map();

        // Context pool state tracking
        this.initializingContexts = new Set(); // Indices currently being initialized in background
        this.abortedContexts = new Set(); // Indices that should be aborted during background init
        this._backgroundPreloadTask = null; // Current background preload task promise (only one at a time)
        this._backgroundPreloadAbort = false; // Flag to signal background task to abort
        this._accountReadyTasks = new Map();
        this._poolReadyTask = null;
        this._rebalanceTask = null;

        // Legacy single context references (for backward compatibility)
        this.context = null;
        this.page = null;

        // currentAuthIndex is the single source of truth for current account, accessed via getter/setter
        // -1 means no account is currently active (invalid/error state)
        this._currentAuthIndex = -1;

        // Flag to distinguish intentional close from unexpected disconnect
        // Used by ConnectionRegistry callback to skip unnecessary reconnect attempts
        this.isClosingIntentionally = false;

        // ConnectionRegistry reference (set after construction to avoid circular dependency)
        this.connectionRegistry = null;
        this._onAuthQueuesDrained = null;
        this._isSystemBusyProvider = null;
        this._accountLoadProvider = null;
        this._accountChangeNotifier = null;
        this.pendingContextClosures = new Map();
        this._closingPendingContexts = new Map();
        this._authUpdateSuspended = new Set();
        this._authUpdateTasks = new Map();
        this._markExpiredTasks = new Map();
        this._expiredRecheckTask = null;
        this._expiredRecheckIndex = null;
        this._expiredRecheckContext = null;
        this._expiredRecheckBrowser = null;
        this._expiredRecheckAborted = false;
        this._recheckBrowserOrphaned = false;
        this._expiredRecheckDueAt = new Map();
        this._expiredRecheckFailures = new Map();
        this._expiredRecheckCursor = 0;

        // Background wakeup service status (instance-level, tracks this.page)
        // Prevents multiple BackgroundWakeup instances from running simultaneously
        this.backgroundWakeupRunning = false;

        // Added for background wakeup logic from new core
        this.noButtonCount = 0;

        // WebSocket initialization state per context - prevents cross-contamination
        // between concurrent init/reconnect operations on different accounts
        // Map: authIndex -> { success: boolean, failed: boolean }
        this._wsInitState = new Map();

        // Target URL for AI Studio app
        this.targetUrl = "https://ai.studio/apps/cab9ab6c-44f9-4e7a-8972-037f8ae177ab";

        // Firefox/Camoufox does not use Chromium-style command line args.
        // We keep this empty; Camoufox has its own anti-fingerprinting optimizations built-in.
        this.launchArgs = [];

        // Firefox-specific preferences for optimization (passed to firefox.launch)
        this.firefoxUserPrefs = {
            "app.update.enabled": false, // Disable auto updates
            "browser.cache.disk.enable": false, // Disable disk cache
            "browser.ping-centre.telemetry": false, // Disable ping telemetry
            "browser.safebrowsing.enabled": false, // Disable safe browsing
            "browser.safebrowsing.malware.enabled": false, // Disable malware check
            "browser.safebrowsing.phishing.enabled": false, // Disable phishing check
            "browser.search.update": false, // Disable search engine auto-update
            "browser.shell.checkDefaultBrowser": false, // Skip default browser check
            "browser.tabs.warnOnClose": false, // No warning on closing tabs
            "datareporting.policy.dataSubmissionEnabled": false, // Disable data reporting
            "dom.min_background_timeout_value": 1, // Disable background tab timer throttling (default: 1000ms)
            "dom.min_timeout_value": 1, // Reduce global minimum timer interval (default: 4ms per HTML5 spec)
            "dom.min_tracking_background_timeout_value": 1, // Disable tracking script background throttling (default: 10000ms)
            "dom.timeout.background_budget_regeneration_rate": 200, // Increase budget regeneration rate to prevent budget exhaustion
            "dom.timeout.background_throttling_max_budget": 100, // Increase max timer budget to reduce throttling frequency
            "dom.timeout.budget_throttling_max_delay": 0, // Disable budget-based forced delay (default: 11250ms)
            "dom.timeout.throttling_delay": 2147483647, // Prevent throttling from ever activating (default: 50ms)
            "dom.webnotifications.enabled": false, // Disable notifications
            "extensions.update.enabled": false, // Disable extension auto-update
            "general.smoothScroll": false, // Disable smooth scrolling
            "gfx.webrender.all": false, // Disable WebRender (GPU-based renderer)
            "layers.acceleration.disabled": true, // Disable GPU hardware acceleration
            "media.autoplay.default": 5, // 5 = Block all autoplay
            "media.volume_scale": "0.0", // Mute audio
            "network.dns.disablePrefetch": true, // Disable DNS prefetching
            "network.http.speculative-parallel-limit": 0, // Disable speculative connections
            "network.prefetch-next": false, // Disable link prefetching
            ...FIREFOX_DOH_DISABLED_PREFS, // Disable DoH/TRR to respect system DNS/hosts
            "permissions.default.geo": 0, // 0 = Always deny geolocation
            "services.sync.enabled": false, // Disable Firefox Sync
            "toolkit.cosmeticAnimations.enabled": false, // Disable UI animations
            "toolkit.telemetry.archive.enabled": false, // Disable telemetry archive
            "toolkit.telemetry.enabled": false, // Disable telemetry
            "toolkit.telemetry.unified": false, // Disable unified telemetry
        };

        this._expiredRecheckTimer = setInterval(async () => {
            try {
                await this._drainPendingReauthClosures();
            } catch (error) {
                this.logger.warn(`[Auth Recheck] Pending context refresh failed: ${error.message}`);
            }
            try {
                await this._recheckNextExpiredAccount();
            } catch (error) {
                this.logger.warn(`[Auth Recheck] Background check failed: ${error.message}`);
            }
        }, EXPIRED_RECHECK_SCHEDULER_MS);
        this._expiredRecheckTimer.unref?.();
        this._startPoolMaintenance();
    }

    get currentAuthIndex() {
        return this._currentAuthIndex;
    }

    set currentAuthIndex(value) {
        this._currentAuthIndex = value;
    }

    _getBrowserExecutablePath() {
        if (this.config.browserExecutablePath) {
            return this.config.browserExecutablePath;
        }

        const platform = os.platform();
        if (platform === "linux") {
            return path.join(process.cwd(), "camoufox-linux", "camoufox");
        }
        if (platform === "win32") {
            return path.join(process.cwd(), "camoufox", "camoufox.exe");
        }
        if (platform === "darwin") {
            return path.join(process.cwd(), "camoufox-macos", "Camoufox.app", "Contents", "MacOS", "camoufox");
        }

        throw new Error(`Unsupported operating system: ${platform}`);
    }

    /**
     * Set the ConnectionRegistry reference (called after construction to avoid circular dependency)
     * @param {ConnectionRegistry} connectionRegistry - The ConnectionRegistry instance
     */
    setConnectionRegistry(connectionRegistry) {
        if (this.connectionRegistry && this._onAuthQueuesDrained) {
            this.connectionRegistry.off("authQueuesDrained", this._onAuthQueuesDrained);
        }
        this.connectionRegistry = connectionRegistry;
        if (this.connectionRegistry) {
            this._onAuthQueuesDrained = authIndex => {
                this._closePendingContextIfIdle(authIndex).catch(error => {
                    this.logger.error(
                        `[ContextPool] Failed to close pending context #${authIndex} after queue drain: ${error.message}`
                    );
                });
            };
            this.connectionRegistry.on("authQueuesDrained", this._onAuthQueuesDrained);
        }
    }

    setSystemBusyProvider(provider) {
        this._isSystemBusyProvider = typeof provider === "function" ? provider : null;
    }

    setAccountLoadProvider(provider) {
        this._accountLoadProvider = typeof provider === "function" ? provider : null;
    }

    setAccountChangeNotifier(notifier) {
        this._accountChangeNotifier = typeof notifier === "function" ? notifier : null;
    }

    notifyAccountIdle(authIndex) {
        this._closePendingContextIfIdle(authIndex).catch(error => {
            this.logger.warn(`[ContextPool] Deferred close for #${authIndex} failed: ${error.message}`);
        });
    }

    _ensurePoolState() {
        this._accountRuntime ||= new Map();
        this._initializationTokens ||= new Map();
        this._candidateFailures ||= new Map();
        this._transportFailedAccounts ||= new Set();
        this._accountTestReservations ||= new Map();
    }

    _runtime(index, state, reason, phase = null, nextRetryAt = null) {
        this._ensurePoolState();
        const previous = this._accountRuntime.get(index);
        this._accountRuntime.set(index, {
            nextRetryAt,
            phase,
            reason,
            since: previous?.state === state && previous?.phase === phase ? previous.since : Date.now(),
            state,
        });
    }

    getAccountRuntimeState(authIndex) {
        this._ensurePoolState();
        const recorded = this._accountRuntime.get(authIndex);
        const health = this.authSource.health.getStatus?.(authIndex) || {};
        const serving = this.getReadyAccountIndices().includes(authIndex);
        let state = recorded?.state || "standby";
        let reason = recorded?.reason || "not_loaded";
        if (this.pendingContextClosures.has(authIndex)) {
            state = "draining";
            reason = this.pendingContextClosures.get(authIndex);
        } else if (!this.authSource.getRotationIndices().includes(authIndex)) {
            state = "unavailable";
            reason = health.mode || "excluded";
        } else if (this.initializingContexts.has(authIndex)) {
            state = "initializing";
            reason = "initialization_in_progress";
        } else if (serving) {
            state = health.probeRequired ? "verifying" : "ready";
            reason = health.probeRequired ? (health.probeInFlight ? "probe_in_progress" : "probe_required") : null;
        } else if (this.connectionRegistry?.isReconnectingInProgress?.(authIndex)) {
            state = "reconnecting";
            reason = "connection_recovery";
        } else if (this._transportFailedAccounts.has(authIndex)) {
            state = "stalled";
            reason = recorded?.reason || "transport_failure";
        } else if (this.contexts.has(authIndex)) {
            state = "stalled";
            reason = "connection_not_ready";
        } else if (state === "ready" || state === "verifying" || state === "initializing" || state === "reconnecting") {
            state = "standby";
            reason = "not_loaded";
        }
        return {
            authIndex,
            connected: Boolean(this.connectionRegistry?.isAccountConnected?.(authIndex)),
            hasContext: this.contexts.has(authIndex),
            nextRetryAt: state === "stalled" ? recorded?.nextRetryAt || null : null,
            phase: ["ready", "verifying", "standby", "unavailable"].includes(state) ? null : recorded?.phase || null,
            reason,
            serving,
            since: recorded?.since || null,
            state,
        };
    }

    getPoolSnapshot() {
        const indices = new Set([
            ...(this.authSource.initialIndices || this.authSource.getRotationIndices()),
            ...this.contexts.keys(),
            ...this.initializingContexts,
        ]);
        const accounts = [...indices].map(index => this.getAccountRuntimeState(index));
        const target = this.config.maxContexts || this.authSource.getRotationIndices().length;
        const members = new Set(this.getReadyAccountIndices());
        const count = state =>
            accounts.filter(
                account =>
                    account.state === state &&
                    (!["ready", "verifying"].includes(state) || members.has(account.authIndex))
            ).length;
        return {
            accounts,
            draining: count("draining"),
            initializing: count("initializing"),
            ready: count("ready"),
            reconnecting: count("reconnecting"),
            shortfall: Math.max(0, target - count("ready") - count("verifying")),
            stalled: count("stalled"),
            target,
            verifying: count("verifying"),
        };
    }

    _startPoolMaintenance() {
        if (this._poolMaintenanceTimer) return;
        this._poolMaintenanceTimer = setInterval(() => {
            if (!this.browser || this.isClosingIntentionally) return;
            this.rebalanceContextPool().catch(error => this.logger.warn(`[ContextPool] ${error.message}`));
        }, POOL_REFILL_INTERVAL_MS);
        this._poolMaintenanceTimer.unref?.();
    }

    _stopPoolMaintenance() {
        clearInterval(this._poolMaintenanceTimer);
        this._poolMaintenanceTimer = null;
    }

    _assertInitialization(token) {
        if (!token) return;
        if (token.cancelled || this._initializationTokens?.get(token.authIndex) !== token) {
            throw new ContextAbortedError(token.authIndex, "initialization superseded or timed out");
        }
    }

    isConnectionGenerationCurrent(authIndex, contextGeneration) {
        const test = this._accountTestConnection;
        if (test?.authIndex === authIndex && !test.cancelled && String(contextGeneration) === test.generation)
            return true;
        const recheck = this._recheckConnectionGenerations?.get(authIndex);
        if (recheck && !this._expiredRecheckAborted && String(contextGeneration) === recheck) return true;
        const token = this._initializationTokens?.get(authIndex);
        if (!token) {
            const residentGeneration = this.contexts.get(authIndex)?.generation;
            if (residentGeneration) return String(contextGeneration) === residentGeneration;
            return contextGeneration === undefined || contextGeneration === null || contextGeneration === "";
        }
        return !token.cancelled && String(contextGeneration) === String(token.generation);
    }

    async _bounded(operation, timeout, description, token = null, onLateResult = null) {
        this._assertInitialization(token);
        let timer;
        let expired = false;
        const pending = Promise.resolve().then(operation);
        pending.then(
            value => {
                if ((expired || token?.cancelled) && onLateResult) {
                    Promise.resolve(onLateResult(value)).catch(() => {});
                }
            },
            () => {}
        );
        try {
            const result = await Promise.race([
                pending,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => {
                            expired = true;
                            const error = new Error(`${description} exceeded its deadline (${timeout}ms).`);
                            error.code = "BROWSER_OPERATION_TIMEOUT";
                            reject(error);
                        },
                        Math.max(1, timeout)
                    );
                }),
                ...(token?.abortPromise ? [token.abortPromise] : []),
            ]);
            this._assertInitialization(token);
            return result;
        } finally {
            clearTimeout(timer);
        }
    }

    _initStage(token, phase, operation, limit = BROWSER_RPC_TIMEOUT_MS, onLateResult = null) {
        this._runtime(token.authIndex, "initializing", "initialization_in_progress", phase);
        this.logger.debug(`[Context#${token.authIndex}] Initialization phase: ${phase}`);
        return this._bounded(
            operation,
            Math.min(limit, Math.max(1, token.deadline - Date.now())),
            `Account #${token.authIndex} ${phase}`,
            token,
            onLateResult
        );
    }

    async _cleanupOperation(operation, description) {
        try {
            await this._bounded(operation, this._cleanupTimeoutMs || CONTEXT_CLEANUP_TIMEOUT_MS, description);
        } catch (error) {
            this.logger.warn(`[ContextPool] ${description}: ${error.message}`);
        }
    }

    _backOffCandidate(index, error) {
        this._ensurePoolState();
        const failures = (this._candidateFailures.get(index) || 0) + 1;
        this._candidateFailures.set(index, failures);
        this._runtime(
            index,
            "stalled",
            error.message,
            this._accountRuntime.get(index)?.phase,
            Date.now() + Math.min(300000, 30000 * 2 ** Math.min(4, failures - 1))
        );
    }

    markAccountTransportFailure(index, reason = "transport_failure") {
        this._ensurePoolState();
        this._transportFailedAccounts.add(index);
        this._runtime(index, "stalled", reason, "close_unresponsive_context");
        this._closeContextForPoolIfPossible(index, "transport_failure").catch(error =>
            this.logger.warn(`[ContextPool] Failed to retire account #${index}: ${error.message}`)
        );
        if (this.browser && !this.isClosingIntentionally) {
            this.rebalanceContextPool().catch(error => this.logger.warn(`[ContextPool] ${error.message}`));
        }
    }

    markAccountTestRecovered(index) {
        this._ensurePoolState();
        this._transportFailedAccounts.delete(index);
        this._candidateFailures.delete(index);
        this._runtime(index, this.contexts.has(index) ? "ready" : "standby", "not_loaded");
    }

    isAccountReady(authIndex) {
        const entry = this.contexts.get(authIndex);
        return Boolean(
            entry?.page &&
            !entry.page.isClosed() &&
            this.authSource.health.isAvailable(authIndex) &&
            !this.authSource.isExpired(authIndex) &&
            !this.authSource.pendingRefreshIndices?.has(authIndex) &&
            !this.pendingContextClosures.has(authIndex) &&
            !this.initializingContexts.has(authIndex) &&
            !this._transportFailedAccounts?.has(authIndex) &&
            this.connectionRegistry?.isAccountConnected(authIndex)
        );
    }

    getReadyAccountIndices() {
        const eligible = this.authSource.getRotationIndices();
        const ready = eligible.filter(index => this.isAccountReady(index));
        return this.config.maxContexts > 0 ? ready.slice(0, this.config.maxContexts) : ready;
    }

    _getServingPoolOccupancy() {
        const eligible = new Set(this.authSource.getRotationIndices());
        return [...new Set([...this.contexts.keys(), ...this.initializingContexts])].filter(
            index =>
                eligible.has(index) &&
                !this.pendingContextClosures.has(index) &&
                (this.initializingContexts.has(index) || this.isAccountReady(index))
        ).length;
    }

    async ensureAccountReady(authIndex) {
        if (this._accountTestConnection?.authIndex === authIndex) return false;
        if (this.isAccountReady(authIndex)) return true;
        if (!this.authSource.getRotationIndices().includes(authIndex)) return false;
        if (this._accountReadyTasks.has(authIndex)) return this._accountReadyTasks.get(authIndex);
        const task = this._ensureAccountReady(authIndex);
        this._accountReadyTasks.set(authIndex, task);
        try {
            return await task;
        } finally {
            if (this._accountReadyTasks.get(authIndex) === task) this._accountReadyTasks.delete(authIndex);
        }
    }

    async _ensureAccountReady(authIndex) {
        if (this.initializingContexts.has(authIndex)) await this._waitForContextInit(authIndex);
        if (this.isAccountReady(authIndex)) return true;
        if (this.authSource.pendingRefreshIndices?.has(authIndex)) return false;
        if (this.contexts.has(authIndex)) {
            if (this._hasActiveQueueForAuth(authIndex)) return false;
            if (
                this.connectionRegistry?.isInGracePeriod(authIndex) ||
                this.connectionRegistry?.isReconnectingInProgress(authIndex)
            )
                return false;
            if (!this.contexts.get(authIndex).page?.isClosed()) {
                if (await this.attemptLightweightReconnect(authIndex)) return this.isAccountReady(authIndex);
                return false;
            }
            await this.closeContext(authIndex);
        }
        if (this.config.maxContexts > 0 && this._getServingPoolOccupancy() >= this.config.maxContexts) return false;
        this.initializingContexts.add(authIndex);
        try {
            await this._ensureBrowser();
            await this._initializeContext(authIndex, true);
            if (this._currentAuthIndex < 0) {
                const entry = this.contexts.get(authIndex);
                if (entry) this._activateContext(entry.context, entry.page, authIndex);
            }
        } finally {
            this.initializingContexts.delete(authIndex);
        }
        return this.isAccountReady(authIndex);
    }

    async ensureAccountPoolReady() {
        this._startPoolMaintenance();
        // Existing ready accounts are never held behind another account's launch.
        if (this.getReadyAccountIndices().length > 0) {
            this.rebalanceContextPool().catch(error => this.logger.warn(`[ContextPool] ${error.message}`));
            return this.getReadyAccountIndices();
        }
        if (this._poolReadyTask) return this._poolReadyTask;
        const task = (async () => {
            await this.rebalanceContextPool();
            const poolCap = this.config.maxContexts || Infinity;
            for (const index of this.authSource.getRotationIndices()) {
                if (this._getServingPoolOccupancy() >= poolCap && !this.contexts.has(index)) break;
                try {
                    if (await this.ensureAccountReady(index)) break;
                } catch (error) {
                    this.logger.warn(`[ContextPool] Account #${index} not ready: ${error.message}`);
                }
            }
            this.rebalanceContextPool().catch(error => this.logger.warn(`[ContextPool] ${error.message}`));
            return this.getReadyAccountIndices();
        })();
        this._poolReadyTask = task;
        try {
            return await task;
        } finally {
            if (this._poolReadyTask === task) this._poolReadyTask = null;
        }
    }

    async fetchNativeModelCatalog() {
        const preferred = this.contexts.get(this.currentAuthIndex);
        const source =
            preferred?.context && !preferred.page?.isClosed()
                ? preferred
                : [...this.contexts.values()].find(entry => entry.context && !entry.page?.isClosed());
        if (!source) throw new Error("No active AI Studio browser context is available for model sync.");

        const page = await source.context.newPage();
        try {
            const [response] = await Promise.all([
                page.waitForResponse(
                    candidate =>
                        candidate.request().method() === "POST" && candidate.url().includes(NATIVE_MODELS_RPC_PATH),
                    { timeout: 45000 }
                ),
                page.goto(AUTH_IDENTITY_URL, { timeout: 45000, waitUntil: "domcontentloaded" }),
            ]);
            if (!response.ok()) throw new Error(`AI Studio model list returned HTTP ${response.status()}.`);
            const body = await response.text();
            if (body.length > 10000000) throw new Error("AI Studio model list is too large.");
            return JSON.parse(body);
        } catch (error) {
            const reason = String(error.message || error)
                .split("\n", 1)[0]
                .slice(0, 180);
            this.logger.warn(`[Models] AI Studio model discovery failed: ${reason}`);
            throw error;
        } finally {
            await page.close().catch(() => {});
        }
    }

    _isSystemBusy() {
        try {
            return this._isSystemBusyProvider?.() === true;
        } catch (error) {
            this.logger.warn(`[ContextPool] Failed to read system busy state: ${error.message}`);
            return false;
        }
    }

    /**
     * Helper: Check for page errors that require refresh
     * @returns {Object} Object with error flags
     */
    async _checkPageErrors(page) {
        try {
            return await page.evaluate(() => {
                // eslint-disable-next-line no-undef
                const bodyText = document.body.innerText || "";
                return {
                    appletFailed: bodyText.includes("Failed to initialize applet"),
                    concurrentUpdates:
                        bodyText.includes("There are concurrent updates") || bodyText.includes("concurrent updates"),
                    snapshotFailed:
                        bodyText.includes("Failed to create snapshot") || bodyText.includes("Please try again"),
                };
            });
        } catch (e) {
            return { appletFailed: false, concurrentUpdates: false, snapshotFailed: false };
        }
    }

    _isCriticalPageError(error) {
        const msg = error?.message || "";
        return (
            msg.includes("Execution context was destroyed") ||
            msg.includes("Target page, context or browser has been closed") ||
            msg.includes("Protocol error") ||
            msg.includes("Navigation failed because page was closed")
        );
    }

    _throwIfContextInitAborted(authIndex, isBackgroundTask = false, logPrefix = null, action = "Context init") {
        if (this.abortedContexts.has(authIndex)) {
            if (logPrefix) {
                this.logger.info(`${logPrefix} ${action} aborted (context marked for deletion)`);
            }
            throw new ContextAbortedError(authIndex, "marked for deletion");
        }

        if (isBackgroundTask && this._backgroundPreloadAbort) {
            if (logPrefix) {
                this.logger.info(`${logPrefix} ${action} aborted (background preload aborted)`);
            }
            throw new ContextAbortedError(authIndex, "background preload aborted");
        }
    }

    async _clickButtonByTextIfVisible(page, text, logPrefix = "[Browser]", debugName = "button") {
        try {
            // Use DOM operation to find and click button
            const clicked = await page.evaluate(text => {
                // eslint-disable-next-line no-undef
                const buttons = document.querySelectorAll("button");
                for (const btn of buttons) {
                    // Check if the element occupies space (simple visibility check)
                    const rect = btn.getBoundingClientRect();
                    const isVisible = rect.width > 0 && rect.height > 0;

                    if (isVisible) {
                        const btnText = (btn.innerText || "").trim();
                        if (btnText === text) {
                            btn.click();
                            return true;
                        }
                    }
                }
                return false;
            }, text);

            return clicked;
        } catch (error) {
            // Element not visible or doesn't exist is expected here,
            // but propagate clearly critical browser/page issues.
            if (error && error.message) {
                const msg = error.message;
                if (this._isCriticalPageError(error)) {
                    throw error;
                }
                if (this.logger && typeof this.logger.debug === "function") {
                    this.logger.debug(`${logPrefix} Ignored error while checking ${debugName}: ${msg}`);
                }
            }
        }

        return false;
    }

    async _clickLaunchButtonIfVisible(page, logPrefix = "[Browser]") {
        try {
            this.logger.debug(`${logPrefix} 🔍 Checking for Launch button...`);

            const clicked = await page.evaluate(() => {
                const isVisible = element => {
                    const rect = element.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                };
                const getText = element => (element.innerText || element.textContent || "").trim();
                const hasLaunchText = element => getText(element).includes("Launch");
                const clickTarget = element => {
                    const target = element.closest("button, [role='button']") || element;
                    target.click();
                    return true;
                };

                // eslint-disable-next-line no-undef
                const controls = Array.from(document.querySelectorAll("button, div[role='button']"));
                for (const control of controls) {
                    if (!isVisible(control)) continue;

                    const ariaLabel = control.getAttribute("aria-label") || "";
                    if (hasLaunchText(control) || ariaLabel.includes("Launch")) {
                        return clickTarget(control);
                    }
                }

                // eslint-disable-next-line no-undef
                const spans = Array.from(document.querySelectorAll("button span, [role='button'] span"));
                for (const span of spans) {
                    if (!isVisible(span)) continue;
                    if (hasLaunchText(span)) {
                        return clickTarget(span);
                    }
                }

                return false;
            });

            if (clicked) {
                this.logger.info(`${logPrefix} Launch button clicked successfully`);
                return true;
            }
        } catch (error) {
            if (this._isCriticalPageError(error)) {
                throw error;
            }
            this.logger.warn(`${logPrefix} ⚠️ Error while checking for Launch button: ${error.message}`);
        }

        return false;
    }

    /**
     * Helper: Wait for WebSocket initialization with log monitoring
     * Supports abort for background tasks and context deletion
     * @param {object} page - Playwright page object
     * @param {string} logPrefix - Log prefix for messages
     * @param {number} timeout - Timeout in milliseconds (default 120000)
     * @param {number} authIndex - Auth index for this context (default -1)
     * @param {boolean} isBackgroundTask - Whether this is a background preload task (default false)
     * @returns {Promise<boolean>} true if initialization succeeded, false if failed or aborted
     */
    async _waitForWebSocketInit(
        page,
        logPrefix = "[Browser]",
        timeout = WS_INIT_TIMEOUT_MS,
        authIndex = -1,
        isBackgroundTask = false,
        initializationToken = null
    ) {
        const token = initializationToken || { cancelled: false };
        try {
            return await this._bounded(
                () => this._waitForWebSocketInitLoop(page, logPrefix, timeout, authIndex, isBackgroundTask, token),
                timeout,
                `${logPrefix} WebSocket initialization`
            );
        } finally {
            if (!initializationToken) token.cancelled = true;
        }
    }

    async _waitForWebSocketInitLoop(page, logPrefix, timeout, authIndex, isBackgroundTask, token) {
        this.logger.info(
            `${logPrefix} ⏳ Waiting for Continue/Launch button or WebSocket initialization (timeout: ${timeout / 1000}s)...`
        );

        const startTime = Date.now();
        const checkInterval = 1000; // Check every 1 second
        let continueClicked = false;
        let skipClicked = false;
        let iteration = 0;
        const poll = async (phase, operation) => {
            if (token.cancelled) throw new ContextAbortedError(authIndex, "WebSocket wait cancelled");
            if (authIndex >= 0)
                this._runtime(
                    authIndex,
                    logPrefix.includes("Reconnect") ? "reconnecting" : "initializing",
                    "waiting_for_websocket",
                    phase
                );
            const result = await this._bounded(
                operation,
                Math.min(BROWSER_RPC_TIMEOUT_MS, Math.max(1, timeout - (Date.now() - startTime))),
                `${logPrefix} ${phase}`,
                token.authIndex !== undefined ? token : null
            );
            if (token.cancelled) throw new ContextAbortedError(authIndex, "WebSocket wait cancelled");
            return result;
        };

        try {
            while (Date.now() - startTime < timeout) {
                if (token.cancelled) throw new ContextAbortedError(authIndex, "WebSocket wait timed out");
                this._throwIfContextInitAborted(authIndex, isBackgroundTask, logPrefix, "WebSocket wait");

                // Read state fresh each iteration
                const state = this._wsInitState.get(authIndex);

                // Check if initialization succeeded
                if (this.connectionRegistry?.isAccountConnected?.(authIndex)) {
                    return true;
                }

                // Check if initialization failed
                if (state && state.failed) {
                    this.logger.warn(`${logPrefix} Initialization failed`);
                    return false;
                }

                if (!continueClicked) {
                    const continueText = "Continue to the app";
                    continueClicked = await poll("websocket_continue", () =>
                        this._clickButtonByTextIfVisible(page, continueText, logPrefix, `popup "${continueText}"`)
                    );
                    if (continueClicked) {
                        this.logger.info(`${logPrefix} Found "${continueText}" button, clicking...`);
                    }
                }

                if (!skipClicked) {
                    const skipText = "Skip";
                    skipClicked = await poll("websocket_skip", () =>
                        this._clickButtonByTextIfVisible(page, skipText, logPrefix, `popup "${skipText}"`)
                    );
                    if (skipClicked) {
                        this.logger.info(`${logPrefix} Found "${skipText}" button, clicking...`);
                    }
                }

                if (iteration % 5 === 0) {
                    await poll("websocket_launch", () => this._clickLaunchButtonIfVisible(page, logPrefix));
                }

                // Check for page errors
                const errors = await poll("websocket_page_errors", () => this._checkPageErrors(page));
                if (errors.appletFailed || errors.concurrentUpdates || errors.snapshotFailed) {
                    this.logger.warn(`${logPrefix} Detected page error: ${JSON.stringify(errors)}`);
                    return false;
                }
                // Random mouse movement while waiting (80% chance per iteration)
                if (Math.random() < 0.3) {
                    try {
                        const vp = page.viewportSize() || { height: 1080, width: 1920 };
                        const randomX = Math.floor(Math.random() * (vp.width * 0.7));
                        const randomY = Math.floor(Math.random() * (vp.height * 0.7));
                        await poll("websocket_mouse", () => this._simulateHumanMovement(page, randomX, randomY));
                    } catch (e) {
                        // Ignore movement errors
                    }
                }
                // Wait before next check
                iteration++;
                await page.waitForTimeout(checkInterval);
            }

            // Timeout reached
            this.logger.error(`${logPrefix} ⏱️ WebSocket initialization timeout after ${timeout / 1000}s`);
            return false;
        } catch (error) {
            // Re-throw aborts and critical page/browser errors so callers keep the original failure reason.
            if (isContextAbortedError(error) || this._isCriticalPageError(error)) {
                throw error;
            }
            // For other errors, log and return false
            this.logger.error(`${logPrefix} Error during WebSocket initialization wait: ${error.message}`);
            return false;
        }
    }

    /**
     * Feature: Update authentication file
     * Writes the current storageState back to the auth file, effectively extending session validity.
     * @param {number} authIndex - The auth index to update
     */
    async _updateAuthFile(authIndex) {
        if (this._authUpdateSuspended.has(authIndex)) return;
        const previous = this._authUpdateTasks.get(authIndex);
        const write = () => {
            if (!this._authUpdateSuspended.has(authIndex)) return this._writeAuthFileFromContext(authIndex);
        };
        const task = previous ? previous.catch(() => {}).then(write) : Promise.resolve(write());
        this._authUpdateTasks.set(authIndex, task);
        try {
            await task;
        } finally {
            if (this._authUpdateTasks.get(authIndex) === task) this._authUpdateTasks.delete(authIndex);
        }
    }

    async _captureStorageState(context) {
        // A partial fallback would overwrite existing IndexedDB credentials in the
        // auth file. Keep the previous snapshot unchanged if complete capture fails.
        return this._bounded(
            () => context.storageState({ indexedDB: true }),
            this._cleanupTimeoutMs || CONTEXT_CLEANUP_TIMEOUT_MS,
            "Capture account storage state"
        );
    }

    async _writeAuthFileFromContext(authIndex) {
        // Retrieve the target account's context from the multi-context Map to avoid cross-contamination of auth data by using this.context
        const contextData = this.contexts.get(authIndex);
        if (!contextData || !contextData.context) return;

        try {
            const configDir = path.join(process.cwd(), "configs", "auth");
            const authFilePath = path.join(configDir, `auth-${authIndex}.json`);

            // Read original file content to preserve all fields (e.g. accountName, custom fields)
            // Relies on AuthSource validation (checks valid index AND file existence)
            const storageState = await this._captureStorageState(contextData.context);
            if (this._authUpdateSuspended.has(authIndex) || this.contexts.get(authIndex) !== contextData) return;
            const authData = this.authSource.getAuth(authIndex);
            if (!authData) {
                this.logger.warn(
                    `[Auth Update] Auth source #${authIndex} returned no data (invalid index or file missing), skipping update.`
                );
                return;
            }

            // Merge new credentials into existing data
            authData.cookies = storageState.cookies;
            authData.origins = storageState.origins;

            // Note: We do NOT force-set accountName. If it was there, it stays; if not, it remains missing.
            // This preserves the "missing state" as requested.

            // Overwrite the file with merged data
            const temporaryPath = `${authFilePath}.${process.pid}.${randomUUID()}.tmp`;
            try {
                await fs.promises.writeFile(temporaryPath, JSON.stringify(authData, null, 2), {
                    flag: "wx",
                    mode: 0o600,
                });
                if (this._authUpdateSuspended.has(authIndex) || this.contexts.get(authIndex) !== contextData) return;
                await fs.promises.rename(temporaryPath, authFilePath);
            } finally {
                await fs.promises.unlink(temporaryPath).catch(() => {});
            }

            this.logger.info(`[Auth Update] 💾 Successfully updated auth credentials for account #${authIndex}`);
        } catch (error) {
            this.logger.error(`[Auth Update] ❌ Failed to update auth file: ${error.message}`);
        }
    }

    async suspendAuthUpdates(authIndex, options = {}) {
        if (!options.keepRecheckRunning && this._expiredRecheckIndex === authIndex) {
            await this._stopExpiredRecheck();
            if (this._expiredRecheckTask) await this._expiredRecheckTask;
        }
        this._authUpdateSuspended.add(authIndex);
        this.authSource.setPendingRefresh(authIndex, true);
        const marking = this._markExpiredTasks.get(authIndex);
        if (marking) await marking;
        const pending = this._authUpdateTasks.get(authIndex);
        if (pending) await pending;
    }

    resumeAuthUpdates(authIndex) {
        this._authUpdateSuspended.delete(authIndex);
        this.authSource.setPendingRefresh(authIndex, false);
    }

    async _markAccountExpired(authIndex) {
        const previous = this._markExpiredTasks.get(authIndex);
        const mark = () => {
            if (this._authUpdateSuspended.has(authIndex)) return false;
            return this.authSource.markAsExpired(authIndex);
        };
        const task = previous ? previous.catch(() => {}).then(mark) : Promise.resolve(mark());
        this._markExpiredTasks.set(authIndex, task);
        try {
            return await task;
        } finally {
            if (this._markExpiredTasks.get(authIndex) === task) this._markExpiredTasks.delete(authIndex);
        }
    }

    /**
     * Get pool target indices based on current account and rotation order
     * @param {number} maxContexts - Max pool size (0 = unlimited)
     * @returns {number[]} Target indices for the pool
     */
    // _getPoolTargetIndices(maxContexts) {
    //     const rotation = this.authSource.getRotationIndices();
    //     if (rotation.length === 0) return [];
    //     if (maxContexts === 0 || maxContexts >= rotation.length) return [...rotation];
    //
    //     const currentCanonical =
    //         this._currentAuthIndex >= 0 ? this.authSource.getCanonicalIndex(this._currentAuthIndex) : null;
    //     const startPos = currentCanonical !== null ? rotation.indexOf(currentCanonical) : -1;
    //     const start = startPos >= 0 ? startPos : 0;
    //
    //     const result = [];
    //     for (let i = 0; i < maxContexts && i < rotation.length; i++) {
    //         result.push(rotation[(start + i) % rotation.length]);
    //     }
    //     return result;
    // }

    /**
     * Interface: Notify user activity
     * Used to force wake up the Launch detection when a request comes in
     */
    notifyUserActivity(authIndex = this._currentAuthIndex) {
        const entry = this.contexts.get(authIndex);
        if (entry) entry.noButtonCount = 0;
        this.noButtonCount = 0;
    }

    /**
     * Helper: Generate a consistent numeric seed from a string
     * Used to keep fingerprints consistent for the same account index
     */
    _generateIdentitySeed(str) {
        let hashValue = 0;
        for (let i = 0; i < str.length; i++) {
            const charCode = str.charCodeAt(i);
            hashValue = (hashValue << 5) - hashValue + charCode;
            hashValue |= 0; // Convert to 32bit integer
        }
        return Math.abs(hashValue);
    }

    /**
     * Feature: Generate Privacy Protection Script (Stealth Mode)
     * Injects specific GPU info and masks webdriver properties to avoid bot detection.
     */
    _getPrivacyProtectionScript(authIndex, generationOverride = undefined) {
        const contextGeneration = generationOverride ?? this._initializationTokens?.get(authIndex)?.generation ?? null;
        let seedSource = `account_salt_${authIndex}`;

        // Attempt to use accountName (email) for better consistency across index reordering
        try {
            const authData = this.authSource.getAuth(authIndex);
            if (authData && authData.accountName && typeof authData.accountName === "string") {
                const cleanName = authData.accountName.trim().toLowerCase();
                if (cleanName.length > 0) {
                    seedSource = `account_email_${cleanName}`;
                }
            }
        } catch (e) {
            // Fallback to index-based seed if auth data read fails
        }

        // Use a consistent seed so the fingerprint remains static for this specific account
        let seed = this._generateIdentitySeed(seedSource);

        // Pseudo-random generator based on the seed
        const deterministicRandom = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };

        // Select a GPU profile consistent with this account
        const gpuProfiles = [
            { renderer: "Intel Iris OpenGL Engine", vendor: "Intel Inc." },
            {
                renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)",
                vendor: "Google Inc. (NVIDIA)",
            },
            {
                renderer: "ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
                vendor: "Google Inc. (AMD)",
            },
        ];
        const profile = gpuProfiles[Math.floor(deterministicRandom() * gpuProfiles.length)];

        // We inject a noise variable to make the environment unique but stable
        const randomArtifact = Math.floor(deterministicRandom() * 1000);

        return `
            (function() {
                if (window._privacyProtectionInjected) return;
                window._privacyProtectionInjected = true;

                try {
                    // 1. Mask WebDriver property
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                    // 2. Mock Plugins if empty
                    if (navigator.plugins.length === 0) {
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => new Array(${3 + Math.floor(deterministicRandom() * 3)}),
                        });
                    }

                    // 3. Spoof WebGL Renderer (High Impact)
                    const getParameterProxy = WebGLRenderingContext.prototype.getParameter;
                    WebGLRenderingContext.prototype.getParameter = function(parameter) {
                        // 37445: UNMASKED_VENDOR_WEBGL
                        // 37446: UNMASKED_RENDERER_WEBGL
                        if (parameter === 37445) return '${profile.vendor}';
                        if (parameter === 37446) return '${profile.renderer}';
                        return getParameterProxy.apply(this, arguments);
                    };

                    // 4. Inject benign noise
                    window['_canvas_noise_${randomArtifact}'] = '${randomArtifact}';

                    if (window === window.top) {
                        console.log("[ProxyClient] Privacy protection layer active: ${profile.renderer}");

                        // PostMessage responder for authIndex requests from cross-origin iframes
                        // Injected via addInitScript so it's ready BEFORE any iframe loads (no race condition)
                        window.addEventListener('message', function(event) {
                            if (event.data && event.data.type === 'requestAuthIndex') {
                                console.log('[BrowserManager] Received authIndex request, responding with: ${authIndex}');
                                event.source.postMessage({
                                    type: 'authIndexResponse',
                                    authIndex: ${authIndex},
                                    contextGeneration: ${JSON.stringify(contextGeneration)}
                                }, '*');
                            }
                        });
                    }
                } catch (err) {
                    console.error("[ProxyClient] Failed to inject privacy script", err);
                }
            })();
        `;
    }

    /**
     * Feature: Natural Mouse Movement
     * Simulates human-like mouse jitters instead of instant teleportation
     */
    async _simulateHumanMovement(page, targetX, targetY) {
        try {
            // Split movement into 3 segments with random deviations
            const steps = 3;
            for (let i = 1; i <= steps; i++) {
                const intermediateX = targetX + (Math.random() - 0.5) * (100 / i);
                const intermediateY = targetY + (Math.random() - 0.5) * (100 / i);

                // Final step must be precise
                const destX = i === steps ? targetX : intermediateX;
                const destY = i === steps ? targetY : intermediateY;

                await page.mouse.move(destX, destY, {
                    steps: 5 + Math.floor(Math.random() * 5), // Optimized speed (was 10-20)
                });
            }
        } catch (e) {
            // Ignore movement errors if page is closed
        }
    }

    /**
     * Feature: Smart "Code" Button Clicking
     * Tries multiple selectors (Code, Develop, Edit, Icons) to be robust against UI changes.
     */
    // async _smartClickCode(page) {
    //     const selectors = [
    //         // Priority 1: Exact text match (Fastest)
    //         'button:text("Code")',
    //         // Priority 2: Alternative texts used by Google
    //         'button:text("Develop")',
    //         'button:text("Edit")',
    //         // Priority 3: Fuzzy attribute matching
    //         'button[aria-label*="Code"]',
    //         'button[aria-label*="code"]',
    //         // Priority 4: Icon based
    //         'button mat-icon:text("code")',
    //         'button span:has-text("Code")',
    //     ];
    //
    //     this.logger.info('[Browser] Trying to locate "Code" entry point using smart selectors...');
    //
    //     for (const selector of selectors) {
    //         try {
    //             // Use a short timeout for quick fail-over
    //             const element = page.locator(selector).first();
    //             if (await element.isVisible({ timeout: 2000 })) {
    //                 this.logger.info(`[Browser] ✅ Smart match: "${selector}", clicking...`);
    //                 // Direct click with force as per new logic
    //                 await element.click({ force: true, timeout: 10000 });
    //                 return true;
    //             }
    //         } catch (e) {
    //             // Ignore timeout for single selector, try next
    //         }
    //     }
    //
    //     throw new Error('Unable to find "Code" button or alternatives (Smart Click Failed)');
    // }

    async _installHostedClient(context, authIndex, contextGeneration) {
        const source = await fs.promises.readFile(
            path.join(__dirname, "..", "..", "scripts", "client", "build.js"),
            "utf8"
        );
        // The Build App bundle lives on Google, so editing local client files alone
        // cannot update it. Serve the matching local client only to this browser
        // context; the hosted app and other scripts remain untouched.
        const bootstrap = `
            if (!window.chrome) window.chrome = {};
            window.chrome._contextId = ${JSON.stringify(authIndex)};
            window.chrome._contextGeneration = ${JSON.stringify(contextGeneration)};
            window.__authIndexReady = Promise.resolve(${JSON.stringify(authIndex)});
        `;
        await context.route("https://ais-*.run.app/assets/index-*.js", async route => {
            if (route.request().resourceType() !== "script") return route.continue();
            await route.fulfill({ body: bootstrap + source, contentType: "application/javascript", status: 200 });
        });
    }

    /**
     * Helper: Load and configure build.js script content
     * Applies environment-specific configurations (TARGET_DOMAIN, LOG_LEVEL)
     * @returns {string} Configured build.js script content
     */
    // _loadAndConfigureBuildScript() {
    //     let buildScriptContent = fs.readFileSync(
    //         path.join(__dirname, "..", "..", "scripts", "client", "build.js"),
    //         "utf-8"
    //     );
    //
    //     if (process.env.TARGET_DOMAIN) {
    //         const lines = buildScriptContent.split("\n");
    //         let domainReplaced = false;
    //         for (let i = 0; i < lines.length; i++) {
    //             if (lines[i].includes("this.targetDomain =")) {
    //                 this.logger.info(`[Config] Found targetDomain line: ${lines[i]}`);
    //                 lines[i] = `        this.targetDomain = "${process.env.TARGET_DOMAIN}";`;
    //                 this.logger.info(`[Config] Replaced with: ${lines[i]}`);
    //                 domainReplaced = true;
    //                 break;
    //             }
    //         }
    //         if (domainReplaced) {
    //             buildScriptContent = lines.join("\n");
    //         } else {
    //             this.logger.warn("[Config] Failed to find targetDomain line in build.js, ignoring.");
    //         }
    //     }
    //
    //     if (process.env.WS_PORT) {
    //         // WS_PORT environment variable is no longer supported
    //         this.logger.error(
    //             `[Config] ❌ WS_PORT environment variable is deprecated and no longer supported. ` +
    //                 `The WebSocket port is now fixed at 9998. Please remove WS_PORT from your .env file.`
    //         );
    //         // Do not modify the default WS_PORT - keep it at 9998
    //     }
    //
    //     // Inject LOG_LEVEL configuration into build.js
    //     // Read from LoggingService.currentLevel instead of environment variable
    //     // This ensures runtime log level changes are respected when browser restarts
    //     const LoggingService = require("../utils/LoggingService");
    //     const currentLogLevel = LoggingService.currentLevel; // 0=DEBUG, 1=INFO, 2=WARN, 3=ERROR
    //     const currentLogLevelName = LoggingService.getLevel(); // "DEBUG", "INFO", etc.
    //
    //     if (currentLogLevel !== 1) {
    //         const lines = buildScriptContent.split("\n");
    //         let levelReplaced = false;
    //         for (let i = 0; i < lines.length; i++) {
    //             // Match "currentLevel: <number>," pattern, ignoring comments
    //             // This is more robust than looking for specific comments like "// Default: INFO"
    //             if (/^\s*currentLevel:\s*\d+/.test(lines[i])) {
    //                 this.logger.info(`[Config] Found LOG_LEVEL config line: ${lines[i]}`);
    //                 lines[i] = `    currentLevel: ${currentLogLevel}, // Injected: ${currentLogLevelName}`;
    //                 this.logger.info(`[Config] Replaced with: ${lines[i]}`);
    //                 levelReplaced = true;
    //                 break;
    //             }
    //         }
    //         if (levelReplaced) {
    //             buildScriptContent = lines.join("\n");
    //         } else {
    //             this.logger.warn("[Config] Failed to find LOG_LEVEL config line in build.js, using default INFO.");
    //         }
    //     }
    //
    //     return buildScriptContent;
    // }

    /**
     * Activate a context as the current one: update legacy references, reset wakeup state,
     * and start background services (health monitor + wakeup + active trigger).
     * @param {object} ctx - The browser context object
     * @param {object} pg - The page object
     * @param {number} authIndex - The auth index being activated
     */
    _activateContext(ctx, pg, authIndex) {
        this.context = ctx;
        this.page = pg;
        this._currentAuthIndex = authIndex;
        this.noButtonCount = 0;
        this._startHealthMonitor(authIndex);
        this._startBackgroundWakeup(authIndex);
        this._sendActiveTrigger("[Browser]", pg);
    }

    /**
     * Helper: Send active trigger
     * Sends a trigger request to wake up Google backend
     * This is a fire-and-forget operation - we don't wait for the trigger request to complete
     * @param {string} logPrefix - Log prefix for step messages (e.g., "[Browser]" or "[Reconnect]")
     * @param {Page} page - The page object to use (defaults to this.page if not provided)
     */
    _sendActiveTrigger(logPrefix = "[Browser]", page = null) {
        // Active Trigger (Hack to wake up Google Backend)
        this.logger.info(`${logPrefix} ⚡ Sending active trigger request to Launch flow...`);

        // Use provided page or fall back to this.page
        const targetPage = page || this.page;

        // Fire-and-forget: send trigger request in background without waiting
        targetPage
            .evaluate(async () => {
                try {
                    await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=ActiveTrigger", {
                        headers: { "Content-Type": "application/json" },
                        method: "GET",
                    });
                } catch (e) {
                    console.log("[ProxyClient] Active trigger sent");
                }
            })
            .catch(() => {
                // Silently ignore errors - this is a best-effort trigger
            });
    }

    /**
     * Helper: Navigate to target page and wake up the page
     * Contains the common navigation and page activation logic
     * @param {Page} page - The page object to navigate
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     */
    async _navigateAndWakeUpPage(page, logPrefix = "[Browser]") {
        this.logger.debug(`${logPrefix} Navigating to target page...`);

        await page.goto(this.targetUrl, {
            timeout: 180000,
            waitUntil: "domcontentloaded",
        });
        this.logger.debug(`${logPrefix} Page loaded.`);

        // Wait for page to stabilize
        await page.waitForTimeout(2000 + Math.random() * 1000);
    }

    /**
     * Helper: Verify navigation to correct page and retry if needed
     * Throws error on failure, which will be caught by the caller's try-catch block
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     * @throws {Error} If navigation fails after retry
     */
    // async _verifyAndRetryNavigation(logPrefix = "[Browser]") {
    //     let currentUrl = this.page.url();
    //
    //     if (!currentUrl.includes(this.expectedAppId)) {
    //         this.logger.warn(`${logPrefix} ⚠️ Page redirected to: ${currentUrl}`);
    //         this.logger.info(`${logPrefix} Expected app ID: ${this.expectedAppId}`);
    //         this.logger.info(`${logPrefix} Attempting to navigate again...`);
    //
    //         // Reset WebSocket initialization flags before re-navigation
    //         this._wsInitSuccess = false;
    //         this._wsInitFailed = false;
    //
    //         // Wait a bit before retrying
    //         await this.page.waitForTimeout(2000);
    //
    //         // Try navigating again
    //         await this.page.goto(this.targetUrl, {
    //             timeout: 180000,
    //             waitUntil: "domcontentloaded",
    //         });
    //         await this.page.waitForTimeout(2000);
    //
    //         // Check URL again
    //         currentUrl = this.page.url();
    //         if (!currentUrl.includes(this.expectedAppId)) {
    //             this.logger.error(`${logPrefix} ❌ Still on wrong page after retry: ${currentUrl}`);
    //             throw new Error(
    //                 `Failed to navigate to correct page. Current URL: ${currentUrl}, Expected app ID: ${this.expectedAppId}`
    //             );
    //         } else {
    //             this.logger.info(`${logPrefix} ✅ Successfully navigated to correct page on retry: ${currentUrl}`);
    //         }
    //     } else {
    //         this.logger.info(`${logPrefix} ✅ Confirmed on correct page: ${currentUrl}`);
    //     }
    // }

    /**
     * Helper: Check page status and detect various error conditions
     * Detects: cookie expiration, region restrictions, 403 errors, page load failures
     * @param {Page} page - The page object to check
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     * @param {number} authIndex - The auth index being checked (default: -1). A confirmed login redirect marks it expired.
     * @throws {Error} If any error condition is detected
     */
    async _checkPageStatusAndErrors(page, logPrefix = "[Browser]", authIndex = -1, token = null) {
        let { currentUrl, pageTitle } = await this._readPageIdentity(page, logPrefix);
        this._assertInitialization(token);

        this.logger.debug(`${logPrefix} [Diagnostic] URL: ${currentUrl}`);
        this.logger.debug(`${logPrefix} [Diagnostic] Title: "${pageTitle}"`);

        // Check for various error conditions
        if (this._isLoginPage(currentUrl, pageTitle)) {
            const confirmed = await this._confirmLoginRequired(page, logPrefix);
            this._assertInitialization(token);
            if (!confirmed) {
                ({ currentUrl, pageTitle } = await this._readPageIdentity(page, logPrefix));
            } else {
                // Mark auth as expired if authIndex is provided
                if (authIndex >= 0 && this.authSource) {
                    await this._markAccountExpired(authIndex);
                }
                throw new AuthExpiredError();
            }
        }

        if (pageTitle.includes("Available regions") || pageTitle.includes("not available")) {
            throw new Error(
                "🚨 The current IP does not support access to Google AI Studio. Please change the IP and restart!"
            );
        }

        if (pageTitle.includes("403") || pageTitle.includes("Forbidden")) {
            throw new Error("🚨 403 Forbidden: Current IP reputation too low, access denied by Google risk control.");
        }

        if (currentUrl === "about:blank") {
            throw new Error("🚨 Page load failed (about:blank), possibly network timeout or browser crash.");
        }
    }

    async _readPageIdentity(page, logPrefix) {
        const currentUrl = page.url();
        let pageTitle = "";
        try {
            pageTitle = await this._bounded(
                () => page.title(),
                this._cleanupTimeoutMs || CONTEXT_CLEANUP_TIMEOUT_MS,
                `${logPrefix} read page title`
            );
        } catch (error) {
            this.logger.warn(`${logPrefix} Unable to get page title: ${error.message}`);
        }
        return { currentUrl, pageTitle };
    }

    _isLoginPage(currentUrl, pageTitle) {
        let googleLoginHost = false;
        try {
            googleLoginHost = new URL(currentUrl).hostname === "accounts.google.com";
        } catch (_error) {
            // A failed/blank navigation is handled by the caller, not treated as expired credentials.
        }
        return (
            googleLoginHost ||
            currentUrl.includes("ServiceLogin") ||
            pageTitle.includes("Sign in") ||
            pageTitle.includes("登录")
        );
    }

    async _confirmLoginRequired(page, logPrefix) {
        const owner = [...(this.contexts?.entries() || [])].find(([, entry]) => entry.page === page)?.[0];
        if (owner !== undefined && this._hasActiveQueueForAuth(owner)) return false;
        await page.waitForTimeout(LOGIN_CONFIRM_WAIT_MS);
        let identity = await this._readPageIdentity(page, logPrefix);
        if (!this._isLoginPage(identity.currentUrl, identity.pageTitle)) return false;

        // A single redirect can be part of a normal sign-in handshake. Retry the app once
        // before persisting an Expired flag; a network failure is not proof of expired auth.
        if (owner !== undefined && this._hasActiveQueueForAuth(owner)) return false;
        await page.goto(this.targetUrl, { timeout: 45000, waitUntil: "domcontentloaded" });
        await page.waitForTimeout(LOGIN_CONFIRM_WAIT_MS);
        identity = await this._readPageIdentity(page, logPrefix);
        return this._isLoginPage(identity.currentUrl, identity.pageTitle);
    }

    async _recheckNextExpiredAccount() {
        if (this._expiredRecheckTask) return;
        const candidates = [
            ...new Set([
                ...(this.authSource.expiredIndices || []),
                ...this.authSource.availableIndices.filter(
                    index => this.authSource.health?.getStatus(index)?.mode === "reauth"
                ),
            ]),
        ]
            .filter(index => !this.authSource.pendingRefreshIndices?.has(index))
            .sort((a, b) => a - b);
        if (candidates.length === 0) return;
        const now = Date.now();
        for (let offset = 0; offset < candidates.length; offset++) {
            const position = (this._expiredRecheckCursor + offset) % candidates.length;
            const authIndex = candidates[position];
            if ((this._expiredRecheckDueAt.get(authIndex) || 0) > now) continue;
            this._expiredRecheckCursor = (position + 1) % candidates.length;
            await this.recheckExpiredAccount(authIndex);
            return;
        }
    }

    async withAccountTestConnection(authIndex, callback, { signal, timeoutMs = 90000, requestId } = {}) {
        this._ensurePoolState();
        if (this._accountTestReservations.has(authIndex))
            throw Object.assign(new Error("busy"), { reason: "busy", status: 409 });
        const reservation = {};
        this._accountTestReservations.set(authIndex, reservation);
        try {
            return await this._withAccountTestConnection(authIndex, callback, { requestId, signal, timeoutMs });
        } finally {
            if (this._accountTestReservations.get(authIndex) === reservation)
                this._accountTestReservations.delete(authIndex);
            // Commit test health first, then let the pool act on the resulting switch.
            setImmediate(() => this.notifyAccountIdle(authIndex));
        }
    }

    async _withAccountTestConnection(authIndex, callback, { signal, timeoutMs, requestId }) {
        if (this.isAccountReady(authIndex)) return callback();
        const fail = (reason, status = 409) => Object.assign(new Error(reason), { reason, status });
        const manual = () => this.authSource.health.isManualProbe?.(authIndex, requestId);
        const eligible = () =>
            this.authSource.getRotationIndices().includes(authIndex) ||
            (manual() && (this.authSource.rotationIndices || []).includes(authIndex));
        const entry = this.contexts.get(authIndex);
        if (
            manual() &&
            entry?.page &&
            !entry.page.isClosed() &&
            !this.initializingContexts.has(authIndex) &&
            !this.pendingContextClosures.has(authIndex) &&
            !this._transportFailedAccounts?.has(authIndex) &&
            this.connectionRegistry.isAccountConnected(authIndex)
        )
            return callback();
        if (manual() && entry && !this.initializingContexts.has(authIndex) && !this._hasActiveQueueForAuth(authIndex))
            await this.closeContext(authIndex);
        if (
            this._accountTestConnection ||
            this._expiredRecheckTask ||
            this._isSystemBusy() ||
            this.contexts.has(authIndex) ||
            this.initializingContexts.has(authIndex) ||
            this._hasActiveQueueForAuth(authIndex) ||
            this.authSource.pendingRefreshIndices?.has(authIndex)
        )
            throw fail("busy");
        if (!eligible()) throw fail("excluded");
        const test = { authIndex, cancelled: false, generation: randomUUID() };
        this._accountTestConnection = test;
        let context,
            page,
            reusable = false;
        const deadline = Date.now() + timeoutMs;
        let rejectAbort;
        const aborted = new Promise((_, reject) => {
            rejectAbort = reject;
        });
        aborted.catch(() => {});
        const abort = () => {
            test.cancelled = true;
            rejectAbort(fail("cancelled", 499));
            context?.close().catch(() => {});
        };
        signal?.addEventListener("abort", abort, { once: true });
        const step = async operation => {
            if (signal?.aborted || test.cancelled) throw fail("cancelled", 499);
            if (!eligible()) throw fail("excluded");
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw fail("startup_timeout", 504);
            try {
                const result = await Promise.race([
                    this._bounded(operation, remaining, `Account test #${authIndex}`),
                    aborted,
                ]);
                if (signal?.aborted || test.cancelled) throw fail("cancelled", 499);
                return result;
            } catch (error) {
                if (Date.now() >= deadline) throw fail("startup_timeout", 504);
                throw error;
            }
        };
        try {
            await step(() => this._ensureBrowser());
            // One temporary diagnostic context, separate from the serving pool.
            if (
                this.config.maxContexts > 0 &&
                this.contexts.size + this.initializingContexts.size > this.config.maxContexts
            )
                throw fail("busy");
            const savedAuth = this.authSource.getAuth(authIndex);
            if (!savedAuth) throw fail("invalid", 404);
            const stickyProxy = this.stickyProxyManager.getProxyForAuth(authIndex);
            const proxy = stickyProxy?.proxy || parseProxyConfig(this.config.proxyUrl, this.config.proxyBypass);
            context = await step(async () => {
                const created = await this.browser.newContext({
                    deviceScaleFactor: 1,
                    storageState: savedAuth,
                    viewport: { height: 1080, width: 1920 },
                    ...(proxy ? { proxy } : {}),
                });
                if (test.cancelled || Date.now() >= deadline) {
                    created.close().catch(() => {});
                    throw fail("cancelled", 499);
                }
                context = created;
                return created;
            });
            await step(() => context.addInitScript(this._getPrivacyProtectionScript(authIndex, test.generation)));
            await step(() => this._installHostedClient(context, authIndex, test.generation));
            page = await step(() => context.newPage());
            const previewAuth = { status: null };
            page.on("response", response => {
                if (
                    response
                        .url()
                        .includes(
                            "/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateAccessToken"
                        )
                ) {
                    previewAuth.status = response.status();
                    if (previewAuth.status >= 400)
                        this.logger.warn(
                            `[AccountTest#${authIndex}] Google Preview GenerateAccessToken returned HTTP ${previewAuth.status}`
                        );
                }
            });
            page.on("console", message => {
                if (test.cancelled) return;
                const text = message.text();
                if (text.includes("[ProxyClient]"))
                    this.logger.info(`[AccountTest#${authIndex}] ${text.replace("[ProxyClient] ", "")}`);
            });
            await step(() => this._navigateAndWakeUpPage(page, `[AccountTest#${authIndex}]`));
            await step(() => this._checkPageStatusAndErrors(page, `[AccountTest#${authIndex}]`, authIndex));
            const ready = await step(() =>
                this._waitForWebSocketInit(
                    page,
                    `[AccountTest#${authIndex}]`,
                    Math.max(1, deadline - Date.now()),
                    authIndex,
                    false
                )
            );
            if (!ready || !this.connectionRegistry.isAccountConnected(authIndex)) throw fail("not_connected", 503);
            // A socket can open before Google's parent page permits Preview API calls.
            // Match normal activation and keep handling Launch while the iframe settles.
            this._sendActiveTrigger(`[AccountTest#${authIndex}]`, page);
            // AI Studio may replace its preview iframe just after the first socket opens.
            // Wait for the same socket to remain connected before dispatching a real test.
            let connection = this.connectionRegistry.getConnectionByAuth(authIndex, false);
            let stableSince = Date.now();
            // Cover one complete client reconnect interval (5s), including iframe replacement.
            const settleMs = this._accountTestSettleMs ?? 6000;
            let nextWakeupAt = 0;
            while (Date.now() - stableSince < settleMs) {
                if (Date.now() >= nextWakeupAt) {
                    const launched = await step(() =>
                        this._clickLaunchButtonIfVisible(page, `[AccountTest#${authIndex}]`)
                    );
                    if (launched) stableSince = Date.now();
                    nextWakeupAt = Date.now() + 1000;
                }
                await step(() => page.waitForTimeout(100));
                const next = this.connectionRegistry.getConnectionByAuth(authIndex, false);
                if (next !== connection || !this.connectionRegistry.isAccountConnected(authIndex)) {
                    connection = next;
                    stableSince = Date.now();
                }
            }
            if (!connection || !this.connectionRegistry.isAccountConnected(authIndex)) throw fail("not_connected", 503);
            // An auxiliary authorization error alone must not refuse a working model call.
            try {
                const result = await callback({ previewAuth, temporary: true });
                reusable = true;
                return result;
            } catch (error) {
                // An actual upstream rejection still proves the browser transport works.
                reusable = error.upstreamStatusCode >= 400 && !error.transportFailure;
                throw error;
            }
        } finally {
            signal?.removeEventListener("abort", abort);
            const retain =
                reusable &&
                !test.cancelled &&
                !signal?.aborted &&
                !this.isClosingIntentionally &&
                page &&
                !page.isClosed() &&
                this.connectionRegistry.isAccountConnected(authIndex) &&
                !this.authSource.isExpired(authIndex) &&
                this.authSource.health.getStatus(authIndex).mode !== "reauth" &&
                eligible() &&
                !this.contexts.has(authIndex) &&
                (!this.config.maxContexts ||
                    this.contexts.size + this.initializingContexts.size < this.config.maxContexts);
            if (retain) {
                this._initializationTokens.delete(authIndex);
                this.contexts.set(authIndex, {
                    context,
                    generation: test.generation,
                    healthMonitorInterval: null,
                    page,
                });
                this._runtime(authIndex, "ready", null);
                this._startHealthMonitor(authIndex);
                this._startBackgroundWakeup(authIndex);
            } else {
                test.cancelled = true;
                if (context) await this._cleanupOperation(() => context.close(), `Close account test #${authIndex}`);
                this.connectionRegistry.closeConnectionByAuth(authIndex);
                this._wsInitState.delete(authIndex);
                this._runtime(authIndex, "standby", "not_loaded");
            }
            if (this._accountTestConnection === test) this._accountTestConnection = null;
        }
    }

    async recheckExpiredAccount(authIndex) {
        if (!Number.isInteger(authIndex) || !this.authSource.availableIndices.includes(authIndex)) {
            return { reason: "unavailable", recovered: false };
        }
        if (this.authSource.pendingRefreshIndices?.has(authIndex)) {
            return { reason: "busy", recovered: false };
        }
        if (!this.authSource.isExpired(authIndex) && this.authSource.health?.getStatus(authIndex)?.mode !== "reauth") {
            return { reason: "not_expired", recovered: false };
        }
        if (this._expiredRecheckTask || this._accountTestConnection) return { reason: "busy", recovered: false };
        this._expiredRecheckAborted = false;
        this._expiredRecheckIndex = authIndex;
        const task = this._runExpiredRecheck(authIndex).then(async result => {
            if (!result.refreshContext) return result;
            try {
                const refresh = await this.refreshContextAfterReauth(authIndex, { deferActivation: true });
                return { ...result, activateAfterRecheck: refresh.activateAfterRecheck };
            } catch (error) {
                this.logger.warn(
                    `[Auth Recheck] Verified auth #${authIndex}, but context refresh is pending: ${error.message}`
                );
                if (this.contexts.has(authIndex)) this.pendingContextClosures.set(authIndex, "reauth");
                else this.resumeAuthUpdates(authIndex);
                return result;
            }
        });
        this._expiredRecheckTask = task;
        let result;
        try {
            result = await task;
            if (result.reason === "recovered") {
                this._expiredRecheckDueAt.delete(authIndex);
                this._expiredRecheckFailures.delete(authIndex);
            } else if (result.reason === "needs_login" || result.reason === "unavailable") {
                const failures = (this._expiredRecheckFailures.get(authIndex) || 0) + 1;
                this._expiredRecheckFailures.set(authIndex, failures);
                this._expiredRecheckDueAt.set(
                    authIndex,
                    Date.now() +
                        Math.min(
                            EXPIRED_RECHECK_INTERVAL_MS * 2 ** Math.min(failures - 1, 5),
                            EXPIRED_RECHECK_MAX_BACKOFF_MS
                        )
                );
            }
        } finally {
            if (this._expiredRecheckTask === task) this._expiredRecheckTask = null;
            if (this._expiredRecheckIndex === authIndex) this._expiredRecheckIndex = null;
        }
        if (
            result.recovered &&
            !this._expiredRecheckAborted &&
            (result.activateAfterRecheck || (this._currentAuthIndex < 0 && this.contexts.size === 0)) &&
            !this._isSystemBusy() &&
            this.authSource.getRotationIndices().includes(authIndex)
        ) {
            // The probe has released its temporary context and cleared its task.
            // Start a service context so recovery from an all-expired startup becomes ready.
            this.launchOrSwitchContext(authIndex).catch(error => {
                this.logger.warn(`[Auth Recheck] Could not activate recovered auth #${authIndex}: ${error.message}`);
            });
        }
        return { reason: result.reason, recovered: result.recovered };
    }

    async _runExpiredRecheck(authIndex) {
        if (this.initializingContexts.has(authIndex) || this._hasActiveQueueForAuth(authIndex)) {
            return { reason: "busy", recovered: false };
        }

        let originalContent;
        let savedAuth;
        let expectedAccountName;
        try {
            const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${authIndex}.json`);
            originalContent = await fs.promises.readFile(authFilePath, "utf-8");
            savedAuth = JSON.parse(originalContent);
            expectedAccountName =
                typeof savedAuth.accountName === "string" ? savedAuth.accountName.trim().toLowerCase() : null;
            if (!expectedAccountName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedAccountName)) {
                return { reason: "unavailable", recovered: false };
            }
        } catch (error) {
            this.logger.warn(`[Auth Recheck] Auth #${authIndex} could not be read: ${error.message}`);
            return { reason: "unavailable", recovered: false };
        }

        // Never evict a loaded context for this background check: a new request could
        // start on it after the idle check. Use one temporary context in the same
        // browser, then close it before the check completes.

        let context = null;
        let probeBrowser = null;
        let launchedBrowser = false;
        let writeSuspended = false;
        let committedHealthReauth = false;
        this._recheckConnectionGenerations ||= new Map();
        const contextGeneration = randomUUID();
        this._recheckConnectionGenerations.set(authIndex, contextGeneration);
        try {
            if (
                (!this.authSource.isExpired(authIndex) &&
                    this.authSource.health?.getStatus(authIndex)?.mode !== "reauth") ||
                this._expiredRecheckAborted
            ) {
                return { reason: "busy", recovered: false };
            }
            // A probe shares the browser process, but its page and WebSocket must not
            // overlap a request or context initialization for the same account.
            if (
                this.initializingContexts.has(authIndex) ||
                this._hasActiveQueueForAuth(authIndex) ||
                this.isClosingIntentionally ||
                (!this.browser &&
                    (this._isSystemBusy() || this.initializingContexts.size > 0 || this._backgroundPreloadTask))
            ) {
                return { reason: "busy", recovered: false };
            }
            if (!this.browser) {
                await this._ensureBrowser();
                launchedBrowser = true;
            }
            probeBrowser = this.browser;
            // Allow at most one temporary probe beyond the configured service pool.
            // A switch may already have overflowed the pool while requests drain.
            if (
                this.config.maxContexts > 0 &&
                this.contexts.size + this.initializingContexts.size > this.config.maxContexts
            ) {
                return { reason: "busy", recovered: false };
            }
            const stickyProxy = this.stickyProxyManager.getProxyForAuth(authIndex);
            const proxyConfig = stickyProxy
                ? stickyProxy.proxy
                : parseProxyConfig(this.config.proxyUrl, this.config.proxyBypass);
            this._expiredRecheckBrowser = probeBrowser;
            context = await probeBrowser.newContext({
                storageState: savedAuth,
                ...(proxyConfig ? { proxy: proxyConfig } : {}),
            });
            this._expiredRecheckContext = context;
            if (this._expiredRecheckAborted) return { reason: "busy", recovered: false };

            await context.addInitScript(this._getPrivacyProtectionScript(authIndex, contextGeneration));
            if (context.route) await this._installHostedClient(context, authIndex, contextGeneration);

            const page = await context.newPage();
            const wsState = { failed: false, success: false };
            page.on("console", msg => {
                const message = msg.text();
                if (message.includes("Connection successful")) wsState.success = true;
                if (message.includes("WebSocket initialization failed")) wsState.failed = true;
            });
            await this._navigateAndWakeUpPage(page, `[Auth Recheck#${authIndex}]`);
            await this._checkPageStatusAndErrors(page, `[Auth Recheck#${authIndex}]`);
            if (this._expiredRecheckAborted) return { reason: "busy", recovered: false };

            // Verify the same readiness signal used by normal context initialization.
            // Merely not being on a login page is insufficient to restore an account.
            const previousWsState = this._wsInitState.get(authIndex);
            this._wsInitState.set(authIndex, wsState);
            let ready;
            try {
                ready = await this._waitForWebSocketInit(
                    page,
                    `[Auth Recheck#${authIndex}]`,
                    EXPIRED_RECHECK_WS_TIMEOUT_MS,
                    authIndex,
                    false
                );
            } finally {
                if (previousWsState) this._wsInitState.set(authIndex, previousWsState);
                else this._wsInitState.delete(authIndex);
            }
            if (!ready || this._expiredRecheckAborted) return { reason: "unavailable", recovered: false };
            await this._checkPageStatusAndErrors(page, `[Auth Recheck#${authIndex}]`);
            const pageUrl = new URL(page.url());
            if (!(
                ["ai.studio", "aistudio.google.com"].includes(pageUrl.hostname) &&
                (pageUrl.pathname === "/apps" || pageUrl.pathname.startsWith("/apps/"))
            )) {
                return { reason: "unavailable", recovered: false };
            }

            // The generic apps page exposes Google's selected account in its account
            // switcher. Check identity there after the target app has proved readiness.
            await page.goto(AUTH_IDENTITY_URL, { timeout: 30000, waitUntil: "domcontentloaded" });
            await page.waitForTimeout(1000);
            const identity = await this._readPageIdentity(page, `[Auth Recheck#${authIndex}]`);
            let identityUrl;
            try {
                identityUrl = new URL(identity.currentUrl);
            } catch (_error) {
                return { reason: "unavailable", recovered: false };
            }
            if (
                this._isLoginPage(identity.currentUrl, identity.pageTitle) ||
                !["ai.studio", "aistudio.google.com"].includes(identityUrl.hostname) ||
                !["/apps", "/apps/"].includes(identityUrl.pathname)
            ) {
                return { reason: "unavailable", recovered: false };
            }
            const detectedAccount = await detectAccountEmail(page);
            if (detectedAccount !== expectedAccountName) {
                this.logger.warn(
                    `[Auth Recheck] Auth #${authIndex} identity could not be confirmed; keeping it excluded.`
                );
                return { reason: "unavailable", recovered: false };
            }
            const storageState = await this._captureStorageState(context);
            if (this._expiredRecheckAborted) return { reason: "busy", recovered: false };
            const healthOnlyReauth = !this.authSource.isExpired(authIndex);
            if (healthOnlyReauth) {
                writeSuspended = true;
                await this.suspendAuthUpdates(authIndex, { keepRecheckRunning: true });
                if (this._expiredRecheckAborted) return { reason: "busy", recovered: false };
            }
            const restored = await this.authSource.unmarkAsExpired(authIndex, {
                allowHealthReauth: true,
                expectedContent: originalContent,
                storageState,
            });
            if (!restored) return { reason: "unavailable", recovered: false };
            committedHealthReauth = healthOnlyReauth;
            const healthMode = this.authSource.health?.getStatus(authIndex)?.mode;
            if (healthMode && healthMode !== "disabled" && healthMode !== "active") {
                this.authSource.health.reset(authIndex);
            }
            this.logger.info(`[Auth Recheck] Auth #${authIndex} recovered and returned to rotation.`);
            return { reason: "recovered", recovered: true, refreshContext: healthOnlyReauth };
        } catch (error) {
            if (isAuthExpiredError(error)) {
                if (this._expiredRecheckAborted) return { reason: "busy", recovered: false };
                const marked = this.authSource.isExpired(authIndex) || (await this._markAccountExpired(authIndex));
                return { reason: marked ? "needs_login" : "unavailable", recovered: false };
            }
            if (!this._expiredRecheckAborted) {
                this.logger.warn(`[Auth Recheck] Auth #${authIndex} could not be verified: ${error.message}`);
            }
            return { reason: this._expiredRecheckAborted ? "busy" : "unavailable", recovered: false };
        } finally {
            if (writeSuspended && !committedHealthReauth) this.resumeAuthUpdates(authIndex);
            this._expiredRecheckContext = null;
            if (this._recheckConnectionGenerations.get(authIndex) === contextGeneration)
                this._recheckConnectionGenerations.delete(authIndex);
            if (context) await this._cleanupOperation(() => context.close(), `Close credential recheck #${authIndex}`);
            if (this._expiredRecheckBrowser === probeBrowser) this._expiredRecheckBrowser = null;
            const closeWhenIdle = launchedBrowser || this._recheckBrowserOrphaned;
            this._recheckBrowserOrphaned = false;
            if (
                closeWhenIdle &&
                this.contexts.size === 0 &&
                this.initializingContexts.size === 0 &&
                this.browser === probeBrowser &&
                !this._isSystemBusy() &&
                !this._backgroundPreloadTask
            ) {
                await this.closeBrowser();
            } else if (!this._isSystemBusy() && !this.isClosingIntentionally && this.browser) {
                this.rebalanceContextPool().catch(error => {
                    this.logger.warn(`[Auth Recheck] Pool rebalance failed: ${error.message}`);
                });
            }
        }
    }

    async _stopExpiredRecheck() {
        if (!this._expiredRecheckTask) return;
        this._expiredRecheckAborted = true;
        if (this._expiredRecheckContext) {
            await this._cleanupOperation(() => this._expiredRecheckContext.close(), "Stop credential recheck");
        }
        await this._expiredRecheckTask.catch(() => {});
    }

    async refreshContextAfterReauth(authIndex, options = {}) {
        // Called after an atomic replacement of auth-{index}.json. The old browser context
        // must never save its stale state over the new credentials.
        this._authUpdateSuspended.add(authIndex);
        this.authSource.setPendingRefresh(authIndex, true);
        this._accountChangeNotifier?.(authIndex);
        if (this._hasActiveQueueForAuth(authIndex)) {
            this.pendingContextClosures.set(authIndex, "reauth");
            return { deferred: true };
        }
        const wasCurrent = authIndex === this._currentAuthIndex;
        try {
            if (this.contexts.has(authIndex)) await this.closeContext(authIndex);
        } catch (error) {
            this.logger.warn(`[Auth Recheck] Could not close stale context #${authIndex}: ${error.message}`);
            if (this.contexts.has(authIndex)) {
                this.pendingContextClosures.set(authIndex, "reauth");
                const retry = setTimeout(() => {
                    this._closePendingContextIfIdle(authIndex).catch(retryError => {
                        this.logger.warn(`[Auth Recheck] Deferred context refresh failed: ${retryError.message}`);
                    });
                }, 5000);
                retry.unref?.();
                return { deferred: true };
            }
        }
        this.resumeAuthUpdates(authIndex);
        if (wasCurrent && !this.authSource.isExpired(authIndex)) {
            if (!options.deferActivation) await this.launchOrSwitchContext(authIndex);
        } else if (!this._isSystemBusy() && this.browser) {
            await this.rebalanceContextPool();
        }
        return { activateAfterRecheck: options.deferActivation && wasCurrent, deferred: false };
    }

    /**
     * Feature: Background Health Monitor (The "Scavenger")
     * Periodically cleans up popups and keeps the session alive.
     * In multi-context mode, stores the interval in the context data.
     */
    _startHealthMonitor(authIndex = this._currentAuthIndex) {
        if (authIndex < 0) {
            this.logger.warn("[Browser] Cannot start health monitor: no active auth index");
            return;
        }

        // Get context data
        const contextData = this.contexts.get(authIndex);
        if (!contextData) {
            this.logger.warn(`[Browser] Cannot start health monitor: context #${authIndex} not found`);
            return;
        }

        if (contextData.healthMonitorInterval) return;

        this.logger.info(`[Context#${authIndex}] 🛡️ Background health monitor service (Scavenger) started...`);

        let tickCount = 0;

        // Run every 4 seconds
        contextData.healthMonitorInterval = setInterval(async () => {
            try {
                if (this.contexts.get(authIndex) !== contextData) {
                    clearInterval(contextData.healthMonitorInterval);
                    contextData.healthMonitorInterval = null;
                    return;
                }

                const page = contextData.page;
                // Double check page status
                if (!page || page.isClosed()) {
                    if (contextData.healthMonitorInterval) {
                        clearInterval(contextData.healthMonitorInterval);
                        contextData.healthMonitorInterval = null;
                        this.logger.info(`[HealthMonitor#${authIndex}] Page closed, stopped background task.`);
                    }
                    return;
                }

                // Buttons such as Reload/Continue can navigate the app. Leave pages
                // serving generation or cache maintenance untouched until they drain.
                if (this._hasActiveQueueForAuth(authIndex) || this._accountTestReservations?.has(authIndex)) return;

                tickCount++;

                try {
                    // 1. Keep-Alive: Random micro-actions (30% chance)
                    if (Math.random() < 0.3) {
                        try {
                            // Optimized randomness based on viewport
                            const vp = page.viewportSize() || { height: 1080, width: 1920 };

                            // Scroll
                            // eslint-disable-next-line no-undef
                            await page.evaluate(() => window.scrollBy(0, (Math.random() - 0.5) * 20));
                            // Human-like mouse jitter
                            const x = Math.floor(Math.random() * (vp.width * 0.8));
                            const y = Math.floor(Math.random() * (vp.height * 0.8));
                            await this._simulateHumanMovement(page, x, y);
                        } catch (e) {
                            /* empty */
                        }
                    }

                    // 2. Anti-Timeout: Move to top-left corner (1,1) every ~1 minute (15 ticks)
                    if (tickCount % 15 === 0) {
                        try {
                            await this._simulateHumanMovement(page, 1, 1);
                        } catch (e) {
                            /* empty */
                        }
                    }

                    // 3. Auto-Save Auth: Every ~24 hours (21600 ticks * 4s = 86400s)
                    if (tickCount % 21600 === 0) {
                        try {
                            this.logger.info(
                                `[HealthMonitor#${authIndex}] 💾 Triggering daily periodic auth file update...`
                            );
                            await this._updateAuthFile(authIndex);
                        } catch (e) {
                            this.logger.warn(`[HealthMonitor#${authIndex}] Auth update failed: ${e.message}`);
                        }
                    }

                    // 4. Popup & Overlay Cleanup
                    if (this._hasActiveQueueForAuth(authIndex)) return;
                    await page.evaluate(() => {
                        const blockers = [
                            "div.cdk-overlay-backdrop",
                            "div.cdk-overlay-container",
                            "div.cdk-global-overlay-wrapper",
                        ];

                        const targetTexts = [
                            "Reload",
                            "Retry",
                            "Got it",
                            "Dismiss",
                            "Not now",
                            "Continue to the app",
                            "Skip",
                        ];

                        // Remove passive blockers
                        blockers.forEach(selector => {
                            // eslint-disable-next-line no-undef
                            document.querySelectorAll(selector).forEach(el => el.remove());
                        });

                        // Click active buttons if visible
                        // eslint-disable-next-line no-undef
                        document.querySelectorAll("button").forEach(btn => {
                            // Check if the element occupies space (simple visibility check)
                            const rect = btn.getBoundingClientRect();
                            const isVisible = rect.width > 0 && rect.height > 0;

                            if (isVisible) {
                                const text = (btn.innerText || "").trim();
                                const ariaLabel = btn.getAttribute("aria-label");

                                // Match text or aria-label
                                if (targetTexts.includes(text) || ariaLabel === "Close") {
                                    console.log(`[ProxyClient] HealthMonitor clicking: ${text || "Close Button"}`);
                                    btn.click();
                                }
                            }
                        });
                    });
                } catch (err) {
                    // Silent catch to prevent log spamming on navigation
                }
            } catch (globalError) {
                // Catch any other unexpected errors in the interval
                this.logger.warn(`[HealthMonitor#${authIndex}] Detailed error: ${globalError.message}`);
                // If the page is definitely gone, stop the monitor
                if (globalError.message.includes("Target page, context or browser has been closed")) {
                    if (contextData.healthMonitorInterval) {
                        clearInterval(contextData.healthMonitorInterval);
                        contextData.healthMonitorInterval = null;
                        this.logger.info(
                            `[HealthMonitor#${authIndex}] Page closed (detected by error), stopped background task.`
                        );
                    }
                }
            }
        }, 4000);
    }

    /**
     * Helper: Save debug information (screenshot and HTML) to root directory
     * @param {string} suffix - Suffix for the debug file names
     * @param {number} [authIndex] - Optional auth index to get the correct page from contexts Map
     * @param {object} [explicitPage] - Optional explicit page object to use (for cases where page is not yet in contexts)
     */
    async _saveDebugArtifacts(suffix = "final", authIndex = null, explicitPage = null) {
        // Prioritize explicit page, then retrieve from contexts Map, finally fall back to this.page
        let targetPage = explicitPage;
        if (!targetPage) {
            targetPage = this.page;
            if (authIndex !== null && this.contexts.has(authIndex)) {
                const ctxData = this.contexts.get(authIndex);
                if (ctxData && ctxData.page) {
                    targetPage = ctxData.page;
                }
            }
        }
        if (!targetPage || targetPage.isClosed()) return;
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
            const screenshotPath = path.join(process.cwd(), `debug_screenshot_${suffix}_${timestamp}.png`);
            await this._bounded(
                () =>
                    targetPage.screenshot({
                        fullPage: true,
                        path: screenshotPath,
                        timeout: this._cleanupTimeoutMs || CONTEXT_CLEANUP_TIMEOUT_MS,
                    }),
                this._cleanupTimeoutMs || CONTEXT_CLEANUP_TIMEOUT_MS,
                "Save failure screenshot"
            );
            this.logger.info(`[Debug] Failure screenshot saved to: ${screenshotPath}`);

            const htmlPath = path.join(process.cwd(), `debug_page_source_${suffix}_${timestamp}.html`);
            const htmlContent = await this._bounded(
                () => targetPage.content(),
                this._cleanupTimeoutMs || CONTEXT_CLEANUP_TIMEOUT_MS,
                "Read failure page source"
            );
            fs.writeFileSync(htmlPath, htmlContent);
            this.logger.info(`[Debug] Failure page source saved to: ${htmlPath}`);
        } catch (e) {
            this.logger.error(`[Debug] Failed to save debug artifacts: ${e.message}`);
        }
    }

    /**
     * Feature: Background Wakeup & "Launch" Button Handler
     * Specifically handles the "Rocket/Launch" button which blocks model loading.
     * This service is bound to this.page (instance-level), not individual contexts.
     * Only one instance should run at a time, tracking the current active page.
     */
    async _startBackgroundWakeup(authIndex = this._currentAuthIndex) {
        const contextData = this.contexts.get(authIndex);
        if (!contextData || contextData.wakeupRunning) return;
        contextData.wakeupRunning = true;
        contextData.noButtonCount = 0;
        this.backgroundWakeupRunning = true;

        // Initial buffer - wait before starting the main loop to let page stabilize
        await new Promise(r => setTimeout(r, 1500));

        // Verify page is still valid after the initial delay
        try {
            if (this.contexts.get(authIndex) !== contextData || !contextData.page || contextData.page.isClosed()) {
                contextData.wakeupRunning = false;
                this.backgroundWakeupRunning = [...this.contexts.values()].some(entry => entry.wakeupRunning);
                this.logger.info(
                    "[Browser] BackgroundWakeup stopped: page became null or closed during startup delay."
                );
                return;
            }
        } catch (error) {
            contextData.wakeupRunning = false;
            this.backgroundWakeupRunning = [...this.contexts.values()].some(entry => entry.wakeupRunning);
            this.logger.warn(`[Browser] BackgroundWakeup stopped: error checking page status: ${error.message}`);
            return;
        }

        this.logger.info("[Browser] 🛡️ Background Wakeup Service (Rocket Handler) started...");

        while (this.contexts.get(authIndex) === contextData && contextData.page && !contextData.page.isClosed()) {
            try {
                const currentPage = contextData.page;
                if (this._hasActiveQueueForAuth(authIndex) || this._accountTestReservations?.has(authIndex)) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }

                // 1. Force page wake-up
                await currentPage.bringToFront().catch(() => {});

                // Micro-movements to trigger rendering frames in headless mode
                const vp = currentPage.viewportSize() || { height: 1080, width: 1920 };
                const moveX = Math.floor(Math.random() * (vp.width * 0.3));
                const moveY = Math.floor(Math.random() * (vp.height * 0.3));
                await this._simulateHumanMovement(currentPage, moveX, moveY);

                // 2. Intelligent Scan for "Launch" or "Rocket" button
                const targetInfo = await currentPage.evaluate(() => {
                    // Optimized precise check
                    try {
                        const preciseCandidates = Array.from(
                            // eslint-disable-next-line no-undef
                            document.querySelectorAll(".interaction-modal p, .interaction-modal button")
                        );
                        for (const el of preciseCandidates) {
                            if (/Launch|rocket_launch/i.test((el.innerText || "").trim())) {
                                const rect = el.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0) {
                                    return {
                                        found: true,
                                        tagName: el.tagName,
                                        text: (el.innerText || "").trim().substring(0, 15),
                                        x: rect.left + rect.width / 2,
                                        y: rect.top + rect.height / 2,
                                    };
                                }
                            }
                        }
                    } catch (e) {
                        /* empty */
                    }

                    const MIN_Y = 400;
                    const MAX_Y = 800;

                    const isValid = rect => rect.width > 0 && rect.height > 0 && rect.top > MIN_Y && rect.top < MAX_Y;

                    // eslint-disable-next-line no-undef
                    const candidates = Array.from(document.querySelectorAll("button, span, div, a, i"));

                    for (const el of candidates) {
                        const text = (el.innerText || "").trim();
                        // Match "Launch" or material icon "rocket_launch"
                        if (!/Launch|rocket_launch/i.test(text)) continue;

                        let targetEl = el;
                        let rect = targetEl.getBoundingClientRect();

                        // Recursive parent check (up to 3 levels)
                        let parentDepth = 0;
                        while (parentDepth < 3 && targetEl.parentElement) {
                            if (targetEl.tagName === "BUTTON" || targetEl.getAttribute("role") === "button") break;
                            const parent = targetEl.parentElement;
                            const pRect = parent.getBoundingClientRect();
                            if (isValid(pRect)) {
                                targetEl = parent;
                                rect = pRect;
                            }
                            parentDepth++;
                        }

                        if (isValid(rect)) {
                            return {
                                found: true,
                                tagName: targetEl.tagName,
                                text: text.substring(0, 15),
                                x: rect.left + rect.width / 2,
                                y: rect.top + rect.height / 2,
                            };
                        }
                    }
                    return { found: false };
                });

                // 3. Execute Click if found
                if (targetInfo.found && !this._hasActiveQueueForAuth(authIndex)) {
                    this.logger.info(`[Browser] 🎯 Found Rocket/Launch button [${targetInfo.tagName}], engaging...`);

                    // Physical Click
                    await currentPage.mouse.move(targetInfo.x, targetInfo.y, { steps: 5 });
                    await new Promise(r => setTimeout(r, 300));
                    await currentPage.mouse.down();
                    await new Promise(r => setTimeout(r, 400));
                    await currentPage.mouse.up();

                    this.logger.info(`[Browser] 🖱️ Physical click executed. Verifying...`);
                    await new Promise(r => setTimeout(r, 1500));

                    // Strategy B: JS Click (Fallback)
                    const isStillThere = await currentPage.evaluate(() => {
                        // eslint-disable-next-line no-undef
                        const els = Array.from(document.querySelectorAll('button, span, div[role="button"]'));
                        return els.some(el => {
                            const r = el.getBoundingClientRect();
                            return (
                                /Launch|rocket_launch/i.test(el.innerText) && r.top > 400 && r.top < 800 && r.height > 0
                            );
                        });
                    });

                    if (isStillThere && !this._hasActiveQueueForAuth(authIndex)) {
                        this.logger.warn(`[Browser] ⚠️ Physical click ineffective, attempting JS force click...`);
                        await currentPage.evaluate(() => {
                            const candidates = Array.from(
                                // eslint-disable-next-line no-undef
                                document.querySelectorAll('button, span, div[role="button"]')
                            );
                            for (const el of candidates) {
                                const r = el.getBoundingClientRect();
                                if (/Launch|rocket_launch/i.test(el.innerText) && r.top > 400 && r.top < 800) {
                                    (el.closest("button") || el).click();
                                    return true;
                                }
                            }
                        });
                        await new Promise(r => setTimeout(r, 2000));
                    } else {
                        this.logger.info(`[Browser] ✅ Click successful, button disappeared.`);
                        // Long sleep on success, but check for context switches every second
                        for (let i = 0; i < 60; i++) {
                            if (contextData.noButtonCount === 0 || this.contexts.get(authIndex) !== contextData) {
                                this.logger.info(`[Browser] ⚡ Woken up early due to user activity or context switch.`);
                                break; // Wake up early if user activity detected
                            }
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }
                } else {
                    contextData.noButtonCount++;
                    // Smart Sleep
                    if (contextData.noButtonCount > 20) {
                        // Long sleep, but check for user activity
                        for (let i = 0; i < 30; i++) {
                            if (contextData.noButtonCount === 0 || this.contexts.get(authIndex) !== contextData) break;
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    } else {
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
            } catch (e) {
                // Ignore errors during page navigation/reload
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // Reset flag when loop exits
        contextData.wakeupRunning = false;
        this.backgroundWakeupRunning = [...this.contexts.values()].some(entry => entry.wakeupRunning);

        // Log the reason for stopping
        if (!contextData.page) {
            this.logger.info("[Browser] Background Wakeup Service stopped: this.page is null.");
        } else if (contextData.page.isClosed()) {
            this.logger.info("[Browser] Background Wakeup Service stopped: this.page was closed.");
        } else {
            this.logger.info("[Browser] Background Wakeup Service stopped: unknown reason.");
        }
    }

    async launchBrowserForVNC(extraArgs = {}) {
        const targetAuthIndex = Number.isInteger(extraArgs.targetAuthIndex) ? extraArgs.targetAuthIndex : null;
        const existingAuth = targetAuthIndex === null ? null : this.authSource.getAuth(targetAuthIndex);
        if (targetAuthIndex !== null && !existingAuth) {
            throw new Error(`Auth #${targetAuthIndex} does not exist for reauthentication.`);
        }
        const stickyProxy =
            targetAuthIndex === null
                ? this.stickyProxyManager.reserveProxyForNewAccount("VNC account binding")
                : this.stickyProxyManager.getProxyForAuth(targetAuthIndex);
        this.logger.info("🚀 [VNC] Launching a new, separate, headful browser instance for VNC session...");
        const browserExecutablePath = this._getBrowserExecutablePath();
        if (!fs.existsSync(browserExecutablePath)) {
            throw new Error(`Browser executable not found at path: ${browserExecutablePath}`);
        }

        const proxyConfig = stickyProxy
            ? stickyProxy.proxy
            : parseProxyConfig(this.config.proxyUrl, this.config.proxyBypass);
        if (proxyConfig) {
            this.logger.info(
                stickyProxy
                    ? `[VNC] Launching browser with proxy: ${stickyProxy.display}`
                    : `[VNC] 🌐 Using proxy: ${getProxySummary(this.config.proxyUrl).server}`
            );
        }

        // This browser instance is temporary and specific to the VNC session.
        // It does NOT affect the main `this.browser` used for the API proxy.
        const vncBrowser = await firefox.launch({
            env: {
                ...withoutLegacyProxyEnv(process.env),
                ...extraArgs.env,
            },
            executablePath: browserExecutablePath,
            firefoxUserPrefs: FIREFOX_DOH_DISABLED_PREFS,
            headless: false,
            ...(proxyConfig ? { proxy: proxyConfig } : {}),
        });

        vncBrowser.on("disconnected", () => {
            this.logger.warn("ℹ️ [VNC] The temporary VNC browser instance has been disconnected.");
        });

        this.logger.info("✅ [VNC] Temporary VNC browser instance launched successfully.");

        let contextOptions = {};
        if (extraArgs.isMobile) {
            this.logger.info("[VNC] Mobile client detected; applying Firefox Android context for VNC login.");
            contextOptions = {
                hasTouch: true,
                userAgent: "Mozilla/5.0 (Android 10; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
            };
        }

        if (existingAuth) {
            contextOptions.storageState = existingAuth;
        }

        const context = await vncBrowser.newContext(
            proxyConfig ? { ...contextOptions, proxy: proxyConfig } : contextOptions
        );
        this.logger.info("✅ [VNC] VNC browser context successfully created.");

        // Return both the browser and context so the caller can manage their lifecycle.
        return { browser: vncBrowser, context, stickyProxy };
    }

    /**
     * Preload a pool of contexts at startup
     * Synchronously initializes the first context, then starts remaining in background
     * @param {number[]} startupOrder - Ordered list of auth indices to try
     * @param {number} maxContexts - Max pool size (0 = unlimited)
     * @returns {Promise<{firstReady: number|null}>}
     */
    async preloadContextPool(startupOrder, maxContexts) {
        const poolSize = maxContexts === 0 ? startupOrder.length : Math.min(maxContexts, startupOrder.length);
        this.logger.info(
            `🚀 [ContextPool] Starting pool preload (pool=${poolSize}, order=[${startupOrder.join(", ")}])...`
        );

        // Abort any existing background preload/rebalance to ensure clean state
        await this.abortBackgroundPreload();

        // Launch browser if not already running
        if (!this.browser) {
            await this._ensureBrowser();
        }

        // Synchronously try ALL indices until one succeeds (fallback beyond poolSize)
        let firstReady = null;

        for (let i = 0; i < startupOrder.length; i++) {
            const authIndex = startupOrder[i];

            // If already initialized, use it directly
            if (this.contexts.has(authIndex)) {
                this.logger.info(`[ContextPool] Context #${authIndex} already exists, reusing`);
                firstReady = authIndex;
                break;
            }

            // If being initialized by another task, wait for it to finish and verify success
            if (this.initializingContexts.has(authIndex)) {
                this.logger.info(`[ContextPool] Context #${authIndex} being initialized, waiting...`);
                await this._waitForContextInit(authIndex);
                if (this.contexts.has(authIndex)) {
                    this.logger.info(`[ContextPool] Context #${authIndex} initialized successfully, reusing`);
                    firstReady = authIndex;
                    break;
                }
                this.logger.warn(`[ContextPool] Context #${authIndex} initialization failed, trying next`);
                continue;
            }

            this.initializingContexts.add(authIndex);
            try {
                this.logger.info(`[ContextPool] Initializing context #${authIndex}...`);
                await this._initializeContext(authIndex);
                firstReady = authIndex;
                this.logger.info(`✅ [ContextPool] First context #${authIndex} ready.`);
                break;
            } catch (error) {
                this.logger.error(`❌ [ContextPool] Context #${authIndex} failed: ${error.message}`);
            } finally {
                // Note: _initializeContext already removes from initializingContexts in its finally block
            }
        }

        if (firstReady === null) {
            if (this.browser) await this.closeBrowser();
            return { firstReady: null };
        }

        // Early return if pool size is 1 (single context mode) - no need for background preload
        if (poolSize === 1) {
            this.logger.info(`[ContextPool] Single context mode (maxContexts=1), skipping background preload.`);
            return { firstReady };
        }

        // Background: calculate remaining contexts using rotation order (same logic as rebalanceContextPool)
        // This ensures startup pool matches the rotation order used during account switching
        const rotation = this.authSource.getRotationIndices();
        const currentCanonical = this.authSource.getCanonicalIndex(firstReady);
        const startPos = currentCanonical !== null ? Math.max(rotation.indexOf(currentCanonical), 0) : 0;
        const ordered = [];
        for (let i = 0; i < rotation.length; i++) {
            ordered.push(rotation[(startPos + i) % rotation.length]);
        }

        // Calculate how many more contexts we need to reach poolSize
        const needCount = poolSize - this.contexts.size;
        if (needCount > 0) {
            // Get candidates from ordered list (excluding already initialized contexts)
            // Convert existing contexts to canonical indices to handle duplicate accounts
            const existingCanonical = new Set(
                [...this.contexts.keys()].map(idx => this.authSource.getCanonicalIndex(idx) ?? idx)
            );
            const candidates = ordered.filter(
                idx => !existingCanonical.has(idx) && !this.initializingContexts.has(idx)
            );

            if (candidates.length > 0) {
                this.logger.info(
                    `[ContextPool] Background preload will try [${candidates.join(", ")}] to reach pool size ${poolSize} (need ${needCount} more)`
                );
                // Pass all candidates, not just the first needCount
                // This allows the background task to try subsequent accounts if earlier ones fail
                this._preloadBackgroundContexts(candidates, poolSize);
            }
        }

        return { firstReady };
    }

    /**
     * Launch browser instance if not already running
     */
    async _ensureBrowser() {
        this._startPoolMaintenance();
        if (this.browser) return;
        if (this._browserLaunchTask) return this._browserLaunchTask;

        const launchTask = this._launchBrowser();
        this._browserLaunchTask = launchTask;
        try {
            await launchTask;
        } finally {
            if (this._browserLaunchTask === launchTask) this._browserLaunchTask = null;
        }
    }

    async _launchBrowser() {
        const isStickyProxyEnabled = this.stickyProxyManager.isEnabled();
        const proxyConfig = isStickyProxyEnabled
            ? null
            : parseProxyConfig(this.config.proxyUrl, this.config.proxyBypass);
        if (isStickyProxyEnabled) {
            this.logger.info("[Browser] Sticky proxy mode enabled; main browser launch will not use the global proxy.");
        }
        this.logger.info("🚀 [Browser] Launching main browser instance...");
        const browserExecutablePath = this._getBrowserExecutablePath();
        if (!fs.existsSync(browserExecutablePath)) {
            this._currentAuthIndex = -1;
            throw new Error(`Browser executable not found at path: ${browserExecutablePath}`);
        }
        this.browser = await firefox.launch({
            args: this.launchArgs,
            env: withoutLegacyProxyEnv(process.env),
            executablePath: browserExecutablePath,
            firefoxUserPrefs: this.firefoxUserPrefs,
            headless: true,
            ...(proxyConfig ? { proxy: proxyConfig } : {}),
        });
        this.browser.on("disconnected", () => {
            if (!this.isClosingIntentionally) {
                this.logger.error("❌ [Browser] Main browser unexpectedly disconnected!");
            } else {
                this.logger.debug("[Browser] Main browser closed intentionally.");
            }
            this.browser = null;
            this._cleanupAllContexts();
        });
        this.logger.info("✅ [Browser] Main browser instance launched successfully.");
    }

    /**
     * Abort any ongoing background preload task and wait for it to complete
     * This is a public method that encapsulates access to internal preload state
     * @returns {Promise<void>} Resolves when the background task has been aborted and cleaned up
     */
    async abortBackgroundPreload() {
        if (!this._backgroundPreloadTask) {
            return; // No task to abort
        }

        this.logger.info(`[ContextPool] Aborting background preload task...`);
        this._backgroundPreloadAbort = true;
        for (const token of this._initializationTokens?.values() || []) {
            if (token.background && token.pending) token.cancel();
        }

        try {
            await this._backgroundPreloadTask;
        } catch (error) {
            // Ignore errors from aborted task
            this.logger.debug(`[ContextPool] Background preload aborted: ${error.message}`);
        }

        this.logger.info(`[ContextPool] Background preload aborted successfully`);
    }

    /**
     * Background sequential initialization of contexts (fire-and-forget)
     * Only one instance should be active at a time - new calls abort old ones
     * @param {number[]} indices - Auth indices to initialize (candidates, may exceed pool size)
     * @param {number} maxPoolSize - Stop when this.contexts.size reaches this limit (0 = no limit)
     */
    async _preloadBackgroundContexts(indices, maxPoolSize = 0) {
        this._ensurePoolState();
        this._preloadDesiredIndices = [...indices];
        this._preloadDesiredCap = maxPoolSize;
        // Dispatching through another healthy account must not keep cancelling a
        // slow pool member's initialization.
        if (this._backgroundPreloadTask) return;

        // Reset abort flag and create new background task
        this._backgroundPreloadAbort = false;
        const currentTask = this._executePreloadTask(indices, maxPoolSize);
        this._backgroundPreloadTask = currentTask;

        // Don't await here - this is fire-and-forget
        // But ensure we clean up the task reference when done
        currentTask
            .catch(error => {
                this.logger.error(`[ContextPool] Background preload task failed: ${error.message}`);
            })
            .finally(() => {
                // Only clear if this is still the current task
                if (this._backgroundPreloadTask === currentTask) {
                    this._backgroundPreloadTask = null;
                }
            });
    }

    _hasActiveQueueForAuth(authIndex) {
        return Boolean(
            this.connectionRegistry?.hasMessageQueueForAuth?.(authIndex) ||
            this._accountLoadProvider?.(authIndex)?.inFlight > 0
        );
    }

    _cancelPendingContextClosure(authIndex, reason = "closure_cancelled") {
        if (!this.pendingContextClosures.has(authIndex)) {
            return false;
        }
        if (this.pendingContextClosures.get(authIndex) === "reauth") {
            return false;
        }
        this.pendingContextClosures.delete(authIndex);
        this.logger.info(`[ContextPool] Cancelled pending close for context #${authIndex} (${reason}).`);
        return true;
    }

    _scheduleContextClosureWhenIdle(authIndex, reason) {
        if (!this.contexts.has(authIndex)) {
            return false;
        }
        const existingReason = this.pendingContextClosures.get(authIndex);
        if (existingReason) {
            this.logger.debug(
                `[ContextPool] Context #${authIndex} is already pending close (${existingReason}), active queues are still present`
            );
            return false;
        }
        this.pendingContextClosures.set(authIndex, reason);
        this.logger.info(
            `[ContextPool] Deferring close for busy context #${authIndex} (active queue(s) present, reason: ${reason})`
        );
        return false;
    }

    async _closeContextForPoolIfPossible(authIndex, reason) {
        if (this._accountTestReservations?.has(authIndex)) return false;
        if (this.pendingContextClosures.get(authIndex) === "reauth") {
            return this._closePendingContextIfIdle(authIndex);
        }
        if (this._hasActiveQueueForAuth(authIndex)) {
            return this._scheduleContextClosureWhenIdle(authIndex, reason);
        }

        this.pendingContextClosures.delete(authIndex);
        await this.closeContext(authIndex);
        return true;
    }

    async _closePendingContextIfIdle(authIndex) {
        const pending = this._closingPendingContexts.get(authIndex);
        if (pending) return pending;
        const task = this._closePendingContextIfIdleImpl(authIndex);
        this._closingPendingContexts.set(authIndex, task);
        try {
            return await task;
        } finally {
            if (this._closingPendingContexts.get(authIndex) === task) this._closingPendingContexts.delete(authIndex);
        }
    }

    async _closePendingContextIfIdleImpl(authIndex) {
        if (this._accountTestReservations?.has(authIndex)) return false;
        if (!this.pendingContextClosures.has(authIndex)) {
            return false;
        }
        if (
            authIndex === this._currentAuthIndex &&
            this.pendingContextClosures.get(authIndex) !== "reauth" &&
            this.authSource.getRotationIndices().includes(authIndex)
        ) {
            this.logger.debug(
                `[ContextPool] Skipping pending close for context #${authIndex} because it is active again as current.`
            );
            return false;
        }
        if (!this.contexts.has(authIndex)) {
            const pendingReason = this.pendingContextClosures.get(authIndex);
            this.pendingContextClosures.delete(authIndex);
            if (pendingReason === "reauth") {
                this.resumeAuthUpdates(authIndex);
            }
            return false;
        }

        if (this._hasActiveQueueForAuth(authIndex)) {
            this.logger.debug(
                `[ContextPool] Pending close for context #${authIndex} is still waiting on active queue(s).`
            );
            return false;
        }

        const pendingReason = this.pendingContextClosures.get(authIndex);
        const wasCurrent = authIndex === this._currentAuthIndex;
        this.pendingContextClosures.delete(authIndex);
        this.logger.info(
            `[ContextPool] Closing deferred context #${authIndex} now that all queues are drained (reason: ${pendingReason}).`
        );
        try {
            await this.closeContext(authIndex);
        } catch (error) {
            if (this.contexts.has(authIndex)) this.pendingContextClosures.set(authIndex, pendingReason);
            else if (pendingReason === "reauth") {
                this.resumeAuthUpdates(authIndex);
            }
            this.logger.warn(`[ContextPool] Deferred close for #${authIndex} failed: ${error.message}`);
            return false;
        }
        if (pendingReason === "reauth") {
            this.resumeAuthUpdates(authIndex);
        }
        if (pendingReason === "reauth" && wasCurrent && !this.authSource.isExpired(authIndex)) {
            await this.launchOrSwitchContext(authIndex);
            return true;
        }
        if (this._isSystemBusy()) {
            this.logger.info("[ContextPool] Skipping rebalance after deferred close because system is busy.");
            return true;
        }
        this.rebalanceContextPool().catch(error => {
            this.logger.error(`[ContextPool] Rebalance after deferred close failed: ${error.message}`);
        });
        return true;
    }

    async _flushPendingContextClosures() {
        for (const authIndex of [...this.pendingContextClosures.keys()]) {
            await this._closePendingContextIfIdle(authIndex);
        }
    }

    async _drainPendingReauthClosures() {
        for (const [authIndex, reason] of [...this.pendingContextClosures.entries()]) {
            if (reason !== "reauth") continue;
            await this._closePendingContextIfIdle(authIndex);
        }
    }

    _prioritizeContextsForRemoval(indices) {
        const idle = [];
        const busy = [];

        for (const authIndex of indices) {
            if (this._hasActiveQueueForAuth(authIndex)) {
                busy.push({ authIndex });
            } else {
                idle.push(authIndex);
            }
        }

        return { busy, idle };
    }

    /**
     * Internal method to execute the actual preload task
     * @private
     */
    async _executePreloadTask(indices, maxPoolSize) {
        this.logger.info(
            `[ContextPool] Background preload starting for [${indices.join(", ")}] (poolCap=${maxPoolSize || "unlimited"})...`
        );

        let aborted = false;

        const attempted = new Set();
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const latest = this._preloadDesiredIndices || indices;
            const eligible = new Set(this.authSource.getRotationIndices());
            const authIndex = latest.find(
                index =>
                    eligible.has(index) &&
                    !attempted.has(index) &&
                    !this.contexts.has(index) &&
                    !this.initializingContexts.has(index) &&
                    (this._accountRuntime?.get(index)?.nextRetryAt || 0) <= Date.now()
            );
            if (authIndex === undefined) break;
            attempted.add(authIndex);
            maxPoolSize = this._preloadDesiredCap ?? maxPoolSize;
            // Check if abort was requested
            if (this._backgroundPreloadAbort) {
                this.logger.info(`[ContextPool] Background preload aborted by request`);
                aborted = true;
                break;
            }

            // Check if browser is available, launch if needed
            if (!this.browser) {
                this.logger.info(`[ContextPool] Browser not available, launching browser for background preload...`);
                try {
                    await this._ensureBrowser();
                    this.logger.info(`[ContextPool] Browser launched successfully for background preload`);
                } catch (error) {
                    this.logger.error(
                        `[ContextPool] Failed to launch browser for background preload: ${error.message}`
                    );
                    break;
                }
            }

            // Check pool size limit
            if (maxPoolSize > 0 && this._getServingPoolOccupancy() >= maxPoolSize) {
                this.logger.info(`[ContextPool] Pool size limit reached, stopping preload`);
                break;
            }

            // Skip if already exists or being initialized by another task
            if (this._accountTestConnection?.authIndex === authIndex) continue;
            if (this.contexts.has(authIndex)) {
                this.logger.debug(`[ContextPool] Context #${authIndex} already exists, skipping`);
                continue;
            }
            if (this.initializingContexts.has(authIndex)) {
                this.logger.info(
                    `[ContextPool] Context #${authIndex} already being initialized by another task, skipping`
                );
                continue;
            }

            this.initializingContexts.add(authIndex);
            try {
                this.logger.info(`[ContextPool] Background preload init context #${authIndex}...`);
                await this._initializeContext(authIndex, true); // Mark as background task
                this._candidateFailures?.delete(authIndex);
                this.logger.info(`✅ [ContextPool] Background context #${authIndex} ready.`);
            } catch (error) {
                if (
                    !isContextAbortedError(error) &&
                    (this._accountRuntime?.get(authIndex)?.nextRetryAt || 0) <= Date.now()
                )
                    this._backOffCandidate(authIndex, error);
                // Check if this is an abort error (user deleted the account during initialization or background preload was aborted)
                const isAbortError = isContextAbortedError(error);
                if (isAbortError) {
                    this.logger.info(`[ContextPool] Background context #${authIndex} aborted as requested`);
                    // If aborted due to background preload abort, mark as aborted
                    aborted = true;
                } else {
                    this.logger.error(`❌ [ContextPool] Background context #${authIndex} failed: ${error.message}`);
                }
            } finally {
                if (!this._initializationTokens?.get(authIndex)?.pending) {
                    this.initializingContexts.delete(authIndex);
                    this.abortedContexts.delete(authIndex);
                }
            }
            // Note: initializingContexts and abortedContexts cleanup is handled in _initializeContext's finally block
        }

        if (!aborted) {
            this.logger.info(`[ContextPool] Background preload complete.`);
        }
    }

    /**
     * Pre-cleanup before switching to a new account
     * Removes contexts that will be excess after the switch to avoid exceeding maxContexts
     * @param {number} targetAuthIndex - The account index we're about to switch to
     */
    async preCleanupForSwitch(targetAuthIndex) {
        if (this._expiredRecheckIndex === targetAuthIndex) await this._stopExpiredRecheck();
        const maxContexts = this.config.maxContexts;
        const isUnlimited = maxContexts === 0;

        // Abort any ongoing background preload task before cleanup
        // This prevents race conditions where background tasks continue initializing contexts
        // that will be immediately removed by the new rebalance after switch
        await this.abortBackgroundPreload();

        // Test: Check if initializingContexts is empty after aborting background task
        if (this.initializingContexts.size > 0) {
            const initializingList = [...this.initializingContexts].join(", ");
            this.logger.error(
                `[ContextPool] Pre-cleanup ERROR: initializingContexts not empty after aborting background task! Contexts still initializing: [${initializingList}]`
            );
            throw new Error(
                `Pre-cleanup failed: initializingContexts not empty (${initializingList}). This should not happen after aborting background task.`
            );
        }

        // In unlimited mode, no need to pre-cleanup
        if (isUnlimited) {
            this.logger.debug(`[ContextPool] Pre-cleanup skipped: unlimited mode`);
            return;
        }

        // If target context already exists or is being initialized, no new context will be created
        if (this.contexts.has(targetAuthIndex)) {
            this.logger.debug(`[ContextPool] Pre-cleanup skipped: target context #${targetAuthIndex} already exists`);
            return;
        }

        if (this.initializingContexts.has(targetAuthIndex)) {
            this.logger.debug(
                `[ContextPool] Pre-cleanup skipped: target context #${targetAuthIndex} is being initialized`
            );
            return;
        }

        // Calculate how many contexts we'll have after adding the new one
        // Include contexts that are currently being initialized in background
        const currentSize = this.contexts.size + this.initializingContexts.size;
        const futureSize = currentSize + 1;

        // If we won't exceed the limit, no cleanup needed
        if (futureSize <= maxContexts) {
            this.logger.debug(
                `[ContextPool] Pre-cleanup skipped: future size ${futureSize} (${this.contexts.size} ready + ${this.initializingContexts.size} initializing + 1 new) <= maxContexts ${maxContexts}`
            );
            return;
        }

        // We need to remove (futureSize - maxContexts) contexts
        const removeCount = futureSize - maxContexts;

        // Build removal priority list (from lowest to highest priority to keep):
        // Priority 1: Old duplicate accounts (removedIndices from duplicateGroups)
        // Priority 2: Expired accounts (not the target if target is expired)
        // Priority 3: Accounts in rotation, ordered by distance from target (farthest first)

        const rotation = this.authSource.getRotationIndices();
        const targetCanonical = this.authSource.getCanonicalIndex(targetAuthIndex);
        const duplicateGroups = this.authSource.getDuplicateGroups();
        const expiredIndices = this.authSource.expiredIndices || [];

        // Get all old duplicate indices (not in rotation)
        const oldDuplicates = new Set();
        for (const group of duplicateGroups) {
            for (const idx of group.removedIndices) {
                oldDuplicates.add(idx);
            }
        }

        // Build rotation order starting from target (accounts closer to target have higher priority)
        // Special case: If target is expired, use targetAuthIndex directly as startPos
        const isTargetExpired = expiredIndices.includes(targetAuthIndex);
        let startPos;
        if (isTargetExpired) {
            // For expired accounts, find rotation position by comparing index values (expired accounts are never in rotation)
            startPos = rotation.indexOf(targetAuthIndex);
            if (startPos === -1) {
                // Target not in rotation (it's expired), find closest position by index value
                startPos = 0;
                for (let i = 0; i < rotation.length; i++) {
                    if (rotation[i] > targetAuthIndex) {
                        startPos = i;
                        break;
                    }
                }
            }
        } else {
            startPos = Math.max(rotation.indexOf(targetCanonical), 0);
        }
        const orderedFromTarget = [];
        for (let i = 0; i < rotation.length; i++) {
            orderedFromTarget.push(rotation[(startPos + i) % rotation.length]);
        }

        // Collect all context indices (existing + initializing)
        const allContextIndices = new Set([...this.contexts.keys(), ...this.initializingContexts]);

        // Build removal priority list
        const removalPriority = [];

        // Special case: If target is an old duplicate, prioritize removing its canonical version
        // Because we're about to create the old duplicate, and they're the same account
        const isTargetOldDuplicate = oldDuplicates.has(targetAuthIndex);
        if (isTargetOldDuplicate) {
            // Find the canonical version of target in existing contexts
            for (const idx of allContextIndices) {
                if (this.authSource.getCanonicalIndex(idx) === targetCanonical && idx === targetCanonical) {
                    removalPriority.push(idx);
                    break;
                }
            }
        }

        // Priority 1: Old duplicate accounts (lowest priority to keep)
        for (const idx of allContextIndices) {
            if (oldDuplicates.has(idx) && !removalPriority.includes(idx)) {
                removalPriority.push(idx);
            }
        }

        // Priority 2: Expired accounts (except target if target is expired)
        for (const idx of allContextIndices) {
            if (expiredIndices.includes(idx) && idx !== targetAuthIndex && !removalPriority.includes(idx)) {
                removalPriority.push(idx);
            }
        }

        // Priority 3: Accounts in rotation, from farthest to closest (reverse rotation order)
        for (let i = orderedFromTarget.length - 1; i >= 0; i--) {
            const canonical = orderedFromTarget[i];
            // Find all contexts with this canonical index
            for (const idx of allContextIndices) {
                if (this.authSource.getCanonicalIndex(idx) === canonical && !removalPriority.includes(idx)) {
                    removalPriority.push(idx);
                }
            }
        }

        const { busy, idle } = this._prioritizeContextsForRemoval(removalPriority);
        const toRemoveNow = idle.slice(0, removeCount);
        const toDefer = busy.slice(0, Math.max(0, removeCount - toRemoveNow.length));

        this.logger.info(
            `[ContextPool] Pre-cleanup before switch to #${targetAuthIndex}: immediate=[${toRemoveNow}], deferred=[${toDefer.map(
                entry => entry.authIndex
            )}] (${this.contexts.size} ready + ${this.initializingContexts.size} initializing)`
        );

        for (const idx of toRemoveNow) {
            await this._closeContextForPoolIfPossible(idx, "pre_cleanup_for_switch");
        }

        for (const entry of toDefer) {
            this._scheduleContextClosureWhenIdle(entry.authIndex, "pre_cleanup_for_switch");
        }

        if (toDefer.length > 0) {
            this.logger.warn(
                `[ContextPool] Allowing temporary MAX_CONTEXTS overflow while busy contexts drain before switch to #${targetAuthIndex}.`
            );
        }
    }

    /**
     * Rebalance context pool after account changes
     * Removes excess contexts and starts missing ones in background
     */
    async rebalanceContextPool() {
        if (this._rebalanceTask) return this._rebalanceTask;
        const task = this._rebalanceContextPool();
        this._rebalanceTask = task;
        try {
            return await task;
        } finally {
            if (this._rebalanceTask === task) this._rebalanceTask = null;
        }
    }

    async _rebalanceContextPool() {
        this._ensurePoolState();
        const maxContexts = this.config.maxContexts;
        // maxContexts === 0 means unlimited pool size
        const isUnlimited = maxContexts === 0;

        // Keep healthy resident accounts stable. currentAuthIndex is a compatibility
        // pointer, not the pool's dispatch policy.
        const rotation = this.authSource.getRotationIndices();
        const currentCanonical =
            this._currentAuthIndex >= 0 ? this.authSource.getCanonicalIndex(this._currentAuthIndex) : null;
        const ordered = [
            ...rotation.filter(index => this.isAccountReady(index)),
            ...rotation.filter(index => this.initializingContexts.has(index)),
            ...rotation.filter(index => !this.contexts.has(index) && !this.initializingContexts.has(index)),
        ].filter(index => (this._accountRuntime?.get(index)?.nextRetryAt || 0) <= Date.now());

        // Targets = first maxContexts from ordered (or all available if unlimited)
        // In unlimited mode, include all valid accounts (rotation + duplicates), excluding expired
        let targets;
        if (isUnlimited) {
            // Filter out expired accounts from availableIndices
            targets = new Set(rotation);
        } else {
            targets = new Set(ordered.slice(0, maxContexts));
        }

        // Stopped accounts may keep a connected page, after enabled accounts have their places.
        for (const [index, entry] of this.contexts) {
            if (!isUnlimited && targets.size >= maxContexts) break;
            if (
                this.authSource.health.getStatus(index).mode === "disabled" &&
                (this.authSource.rotationIndices || []).includes(index) &&
                !this.authSource.isExpired(index) &&
                entry.page &&
                !entry.page.isClosed() &&
                this.connectionRegistry.isAccountConnected(index) &&
                !this._transportFailedAccounts.has(index)
            )
                targets.add(index);
        }

        for (const idx of targets) {
            this._cancelPendingContextClosure(idx, "rebalance_target");
        }

        // Remove contexts not in targets (except current)
        // Special handling: if current account is a duplicate (old version), also remove its canonical version
        // BUT only in limited mode - in unlimited mode, keep all contexts
        const toRemove = [];
        const currentCanonicalIndex = currentCanonical; // Already calculated above
        const isDuplicateAccount =
            this._currentAuthIndex >= 0 &&
            currentCanonicalIndex !== null &&
            currentCanonicalIndex !== this._currentAuthIndex;

        for (const idx of this.contexts.keys()) {
            if (this._accountTestReservations.has(idx)) continue;
            // The compatibility pointer must not retain an unhealthy account.
            if (idx === this._currentAuthIndex && targets.has(idx)) continue;

            // If current is a duplicate AND we're in limited mode, remove the canonical version (we're using the old one)
            if (!isUnlimited && isDuplicateAccount && idx === currentCanonicalIndex) {
                toRemove.push(idx);
                continue;
            }

            // Remove if not in targets
            if (!targets.has(idx)) {
                toRemove.push(idx);
            }
        }

        // Candidates: all accounts from ordered that are not yet initialized
        // Pass the full ordered list to allow fallback if target accounts fail
        // The background task will stop when poolSize is reached
        // Convert activeContexts to canonical indices to handle duplicate accounts
        const activeContextsRaw = new Set([...this.contexts.keys()].filter(idx => !toRemove.includes(idx)));
        const activeContexts = new Set(
            [...activeContextsRaw].map(idx => this.authSource.getCanonicalIndex(idx) ?? idx)
        );
        // Don't filter out initializingContexts here - let _executePreloadTask handle it
        // This ensures that if a background task is aborted, the account will be retried
        // If a foreground task is running, _executePreloadTask will skip it (line 1382)
        const candidates = ordered.filter(idx => !activeContexts.has(idx));

        const { busy, idle } = this._prioritizeContextsForRemoval(toRemove);

        this.logger.info(
            `[ContextPool] Rebalance: targets=[${[...targets]}], removeNow=[${idle}], removeDeferred=[${busy.map(
                entry => entry.authIndex
            )}], candidates=[${candidates}]`
        );

        for (const idx of idle) {
            await this._closeContextForPoolIfPossible(idx, "rebalance");
        }

        for (const entry of busy) {
            this._scheduleContextClosureWhenIdle(entry.authIndex, "rebalance");
        }

        // Preload candidates if ready and initializing contexts still leave room in the pool
        const poolOccupancy = this._getServingPoolOccupancy();
        if (!this._expiredRecheckContext && candidates.length > 0 && (isUnlimited || poolOccupancy < maxContexts)) {
            this._preloadBackgroundContexts(candidates, isUnlimited ? 0 : maxContexts);
        }

        for (const index of targets) {
            if (this.contexts.has(index) && !this.isAccountReady(index) && this.authSource.health.isAvailable(index)) {
                this.ensureAccountReady(index).catch(error => {
                    this.logger.warn(`[ContextPool] Account #${index} recovery failed: ${error.message}`);
                });
            }
        }
    }

    /**
     * Wait for a background context initialization to complete
     * @param {number} authIndex - The auth index to wait for
     * @param {number} timeoutMs - Timeout in milliseconds
     */
    async _waitForContextInit(authIndex, timeoutMs = 120000) {
        const start = Date.now();
        while (this.initializingContexts.has(authIndex)) {
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Timeout waiting for context #${authIndex} initialization`);
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }

    /**
     * Initialize a single context for the given auth index
     * This is a helper method used by both preloadContextPool and launchOrSwitchContext
     * @param {number} authIndex - The auth index to initialize
     * @param {boolean} isBackgroundTask - Whether this is a background preload task (can be aborted by _backgroundPreloadAbort)
     * @returns {Promise<{context, page}>}
     */
    async _initializeContext(authIndex, isBackgroundTask = false) {
        this._ensurePoolState();
        const previousToken = this._initializationTokens.get(authIndex);
        previousToken?.cancel?.();
        const token = {
            authIndex,
            background: isBackgroundTask,
            cancelled: false,
            deadline: Date.now() + (this._contextInitTimeoutMs || CONTEXT_INIT_TIMEOUT_MS),
            generation: randomUUID(),
            pending: true,
        };
        token.abortPromise = new Promise((_, reject) => {
            token.cancel = () => {
                if (token.cancelled) return;
                token.cancelled = true;
                reject(new ContextAbortedError(authIndex, "initialization cancelled"));
            };
        });
        token.abortPromise.catch(() => {});
        this._initializationTokens.set(authIndex, token);
        let context = null;
        let page = null;

        try {
            // Check if this context has been marked for abort before starting
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            // Initialize per-context WebSocket state to ensure clean state for this context
            // Each context gets its own state object, preventing cross-contamination
            // between concurrent init/reconnect operations on different accounts
            this._wsInitState.set(authIndex, { failed: false, success: false });

            const stickyProxy = this.stickyProxyManager.getProxyForAuth(authIndex);
            const proxyConfig = stickyProxy
                ? stickyProxy.proxy
                : parseProxyConfig(this.config.proxyUrl, this.config.proxyBypass);
            if (stickyProxy) {
                this.logger.info(
                    `[Context#${authIndex}] Using sticky proxy for account "${stickyProxy.accountKey}": ${stickyProxy.display}`
                );
            }
            const storageStateObject = this.authSource.getAuth(authIndex);
            if (!storageStateObject) {
                throw new Error(`Failed to get or parse auth source for index ${authIndex}.`);
            }

            // Viewport Randomization
            const randomWidth = 1920 + Math.floor(Math.random() * 50);
            const randomHeight = 1080 + Math.floor(Math.random() * 50);

            // Check abort status before expensive operations
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            context = await this._initStage(
                token,
                "create_context",
                () =>
                    this.browser.newContext({
                        deviceScaleFactor: 1,
                        storageState: storageStateObject,
                        viewport: { height: randomHeight, width: randomWidth },
                        ...(proxyConfig ? { proxy: proxyConfig } : {}),
                    }),
                BROWSER_RPC_TIMEOUT_MS,
                lateContext => this._cleanupOperation(() => lateContext.close(), `Close late context #${authIndex}`)
            );

            // Check abort status after context creation
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            // Inject Privacy Script immediately after context creation
            const privacyScript = this._getPrivacyProtectionScript(authIndex);
            await this._initStage(token, "inject_privacy", () => context.addInitScript(privacyScript));
            if (context.route) {
                await this._initStage(token, "install_client", () =>
                    this._installHostedClient(context, authIndex, token.generation)
                );
            }

            page = await this._initStage(
                token,
                "create_page",
                () => context.newPage(),
                BROWSER_RPC_TIMEOUT_MS,
                latePage => this._cleanupOperation(() => latePage.close(), `Close late page #${authIndex}`)
            );

            // Pure JS Wakeup (Focus & Mouse Movement)
            // Skip focus operations for background tasks to avoid window focus conflicts
            if (!isBackgroundTask) {
                try {
                    await this._initStage(token, "focus_page", () => page.bringToFront());
                    // eslint-disable-next-line no-undef
                    await this._initStage(token, "focus_window", () => page.evaluate(() => window.focus()));
                    const vp = page.viewportSize() || { height: 1080, width: 1920 };
                    const startX = Math.floor(Math.random() * (vp.width * 0.5));
                    const startY = Math.floor(Math.random() * (vp.height * 0.5));
                    await this._initStage(token, "move_mouse", () => this._simulateHumanMovement(page, startX, startY));
                } catch (e) {
                    this.logger.warn(`[Context#${authIndex}] Wakeup minor error: ${e.message}`);
                }
            } else {
                this.logger.debug(`[Context#${authIndex}] Skipping focus operations for background task`);
            }

            page.on("console", msg => {
                if (token.cancelled || this._initializationTokens.get(authIndex) !== token) return;
                const msgText = msg.text();
                if (msgText.includes("Content-Security-Policy")) {
                    return;
                }

                // Filter out WebGL not supported warning (expected when GPU is disabled for privacy)
                if (msgText.includes("WebGL not supported")) {
                    return;
                }

                if (msgText.includes("downloadable font: download failed")) {
                    return;
                }

                if (msgText.includes("[ProxyClient]")) {
                    const forwardedMessage = `[Context#${authIndex}] ${msgText.replace("[ProxyClient] ", "")}`;
                    const browserLogType = msg.type();

                    if (browserLogType === "debug") {
                        this.logger.debug(forwardedMessage);
                    } else if (browserLogType === "warning") {
                        this.logger.warn(forwardedMessage);
                    } else if (browserLogType === "error") {
                        this.logger.error(forwardedMessage);
                    } else {
                        this.logger.info(forwardedMessage);
                    }
                } else if (msg.type() === "error") {
                    this.logger.error(`[Context#${authIndex} Page Error] ${msgText}`);
                }

                // Check for WebSocket initialization status
                if (msgText.includes("Connection successful")) {
                    this.logger.debug(
                        `[Context#${authIndex}] ✅ Detected successful WebSocket connection from browser`
                    );
                    const s = this._wsInitState.get(authIndex);
                    if (s) s.success = true;
                } else if (msgText.includes("WebSocket initialization failed")) {
                    this.logger.warn(
                        `[Context#${authIndex}] ❌ Detected WebSocket initialization failure from browser`
                    );
                    const s = this._wsInitState.get(authIndex);
                    if (s) s.failed = true;
                }
            });

            // Check abort status before navigation (most time-consuming part)
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            await this._initStage(
                token,
                "navigate",
                () => this._navigateAndWakeUpPage(page, `[Context#${authIndex}]`),
                185000
            );

            // Check abort status after navigation
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            await this._initStage(
                token,
                "check_identity",
                () => this._checkPageStatusAndErrors(page, `[Context#${authIndex}]`, authIndex, token),
                60000
            );

            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            // Wait for WebSocket initialization (no retry)
            // Check if initialization already succeeded (console listener may have detected it)
            if (this.connectionRegistry?.isAccountConnected?.(authIndex)) {
                this.logger.info(`[Context#${authIndex}] ✅ WebSocket already initialized, skipping wait`);
            } else {
                // Wait for WebSocket initialization (120 second timeout)
                // This will throw an abort error if the context is aborted during wait
                const initSuccess = await this._initStage(
                    token,
                    "wait_websocket",
                    () =>
                        this._waitForWebSocketInit(
                            page,
                            `[Context#${authIndex}]`,
                            WS_INIT_TIMEOUT_MS,
                            authIndex,
                            isBackgroundTask,
                            token
                        ),
                    this._webSocketInitTimeoutMs || WS_INIT_TIMEOUT_MS
                );

                if (!initSuccess) {
                    throw new Error("WebSocket initialization failed. Please check browser logs and page errors.");
                }
            }

            // Final check before adding to contexts map
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);
            this._assertInitialization(token);

            // Save to contexts map - with atomic abort check to prevent race condition
            // between the check above and actually adding to the map
            if (!this.abortedContexts.has(authIndex) && !(isBackgroundTask && this._backgroundPreloadAbort)) {
                this.contexts.set(authIndex, {
                    context,
                    healthMonitorInterval: null,
                    page,
                });
            } else {
                this._throwIfContextInitAborted(authIndex, isBackgroundTask);
            }

            // Update auth file
            try {
                await this._initStage(
                    token,
                    "save_auth",
                    () => this._updateAuthFile(authIndex),
                    this._cleanupTimeoutMs || CONTEXT_CLEANUP_TIMEOUT_MS
                );
            } catch (error) {
                if (isContextAbortedError(error)) throw error;
                // Saving renewed cookies is optional; retain an accepted connection
                // and the previous credential snapshot if capture is slow.
                this.logger.warn(`[Auth Update] Could not refresh auth #${authIndex}: ${error.message}`);
            }
            this._assertInitialization(token);
            this._runtime(authIndex, "ready", null);
            this._transportFailedAccounts.delete(authIndex);
            this._startHealthMonitor(authIndex);
            this._startBackgroundWakeup(authIndex);

            return { context, page };
        } catch (error) {
            token.cancel();
            // Check if this is an abort error
            const isAbortError = isContextAbortedError(error);
            if (this._initializationTokens.get(authIndex) === token) {
                if (isAbortError) this._runtime(authIndex, "standby", "initialization_cancelled");
                else this._backOffCandidate(authIndex, error);
            }
            // Check if this is an auth expiration error
            const isAuthExpired = isAuthExpiredError(error);

            if (isAbortError) {
                this.logger.info(`[Browser] Context #${authIndex} initialization aborted as requested.`);
            } else if (isAuthExpired) {
                this.logger.error(
                    `❌ [Browser] Context initialization failed for index ${authIndex} (auth expired), cleaning up...`
                );
                // Auth is already marked as expired in _checkPageStatusAndErrors
            } else {
                this.logger.error(`❌ [Browser] Context initialization failed for index ${authIndex}, cleaning up...`);
            }

            // Save debug artifacts before closing the page (only for non-abort errors)
            if (!isAbortError && page && !page.isClosed()) {
                await this._cleanupOperation(
                    () => this._saveDebugArtifacts("init_failed", authIndex, page),
                    `Save initialization diagnostics #${authIndex}`
                );
            }

            // Remove from contexts map if it was added
            if (this.contexts.get(authIndex)?.context === context) {
                this.contexts.delete(authIndex);
                this.logger.info(`[Browser] Removed failed context #${authIndex} from contexts map`);
            }

            // Close context if it was created
            if (context) {
                try {
                    await this._cleanupOperation(() => context.close(), `Close failed context #${authIndex}`);
                    if (isAbortError) {
                        this.logger.info(`[Browser] Cleaned up aborted context for index ${authIndex}`);
                    } else {
                        this.logger.info(`[Browser] Cleaned up leaked context for index ${authIndex}`);
                    }
                } catch (closeError) {
                    this.logger.warn(`[Browser] Failed to close context during cleanup: ${closeError.message}`);
                }
            }
            throw error;
        } finally {
            // Ensure cleanup of tracking sets even if error is thrown
            token.pending = false;
            if (this._initializationTokens.get(authIndex) === token) {
                this.initializingContexts.delete(authIndex);
                this.abortedContexts.delete(authIndex);
            }
        }
    }

    async launchOrSwitchContext(authIndex) {
        if (typeof authIndex !== "number" || authIndex < 0) {
            this.logger.error(`[Browser] Invalid authIndex: ${authIndex}. authIndex must be >= 0.`);
            this._currentAuthIndex = -1;
            throw new Error(`Invalid authIndex: ${authIndex}. Must be >= 0.`);
        }

        if (this._expiredRecheckIndex === authIndex) await this._stopExpiredRecheck();
        if (this.pendingContextClosures.get(authIndex) === "reauth") {
            if (this._hasActiveQueueForAuth(authIndex)) {
                throw new Error(
                    `Account #${authIndex} is finishing its previous requests before reauthentication takes effect.`
                );
            }
            await this._closePendingContextIfIdle(authIndex);
        }

        this._cancelPendingContextClosure(authIndex, "context_reused");

        // [Auth Switch] Save current auth data before switching
        if (this.browser && this._currentAuthIndex >= 0 && this._currentAuthIndex !== authIndex) {
            try {
                await this._updateAuthFile(this._currentAuthIndex);
            } catch (e) {
                this.logger.warn(`[Browser] Failed to save current auth during switch: ${e.message}`);
            }
        }

        // Wait for background initialization if in progress
        if (this.initializingContexts.has(authIndex)) {
            this.logger.info(`[Browser] Context #${authIndex} is being initialized in background, waiting...`);
            await this._waitForContextInit(authIndex);
        }

        // Check if browser is running, launch if needed
        if (!this.browser) {
            await this._ensureBrowser();
        }

        // Check if context already exists (fast switch path)
        if (this.contexts.has(authIndex)) {
            this.logger.info("==================================================");
            this.logger.info(`⚡ [FastSwitch] Switching to pre-loaded context for account #${authIndex}`);
            this.logger.info("==================================================");

            // Validate that the page is still alive before switching
            const contextData = this.contexts.get(authIndex);
            if (!contextData || !contextData.page || contextData.page.isClosed()) {
                this.logger.warn(
                    `[FastSwitch] Page for account #${authIndex} is closed, cleaning up and re-initializing...`
                );
                // Clean up the dead context
                await this.closeContext(authIndex);
                // Fall through to slow path to re-initialize
            } else {
                // Quick auth status check without navigation
                try {
                    await this._checkPageStatusAndErrors(contextData.page, `[FastSwitch#${authIndex}]`, authIndex);
                    if (this.authSource.isExpired(authIndex)) {
                        this.logger.info(`[FastSwitch] Account #${authIndex} recovered; restoring rotation.`);
                        await this.authSource.unmarkAsExpired(authIndex);
                    }

                    // Page is alive and auth is valid, proceed with fast switch
                    // Switch to new context
                    this._activateContext(contextData.context, contextData.page, authIndex);
                    await this._flushPendingContextClosures();

                    this.logger.info(`✅ [FastSwitch] Switched to account #${authIndex} instantly!`);
                    return;
                } catch (error) {
                    // Check if this is an auth expiration error
                    const isAuthExpired = isAuthExpiredError(error);

                    if (isAuthExpired) {
                        await this.closeContext(authIndex);
                        throw error;
                    }

                    // For other errors, clean up and retry with slow path
                    this.logger.warn(
                        `[FastSwitch] Failed to check auth status for account #${authIndex}: ${error.message}, cleaning up and re-initializing...`
                    );
                    // Clean up the problematic context
                    await this.closeContext(authIndex);
                    // Fall through to slow path to re-initialize
                }
            }
        }

        // Context doesn't exist, need to initialize it (slow path)
        this.logger.info("==================================================");
        this.logger.info(`🔄 [Browser] Context for account #${authIndex} not found, initializing...`);
        this.logger.info("==================================================");

        // Check again if another caller started initializing while we were checking
        // This protects against race condition where multiple callers finish waiting
        // at the same time and all try to initialize the same context
        if (this.initializingContexts.has(authIndex)) {
            this.logger.info(`[Browser] Another caller is initializing context #${authIndex}, waiting...`);
            await this._waitForContextInit(authIndex);
            // After waiting, recursively call to use the fast path or retry
            return await this.launchOrSwitchContext(authIndex);
        }

        this.initializingContexts.add(authIndex);

        try {
            // Initialize new context (isBackgroundTask=false for foreground initialization)
            const { context, page } = await this._initializeContext(authIndex, false);

            this._activateContext(context, page, authIndex);
            await this._flushPendingContextClosures();

            // If this account was marked as expired but login succeeded, restore it
            if (this.authSource.isExpired(authIndex)) {
                this.logger.info(`[Browser] Account #${authIndex} was expired but login succeeded, restoring...`);
                await this.authSource.unmarkAsExpired(authIndex);
                // Note: rebalanceContextPool() will be called by the caller (AuthSwitcher)
            }

            this.logger.info("==================================================");
            this.logger.info(`✅ [Browser] Account ${authIndex} context initialized successfully!`);
            this.logger.info("✅ [Browser] Browser client is ready.");
            this.logger.info("==================================================");
        } catch (error) {
            this.logger.error(`❌ [Browser] Account ${authIndex} context initialization failed: ${error.message}`);
            // Debug artifacts are already saved in _initializeContext's catch block

            // Clean up if HealthMonitor was started
            if (this.contexts.has(authIndex)) {
                const contextData = this.contexts.get(authIndex);
                if (contextData.healthMonitorInterval) {
                    clearInterval(contextData.healthMonitorInterval);
                    this.logger.info(`[Browser] Cleaned up health monitor for failed context #${authIndex}`);
                }
            }

            // Reset state
            this.context = null;
            this.page = null;
            this._currentAuthIndex = -1;
            // DO NOT reset backgroundWakeupRunning here!
            // If a BackgroundWakeup was running, it will detect this.page === null and exit on its own.
            // Resetting the flag here could allow a new instance to start before the old one exits.

            throw error;
        }
    }

    /**
     * Lightweight Reconnect: Refreshes the page and clicks "Continue to the app" button
     * without restarting the entire browser instance.
     *
     * This method is called when WebSocket connection is lost but the browser
     * process is still running. It's much faster than a full browser restart.
     *
     * @returns {Promise<boolean>} true if reconnect was successful, false otherwise
     */
    /**
     * Attempt lightweight reconnect for a specific account
     * Refreshes the page and re-injects the proxy script without restarting the browser
     * @param {number} authIndex - The auth index to reconnect (defaults to current if not specified)
     * @returns {Promise<boolean>} true if reconnect was successful, false otherwise
     */
    async attemptLightweightReconnect(authIndex = null) {
        // Use provided authIndex or fall back to current
        const targetAuthIndex = authIndex !== null ? authIndex : this._currentAuthIndex;

        if (targetAuthIndex < 0) {
            this.logger.warn("[Reconnect] Invalid auth index, cannot perform lightweight reconnect.");
            return false;
        }

        // Get the context data for this account
        const contextData = this.contexts.get(targetAuthIndex);
        if (!contextData || !contextData.page) {
            this.logger.warn(
                `[Reconnect] No context found for account #${targetAuthIndex}, cannot perform lightweight reconnect.`
            );
            return false;
        }

        if (this._hasActiveQueueForAuth(targetAuthIndex)) {
            this.logger.info(`[Reconnect] Deferring account #${targetAuthIndex} reload until its requests drain.`);
            return false;
        }

        const page = contextData.page;
        const token = this._initializationTokens?.get(targetAuthIndex) || null;
        const deadline = Date.now() + (this._contextInitTimeoutMs || CONTEXT_INIT_TIMEOUT_MS);
        const reconnectStep = async (phase, operation, limit = BROWSER_RPC_TIMEOUT_MS) => {
            if (this.contexts.get(targetAuthIndex) !== contextData)
                throw new ContextAbortedError(targetAuthIndex, "reconnect context replaced");
            this._runtime(targetAuthIndex, "reconnecting", "connection_recovery", phase);
            const result = await this._bounded(
                operation,
                Math.min(limit, Math.max(1, deadline - Date.now())),
                `Reconnect #${targetAuthIndex} ${phase}`,
                token
            );
            if (this.contexts.get(targetAuthIndex) !== contextData)
                throw new ContextAbortedError(targetAuthIndex, "reconnect context replaced");
            return result;
        };

        // Verify browser and page are still valid
        if (!this.browser || !page) {
            this.logger.warn(
                `[Reconnect] Browser or page is not available for account #${targetAuthIndex}, cannot perform lightweight reconnect.`
            );
            return false;
        }

        // Check if page is closed
        if (page.isClosed()) {
            this.logger.warn(
                `[Reconnect] Page is closed for account #${targetAuthIndex}, cannot perform lightweight reconnect.`
            );
            return false;
        }

        this.logger.info("==================================================");
        this.logger.info(`🔄 [Reconnect] Starting lightweight reconnect for account #${targetAuthIndex}...`);
        this.logger.info("==================================================");

        // Only this account's services pause during its navigation.
        if (contextData.healthMonitorInterval) {
            clearInterval(contextData.healthMonitorInterval);
            contextData.healthMonitorInterval = null;
        }

        try {
            // Reset per-context WebSocket state to ensure clean state for reconnection
            this._wsInitState.set(targetAuthIndex, { failed: false, success: false });
            this.logger.info("[Reconnect] Reset WebSocket initialization state");

            // Navigate to target page and wake it up
            await reconnectStep("navigate", () => this._navigateAndWakeUpPage(page, "[Reconnect]"), 185000);

            // Check for cookie expiration, region restrictions, and other errors
            await reconnectStep(
                "check_identity",
                () => this._checkPageStatusAndErrors(page, "[Reconnect]", targetAuthIndex, token),
                60000
            );

            // Wait for WebSocket initialization (no retry)
            // Check if initialization already succeeded (console listener may have detected it)
            const wsState = this._wsInitState.get(targetAuthIndex);
            if (wsState && wsState.success) {
                this.logger.info(`[Reconnect] ✅ WebSocket already initialized, skipping wait`);
            } else {
                // Wait for WebSocket initialization (120 second timeout)
                const initSuccess = await reconnectStep(
                    "wait_websocket",
                    () => this._waitForWebSocketInit(page, "[Reconnect]", WS_INIT_TIMEOUT_MS, targetAuthIndex, false),
                    this._webSocketInitTimeoutMs || WS_INIT_TIMEOUT_MS
                );

                if (!initSuccess) {
                    this.logger.error("[Reconnect] WebSocket initialization failed.");
                    return false;
                }
            }

            this._sendActiveTrigger("[Reconnect]", page);

            // [Auth Update] Save the refreshed cookies to the auth file immediately
            await reconnectStep(
                "save_auth",
                () => this._updateAuthFile(targetAuthIndex),
                this._cleanupTimeoutMs || CONTEXT_CLEANUP_TIMEOUT_MS
            );

            this.logger.info("==================================================");
            this.logger.info(`✅ [Reconnect] Lightweight reconnect successful for account #${targetAuthIndex}!`);
            this.logger.info("==================================================");

            this.notifyUserActivity(targetAuthIndex);
            this._startHealthMonitor(targetAuthIndex);
            this._startBackgroundWakeup(targetAuthIndex);
            this._runtime(targetAuthIndex, "ready", null);

            return true;
        } catch (error) {
            // Check if this is an abort error (context was deleted during reconnect)
            const isAbortError = isContextAbortedError(error);
            // Check if this is an auth expiration error
            const isAuthExpired = isAuthExpiredError(error);

            if (isAbortError) {
                this.logger.info(
                    `[Reconnect] Lightweight reconnect aborted for account #${targetAuthIndex} (context deleted)`
                );
                return false;
            }

            if (isAuthExpired) {
                this.logger.error(
                    `❌ [Reconnect] Lightweight reconnect failed for account #${targetAuthIndex} (auth expired)`
                );
                // Auth is already marked as expired in _checkPageStatusAndErrors
                await this._cleanupOperation(
                    () => this._saveDebugArtifacts("reconnect_expired", targetAuthIndex, page),
                    `Save reconnect diagnostics #${targetAuthIndex}`
                );
                // Close context for expired auth - it needs full re-initialization
                await this.closeContext(targetAuthIndex);
                return false;
            }

            this.logger.error(
                `❌ [Reconnect] Lightweight reconnect failed for account #${targetAuthIndex}: ${error.message}`
            );
            await this._cleanupOperation(
                () => this._saveDebugArtifacts("reconnect_failed", targetAuthIndex, page),
                `Save reconnect diagnostics #${targetAuthIndex}`
            );
            this._backOffCandidate(targetAuthIndex, error);
            // Keep context for non-expired failures - next request will try to refresh the page
            return false;
        }
    }

    /**
     * Close a single context for a specific account
     *
     * IMPORTANT: When deleting an account, always call this method BEFORE closeConnectionByAuth()
     * Calling order: closeContext() -> closeConnectionByAuth()
     *
     * Reason: This method removes the context from the contexts Map BEFORE closing it.
     * When context.close() triggers WebSocket disconnect, ConnectionRegistry._removeConnection()
     * will check if the context still exists. If not found, it skips reconnect logic.
     * If you call closeConnectionByAuth() first, _removeConnection() will see the context
     * still exists and may trigger unnecessary reconnect attempts.
     *
     * @param {number} authIndex - The auth index to close
     */
    async closeContext(authIndex) {
        this._contextCloseTasks ||= new Map();
        if (this._contextCloseTasks.has(authIndex)) return this._contextCloseTasks.get(authIndex);
        const task = this._closeContextWithRefresh(authIndex);
        this._contextCloseTasks.set(authIndex, task);
        try {
            return await task;
        } finally {
            if (this._contextCloseTasks.get(authIndex) === task) this._contextCloseTasks.delete(authIndex);
        }
    }

    async _closeContextWithRefresh(authIndex) {
        const pendingReauth = this.pendingContextClosures.get(authIndex) === "reauth";
        try {
            return await this._closeContextImpl(authIndex);
        } finally {
            if (pendingReauth && !this.contexts.has(authIndex) && !this.initializingContexts.has(authIndex)) {
                this.pendingContextClosures.delete(authIndex);
                this.resumeAuthUpdates(authIndex);
            } else if (pendingReauth) {
                this.pendingContextClosures.set(authIndex, "reauth");
            }
        }
    }

    async _closeContextImpl(authIndex) {
        this.pendingContextClosures.delete(authIndex);

        // If context is being initialized in background, signal abort and wait
        if (this.initializingContexts.has(authIndex)) {
            this.logger.info(`[Browser] Context #${authIndex} is being initialized, marking for abort and waiting...`);
            this.abortedContexts.add(authIndex);
            this._initializationTokens?.get(authIndex)?.cancel?.();
            await this._cleanupOperation(
                () => this._waitForContextInit(authIndex),
                `Wait for cancelled initialization #${authIndex}`
            );
            this.abortedContexts.delete(authIndex);
        }

        if (!this.contexts.has(authIndex)) {
            // Context doesn't exist (was never initialized or was aborted)
            // Still check if we need to close the browser
            // Only close if there are no contexts AND no contexts being initialized
            if (
                this.contexts.size === 0 &&
                this.initializingContexts.size === 0 &&
                this.browser &&
                !(this.authSource.availableIndices?.length > 0) &&
                !this.isClosingIntentionally
            ) {
                if (this._expiredRecheckBrowser === this.browser) this._recheckBrowserOrphaned = true;
                else {
                    this.logger.info(`[Browser] All contexts closed, closing browser instance...`);
                    await this.closeBrowser();
                }
            }
            return;
        }

        const contextData = this.contexts.get(authIndex);

        // A still-valid context may have received renewed cookies. Save before discarding it,
        // but never overwrite a newly reauthenticated file with an old context snapshot.
        if (
            !this._authUpdateSuspended.has(authIndex) &&
            !this.authSource.isExpired(authIndex) &&
            !contextData.page?.isClosed()
        ) {
            try {
                const identity = await this._readPageIdentity(contextData.page, `[Context#${authIndex}]`);
                if (!this._isLoginPage(identity.currentUrl, identity.pageTitle))
                    await this._cleanupOperation(
                        () => this._updateAuthFile(authIndex),
                        `Save account before close #${authIndex}`
                    );
            } catch (error) {
                this.logger.warn(
                    `[Auth Update] Could not save auth #${authIndex} before context close: ${error.message}`
                );
            }
        }

        // Stop health monitor for this context
        if (contextData.healthMonitorInterval) {
            clearInterval(contextData.healthMonitorInterval);
            contextData.healthMonitorInterval = null;
            this.logger.info(`[Browser] Stopped health monitor for context #${authIndex}`);
        }

        // Remove from contexts map FIRST, before closing context
        // This ensures that when context.close() triggers WebSocket disconnect,
        // _removeConnection will see that the context is already gone and skip reconnect logic
        this.contexts.delete(authIndex);
        this._initializationTokens?.get(authIndex)?.cancel?.();
        if (
            this.contexts.size === 0 &&
            this.initializingContexts.size === 0 &&
            this.browser &&
            this._expiredRecheckBrowser === this.browser
        ) {
            this._recheckBrowserOrphaned = true;
        }

        // Proactively close message queues BEFORE closing context to prevent race condition
        // Race condition: context.close() triggers async WebSocket 'close' event, which calls _removeConnection()
        // But _removeConnection() executes later in event loop, after switchAccount() may have updated currentAuthIndex
        // So we must close queues NOW for ANY account being closed (current or not)
        if (this.connectionRegistry) {
            const isCurrent = this._currentAuthIndex === authIndex;
            this.logger.info(
                `[Browser] Proactively closing message queues for account #${authIndex}${isCurrent ? " (current account)" : ""}`
            );
            this.connectionRegistry.closeMessageQueuesForAuth(authIndex, "context_closed");
        }

        // If this was the current context, reset current references
        if (this._currentAuthIndex === authIndex) {
            this.context = null;
            this.page = null;
            this._currentAuthIndex = -1;
            // DO NOT reset backgroundWakeupRunning here!
            // If a BackgroundWakeup was running, it will detect this.page === null and exit on its own.
            // Resetting the flag here could allow a new instance to start before the old one exits.
            this.logger.debug(`[Browser] Current context was closed, currentAuthIndex reset to -1.`);
        }

        // Close the context AFTER removing from map
        try {
            if (contextData.context) {
                await this._cleanupOperation(() => contextData.context.close(), `Close context #${authIndex}`);
                this.logger.info(`[Browser] Context #${authIndex} closed.`);
            }
        } catch (e) {
            this.logger.warn(`[Browser] Error closing context #${authIndex}: ${e.message}`);
        }

        // If this was the last context, close the browser to free resources
        // This ensures a clean state when all accounts are deleted
        // Only close if there are no contexts AND no contexts being initialized
        if (
            this.contexts.size === 0 &&
            this.initializingContexts.size === 0 &&
            this.browser &&
            !(this.authSource.availableIndices?.length > 0) &&
            !this.isClosingIntentionally
        ) {
            if (this._expiredRecheckBrowser === this.browser) this._recheckBrowserOrphaned = true;
            else {
                this.logger.info(`[Browser] All contexts closed, closing browser instance...`);
                await this.closeBrowser();
            }
        }
    }

    /**
     * Helper: Clean up all context resources (health monitors, etc.)
     * Called when browser is closing or has disconnected
     */
    _cleanupAllContexts() {
        this._stopPoolMaintenance();
        for (const token of this._initializationTokens?.values() || []) token.cancel?.();
        this._initializationTokens?.clear();
        this._recheckConnectionGenerations?.clear();
        // Clean up all context health monitors
        for (const [authIndex, contextData] of this.contexts.entries()) {
            if (contextData.healthMonitorInterval) {
                clearInterval(contextData.healthMonitorInterval);
                contextData.healthMonitorInterval = null;
                this.logger.info(`[Browser] Stopped health monitor for context #${authIndex}`);
            }
        }

        for (const authIndex of [...(this.authSource.pendingRefreshIndices || [])]) {
            this.resumeAuthUpdates(authIndex);
        }

        // Reset all references
        this.contexts.clear();
        this.initializingContexts.clear();
        this.abortedContexts.clear();
        this.pendingContextClosures.clear();
        this._wsInitState.clear();
        this.context = null;
        this.page = null;
        this._currentAuthIndex = -1;
        // DO NOT reset backgroundWakeupRunning here!
        // If a BackgroundWakeup was running, it will detect this.page === null and exit on its own.
        // Resetting the flag here could allow a new instance to start before the old one exits.
    }

    /**
     * Unified cleanup method for the main browser instance.
     * Handles intervals, timeouts, and resetting all references.
     * In multi-context mode, cleans up all contexts.
     */
    async closeBrowser() {
        // Set flag to indicate intentional close - prevents ConnectionRegistry from
        // attempting lightweight reconnect when WebSocket disconnects
        this.isClosingIntentionally = true;
        this._stopPoolMaintenance();
        this._backgroundPreloadAbort = true;
        for (const token of this._initializationTokens?.values() || []) token.cancel?.();

        // Legacy single health monitor cleanup (for backward compatibility)
        if (this.healthMonitorInterval) {
            clearInterval(this.healthMonitorInterval);
            this.healthMonitorInterval = null;
        }

        const browser = this.browser;
        if (browser) {
            this.logger.debug("[Browser] Closing main browser instance and all contexts...");
            for (const authIndex of this.contexts.keys()) {
                if (this.authSource.isExpired(authIndex) || this._authUpdateSuspended.has(authIndex)) continue;
                const page = this.contexts.get(authIndex)?.page;
                if (!page || page.isClosed()) continue;
                try {
                    const identity = await this._readPageIdentity(page, `[Context#${authIndex}]`);
                    if (!this._isLoginPage(identity.currentUrl, identity.pageTitle))
                        await this._cleanupOperation(
                            () => this._updateAuthFile(authIndex),
                            `Save account before browser close #${authIndex}`
                        );
                } catch (error) {
                    this.logger.warn(
                        `[Auth Update] Could not save auth #${authIndex} before browser close: ${error.message}`
                    );
                }
            }
            try {
                // Give close() 5 seconds, otherwise force proceed
                const closePromise = browser.close();
                // Attach a catch handler to prevent unhandled rejection if timeout wins
                closePromise.catch(() => {
                    // Silently ignore - the timeout will handle this
                });
                await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 5000))]);
            } catch (e) {
                this.logger.warn(`[Browser] Error during close (ignored): ${e.message}`);
            }

            if (this.browser === browser) {
                this.browser = null;
                this._cleanupAllContexts();
                this.logger.debug(
                    "[Browser] Main browser instance and all contexts closed, currentAuthIndex reset to -1."
                );
            }
        }

        // Reset flag after close is complete
        this.isClosingIntentionally = false;
    }

    async switchAccount(newAuthIndex) {
        this.logger.info(`🔄 [Browser] Starting account switch: from ${this._currentAuthIndex} to ${newAuthIndex}`);
        await this.launchOrSwitchContext(newAuthIndex);
        this.logger.info(`✅ [Browser] Account switch completed, current account: ${this._currentAuthIndex}`);
    }
}

module.exports = BrowserManager;
