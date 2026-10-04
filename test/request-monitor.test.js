const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildOverview, exportRecords, listRequests, parseUsageQuery } = require("../src/core/UsageAnalytics");
const UsageStatsService = require("../src/core/UsageStatsService");
const { TokenUsageCapture } = require("../src/core/TokenUsage");
const now = Date.parse("2026-10-02T12:00:00Z");
const at = "2026-10-02T11:00:00Z";
const fixtures = [
    {
        accountKey: "unassigned",
        attemptCount: 0,
        attempts: [],
        clientIp: "10.10.10.50",
        finishedAt: at,
        model: "gemini",
        outcome: "error",
        requestCategory: "generation",
        requestId: "local",
        sequence: 1,
        startedAt: at,
        statusCode: 503,
        tokenUsage: null,
    },
    {
        accountKey: "1:a@example.com",
        attemptCount: 2,
        attempts: [
            {
                accountKey: "4:d@example.com",
                accountName: "d@example.com",
                authIndex: 4,
                finishedAt: at,
                localStatusCode: null,
                outcome: "error",
                requestAttemptId: "retry:d",
                startedAt: at,
                statusCode: 429,
                tokenUsage: null,
                upstreamStatusCode: 429,
            },
            {
                accountKey: "1:a@example.com",
                accountName: "a@example.com",
                authIndex: 1,
                finishedAt: at,
                localStatusCode: null,
                outcome: "success",
                requestAttemptId: "retry:a",
                startedAt: at,
                statusCode: 200,
                tokenUsage: {
                    cachedInputTokens: 50021,
                    inputTokens: 50034,
                    outputTokens: 298,
                    thoughtTokens: 0,
                    totalTokens: 50332,
                },
                upstreamStatusCode: 200,
            },
        ],
        clientIp: "10.10.10.50",
        finalAccountName: "a@example.com",
        finalAuthIndex: 1,
        finishedAt: at,
        model: "gemini",
        outcome: "success",
        requestCategory: "generation",
        requestId: "retry",
        sequence: 2,
        startedAt: at,
        statusCode: 200,
    },
    {
        accountKey: "4:d@example.com",
        attemptCount: 1,
        attempts: [
            {
                accountName: "d@example.com",
                authIndex: 4,
                finishedAt: at,
                localStatusCode: 499,
                outcome: "aborted",
                startedAt: at,
            },
        ],
        clientIp: "127.0.0.1",
        finalAccountName: "d@example.com",
        finalAuthIndex: 4,
        finishedAt: at,
        model: "gemini",
        outcome: "aborted",
        requestCategory: "account_test",
        requestId: "test",
        sequence: 3,
        startedAt: at,
        statusCode: 499,
    },
];

test("conversation diagnostics and per-attempt cache decisions survive completion and account filtering", () => {
    const service = new UsageStatsService(null, null, null, false);
    service.enabled = true;
    service.startRequest("diagnostic", { model: "gemini" });
    service.updateRequest("diagnostic", {
        conversationConfigChanged: true,
        conversationId: "chat_1",
        conversationMatch: "history_match",
        conversationReused: true,
        conversationSource: "history",
    });
    service.recordAttempt("diagnostic", 1, "a@example.com", "first", {
        body: "must not be persisted",
        expiresAt: "2026-10-03T06:00:00Z",
        prefixLength: 2,
        state: "selected",
        upstreamExpiresAt: "2026-10-04T05:00:00Z",
    });
    service.finishAttempt("diagnostic", {
        authIndex: 1,
        outcome: "error",
        requestAttemptId: "first",
        upstreamStatusCode: 404,
    });
    service.recordAttempt("diagnostic", 2, "b@example.com", "second", { state: "fallback" });
    assert.equal(
        service.getActive(parseUsageQuery({ range: "all", view: "requests" })).items[0].conversationMatch,
        "history_match"
    );
    service.finishAttempt("diagnostic", {
        authIndex: 2,
        outcome: "success",
        requestAttemptId: "second",
        upstreamStatusCode: 200,
    });
    const record = service.finishRequest("diagnostic", { outcome: "success", statusCode: 200 });
    assert.equal(record.conversationConfigChanged, true);
    assert.equal(record.cacheDecision.state, "fallback");
    const first = listRequests(
        [record],
        parseUsageQuery({ accountKey: "name:a@example.com", range: "all", view: "attempts" })
    ).items[0];
    assert.equal(first.cacheDecision.state, "selected");
    assert.equal(first.conversationMatch, "history_match");
    assert.equal(JSON.stringify(record).includes("must not be persisted"), false);
});

