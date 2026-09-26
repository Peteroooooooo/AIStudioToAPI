<template>
    <section class="console-dashboard">
        <header class="dashboard-heading">
            <div>
                <p class="dashboard-eyebrow">AIStudioToAPI</p>
                <h1>{{ t("consoleDashboard") }}</h1>
                <p>{{ t("consoleDashboardSubtitle") }}</p>
            </div>
            <div class="dashboard-heading-actions">
                <span v-if="overview?.asOf" class="dashboard-updated">
                    {{ t("consoleUpdatedAt") }} {{ formatTime(overview.asOf) }}
                </span>
                <button type="button" class="dashboard-refresh" :disabled="refreshing" @click="loadOverview">
                    {{ refreshing ? t("loading") : t("consoleRefresh") }}
                </button>
            </div>
        </header>

        <div class="dashboard-status-band">
            <div class="dashboard-status-main">
                <span class="dashboard-status-dot" :class="serviceTone"></span>
                <div>
                    <span class="dashboard-status-label">{{ t("consoleServiceStatus") }}</span>
                    <strong>{{ serviceLabel }}</strong>
                </div>
            </div>
            <div class="dashboard-status-detail">
                <span>{{ t("consoleBrowserStatus") }}</span>
                <strong>{{ browserLabel }}</strong>
            </div>
            <div class="dashboard-status-detail">
                <span>{{ t("consoleCurrentAccount") }}</span>
                <strong>{{ currentAccountLabel }}</strong>
            </div>
            <div class="dashboard-status-detail">
                <span>{{ t("consoleVersion") }}</span>
                <strong>{{ appVersion }}</strong>
            </div>
        </div>

        <div class="dashboard-metrics">
            <article class="dashboard-metric">
                <span>{{ t("consoleAvailableAccounts") }}</span>
                <strong>{{ readyAccounts }}</strong>
                <small>{{ t("consoleAccountsTotal", { count: accounts.length }) }}</small>
            </article>
            <article class="dashboard-metric">
                <span>{{ t("consoleCoolingAccounts") }}</span>
                <strong :class="{ 'is-warning': coolingAccounts > 0 }">{{ coolingAccounts }}</strong>
                <small>{{ t("consoleNeedsAttention", { count: problemAccounts }) }}</small>
            </article>
            <article class="dashboard-metric">
                <span>{{ t("consoleContextPool") }}</span>
                <strong
                    >{{ status.activeContextsCount || 0 }} <em>/ {{ contextLimit }}</em></strong
                >
                <small>{{ t("consoleWarmedContexts") }}</small>
            </article>
            <article class="dashboard-metric">
                <span>{{ t("consoleRequests24h") }}</span>
                <strong>{{ formatCount(overview?.summary?.totalRequests) }}</strong>
                <small>{{ t("consoleFailed24h", { count: formatCount(overview?.summary?.errorCount) }) }}</small>
            </article>
        </div>

        <div class="dashboard-columns">
            <section class="dashboard-panel context-panel">
                <div class="dashboard-panel-header">
                    <div>
                        <h2>{{ t("consoleContextPool") }}</h2>
                        <p>{{ t("consoleContextDescription") }}</p>
                    </div>
                    <button type="button" class="dashboard-text-action" @click="emit('navigate', 'accounts')">
                        {{ t("consoleSeeAccounts") }} <span aria-hidden="true">→</span>
                    </button>
                </div>
                <div v-if="accounts.length" class="context-list">
                    <div v-for="account in accounts" :key="account.index" class="context-row">
                        <span class="context-avatar">{{ account.index }}</span>
                        <div class="context-identity">
                            <strong>{{ accountLabel(account) }}</strong>
                            <small v-if="account.index === status.currentAuthIndex">{{
                                t("consoleCurrentAccount")
                            }}</small>
                            <small v-else>{{ healthLabel(account) }}</small>
                        </div>
                        <span class="context-badge" :class="account.hasContext ? 'is-ready' : 'is-idle'">
                            {{ account.hasContext ? t("consoleWarmed") : t("consoleNotWarmed") }}
                        </span>
                    </div>
                </div>
                <p v-else class="dashboard-empty">{{ t("consoleNoAccounts") }}</p>
                <div class="dashboard-panel-foot">
                    <span
                        >{{ t("consoleRotationCount") }} <strong>{{ status.usageCount ?? "–" }}</strong></span
                    >
                    <span
                        >{{ t("consoleFailureCount") }} <strong>{{ status.failureCount ?? "–" }}</strong></span
                    >
                    <button type="button" @click="emit('navigate', 'settings')">{{ t("consoleGoSettings") }}</button>
                </div>
            </section>

            <section class="dashboard-panel failures-panel">
                <div class="dashboard-panel-header">
                    <div>
                        <h2>{{ t("consoleRecentFailures") }}</h2>
                        <p>{{ t("consoleRecentFailuresDescription") }}</p>
                    </div>
                    <button type="button" class="dashboard-text-action" @click="emit('navigate', 'stats')">
                        {{ t("consoleSeeUsage") }} <span aria-hidden="true">→</span>
                    </button>
                </div>
                <p v-if="overviewError" class="dashboard-error" role="alert">{{ overviewError }}</p>
                <div v-if="overview?.recentFailures?.length" class="failure-list">
                    <button
                        v-for="failure in overview.recentFailures"
                        :key="failure.requestId"
                        type="button"
                        class="failure-row"
                        @click="emit('open-request', failure.requestId)"
                    >
                        <span class="failure-status">HTTP {{ failure.statusCode || "–" }}</span>
                        <span class="failure-main">
                            <strong>{{ failure.model || t("consoleUnknown") }}</strong>
                            <small>{{ formatTime(failure.finishedAt) }} · {{ shortId(failure.requestId) }}</small>
                            <small>{{ t("consoleAttemptedAccounts") }}: {{ attemptedAccounts(failure) }}</small>
                        </span>
                        <span class="failure-arrow" aria-hidden="true">→</span>
                    </button>
                </div>
                <p v-else-if="!overviewError" class="dashboard-empty">{{ t("consoleNoRecentFailures") }}</p>
            </section>
        </div>
    </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({
    appVersion: { default: "", type: String },
    status: { required: true, type: Object },
    t: { required: true, type: Function },
});
const emit = defineEmits(["navigate", "open-request"]);

