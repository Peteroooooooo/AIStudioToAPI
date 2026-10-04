<template>
    <p v-if="!items.length" class="mm-muted">{{ m("emptyAttempts") }}</p>
    <ol v-else class="mm-timeline">
        <li v-for="(item, index) in items" :key="item.requestAttemptId || index">
            <div class="mm-timeline-head">
                <strong>{{ m("attempt") }} {{ index + 1 }} · {{ account(item) }}</strong
                ><RequestOutcomeBadge :outcome="item.outcome" />
            </div>
            <small
                >{{ status({ ...item, metricScope: "attempts" }, m) }} · {{ time(item.startedAt) }} ·
                {{ duration(item.durationMs) }}</small
            ><TokenUsageDisplay :usage="item.tokenUsage" />
            <pre v-if="item.errorMessage" class="mm-error-block">{{ item.errorMessage }}</pre>
            <small v-if="item.terminationReason">{{ m("termination") }}: {{ item.terminationReason }}</small>
            <details v-if="item.rawUsageMetadata">
                <summary>{{ m("raw") }}</summary>
                <pre>{{ JSON.stringify(item.rawUsageMetadata, null, 2) }}</pre>
            </details>
        </li>
    </ol>
</template>
<script setup>
import { inject } from "vue";
import { duration, status, time } from "./format";
import TokenUsageDisplay from "./TokenUsageDisplay.vue";
import RequestOutcomeBadge from "./RequestOutcomeBadge.vue";
defineProps({ items: { default: () => [], type: Array } });
const { account, m } = inject("monitor");
</script>
