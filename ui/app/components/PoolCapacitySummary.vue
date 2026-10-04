<template>
    <section class="pool-capacity" :aria-label="t('poolCapacityTitle')">
        <div class="pool-capacity-grid">
            <div v-for="metric in primaryMetrics" :key="metric.key" :title="t(metric.help)">
                <span>{{ t(metric.label) }}</span
                ><strong>{{ stale ? "—" : (capacity?.[metric.key] ?? "—") }}</strong>
            </div>
        </div>
        <p v-if="!stale && capacity?.shortfall" class="pool-capacity-warning">
            {{ t("poolShortfallNotice", { count: capacity.shortfall }) }}
        </p>
        <ul v-if="blockedAccounts.length">
            <li v-for="account in blockedAccounts" :key="account.authIndex">
                #{{ account.authIndex }} ·
                {{ t(account.state === "stalled" ? "accountNote_connectionError" : "accountNote_connecting") }}
                <template v-if="account.nextRetryAt">
                    · {{ t("accountRetryAt", { time: formatTime(account.nextRetryAt) }) }}</template
                >
            </li>
        </ul>
        <details>
            <summary>{{ t("poolMetricsDetails") }}</summary>
            <dl>
                <div v-for="metric in allMetrics" :key="metric.key">
                    <dt>{{ t(metric.label) }}: {{ capacity?.[metric.key] ?? "—" }}</dt>
                    <dd>{{ t(metric.help) }}</dd>
                </div>
            </dl>
        </details>
        <p v-if="!capacity">{{ t("poolStateUnavailable") }}</p>
    </section>
</template>
<script setup>
import { computed } from "vue";
const props = defineProps({
    capacity: { default: null, type: Object },
    stale: { default: false, type: Boolean },
    t: { required: true, type: Function },
});
const primaryMetrics = [
    { help: "poolTargetHelp", key: "target", label: "poolTarget" },
    { help: "poolConfirmedReadyHelp", key: "ready", label: "poolConfirmedReady" },
    { help: "poolBusyHelp", key: "busy", label: "poolBusy" },
    { help: "poolWaitingHelp", key: "waiting", label: "poolWaiting" },
];
const allMetrics = [
    ...primaryMetrics,
    { help: "poolConfiguredTargetHelp", key: "configuredTarget", label: "poolConfiguredTarget" },
    { help: "poolVerifyingHelp", key: "verifying", label: "poolVerifying" },
    { help: "poolInitializingHelp", key: "initializing", label: "poolInitializing" },
    { help: "poolIdleHelp", key: "idle", label: "poolIdle" },
    { help: "poolMaintenanceHelp", key: "maintenance", label: "poolMaintenance" },
    { help: "poolShortfallHelp", key: "shortfall", label: "poolShortfall" },
];
const blockedAccounts = computed(() =>
    (props.stale ? [] : props.capacity?.accounts || []).filter(account =>
        ["initializing", "reconnecting", "stalled", "draining"].includes(account.state)
    )
);
const formatTime = value => (value ? new Date(value).toLocaleTimeString() : "—");
</script>
<style scoped>
.pool-capacity {
    margin: 16px 0;
    padding: 16px;
    border: 1px solid var(--el-border-color);
    border-radius: 12px;
    background: var(--el-bg-color);
}
.pool-capacity-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 12px;
}
.pool-capacity-grid div {
    display: grid;
    gap: 5px;
}
.pool-capacity-grid span {
    font-size: 0.78rem;
    color: var(--el-text-color-secondary);
}
.pool-capacity-grid strong {
    font-size: 1.2rem;
}
.pool-capacity-warning {
    color: var(--el-color-warning);
    font-weight: 600;
}
.pool-capacity ul {
    padding-left: 20px;
    font-size: 0.8rem;
    line-height: 1.7;
    overflow-wrap: anywhere;
}
.pool-capacity details {
    margin-top: 12px;
    font-size: 0.78rem;
}
.pool-capacity summary {
    cursor: pointer;
    width: fit-content;
    color: var(--el-color-primary);
}
.pool-capacity dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    gap: 12px 20px;
}
.pool-capacity dt {
    font-weight: 600;
}
.pool-capacity dd {
    margin: 4px 0 0;
    line-height: 1.5;
    color: var(--el-text-color-secondary);
}
</style>
