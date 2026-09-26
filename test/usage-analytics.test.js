const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildOverview, listRequests, parseUsageQuery } = require("../src/core/UsageAnalytics");
const UsageStatsService = require("../src/core/UsageStatsService");

const nowMs = Date.parse("2026-09-25T12:00:00.000Z");
const records = [
    {
        accountKey: "0:alpha@example.com",
        attemptCount: 1,
        attempts: [{ accountKey: "0:alpha@example.com" }],
        durationMs: 1200,
        errorMessage: "Quota exceeded",
        finalAccountName: "alpha@example.com",
        finalAuthIndex: 0,
        finishedAt: "2026-09-25T10:00:01.000Z",
        model: "gemini-flash",
        outcome: "error",
        requestId: "request-1",
        sequence: 1,
        startedAt: "2026-09-25T10:00:00.000Z",
        statusCode: 429,
    },
    {
        accountKey: "1:beta@example.com",
        attemptCount: 2,
        durationMs: 3000,
        finalAccountName: "beta@example.com",
        finalAuthIndex: 1,
        finishedAt: "2026-09-25T10:10:03.000Z",
        model: "gemini-flash",
        outcome: "success",
        requestId: "request-2",
        sequence: 2,
        startedAt: "2026-09-25T10:10:00.000Z",
        statusCode: 200,
    },
    {
        accountKey: "1:beta@example.com",
        attemptCount: 1,
        durationMs: 400,
        finalAccountName: "beta@example.com",
        finalAuthIndex: 1,
        finishedAt: "2026-09-25T10:20:01.000Z",
        model: "gemini-pro",
        outcome: "aborted",
        requestId: "request-3",
        sequence: 3,
        startedAt: "2026-09-25T10:20:00.000Z",
        statusCode: null,
    },
    {
        accountKey: "0:alpha@example.com",
        attemptCount: 1,
        durationMs: 1000,
        finalAccountName: "alpha@example.com",
        finalAuthIndex: 0,
        finishedAt: "2026-09-25T11:00:01.000Z",
        model: "gemini-pro",
        outcome: "success",
        requestId: "request-4",
        sequence: 4,
        startedAt: "2026-09-25T11:00:00.000Z",
        statusCode: 200,
    },
];

test("overview summarizes completed requests and attributes them to final accounts", () => {
    const query = parseUsageQuery({ range: "24h" }, nowMs);
    const overview = buildOverview(records, query, 2, 4, nowMs);

    assert.deepEqual(
        {
            abortedCount: overview.summary.abortedCount,
            activeRequests: overview.summary.activeRequests,
            avgDurationMs: overview.summary.avgDurationMs,
            errorCount: overview.summary.errorCount,
            retriedRequests: overview.summary.retriedRequests,
            successCount: overview.summary.successCount,
            successRate: overview.summary.successRate,
            totalRequests: overview.summary.totalRequests,
        },
        {
            abortedCount: 1,
            activeRequests: 2,
            avgDurationMs: 1400,
            errorCount: 1,
            retriedRequests: 1,
            successCount: 2,
            successRate: 50,
            totalRequests: 4,
        }
    );
    assert.equal(overview.accounts.find(account => account.finalAuthIndex === 1).totalRequests, 2);
    assert.equal(overview.accounts.find(account => account.finalAuthIndex === 1).errorCount, 0);
    assert.equal(overview.recentFailures[0].requestId, "request-1");
    assert.equal(overview.recentFailures[0].sequence, 1);
    assert.equal(overview.recentFailures[0].startedAt, records[0].startedAt);
    assert.equal(overview.recentFailures[0].durationMs, records[0].durationMs);
    assert.equal(overview.recentFailures[0].attemptCount, records[0].attemptCount);
    assert.deepEqual(overview.recentFailures[0].attempts, records[0].attempts);
    assert.equal(
        overview.trend.reduce((total, bucket) => total + bucket.totalRequests, 0),
        4
    );
    assert.deepEqual(overview.filterOptions.models, ["gemini-flash", "gemini-pro"]);
    assert.equal("records" in overview, false);
});