const overview = ref(null);
const overviewError = ref("");
const refreshing = ref(false);
let pollTimer = null;

const accounts = computed(() => props.status.accountDetails || []);
const readyAccounts = computed(
    () =>
        accounts.value.filter(
            account =>
                account.isRotation &&
                !account.isInvalid &&
                !account.isExpired &&
                !account.isDuplicate &&
                account.health?.mode === "active"
        ).length
);
const coolingAccounts = computed(() => accounts.value.filter(account => account.health?.mode === "cooldown").length);
const problemAccounts = computed(
    () =>
        accounts.value.filter(
            account =>
                account.health?.mode !== "active" || account.isInvalid || account.isExpired || account.isDuplicate
        ).length
);
const contextLimit = computed(() => (props.status.maxContexts === 0 ? "∞" : (props.status.maxContexts ?? "–")));
const serviceTone = computed(() =>
    !props.status.serviceConnected ? "is-error" : props.status.isSystemBusy ? "is-warning" : "is-ready"
);
const serviceLabel = computed(() =>
    !props.status.serviceConnected
        ? props.t("consoleUnavailable")
        : props.status.isSystemBusy
          ? props.t("consoleBusy")
          : props.t("consoleRunning")
);
const browserLabel = computed(() =>
    props.status.browserConnected ? props.t("consoleConnected") : props.t("consoleDisconnected")
);
const currentAccountLabel = computed(() => {
    const current = accounts.value.find(account => account.index === props.status.currentAuthIndex);
    return current ? accountLabel(current) : props.t("consoleNoCurrentAccount");
});

const formatCount = value =>
    Number.isFinite(value) ? new Intl.NumberFormat(document.documentElement.lang || "en").format(value) : "–";
const formatTime = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "–" : date.toLocaleString(document.documentElement.lang || "en");
};
const shortId = value => (typeof value === "string" && value.length > 13 ? `${value.slice(0, 13)}…` : value || "–");
const attemptedAccounts = failure => {
    const indices = (failure.attempts || []).map(attempt => attempt.authIndex).filter(index => Number.isInteger(index));
    if (indices.length) return [...new Set(indices)].map(index => `#${index}`).join(" → ");
    return Number.isInteger(failure.finalAuthIndex) ? `#${failure.finalAuthIndex}` : "–";
};
const accountLabel = account => {
    const name = account?.name;
    if (!name) return `#${account?.index ?? "–"}`;
    const [local, domain] = name.split("@");
    if (!domain) return `#${account.index} · ${name}`;
    return `#${account.index} · ${local.slice(0, 2)}***@${domain}`;
};
const healthLabel = account => {
    if (account.isInvalid) return props.t("consoleInvalidAccount");
    if (account.isExpired) return props.t("consoleExpiredAccount");
    if (account.isDuplicate) return props.t("consoleDuplicateAccount");
    switch (account.health?.mode) {
        case "cooldown":
            return props.t("consoleCooldown");
        case "reauth":
            return props.t("consoleReauth");
        case "disabled":
            return props.t("consoleDisabled");
        default:
            return props.t("consoleAvailable");
    }
};

