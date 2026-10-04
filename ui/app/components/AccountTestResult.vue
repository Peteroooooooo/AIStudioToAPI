<template>
    <button
        v-if="result?.status !== 'running'"
        type="button"
        class="test-summary"
        :class="`is-${result?.status || 'untested'}`"
        :title="t('accountTestLast')"
        @click="$emit('open')"
    >
        {{ t("accountTestLast") }}：{{ label }}
        <span v-if="result?.finishedAt"> · {{ time }}</span>
    </button>
</template>

<script setup>
import { computed } from "vue";
const props = defineProps({ result: { default: null, type: Object }, t: { required: true, type: Function } });
defineEmits(["open"]);
const time = computed(() => {
    const date = new Date(props.result.finishedAt);
    const options = { hour: "2-digit", hour12: false, minute: "2-digit" };
    if (date.toDateString() !== new Date().toDateString()) Object.assign(options, { day: "2-digit", month: "2-digit" });
    return date.toLocaleString([], options);
});
const label = computed(() => {
    const result = props.result;
    if (!result) return props.t("accountTestCompact_untested");
    if (result.status === "success") return `✓ ${props.t("accountTestCompact_success")}`;
    if (result.status === "running") return props.t("accountTestCompact_running");
    const reasons = [
        "rate_limited",
        "request_timeout",
        "connection_lost",
        "needs_login",
        "access_denied",
        "startup_timeout",
        "startup_failed",
        "empty_response",
        "invalid_response",
    ];
    return `${result.status === "failed" ? "✕ " : ""}${props.t(`accountTestCompact_${reasons.includes(result.reason) ? result.reason : result.status === "not_tested" ? "not_tested" : "failed"}`)}`;
});
</script>

<style scoped>
.test-summary {
    display: block;
    margin-top: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: 0.75rem;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
}
.test-summary.is-success {
    color: var(--color-success);
}
.test-summary.is-failed {
    color: var(--color-error);
}
.test-summary.is-running {
    color: var(--color-primary);
}
.test-summary:hover {
    text-decoration: underline;
}
</style>
