/**
 * Uses Gemini explicit cachedContents resources behind the existing browser
 * connection. Client requests remain stateless and retain their full history.
 */
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const GeminiCacheStore = require("./GeminiCacheStore");

const DELETE_RETRY_DELAY_MS = 60_000;

class GeminiCacheManager {
    constructor(handler, dataDir) {
        this.handler = handler;
        this.logger = handler.logger;
        this.config = handler.config;
        this.store = new GeminiCacheStore({ config: this.config, dataDir, logger: this.logger });
        this.attempts = new WeakMap();
        this.cachedAttemptIds = new Map();
        this.bypassOnce = new WeakSet();
        this.pendingCreates = new Set();
        this.pendingRenewals = new Set();
        this.activeCacheUses = new Map();
        this.deferredAncestors = new Map();
        this.retiringCacheUses = new Set();
        this.deleteFlushScheduled = false;
        this.deleteRetryAfter = new Map();
        this.disconnectedDeleteOwners = new Set();
        this.background = Promise.resolve();
        this.queuedTasks = 0;
        this.accountUses = new Map();
        this.lastCurrentAuthIndex = null;
        this.metrics = { created: 0, createFailed: 0, fallbacks: 0, localHits: 0, renewals: 0 };
    }

    _accountKey(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) return null;
        const accountName = this.handler.authSource?.accountNameMap?.get(authIndex);
        const identity =
            typeof accountName === "string" && accountName.trim()
                ? accountName.trim().toLowerCase()
                : this.handler.authSource?._getAuthContent?.(authIndex);
        if (typeof identity !== "string" || !identity) return null;
        return crypto
            .createHmac("sha256", this.config.sessionSecret || "local-cache-owner")
            .update(identity)
            .digest("hex");
    }

    _model(proxyRequest) {
        return (
            proxyRequest.path?.match(/^\/v1beta\/models\/([^:]+):(?:streamGenerateContent|generateContent)$/)?.[1] ||
            null
        );
    }

    _cacheFields(googleRequest, prefixLength) {
        const fields = { contents: googleRequest.contents.slice(0, prefixLength) };
        for (const key of ["systemInstruction", "tools", "toolConfig"]) {
            if (googleRequest[key] !== undefined) fields[key] = googleRequest[key];
        }
        return fields;
    }

    _requestInfo(proxyRequest, authIndex) {
        if (!this.config.cacheEnabled || !proxyRequest?.is_generative || proxyRequest.method !== "POST") return null;
        const model = this._model(proxyRequest);
        const accountKey = this._accountKey(authIndex);
        if (!model || !accountKey || typeof proxyRequest.body !== "string") return null;
        let googleRequest;
        try {
            googleRequest = JSON.parse(proxyRequest.body);
        } catch {
            return null;
        }
        if (
            !Array.isArray(googleRequest.contents) ||
            googleRequest.contents.length === 0 ||
            googleRequest.cachedContent
        ) {
            return null;
        }
        return { accountKey, authIndex, googleRequest, model };
    }

    _syncCurrentAccount(currentAuthIndex) {
        if (currentAuthIndex === this.lastCurrentAuthIndex) return;
        this.lastCurrentAuthIndex = currentAuthIndex;
        this.accountUses.set(currentAuthIndex, 0);
    }

    chooseConnectedAccount(proxyRequest, currentAuthIndex) {
        this._deleteEvicted();
        this._syncCurrentAccount(currentAuthIndex);
        const currentInfo = this._requestInfo(proxyRequest, currentAuthIndex);
        if (!currentInfo) return currentAuthIndex;
        const currentMatch = this.store.findLongest(currentInfo);
        let bestIndex = currentAuthIndex;
        let bestPrefix =
            currentMatch && Date.parse(currentMatch.entry.expireTime) - Date.now() >= 10000
                ? currentMatch.prefixLength
                : -1;
        const candidates = this.handler.authSource?.getRotationIndices?.() || [];
        for (const index of candidates) {
            if (index === currentAuthIndex || !this.handler.authSource.health?.isAvailable(index)) continue;
            const connection = this.handler.connectionRegistry.getConnectionByAuth(index, false);
            if (!connection || connection.readyState !== 1) continue;
            if (this.config.switchOnUses > 0 && (this.accountUses.get(index) || 0) >= this.config.switchOnUses)
                continue;
            const info = this._requestInfo(proxyRequest, index);
            if (!info) continue;
            const match = this.store.findLongest(info);
            if (!match || Date.parse(match.entry.expireTime) - Date.now() < 10000) continue;
            if (match.prefixLength > bestPrefix) {
                bestIndex = index;
                bestPrefix = match.prefixLength;
            }
        }
        return bestIndex;
    }

    recordAccountUse(authIndex, currentAuthIndex) {
        this._syncCurrentAccount(currentAuthIndex);
        const count = (this.accountUses.get(authIndex) || 0) + 1;
        this.accountUses.set(authIndex, count);
        return count;
    }

    prepare(proxyRequest, authIndex) {
        this._pruneDeferredAncestors();
        this._releaseAttempt(proxyRequest);
        const info = this._requestInfo(proxyRequest, authIndex);
        if (!info) {
            this.attempts.delete(proxyRequest);
            return proxyRequest;
        }
        const bypass = this.bypassOnce.delete(proxyRequest);
        const match = bypass ? null : this.store.findLongest(info);
        const usable =
            match &&
            !this.retiringCacheUses.has(this._cacheUseKey(match.entry)) &&
            Date.parse(match.entry.expireTime) - Date.now() >= 10000;
        const attempt = {
            ...info,
            activeHit: Boolean(usable),
            hit: usable ? match.entry : null,
            prefixLength: usable ? match.prefixLength : null,
        };
        this.attempts.set(proxyRequest, attempt);
        if (!usable) return proxyRequest;

        const useKey = this._cacheUseKey(match.entry);
        const active = this.activeCacheUses.get(useKey) || new Set();
        active.add(attempt);
        this.activeCacheUses.set(useKey, active);
        const deferred = this.deferredAncestors.get(useKey);
        if (deferred && this._hasDiverged(match.prefixLength, info.googleRequest.contents, deferred.contents)) {
            deferred.protectedFork = true;
        }

        if (proxyRequest.request_id && proxyRequest.request_attempt_id) {
            let ids = this.cachedAttemptIds.get(proxyRequest.request_id);
            if (!ids) {
                ids = new Set();
                this.cachedAttemptIds.set(proxyRequest.request_id, ids);
            }
            ids.add(proxyRequest.request_attempt_id);
        }

        const body = {
            ...info.googleRequest,
            cachedContent: match.entry.name,
            contents: info.googleRequest.contents.slice(match.prefixLength),
        };
        delete body.systemInstruction;
        delete body.tools;
        delete body.toolConfig;
        this.metrics.localHits++;
        this.logger.info(`[Cache] Using a ${match.prefixLength}-message Gemini prefix on account #${authIndex}.`);
        return { ...proxyRequest, body: JSON.stringify(body) };
    }

    canFallback(proxyRequest, error) {
        const hit = this.attempts.get(proxyRequest)?.hit;
        const status = Number(error?.status);
        return Boolean(hit && [400, 403, 404, 422, 500].includes(status));
    }

    consumeCachedAttemptOutcome({ requestId, requestAttemptId, status, success }) {
        const ids = this.cachedAttemptIds.get(requestId);
        if (!ids?.has(requestAttemptId)) return false;
        ids.delete(requestAttemptId);
        if (ids.size === 0) this.cachedAttemptIds.delete(requestId);
        return !success && [400, 403, 404, 422, 500].includes(Number(status));
    }

    async invalidateAndBypass(proxyRequest) {
        const hit = this.attempts.get(proxyRequest)?.hit;
        if (!hit) return false;
        this._releaseAttempt(proxyRequest);
        await this.store.remove(hit);
        this.bypassOnce.add(proxyRequest);
        this.metrics.fallbacks++;
        this.logger.warn("[Cache] Cached resource rejected; retrying the original request without cache.");
        return true;
    }

    attachResponse(res, proxyRequest) {
        if (!proxyRequest?.is_generative) return;
        res.once("close", () => {
            this.cachedAttemptIds.delete(proxyRequest.request_id);
            this._releaseAttempt(proxyRequest);
        });
        res.once("finish", () => {
            const info = this.attempts.get(proxyRequest);
            try {
                if (!info || !this.config.cacheEnabled || res.__usageTrackingOutcome || res.statusCode >= 400) return;
                if (info.hit) {
                    this.store.recordHit(info.hit).catch(error => {
                        this.logger.warn(`[Cache] Could not record cache hit: ${error.message}`);
                    });
                    this._maybeRenew(info);
                }
                this._scheduleCreate(info);
            } finally {
                this._releaseAttempt(proxyRequest);
            }
        });
    }

    _cacheUseKey(entry) {
        return `${entry.accountKey}:${entry.name}`;
    }

    _pruneDeferredAncestors() {
        for (const [key, deferred] of this.deferredAncestors) {
            if (!this.store.hasCurrent(deferred.entry) || (deferred.protectedFork && !this.activeCacheUses.has(key)))
                this.deferredAncestors.delete(key);
        }
    }

    _hasDiverged(prefixLength, left, right) {
        for (let index = prefixLength; index < Math.min(left.length, right.length); index++) {
            if (!isDeepStrictEqual(left[index], right[index])) return true;
        }
        return false;
    }

    _releaseAttempt(proxyRequest) {
        const attempt = this.attempts.get(proxyRequest);
        if (!attempt?.activeHit) return;
        attempt.activeHit = false;
        const key = this._cacheUseKey(attempt.hit);
        const active = this.activeCacheUses.get(key);
        active?.delete(attempt);
        if (active?.size === 0) this.activeCacheUses.delete(key);
        const deferred = this.deferredAncestors.get(key);
        if (deferred?.protectedFork && !this.activeCacheUses.has(key)) this.deferredAncestors.delete(key);
        else this._retireDeferred(key);
        this._deleteEvicted();
    }

    _retireDeferred(key) {
        const deferred = this.deferredAncestors.get(key);
        if (!deferred || deferred.protectedFork || deferred.scheduled || this.activeCacheUses.has(key)) return;
        deferred.scheduled = true;
        if (
            !this._schedule(async () => {
                try {
                    if (
                        this.deferredAncestors.get(key) !== deferred ||
                        deferred.protectedFork ||
                        this.activeCacheUses.has(key)
                    )
                        return;
                    const retired = await this.store.retire(
                        deferred.entry,
                        () =>
                            this.deferredAncestors.get(key) === deferred &&
                            !deferred.protectedFork &&
                            !this.activeCacheUses.has(key)
                    );
                    if (retired) {
                        if (this.deferredAncestors.get(key) === deferred) this.deferredAncestors.delete(key);
                        this._deleteEvicted();
                    } else if (!this.store.hasCurrent(deferred.entry)) {
                        if (this.deferredAncestors.get(key) === deferred) this.deferredAncestors.delete(key);
                    }
                } finally {
                    deferred.scheduled = false;
                }
            })
        )
            deferred.scheduled = false;
    }

    _schedule(task) {
        if (this.queuedTasks >= 16) return false;
        this.queuedTasks++;
        this.background = this.background
            .then(() => task())
            .catch(error => this.logger.warn(`[Cache] Background operation failed: ${error.message}`))
            .finally(() => {
                this.queuedTasks--;
            });
        return true;
    }

    _scheduleCreate(info) {
        if (!this.config.cacheEnabled) return;
        if (info.googleRequest.systemInstruction || info.googleRequest.tools || info.googleRequest.toolConfig) {
            this._scheduleCreatePrefix(info, 0);
        }
        this._scheduleCreatePrefix(info, info.googleRequest.contents.length);
    }

    _scheduleCreatePrefix(info, prefixLength) {
        const { accountKey, googleRequest, model } = info;
        const existing = this.store.findLongest({ accountKey, googleRequest, maxPrefixLength: prefixLength, model });
        if (existing?.prefixLength === prefixLength) return;
        const taskKey = crypto
            .createHash("sha256")
            .update(JSON.stringify([accountKey, model, this._cacheFields(googleRequest, prefixLength)]))
            .digest("hex");
        if (this.pendingCreates.has(taskKey)) return;
        this.pendingCreates.add(taskKey);
        if (
            !this._schedule(async () => {
                try {
                    await this._create(info, prefixLength);
                } finally {
                    this.pendingCreates.delete(taskKey);
                }
            })
        ) {
            this.pendingCreates.delete(taskKey);
        }
    }

    async _create(info, prefixLength) {
        if (!this.config.cacheEnabled || !this.handler.connectionRegistry.getConnectionByAuth(info.authIndex, false))
            return;
        const fields = this._cacheFields(info.googleRequest, prefixLength);
        const fullFields = this._cacheFields(info.googleRequest, info.googleRequest.contents.length);
        // Token count cannot exceed the UTF-8 byte count of this request body.
        if (Buffer.byteLength(JSON.stringify(fullFields)) < this.config.cacheMinTokens) return;
        const existing = this.store.findLongest({ ...info, maxPrefixLength: prefixLength });
        if (existing?.prefixLength === prefixLength) return;
        if (
            prefixLength > 0 &&
            existing?.prefixLength === 0 &&
            Buffer.byteLength(JSON.stringify(fields)) -
                Buffer.byteLength(JSON.stringify(this._cacheFields(info.googleRequest, 0))) <
                this.config.cacheCheckpointTokens
        ) {
            return;
        }

        // countTokens requires at least one content message, while cachedContents
        // can store system instructions and tools on their own.
        const countFields =
            prefixLength === 0 ? { ...fields, contents: [{ parts: [{ text: "." }], role: "user" }] } : fields;
        const countResponse = await this._resourceRequest(info.authIndex, {
            body: { generateContentRequest: { model: `models/${info.model}`, ...countFields } },
            method: "POST",
            path: `/v1beta/models/${info.model}:countTokens`,
        });
        const tokenCount = Number(countResponse.totalTokens) - (prefixLength === 0 ? 1 : 0);
        if (!Number.isSafeInteger(tokenCount) || tokenCount < this.config.cacheMinTokens) return;
        if (
            existing?.entry?.tokenCount != null &&
            tokenCount - existing.entry.tokenCount < this.config.cacheCheckpointTokens
        ) {
            return;
        }

        try {
            const cacheFields = { ...fields };
            if (prefixLength === 0) delete cacheFields.contents;
            const created = await this._resourceRequest(info.authIndex, {
                body: { model: `models/${info.model}`, ...cacheFields, ttl: `${this.config.cacheTtlSeconds}s` },
                method: "POST",
                path: "/v1beta/cachedContents",
            });
            if (!created.name || !created.expireTime) throw new Error("Gemini did not return a cache name and expiry.");
            const retiringKeys = new Set();
            const previousDeferred = new Map();
            let stored = false;
            try {
                await this.store.put({
                    accountKey: info.accountKey,
                    canRetireAncestor: ancestor => {
                        const key = this._cacheUseKey(ancestor);
                        const active = this.activeCacheUses.get(key);
                        if (!active?.size) {
                            this.retiringCacheUses.add(key);
                            retiringKeys.add(key);
                            return true;
                        }
                        const previous = this.deferredAncestors.get(key);
                        const protectedFork =
                            previous?.protectedFork ||
                            [...active].some(use =>
                                this._hasDiverged(
                                    ancestor.prefixLength,
                                    use.googleRequest.contents,
                                    info.googleRequest.contents
                                )
                            );
                        previousDeferred.set(key, previous);
                        this.deferredAncestors.set(key, {
                            contents: info.googleRequest.contents,
                            entry: ancestor,
                            protectedFork,
                            scheduled: false,
                        });
                        return false;
                    },
                    expireTime: created.expireTime,
                    googleRequest: info.googleRequest,
                    model: info.model,
                    name: created.name,
                    prefixLength,
                    retireAncestors: prefixLength > 0,
                    tokenCount,
                });
                stored = true;
            } finally {
                for (const key of retiringKeys) this.retiringCacheUses.delete(key);
                if (!stored) {
                    for (const [key, previous] of previousDeferred) {
                        if (previous) this.deferredAncestors.set(key, previous);
                        else this.deferredAncestors.delete(key);
                    }
                }
            }
            for (const key of previousDeferred.keys()) this._retireDeferred(key);
            this._pruneDeferredAncestors();
            this.metrics.created++;
            this.logger.info(`[Cache] Created Gemini prefix (${tokenCount} tokens) on account #${info.authIndex}.`);
            this._deleteEvicted();
        } catch (error) {
            this.metrics.createFailed++;
            throw error;
        }
    }

    _maybeRenew(info) {
        const entry = info.hit;
        if (!entry || this.config.cacheRenewWindowSeconds <= 0) return;
        if (Date.parse(entry.expireTime) - Date.now() > this.config.cacheRenewWindowSeconds * 1000) return;
        if (this.pendingRenewals.has(entry.name)) return;
        this.pendingRenewals.add(entry.name);
        if (
            !this._schedule(async () => {
                try {
                    const updated = await this._resourceRequest(info.authIndex, {
                        body: { ttl: `${this.config.cacheTtlSeconds}s` },
                        method: "PATCH",
                        path: `/v1beta/${entry.name}`,
                        queryParams: { updateMask: "ttl" },
                    });
                    if (updated.expireTime) {
                        const current = this.store.findLongest({ ...info, maxPrefixLength: entry.prefixLength });
                        if (current?.prefixLength !== entry.prefixLength || current.entry.name !== entry.name) return;
                        await this.store.put({
                            accountKey: info.accountKey,
                            expireTime: updated.expireTime,
                            googleRequest: info.googleRequest,
                            model: info.model,
                            name: entry.name,
                            prefixLength: entry.prefixLength,
                            tokenCount: entry.tokenCount,
                        });
                        this.metrics.renewals++;
                    }
                } catch (error) {
                    this.logger.warn(`[Cache] Could not renew Gemini resource: ${error.message}`);
                } finally {
                    this.pendingRenewals.delete(entry.name);
                }
            })
        ) {
            this.pendingRenewals.delete(entry.name);
        }
    }

    _deleteEvicted() {
        this._pruneDeferredAncestors();
        if (this.deleteFlushScheduled) return;
        const pending = this.store.pendingDeleteEntries();
        const pendingKeys = new Set(pending.map(entry => this._cacheUseKey(entry)));
        for (const key of this.deleteRetryAfter.keys()) {
            if (!pendingKeys.has(key)) this.deleteRetryAfter.delete(key);
        }
        if (
            !pending.some(
                entry =>
                    this._connectedDeleteAccount(entry) !== null &&
                    !this.activeCacheUses.has(this._cacheUseKey(entry)) &&
                    (this.deleteRetryAfter.get(this._cacheUseKey(entry)) || 0) <= Date.now()
            )
        )
            return;
        this.deleteFlushScheduled = true;
        if (
            !this._schedule(async () => {
                try {
                    for (const entry of this.store.pendingDeleteEntries()) {
                        const key = this._cacheUseKey(entry);
                        if (this.activeCacheUses.has(key)) continue;
                        const authIndex = this._connectedDeleteAccount(entry);
                        if (authIndex === null) continue;
                        if ((this.deleteRetryAfter.get(key) || 0) > Date.now()) continue;
                        try {
                            await this._resourceRequest(authIndex, { method: "DELETE", path: `/v1beta/${entry.name}` });
                        } catch (error) {
                            if (error.status !== 404) {
                                this.deleteRetryAfter.set(key, Date.now() + DELETE_RETRY_DELAY_MS);
                                this.logger.warn(
                                    `[Cache] Could not delete superseded Gemini resource: ${error.message}`
                                );
                                continue;
                            }
                        }
                        try {
                            await this.store.markDeleted(entry);
                            this.deleteRetryAfter.delete(key);
                        } catch (error) {
                            this.deleteRetryAfter.set(key, Date.now() + DELETE_RETRY_DELAY_MS);
                            this.logger.warn(`[Cache] Could not save Gemini resource deletion: ${error.message}`);
                        }
                    }
                } finally {
                    this.deleteFlushScheduled = false;
                }
            })
        )
            this.deleteFlushScheduled = false;
    }

    _connectedDeleteAccount(entry) {
        const authIndex = this.handler.authSource?.availableIndices?.find(
            index => this._accountKey(index) === entry.accountKey
        );
        const connection = Number.isInteger(authIndex)
            ? this.handler.connectionRegistry.getConnectionByAuth(authIndex, false)
            : null;
        if (connection?.readyState !== 1) {
            this.disconnectedDeleteOwners.add(entry.accountKey);
            return null;
        }
        if (this.disconnectedDeleteOwners.delete(entry.accountKey)) {
            for (const key of this.deleteRetryAfter.keys()) {
                if (key.startsWith(`${entry.accountKey}:`)) this.deleteRetryAfter.delete(key);
            }
        }
        return authIndex;
    }

    async _resourceRequest(authIndex, { body, method, path, queryParams = {} }) {
        // Cache maintenance is not a client generation attempt and must not
        // reset or trip the account-health failure counter.
        const requestId = `cache_resource_${this.handler._generateRequestId()}`;
        const proxyRequest = {
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            is_generative: false,
            method,
            path,
            query_params: queryParams,
            request_id: requestId,
            streaming_mode: "fake",
        };
        this.handler._initializeProxyRequestAttempt(proxyRequest);
        const queue = this.handler.connectionRegistry.createMessageQueue(
            requestId,
            authIndex,
            proxyRequest.request_attempt_id
        );
        try {
            this.handler._forwardRequest(proxyRequest, authIndex);
            const first = await queue.dequeue(60000);
            if (first.event_type === "error" || Number(first.status) >= 400) {
                const error = new Error(`Gemini cache resource request failed (${first.status || "unknown"}).`);
                error.status = Number(first.status);
                throw error;
            }
            if (first.type === "STREAM_END") return {};
            const chunks = [];
            let bytes = 0;
            if (first.event_type === "chunk" && first.data) {
                const chunk = Buffer.from(first.data);
                bytes += chunk.length;
                chunks.push(chunk);
            }
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const message = await queue.dequeue(60000);
                if (message.type === "STREAM_END") break;
                if (message.event_type === "error") {
                    const error = new Error(`Gemini cache resource request failed (${message.status || "unknown"}).`);
                    error.status = Number(message.status);
                    throw error;
                }
                if (message.event_type === "chunk" && message.data) {
                    const chunk = Buffer.from(message.data);
                    bytes += chunk.length;
                    if (bytes > 1024 * 1024) throw new Error("Gemini cache resource response is too large.");
                    chunks.push(chunk);
                }
            }
            if (method === "DELETE" || chunks.length === 0) return {};
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (result.error) {
                const error = new Error(`Gemini cache resource request failed (${result.error.code || "unknown"}).`);
                error.status = Number(result.error.code);
                throw error;
            }
            return result;
        } finally {
            this.handler.connectionRegistry.removeMessageQueue(requestId, "cache_resource_complete");
        }
    }

    stats() {
        return { ...this.store.stats(), ...this.metrics, queuedTasks: this.queuedTasks };
    }

    async close() {
        while (this.queuedTasks > 0) await this.background;
        await this.store.close();
        this._deleteEvicted();
        while (this.queuedTasks > 0) await this.background;
    }
}

module.exports = GeminiCacheManager;
