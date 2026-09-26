<template>
    <section class="logs-view" aria-labelledby="logs-heading">
        <header class="logs-heading">
            <div>
                <p class="logs-eyebrow">{{ t("log") }}</p>
                <h1 id="logs-heading">{{ t("realtimeLogs") }}</h1>
                <p class="logs-subtitle">{{ t("logsSubtitle") }}</p>
            </div>
            <span class="logs-loaded">{{ t("logsLoadedCount", { count: loadedEntries.length }) }}</span>
        </header>

        <div class="logs-toolbar">
            <div class="logs-filter-primary">
                <input
                    v-model.trim="search"
                    class="logs-input logs-search"
                    type="search"
                    maxlength="200"
                    :aria-label="t('logsSearchPlaceholder')"
                    :placeholder="t('logsSearchPlaceholder')"
                />
                <label class="logs-field logs-level">
                    <span>{{ t("logLevel") }}</span>
                    <select v-model="level" class="logs-input">
                        <option value="all">{{ t("logsLevelAll") }}</option>
                        <option value="ERROR">ERROR</option>
                        <option value="WARN">WARN</option>
                        <option value="INFO">INFO</option>
                        <option value="DEBUG">DEBUG</option>
                    </select>
                </label>
            </div>
            <div class="logs-filter-secondary">
                <label class="logs-field">
                    <span>{{ t("logsStartTime") }}</span>
                    <input v-model="fromTime" class="logs-input" type="datetime-local" />
                </label>
                <label class="logs-field">
                    <span>{{ t("logsEndTime") }}</span>
                    <input v-model="toTime" class="logs-input" type="datetime-local" :min="fromTime || undefined" />
                </label>
            </div>
            <p class="logs-note">{{ t("logsTimeNote") }} {{ t("logsBoundedNote") }}</p>
        </div>

        <div class="logs-actions">
            <span class="logs-result-count">{{ t("logsVisibleCount", { count: visibleEntries.length }) }}</span>
            <span v-if="paused && newCount" class="logs-new-count" role="status">
                {{ t("logsNewEntries", { count: newCount }) }}
            </span>
            <div class="logs-action-buttons">
                <button type="button" class="logs-button" :aria-pressed="paused" @click="togglePause">
                    {{ paused ? t("logsResume") : t("logsPause") }}
                </button>
                <label class="logs-autoscroll">
                    <input v-model="autoScroll" type="checkbox" />
                    <span>{{ t("logsAutoScroll") }}</span>
                </label>
                <button
                    type="button"
                    class="logs-button"
                    :disabled="!visibleEntries.length"
                    @click="downloadLogs(true)"
                >
                    {{ t("logsDownloadFiltered") }}
                </button>
                <button
                    type="button"
                    class="logs-button"
                    :disabled="!loadedEntries.length"
                    @click="downloadLogs(false)"
                >
                    {{ t("logsDownloadLoaded") }}
                </button>
            </div>
        </div>

        <div ref="feed" class="logs-feed" role="log" aria-live="off" aria-relevant="additions text">
            <p v-if="!loadedEntries.length" class="logs-empty">{{ t("logsEmpty") }}</p>
            <p v-else-if="!visibleEntries.length" class="logs-empty">{{ t("logsNoMatches") }}</p>
            <article
                v-for="entry in visibleEntries"
                v-else
                :key="entry.index"
                class="logs-entry"
                :class="entry.level ? `logs-entry-${entry.level.toLowerCase()}` : ''"
            >
                <div class="logs-entry-meta">
                    <time v-if="entry.timestamp" class="logs-time">{{ entry.timestamp }}</time>
                    <span v-if="entry.level" class="logs-badge">{{ entry.level }}</span>
                    <span v-if="entry.source" class="logs-source">{{ entry.source }}</span>
                </div>
                <div class="logs-entry-main">
                    <div class="logs-message">
                        <template v-if="entry.message.length > 240 && !expanded.has(entry.index) && !search">
                            <span>{{ entry.message.slice(0, 240) }}…</span>
                        </template>
                        <template v-else>
                            <template v-for="(segment, segmentIndex) in highlighted(entry.message)" :key="segmentIndex">
                                <mark v-if="segment.match">{{ segment.text }}</mark>
                                <span v-else>{{ segment.text }}</span>
                            </template>
                        </template>
                    </div>
                    <div class="logs-row-actions">
                        <button
                            v-if="entry.message.length > 240 && !search"
                            type="button"
                            class="logs-text-button"
                            :aria-expanded="expanded.has(entry.index)"
                            @click="toggleExpanded(entry.index)"
                        >
                            {{ expanded.has(entry.index) ? t("logsCollapse") : t("logsExpand") }}
                        </button>
                        <button
                            type="button"
                            class="logs-text-button"
                            :aria-label="t('logsCopyLine')"
                            @click="copyEntry(entry)"
                        >
                            {{ t("copy") }}
                        </button>
                    </div>
                </div>
            </article>
        </div>
        <p class="logs-feedback" role="status" aria-live="polite">{{ feedback }}</p>
    </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";

