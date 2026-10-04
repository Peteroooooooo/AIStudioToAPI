<template>
    <div class="mm-summary">
        <button
            v-for="card in cards"
            :key="card.key"
            class="mm-card mm-stat"
            :class="`mm-stat-${card.key}`"
            :title="card.hint"
            @click="$emit('select', card.key)"
        >
            <span class="mm-stat-label"
                ><span class="mm-stat-icon">{{ card.icon }}</span
                >{{ card.label }}</span
            >
            <span class="mm-stat-value">
                <strong :title="number(card.exact)">{{ card.value }}</strong>
                <span v-if="card.key === 'cached'" class="mm-stat-rate">
                    {{ m("hitRate") }} <b>{{ percent(summary?.cacheReadRate) }}</b>
                </span>
            </span>
            <small v-if="card.note">{{ card.note }}</small>
        </button>
    </div>
    <div class="mm-scope-note">
        <span>{{ m(scope === "attempts" ? "attemptScopeHint" : "requestScopeHint") }}</span
        ><span
            >{{ m("cancelCount") }} {{ number(summary?.abortedCount) }} · {{ m("unknownCount") }}
            {{ number(summary?.unknownCount) }}</span
        >
    </div>
</template>
<script setup>
import { computed, inject } from "vue";
import { compact, number, percent } from "./format";
const props = defineProps({ scope: { default: "requests", type: String }, summary: { default: null, type: Object } });
defineEmits(["select"]);
const { m } = inject("monitor");
const cards = computed(() => {
    const s = props.summary || {};
    const tokenHint = field =>
        `${m(s.tokenUsageCoverage?.[field] === s.totalRequests ? "reported" : "partial")} ${number(s.tokenUsageCoverage?.[field])}/${number(s.totalRequests)}`;
    return [
        {
            exact: s.completedCount,
            icon: "↗",
            key: "completed",
            label: `${m("completed")}${m(props.scope === "attempts" ? "attempts" : "requests")}`,
            note: `${m("success")} ${number(s.successCount)} · ${m("error")} ${number(s.errorCount)}`,
            value: compact(s.completedCount),
        },
        {
            exact: s.successRate,
            hint: m("denominator"),
            icon: "✓",
            key: "success",
            label: m("successRate"),
            value: percent(s.successRate),
        },
        {
            exact: s.errorCount,
            icon: "×",
            key: "error",
            label: m("failures"),
            note: `${m("active")} ${number(s.inProgressCount)} · ${m("queued")} ${number(s.queuedCount)}`,
            value: compact(s.errorCount),
        },
        {
            exact: s.tokenUsage?.inputTokens,
            hint: tokenHint("inputTokens"),
            icon: "↓",
            key: "input",
            label: m("input"),
            value: compact(s.tokenUsage?.inputTokens),
        },
        {
            exact: s.tokenUsage?.outputTokens,
            hint: `${tokenHint("outputTokens")} · ${m("thoughtsIncluded")}`,
            icon: "↑",
            key: "output",
            label: m("output"),
            value: compact(s.tokenUsage?.outputTokens),
        },
        {
            exact: s.tokenUsage?.cachedInputTokens,
            hint: s.cacheAnomalyCount ? `${m("anomalies")} ${number(s.cacheAnomalyCount)}` : m("cacheRateHint"),
            icon: "◈",
            key: "cached",
            label: m("cache"),
            value: compact(s.tokenUsage?.cachedInputTokens),
        },
    ];
});
</script>
