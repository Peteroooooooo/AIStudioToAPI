const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { UserAbortedError } = require("../utils/CustomErrors");

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

function schedulerError(message, status = 503) {
    return Object.assign(new Error(message), { status, statusCode: status });
}

/** Conversation ownership is independent of Google cache expiry and browser load. */
class AccountScheduler {
    constructor(handler, { dataDir, clock = Date.now, maxOwners = 2048, maxWaiting = 128 } = {}) {
        this.handler = handler;
        this.clock = clock;
        this.maxOwners = maxOwners;
        this.maxWaiting = maxWaiting;
        this.owners = new Map();
        this.prefixes = new Map();
        this.resources = new Map();
        this.requests = new Map();
        this.recovering = new Set();
        this.cursor = -1;
        this.filePath = dataDir ? path.join(dataDir, "conversation-owners.json") : null;
        this.persistChain = Promise.resolve();
        this._load();
        handler.browserManager?.setAccountLoadProvider?.(index => this.getAccountLoad(index));
        handler.browserManager?.setAccountChangeNotifier?.(index => this.notifyAccountChange(index));
        handler.connectionRegistry?.on?.("connectionAdded", () => this._pump());
    }

    _hash(value) {
        return crypto.createHash("sha256").update(canonical(value)).digest("hex");
    }

    _load() {
        if (!this.filePath) return;
        try {
            const saved = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            if (saved.version !== 1) return;
            for (const [key, owner] of (saved.owners || []).slice(-this.maxOwners)) {
                if (typeof key === "string" && Number.isInteger(owner.authIndex) && owner.authIndex >= 0) {
                    this.owners.set(key, { ...owner, version: Number(owner.version) || 1 });
                }
            }
            for (const [prefix, key] of saved.prefixes || []) {
                if (this.owners.has(key)) this.prefixes.set(prefix, key);
            }
            for (const [key, binding] of (saved.resources || []).slice(-this.maxOwners)) {
                if (Number.isInteger(binding?.authIndex) && binding.authIndex >= 0) this.resources.set(key, binding);
            }
        } catch (error) {
            if (error.code !== "ENOENT")
                this.handler.logger?.warn(`[Accounts] Could not load conversation owners: ${error.message}`);
        }
    }

