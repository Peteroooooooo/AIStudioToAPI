const fs = require("fs");
const path = require("path");
const { isAuthExpiredError } = require("../utils/CustomErrors");

const testError = (reason, status = 409, message = reason) => Object.assign(new Error(message), { reason, status });

/** A small, real generation on exactly one account; no retries or failover. */
class AccountTestService {
    constructor(system) {
        this.system = system;
        this.results = new Map();
        this.running = new Set();
        this.startupTimeoutMs = 90000;
        this.resultsFile = system.usageStatsService?.dataDir
            ? path.join(system.usageStatsService.dataDir, "account-test-results.json")
            : null;
        this._loadResults();
    }

    get requestTimeoutMs() {
        return this._requestTimeoutMs ?? this.system.requestHandler.timeouts.FAKE_STREAM;
    }

    set requestTimeoutMs(value) {
        this._requestTimeoutMs = value;
    }

    _loadResults() {
        if (!this.resultsFile) return;
        let saved = [];
        try {
            saved = JSON.parse(fs.readFileSync(this.resultsFile, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT")
                this.system.logger.warn(`[AccountTest] Could not load history: ${error.message}`);
        }
        // Older versions persisted test requests in usage history only.
        for (const record of this.system.usageStatsService.records || []) {
            if (record.requestCategory !== "account_test" || !["success", "error"].includes(record.outcome)) continue;
            const attempt = record.attempts?.[0];
            saved.push({
                accountName: record.finalAccountName,
                result: {
                    accountIndex: record.finalAuthIndex,
                    checkedAt: record.startedAt,
                    durationMs: record.durationMs,
                    error: record.errorMessage,
                    finishedAt: record.finishedAt,
                    model: record.model,
                    reason:
                        record.outcome === "success"
                            ? "generated"
                            : attempt?.upstreamStatusCode === 429
                              ? "rate_limited"
                              : attempt?.terminationReason === "request_timeout"
                                ? "request_timeout"
                                : attempt?.terminationReason === "reconnect_cleanup"
                                  ? "connection_lost"
                                  : "request_failed",
                    requestId: record.requestId,
                    status: record.outcome === "success" ? "success" : "failed",
                    statusCode: record.statusCode,
                    tokenUsage: record.tokenUsage,
                    upstreamStatusCode: attempt?.upstreamStatusCode ?? null,
                },
            });
        }
        for (const entry of saved) {
            const index = entry.result?.accountIndex;
            if (!Number.isInteger(index) || entry.accountName !== this.system.authSource.accountNameMap.get(index))
                continue;
            if (!["success", "failed"].includes(entry.result.status)) continue;
            const previous = this.results.get(index);
            if (previous && Date.parse(previous.result.finishedAt) >= Date.parse(entry.result.finishedAt)) continue;
            this.results.set(index, { ...entry, credentialEpoch: this.system.getAuthCredentialEpoch?.(index) });
        }
    }

    _saveResults() {
        if (!this.resultsFile) return;
        try {
            const saved = [...this.results.entries()]
                .filter(
                    ([index, entry]) => this.getResult(index) && ["success", "failed"].includes(entry.result.status)
                )
                .map(([index, entry]) => ({
                    accountName: this.system.authSource.accountNameMap.get(index),
                    result: entry.result,
                }));
            const temporary = `${this.resultsFile}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 });
            fs.renameSync(temporary, this.resultsFile);
        } catch (error) {
            this.system.logger.warn(`[AccountTest] Could not save history: ${error.message}`);
        }
    }

    getResult(index) {
        const entry = this.results.get(index);
        if (!entry || entry.credentialEpoch !== this.system.getAuthCredentialEpoch?.(index)) return null;
        return entry.result;
    }

    _check(index, modelId, recovery = false) {
        const { authSource: auth, browserManager, requestHandler, modelCatalogStore } = this.system;
        if (!Number.isInteger(index) || !auth.availableIndices.includes(index)) throw testError("invalid", 404);
        const health = auth.health.getStatus(index);
        if (health.mode === "disabled" && !recovery) throw testError("disabled");
        if (auth.isExpired(index) || health.mode === "reauth") throw testError("needs_login");
        if (!auth.health.isAvailable(index) && !recovery) throw testError("disabled");
        if (!(recovery ? auth.rotationIndices || auth.getRotationIndices() : auth.getRotationIndices()).includes(index))
            throw testError("excluded");
        const model = modelCatalogStore.getAdminState().models.find(item => item.id === modelId);
        if (!model?.enabled || !model.probeSupported) throw testError("model_unavailable", 422);
        const load = requestHandler.accountScheduler.getAccountLoad(index);
        const activity = this.system.connectionRegistry.getAccountActivity(index);
        if (
            this.running.has(index) ||
            load.inFlight ||
            load.waiting ||
            activity.generation ||
            activity.maintenance ||
            browserManager.initializingContexts.has(index) ||
            auth.pendingRefreshIndices?.has(index)
        )
            throw testError("busy");
        return model;
    }

    async test(index, modelId, { signal, recovery = false } = {}) {
        const checkedAt = new Date().toISOString();
        const startedAt = Date.now();
        let model;
        try {
            model = this._check(index, modelId, recovery);
        } catch (error) {
            // A refused test says nothing about upstream generation capability.
            return {
                accountIndex: index,
                checkedAt,
                durationMs: 0,
                model: modelId,
                reason: error.reason,
                responseText: null,
                status: "not_tested",
                statusCode: error.status,
                upstreamStatusCode: null,
            };
        }
        const credentialEpoch = this.system.getAuthCredentialEpoch?.(index);
        const requestId = `account_test_${this.system.requestHandler._generateRequestId()}`;
        const health = this.system.authSource.health;
        if (recovery && !health.beginManualProbe(index, requestId, model.id))
            return {
                accountIndex: index,
                checkedAt,
                model: model.id,
                reason: "busy",
                status: "not_tested",
                statusCode: 409,
            };
        const previousResult = this.results.get(index);
        const state = {
            accountIndex: index,
            checkedAt,
            model: model.id,
            requestId,
            requestTimeoutMs: this.requestTimeoutMs,
            stage: "opening",
            startupTimeoutMs: this.startupTimeoutMs,
            status: "running",
        };
        this.running.add(index);
        this.results.set(index, { credentialEpoch, result: state });
        let result;
        try {
            result = await this.system.browserManager.withAccountTestConnection(
                index,
                async ({ previewAuth, temporary = false } = {}) => {
                    if (credentialEpoch !== this.system.getAuthCredentialEpoch?.(index))
                        throw testError("credentials_changed");
                    state.stage = "requesting";
                    state.connectionMode = temporary ? "temporary" : "resident";
                    state.startupDurationMs = Date.now() - startedAt;
                    return this._generate(index, model, requestId, signal, state, previewAuth);
                },
                { requestId, signal, timeoutMs: this.startupTimeoutMs }
            );
            if (credentialEpoch !== this.system.getAuthCredentialEpoch?.(index)) throw testError("credentials_changed");
            result = { ...state, ...result, reason: "generated", status: "success" };
        } catch (error) {
            const reason = signal?.aborted
                ? "cancelled"
                : isAuthExpiredError(error)
                  ? "needs_login"
                  : error.reason || (state.stage === "opening" ? "startup_failed" : "request_failed");
            result = {
                ...state,
                error: error.message,
                reason,
                requestDurationMs: error.requestDurationMs,
                responseText: null,
                status: ["busy", "excluded", "credentials_changed", "cancelled"].includes(reason)
                    ? "not_tested"
                    : "failed",
                statusCode: error.status || 503,
                transportFailure: error.transportFailure === true,
                upstreamStatusCode: error.upstreamStatusCode || null,
            };
        } finally {
            this.running.delete(index);
        }
        result.durationMs = Date.now() - startedAt;
        result.finishedAt = new Date().toISOString();
        delete result.stage;
        delete result.phase;
        if (recovery) {
            const credentialCurrent = credentialEpoch === this.system.getAuthCredentialEpoch?.(index);
            const probeCurrent = health.isManualProbe(index, requestId);
            result.recovered = health.finishManualProbe(index, requestId, {
                status:
                    credentialCurrent && result.status === "failed" && state.stage === "requesting"
                        ? result.upstreamStatusCode >= 400
                            ? result.upstreamStatusCode
                            : result.transportFailure
                              ? result.statusCode
                              : undefined
                        : undefined,
                success: credentialCurrent && result.status === "success",
                transportFailure: result.transportFailure === true,
            });
            if (credentialCurrent && probeCurrent && result.status === "success")
                this.system.browserManager.markAccountTestRecovered?.(index);
            else if (credentialCurrent && probeCurrent && result.transportFailure)
                this.system.browserManager.markAccountTransportFailure?.(index, result.reason);
            this.system.requestHandler.accountScheduler.notifyAccountChange(index);
        }
        if (result.status === "not_tested") {
            if (previousResult) this.results.set(index, previousResult);
            else this.results.delete(index);
        } else this.results.set(index, { credentialEpoch, result });
        this._saveResults();
        this.system.logger.info(
            `[AccountTest] #${index} ${model.id}: ${result.status} (${result.durationMs}ms), ${requestId}`
        );
        return result;
    }

    async _generate(index, model, requestId, signal, state = {}, previewAuth) {
        const { requestHandler: handler, connectionRegistry: registry, usageStatsService: usage } = this.system;
        // Use the same converter, model policy and transport as a downstream Chat request.
        // A separate 512-token cap could exhaust the model's thinking budget before its reply.
        const { proxyRequest: proxy } = await handler.createOpenAIProxyRequest(
            { messages: [{ content: "Reply with OK only.", role: "user" }], model: model.id, stream: false },
            requestId
        );
        proxy.request_attempt_limit = 1;
        const startedAt = Date.now();
        const deadline = Date.now() + this.requestTimeoutMs;
        let queue,
            dispatched = false,
            finished = false,
            upstreamStatusCode = null;
        const cancel = () => {
            if (!finished && dispatched) {
                registry.endRequestAttempt(requestId, {
                    authIndex: index,
                    healthFailure: false,
                    outcome: "aborted",
                    requestAttemptId: proxy.request_attempt_id,
                    statusCode: 499,
                    terminationReason: "user_cancelled",
                });
                handler._cancelBrowserRequest(requestId, index, proxy.request_attempt_id);
            }
            queue?.close("account_test_cancelled");
        };
        usage?.startRequest(requestId, {
            apiFormat: "openai",
            initialAuthIndex: index,
            method: "POST",
            model: model.id,
            path: `/api/accounts/${index}/test`,
            requestCategory: "account_test",
        });
        signal?.addEventListener("abort", cancel, { once: true });
        try {
            await handler.accountScheduler.acquirePinned(proxy, index, {
                deadline,
                isReady: () => registry.isAccountConnected(index),
                signal,
            });
            if (signal?.aborted) throw testError("cancelled", 499);
            queue = registry.createMessageQueue(requestId, index, proxy.request_attempt_id);
            handler._forwardRequest(proxy, index);
            dispatched = true;
            state.dispatchedAt = new Date().toISOString();
            state.phase = "waiting_response";
            const chunks = [];
            let bytes = 0;
            // eslint-disable-next-line no-constant-condition
            while (true) {
                if (signal?.aborted) throw testError("cancelled", 499);
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw testError("request_timeout", 504);
                let message;
                try {
                    message = await queue.dequeue(remaining);
                } catch (error) {
                    if (signal?.aborted) throw testError("cancelled", 499);
                    throw testError(Date.now() >= deadline ? "request_timeout" : "connection_lost", 504, error.message);
                }
                if (message.event_type === "response_headers") {
                    upstreamStatusCode = Number(message.status) || null;
                    state.upstreamStatusCode = upstreamStatusCode;
                    state.phase = "reading_response";
                }
                if (message.event_type === "error" || Number(message.status) >= 400) {
                    const status = Number(message.upstream_status) || Number(message.status) || 502;
                    const reason =
                        status === 429
                            ? "rate_limited"
                            : status === 401 || status === 403
                              ? "access_denied"
                              : message.termination_reason === "browser_timeout"
                                ? "request_timeout"
                                : "upstream_error";
                    throw Object.assign(testError(reason, status, message.message || `HTTP ${status}`), {
                        upstreamStatusCode: Number(message.upstream_status) || upstreamStatusCode,
                    });
                }
                if (message.type === "STREAM_END") break;
                if (message.event_type === "chunk" && message.data) {
                    const chunk = Buffer.from(message.data);
                    bytes += chunk.length;
                    if (bytes > 1024 * 1024) throw testError("invalid_response", 502);
                    chunks.push(chunk);
                }
            }
            let parsed;
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            } catch {
                throw Object.assign(testError("invalid_response", 502), { upstreamStatusCode });
            }
            if (parsed.error)
                throw Object.assign(
                    testError(
                        "upstream_error",
                        Number(parsed.error.code) || 502,
                        parsed.error.message || "Upstream returned an error."
                    ),
                    { upstreamStatusCode }
                );
            const text = parsed.candidates
                ?.flatMap(candidate => candidate.content?.parts || [])
                .filter(part => !part.thought && typeof part.text === "string")
                .map(part => part.text)
                .join("")
                .trim();
            if (!text) {
                const finishReason = parsed.candidates?.[0]?.finishReason;
                const reason = finishReason === "MAX_TOKENS" ? "output_limit" : "empty_response";
                throw Object.assign(testError(reason, 502, finishReason || reason), { upstreamStatusCode });
            }
            finished = true;
            const record = usage?.finishRequest(requestId, {
                finalAuthIndex: index,
                outcome: "success",
                statusCode: 200,
            });
            return {
                requestDurationMs: Date.now() - startedAt,
                responseText: text.slice(0, 1000),
                statusCode: 200,
                tokenUsage: record?.tokenUsage || null,
                upstreamStatusCode,
            };
        } catch (error) {
            error.upstreamStatusCode ??= upstreamStatusCode;
            error.requestDurationMs = Date.now() - startedAt;
            const attempt = registry.messageQueues.get(requestId);
            const recentProgress =
                upstreamStatusCode === 200 &&
                attempt?.lastProgressAt != null &&
                Date.now() - attempt.lastProgressAt < handler.timeouts.STREAM_CHUNK;
            error.transportFailure =
                state.connectionMode !== "temporary" &&
                (error.reason === "connection_lost" || (error.reason === "request_timeout" && !recentProgress));
            if (
                error.reason === "request_timeout" &&
                upstreamStatusCode === null &&
                [401, 403].includes(previewAuth?.status)
            ) {
                error.reason = "preview_auth_failed";
                error.message = `Google Preview did not return a generation response; GenerateAccessToken returned HTTP ${previewAuth.status}.`;
            }
            const statusCode = error.status || 502;
            if (dispatched)
                registry.endRequestAttempt(requestId, {
                    authIndex: index,
                    errorMessage: error.message,
                    healthFailure: !signal?.aborted && error.transportFailure,
                    outcome: signal?.aborted ? "aborted" : "error",
                    requestAttemptId: proxy.request_attempt_id,
                    statusCode,
                    terminationReason: error.reason || "test_failed",
                });
            usage?.finishRequest(requestId, {
                errorMessage: error.message,
                finalAuthIndex: index,
                outcome: signal?.aborted ? "aborted" : "error",
                statusCode,
            });
            throw error;
        } finally {
            signal?.removeEventListener("abort", cancel);
            if (dispatched && !finished) handler._cancelBrowserRequest(requestId, index, proxy.request_attempt_id);
            if (queue) registry.removeMessageQueue(requestId, "account_test_complete");
            handler.accountScheduler.release(requestId);
        }
    }
}

module.exports = AccountTestService;