const loadOverview = async () => {
    if (refreshing.value) return;
    refreshing.value = true;
    try {
        const response = await fetch("/api/usage-stats/overview?range=24h&requestCategory=generation", {
            cache: "no-store",
        });
        if (response.status === 401) {
            window.location.href = "/login";
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        overview.value = await response.json();
        overviewError.value = "";
    } catch (error) {
        overviewError.value = `${props.t("consoleOverviewFailed")}: ${error.message}`;
    } finally {
        refreshing.value = false;
    }
};
const onVisibilityChange = () => {
    if (!document.hidden) loadOverview();
};
onMounted(() => {
    loadOverview();
    pollTimer = window.setInterval(() => {
        if (!document.hidden) loadOverview();
    }, 30000);
    document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeUnmount(() => {
    if (pollTimer) window.clearInterval(pollTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<style lang="less" scoped>
.console-dashboard {
    color: var(--text-primary);
    display: grid;
    gap: 18px;
    min-width: 0;
}
.dashboard-heading,
.dashboard-panel-header,
.dashboard-status-band,
.dashboard-panel-foot {
    align-items: center;
    display: flex;
    justify-content: space-between;
}
.dashboard-heading {
    gap: 16px;
}
.dashboard-heading h1 {
    font-size: clamp(1.45rem, 2vw, 1.85rem);
    letter-spacing: -0.025em;
    margin: 3px 0 5px;
}
.dashboard-heading p {
    color: var(--text-secondary);
    margin: 0;
}
.dashboard-eyebrow {
    color: var(--color-primary) !important;
    font-size: 0.74rem;
    font-weight: 800;
    letter-spacing: 0.13em;
    text-transform: uppercase;
}
.dashboard-heading-actions {
    align-items: center;
    display: flex;
    gap: 12px;
}
.dashboard-updated {
    color: var(--text-secondary);
    font-size: 0.8rem;
    white-space: nowrap;
}
.dashboard-refresh,
.dashboard-text-action,
.dashboard-panel-foot button {
    background: transparent;
    border: 1px solid var(--border-light);
    border-radius: 9px;
    color: var(--text-primary);
    cursor: pointer;
    font: inherit;
    padding: 8px 12px;
}
.dashboard-refresh:hover,
.dashboard-text-action:hover,
.dashboard-panel-foot button:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
}
.dashboard-refresh:disabled {
    cursor: wait;
    opacity: 0.6;
}
.dashboard-status-band {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: 16px;
    gap: 12px;
    padding: 18px 22px;
}
.dashboard-status-main {
    align-items: center;
    display: flex;
    gap: 12px;
    min-width: 165px;
}
.dashboard-status-main div,
.dashboard-status-detail {
    display: grid;
    gap: 3px;
}
.dashboard-status-label,
.dashboard-status-detail span {
    color: var(--text-secondary);
    font-size: 0.78rem;
}
.dashboard-status-main strong,
.dashboard-status-detail strong {
    font-size: 0.93rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dashboard-status-dot {
    border-radius: 50%;
    height: 10px;
    width: 10px;
}
.dashboard-status-dot.is-ready {
    background: var(--color-success);
    box-shadow: 0 0 0 5px rgba(var(--color-success-rgb), 0.12);
}
.dashboard-status-dot.is-warning {
    background: var(--color-warning);
}
.dashboard-status-dot.is-error {
    background: var(--color-error);
}
.dashboard-metrics {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
}
.dashboard-metric,
.dashboard-panel {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: 15px;
}
.dashboard-metric {
    display: grid;
    gap: 7px;
    min-width: 0;
    padding: 18px;
}
.dashboard-metric > span {
    color: var(--text-secondary);
    font-size: 0.79rem;
    font-weight: 600;
}
.dashboard-metric strong {
    font-size: 1.6rem;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.03em;
    line-height: 1.2;
}
.dashboard-metric strong.is-warning {
    color: var(--color-warning);
}
.dashboard-metric em {
    color: var(--text-secondary);
    font-size: 0.9rem;
    font-style: normal;
    font-weight: 500;
}
.dashboard-metric small {
    color: var(--text-secondary);
    font-size: 0.75rem;
}
.dashboard-columns {
    align-items: start;
    display: grid;
    gap: 14px;
    grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
}
.dashboard-panel {
    min-width: 0;
    padding: 19px;
}
.dashboard-panel-header {
    gap: 12px;
    margin-bottom: 12px;
}
.dashboard-panel-header h2 {
    font-size: 1rem;
    margin: 0 0 4px;
}
.dashboard-panel-header p {
    color: var(--text-secondary);
    font-size: 0.78rem;
    margin: 0;
}
.dashboard-text-action {
    border-color: transparent;
    color: var(--color-primary);
    flex-shrink: 0;
    font-size: 0.78rem;
    font-weight: 650;
}
.context-list,
.failure-list {
    display: grid;
}
.context-row,
.failure-row {
    align-items: center;
    border-top: 1px solid var(--border-light);
    display: flex;
    gap: 11px;
    min-height: 60px;
    padding: 9px 0;
}
.context-avatar {
    align-items: center;
    background: rgba(var(--color-primary-rgb), 0.1);
    border-radius: 9px;
    color: var(--color-primary);
    display: flex;
    flex: 0 0 32px;
    font-size: 0.78rem;
    font-weight: 800;
    height: 32px;
    justify-content: center;
}
.context-identity,
.failure-main {
    display: grid;
    gap: 3px;
    min-width: 0;
}
.context-identity {
    flex: 1;
}
.context-identity strong,
.failure-main strong {
    font-size: 0.82rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.context-identity small,
.failure-main small {
    color: var(--text-secondary);
    font-size: 0.73rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.context-badge {
    border-radius: 999px;
    font-size: 0.71rem;
    padding: 5px 8px;
    white-space: nowrap;
}
.context-badge.is-ready {
    background: rgba(var(--color-success-rgb), 0.13);
    color: var(--color-success);
}
.context-badge.is-idle {
    background: var(--bg-body);
    color: var(--text-secondary);
}
.failure-row {
    background: none;
    border-bottom: 0;
    border-left: 0;
    border-right: 0;
    border-radius: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
    width: 100%;
}
.failure-row:hover {
    color: var(--color-primary);
}
.failure-status {
    background: rgba(var(--color-error-rgb), 0.1);
    border-radius: 7px;
    color: var(--color-error);
    flex: 0 0 auto;
    font-size: 0.72rem;
    font-weight: 750;
    padding: 6px 8px;
}
.failure-main {
    flex: 1;
}
.failure-arrow {
    color: var(--text-secondary);
}
.dashboard-panel-foot {
    border-top: 1px solid var(--border-light);
    color: var(--text-secondary);
    flex-wrap: wrap;
    font-size: 0.75rem;
    gap: 10px;
    margin-top: 12px;
    padding-top: 13px;
}
.dashboard-panel-foot strong {
    color: var(--text-primary);
}
.dashboard-panel-foot button {
    font-size: 0.75rem;
    padding: 6px 9px;
}
.dashboard-empty,
.dashboard-error {
    color: var(--text-secondary);
    font-size: 0.82rem;
    margin: 16px 0;
}
.dashboard-error {
    color: var(--color-error);
}
@media (max-width: 1100px) {
    .dashboard-status-band {
        align-items: stretch;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .dashboard-metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}
@media (max-width: 760px) {
    .dashboard-heading {
        align-items: flex-start;
        flex-direction: column;
    }
    .dashboard-columns {
        grid-template-columns: 1fr;
    }
    .dashboard-heading-actions {
        justify-content: space-between;
        width: 100%;
    }
}
@media (max-width: 480px) {
    .console-dashboard {
        gap: 12px;
    }
    .dashboard-status-band {
        gap: 14px;
        padding: 16px;
    }
    .dashboard-metric {
        padding: 14px;
    }
    .dashboard-metric strong {
        font-size: 1.35rem;
    }
    .dashboard-panel {
        padding: 15px;
    }
    .dashboard-panel-header {
        align-items: flex-start;
    }
    .dashboard-panel-header p {
        max-width: 21ch;
    }
}
</style>
