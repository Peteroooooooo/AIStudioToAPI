const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RANGE_DURATION_MS = { "1h": HOUR_MS, "7d": 7 * DAY_MS, "24h": DAY_MS, "30d": 30 * DAY_MS };

const MAX_PAGE_SIZE = 100;
const MAX_TREND_BUCKETS = 120;
const UNATTRIBUTED_ACCOUNT_KEY = "unattributed";
const formatters = new Map();
const { normalizeTokenUsage, TOKEN_FIELDS } = require("./TokenUsage");
const { sumTokenUsage } = require("./TokenUsage");

class UsageQueryError extends Error {
    constructor(field) {
        super(`Invalid usage query field: ${field}`);
        this.name = "UsageQueryError";
    }
}

function scalar(query, field, maxLength = 200) {
    const value = query?.[field];
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string" || value.length > maxLength) throw new UsageQueryError(field);
    return value.trim();
}

function parseDate(query, field) {
    const value = scalar(query, field, 64);
    if (!value) return null;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new UsageQueryError(field);
    return parsed;
}

function parseNonnegativeInteger(query, field) {
    const value = scalar(query, field, 16);
    if (!value) return null;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) throw new UsageQueryError(field);
    return parsed;
}

function accountNameFromKey(accountKey) {
    if (typeof accountKey !== "string") return null;
    const separator = accountKey.indexOf(":");
    if (separator < 0) return null;
    if (accountKey.startsWith("index:")) return null;
    const name = accountKey.slice(separator + 1).trim();
    return name && name !== "N/A" ? name : null;
}

function normalizeAccountKey(accountKey, accountName = null, authIndex = null) {
    if (accountKey === UNATTRIBUTED_ACCOUNT_KEY) return UNATTRIBUTED_ACCOUNT_KEY;
    const name = accountName || accountNameFromKey(accountKey);
    if (name) return `name:${name.toLowerCase()}`;
    const indexText = String(accountKey ?? "").split(":", 1)[0];
    const parsedIndex = /^\d+$/.test(indexText) ? Number(indexText) : null;
    const index = Number.isInteger(authIndex) && authIndex >= 0 ? authIndex : parsedIndex;
    if (Number.isSafeInteger(index) && index >= 0) return `index:${index}`;
    return accountKey || "unassigned";
}

function accountIdentitySource(accountKey) {
    if (accountKey.startsWith("name:")) return "name";
    if (accountKey.startsWith("index:")) return "index";
    return "unknown";
}