test("monitor filters share results across summary, list and export", () => {
    const cases = [
        [{ statusOrigin: "local", view: "requests" }, ["local"]],
        [{ requestOrigin: "test", view: "requests" }, ["test"]],
        [{ requestOrigin: "production", retried: "true", view: "requests" }, ["retry"]],
        [{ clientIp: "127.0.0.1", view: "requests" }, ["test"]],
        [
            { accountKey: "name:d@example.com", statusCode: "429", statusOrigin: "upstream", view: "attempts" },
            ["retry"],
        ],
    ];
    for (const [filter, ids] of cases) {
        const query = parseUsageQuery({ range: "all", ...filter }, now, true);
        assert.deepEqual(
            exportRecords(fixtures, query).map(record => record.requestId),
            ids
        );
        assert.deepEqual(
            listRequests(fixtures, query).items.map(record => record.requestId),
            ids
        );
        assert.equal(buildOverview(fixtures, query, 0, 3, now).summary.totalRequests, ids.length);
    }
});

test("snapshot and new-record counts exclude later completions with old start times", () => {
    const query = parseUsageQuery({ limit: "1", range: "all", snapshotSequence: "2", view: "requests" }, now, true);
    assert.equal(buildOverview(fixtures, query).summary.totalRequests, 2);
    assert.equal(exportRecords(fixtures, query).length, 2);
    const first = listRequests(fixtures, query);
    assert.equal(first.items[0].requestId, "retry");
    assert.equal(listRequests(fixtures, { ...query, cursor: first.nextCursor }).items[0].requestId, "local");
    assert.equal(
        buildOverview(fixtures, parseUsageQuery({ afterSequence: "2", range: "all", view: "requests" }, now)).summary
            .totalRequests,
        1
    );
});

test("conversation filtering keeps client requests, retry calls, summary and export aligned", () => {
    const records = fixtures.map(record =>
        record.requestId === "retry"
            ? {
                  ...record,
                  conversationDate: "2026-10-02",
                  conversationId: "chat_12",
                  conversationNumber: 1,
                  conversationReused: true,
                  conversationSource: "history",
              }
            : record
    );
    for (const view of ["requests", "attempts"]) {
        const query = parseUsageQuery({ conversationId: "chat_12", range: "all", view }, now, true);
        const items = listRequests(records, query).items;
        assert.equal(items.length, view === "requests" ? 1 : 2);
        assert.equal(buildOverview(records, query).summary.totalRequests, items.length);
        assert.equal(exportRecords(records, query).length, items.length);
        assert.ok(items.every(item => item.conversationId === "chat_12"));
        assert.ok(items.every(item => item.conversationSource === "history" && item.conversationReused));
        assert.ok(items.every(item => item.conversationDate === "2026-10-02" && item.conversationNumber === 1));
        assert.equal(buildOverview(records, query).filterOptions.conversations[0].conversationNumber, 1);
    }
    assert.throws(() => parseUsageQuery({ conversationId: "raw-client-session" }), /conversationId/);
});

