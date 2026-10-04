<template>
    <div class="account-runtime">
        <template v-if="compact">
            <button
                type="button"
                class="runtime-status runtime-button"
                :class="`is-${status.tone}`"
                @click="$emit('open')"
            >
                <span class="runtime-dot" aria-hidden="true"></span>{{ compactLabel }}
                <span v-if="compactTime"> · {{ compactTime }}</span>
            </button>
            <p v-if="shortNote" class="runtime-note">{{ shortNote }}</p>
        </template>
        <template v-else>
            <strong class="runtime-status" :class="`is-${status.tone}`">
                <span class="runtime-dot" aria-hidden="true"></span>{{ t(status.label) }}
            </strong>
            <p class="runtime-description">{{ t(status.description) }}</p>
            <p v-if="shortNote" class="runtime-note">{{ shortNote }}</p>
            <p v-if="currentPhase" class="runtime-note">{{ t("accountCurrentOperation") }}: {{ currentPhase }}</p>
            <p v-if="retryAt" class="runtime-note">
                {{ t("accountRetryAt", { time: new Date(retryAt).toLocaleTimeString() }) }}
                ·
                {{
                    retryAt > now ? t("accountRetryRemaining", { time: duration(retryAt - now) }) : t("accountRetryDue")
                }}
            </p>
            <p v-if="!isStale && account.waiting" class="runtime-note">
                {{ t("accountWaitingCount", { count: account.waiting }) }}
            </p>
            <details v-if="!isStale" class="runtime-details" :open="expanded">
                <summary>{{ t("accountStatusDetails") }}</summary>
                <dl>
                    <div v-if="account.health?.lastStatus">
                        <dt>{{ t("accountsLastFailure") }}</dt>
                        <dd>HTTP {{ account.health.lastStatus }}</dd>
                        <small v-if="account.health.failureModel">{{ account.health.failureModel }}</small>
                    </div>
                    <div>
                        <dt>{{ t("accountBrowserConnection") }}</dt>
                        <dd>{{ t(account.runtime?.connected ? "accountConnected" : "accountNotConnected") }}</dd>
                        <small>{{ t("accountBrowserConnectionHelp") }}</small>
                    </div>
                    <div>
                        <dt>{{ t("accountBrowserRunning") }}</dt>
                        <dd>{{ t(account.hasContext ? "accountYes" : "accountNo") }}</dd>
                        <small>{{ t("accountBrowserRunningHelp") }}</small>
                    </div>
                    <div>
                        <dt>{{ t("accountSelectedForServing") }}</dt>
                        <dd>{{ t(account.poolMember ? "accountYes" : "accountNo") }}</dd>
                        <small>{{ t("accountSelectedForServingHelp") }}</small>
                    </div>
                    <div>
                        <dt>{{ t("accountGenerationActivity") }}</dt>
                        <dd>
                            {{
                                t(
                                    execution.state === "generating" || execution.state === "testing"
                                        ? "accountGenerating"
                                        : "accountNotGenerating"
                                )
                            }}
                        </dd>
                        <small>{{ t("accountGenerationActivityHelp") }}</small>
                    </div>
                    <div>
                        <dt>{{ t("accountBackgroundTasks") }}</dt>
                        <dd>{{ account.activity?.maintenance ?? 0 }}</dd>
                        <small>{{ t("accountBackgroundTasksHelp") }}</small>
                    </div>
                    <div
                        v-if="
                            account.runtime?.since &&
                            ['initializing', 'reconnecting', 'stalled', 'draining'].includes(account.runtime?.state)
                        "
                    >
                        <dt>{{ t("accountStateDuration") }}</dt>
                        <dd>{{ duration(now - account.runtime.since) }}</dd>
                        <small>{{ t("accountStateDurationHelp") }}</small>
                    </div>
                    <div v-if="account.slot?.requestId">
                        <dt>{{ t("requestId") }}</dt>
                        <dd class="runtime-request">{{ account.slot.requestId }}</dd>
                        <small>{{ t("accountRequestIdHelp") }}</small>
                    </div>
                    <div v-if="account.slot?.requestId && account.slot?.startedAt">
                        <dt>{{ t("accountRequestDuration") }}</dt>
                        <dd>{{ duration(now - account.slot.startedAt) }}</dd>
                        <small>{{ t("accountRequestDurationHelp") }}</small>
                    </div>
                    <div v-if="account.slot?.requestId && account.slot?.deadline">
                        <dt>{{ t("accountRequestTimeLeft") }}</dt>
                        <dd>{{ duration(account.slot.deadline - now) }}</dd>
                        <small>{{ t("accountRequestTimeLeftHelp") }}</small>
                    </div>
                    <div v-if="account.slot?.requestId && account.slot?.lastProgressAt">
                        <dt>{{ t("accountLastProgress") }}</dt>
                        <dd>{{ duration(now - account.slot.lastProgressAt) }}</dd>
                        <small>{{ t("accountLastProgressHelp") }}</small>
                    </div>
                    <div v-if="['stalled', 'unavailable'].includes(account.runtime?.state) && account.runtime?.reason">
                        <dt>{{ t("accountErrorDetail") }}</dt>
                        <dd class="runtime-reason">{{ runtimeReasonLabel(account.runtime.reason, t) }}</dd>
                        <small>{{ t("accountErrorDetailHelp") }}</small>
                    </div>
                </dl>
            </details>
        </template>
    </div>
