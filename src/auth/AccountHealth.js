const fs = require("fs");
const path = require("path");

// Account availability is kept apart from auth cookies so a transient failure never rewrites credentials.
class AccountHealth {
    constructor(
        logger,
        filePath = path.join(process.cwd(), "data", "account-health.json"),
        now = Date.now,
        config = {}
    ) {
        this.logger = logger;
        this.filePath = filePath;
        this.now = now;
        this.config = config;
        // Tests temporarily reserve an account without changing the user's switch.
        this.manualProbes = new Map();
        this.epochs = new Map();
        this.accounts = {};
        try {
            const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (saved.version === 1 && saved.accounts && typeof saved.accounts === "object") {
                this.accounts = saved.accounts;
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                this.logger.warn(`[Auth] Could not load account health: ${error.message}`);
            }
        }
        let migrated = false;
        for (const record of Object.values(this.accounts)) {
            if (record.mode === "cooldown") {
                record.mode = "disabled";
                record.disabledBy = "auto";
                migrated = true;
            } else if (record.mode === "disabled" && !record.disabledBy) {
                record.disabledBy = "manual";
                record.until = null;
                migrated = true;
            }
            if (record.disabledBy === "auto" && !record.disabledStatus) {
                record.disabledStatus = record.cooldownReason === "rate-limit" ? 429 : record.lastStatus || null;
                migrated = true;
            }
        }
        if (migrated) this._save();
    }