test("conversation metadata survives queued, active and finished requests without inventing legacy associations", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-conversation-"));
    const service = new UsageStatsService(null, null, directory);
    t.after(async () => {
        await service.appendPromise;
        fs.rmSync(directory, { force: true, recursive: true });
    });
    service.startRequest("conversation", { requestCategory: "generation" });
    service.updateRequest("conversation", {
        conversationId: "chat_12",
        conversationReused: true,
        conversationSource: "session",
        queueState: "waiting",
    });
    const parents = parseUsageQuery({ conversationId: "chat_12", range: "all", view: "requests" });
    assert.equal(service.getActive(parents).items[0].conversationSource, "session");
    const label = service.getActive(parents).items[0];
    assert.match(label.conversationDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(label.conversationNumber, 1);
    service.recordAttempt("conversation", 4, "d@example.com", "conversation:d");
    const calls = parseUsageQuery({ conversationId: "chat_12", range: "all", view: "attempts" });
    assert.equal(service.getActive(calls).items[0].conversationId, "chat_12");
    assert.equal(service.getActive(calls).items[0].conversationDate, label.conversationDate);
    service.finishRequest("conversation", { outcome: "success", statusCode: 200 });
    await service.appendPromise;
    const restored = new UsageStatsService(null, null, directory);
    assert.equal(restored.getRequest("conversation").conversationId, "chat_12");
    assert.equal(restored.getRequest("conversation").conversationReused, true);
    assert.equal(restored.getRequest("conversation").conversationSource, "session");
    assert.equal(restored.getRequest("conversation").conversationDate, label.conversationDate);
    assert.equal(restored.getRequest("conversation").conversationNumber, label.conversationNumber);
    await restored.importJsonl(
        JSON.stringify({
            ...restored.getRequest("conversation"),
            conversationDate: undefined,
            conversationNumber: undefined,
            requestId: "imported-old",
            startedAt: "2020-01-01T00:00:00Z",
        })
    );
    await restored.appendPromise;
    assert.equal(restored.getRequest("imported-old").conversationDate, label.conversationDate);
    assert.equal(restored.getRequest("imported-old").conversationNumber, label.conversationNumber);
    const emptyRange = restored.getOverview(
        parseUsageQuery({
            conversationId: "chat_12",
            from: "2099-01-01T00:00:00Z",
            range: "custom",
            to: "2099-01-02T00:00:00Z",
            view: "requests",
        })
    );
    assert.equal(emptyRange.summary.totalRequests, 0);
    assert.equal(emptyRange.filterOptions.conversations[0].conversationDate, label.conversationDate);
    const legacy = restored._normalizeLoadedRecord(fixtures[1]);
    assert.equal(legacy.conversationId, undefined);
    assert.equal(listRequests([legacy], parents).items.length, 0);
});

test("a timeout after upstream200 remains filterable by its local504 status", () => {
    const record = {
        ...fixtures[1],
        attemptCount: 1,
        attempts: [
            {
                ...fixtures[1].attempts[1],
                localStatusCode: 504,
                outcome: "error",
                terminationReason: "request_deadline_exceeded",
                upstreamStatusCode: 200,
            },
        ],
        outcome: "error",
        statusCode: 504,
    };
    for (const source of ["", "local"]) {
        const query = parseUsageQuery(
            { range: "all", statusCode: "504", statusOrigin: source, view: "attempts" },
            now,
            true
        );
        assert.equal(buildOverview([record], query).summary.errorCount, 1);
        assert.equal(listRequests([record], query).items.length, 1);
        assert.equal(exportRecords([record], query).length, 1);
    }
    const query = parseUsageQuery(
        { range: "all", statusCode: "504", statusOrigin: "upstream", view: "attempts" },
        now,
        true
    );
    assert.equal(listRequests([record], query).items.length, 0);
});

test("cancelled records do not lower success rate and recent outcomes belong to the account", () => {
    assert.equal(
        buildOverview(fixtures, parseUsageQuery({ range: "all", view: "requests" }, now)).summary.successRate,
        50
    );
    const calls = buildOverview(
        fixtures,
        parseUsageQuery({ accountKey: "name:d@example.com", range: "all", view: "attempts" }, now)
    );
    assert.equal(calls.summary.successRate, 0);
    assert.deepEqual(
        calls.accounts[0].recentOutcomes.map(item => item.outcome),
        ["aborted", "error"]
    );
    assert.equal(calls.accounts[0].tokenUsage.inputTokens, null);
});

test("cache anomalies remain visible and suppress invalid cache rates", () => {
    const usage = { cachedInputTokens: 10, inputTokens: 2 };
    const records = [
        { ...fixtures[2], attempts: [{ ...fixtures[2].attempts[0], tokenUsage: usage }], tokenUsage: usage },
    ];
    const summary = buildOverview(records, parseUsageQuery({ range: "all", view: "requests" }, now)).summary;
    assert.equal(summary.cacheAnomalyCount, 1);
    assert.equal(summary.cacheReadRate, null);
    assert.equal(summary.tokenUsage.cachedInputTokens, 10);
});