function parseUsageQuery(rawQuery = {}, nowMs = Date.now(), includePagination = false) {
    const requestedRange = scalar(rawQuery, "range", 16) || "24h";
    if (requestedRange !== "all" && requestedRange !== "custom" && !RANGE_DURATION_MS[requestedRange]) {
        throw new UsageQueryError("range");
    }

    const customFrom = parseDate(rawQuery, "from");
    const customTo = parseDate(rawQuery, "to");
    const custom = customFrom !== null || customTo !== null;
    if (requestedRange === "custom" && !custom) throw new UsageQueryError("from");

    const rangeKey = custom ? "custom" : requestedRange;
    const fromMs = custom ? customFrom : rangeKey === "all" ? null : nowMs - RANGE_DURATION_MS[rangeKey];
    const toMs = custom ? (customTo ?? nowMs) : rangeKey === "all" ? null : nowMs;
    if (fromMs !== null && toMs !== null && fromMs > toMs) throw new UsageQueryError("from");

    const model = scalar(rawQuery, "model");
    const accountKeyRaw = scalar(rawQuery, "accountKey", 320);
    const accountKey = accountKeyRaw ? normalizeAccountKey(accountKeyRaw) : "";
    const apiKeyId = scalar(rawQuery, "apiKeyId", 128);
    const requestCategory = scalar(rawQuery, "requestCategory", 64);
    const apiFormat = scalar(rawQuery, "apiFormat", 64);
    const cacheState = scalar(rawQuery, "cacheState", 16);
    if (cacheState && !["hit", "miss", "unknown"].includes(cacheState)) throw new UsageQueryError("cacheState");
    const minDurationMs = parseNonnegativeInteger(rawQuery, "minDurationMs");
    const maxDurationMs = parseNonnegativeInteger(rawQuery, "maxDurationMs");
    if (minDurationMs !== null && maxDurationMs !== null && minDurationMs > maxDurationMs) {
        throw new UsageQueryError("minDurationMs");
    }
    const granularity = scalar(rawQuery, "granularity", 16) || "auto";
    if (!["auto", "hour", "day"].includes(granularity)) throw new UsageQueryError("granularity");
    const timezone = scalar(rawQuery, "timezone", 64) || "UTC";
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
        throw new UsageQueryError("timezone");
    }
    const outcome = scalar(rawQuery, "outcome", 16);
    if (outcome && !["success", "error", "aborted"].includes(outcome)) throw new UsageQueryError("outcome");
    const q = scalar(rawQuery, "q").toLowerCase();
    const rawStatus = scalar(rawQuery, "statusCode", 3);
    const statusCode = rawStatus ? Number(rawStatus) : null;
    if (rawStatus && (!/^\d{3}$/.test(rawStatus) || statusCode < 100 || statusCode > 599)) {
        throw new UsageQueryError("statusCode");
    }

    let limit = 20;
    let cursor = null;
    if (includePagination) {
        const rawLimit = scalar(rawQuery, "limit", 3);
        if (rawLimit) {
            limit = Number(rawLimit);
            if (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
                throw new UsageQueryError("limit");
            }
        }
        const rawCursor = scalar(rawQuery, "cursor", 16);
        if (rawCursor) {
            cursor = Number(rawCursor);
            if (!/^\d+$/.test(rawCursor) || !Number.isSafeInteger(cursor) || cursor < 1) {
                throw new UsageQueryError("cursor");
            }
        }
    }

    return {
        accountKey,
        apiFormat,
        apiKeyId,
        cacheState,
        cursor,
        fromMs,
        granularity,
        limit,
        maxDurationMs,
        minDurationMs,
        model,
        outcome,
        q,
        rangeKey,
        requestCategory,
        statusCode,
        timezone,
        toMs,
    };
}

function getAccountKey(record) {
    return normalizeAccountKey(record.accountKey, record.finalAccountName, record.finalAuthIndex);
}

function getAttemptAccountKey(attempt) {
    return normalizeAccountKey(attempt?.accountKey, attempt?.accountName, attempt?.authIndex);
}

function getCacheState(record) {
    const attempts = Array.isArray(record.attempts) ? record.attempts : [];
    const detailed = attempts.some(attempt => Object.hasOwn(attempt, "tokenUsage") || attempt.requestAttemptId);
    if (!detailed && record.attemptCount > 1) return "unknown";
    const usages = detailed
        ? attempts.map(attempt => normalizeTokenUsage(attempt.tokenUsage))
        : [normalizeTokenUsage(record.tokenUsage)];
    if (usages.some(usage => usage?.cachedInputTokens > 0)) return "hit";
    if (usages.length && usages.every(usage => usage?.cachedInputTokens === 0)) return "miss";
    return "unknown";
}

function getRecordTime(record) {
    const startedAt = Date.parse(record.startedAt);
    if (Number.isFinite(startedAt)) return startedAt;
    const finishedAt = Date.parse(record.finishedAt);
    return Number.isFinite(finishedAt) ? finishedAt : null;
}

function matchesTime(record, query) {
    const timestamp = getRecordTime(record);
    if (timestamp === null) return false;
    return (query.fromMs === null || timestamp >= query.fromMs) && (query.toMs === null || timestamp <= query.toMs);
}