test("overview and requests share time, account, model, outcome, status and search filters", () => {
    const query = parseUsageQuery(
        {
            accountKey: "0:alpha@example.com",
            from: "2026-09-25T09:00:00.000Z",
            model: "gemini-flash",
            outcome: "error",
            q: "quota",
            statusCode: "429",
            to: "2026-09-25T10:05:00.000Z",
        },
        nowMs,
        true
    );
    const overview = buildOverview(records, query, 0, 4, nowMs);
    const page = listRequests(records, query);

    assert.equal(overview.range.key, "custom");
    assert.equal(overview.summary.totalRequests, 1);
    assert.equal(overview.accounts[0].accountKey, "name:alpha@example.com");
    assert.deepEqual(overview.filterOptions.models, ["gemini-flash"]);
    assert.deepEqual(
        page.items.map(item => item.requestId),
        ["request-1"]
    );
    assert.equal(page.totalMatched, 1);

    const searchOnly = buildOverview(records, parseUsageQuery({ q: "quota" }, nowMs), 0, 4, nowMs);
    assert.equal(searchOnly.summary.totalRequests, 1);
    assert.deepEqual(searchOnly.filterOptions.models, ["gemini-flash", "gemini-pro"]);
});

test("sequence cursor keeps later pages stable when a new request arrives", () => {
    const firstQuery = parseUsageQuery({ limit: "2", range: "all" }, nowMs, true);
    const firstPage = listRequests(records, firstQuery);
    assert.deepEqual(
        firstPage.items.map(item => item.sequence),
        [4, 3]
    );
    assert.equal(firstPage.nextCursor, 3);
    assert.equal(firstPage.hasMore, true);

    const appended = records.concat({ ...records[3], requestId: "request-5", sequence: 5 });
    const secondQuery = parseUsageQuery(
        { cursor: String(firstPage.nextCursor), limit: "2", range: "all" },
        nowMs,
        true
    );
    const secondPage = listRequests(appended, secondQuery);
    assert.deepEqual(
        secondPage.items.map(item => item.sequence),
        [2, 1]
    );
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.totalMatched, 5);
});

test("invalid time windows, filters and oversized pages are rejected", () => {
    assert.throws(() => parseUsageQuery({ range: "yesterday" }, nowMs), /range/);
    assert.throws(() => parseUsageQuery({ outcome: "healthy" }, nowMs), /outcome/);
    assert.throws(() => parseUsageQuery({ from: "2026-09-26T00:00:00Z", to: "2026-09-25T00:00:00Z" }, nowMs), /from/);
    assert.throws(() => parseUsageQuery({ limit: "101" }, nowMs, true), /limit/);
    assert.throws(() => parseUsageQuery({ cursor: "1e3" }, nowMs, true), /cursor/);
    assert.throws(() => parseUsageQuery({ model: ["first", "second"] }, nowMs), /model/);
});

