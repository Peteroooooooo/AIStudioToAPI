<template>
    <el-drawer
        :model-value="open"
        :title="m(isCall ? 'currentCall' : 'requestDetail')"
        size="min(100vw, 560px)"
        class="mm-drawer"
        @update:model-value="$emit('update:open', $event)"
    >
        <div v-if="record" class="mm-monitor mm-detail">
            <div class="mm-detail-head">
                <RequestOutcomeBadge :outcome="record.outcome" /><strong>{{ record.model || "—" }}</strong
                ><span v-if="record.requestCategory === 'account_test'" class="mm-test-tag">{{ m("testTag") }}</span>
            </div>
            <ConversationTag v-if="record.conversationId" :record="record" @select="$emit('conversation', $event)" />
            <dl class="mm-facts">
                <div v-for="fact in facts" :key="fact[0]">
                    <dt>{{ m(fact[0]) }}</dt>
                    <dd>{{ fact[1] }}</dd>
                </div>
            </dl>
            <section class="mm-detail-section">
                <h3>{{ m("usage") }}</h3>
                <dl class="mm-token-facts">
                    <div v-for="field in fields" :key="field[0]">
                        <dt>{{ m(field[1]) }}</dt>
                        <dd>{{ number(record.tokenUsage?.[field[0]]) }}</dd>
                    </div>
                    <div>
                        <dt>{{ m("nonCached") }}</dt>
                        <dd data-testid="noncached">{{ number(nonCached(record.tokenUsage)) }}</dd>
                    </div>
                </dl>
                <p class="mm-muted">{{ m("cacheIncluded") }} · {{ m("thoughtsIncluded") }}</p>
                <p v-if="cacheAnomaly(record.tokenUsage)" class="mm-danger">{{ m("countAnomaly") }}</p>
                <small>{{ m(record.usageState || "unreported") }}</small>
            </section>
            <section
                v-if="record.errorMessage || ['error', 'aborted'].includes(record.outcome)"
                class="mm-detail-section"
            >
                <h3>{{ m("errorDetail") }}</h3>
                <p>{{ status(record, m) }}</p>
                <p v-if="record.terminationReason">
                    {{ m("termination") }}: <code>{{ record.terminationReason }}</code>
                </p>
                <pre v-if="record.errorMessage" class="mm-error-block">{{ record.errorMessage }}</pre>
            </section>
            <section v-if="isCall" class="mm-detail-section">
                <details @toggle="onChainToggle">
                    <summary>{{ m("chain") }} · {{ record.parentAttemptCount ?? "—" }} {{ m("calls") }}</summary>
                    <p v-if="parentLoading">{{ m("loading") }}</p>
                    <p v-else-if="parentError" class="mm-danger">
                        {{ parentError }} <button class="mm-link" @click="$emit('parent')">{{ m("retry") }}</button>
                    </p>
                    <template v-else-if="parent"
                        ><div class="mm-parent-summary">
                            <RequestOutcomeBadge :outcome="parent.outcome" /><span
                                >{{ m("requestStatus") }} {{ parent.statusCode ?? "—" }} ·
                                {{ duration(parent.durationMs) }}</span
                            >
                        </div>
                        <AttemptTimeline :items="parent.attempts || []"
                    /></template>
                </details>
            </section>
            <section v-else-if="!record.active" class="mm-detail-section">
                <h3>{{ m("chain") }}</h3>
                <AttemptTimeline :items="record.attempts || []" />
            </section>
            <details v-if="record.rawUsageMetadata" class="mm-detail-section">
                <summary>{{ m("raw") }}</summary>
                <pre>{{ JSON.stringify(record.rawUsageMetadata, null, 2) }}</pre>
            </details>
            <section class="mm-detail-section">
                <button class="mm-link" @click="$emit('logs', record.requestId)">{{ m("requestLog") }} ↗</button>
            </section>
        </div>
    </el-drawer>
</template>
<script setup>
import { computed, inject } from "vue";
import { cacheAnomaly, duration, keyLabel, nonCached, number, status, time } from "./format";
import AttemptTimeline from "./AttemptTimeline.vue";
import ConversationTag from "./ConversationTag.vue";
import RequestOutcomeBadge from "./RequestOutcomeBadge.vue";
const props = defineProps({
    open: Boolean,
    parent: { default: null, type: Object },
    parentError: { default: "", type: String },
    parentLoading: Boolean,
    record: { default: null, type: Object },
});
const emit = defineEmits(["update:open", "parent", "logs", "conversation"]);
const { account, m } = inject("monitor");
const isCall = computed(() => props.record?.metricScope === "attempts" || Number.isInteger(props.record?.attemptIndex));
const onChainToggle = event => {
    if (event.target.open && !props.parent && !props.parentLoading) emit("parent");
};
const fields = [
    ["inputTokens", "input"],
    ["cachedInputTokens", "cached"],
    ["outputTokens", "output"],
    ["thoughtTokens", "thought"],
    ["totalTokens", "total"],
];
const facts = computed(() => {
    const r = props.record || {};
    const rows = [
        ["account", r.attemptCount === 0 ? m("unassigned") : account(r)],
        ["status", status(r, m)],
        ["protocol", r.apiFormat || "—"],
        ["path", `${r.method || ""} ${r.path || "—"}`],
        ["apiKeys", !r.apiKeyId || r.apiKeyId === "unknown" ? m("apiKeyUnknown") : keyLabel(r.apiKeyId)],
        ["ip", r.clientIp || "—"],
        ["started", time(r.startedAt)],
        ["finished", time(r.finishedAt)],
        ["duration", duration(r.durationMs)],
        ["ttft", duration(r.firstTextLatencyMs)],
        ["tps", Number.isFinite(r.generationTps) ? r.generationTps.toFixed(1) : "—"],
    ];
    if (!r.conversationId) rows.splice(1, 0, ["conversation", m("unknown")]);
    if (r.conversationMatch) rows.push(["conversationAssociation", m(r.conversationMatch)]);
    if (r.conversationConfigChanged) rows.push(["note", m("conversationConfigChanged")]);
    if (r.cacheDecision) {
        rows.push(["localCache", m(`cache_${r.cacheDecision.state}`)]);
        if (r.cacheDecision.expiresAt) rows.push(["cacheExpiresAt", time(r.cacheDecision.expiresAt)]);
        if (r.cacheDecision.upstreamExpiresAt && r.cacheDecision.upstreamExpiresAt !== r.cacheDecision.expiresAt)
            rows.push(["cacheUpstreamExpiresAt", time(r.cacheDecision.upstreamExpiresAt)]);
    }
    if (isCall.value)
        rows.push(
            ["upstream", number(r.upstreamStatusCode)],
            ["local", number(r.localStatusCode)],
            ["callOrder", `${(r.attemptIndex ?? 0) + 1}/${r.parentAttemptCount ?? "—"}`]
        );
    else rows.push(["calls", number(r.attemptCount)]);
    if (r.historicalIncomplete) rows.push(["note", m("historyIncomplete")]);
    if (r.activityEndedUnknown) rows.push(["note", m("activityEndedUnknown")]);
    return rows;
});
</script>