function matchesFilters(record, query) {
    if (
        query.accountKey &&
        getAccountKey(record) !== query.accountKey &&
        !(record.attempts || []).some(attempt => getAttemptAccountKey(attempt) === query.accountKey) &&
        !(
            query.accountKey === UNATTRIBUTED_ACCOUNT_KEY &&
            getTokenEvents(record).some(event => event.accountKey === UNATTRIBUTED_ACCOUNT_KEY && event.usage)
        )
    )
        return false;
    if (query.model && (record.model || "unknown") !== query.model) return false;
    if (query.apiKeyId && (record.apiKeyId || "unknown") !== query.apiKeyId) return false;
    if (query.requestCategory && (record.requestCategory || "unknown") !== query.requestCategory) return false;
    if (query.apiFormat && (record.apiFormat || "unknown") !== query.apiFormat) return false;
    if (query.outcome && record.outcome !== query.outcome) return false;
    if (query.statusCode !== null && record.statusCode !== query.statusCode) return false;
    if (query.cacheState && getCacheState(record) !== query.cacheState) return false;
    if (
        (query.minDurationMs !== null || query.maxDurationMs !== null) &&
        (!Number.isFinite(record.durationMs) ||
            (query.minDurationMs !== null && record.durationMs < query.minDurationMs) ||
            (query.maxDurationMs !== null && record.durationMs > query.maxDurationMs))
    )
        return false;
    if (query.q) {
        const searchable = [
            record.requestId,
            record.model,
            record.finalAccountName,
            record.apiKeyId,
            record.apiFormat,
            record.requestCategory,
            record.clientIp,
            record.errorMessage,
            record.path,
            record.statusCode,
            ...(record.attempts || []).map(attempt => attempt.accountName),
        ];
        if (
            !searchable.some(value =>
                String(value ?? "")
                    .toLowerCase()
                    .includes(query.q)
            )
        )
            return false;
    }
    return true;
}

function rate(successCount, totalRequests) {
    return totalRequests ? Number(((successCount / totalRequests) * 100).toFixed(1)) : 0;
}

function createCounts() {
    return {
        abortedCount: 0,
        attemptCount: 0,
        cacheReadCoverage: 0,
        cacheReadEligibleInputTokens: 0,
        cacheReadRate: null,
        errorCount: 0,
        successCount: 0,
        tokenUsage: Object.fromEntries(TOKEN_FIELDS.map(field => [field, null])),
        tokenUsageCoverage: Object.fromEntries(TOKEN_FIELDS.map(field => [field, 0])),
        totalRequests: 0,
        touchedRequests: 0,
    };
}

function addRequestCounts(counts, record) {
    counts.totalRequests += 1;
    if (record.outcome === "success") counts.successCount += 1;
    else if (record.outcome === "aborted") counts.abortedCount += 1;
    else counts.errorCount += 1;
}

function addUsage(counts, rawUsage) {
    const usage = normalizeTokenUsage(rawUsage);
    if (usage) {
        for (const field of TOKEN_FIELDS) {
            if (usage[field] === null) continue;
            counts.tokenUsage[field] = (counts.tokenUsage[field] ?? 0) + usage[field];
            counts.tokenUsageCoverage[field] += 1;
        }
    }
}

function addCachePair(counts, rawUsage) {
    const usage = normalizeTokenUsage(rawUsage);
    if (!usage || usage.inputTokens === null || usage.cachedInputTokens === null) return;
    counts.cacheReadCoverage += 1;
    counts.cacheReadEligibleInputTokens += usage.inputTokens;
    counts._cachedInputForRate = (counts._cachedInputForRate || 0) + usage.cachedInputTokens;
}

function finishCounts(counts) {
    counts.cacheReadRate = counts.cacheReadEligibleInputTokens
        ? Number((((counts._cachedInputForRate || 0) / counts.cacheReadEligibleInputTokens) * 100).toFixed(1))
        : null;
    delete counts._cachedInputForRate;
    return counts;
}

function getTokenEvents(record) {
    const attempts = Array.isArray(record.attempts) ? record.attempts : [];
    const detailed = attempts.some(attempt => Object.hasOwn(attempt, "tokenUsage") || attempt.requestAttemptId);
    if (detailed) {
        return attempts.map(attempt => ({
            accountKey: getAttemptAccountKey(attempt),
            accountName: attempt.accountName || accountNameFromKey(attempt.accountKey),
            authIndex: attempt.authIndex ?? null,
            finishedAt: attempt.finishedAt || record.finishedAt,
            usage: normalizeTokenUsage(attempt.tokenUsage),
        }));
    }
    const attributable = attempts.length === 1 || (!attempts.length && record.attemptCount === 1);
    return [
        {
            accountKey: attributable
                ? attempts.length
                    ? getAttemptAccountKey(attempts[0])
                    : getAccountKey(record)
                : UNATTRIBUTED_ACCOUNT_KEY,
            accountName: attributable ? record.finalAccountName || accountNameFromKey(record.accountKey) : null,
            authIndex: attributable ? (record.finalAuthIndex ?? null) : null,
            finishedAt: record.finishedAt,
            usage: normalizeTokenUsage(record.tokenUsage),
        },
    ];
}

