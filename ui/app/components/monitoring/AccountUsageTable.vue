<template>
    <div class="mm-list-tools">
        <small>{{ m("accountViewScope") }}</small
        ><select v-model="sort" :aria-label="m('sort')">
            <option value="calls">{{ m("mostCalls") }}</option>
            <option value="latest">{{ m("latest") }}</option>
        </select>
    </div>
    <div v-if="!items.length" class="mm-empty">{{ m("empty") }}</div>
    <div v-else class="mm-table-scroll">
        <table class="mm-table mm-accounts">
            <thead>
                <tr>
                    <th>{{ m("account") }}</th>
                    <th>{{ m("current") }}</th>
                    <th>{{ m("calls") }}</th>
                    <th>{{ m("success") }} / {{ m("error") }}</th>
                    <th>{{ m("successRate") }}</th>
                    <th>{{ m("recent") }}</th>
                    <th>{{ m("usage") }}</th>
                    <th>{{ m("lastUsed") }}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <template v-for="item in sorted" :key="item.accountKey"
                    ><tr>
                        <td>
                            <button
                                class="mm-account-expand"
                                :aria-expanded="expanded === item.accountKey"
                                @click="toggle(item)"
                            >
                                <span>{{ expanded === item.accountKey ? "▾" : "▸" }}</span
                                ><strong>{{ item.unattributed ? m("unattributed") : account(item) }}</strong>
                            </button>
                        </td>
                        <td><AccountStatusBadge :account="runtime(item)" :stale="stale" /></td>
                        <td>{{ number(item.totalRequests) }}</td>
                        <td>
                            <span class="mm-positive">{{ number(item.successCount) }}</span> /
                            <span class="mm-danger">{{ number(item.errorCount) }}</span>
                        </td>
                        <td>{{ percent(item.successRate) }}</td>
                        <td><RecentOutcomes :items="item.recentOutcomes || []" /></td>
                        <td><TokenUsageDisplay :usage="item.tokenUsage" /></td>
                        <td>{{ time(item.lastUsedAt) }}</td>
                        <td>
                            <button class="mm-link" @click="$emit('requests', item)">{{ m("viewCalls") }}</button>
                        </td>
                    </tr>
                    <tr v-if="expanded === item.accountKey" class="mm-expansion-row">
                        <td colspan="9">
                            <div class="mm-account-expansion">
                                <section>
                                    <h3>{{ m("current") }}</h3>
                                    <AccountStatusBadge :account="runtime(item)" :stale="stale" />
                                    <p
                                        v-if="lastFailure(item)"
                                        class="mm-danger"
                                        :title="lastFailure(item).errorMessage || ''"
                                    >
                                        {{ m("recentFailure") }}: {{ status(lastFailure(item), m) }}
                                        {{ shortError(lastFailure(item).errorMessage) }}
                                    </p>
                                    <p v-else-if="runtime(item)?.health?.lastStatus" class="mm-danger">
                                        {{ m("recentFailure") }}: HTTP {{ runtime(item).health.lastStatus }}
                                        <small>{{
                                            time(
                                                runtime(item).health.lastFailureAt
                                                    ? new Date(runtime(item).health.lastFailureAt).toISOString()
                                                    : null
                                            )
                                        }}</small>
                                    </p>
                                    <p
                                        v-else-if="
                                            runtime(item)?.runtime?.reason &&
                                            runtime(item)?.runtime?.state === 'stalled'
                                        "
                                        class="mm-danger"
                                    >
                                        {{ runtime(item).runtime.reason }}
                                    </p>
                                    <div class="mm-test-result">
                                        <span>{{ m("lastTest") }}</span
                                        ><AccountTestResult
                                            v-if="runtime(item)?.lastTest"
                                            :result="runtime(item).lastTest"
                                            :t="t"
                                            @open="$emit('manage', runtime(item))"
                                        /><small v-else>{{ m("neverTested") }}</small>
                                    </div>
                                    <button
                                        v-if="runtime(item)"
                                        class="mm-link"
                                        @click="$emit('manage', runtime(item))"
                                    >
                                        {{ m("manage") }} ↗
                                    </button>
                                </section>
                                <section>
                                    <h3>{{ m("tokenStructure") }}</h3>
                                    <dl class="mm-mini-facts">
                                        <div v-for="field in tokenFields" :key="field[0]">
                                            <dt>{{ m(field[1]) }}</dt>
                                            <dd>{{ number(item.tokenUsage?.[field[0]]) }}</dd>
                                        </div>
                                    </dl>
                                    <small
                                        >{{ m("coverage") }} {{ number(item.tokenUsageCoverage?.inputTokens) }}/{{
                                            number(item.totalRequests)
                                        }}</small
                                    >
                                </section>
                                <section class="mm-account-models">
                                    <h3>{{ m("modelUsage") }}</h3>
                                    <p v-if="details[item.accountKey]?.loading">{{ m("loading") }}</p>
                                    <p v-else-if="details[item.accountKey]?.error" class="mm-danger">
                                        {{ details[item.accountKey].error }}
                                    </p>
                                    <UsageGroupTable
                                        v-else
                                        :items="details[item.accountKey]?.data?.models || []"
                                        kind="model"
                                        @requests="$emit('account-model', item, $event)"
                                        @failures="$emit('account-model', item, $event, true)"
                                    />
                                </section>
                            </div>
                        </td>
                    </tr>
                </template>
            </tbody>
        </table>
    </div>
</template>
<script setup>
import { computed, inject, ref, watch } from "vue";
import { account, number, percent, shortError, status, time } from "./format";
import AccountStatusBadge from "./AccountStatusBadge.vue";
import AccountTestResult from "../AccountTestResult.vue";
import RecentOutcomes from "./RecentOutcomes.vue";
import TokenUsageDisplay from "./TokenUsageDisplay.vue";
import UsageGroupTable from "./UsageGroupTable.vue";
const props = defineProps({
    details: { default: () => ({}), type: Object },
    items: { default: () => [], type: Array },
    runtimeAccounts: { default: () => [], type: Array },
    stale: Boolean,
});
const emit = defineEmits(["requests", "manage", "expand", "account-model"]);
const { m, t } = inject("monitor");
const expanded = ref("");
watch(
    () => props.details,
    cache => {
        const row = props.items.find(item => item.accountKey === expanded.value);
        if (row && !cache[expanded.value]) emit("expand", row);
    }
);
const sort = ref("calls");
const lastFailure = item => props.details[item.accountKey]?.data?.recentFailures?.[0];
const sorted = computed(() =>
    [...props.items].sort((a, b) =>
        sort.value === "latest"
            ? (b.lastUsedAt || "").localeCompare(a.lastUsedAt || "")
            : b.totalRequests - a.totalRequests
    )
);
const runtime = item =>
    props.runtimeAccounts.find(row =>
        row.name && item.finalAccountName
            ? row.name.toLowerCase() === item.finalAccountName.toLowerCase()
            : row.index === item.finalAuthIndex
    );
const toggle = item => {
    expanded.value = expanded.value === item.accountKey ? "" : item.accountKey;
    if (expanded.value && !props.details[item.accountKey]) emit("expand", item);
};
const tokenFields = [
    ["inputTokens", "input"],
    ["cachedInputTokens", "cached"],
    ["outputTokens", "output"],
    ["thoughtTokens", "thought"],
];
</script>
