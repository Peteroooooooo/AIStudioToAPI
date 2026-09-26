const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const UsageStatsService = require("../src/core/UsageStatsService");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const { fromUsageMetadata, TokenUsageCapture } = require("../src/core/TokenUsage");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("upstream metadata preserves cache zero, missing fields and thought tokens", () => {
    assert.deepEqual(
        fromUsageMetadata({
            cachedContentTokenCount: 0,
            candidatesTokenCount: 3,
            promptTokenCount: 12,
            thoughtsTokenCount: 2,
            totalTokenCount: 17,
        }),
        {
            cachedInputTokens: 0,
            inputTokens: 12,
            outputTokens: 5,
            thoughtTokens: 2,
            totalTokens: 17,
        }
    );
    assert.equal(fromUsageMetadata({}), null);
    assert.equal(fromUsageMetadata({ promptTokenCount: 0 }).cachedInputTokens, null);
});

test("fragmented SSE usage snapshots replace earlier snapshots for one attempt", () => {
    const capture = new TokenUsageCapture();
    capture.ingest('data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}\n\n');
    capture.ingest('data: {"usageMeta');
    capture.ingest(
        'data": {"promptTokenCount":10,"candidatesTokenCount":4,"totalTokenCount":14,"cachedContentTokenCount":3}}\r\n\r\n'
    );
    assert.deepEqual(capture.finish(), {
        cachedInputTokens: 3,
        inputTokens: 10,
        outputTokens: 4,
        thoughtTokens: null,
        totalTokens: 14,
    });
});

