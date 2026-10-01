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
        // Only an actual dispatched business request can occupy a recovery probe.
        // Probes are not persisted: after restart no previous request remains alive.
        this.probes = new Map();
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
        const record = this.accounts[index] || {};
        const mode = record.mode === "cooldown" && record.until <= this.now() ? "active" : record.mode || "active";
        const probeRequired =
            record.mode === "cooldown" &&
            mode === "active" &&
            (record.rateLimitProbeRequired || record.cooldownReason === "rate-limit" || record.lastStatus === 429);
        return {
            consecutiveFailures: record.consecutiveFailures || 0,
            lastFailureAt: record.lastFailureAt || null,
            lastStatus: record.lastStatus || null,
            mode,
            probeInFlight: probeRequired && Boolean(this.probes?.has(index)),
            probeRequired,
            until: mode === "cooldown" || probeRequired ? record.until : null,
        };
    }

    isAvailable(index) {
        return this.getStatus(index).mode === "active";
    }

    getEpoch(index) {
        return this.epochs?.get(index) || 0;
    }

    _advanceEpoch(index) {
        this.epochs ||= new Map();
        this.epochs.set(index, this.getEpoch(index) + 1);
    }

    tryAcquireProbe(index, requestId) {
        const status = this.getStatus(index);
        if (status.mode !== "active") return false;
        if (!status.probeRequired) return true;
        this.probes ||= new Map();
        if (!requestId || this.probes.has(index)) return false;
        this.probes.set(index, requestId);
        return true;
    }

    releaseProbe(index, requestId) {
        if (this.probes?.get(index) === requestId) this.probes?.delete(index);
    }

    recordFailure(index, status, requestId = null, epoch = undefined) {
        if (!Number.isInteger(index) || index < 0) return this.getStatus(index);
        if (epoch !== undefined && epoch !== this.getEpoch(index)) return this.getStatus(index);
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
        if (previous.mode === "disabled" || previous.mode === "reauth") return this.getStatus(index);

        // Responses already in flight before a 429 cannot change that cooldown,
        // even if they arrive after its deadline. Only the reserved probe can.
        const rateLimitCooldown =
            previous.mode === "cooldown" &&
            (previous.rateLimitProbeRequired ||
                previous.cooldownReason === "rate-limit" ||
                previous.lastStatus === 429);
        const isProbe = requestId && this.probes?.get(index) === requestId;
        if (rateLimitCooldown && (!isProbe || previous.until > this.now())) return this.getStatus(index);
        if (isProbe) this.releaseProbe(index, requestId);

        const now = this.now();
        const recent = previous.lastFailureAt && now - previous.lastFailureAt < 10 * 60 * 1000;
        const consecutiveFailures =
            recent && previous.lastStatus === code ? (previous.consecutiveFailures || 0) + 1 : 1;
        const record = {
            ...previous,
            consecutiveFailures,
            lastFailureAt: now,
            lastRequestId: requestId,
            lastStatus: code,
            rateLimitProbeRequired: rateLimitCooldown,
        };
        if (code === 401 && consecutiveFailures >= 2) {
            record.mode = "reauth";
            record.until = null;
        } else if (code === 429) {
            const seconds = this.config?.rateLimitCooldownSeconds;
            const cooldownSeconds = Number.isInteger(seconds) && seconds > 0 ? seconds : 18000;
            record.mode = "cooldown";
            record.cooldownReason = "rate-limit";
            record.rateLimitProbeRequired = true;
            record.until = now + cooldownSeconds * 1000;
        } else if (code >= 502 && consecutiveFailures >= 3) {
            const cooldownLevel = Math.min((previous.cooldownLevel || 0) + 1, 4);
            record.mode = "cooldown";
            record.cooldownReason = "transient";
            record.cooldownLevel = cooldownLevel;
            record.until = now + 60 * 1000 * 2 ** (cooldownLevel - 1);
        } else if (!rateLimitCooldown && this.getStatus(index).mode === "active") {
            record.mode = "active";
            record.until = null;
        }
        this.accounts[index] = record;
        if (code === 429 || (record.mode !== "active" && record.mode !== previous.mode)) this._advanceEpoch(index);
        this._save();
        if (record.mode !== "active") {
            this.logger.warn(
                `[Auth] Account #${index} ${record.mode} after HTTP ${code}${record.until ? ` until ${new Date(record.until).toISOString()}` : ""}`
            );
        }
        return this.getStatus(index);
    }

    recordSuccess(index, requestId = null, epoch = undefined) {
        if (epoch !== undefined && epoch !== this.getEpoch(index)) return;
        const previous = this.accounts[index];
        if (!previous || this.getStatus(index).mode !== "active") return;
        if (this.getStatus(index).probeRequired) {
            if (!requestId || this.probes?.get(index) !== requestId) return;
            this.releaseProbe(index, requestId);
            this._advanceEpoch(index);
        }
        if (!previous.consecutiveFailures && !previous.cooldownLevel) return;
        this.accounts[index] = { mode: "active" };
        this._save();
    }

    setDisabled(index, disabled) {
        this._advanceEpoch(index);
        this.probes?.delete(index);
        this.accounts[index] = disabled ? { mode: "disabled" } : { mode: "active" };
        this._save();
        return this.getStatus(index);
    }

    reset(index) {
        this._advanceEpoch(index);
        this.probes?.delete(index);
        this.accounts[index] = { mode: "active" };
        this._save();
        return this.getStatus(index);
    }

    remove(index) {
        this._advanceEpoch(index);
        this.probes?.delete(index);
        if (this.accounts[index]) {
            delete this.accounts[index];
            this._save();
        }
    }
}

module.exports = AccountHealth;