    _save() {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { mode: 0o700, recursive: true });
            const temporary = `${this.filePath}.${process.pid}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify({ accounts: this.accounts, version: 1 }), { mode: 0o600 });
            fs.renameSync(temporary, this.filePath);
        } catch (error) {
            this.logger.error(`[Auth] Could not save account health: ${error.message}`);
        }
    }

    getStatus(index) {
        let record = this.accounts[index] || {};
        if (
            record.mode === "disabled" &&
            record.disabledBy === "auto" &&
            Number.isFinite(record.until) &&
            record.until <= this.now() &&
            !this.manualProbes.has(index)
        ) {
            this._advanceEpoch(index);
            record = { ...record, consecutiveFailures: 0, disabledBy: null, mode: "active", until: null };
            this.accounts[index] = record;
            this._save();
        }
        const mode = record.mode || "active";
        return {
            consecutiveFailures: record.consecutiveFailures || 0,
            cooldownReason: record.cooldownReason || null,
            disabledBy: record.disabledBy || null,
            disabledStatus: record.disabledStatus || null,
            enabled: mode === "active",
            failureModel: record.failureModel || null,
            lastFailureAt: record.lastFailureAt || null,
            lastStatus: record.lastStatus || null,
            mode,
            probeInFlight: this.manualProbes.has(index),
            probeRequired: false,
            until: mode === "disabled" && record.disabledBy === "auto" ? record.until : null,
        };
    }

    isAvailable(index) {
        return this.getStatus(index).enabled && !this.manualProbes.has(index);
    }

    getEpoch(index) {
        return this.epochs?.get(index) || 0;
    }

    _advanceEpoch(index) {
        this.epochs ||= new Map();
        this.manualProbes?.delete(index);
        this.epochs.set(index, this.getEpoch(index) + 1);
    }

    tryAcquireProbe(index, requestId) {
        if (this.manualProbes.has(index)) return this.isManualProbe(index, requestId);
        return this.isAvailable(index);
    }

    releaseProbe() {}

    beginManualProbe(index, requestId, model) {
        const status = this.getStatus(index);
        if (status.mode === "reauth" || this.manualProbes.has(index)) return false;
        this._advanceEpoch(index);
        this.manualProbes.set(index, { enabled: status.enabled, epoch: this.getEpoch(index), model, requestId });
        return true;
    }

    isManualProbe(index, requestId) {
        const probe = this.manualProbes?.get(index);
        return Boolean(probe && probe.requestId === requestId && probe.epoch === this.getEpoch(index));
    }

    finishManualProbe(index, requestId, { success = false, status, transportFailure = false } = {}) {
        if (!this.isManualProbe(index, requestId)) return false;
        const probe = this.manualProbes.get(index);
        const previous = this.accounts[index] || {};
        this.manualProbes.delete(index);
        if (success) {
            if (probe.enabled) this.recordSuccess(index, requestId, probe.epoch);
            return probe.enabled;
        }
        if (!status) return false; // Cancellation / preparation refusal leaves health unchanged.
        if (!probe.enabled) {
            // A diagnostic test on a stopped account cannot move its restore deadline or switch.
            this.accounts[index] = {
                ...previous,
                failureModel: probe.model,
                lastFailureAt: this.now(),
                lastRequestId: requestId,
                lastStatus: Number(status),
            };
            this._save();
            return false;
        }
        this.recordFailure(index, status, requestId, probe.epoch, {
            model: probe.model,
            transportFailure,
        });
        return false;
    }

    recordFailure(index, status, requestId = null, epoch = undefined, options = {}) {
        if (!Number.isInteger(index) || index < 0) return this.getStatus(index);
        const current = this.getStatus(index);
        if (epoch !== undefined && epoch !== this.getEpoch(index)) return current;
        const code = Number(status);
        // Request format, model and ambiguous permission errors do not prove an account is unhealthy.
        if (![401, 429, 502, 503, 504].includes(code)) {
            this.releaseProbe(index, requestId);
            return this.getStatus(index);
        }
        const previous = this.accounts[index] || {};
        if (requestId && previous.lastRequestId === requestId && previous.lastStatus === code) {
            return this.getStatus(index);
        }
        if (!current.enabled) return current;

        const now = this.now();
        const recent = previous.lastFailureAt && now - previous.lastFailureAt < 10 * 60 * 1000;
        const consecutiveFailures =
            recent && previous.lastStatus === code ? (previous.consecutiveFailures || 0) + 1 : 1;
        const record = {
            ...previous,
            consecutiveFailures,
            disabledBy: null,
            failureModel: options.model || previous.failureModel || null,
            lastFailureAt: now,
            lastRequestId: requestId,
            lastStatus: code,
            mode: "active",
            until: null,
        };
        if (code === 401 && consecutiveFailures >= 2) {
            record.mode = "reauth";
            record.disabledBy = "auto";
            record.until = null;
        } else if (code === 429) {
            const seconds = this.config?.rateLimitCooldownSeconds;
            const cooldownSeconds = Number.isInteger(seconds) && seconds > 0 ? seconds : 18000;
            record.mode = "disabled";
            record.disabledBy = "auto";
            record.cooldownReason = "rate-limit";
            record.until = now + cooldownSeconds * 1000;
        } else if (code >= 502 && (consecutiveFailures >= 3 || options.transportFailure)) {
            record.mode = "disabled";
            record.disabledBy = "auto";
            record.cooldownReason = "transient";
            record.until = now + 60 * 1000;
        }
        this.accounts[index] = record;
        if (record.mode !== "active") {
            record.disabledStatus = code;
            this._advanceEpoch(index);
        }
        this._save();
        if (record.mode !== "active") {
            this.logger.warn(
                `[Auth] Account #${index} ${record.mode} after HTTP ${code}${record.until ? ` until ${new Date(record.until).toISOString()}` : ""}`
            );
        }
        return this.getStatus(index);
    }

    recordSuccess(index, ...outcome) {
        const epoch = outcome[1];
        const current = this.getStatus(index);
        if (epoch !== undefined && epoch !== this.getEpoch(index)) return;
        const previous = this.accounts[index];
        if (!previous || !current.enabled || !previous.consecutiveFailures) return;
        this.accounts[index] = { ...previous, consecutiveFailures: 0 };
        this._save();
    }

    setDisabled(index, disabled) {
        this._advanceEpoch(index);
        this.accounts[index] = {
            ...this.accounts[index],
            consecutiveFailures: 0,
            cooldownReason: null,
            disabledBy: disabled ? "manual" : null,
            disabledStatus: null,
            mode: disabled ? "disabled" : "active",
            until: null,
        };
        this._save();
        return this.getStatus(index);
    }

    reset(index) {
        return this.setDisabled(index, false);
    }

    remove(index) {
        this._advanceEpoch(index);
        this.manualProbes?.delete(index);
        if (this.accounts[index]) {
            delete this.accounts[index];
            this._save();
        }
    }
}

module.exports = AccountHealth;