function getScopedEvents(record, query) {
    const events = getTokenEvents(record);
    return query.accountKey ? events.filter(event => event.accountKey === query.accountKey) : events;
}

function addRecord(counts, record, query) {
    addRequestCounts(counts, record);
    const events = getScopedEvents(record, query);
    counts.attemptCount += query.accountKey ? events.length : record.attemptCount || events.length;
    addUsage(
        counts,
        query.accountKey
            ? sumTokenUsage(events.map(event => event.usage))
            : record.tokenUsage || sumTokenUsage(events.map(event => event.usage))
    );
    for (const event of events) addCachePair(counts, event.usage);
}

function getFormatter(timezone) {
    if (!formatters.has(timezone)) {
        formatters.set(
            timezone,
            new Intl.DateTimeFormat("en-US", {
                day: "2-digit",
                hour: "2-digit",
                hourCycle: "h23",
                minute: "2-digit",
                month: "2-digit",
                second: "2-digit",
                timeZone: timezone,
                year: "numeric",
            })
        );
    }
    return formatters.get(timezone);
}

function zonedParts(timeMs, timezone) {
    return Object.fromEntries(
        getFormatter(timezone)
            .formatToParts(timeMs)
            .filter(part => part.type !== "literal")
            .map(part => [part.type, Number(part.value)])
    );
}

function offsetAt(timeMs, timezone) {
    const parts = zonedParts(timeMs, timezone);
    const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return localAsUtc - Math.floor(timeMs / 1000) * 1000;
}

function zonedDayStart(timeMs, timezone) {
    const parts = zonedParts(timeMs, timezone);
    const midnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
    let start = midnightAsUtc - offsetAt(timeMs, timezone);
    for (let iteration = 0; iteration < 3; iteration += 1) {
        const corrected = midnightAsUtc - offsetAt(start, timezone);
        if (corrected === start) break;
        start = corrected;
    }
    return start;
}

function zonedHourStart(timeMs, timezone) {
    const offset = offsetAt(timeMs, timezone);
    return Math.floor((timeMs + offset) / HOUR_MS) * HOUR_MS - offset;
}

function nextZonedDay(start, timezone) {
    return zonedDayStart(start + 36 * HOUR_MS, timezone);
}

function buildTrend(records, query, nowMs) {
    if (records.length === 0 && query.rangeKey === "all") return { bucketMs: null, granularity: "day", trend: [] };
    const earliest = records.reduce((min, record) => Math.min(min, getRecordTime(record)), nowMs);
    const latest = records.reduce((max, record) => Math.max(max, getRecordTime(record)), nowMs);
    const fromMs = query.fromMs ?? earliest;
    const toMs = query.toMs ?? latest;
    const spanMs = Math.max(0, toMs - fromMs);
    const granularity = query.granularity === "auto" ? (spanMs <= 2 * DAY_MS ? "hour" : "day") : query.granularity;
    const baseMs = granularity === "hour" ? HOUR_MS : DAY_MS;
    const stride = Math.max(1, Math.ceil((spanMs / baseMs + 2) / MAX_TREND_BUCKETS));
    const firstBucketMs =
        granularity === "hour" ? zonedHourStart(fromMs, query.timezone) : zonedDayStart(fromMs, query.timezone);
    const trend = [];
    let bucketStart = firstBucketMs;
    while (bucketStart <= toMs && trend.length < MAX_TREND_BUCKETS) {
        trend.push({ ...createCounts(), start: new Date(bucketStart).toISOString() });
        if (granularity === "hour") bucketStart += stride * HOUR_MS;
        else for (let day = 0; day < stride; day += 1) bucketStart = nextZonedDay(bucketStart, query.timezone);
    }
    const starts = trend.map(bucket => Date.parse(bucket.start));
    for (const record of records) {
        const time = getRecordTime(record);
        let lo = 0;
        let hi = starts.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (starts[mid] <= time) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) addRecord(trend[lo - 1], record, query);
    }
    trend.forEach(finishCounts);
    return { bucketMs: baseMs * stride, granularity, trend };
}

