<template>
    <div class="mm-list-tools">
        <div class="mm-segment">
            <button :class="{ active: !activity }" @click="$emit('activity', '')">{{ m("history") }}</button
            ><button :class="{ active: activity }" @click="$emit('activity', 'active')">
                {{ m("activity") }} <span>{{ activeCount }}</span>
            </button>
        </div>
        <div>
            <select v-model="density" :aria-label="m('density')">
                <option value="standard">{{ m("standard") }}</option>
                <option value="compact">{{ m("compact") }}</option>
            </select>
            <details class="mm-column-menu">
                <summary>{{ m("columns") }}</summary>
                <div>
                    <label v-for="column in optionalColumns" :key="column"
                        ><input type="checkbox" :checked="columns.includes(column)" @change="toggleColumn(column)" />{{
                            m(column)
                        }}</label
                    >
                </div>
            </details>
        </div>
    </div>
    <div v-if="error" class="mm-notice mm-danger" role="alert">
        {{ error }} <button class="mm-link" @click="$emit('retry')">{{ m("retry") }}</button>
    </div>
    <div v-if="loading && !items.length" class="mm-empty" role="status">{{ m("loading") }}</div>
    <div v-else-if="!items.length" class="mm-empty">{{ m("empty") }}</div>
    <template v-else>
        <div class="mm-table-scroll">
            <table class="mm-table mm-requests" :class="`density-${density}`">
                <thead>
                    <tr>
                        <th>{{ m("time") }}</th>
                        <th>{{ m("account") }} / {{ m("model") }}</th>
                        <th>{{ m("outcome") }}</th>
                        <th>{{ m("status") }}</th>
                        <th>{{ m("duration") }}</th>
                        <th>{{ m("usage") }}</th>
                        <th v-for="column in columns" :key="column">{{ m(column) }}</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="record in items"
                        :key="record.requestAttemptId || record.requestId"
                        @dblclick="$emit('open', record)"
                    >
                        <td>
                            <span :title="time(record.startedAt)">{{ time(record.startedAt, true) }}</span>
                        </td>
                        <td class="mm-identity">
                            <strong :title="accountLabel(record)">{{ accountLabel(record) }}</strong
                            ><small class="mm-mono"
                                >{{ record.model || "—" }}
                                <span v-if="record.requestCategory === 'account_test'" class="mm-test-tag">{{
                                    m("testTag")
                                }}</span></small
                            >
                            <ConversationTag :record="record" @select="$emit('conversation', $event)" />
                        </td>
                        <td><RequestOutcomeBadge :outcome="record.outcome" /></td>
                        <td class="mm-status-cell">
                            <span>{{ status(record, m) }}</span
                            ><small v-if="record.errorMessage" class="mm-error-summary" :title="record.errorMessage">{{
                                shortError(record.errorMessage)
                            }}</small>
                        </td>
                        <td class="mm-numeric">{{ duration(record.durationMs) }}</td>
                        <td><TokenUsageDisplay :usage="record.tokenUsage" /></td>
                        <td v-for="column in columns" :key="column" :title="columnValue(record, column)">
                            {{ columnValue(record, column) }}
                        </td>
                        <td>
                            <button class="mm-link" @click="$emit('open', record)">{{ m("details") }}</button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <div class="mm-mobile-records">
            <button
                v-for="record in items"
                :key="record.requestAttemptId || record.requestId"
                class="mm-mobile-record"
                @click="$emit('open', record)"
            >
                <div>
                    <strong>{{ accountLabel(record) }}</strong
                    ><RequestOutcomeBadge :outcome="record.outcome" />
                </div>
                <code>{{ record.model || "—" }}</code>
                <ConversationTag :record="record" :interactive="false" />
                <div>
                    <small
                        >{{ time(record.startedAt, true) }} · {{ status(record, m) }} ·
                        {{ duration(record.durationMs) }}</small
                    ><TokenUsageDisplay :usage="record.tokenUsage" />
                </div>
                <small v-if="record.errorMessage" class="mm-danger">{{ shortError(record.errorMessage) }}</small>
            </button>
        </div>
    </template>
    <footer class="mm-pagination">
        <span
            >{{ number(total) }} {{ m("records") }} · {{ m("page") }} {{ page + 1 }}
            <small v-if="activity">· {{ m("activeHint") }}</small></span
        >
        <div>
            <button class="mm-button" :disabled="page === 0 || loading" @click="$emit('previous')">
                {{ m("previous") }}</button
            ><button class="mm-button" :disabled="!hasMore || loading" @click="$emit('next')">{{ m("next") }}</button>
        </div>
    </footer>
</template>
<script setup>
import { inject, ref, watch } from "vue";
import { duration, keyLabel, number, shortError, status, time } from "./format";
import ConversationTag from "./ConversationTag.vue";
import RequestOutcomeBadge from "./RequestOutcomeBadge.vue";
import TokenUsageDisplay from "./TokenUsageDisplay.vue";
defineProps({
    activeCount: { default: 0, type: Number },
    activity: { default: "", type: String },
    error: { default: "", type: String },
    hasMore: Boolean,
    items: { default: () => [], type: Array },
    loading: Boolean,
    page: { default: 0, type: Number },
    total: { default: 0, type: Number },
});
defineEmits(["open", "next", "previous", "retry", "activity", "conversation"]);
const { account, m } = inject("monitor");
let preferences;
try {
    preferences = JSON.parse(localStorage.getItem("monitor-table") || "{}");
} catch {
    preferences = {};
}
const optionalColumns = ["protocol", "apiKeys", "ip", "path", "thought", "total", "cacheState", "ttft", "tps"];
const columns = ref(
    Array.isArray(preferences.columns) ? preferences.columns.filter(column => optionalColumns.includes(column)) : []
);
const density = ref(preferences.density === "compact" ? "compact" : "standard");
const toggleColumn = column => {
    columns.value = columns.value.includes(column)
        ? columns.value.filter(item => item !== column)
        : [...columns.value, column];
};
watch([columns, density], () => {
    try {
        localStorage.setItem("monitor-table", JSON.stringify({ columns: columns.value, density: density.value }));
    } catch {
        /* Preferences are optional. */
    }
});
const accountLabel = record =>
    record.attemptCount === 0
        ? m("unassigned")
        : record.accountKey === "unattributed"
          ? m("unattributed")
          : account(record);
const columnValue = (record, column) =>
    ({
        apiKeys: keyLabel(record.apiKeyId),
        cacheState:
            record.tokenUsage?.cachedInputTokens == null
                ? m("unknown")
                : m(record.tokenUsage.cachedInputTokens > 0 ? "hit" : "miss"),
        ip: record.clientIp || "—",
        path: record.path || "—",
        protocol: record.apiFormat || "—",
        thought: number(record.tokenUsage?.thoughtTokens),
        total: number(record.tokenUsage?.totalTokens),
        tps: Number.isFinite(record.generationTps) ? record.generationTps.toFixed(1) : "—",
        ttft: duration(record.firstTextLatencyMs),
    })[column];
</script>