    _persist() {
        if (!this.filePath || this.persistTimer) return;
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.flush().catch(error =>
                this.handler.logger?.warn(`[Accounts] Could not persist owners: ${error.message}`)
            );
        }, 50);
        this.persistTimer.unref?.();
    }

    flush() {
        const snapshot = JSON.stringify({
            owners: [...this.owners],
            prefixes: [...this.prefixes],
            resources: [...this.resources],
            version: 1,
        });
        if (!this.filePath) return Promise.resolve();
        const write = async () => {
            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.promises.writeFile(`${this.filePath}.tmp`, snapshot);
            await fs.promises.rename(`${this.filePath}.tmp`, this.filePath);
        };
        this.persistChain = this.persistChain.catch(() => {}).then(write);
        return this.persistChain;
    }

    _identity(proxy, scope, sessionId) {
        let body;
        try {
            body = typeof proxy.body === "string" ? JSON.parse(proxy.body) : proxy.body || {};
        } catch {
            body = {};
        }
        const model = proxy.path?.match(/\/models\/([^:/?]+)/)?.[1] || body.model || "";
        const base = this._hash({
            model,
            scope,
            system: body.systemInstruction,
            toolConfig: body.toolConfig,
            tools: body.tools,
        });
        const contents = Array.isArray(body.contents) ? body.contents : [];
        const prefixHashes = [];
        // Incremental hashing avoids repeatedly serializing a growing history.
        const digest = crypto.createHash("sha256").update(base);
        for (const content of contents) {
            digest.update(canonical(content));
            prefixHashes.push(digest.copy().digest("hex"));
        }
        let key = sessionId ? this._hash({ base, sessionId }) : null;
        if (!key) {
            for (let index = prefixHashes.length - 1; index >= 0; index--) {
                const ownerKey = this.prefixes.get(prefixHashes[index]);
                if (this.owners.has(ownerKey)) {
                    key = ownerKey;
                    break;
                }
            }
        }
        key ||= prefixHashes.length
            ? prefixHashes[prefixHashes.length - 1]
            : this._hash({ base, requestId: proxy.request_id });
        return { body, explicit: Boolean(sessionId), key, prefixHashes };
    }

    _resourceNames(proxy, body) {
        const names = new Set();
        if (body.cachedContent) names.add(body.cachedContent);
        if (body.generateContentRequest?.cachedContent) names.add(body.generateContentRequest.cachedContent);
        const visit = value => {
            if (!value || typeof value !== "object") return;
            if (
                value.fileData?.fileUri &&
                /(?:generativelanguage\.googleapis\.com\/.*\/files\/|^files\/)/.test(value.fileData.fileUri)
            )
                names.add(value.fileData.fileUri);
            for (const child of Object.values(value)) if (typeof child === "object") visit(child);
        };
        visit(body);
        const resource = proxy.path?.match(/(?:cachedContents|files)\/[^/:?]+/)?.[0];
        if (resource) names.add(resource);
        const session = proxy.headers?.["x-goog-upload-url"];
        if (session) names.add(session);
        if (proxy.query_params?.upload_id) names.add(`upload-session:${proxy.query_params.upload_id}`);
        return [...names];
    }

    _resourceKey(scope, name) {
        // Normalize a File API URI and its short resource name to the same key.
        const normalized = name.match(/(?:cachedContents|files)\/[^/?]+/)?.[0] || name;
        return this._hash({ resource: normalized, scope });
    }

    _accountKey(authIndex) {
        const identity =
            this.handler.authSource.accountNameMap?.get(authIndex)?.trim().toLowerCase() || `index:${authIndex}`;
        return crypto
            .createHmac("sha256", this.handler.config?.sessionSecret || "local-account-owner")
            .update(identity)
            .digest("hex");
    }

    _sameAccount(binding) {
        return !binding.accountKey || binding.accountKey === this._accountKey(binding.authIndex);
    }

    recordResource(scope, name, authIndex) {
        if (typeof name !== "string" || !name || !Number.isInteger(authIndex)) return;
        this.resources.set(this._resourceKey(scope, name), { accountKey: this._accountKey(authIndex), authIndex });
        while (this.resources.size > this.maxOwners) this.resources.delete(this.resources.keys().next().value);
        this._persist();
    }

    _readyIndices() {
        return (this.handler.browserManager?.getReadyAccountIndices?.() || []).filter(index =>
            this.isAccountAvailable(index)
        );
    }

    isAccountAvailable(index) {
        const auth = this.handler.authSource;
        return (
            Number.isInteger(index) &&
            index >= 0 &&
            auth.health.isAvailable(index) &&
            !auth.isExpired?.(index) &&
            !auth.pendingRefreshIndices?.has(index) &&
            (this.handler.browserManager?.isAccountReady?.(index) ??
                Boolean(this.handler.connectionRegistry?.getConnectionByAuth(index, false)))
        );
    }

    _ownerCanWait(index) {
        const auth = this.handler.authSource;
        if (!auth.health.isAvailable(index) || auth.isExpired?.(index) || auth.pendingRefreshIndices?.has(index))
            return false;
        return (
            this.isAccountAvailable(index) ||
            this.recovering.has(index) ||
            this.handler.connectionRegistry?.isInGracePeriod?.(index) ||
            this.handler.connectionRegistry?.isReconnectingInProgress?.(index)
        );
    }

    getAccountLoad(authIndex) {
        let inFlight = 0,
            waiting = 0,
            conversations = 0;
        for (const request of this.requests.values()) {
            if (request.lease.authIndex === authIndex) {
                if (request.running) inFlight++;
                else if (request.waiter) waiting++;
            }
        }
        for (const owner of this.owners.values()) if (owner.authIndex === authIndex) conversations++;
        return { conversations, inFlight, waiting };
    }

    getSnapshot() {
        const indices = new Set([
            ...this._readyIndices(),
            ...[...this.requests.values()].map(request => request.lease.authIndex),
        ]);
        const accounts = [...indices].map(authIndex => ({ authIndex, ...this.getAccountLoad(authIndex) }));
        return {
            accounts,
            inFlight: accounts.reduce((n, a) => n + a.inFlight, 0),
            owners: this.owners.size,
            waiting: accounts.reduce((n, a) => n + a.waiting, 0),
        };
    }

    _choose(proxy, excluded = []) {
        const candidates = this._readyIndices().filter(index => !excluded.includes(index));
        if (!candidates.length)
            throw schedulerError("No serving account is available; retry after cooldown or reauthentication.");
        const cached =
            this.handler.cacheManager?.findOwnerCandidates?.(proxy, candidates, { scope: proxy.cache_scope }) || [];
        if (cached.length) return cached[0].authIndex;
        candidates.sort((left, right) => {
            const a = this.getAccountLoad(left),
                b = this.getAccountLoad(right);
            return (
                a.inFlight + a.waiting - (b.inFlight + b.waiting) ||
                a.conversations - b.conversations ||
                Number(left <= this.cursor) - Number(right <= this.cursor) ||
                left - right
            );
        });
        this.cursor = candidates[0];
        return candidates[0];
    }

    _trimOwners() {
        if (this.owners.size < this.maxOwners) return;
        const active = new Set([...this.requests.values()].map(request => request.lease.key));
        const oldest = [...this.owners]
            .filter(([key]) => !active.has(key))
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!oldest) throw schedulerError("Conversation owner registry is busy; retry shortly.");
        this.owners.delete(oldest[0]);
        for (const [prefix, key] of this.prefixes) if (key === oldest[0]) this.prefixes.delete(prefix);
    }

    acquire(proxy, { scope = "anonymous", sessionId = null, signal, deadline } = {}) {
        if (signal?.aborted) return Promise.reject(new UserAbortedError());
        if (this.requests.has(proxy.request_id)) return Promise.reject(schedulerError("Duplicate request ID."));
        proxy.cache_scope = scope;
        const identity = this._identity(proxy, scope, sessionId);
        const ephemeral = proxy.is_generative === false;
        if (ephemeral) {
            identity.key = this._hash({ requestId: proxy.request_id, scope });
            identity.prefixHashes = [];
        }
        const resources = this._resourceNames(proxy, identity.body);
        const resourceOwners = resources.map(name => {
            const binding = this.resources.get(this._resourceKey(scope, name));
            return binding && this._sameAccount(binding) ? binding.authIndex : undefined;
        });
        if (resourceOwners.some(index => index === undefined))
            return Promise.reject(
                schedulerError(
                    "The owning account of this Google resource is unknown. Upload it through this API before using it.",
                    409
                )
            );
        if (new Set(resourceOwners).size > 1)
            return Promise.reject(schedulerError("Google resources from different accounts cannot be combined.", 409));
        let owner = this.owners.get(identity.key);
        if (owner && !this._sameAccount(owner)) {
            owner.authIndex = -1;
            owner.version++;
        }
        let selected;
        try {
            const pinned = resourceOwners[0];
            if (pinned !== undefined && !this.isAccountAvailable(pinned))
                throw schedulerError(
                    "The Google resource's account is unavailable; its resource cannot be replayed on another account."
                );
            selected = pinned ?? (owner && this._ownerCanWait(owner.authIndex) ? owner.authIndex : this._choose(proxy));
            if (!owner) {
                this._trimOwners();
                owner = {
                    accountKey: this._accountKey(selected),
                    authIndex: selected,
                    lastUsed: this.clock(),
                    version: 1,
                };
                this.owners.set(identity.key, owner);
            } else if (owner.authIndex !== selected) {
                owner.authIndex = selected;
                owner.accountKey = this._accountKey(selected);
                owner.version++;
            }
            owner.lastUsed = this.clock();
            if (!identity.explicit) {
                for (const prefix of identity.prefixHashes) {
                    // Only the complete incoming history identifies this turn; common first
                    // messages must not collapse independent multi-turn conversations.
                    if (prefix === identity.prefixHashes.at(-1)) {
                        this.prefixes.delete(prefix);
                        this.prefixes.set(prefix, identity.key);
                    }
                }
                while (this.prefixes.size > this.maxOwners * 4) this.prefixes.delete(this.prefixes.keys().next().value);
            }
            const lease = {
                authIndex: selected,
                key: identity.key,
                requestId: proxy.request_id,
                version: owner.version,
            };
            const request = {
                deadline: deadline || this.clock() + this.handler.timeouts.FAKE_STREAM,
                ephemeral,
                lease,
                pinned: resourceOwners.length > 0,
                proxy,
                running: false,
                signal,
            };
            this.requests.set(proxy.request_id, request);
            proxy.account_lease = lease;
            if (signal) {
                request.onAbort = () => this.cancel(proxy.request_id);
                signal.addEventListener("abort", request.onAbort, { once: true });
            }
            this._persist();
            return this._waitForSlot(request).catch(error => {
                this.release(proxy.request_id);
                throw error;
            });
        } catch (error) {
            return Promise.reject(error);
        }
    }

    _waitForSlot(request) {
        if (request.signal?.aborted) return Promise.reject(new UserAbortedError());
        if (this.clock() >= request.deadline)
            return Promise.reject(schedulerError("Account queue deadline exceeded.", 504));
        const load = this.getAccountLoad(request.lease.authIndex);
        const health = this.handler.authSource.health;
        if (
            this.isAccountAvailable(request.lease.authIndex) &&
            load.inFlight === 0 &&
            load.waiting === 0 &&
            (health.tryAcquireProbe?.(request.lease.authIndex, request.lease.requestId) ?? true)
        ) {
            request.running = true;
            return Promise.resolve(request.lease);
        }
        if ([...this.requests.values()].filter(item => item.waiter).length >= this.maxWaiting)
            return Promise.reject(schedulerError("Account request queue is full."));
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => {
                    this._rejectWaiter(request, schedulerError("Account queue deadline exceeded.", 504));
                    this.release(request.lease.requestId);
                },
                Math.max(1, request.deadline - this.clock())
            );
            request.waiter = { reject, resolve, timeout };
            if (!this.queuePollTimer) {
                this.queuePollTimer = setInterval(() => this._pump(), 100);
                this.queuePollTimer.unref?.();
            }
            this._pump();
        });
    }

    _rejectWaiter(request, error) {
        if (!request.waiter) return;
        clearTimeout(request.waiter.timeout);
        request.waiter.reject(error);
        request.waiter = null;
    }

    _moveOwner(request, excluded = []) {
        if (request.pinned)
            throw schedulerError("This request uses an account-owned Google resource and cannot migrate.");
        const owner = this.owners.get(request.lease.key);
        // Another queued request may already have migrated the conversation.
        const selected =
            owner && this.isAccountAvailable(owner.authIndex) && !excluded.includes(owner.authIndex)
                ? owner.authIndex
                : this._choose(request.proxy, excluded);
        if (owner.authIndex !== selected) {
            owner.authIndex = selected;
            owner.accountKey = this._accountKey(selected);
            owner.version++;
        }
        owner.lastUsed = this.clock();
        request.lease = { ...request.lease, authIndex: selected, version: owner.version };
        request.proxy.account_lease = request.lease;
        this._persist();
    }

    _pump() {
        for (const request of this.requests.values()) {
            if (!request.waiter) continue;
            try {
                const owner = this.owners.get(request.lease.key);
                if (
                    !this._ownerCanWait(request.lease.authIndex) ||
                    owner.authIndex !== request.lease.authIndex ||
                    owner.version !== request.lease.version
                )
                    this._moveOwner(request);
                const index = request.lease.authIndex;
                if (!this.isAccountAvailable(index)) continue;
                if (
                    this.getAccountLoad(index).inFlight ||
                    !(this.handler.authSource.health.tryAcquireProbe?.(index, request.lease.requestId) ?? true)
                )
                    continue;
                const waiter = request.waiter;
                clearTimeout(waiter.timeout);
                request.waiter = null;
                request.running = true;
                waiter.resolve(request.lease);
            } catch (error) {
                this._rejectWaiter(request, error);
                this.release(request.lease.requestId);
            }
        }
        if (![...this.requests.values()].some(request => request.waiter)) {
            clearInterval(this.queuePollTimer);
            this.queuePollTimer = null;
        }
    }

    hasRequest(requestId) {
        return this.requests.has(requestId);
    }
    getLease(requestId) {
        return this.requests.get(requestId)?.lease || null;
    }
    getDeadline(requestId) {
        return this.requests.get(requestId)?.deadline || null;
    }
    getSignal(requestId) {
        return this.requests.get(requestId)?.signal || null;
    }
    pauseForRecovery(requestId) {
        const request = this.requests.get(requestId);
        if (!request) return;
        request.running = false;
        this.recovering.add(request.lease.authIndex);
        this.handler.authSource.health.releaseProbe?.(request.lease.authIndex, requestId);
    }
    isCurrentOwner(lease, authIndex) {
        if (!lease) return false;
        const owner = this.owners.get(lease.key);
        return Boolean(
            owner && this._sameAccount(owner) && owner.version === lease.version && owner.authIndex === authIndex
        );
    }

    async retry(requestId, { unavailable = false, exclude = [] } = {}) {
        const request = this.requests.get(requestId);
        if (!request || request.signal?.aborted) throw new UserAbortedError();
        const oldIndex = request.lease.authIndex;
        this.recovering.delete(oldIndex);
        request.running = false;
        this.handler.authSource.health.releaseProbe?.(oldIndex, requestId);
        const owner = this.owners.get(request.lease.key);
        if (!unavailable && owner && (owner.authIndex !== oldIndex || owner.version !== request.lease.version))
            this._moveOwner(request);
        else if (unavailable || !this.isAccountAvailable(oldIndex))
            this._moveOwner(request, [...new Set([...exclude, oldIndex])]);
        const pending = this._waitForSlot(request);
        this._pump();
        this.handler.browserManager?.notifyAccountIdle?.(oldIndex);
        return pending;
    }

    notifyAccountChange() {
        this._pump();
        this.handler.browserManager
            ?.ensureAccountPoolReady?.()
            .catch(error => this.handler.logger?.warn(`[Accounts] Pool refill failed: ${error.message}`));
    }

    release(requestId) {
        const request = this.requests.get(requestId);
        if (!request) return;
        this._rejectWaiter(request, new UserAbortedError());
        request.signal?.removeEventListener("abort", request.onAbort);
        this.requests.delete(requestId);
        if (request.ephemeral) this.owners.delete(request.lease.key);
        this.recovering.delete(request.lease.authIndex);
        this.handler.authSource.health.releaseProbe?.(request.lease.authIndex, requestId);
        this._pump();
        this.handler.browserManager?.notifyAccountIdle?.(request.lease.authIndex);
    }

    cancel(requestId) {
        this.release(requestId);
    }

    async waitForMaintenance(authIndex, lease) {
        const deadline = this.clock() + 10000;
        while (this.clock() < deadline) {
            if (!this.isCurrentOwner(lease, authIndex) || !this.isAccountAvailable(authIndex)) return false;
            if (this.handler.authSource.health.getStatus?.(authIndex)?.probeRequired) return false;
            const load = this.getAccountLoad(authIndex);
            if (!load.inFlight && !load.waiting) return true;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return false;
    }
}

module.exports = AccountScheduler;