test("usage from separate backend attempts is saved without counting repeated stream snapshots twice", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-token-test-"));
    try {
        const service = new UsageStatsService(null, null, directory);
        service.startRequest("token-request", { model: "gemini-test", requestCategory: "generation" });
        service.recordBackendChunk(
            "token-request",
            "attempt-1",
            JSON.stringify({
                usageMetadata: { candidatesTokenCount: 2, promptTokenCount: 10, totalTokenCount: 12 },
            })
        );
        service.recordBackendChunk(
            "token-request",
            "attempt-2",
            JSON.stringify({
                usageMetadata: {
                    cachedContentTokenCount: 0,
                    candidatesTokenCount: 4,
                    promptTokenCount: 5,
                    totalTokenCount: 9,
                },
            })
        );
        const saved = service.finishRequest("token-request", { outcome: "success", statusCode: 200 });
        assert.deepEqual(saved.tokenUsage, {
            cachedInputTokens: 0,
            inputTokens: 15,
            outputTokens: 6,
            thoughtTokens: null,
            totalTokens: 21,
        });
        await service.appendPromise;
        const reloaded = new UsageStatsService(null, null, directory);
        assert.deepEqual(reloaded.records[0].tokenUsage, saved.tokenUsage);
    } finally {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("retry usage is attributed to the actual upstream account and persisted by attempt", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-attempt-test-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const authSource = {
        accountNameMap: new Map([
            [1, "first"],
            [2, "second"],
        ]),
    };
    const service = new UsageStatsService(authSource, null, directory);
    const registry = new ConnectionRegistry(logger);
    service.connectionRegistry = registry;
    registry.on("backendChunk", ({ requestId, requestAttemptId, data }) => {
        service.recordBackendChunk(requestId, requestAttemptId, data);
    });
    registry.on("backendAttemptEvent", event => service.recordBackendAttemptEvent(event));

    const send = (authIndex, requestAttemptId, eventType, fields = {}) => {
        registry._handleIncomingMessage(
            JSON.stringify({
                ...fields,
                event_type: eventType,
                request_attempt_id: requestAttemptId,
                request_id: "retry-request",
            }),
            authIndex
        );
    };

    service.startRequest("retry-request", {
        apiKeyId: "a".repeat(64),
        model: "gemini-test",
        requestCategory: "generation",
    });
    registry.createMessageQueue("retry-request", 1, "attempt-1");
    service.recordAttempt("retry-request", 1, "first");
    send(1, "attempt-1", "response_headers", { status: 200 });
    send(1, "attempt-1", "chunk", {
        data: 'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}\n\n',
    });
    send(1, "attempt-1", "error", { status: 503 });

    registry.createMessageQueue("retry-request", 2, "attempt-2");
    service.recordAttempt("retry-request", 2, "second");
    send(2, "attempt-2", "response_headers", { status: "200" });
    send(2, "attempt-2", "chunk", {
        data: 'data: {"usageMetadata":{"cachedContentTokenCount":0,"promptTokenCount":5,"candidatesTokenCount":4,"totalTokenCount":9}}\n\n',
    });
    send(2, "attempt-2", "stream_close");

    const saved = service.finishRequest("retry-request", {
        finalAccountName: "second",
        finalAuthIndex: 2,
        outcome: "success",
        statusCode: 200,
    });
    assert.equal(saved.attemptCount, 2);
    assert.equal(saved.apiKeyId, "a".repeat(64));
    assert.equal(saved.tokenUsage.totalTokens, 21);
    assert.equal(saved.usageState, "partial");
    assert.deepEqual(
        saved.attempts.map(({ accountKey, outcome, requestAttemptId, statusCode, tokenUsage, usageState }) => ({
            accountKey,
            outcome,
            requestAttemptId,
            statusCode,
            totalTokens: tokenUsage?.totalTokens,
            usageState,
        })),
        [
            {
                accountKey: "1:first",
                outcome: "error",
                requestAttemptId: "attempt-1",
                statusCode: 503,
                totalTokens: 12,
                usageState: "partial",
            },
            {
                accountKey: "2:second",
                outcome: "success",
                requestAttemptId: "attempt-2",
                statusCode: 200,
                totalTokens: 9,
                usageState: "reported",
            },
        ]
    );
    assert.deepEqual(saved.attempts[0].rawUsageMetadata, {
        candidatesTokenCount: 2,
        promptTokenCount: 10,
        totalTokenCount: 12,
    });
    assert.ok(saved.attempts.every(attempt => attempt.startedAt && attempt.finishedAt));

    await service.appendPromise;
    const reloaded = new UsageStatsService(authSource, null, directory);
    assert.deepEqual(reloaded.records[0].attempts, saved.attempts);
});

test("missing upstream usage remains unknown and marks retry totals as partial", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-partial-test-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const service = new UsageStatsService(null, null, directory);
    service.startRequest("partial-request");
    service.recordAttempt("partial-request", 1, "first", "attempt-1");
    service.recordBackendAttemptEvent({
        authIndex: 1,
        eventType: "error",
        requestAttemptId: "attempt-1",
        requestId: "partial-request",
        statusCode: 429,
    });
    service.recordAttempt("partial-request", 2, "second", "attempt-2");
    service.recordBackendChunk(
        "partial-request",
        "attempt-2",
        'data: {"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n'
    );
    const saved = service.finishRequest("partial-request", { outcome: "success", statusCode: 200 });
    assert.equal(saved.attempts[0].tokenUsage, null);
    assert.equal(saved.attempts[0].usageState, "unreported");
    assert.equal(saved.attempts[1].tokenUsage.totalTokens, 7);
    assert.equal(saved.tokenUsage.totalTokens, 7);
    assert.equal(saved.usageState, "partial");
    await service.appendPromise;
});

test("legacy records load without inventing per-attempt token attribution", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-legacy-usage-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    fs.writeFileSync(
        path.join(directory, "usage-stats.jsonl"),
        JSON.stringify({
            accountKey: "2:second",
            apiFormat: "openai",
            attemptCount: 2,
            attempts: [{ accountKey: "1:first" }, { accountKey: "2:second" }],
            durationMs: 10,
            finishedAt: "2026-01-01T00:00:00.000Z",
            outcome: "success",
            requestId: "legacy-request",
            sequence: 1,
            tokenUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        }) + "\n"
    );
    const service = new UsageStatsService(null, null, directory);
    const [record] = service.records;
    assert.equal(record.apiKeyId, null);
    assert.deepEqual(record.attempts, [{ accountKey: "1:first" }, { accountKey: "2:second" }]);
    assert.equal(record.tokenUsage.totalTokens, 7);
    assert.equal(record.usageState, "partial");
});