function buildOverview(records, query, activeRequests = 0, latestSequence = 0, nowMs = Date.now()) {
    const summary = { ...createCounts(), avgDurationMs: 0, retriedRequests: 0, successRate: 0 };
    const accountMap = new Map();
    const modelMap = new Map();
    const apiKeyMap = new Map();
    const optionAccounts = new Map();
    const optionModels = new Set();
    const optionApiKeys = new Set();
    const optionCategories = new Set();
    const optionFormats = new Set();
    const matchedRecords = [];
    const recentFailures = [];
    let totalDurationMs = 0;

    for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (!matchesTime(record, query)) continue;
        const finalAccountKey = getAccountKey(record);
        const model = record.model || "unknown";
        const apiKeyId = record.apiKeyId || "unknown";
        const events = getTokenEvents(record);
        optionModels.add(model);
        optionApiKeys.add(apiKeyId);
        optionCategories.add(record.requestCategory || "unknown");
        optionFormats.add(record.apiFormat || "unknown");
        if (!optionAccounts.has(finalAccountKey)) {
            optionAccounts.set(finalAccountKey, {
                accountKey: finalAccountKey,
                finalAccountName: record.finalAccountName || accountNameFromKey(record.accountKey),
                finalAuthIndex: record.finalAuthIndex ?? null,
                identitySource: accountIdentitySource(finalAccountKey),
            });
        }
        for (const event of events) {
            if (event.accountKey === UNATTRIBUTED_ACCOUNT_KEY || optionAccounts.has(event.accountKey)) continue;
            optionAccounts.set(event.accountKey, {
                accountKey: event.accountKey,
                finalAccountName: event.accountName,
                finalAuthIndex: event.authIndex,
                identitySource: accountIdentitySource(event.accountKey),
            });
        }
        if (!matchesFilters(record, query)) continue;

        matchedRecords.push(record);
        addRecord(summary, record, query);
        totalDurationMs += Number.isFinite(record.durationMs) ? record.durationMs : 0;
        if (record.attemptCount > 1) summary.retriedRequests += 1;
        if (record.outcome === "error" && recentFailures.length < 5) {
            recentFailures.push({
                ...record,
                scopedTokenUsage: query.accountKey
                    ? sumTokenUsage(getScopedEvents(record, query).map(event => event.usage))
                    : normalizeTokenUsage(record.tokenUsage),
                sequence: Number.isSafeInteger(record.sequence) && record.sequence > 0 ? record.sequence : index + 1,
            });
        }

        if (!query.accountKey || finalAccountKey === query.accountKey) {
            let finalAccount = accountMap.get(finalAccountKey);
            if (!finalAccount) {
                finalAccount = {
                    ...createCounts(),
                    accountKey: finalAccountKey,
                    avgDurationMs: 0,
                    finalAccountName: record.finalAccountName || accountNameFromKey(record.accountKey),
                    finalAuthIndex: record.finalAuthIndex ?? null,
                    identitySource: accountIdentitySource(finalAccountKey),
                    lastUsedAt: null,
                    successRate: 0,
                    totalDurationMs: 0,
                    unattributed: false,
                };
                accountMap.set(finalAccountKey, finalAccount);
            }
            addRequestCounts(finalAccount, record);
            finalAccount.totalDurationMs += Number.isFinite(record.durationMs) ? record.durationMs : 0;
            if ((record.finishedAt || "") > (finalAccount.lastUsedAt || ""))
                finalAccount.lastUsedAt = record.finishedAt;
        }

        const touched = new Set();
        for (const event of events) {
            if (query.accountKey && event.accountKey !== query.accountKey) continue;
            if (event.accountKey === UNATTRIBUTED_ACCOUNT_KEY && !event.usage) continue;
            let account = accountMap.get(event.accountKey);
            if (!account) {
                account = {
                    ...createCounts(),
                    accountKey: event.accountKey,
                    avgDurationMs: 0,
                    finalAccountName: event.accountName,
                    finalAuthIndex: event.authIndex,
                    identitySource: accountIdentitySource(event.accountKey),
                    lastUsedAt: null,
                    successRate: 0,
                    totalDurationMs: 0,
                    unattributed: event.accountKey === UNATTRIBUTED_ACCOUNT_KEY,
                };
                accountMap.set(event.accountKey, account);
            }
            account.attemptCount += 1;
            addUsage(account, event.usage);
            addCachePair(account, event.usage);
            if (!touched.has(event.accountKey)) {
                account.touchedRequests += 1;
                touched.add(event.accountKey);
            }
            if ((event.finishedAt || "") > (account.lastUsedAt || "")) account.lastUsedAt = event.finishedAt;
        }

        let modelStats = modelMap.get(model);
        if (!modelStats) {
            modelStats = { ...createCounts(), model, successRate: 0 };
            modelMap.set(model, modelStats);
        }
        addRecord(modelStats, record, query);

        let apiKeyStats = apiKeyMap.get(apiKeyId);
        if (!apiKeyStats) {
            apiKeyStats = { ...createCounts(), apiKeyId, successRate: 0 };
            apiKeyMap.set(apiKeyId, apiKeyStats);
        }
        addRecord(apiKeyStats, record, query);
    }

    summary.avgDurationMs = summary.totalRequests ? Math.round(totalDurationMs / summary.totalRequests) : 0;
    summary.successRate = rate(summary.successCount, summary.totalRequests);
    summary.activeRequests = activeRequests;
    finishCounts(summary);
    const accounts = Array.from(accountMap.values())
        .map(account => {
            account.avgDurationMs = account.totalRequests
                ? Math.round(account.totalDurationMs / account.totalRequests)
                : 0;
            account.successRate = rate(account.successCount, account.totalRequests);
            return finishCounts(account);
        })
        .sort(
            (a, b) =>
                b.totalRequests - a.totalRequests ||
                b.attemptCount - a.attemptCount ||
                a.accountKey.localeCompare(b.accountKey)
        );
    const models = Array.from(modelMap.values())
        .map(model => finishCounts({ ...model, successRate: rate(model.successCount, model.totalRequests) }))
        .sort((a, b) => b.totalRequests - a.totalRequests || a.model.localeCompare(b.model));
    const apiKeys = Array.from(apiKeyMap.values())
        .map(apiKey => finishCounts({ ...apiKey, successRate: rate(apiKey.successCount, apiKey.totalRequests) }))
        .sort((a, b) => b.totalRequests - a.totalRequests || a.apiKeyId.localeCompare(b.apiKeyId));
    const { bucketMs, granularity, trend } = buildTrend(matchedRecords, query, nowMs);

    return {
        accounts,
        apiKeys,
        asOf: new Date(nowMs).toISOString(),
        filterOptions: {
            accounts: Array.from(optionAccounts.values()).sort((a, b) => a.accountKey.localeCompare(b.accountKey)),
            apiFormats: Array.from(optionFormats).sort(),
            apiKeys: Array.from(optionApiKeys)
                .sort()
                .map(apiKeyId => ({ apiKeyId })),
            models: Array.from(optionModels).sort(),
            requestCategories: Array.from(optionCategories).sort(),
        },
        latestSequence,
        models,
        range: {
            bucketMs,
            from: query.fromMs === null ? null : new Date(query.fromMs).toISOString(),
            granularity,
            key: query.rangeKey,
            timezone: query.timezone,
            to: query.toMs === null ? null : new Date(query.toMs).toISOString(),
            tokenUsageScope: query.accountKey ? "matching-attempts" : "request",
        },
        recentFailures,
        summary,
        trend,
    };
}

function listRequests(records, query) {
    const items = [];
    let hasMore = false;
    let totalMatched = 0;
    for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (!matchesTime(record, query) || !matchesFilters(record, query)) continue;
        totalMatched += 1;
        const sequence = Number.isSafeInteger(record.sequence) && record.sequence > 0 ? record.sequence : index + 1;
        if (query.cursor !== null && sequence >= query.cursor) continue;
        if (items.length < query.limit) {
            items.push({
                ...record,
                scopedTokenUsage: query.accountKey
                    ? sumTokenUsage(getScopedEvents(record, query).map(event => event.usage))
                    : normalizeTokenUsage(record.tokenUsage),
                sequence,
            });
        } else hasMore = true;
    }
    return {
        hasMore,
        items,
        nextCursor: hasMore ? items[items.length - 1].sequence : null,
        tokenUsageScope: query.accountKey ? "matching-attempts" : "request",
        totalMatched,
    };
}

module.exports = { buildOverview, listRequests, parseUsageQuery, UsageQueryError };
