const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildOverview, listRequests, parseUsageQuery, exportRecords } = require("../src/core/UsageAnalytics");
const UsageStatsService = require("../src/core/UsageStatsService");
const now = Date.parse("2026-10-01T12:00:00Z");
const parent = {
    accountKey: "1:a@example.com",
    apiFormat: "openai",
    attemptCount: 2,
    attempts: [
        {
            accountKey: "4:d@example.com",
            accountName: "d@example.com",
            authIndex: 4,
            errorMessage: "Quota",
            finishedAt: "2026-10-01T10:00:01Z",
            outcome: "error",
            requestAttemptId: "d-call",
            startedAt: "2026-10-01T10:00:00Z",
            statusCode: 429,
            tokenUsage: null,
            upstreamStatusCode: 429,
        },
        {
            accountKey: "1:a@example.com",
            accountName: "a@example.com",
            authIndex: 1,
            finishedAt: "2026-10-01T10:00:20Z",
            outcome: "success",
            requestAttemptId: "a-call",
            startedAt: "2026-10-01T10:00:02Z",
            statusCode: 200,
            tokenUsage: { cachedInputTokens: 0, inputTokens: 20, outputTokens: 3, totalTokens: 23 },
            upstreamStatusCode: 200,
        },
    ],
    durationMs: 20000,
    finalAccountName: "a@example.com",
    finalAuthIndex: 1,
    finishedAt: "2026-10-01T10:00:20Z",
    model: "gemini-flash",
    outcome: "success",
    requestId: "parent",
    sequence: 1,
    startedAt: "2026-10-01T10:00:00Z",
    statusCode: 200,
    tokenUsage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
};

test("D account filter exposes only D429 and identical call statistics and export", () => {
    const query = parseUsageQuery(
        { accountKey: "name:d@example.com", outcome: "error", range: "all", statusCode: "429" },
        now,
        true
    );
    const page = listRequests([parent], query);
    assert.equal(page.items.length, 1);
    const row = page.items[0];
    assert.equal(row.finalAccountName, "d@example.com");
    assert.equal(row.statusCode, 429);
    assert.equal(row.durationMs, 1000);
    assert.equal(row.tokenUsage, null);
    assert.equal(row.attempts.length, 1);
    assert.equal(row.errorMessage, "Quota");
    const overview = buildOverview([parent], query, 0, 1, now);
    assert.equal(overview.summary.totalRequests, 1);
    assert.equal(overview.summary.clientRequestCount, 1);
    assert.equal(overview.summary.successRate, 0);
    assert.equal(overview.summary.errorCount, 1);
    assert.equal(overview.summary.tokenUsage.totalTokens, null);
    assert.equal(overview.accounts[0].successRate, 0);
    assert.deepEqual(
        exportRecords([parent], query).map(call => call.requestAttemptId),
        ["d-call"]
    );
    const all = buildOverview([parent], parseUsageQuery({ range: "all" }, now), 0, 1, now);
    assert.equal(all.summary.totalRequests, 2);
    assert.equal(all.summary.clientRequestCount, 1);
    assert.equal(all.summary.successRate, 50);
    assert.equal(all.summary.tokenUsage.totalTokens, 23);
});

test("compound cursors retain another call from the same parent across page boundaries", () => {
    const first = listRequests([parent], parseUsageQuery({ limit: "1", range: "all" }, now, true));
    assert.equal(first.items[0].requestAttemptId, "a-call");
    assert.equal(first.nextCursor, "1:1:1:-:-");
    const added = {
        ...parent,
        attempts: [{ ...parent.attempts[1], requestAttemptId: "new-call" }],
        requestId: "new-parent",
        sequence: 2,
    };
    const second = listRequests(
        [parent, added],
        parseUsageQuery({ cursor: first.nextCursor, limit: "1", range: "all" }, now, true)
    );
    assert.equal(second.items[0].requestAttemptId, "d-call");
    assert.equal(second.hasMore, false);
    assert.equal(second.totalMatched, 2);
});