</template>
<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { accountExecution, accountStatus, runtimeReasonLabel } from "../utils/runtimeLabels";
const props = defineProps({
    account: { required: true, type: Object },
    compact: { default: false, type: Boolean },
    expanded: { default: false, type: Boolean },
    stale: { default: false, type: Boolean },
    t: { required: true, type: Function },
});
defineEmits(["open"]);
const now = ref(Date.now());
let timer;
onMounted(() => {
    timer = setInterval(() => {
        now.value = Date.now();
    }, 1000);
});
onBeforeUnmount(() => clearInterval(timer));
const isStale = computed(
    () => props.stale || Boolean(props.account.observedAt && now.value - props.account.observedAt > 15000)
);
const execution = computed(() => accountExecution(props.account));
const status = computed(() => accountStatus({ ...props.account, statusStale: isStale.value }));
const compactLabel = computed(() => props.t(`accountCompact_${status.value.state}`));
const compactTime = computed(() => {
    if (isStale.value) return null;
    const startedAt = props.account.testRunning
        ? Date.parse(props.account.lastTest?.checkedAt)
        : execution.value.startedAt;
    if (status.value.state === "processing" && Number.isFinite(startedAt))
        return compactDuration(now.value - startedAt);
    return null;
});
const compactDuration = ms => {
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
    return `${seconds}s`;
};
const retryAt = computed(() => (props.account.health?.disabledBy === "auto" ? props.account.health?.until : null));
const shortNote = computed(() => {
    const note = status.value.note;
    if (!note) return "";
    if (note === "accountNote_autoDisabled") {
        const code = props.account.health.disabledStatus || props.account.health.lastStatus;
        const reason = code ? `HTTP ${code}` : props.t(note);
        return retryAt.value
            ? `${reason} · ${props.t("accountAutoEnableIn", { time: compactDuration(retryAt.value - now.value) })}`
            : reason;
    }
    return props.t(note);
});
const currentPhase = computed(() => {
    if (!["initializing", "reconnecting"].includes(props.account.runtime?.state) || !props.account.runtime?.phase)
        return null;
    const label = runtimeReasonLabel(props.account.runtime.phase, props.t);
    return label === props.account.runtime.phase ? props.t("accountBrowserOperation") : label;
});
const duration = ms => {
    if (!Number.isFinite(ms)) return "—";
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours
        ? props.t("accountDurationHours", { hours, minutes })
        : minutes
          ? props.t("accountDurationMinutes", { minutes, seconds: seconds % 60 })
          : props.t("accountDurationSeconds", { count: seconds });
};
</script>
<style scoped>
.account-runtime {
    max-width: 380px;
    font-size: 0.78rem;
    font-weight: 400;
    line-height: 1.5;
    white-space: normal;
    color: var(--el-text-color-secondary);
}
.runtime-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.86rem;
}
.runtime-button {
    padding: 0;
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
}
.runtime-button:hover {
    text-decoration: underline;
}
.runtime-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentcolor;
}
.is-success {
    color: var(--el-color-success);
}
.is-primary {
    color: var(--el-color-primary);
}
.is-warning {
    color: var(--el-color-warning);
}
.is-danger {
    color: var(--el-color-danger);
}
.is-muted {
    color: var(--el-text-color-secondary);
}
.runtime-description,
.runtime-note {
    margin: 5px 0 0;
}
.runtime-details {
    margin-top: 7px;
}
.runtime-details summary {
    width: fit-content;
    cursor: pointer;
    color: var(--el-color-primary);
}
.runtime-details dl {
    margin: 8px 0 0;
}
.runtime-details dl > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 3px 10px;
    padding: 7px 0;
    border-top: 1px solid var(--el-border-color-lighter);
}
.runtime-details dt {
    font-weight: 600;
}
.runtime-details dd {
    margin: 0;
}
.runtime-details small {
    grid-column: 1 / -1;
    line-height: 1.5;
}
.runtime-request,
.runtime-reason {
    overflow-wrap: anywhere;
}
</style>
