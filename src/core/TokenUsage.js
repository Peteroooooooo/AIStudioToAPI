const TOKEN_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "thoughtTokens", "cachedInputTokens"];
const UPSTREAM_COUNT_FIELDS = [
    "promptTokenCount",
    "toolUsePromptTokenCount",
    "candidatesTokenCount",
    "thoughtsTokenCount",
    "totalTokenCount",
    "cachedContentTokenCount",
];
const MAX_SSE_LINE = 256 * 1024;

function tokenCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeTokenUsage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const normalized = Object.fromEntries(TOKEN_FIELDS.map(field => [field, tokenCount(value[field])]));
    return TOKEN_FIELDS.some(field => normalized[field] !== null) ? normalized : null;
}

function fromUsageMetadata(metadata) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const prompt = tokenCount(metadata.promptTokenCount);
    const toolPrompt = tokenCount(metadata.toolUsePromptTokenCount);
    const candidates = tokenCount(metadata.candidatesTokenCount);
    const thoughts = tokenCount(metadata.thoughtsTokenCount);
    const inputTokens = prompt === null ? null : prompt + (toolPrompt ?? 0);
    const outputTokens = candidates === null && thoughts === null ? null : (candidates ?? 0) + (thoughts ?? 0);
    const reportedTotal = tokenCount(metadata.totalTokenCount);
    const totalTokens =
        reportedTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
    return normalizeTokenUsage({
        cachedInputTokens: metadata.cachedContentTokenCount,
        inputTokens,
        outputTokens,
        thoughtTokens: thoughts,
        totalTokens,
    });
}

function snapshotUsageMetadata(metadata) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const snapshot = {};
    for (const field of UPSTREAM_COUNT_FIELDS) {
        const count = tokenCount(metadata[field]);
        if (count !== null) snapshot[field] = count;
    }
    return Object.keys(snapshot).length ? snapshot : null;
}

function sumTokenUsage(usages) {
    const totals = Object.fromEntries(TOKEN_FIELDS.map(field => [field, null]));
    for (const usage of usages) {
        if (!usage) continue;
        for (const field of TOKEN_FIELDS) {
            const value = tokenCount(usage[field]);
            if (value !== null) totals[field] = (totals[field] ?? 0) + value;
        }
    }
    return normalizeTokenUsage(totals);
}

class TokenUsageCapture {
    constructor() {
        this.usage = null;
        this.rawUsageMetadata = null;
        this.lineBuffer = "";
        this.dataLines = [];
        this.skipLine = false;
    }

    _readJson(text) {
        try {
            const response = JSON.parse(text);
            const responses = Array.isArray(response) ? response : [response];
            for (const item of responses) {
                const usage = fromUsageMetadata(item?.usageMetadata);
                if (usage) {
                    this.usage = usage;
                    this.rawUsageMetadata = snapshotUsageMetadata(item.usageMetadata);
                }
            }
            return true;
        } catch {
            return false;
        }
    }

    _flushEvent() {
        if (this.dataLines.length) this._readJson(this.dataLines.join("\n"));
        this.dataLines = [];
    }

    _readLine(line) {
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line) {
            this._flushEvent();
        } else if (line.startsWith("data:") && line.length <= MAX_SSE_LINE) {
            this.dataLines.push(line.slice(5).trimStart());
        }
    }

    ingest(chunk) {
        if (typeof chunk !== "string" || !chunk) return;
        const trimmed = chunk.trimStart();
        if (!this.lineBuffer && !this.dataLines.length && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
            if (!trimmed.includes('"usageMetadata"')) return;
            if (this._readJson(trimmed)) return;
        }
        if (this.skipLine) {
            const newline = chunk.indexOf("\n");
            if (newline < 0) return;
            chunk = chunk.slice(newline + 1);
            this.skipLine = false;
        }
        this.lineBuffer += chunk;
        let newline;
        while ((newline = this.lineBuffer.indexOf("\n")) >= 0) {
            const line = this.lineBuffer.slice(0, newline);
            this.lineBuffer = this.lineBuffer.slice(newline + 1);
            this._readLine(line);
        }
        if (this.lineBuffer.length > MAX_SSE_LINE) {
            this.lineBuffer = "";
            this.dataLines = [];
            this.skipLine = true;
        }
    }

    finish() {
        if (this.lineBuffer) this._readLine(this.lineBuffer);
        this._flushEvent();
        this.lineBuffer = "";
        return this.usage;
    }
}

module.exports = {
    fromUsageMetadata,
    normalizeTokenUsage,
    snapshotUsageMetadata,
    sumTokenUsage,
    TOKEN_FIELDS,
    TokenUsageCapture,
};