test("call time, duration, cache and error search never borrow another attempt fields", () => {
    const query = parseUsageQuery(
        {
            cacheState: "miss",
            from: "2026-10-01T10:00:01Z",
            minDurationMs: "17000",
            range: "custom",
            to: "2026-10-01T10:00:03Z",
        },
        now,
        true
    );
    assert.deepEqual(
        listRequests([parent], query).items.map(call => call.requestAttemptId),
        ["a-call"]
    );
    assert.equal(
        listRequests(
            [parent],
            parseUsageQuery({ accountKey: "name:d@example.com", q: "a@example.com", range: "all" }, now, true)
        ).totalMatched,
        0
    );
});

test("legacy call lacks fabricated success, time, duration and inherited sibling usage", () => {
    const legacy = {
        ...parent,
        attempts: [
            { accountKey: "4:d@example.com", accountName: "d@example.com", authIndex: 4 },
            { accountKey: "1:a@example.com", accountName: "a@example.com", authIndex: 1 },
        ],
    };
    const page = listRequests([legacy], parseUsageQuery({ range: "all" }, now, true));
    assert.equal(page.items.length, 2);
    for (const row of page.items) {
        assert.equal(row.outcome, "unknown");
        assert.equal(row.statusCode, null);
        assert.equal(row.durationMs, null);
        assert.equal(row.startedAt, null);
        assert.equal(row.tokenUsage, null);
        assert.equal(row.historicalIncomplete, true);
    }
    const summary = buildOverview([legacy], parseUsageQuery({ range: "all" }, now), 0, 1, now).summary;
    assert.equal(summary.unknownCount, 2);
    assert.equal(summary.errorCount, 0);
    assert.equal(summary.completedCount, 0);
});

test("terminal call events validate identity, are idempotent and cannot create undispatched calls", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-terminal-"));
    const service = new UsageStatsService(null, null, directory);
    t.after(async () => {
        await service.appendPromise;
        fs.rmSync(directory, { force: true, recursive: true });
    });
    service.startRequest("r");
    assert.equal(service.finishAttempt("r", { authIndex: 4, outcome: "error", requestAttemptId: "ghost" }), false);
    service.recordBackendChunk(
        "r",
        "ghost",
        JSON.stringify({ usageMetadata: { candidatesTokenCount: 2, promptTokenCount: 1, totalTokenCount: 3 } })
    );
    assert.equal(service.activeRequests.get("r").attempts.length, 0);
    service.recordAttempt("r", 4, "d@example.com", "d");
    assert.equal(service.finishAttempt("r", { authIndex: 1, outcome: "success", requestAttemptId: "d" }), false);
    service.recordBackendAttemptEvent({
        authIndex: 4,
        errorMessage: "Quota",
        eventType: "attempt_end",
        outcome: "error",
        requestAttemptId: "d",
        requestId: "r",
        terminationReason: "upstream_error",
        upstreamStatusCode: 429,
    });
    assert.equal(
        service.finishAttempt("r", {
            authIndex: 4,
            outcome: "success",
            requestAttemptId: "d",
            upstreamStatusCode: 200,
        }),
        false
    );
    service.recordAttempt("r", 1, "a@example.com", "a");
    service.finishAttempt("r", {
        authIndex: 1,
        localStatusCode: 499,
        outcome: "aborted",
        requestAttemptId: "a",
        terminationReason: "client_disconnect",
        upstreamStatusCode: 200,
    });
    const saved = service.finishRequest("r", { outcome: "success", statusCode: 200 });
    assert.equal(saved.attempts[0].outcome, "error");
    assert.equal(saved.attempts[0].upstreamStatusCode, 429);
    assert.equal(saved.attempts[0].errorMessage, "Quota");
    assert.equal(saved.attempts[1].outcome, "aborted");
    assert.equal(saved.attempts[1].localStatusCode, 499);
    assert.equal(service.getRequest("r").requestId, "r");
});

