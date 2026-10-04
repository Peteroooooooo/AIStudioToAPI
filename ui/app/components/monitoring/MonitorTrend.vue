<template>
    <details class="mm-card mm-trend">
        <summary>{{ m("trend") }}</summary>
        <div class="mm-trend-controls">
            <select v-model="metric" :aria-label="m('trendMetric')">
                <option value="totalRequests">{{ m("requests") }}</option>
                <option value="inputTokens">{{ m("input") }}</option>
                <option value="outputTokens">{{ m("output") }}</option>
                <option value="cachedInputTokens">{{ m("cached") }}</option></select
            ><label
                >{{ m("granularity")
                }}<select :value="granularity" @change="$emit('granularity', $event.target.value)">
                    <option v-for="value in ['auto', 'hour', 'day']" :key="value" :value="value">{{ m(value) }}</option>
                </select></label
            ><label
                >{{ m("timezone")
                }}<select :value="timezone" @change="$emit('timezone', $event.target.value)">
                    <option v-for="value in zones" :key="value">{{ value }}</option>
                </select></label
            >
        </div>
        <p v-if="!items.length">{{ m("trendEmpty") }}</p>
        <div v-else class="mm-chart">
            <svg viewBox="0 0 900 130" role="img" :aria-label="m('trend')">
                <line x1="5" y1="120" x2="895" y2="120" stroke="var(--mm-border)" />
                <path :d="path" fill="none" stroke="#438bee" stroke-width="2" />
                <circle v-for="point in points" :key="point.time" :cx="point.x" :cy="point.y" r="3" fill="#438bee">
                    <title>{{ time(point.time) }} · {{ number(point.value) }}</title>
                </circle>
            </svg>
            <div class="mm-chart-labels">
                <span>{{ time(items[0]?.start) }}</span
                ><span>{{ time(items.at(-1)?.start) }}</span>
            </div>
        </div>
    </details>
</template>
<script setup>
import { computed, inject, ref } from "vue";
import { number, time } from "./format";
const props = defineProps({
    granularity: { default: "auto", type: String },
    items: { default: () => [], type: Array },
    timezone: { default: "UTC", type: String },
});
defineEmits(["granularity", "timezone"]);
const { m } = inject("monitor");
const metric = ref("totalRequests");
const zones = [
    ...new Set([
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        "UTC",
        ...(Intl.supportedValuesOf?.("timeZone") || []),
    ]),
];
const points = computed(() => {
    const values = props.items.map(item =>
        metric.value === "totalRequests" ? item.totalRequests : item.tokenUsage?.[metric.value]
    );
    const maximum = Math.max(1, ...values.filter(Number.isFinite));
    return props.items
        .map((item, index) => ({
            time: item.start,
            value: values[index],
            x: 5 + (index * 890) / Math.max(1, props.items.length - 1),
            y: 120 - ((values[index] || 0) / maximum) * 105,
        }))
        .filter(point => Number.isFinite(point.value));
});
const path = computed(() => points.value.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" "));
</script>