test("active snapshots contain live calls only and vanish on completion", () => {
    const service = new UsageStatsService(null, null, null, false);
    service.enabled = true;
    service.startRequest("pending", { clientIp: "10.10.10.50", model: "gemini" });
    service.updateRequest("pending", { queueState: "queued" });
    service.startRequest("active", { model: "gemini" });
    service.recordAttempt("active", 4, "d@example.com", "active:d");
    service.finishAttempt("active", {
        authIndex: 4,
        outcome: "error",
        requestAttemptId: "active:d",
        upstreamStatusCode: 429,
    });
    service.recordAttempt("active", 1, "a@example.com", "active:a");
    const current = service.getRequest("active");
    assert.equal(current.outcome, "in_progress");
    assert.equal(current.attempts[0].outcome, "error");
    assert.equal(current.attempts[0].upstreamStatusCode, 429);
    assert.equal(current.attempts[0].active, false);
    assert.equal(current.attempts[1].active, true);
    assert.equal(Object.hasOwn(current, "tokenCaptures"), false);
    const parents = service.getActive(parseUsageQuery({ range: "all", view: "requests" }));
    assert.equal(parents.items.length, 2);
    assert.equal(parents.items.find(row => row.requestId === "pending").outcome, "queued");
    assert.equal(Object.hasOwn(parents.items[0], "tokenCaptures"), false);
    assert.equal(
        service.getActive(parseUsageQuery({ accountKey: "name:d@example.com", range: "all", view: "attempts" })).items
            .length,
        0
    );
    const a = service.getActive(parseUsageQuery({ accountKey: "name:a@example.com", range: "all", view: "attempts" }));
    assert.equal(a.items.length, 1);
    assert.equal(a.items[0].outcome, "in_progress");
    service.activeRequests.delete("active");
    assert.equal(service.getActive(parseUsageQuery({ range: "all", view: "attempts" })).items.length, 0);
});

test("first text timing ignores thoughts and tool calls", () => {
    const capture = new TokenUsageCapture();
    const event = parts => `data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\n\n`;
    capture.ingest(event([{ text: "thinking", thought: true }]), 1000);
    capture.ingest(event([{ functionCall: { name: "read_file" } }]), 2000);
    assert.equal(capture.firstTextAtMs, null);
    capture.ingest(event([{ text: "hello" }]), 3000);
    capture.ingest(event([{ text: "world" }]), 5000);
    capture.finish();
    assert.equal(capture.firstTextAtMs, 3000);
    assert.equal(capture.lastTextAtMs, 5000);
    const nonStream = new TokenUsageCapture();
    nonStream.ingest(JSON.stringify({ candidates: [{ content: { parts: [{ text: "reply" }] } }] }), 6000);
    assert.equal(nonStream.firstTextAtMs, 6000);
});

test("missing historical outcome and duration remain unknown", () => {
    const record = new UsageStatsService(null, null, null, false)._normalizeLoadedRecord({ requestId: "legacy" });
    assert.equal(record.outcome, "unknown");
    assert.equal(record.durationMs, null);
});

test("saved latency and stream TPS use body text timing and exclude thought tokens", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-timing-"));
    const service = new UsageStatsService(null, null, directory);
    t.after(async () => {
        await service.appendPromise;
        fs.rmSync(directory, { force: true, recursive: true });
    });
    const start = Date.now() - 5000;
    for (const streaming of [true, false]) {
        const requestId = streaming ? "stream" : "nonstream";
        const tracker = service.startRequest(requestId, { isStreaming: streaming });
        tracker.startedAtMs = start;
        tracker.startedAt = new Date(start).toISOString();
        service.recordAttempt(requestId, 1, "a@example.com", `${requestId}:a`);
        tracker.attempts[0].startedAt = new Date(start).toISOString();
        const capture = new TokenUsageCapture();
        capture.ingest('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n', start + 1000);
        capture.ingest(
            'data: {"candidates":[{"content":{"parts":[{"text":"world"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":20,"thoughtsTokenCount":80,"totalTokenCount":102}}\n\n',
            start + 3000
        );
        tracker.tokenCaptures.set(`${requestId}:a`, capture);
        service.finishAttempt(requestId, {
            authIndex: 1,
            outcome: "success",
            requestAttemptId: `${requestId}:a`,
            upstreamStatusCode: 200,
        });
        const record = service.finishRequest(requestId, { outcome: "success", statusCode: 200 });
        assert.equal(record.firstTextLatencyMs, 1000);
        assert.equal(record.attempts[0].firstTextLatencyMs, 1000);
        assert.equal(record.tokenUsage.outputTokens, 100);
        assert.equal(record.generationTps, streaming ? 10 : null);
        assert.equal(record.attempts[0].generationTps, streaming ? 10 : null);
    }
});