test("known completed calls alone determine success rate and duration averages", () => {
    const mixed = {
        ...parent,
        attempts: [
            ...parent.attempts,
            {
                accountName: "a@example.com",
                authIndex: 1,
                requestAttemptId: "unknown",
                startedAt: "2026-10-01T10:01:00Z",
                tokenUsage: null,
            },
        ],
    };
    const summary = buildOverview([mixed], parseUsageQuery({ range: "all" }, now), 0, 1, now).summary;
    assert.equal(summary.totalRequests, 3);
    assert.equal(summary.completedCount, 2);
    assert.equal(summary.unknownCount, 1);
    assert.equal(summary.successRate, 50);
    assert.equal(summary.durationCoverage, 2);
    assert.equal(summary.avgDurationMs, 9500);
});

test("one historical call can own legacy usage without borrowing the parent outcome", () => {
    const single = { ...parent, attemptCount: 1, attempts: [{ accountName: "a@example.com", authIndex: 1 }] };
    const row = listRequests([single], parseUsageQuery({ range: "all" }, now, true)).items[0];
    assert.equal(row.tokenUsage.totalTokens, 23);
    assert.equal(row.outcome, "unknown");
    assert.equal(row.statusCode, null);
    assert.equal(row.tokenSource, "legacy-single-call");
});

test("local timeout preserves received upstream status and parent finalization cannot fabricate a call result", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-local-timeout-"));
    const service = new UsageStatsService(null, null, directory);
    t.after(async () => {
        await service.appendPromise;
        fs.rmSync(directory, { force: true, recursive: true });
    });
    service.startRequest("timeout");
    service.recordAttempt("timeout", 1, "a", "a1");
    service.recordBackendAttemptEvent({
        authIndex: 1,
        eventType: "response_headers",
        requestAttemptId: "a1",
        requestId: "timeout",
        statusCode: 200,
    });
    service.recordBackendAttemptEvent({
        authIndex: 1,
        eventType: "attempt_end",
        outcome: "error",
        requestAttemptId: "a1",
        requestId: "timeout",
        statusCode: 504,
        terminationReason: "upstream_timeout",
    });
    const timed = service.finishRequest("timeout", { outcome: "error", statusCode: 504 });
    assert.equal(timed.attempts[0].upstreamStatusCode, 200);
    assert.equal(timed.attempts[0].localStatusCode, 504);
    service.startRequest("unknown");
    service.recordAttempt("unknown", 1, "a", "a2");
    const unknown = service.finishRequest("unknown", { outcome: "success", statusCode: 200 });
    assert.equal(unknown.attempts[0].outcome, "unknown");
    assert.equal(unknown.attempts[0].statusCode, null);
});

test("explicit unknown upstream and legacy local-looking statuses never become inferred HTTP statuses", () => {
    const cases = [
        { ...parent.attempts[0], localStatusCode: 504, statusCode: 504, upstreamStatusCode: null },
        {
            accountName: "d@example.com",
            authIndex: 4,
            finishedAt: parent.finishedAt,
            outcome: "error",
            requestAttemptId: "legacy504",
            startedAt: parent.startedAt,
            statusCode: 504,
        },
    ];
    const rows = listRequests(
        [{ ...parent, attempts: cases, statusCode: 504 }],
        parseUsageQuery({ range: "all", statusCode: "504" }, now, true)
    ).items;
    assert.equal(rows.length, 2);
    const current = rows.find(row => row.requestAttemptId === "d-call");
    assert.equal(current.upstreamStatusCode, null);
    assert.equal(current.localStatusCode, 504);
    assert.equal(current.legacyStatusCode, null);
    assert.equal(current.statusOrigin, "local");
    const legacy = rows.find(row => row.requestAttemptId === "legacy504");
    assert.equal(legacy.upstreamStatusCode, null);
    assert.equal(legacy.localStatusCode, null);
    assert.equal(legacy.legacyStatusCode, 504);
    assert.equal(legacy.statusOrigin, "legacy-unknown");
    assert.equal(legacy.historicalIncomplete, true);
});