import I18n from "../utils/i18n";

const props = defineProps({
    languageVersion: { default: 0, type: Number },
    logCount: { default: 0, type: Number },
    logs: { default: "", type: String },
});
const t = (key, options) => {
    props.languageVersion;
    return I18n.t(key, options);
};

const search = ref("");
const level = ref("all");
const fromTime = ref("");
const toTime = ref("");
const paused = ref(false);
const autoScroll = ref(true);
const newCount = ref(0);
const displayedRaw = ref(props.logCount > 0 ? props.logs : "");
const lastObservedRaw = ref(displayedRaw.value);
const expanded = ref(new Set());
const feedback = ref("");
const feed = ref(null);

// The status endpoint still provides a bounded, joined text buffer. Parse only
// its known prefix and keep continuation lines with their preceding entry.
const logPrefix = /^\[(DEBUG|INFO|WARN|ERROR)\]\s+(.+?)\s+\[([^\]]+)\]\s+-\s?(.*)$/;
const timePrefix = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

const redact = value =>
    value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+={0,2}/gi, "Bearer [REDACTED]")
        .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
        .replace(/(\b(?:Set-Cookie|Cookie)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
        .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
        .replace(/(["']?apiKeys["']?\s*[:=]\s*)\[[^\]]*\]/gi, "$1[REDACTED]")
        .replace(
            /(["']?(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|session[_-]?secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
            "$1[REDACTED]"
        );

const parseEntries = raw => {
    if (!raw) return [];
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
        const parts = logPrefix.exec(line);
        if (parts) {
            entries.push({ level: parts[1], message: parts[4], source: parts[3], timestamp: parts[2] });
        } else if (entries.length) {
            entries[entries.length - 1].message += `\n${line}`;
        } else if (line.trim()) {
            entries.push({ level: "", message: line, source: "", timestamp: "" });
        }
    }
    return entries.map((entry, index) => {
        const safe = {
            index,
            level: entry.level,
            message: redact(entry.message),
            source: redact(entry.source),
            timestamp: redact(entry.timestamp),
        };
        safe.text = [safe.level && `[${safe.level}]`, safe.timestamp, safe.source && `[${safe.source}] -`, safe.message]
            .filter(Boolean)
            .join(" ");
        safe.timeKey = timePrefix.test(safe.timestamp) ? safe.timestamp.slice(0, 16).replace(" ", "T") : "";
        return safe;
    });
};

const countAddedEntries = (before, after) => {
    if (!before.length) return after.length;
    for (let overlap = Math.min(before.length, after.length); overlap > 0; overlap--) {
        if (before.slice(-overlap).every((entry, index) => entry.text === after[index].text)) {
            return after.length - overlap;
        }
    }
    return after.length;
};

const loadedEntries = computed(() => parseEntries(displayedRaw.value));
const visibleEntries = computed(() => {
    const needle = search.value.toLocaleLowerCase();
    return loadedEntries.value.filter(entry => {
        if (level.value !== "all" && entry.level !== level.value) return false;
        if (fromTime.value && (!entry.timeKey || entry.timeKey < fromTime.value)) return false;
        if (toTime.value && (!entry.timeKey || entry.timeKey > toTime.value)) return false;
        return !needle || entry.text.toLocaleLowerCase().includes(needle);
    });
});

const highlighted = value => {
    const needle = search.value.toLocaleLowerCase();
    if (!needle) return [{ match: false, text: value }];
    const lowered = value.toLocaleLowerCase();
    const segments = [];
    let start = 0;
    let found = lowered.indexOf(needle, start);
    while (found !== -1) {
        if (found > start) segments.push({ match: false, text: value.slice(start, found) });
        segments.push({ match: true, text: value.slice(found, found + needle.length) });
        start = found + needle.length;
        found = lowered.indexOf(needle, start);
    }
    if (start < value.length) segments.push({ match: false, text: value.slice(start) });
    return segments;
};

const scrollToBottom = () => {
    if (feed.value) feed.value.scrollTop = feed.value.scrollHeight;
};
watch(
    () => [props.logs, props.logCount],
    ([logs, count]) => {
        const raw = count > 0 ? logs : "";
        if (paused.value) {
            newCount.value += countAddedEntries(parseEntries(lastObservedRaw.value), parseEntries(raw));
        } else {
            displayedRaw.value = raw;
            expanded.value = new Set();
            if (autoScroll.value) nextTick(scrollToBottom);
        }
        lastObservedRaw.value = raw;
    }
);
watch([search, level, fromTime, toTime], () => {
    if (autoScroll.value && !paused.value) nextTick(scrollToBottom);
});

const togglePause = () => {
    paused.value = !paused.value;
    if (!paused.value) {
        displayedRaw.value = props.logCount > 0 ? props.logs : "";
        lastObservedRaw.value = displayedRaw.value;
        newCount.value = 0;
        expanded.value = new Set();
        if (autoScroll.value) nextTick(scrollToBottom);
    }
};
const toggleExpanded = index => {
    const next = new Set(expanded.value);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    expanded.value = next;
};
const copyEntry = async entry => {
    try {
        await navigator.clipboard.writeText(entry.text);
        feedback.value = t("logsCopied");
    } catch {
        feedback.value = t("logsCopyFailed");
    }
};
const downloadLogs = filtered => {
    const entries = filtered ? visibleEntries.value : loadedEntries.value;
    if (!entries.length) return;
    const blob = new Blob([entries.map(entry => entry.text).join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `AIStudioToAPI_${filtered ? "filtered" : "loaded"}_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
};

defineExpose({ scrollToBottom });
</script>

<style scoped>
.logs-view {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 16px;
    color: var(--text-primary);
}

.logs-heading,
.logs-actions,
.logs-filter-primary,
.logs-filter-secondary,
.logs-action-buttons {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.logs-heading,
.logs-actions {
    justify-content: space-between;
}

.logs-heading h1 {
    margin: 2px 0 4px;
    font-size: clamp(1.5rem, 2.5vw, 2rem);
}

.logs-eyebrow {
    margin: 0;
    color: var(--color-primary);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.logs-subtitle,
.logs-note,
.logs-loaded,
.logs-result-count,
.logs-source,
.logs-feedback {
    color: var(--text-secondary);
}

.logs-subtitle,
.logs-note,
.logs-feedback {
    margin: 0;
}

.logs-toolbar,
.logs-actions,
.logs-feed {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: 14px;
}

.logs-toolbar {
    display: grid;
    gap: 12px;
    padding: 16px;
}

.logs-filter-primary > *,
.logs-filter-secondary > * {
    flex: 1 1 180px;
    min-width: 0;
}

.logs-filter-primary .logs-search {
    flex: 3 1 280px;
}

.logs-field {
    display: grid;
    gap: 5px;
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-weight: 600;
}

.logs-input {
    width: 100%;
    min-height: 38px;
    box-sizing: border-box;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 7px 10px;
    background: var(--bg-card);
    color: var(--text-primary);
    font: inherit;
}

.logs-input:focus-visible,
.logs-button:focus-visible,
.logs-text-button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
}

.logs-note {
    font-size: 0.77rem;
    line-height: 1.5;
}

.logs-actions {
    padding: 10px 14px;
}

.logs-action-buttons {
    justify-content: flex-end;
}

.logs-new-count {
    color: var(--color-primary);
    font-size: 0.82rem;
    font-weight: 700;
}

.logs-autoscroll {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-secondary);
    font-size: 0.82rem;
    white-space: nowrap;
}

.logs-button {
    min-height: 34px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 5px 10px;
    background: var(--bg-card);
    color: var(--text-primary);
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
}

.logs-button:hover:not(:disabled),
.logs-text-button:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
}

.logs-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.logs-feed {
    height: clamp(320px, 54vh, 680px);
    overflow: auto;
    overscroll-behavior: contain;
    padding: 4px 0;
}

.logs-entry {
    border-bottom: 1px solid var(--border-light);
    padding: 12px 16px;
    border-left: 3px solid transparent;
}

.logs-entry:last-child {
    border-bottom: 0;
}

.logs-entry:hover {
    background: var(--bg-list-item-hover);
}

.logs-entry-error {
    border-left-color: var(--color-error);
}

.logs-entry-warn {
    border-left-color: var(--color-warning);
}

.logs-entry-info {
    border-left-color: var(--color-primary);
}

.logs-entry-meta,
.logs-entry-main,
.logs-row-actions {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}

.logs-entry-meta {
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 7px;
    font-size: 0.76rem;
}

.logs-time {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
}

.logs-badge {
    border: 1px solid currentColor;
    border-radius: 5px;
    padding: 1px 5px;
    color: var(--text-secondary);
    font-size: 0.69rem;
    font-weight: 700;
    letter-spacing: 0.04em;
}

.logs-entry-error .logs-badge {
    color: var(--color-error);
}

.logs-entry-warn .logs-badge {
    color: var(--color-warning);
}

.logs-entry-info .logs-badge {
    color: var(--color-primary);
}

.logs-entry-main {
    justify-content: space-between;
}

.logs-message {
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.83rem;
    line-height: 1.55;
}

.logs-message mark {
    background: var(--color-warning);
    color: #111;
    border-radius: 2px;
}

.logs-row-actions {
    flex: 0 0 auto;
    align-items: center;
}

.logs-text-button {
    border: 0;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.77rem;
    white-space: nowrap;
}

.logs-empty {
    margin: 0;
    padding: 64px 20px;
    color: var(--text-secondary);
    text-align: center;
}

.logs-feedback {
    min-height: 1em;
    font-size: 0.76rem;
}

@media (max-width: 640px) {
    .logs-view {
        gap: 12px;
    }

    .logs-toolbar {
        padding: 12px;
    }

    .logs-filter-primary,
    .logs-filter-secondary {
        gap: 10px;
    }

    .logs-filter-primary > *,
    .logs-filter-secondary > * {
        flex-basis: 100%;
    }

    .logs-actions {
        align-items: flex-start;
    }

    .logs-action-buttons {
        justify-content: flex-start;
        width: 100%;
    }

    .logs-feed {
        height: clamp(280px, 48vh, 520px);
    }

    .logs-entry {
        padding: 10px 12px;
    }

    .logs-entry-main {
        flex-direction: column;
        gap: 6px;
    }

    .logs-row-actions {
        align-self: flex-end;
    }
}
</style>
