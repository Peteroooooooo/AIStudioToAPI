const fs = require("fs");
const path = require("path");

// Account availability is kept apart from auth cookies so a transient failure never rewrites credentials.
class AccountHealth {
    constructor(logger, filePath = path.join(process.cwd(), "data", "account-health.json"), now = Date.now) {
        this.logger = logger;
        this.filePath = filePath;
        this.now = now;
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
        return {
            consecutiveFailures: record.consecutiveFailures || 0,
            lastFailureAt: record.lastFailureAt || null,
            lastStatus: record.lastStatus || null,
            mode,
            until: mode === "cooldown" ? record.until : null,
        };
    }

    isAvailable(index) {
        return this.getStatus(index).mode === "active";
    }

    recordFailure(index, status, requestId = null) {
        if (!Number.isInteger(index) || index < 0) return this.getStatus(index);
        const code = Number(status);
        // Request format, model and ambiguous permission errors do not prove an account is unhealthy.
        if (![401, 429, 502, 503, 504].includes(code)) return this.getStatus(index);
        const previous = this.accounts[index] || {};
        if (requestId && previous.lastRequestId === requestId && previous.lastStatus === code) {
            return this.getStatus(index);
        }
        if (previous.mode === "disabled" || previous.mode === "reauth") return this.getStatus(index);

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
        };
        if (code === 401 && consecutiveFailures >= 2) {
            record.mode = "reauth";
            record.until = null;
        } else if (code === 429 || (code >= 502 && consecutiveFailures >= 3)) {
            const cooldownLevel = Math.min((previous.cooldownLevel || 0) + 1, 4);
            const baseMs = code === 429 ? 5 * 60 * 1000 : 60 * 1000;
            record.mode = "cooldown";
            record.cooldownLevel = cooldownLevel;
            record.until = now + baseMs * 2 ** (cooldownLevel - 1);
        } else if (this.getStatus(index).mode === "active") {
            record.mode = "active";
            record.until = null;
        }
        this.accounts[index] = record;
        this._save();
        if (record.mode !== "active") {
            this.logger.warn(
                `[Auth] Account #${index} ${record.mode} after HTTP ${code}${record.until ? ` until ${new Date(record.until).toISOString()}` : ""}`
            );
        }
        return this.getStatus(index);
    }

    recordSuccess(index) {
        const previous = this.accounts[index];
        if (!previous || this.getStatus(index).mode !== "active") return;
        if (!previous.consecutiveFailures && !previous.cooldownLevel) return;
        this.accounts[index] = { mode: "active" };
        this._save();
    }

    setDisabled(index, disabled) {
        this.accounts[index] = disabled ? { mode: "disabled" } : { mode: "active" };
        this._save();
        return this.getStatus(index);
    }

    reset(index) {
        this.accounts[index] = { mode: "active" };
        this._save();
        return this.getStatus(index);
    }

    remove(index) {
        if (this.accounts[index]) {
            delete this.accounts[index];
            this._save();
        }
    }
}

module.exports = AccountHealth;