test("loading persisted records preserves an unknown HTTP status", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-usage-test-"));
    try {
        fs.writeFileSync(path.join(directory, "usage-stats.jsonl"), `${JSON.stringify(records[2])}\n`);
        const service = new UsageStatsService(null, null, directory);
        assert.equal(service.records[0].statusCode, null);
        assert.equal(service.getOverview(parseUsageQuery({ range: "all" }, nowMs), nowMs).summary.totalRequests, 1);
    } finally {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("token totals keep missing history distinct from real zero and follow filters", () => {
    const tokenRecords = [
        records[0],
        { ...records[1], tokenUsage: { cachedInputTokens: 0, inputTokens: 100, outputTokens: 30, totalTokens: 130 } },
        { ...records[2], tokenUsage: { cachedInputTokens: 5, inputTokens: 20, outputTokens: null, totalTokens: null } },
        { ...records[3], tokenUsage: { cachedInputTokens: null, inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ];
    const overview = buildOverview(tokenRecords, parseUsageQuery({ range: "24h" }, nowMs), 0, 4, nowMs);
    assert.equal(overview.summary.tokenUsage.totalTokens, 130);
    assert.equal(overview.summary.tokenUsage.inputTokens, 120);
    assert.equal(overview.summary.tokenUsage.cachedInputTokens, 5);
    assert.equal(overview.summary.tokenUsageCoverage.totalTokens, 2);
    assert.equal(overview.summary.tokenUsageCoverage.cachedInputTokens, 2);
    assert.equal(overview.accounts.find(account => account.finalAuthIndex === 0).tokenUsage.totalTokens, 0);
    assert.equal(overview.models.find(model => model.model === "gemini-pro").tokenUsageCoverage.totalTokens, 1);

    const filtered = buildOverview(
        tokenRecords,
        parseUsageQuery({ model: "gemini-flash", outcome: "error" }, nowMs),
        0,
        4,
        nowMs
    );
    assert.equal(filtered.summary.tokenUsage.totalTokens, null);
    assert.equal(filtered.summary.tokenUsageCoverage.totalTokens, 0);
});

test("attempt tokens belong to the account that made each call, including before a switch", () => {
    const switched = {
        ...records[1],
        apiKeyId: "key-7",
        attempts: [
            {
                accountKey: "0:alpha@example.com",
                accountName: "alpha@example.com",
                authIndex: 0,
                outcome: "error",
                requestAttemptId: "request-2:1",
                statusCode: 503,
                tokenUsage: { cachedInputTokens: 20, inputTokens: 100, outputTokens: 30, totalTokens: 130 },
            },
            {
                accountKey: "1:beta@example.com",
                accountName: "beta@example.com",
                authIndex: 1,
                outcome: "success",
                requestAttemptId: "request-2:2",
                statusCode: 200,
                tokenUsage: { cachedInputTokens: 0, inputTokens: 50, outputTokens: 20, totalTokens: 70 },
            },
        ],
        requestCategory: "generation",
        tokenUsage: { cachedInputTokens: 20, inputTokens: 150, outputTokens: 50, totalTokens: 200 },
    };
    const all = buildOverview([switched], parseUsageQuery({ range: "all" }, nowMs), 0, 2, nowMs);
    assert.equal(all.summary.totalRequests, 1);
    assert.equal(all.summary.attemptCount, 2);
    assert.equal(all.summary.tokenUsage.totalTokens, 200);
    assert.equal(all.summary.cacheReadRate, 13.3);
    assert.equal(
        all.accounts.find(account => account.accountKey === "name:alpha@example.com").tokenUsage.totalTokens,
        130
    );
    assert.equal(all.accounts.find(account => account.accountKey === "name:alpha@example.com").totalRequests, 0);
    assert.equal(
        all.accounts.find(account => account.accountKey === "name:beta@example.com").tokenUsage.totalTokens,
        70
    );
    assert.equal(all.accounts.find(account => account.accountKey === "name:beta@example.com").totalRequests, 1);
    assert.equal(all.apiKeys[0].apiKeyId, "key-7");
    assert.equal(all.apiKeys[0].tokenUsage.totalTokens, 200);
    assert.deepEqual(all.filterOptions.requestCategories, ["generation"]);

    const alphaQuery = parseUsageQuery({ accountKey: "0:alpha@example.com", range: "all" }, nowMs, true);
    const alpha = buildOverview([switched], alphaQuery, 0, 2, nowMs);
    assert.equal(alpha.summary.totalRequests, 1);
    assert.equal(alpha.summary.tokenUsage.totalTokens, 130);
    assert.equal(alpha.summary.cacheReadRate, 20);
    assert.equal(
        alpha.trend.reduce((sum, bucket) => sum + (bucket.tokenUsage.totalTokens || 0), 0),
        130
    );
    assert.equal(alpha.accounts.length, 1);
    assert.equal(alpha.accounts[0].accountKey, "name:alpha@example.com");
    const alphaPage = listRequests([switched], alphaQuery);
    assert.equal(alphaPage.items[0].tokenUsage.totalTokens, 200);
    assert.equal(alphaPage.items[0].scopedTokenUsage.totalTokens, 130);
    assert.equal(alphaPage.tokenUsageScope, "matching-attempts");
});

test("cache state, token coverage and API-key filters never infer a missing usage value as zero", () => {
    const unknown = { ...records[0], apiKeyId: "key-a", tokenUsage: null };
    const miss = {
        ...records[3],
        apiKeyId: "key-b",
        requestCategory: "generation",
        tokenUsage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    const hit = {
        ...records[1],
        apiKeyId: "key-b",
        attemptCount: 1,
        requestCategory: "generation",
        tokenUsage: { cachedInputTokens: 10, inputTokens: 50, outputTokens: 10, totalTokens: 60 },
    };
    const data = [unknown, miss, hit];
    assert.deepEqual(
        ["unknown", "miss", "hit"].map(
            cacheState => listRequests(data, parseUsageQuery({ cacheState, range: "all" }, nowMs, true)).totalMatched
        ),
        [1, 1, 1]
    );
    const filteredQuery = parseUsageQuery(
        { apiKeyId: "key-b", maxDurationMs: "3000", minDurationMs: "1000", requestCategory: "generation" },
        nowMs,
        true
    );
    const overview = buildOverview(data, filteredQuery, 0, 3, nowMs);
    assert.equal(overview.summary.totalRequests, listRequests(data, filteredQuery).totalMatched);
    assert.equal(overview.summary.totalRequests, 2);
    assert.equal(overview.summary.tokenUsage.totalTokens, 60);
    assert.equal(overview.summary.tokenUsageCoverage.totalTokens, 2);
    assert.equal(overview.summary.cacheReadRate, 20);
    assert.equal(overview.summary.cacheReadCoverage, 2);
    assert.equal(overview.summary.cacheReadEligibleInputTokens, 50);
    assert.equal(overview.apiKeys[0].apiKeyId, "key-b");
});

test("legacy multi-attempt totals remain unassigned and daily buckets respect timezone", () => {
    const legacy = {
        ...records[1],
        attempts: [{ accountKey: "0:alpha@example.com" }, { accountKey: "1:beta@example.com" }],
        tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
    const query = parseUsageQuery({ granularity: "day", range: "all", timezone: "Asia/Singapore" }, nowMs);
    const overview = buildOverview([legacy], query, 0, 2, nowMs);
    assert.equal(overview.summary.tokenUsage.totalTokens, 15);
    assert.equal(overview.accounts.find(account => account.unattributed).tokenUsage.totalTokens, 15);
    assert.equal(
        overview.accounts.find(account => account.accountKey === "name:beta@example.com").tokenUsage.totalTokens,
        null
    );
    assert.equal(overview.trend[0].start, "2026-09-24T16:00:00.000Z");
    assert.equal(overview.range.timezone, "Asia/Singapore");
    const unattributed = parseUsageQuery({ accountKey: "unattributed", range: "all" }, nowMs, true);
    assert.equal(listRequests([legacy], unattributed).totalMatched, 1);
    assert.equal(buildOverview([legacy], unattributed, 0, 2, nowMs).summary.tokenUsage.totalTokens, 15);
});

test("account identity stays stable when an account index changes", () => {
    const moved = {
        ...records[3],
        accountKey: "9:alpha@example.com",
        finalAuthIndex: 9,
        requestId: "moved-account",
        sequence: 5,
    };
    const overview = buildOverview([records[3], moved], parseUsageQuery({ range: "all" }, nowMs), 0, 5, nowMs);
    assert.equal(overview.accounts.length, 1);
    assert.equal(overview.accounts[0].accountKey, "name:alpha@example.com");
    assert.equal(overview.accounts[0].totalRequests, 2);
    const oldKey = parseUsageQuery({ accountKey: "0:alpha@example.com", range: "all" }, nowMs, true);
    assert.equal(listRequests([records[3], moved], oldKey).totalMatched, 2);
});

test("daily trend follows timezone midnight across a daylight-saving transition", () => {
    const query = parseUsageQuery(
        {
            from: "2026-03-08T05:00:00.000Z",
            granularity: "day",
            timezone: "America/New_York",
            to: "2026-03-10T04:00:00.000Z",
        },
        nowMs
    );
    const record = {
        ...records[3],
        finishedAt: "2026-03-08T12:00:01.000Z",
        startedAt: "2026-03-08T12:00:00.000Z",
    };
    const overview = buildOverview([record], query, 0, 1, nowMs);
    assert.deepEqual(
        overview.trend.map(bucket => bucket.start),
        ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", "2026-03-10T04:00:00.000Z"]
    );
});
