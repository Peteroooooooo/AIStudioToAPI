<template>
    <div v-if="!items.length" class="mm-empty">{{ m("empty") }}</div>
    <div v-else class="mm-table-scroll">
        <table class="mm-table">
            <thead>
                <tr>
                    <th>{{ m(kind === "model" ? "model" : "apiKeys") }}</th>
                    <th>{{ m("completed") }}</th>
                    <th>{{ m("successRate") }}</th>
                    <th>{{ m("usage") }}</th>
                    <th>{{ m("cached") }}</th>
                    <th>{{ m("lastUsed") }}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <template v-for="item in items" :key="item.model || item.apiKeyId"
                    ><tr>
                        <td>
                            <strong class="mm-mono">{{
                                kind === "model"
                                    ? item.model
                                    : item.apiKeyId === "unknown"
                                      ? m("apiKeyUnknown")
                                      : keyLabel(item.apiKeyId)
                            }}</strong
                            ><small v-if="kind === 'key'">{{ m("safeKey") }}</small>
                        </td>
                        <td>
                            {{ number(item.completedCount)
                            }}<small
                                ><span class="mm-positive">{{ number(item.successCount) }}</span> /
                                <span class="mm-danger">{{ number(item.errorCount) }}</span></small
                            >
                        </td>
                        <td>{{ percent(item.successRate) }}</td>
                        <td><TokenUsageDisplay :usage="item.tokenUsage" /></td>
                        <td :title="number(item.tokenUsage?.cachedInputTokens)">
                            {{ compact(item.tokenUsage?.cachedInputTokens)
                            }}<small
                                >{{ m("coverage") }} {{ number(item.tokenUsageCoverage?.cachedInputTokens) }}/{{
                                    number(item.totalRequests)
                                }}</small
                            >
                        </td>
                        <td>{{ time(item.lastUsedAt) }}</td>
                        <td>
                            <div class="mm-row-actions">
                                <button class="mm-link" @click="$emit('requests', item)">{{ m("viewRequests") }}</button
                                ><button class="mm-link" @click="$emit('failures', item)">
                                    {{ m("viewFailures") }}</button
                                ><button
                                    v-if="kind === 'key'"
                                    class="mm-link"
                                    :aria-expanded="expanded === item.apiKeyId"
                                    @click="toggle(item)"
                                >
                                    {{ m("keyModels") }} {{ expanded === item.apiKeyId ? "▴" : "▾" }}
                                </button>
                            </div>
                        </td>
                    </tr>
                    <tr v-if="kind === 'key' && expanded === item.apiKeyId" class="mm-expansion-row">
                        <td colspan="7">
                            <div v-if="details[item.apiKeyId]?.loading" class="mm-empty">{{ m("loading") }}</div>
                            <div v-else-if="details[item.apiKeyId]?.error" class="mm-danger">
                                {{ details[item.apiKeyId].error }}
                            </div>
                            <UsageGroupTable
                                v-else
                                :items="details[item.apiKeyId]?.data?.models || []"
                                kind="model"
                                @requests="$emit('key-model', item, $event)"
                                @failures="$emit('key-model', item, $event, true)"
                            />
                        </td></tr
                ></template>
            </tbody>
        </table>
    </div>
</template>
<script setup>
import { inject, ref, watch } from "vue";
import { compact, keyLabel, number, percent, time } from "./format";
import TokenUsageDisplay from "./TokenUsageDisplay.vue";
const props = defineProps({
    details: { default: () => ({}), type: Object },
    items: { default: () => [], type: Array },
    kind: { default: "model", type: String },
});
const emit = defineEmits(["requests", "failures", "expand", "key-model"]);
const { m } = inject("monitor");
const expanded = ref("");
watch(
    () => props.details,
    cache => {
        const row = props.items.find(item => item.apiKeyId === expanded.value);
        if (row && !cache[expanded.value]) emit("expand", row);
    }
);
const toggle = item => {
    expanded.value = expanded.value === item.apiKeyId ? "" : item.apiKeyId;
    if (expanded.value && !props.details[item.apiKeyId]) emit("expand", item);
};
</script>
