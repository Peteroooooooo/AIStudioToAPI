<template>
    <section class="accounts-view" aria-labelledby="accounts-title">
        <header class="accounts-header">
            <div>
                <p class="accounts-eyebrow">{{ t("accountsEyebrow") }}</p>
                <h1 id="accounts-title">{{ t("accountManagement") }}</h1>
                <p class="accounts-subtitle">{{ t("accountsSubtitle") }}</p>
            </div>
            <div class="accounts-header-side">
                <span v-if="statsUpdatedAt" class="accounts-updated">
                    {{ t("usageUpdatedAt") }} {{ formatTime(statsUpdatedAt) }}
                </span>
                <div class="accounts-header-actions">
                    <button type="button" class="accounts-button" :disabled="isBusy" @click="refresh">
                        {{ t("usageRefresh") }}
                    </button>
                    <button type="button" class="accounts-button" :disabled="isBusy" @click="emit('upload')">
                        {{ t("uploadFile") }}
                    </button>
                    <button
                        type="button"
                        class="accounts-button accounts-button-primary"
                        :disabled="isBusy"
                        @click="emit('add')"
                    >
                        {{ t("btnAddUser") }}
                    </button>
                </div>
            </div>
        </header>

        <div class="accounts-status-strip" :aria-label="t('accountsStatusSummary')">
            <div class="accounts-status-item">
                <span class="accounts-status-dot is-ready"></span>
                <span>{{ t("accountsAvailable") }}</span>
                <strong>{{ statusCounts.available }}</strong>
            </div>
            <div class="accounts-status-item">
                <span class="accounts-status-dot is-cooldown"></span>
                <span>{{ t("healthCooldown") }}</span>
                <strong>{{ statusCounts.cooldown }}</strong>
            </div>
            <div class="accounts-status-item">
                <span class="accounts-status-dot is-reauth"></span>
                <span>{{ t("healthReauth") }}</span>
                <strong>{{ statusCounts.reauth }}</strong>
            </div>
            <div class="accounts-status-item">
                <span class="accounts-status-dot is-disabled"></span>
                <span>{{ t("healthDisabled") }}</span>
                <strong>{{ statusCounts.disabled }}</strong>
            </div>
            <div class="accounts-current-counters">
                <span
                    >{{ t("accountsCurrentRotation") }} <strong>{{ usageCount ?? "—" }}</strong></span
                >
                <span
                    >{{ t("accountsCurrentFailures") }} <strong>{{ failureCount ?? "—" }}</strong></span
                >
            </div>
        </div>

        <div class="accounts-toolbar">
            <div class="accounts-toolbar-main">
                <label class="accounts-search">
                    <span class="sr-only">{{ t("accountsSearch") }}</span>
                    <input v-model.trim="search" type="search" :placeholder="t('accountsSearchPlaceholder')" />
                </label>
                <label class="accounts-filter">
                    <span class="sr-only">{{ t("accountsFilterStatus") }}</span>
                    <select v-model="statusFilter" :aria-label="t('accountsFilterStatus')">
                        <option value="all">{{ t("accountsAllStatuses") }}</option>
                        <option value="available">{{ t("accountsAvailable") }}</option>
                        <option value="cooldown">{{ t("healthCooldown") }}</option>
                        <option value="reauth">{{ t("healthReauth") }}</option>
                        <option value="disabled">{{ t("healthDisabled") }}</option>
                        <option value="excluded">{{ t("accountsExcluded") }}</option>
                    </select>
                </label>
                <div class="accounts-range" :aria-label="t('usageTimeRange')">
                    <button
                        v-for="range in ranges"
                        :key="range.value"
                        type="button"
                        :class="{ 'is-active': statsRange === range.value }"
                        :aria-pressed="statsRange === range.value"
                        @click="statsRange = range.value"
                    >
                        {{ t(range.label) }}
                    </button>
                </div>
            </div>
            <div class="accounts-toolbar-secondary">
                <span class="accounts-range-note">{{
                    statsLoading ? t("accountsLoadingStats") : t("accountsRangeNote")
                }}</span>
                <button type="button" class="accounts-text-button" :disabled="isBusy" @click="emit('deduplicate')">
                    {{ t("btnDeduplicateAuth") }}
                </button>
            </div>
        </div>

        <p v-if="statsError" class="accounts-inline-error" role="alert">
            {{ t("usageLoadFailed") }}: {{ statsError }}
            <button type="button" @click="loadStats">{{ t("usageRefresh") }}</button>
        </p>

        <div v-if="accounts.length" class="accounts-selection">
            <el-checkbox
                :model-value="allVisibleSelected"
                :indeterminate="someVisibleSelected && !allVisibleSelected"
                :disabled="!filteredAccounts.length || isBusy"
                @change="toggleAllVisible"
            >
                {{ t("selectAll") }}
            </el-checkbox>
            <span class="accounts-selection-count">{{ t("selectedCount", { count: selectedIndices.length }) }}</span>
            <template v-if="selectedIndices.length">
                <button
                    type="button"
                    class="accounts-text-button"
                    :disabled="isBusy"
                    @click="emit('batch-download', selectedIndices)"
                >
                    {{ t("batchDownload") }}
                </button>
                <button
                    type="button"
                    class="accounts-text-button is-danger"
                    :disabled="isBusy"
                    @click="emit('batch-delete', selectedIndices)"
                >
                    {{ t("batchDelete") }}
                </button>
            </template>
        </div>

        <div v-if="!accounts.length" class="accounts-empty">
            <strong>{{ t("accountsNoAccounts") }}</strong>
            <p>{{ t("accountsNoAccountsHint") }}</p>
            <button type="button" class="accounts-button accounts-button-primary" @click="emit('add')">
                {{ t("btnAddUser") }}
            </button>
        </div>
        <div v-else-if="!filteredAccounts.length" class="accounts-empty">
            <strong>{{ t("accountsNoMatches") }}</strong>
            <button type="button" class="accounts-text-button" @click="clearFilters">
                {{ t("accountsClearFilters") }}
            </button>
        </div>
        <template v-else>
            <div class="accounts-table-wrap">
                <table class="accounts-table">
                    <thead>
                        <tr>
                            <th class="accounts-select-column">
                                <span class="sr-only">{{ t("selectAll") }}</span>
                            </th>
                            <th>{{ t("account") }}</th>
                            <th>{{ t("accountStatus") }}</th>
                            <th>{{ t("accountsLastFailure") }}</th>
                            <th>{{ t("usageLastUsed") }}</th>
                            <th>{{ t("accountsCallsAttempts") }}</th>
                            <th>{{ t("usageTotalTokens") }}</th>
                            <th>{{ t("accountsActions") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="account in filteredAccounts"
                            :key="account.index"
                            :class="{ 'is-current': account.index === currentAuthIndex }"
                        >
                            <td>
                                <el-checkbox
                                    :model-value="selected.has(account.index)"
                                    :aria-label="`${t('accountsSelectAccount')} #${account.index}`"
                                    :disabled="isBusy"
                                    @change="toggleSelected(account.index)"
                                />
                            </td>
                            <td class="accounts-name-cell">
                                <button type="button" class="accounts-name-button" @click="openDetails(account)">
                                    <span class="accounts-index">#{{ account.index }}</span>
                                    <strong>{{ displayName(account) }}</strong>
                                </button>
                                <div class="accounts-tags">
                                    <span v-if="account.index === currentAuthIndex" class="accounts-tag is-current">{{
                                        t("tagCurrent")
                                    }}</span>
                                    <span v-if="account.isInvalid" class="accounts-tag is-issue">{{
                                        t("jsonFormatError")
                                    }}</span>
                                    <span v-if="account.isDuplicate" class="accounts-tag is-issue">{{
                                        t("duplicateAuth")
                                    }}</span>
                                    <span v-if="account.isExpired" class="accounts-tag is-issue">{{
                                        t("tagExpired")
                                    }}</span>
                                    <span v-if="account.hasContext" class="accounts-tag">{{
                                        t("accountsContextReady")
                                    }}</span>
                                </div>
                            </td>
                            <td>
                                <span class="accounts-health" :class="`is-${healthTone(account)}`">
                                    <span class="accounts-status-dot" :class="`is-${healthTone(account)}`"></span>
                                    {{ healthLabel(account) }}
                                </span>
                                <small
                                    v-if="account.health?.mode === 'cooldown' && account.health?.until"
                                    class="accounts-muted"
                                >
                                    {{ t("accountsRemaining", { time: cooldownRemaining(account.health.until) }) }}
                                </small>
                            </td>
                            <td>{{ account.health?.lastStatus ? `HTTP ${account.health.lastStatus}` : "—" }}</td>
                            <td>{{ formatTime(statsFor(account)?.lastUsedAt) }}</td>
                            <td class="accounts-number-cell">
                                <template v-if="statsFor(account)">
                                    <strong>{{ formatNumber(statsFor(account).touchedRequests) }}</strong>
                                    <small
                                        >{{ formatNumber(statsFor(account).attemptCount) }}
                                        {{ t("accountsAttemptsShort") }}</small
                                    >
                                </template>
                                <span v-else>—</span>
                            </td>
                            <td class="accounts-number-cell">
                                <strong>{{ formatTokens(statsFor(account)?.tokenUsage?.totalTokens) }}</strong>
                                <small
                                    v-if="
                                        statsFor(account)?.tokenUsage?.totalTokens !== null &&
                                        statsFor(account)?.tokenUsage?.totalTokens !== undefined
                                    "
                                >
                                    {{ formatTokens(statsFor(account)?.tokenUsage?.inputTokens) }} /
                                    {{ formatTokens(statsFor(account)?.tokenUsage?.outputTokens) }}
                                </small>
                            </td>
                            <td>
                                <div class="accounts-row-actions">
                                    <button type="button" class="accounts-text-button" @click="openDetails(account)">
                                        {{ t("usageDetails") }}
                                    </button>
                                    <button
                                        type="button"
                                        class="accounts-text-button"
                                        :disabled="isBusy || account.index === currentAuthIndex || !account.isRotation"
                                        @click="emit('switch', account.index)"
                                    >
                                        {{ t("btnSwitchAccount") }}
                                    </button>
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div class="accounts-cards">
                <article v-for="account in filteredAccounts" :key="account.index" class="accounts-card">
                    <div class="accounts-card-top">
                        <el-checkbox
                            :model-value="selected.has(account.index)"
                            :aria-label="`${t('accountsSelectAccount')} #${account.index}`"
                            :disabled="isBusy"
                            @change="toggleSelected(account.index)"
                        />
                        <button type="button" class="accounts-name-button" @click="openDetails(account)">
                            <span class="accounts-index">#{{ account.index }}</span>
                            <strong>{{ displayName(account) }}</strong>
                        </button>
                        <span class="accounts-health" :class="`is-${healthTone(account)}`">{{
                            healthLabel(account)
                        }}</span>
                    </div>
                    <div class="accounts-tags">
                        <span v-if="account.index === currentAuthIndex" class="accounts-tag is-current">{{
                            t("tagCurrent")
                        }}</span>
                        <span v-if="account.isInvalid" class="accounts-tag is-issue">{{ t("jsonFormatError") }}</span>
                        <span v-if="account.isDuplicate" class="accounts-tag is-issue">{{ t("duplicateAuth") }}</span>
                        <span v-if="account.isExpired" class="accounts-tag is-issue">{{ t("tagExpired") }}</span>
                        <span v-if="account.hasContext" class="accounts-tag">{{ t("accountsContextReady") }}</span>
                    </div>
                    <p
                        v-if="account.health?.mode === 'cooldown' && account.health?.until"
                        class="accounts-cooldown-note"
                    >
                        {{ t("accountsRemaining", { time: cooldownRemaining(account.health.until) }) }}
                    </p>
                    <dl class="accounts-card-metrics">
                        <div>
                            <dt>{{ t("usageLastUsed") }}</dt>
                            <dd>{{ formatTime(statsFor(account)?.lastUsedAt) }}</dd>
                        </div>
                        <div>
                            <dt>{{ t("accountsCallsAttempts") }}</dt>
                            <dd>
                                {{
                                    statsFor(account)
                                        ? `${formatNumber(statsFor(account).touchedRequests)} / ${formatNumber(statsFor(account).attemptCount)}`
                                        : "—"
                                }}
                            </dd>
                        </div>
                        <div>
                            <dt>{{ t("usageTotalTokens") }}</dt>
                            <dd>{{ formatTokens(statsFor(account)?.tokenUsage?.totalTokens) }}</dd>
                        </div>
                        <div>
                            <dt>{{ t("accountsLastFailure") }}</dt>
                            <dd>{{ account.health?.lastStatus ? `HTTP ${account.health.lastStatus}` : "—" }}</dd>
                        </div>
                    </dl>
                    <div class="accounts-card-actions">
                        <button type="button" class="accounts-text-button" @click="openDetails(account)">
                            {{ t("usageDetails") }}
                        </button>
                        <button
                            type="button"
                            class="accounts-text-button"
                            :disabled="isBusy || account.index === currentAuthIndex || !account.isRotation"
                            @click="emit('switch', account.index)"
                        >
                            {{ t("btnSwitchAccount") }}
                        </button>
                    </div>
                </article>
            </div>
        </template>

        <p class="accounts-footnote">{{ t("accountsIdentityScope") }}</p>

        <el-drawer
            v-model="detailsOpen"
            :size="'min(100vw, 560px)'"
            :title="selectedAccount ? `#${selectedAccount.index} ${displayName(selectedAccount)}` : ''"
        >
            <template v-if="selectedAccount">
                <div class="accounts-detail-tags">
                    <span class="accounts-health" :class="`is-${healthTone(selectedAccount)}`">{{
                        healthLabel(selectedAccount)
                    }}</span>
                    <span v-if="selectedAccount.index === currentAuthIndex" class="accounts-tag is-current">{{
                        t("tagCurrent")
                    }}</span>
                    <span v-if="selectedAccount.isInvalid" class="accounts-tag is-issue">{{
                        t("jsonFormatError")
                    }}</span>
                    <span v-if="selectedAccount.isDuplicate" class="accounts-tag is-issue">{{
                        t("duplicateAuth")
                    }}</span>
                    <span v-if="selectedAccount.isExpired" class="accounts-tag is-issue">{{ t("tagExpired") }}</span>
                    <span v-if="selectedAccount.hasContext" class="accounts-tag">{{ t("accountsContextReady") }}</span>
                </div>
                <p
                    v-if="selectedAccount.health?.mode === 'cooldown' && selectedAccount.health?.until"
                    class="accounts-detail-note"
                >
                    {{ t("accountsRemaining", { time: cooldownRemaining(selectedAccount.health.until) }) }} ·
                    {{ t("healthUntil", { time: formatTime(selectedAccount.health.until) }) }}
                </p>
                <p
                    v-if="
                        selectedAccount.isDuplicate &&
                        selectedAccount.canonicalIndex !== null &&
                        selectedAccount.canonicalIndex !== undefined
                    "
                    class="accounts-detail-note"
                >
                    {{ t("duplicateAuthHint", { index: selectedAccount.canonicalIndex }) }}
                </p>
                <div class="accounts-detail-summary">
                    <div>
                        <span>{{ t("accountsCallsAttempts") }}</span
                        ><strong>{{
                            selectedStats
                                ? `${formatNumber(selectedStats.touchedRequests)} / ${formatNumber(selectedStats.attemptCount)}`
                                : "—"
                        }}</strong>
                    </div>
                    <div>
                        <span>{{ t("usageInputTokens") }}</span
                        ><strong>{{ formatTokens(selectedStats?.tokenUsage?.inputTokens) }}</strong>
                    </div>
                    <div>
                        <span>{{ t("usageOutputTokens") }}</span
                        ><strong>{{ formatTokens(selectedStats?.tokenUsage?.outputTokens) }}</strong>
                    </div>
                    <div>
                        <span>{{ t("usageTotalTokens") }}</span
                        ><strong>{{ formatTokens(selectedStats?.tokenUsage?.totalTokens) }}</strong>
                    </div>
                </div>
                <p class="accounts-detail-note">{{ t("accountsRangeNote") }}</p>
                <div class="accounts-detail-actions">
                    <button
                        v-if="selectedAccount.health?.mode === 'reauth'"
                        type="button"
                        class="accounts-button accounts-button-primary"
                        :disabled="isBusy"
                        @click="emit('add')"
                    >
                        {{ t("accountsOpenVncLogin") }}
                    </button>
                    <button
                        type="button"
                        class="accounts-button"
                        :disabled="isBusy || selectedAccount.isInvalid"
                        @click="emit('health', selectedAccount)"
                    >
                        {{ healthActionLabel(selectedAccount) }}
                    </button>
                    <button
                        type="button"
                        class="accounts-button"
                        :disabled="isBusy || selectedAccount.index === currentAuthIndex || !selectedAccount.isRotation"
                        @click="emit('switch', selectedAccount.index)"
                    >
                        {{ t("btnSwitchAccount") }}
                    </button>
                    <button type="button" class="accounts-button" @click="emit('download', selectedAccount.index)">
                        {{ t("download") }}
                    </button>
                    <button
                        type="button"
                        class="accounts-button is-danger"
                        :disabled="isBusy"
                        @click="emit('delete', selectedAccount.index)"
                    >
                        {{ t("btnDeleteUser") }}
                    </button>
                </div>

                <section class="accounts-attempts" aria-labelledby="accounts-attempts-title">
                    <div class="accounts-attempts-heading">
                        <div>
                            <h2 id="accounts-attempts-title">{{ t("accountsRecentAttempts") }}</h2>
                            <p>{{ t("accountsAttemptSampleNote") }}</p>
                        </div>
                        <span v-if="recentAttempts.length" class="accounts-sample-rate">
                            {{ t("accountsSampleSuccess", { rate: sampleSuccessRate, count: recentAttempts.length }) }}
                        </span>
                    </div>
                    <p v-if="attemptsLoading" class="accounts-detail-note">{{ t("accountsLoadingAttempts") }}</p>
                    <p v-else-if="attemptsError" class="accounts-inline-error" role="alert">{{ attemptsError }}</p>
                    <p v-else-if="!recentAttempts.length" class="accounts-detail-note">
                        {{ t("accountsNoRecentAttempts") }}
                    </p>
                    <ol v-else class="accounts-attempt-list">
                        <li v-for="attempt in recentAttempts" :key="attempt.key">
                            <span class="accounts-attempt-outcome" :class="`is-${attempt.outcome}`">{{
                                attemptLabel(attempt)
                            }}</span>
                            <span class="accounts-attempt-meta">
                                <time>{{ formatTime(attempt.finishedAt || attempt.startedAt) }}</time>
                                <small
                                    >{{ attempt.model || "—" }} ·
                                    {{ attempt.statusCode ? `HTTP ${attempt.statusCode}` : "—" }}</small
                                >
                            </span>
                            <strong>{{ formatTokens(attempt.tokenUsage?.totalTokens) }}</strong>
                        </li>
                    </ol>
                </section>
            </template>
        </el-drawer>
    </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
    accounts: { default: () => [], type: Array },
    currentAuthIndex: { default: -1, type: Number },
    failureCount: { default: null, type: [String, Number] },
    isBusy: { default: false, type: Boolean },
    t: { required: true, type: Function },
    usageCount: { default: null, type: [String, Number] },
});
const emit = defineEmits([
    "add",
    "batch-delete",
    "batch-download",
    "deduplicate",
    "delete",
    "download",
    "health",
    "refresh",
    "switch",
    "upload",
]);
const t = (key, options) => props.t(key, options);
const ranges = [
    { label: "accountsRange24h", value: "24h" },
    { label: "accountsRange7d", value: "7d" },
    { label: "accountsRangeAll", value: "all" },
];
const search = ref("");
const statusFilter = ref("all");
const statsRange = ref("24h");
const stats = ref(null);
const statsError = ref("");
const statsLoading = ref(false);
const selected = ref(new Set());
const selectedAccount = ref(null);
const detailsOpen = ref(false);
const recentAttempts = ref([]);
const attemptsLoading = ref(false);
const attemptsError = ref("");
const clockNow = ref(Date.now());
let statsGeneration = 0;
let attemptsGeneration = 0;
let refreshTimer = null;
let clockTimer = null;

const statusCounts = computed(() => {
    const counts = { available: 0, cooldown: 0, disabled: 0, reauth: 0 };
    for (const account of props.accounts) {
        const mode = account.health?.mode || "active";
        if (mode === "cooldown" || mode === "reauth" || mode === "disabled") counts[mode] += 1;
        else if (account.isRotation) counts.available += 1;
    }
    return counts;
});
const healthTone = account => {
    const mode = account.health?.mode;
    if (mode === "cooldown" || mode === "reauth" || mode === "disabled") return mode;
    return account.isRotation ? "ready" : "excluded";
};
const healthLabel = account => {
    const tone = healthTone(account);
    if (tone === "cooldown") return t("healthCooldown");
    if (tone === "reauth") return t("healthReauth");
    if (tone === "disabled") return t("healthDisabled");
    return tone === "ready" ? t("accountsAvailable") : t("accountsExcluded");
};
const healthActionLabel = account => {
    const mode = account.health?.mode;
    if (mode === "disabled") return t("healthEnable");
    if (mode === "cooldown") return t("accountsClearCooldown");
    if (mode === "reauth") return t("accountsRetryWithoutReauth");
    return t("healthDisable");
};
const displayName = account => account.name || (account.isInvalid ? t("jsonFormatError") : t("unnamedAccount"));
const accountKey = account => (account.name ? `name:${account.name.trim().toLowerCase()}` : `index:${account.index}`);
const accountStats = computed(() => new Map((stats.value?.accounts || []).map(item => [item.accountKey, item])));
const statsFor = account => accountStats.value.get(accountKey(account)) || null;
const statsUpdatedAt = computed(() => stats.value?.asOf || null);
const filteredAccounts = computed(() => {
    const query = search.value.toLowerCase();
    return props.accounts.filter(account => {
        if (statusFilter.value !== "all" && healthTone(account) !== statusFilter.value) return false;
        return !query || `${account.index} ${account.name || ""}`.toLowerCase().includes(query);
    });
});
const selectedIndices = computed(() => [...selected.value].sort((a, b) => a - b));
const allVisibleSelected = computed(
    () =>
        filteredAccounts.value.length > 0 && filteredAccounts.value.every(account => selected.value.has(account.index))
);
const someVisibleSelected = computed(() => filteredAccounts.value.some(account => selected.value.has(account.index)));
const selectedStats = computed(() => (selectedAccount.value ? statsFor(selectedAccount.value) : null));
const sampleSuccessRate = computed(() => {
    if (!recentAttempts.value.length) return "—";
    const successes = recentAttempts.value.filter(attempt => attempt.outcome === "success").length;
    return `${Math.round((successes / recentAttempts.value.length) * 100)}%`;
});

const formatNumber = value => (Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "—");
const formatTokens = value => (Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "—");
const formatTime = value => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};
const cooldownRemaining = until => {
    const remainingSeconds = Math.max(0, Math.ceil((Number(until) - clockNow.value) / 1000));
    const hours = Math.floor(remainingSeconds / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    const seconds = remainingSeconds % 60;
    return hours
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${minutes}:${String(seconds).padStart(2, "0")}`;
};
const toggleSelected = index => {
    const next = new Set(selected.value);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    selected.value = next;
};
const toggleAllVisible = () => {
    const next = new Set(selected.value);
    if (allVisibleSelected.value) filteredAccounts.value.forEach(account => next.delete(account.index));
    else filteredAccounts.value.forEach(account => next.add(account.index));
    selected.value = next;
};
const clearFilters = () => {
    search.value = "";
    statusFilter.value = "all";
};
const readJson = async url => {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (response.redirected || response.status === 401) {
        window.location.href = "/login";
        throw new Error(t("usageSessionExpired"));
    }
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || body.error || `HTTP ${response.status}`);
    }
    return response.json();
};
const loadStats = async () => {
    const generation = ++statsGeneration;
    statsLoading.value = true;
    statsError.value = "";
    try {
        const data = await readJson(`/api/usage-stats/overview?range=${statsRange.value}&requestCategory=generation`);
        if (generation === statsGeneration) stats.value = data;
    } catch (error) {
        if (generation === statsGeneration) statsError.value = error.message || String(error);
    } finally {
        if (generation === statsGeneration) statsLoading.value = false;
    }
};
const loadRecentAttempts = async account => {
    const generation = ++attemptsGeneration;
    recentAttempts.value = [];
    attemptsError.value = "";
    attemptsLoading.value = true;
    try {
        const params = new URLSearchParams({
            accountKey: accountKey(account),
            limit: "20",
            range: statsRange.value,
            requestCategory: "generation",
        });
        const result = await readJson(`/api/usage-stats/requests?${params}`);
        if (generation !== attemptsGeneration) return;
        const matches = [];
        for (const record of result.items || []) {
            for (const attempt of record.attempts || []) {
                if (!attempt.requestAttemptId) continue;
                const sameAccount = account.name
                    ? String(attempt.accountName || "").toLowerCase() === account.name.trim().toLowerCase()
                    : attempt.authIndex === account.index;
                if (!sameAccount) continue;
                matches.push({
                    ...attempt,
                    key: `${record.requestId}:${attempt.requestAttemptId}`,
                    model: record.model,
                });
            }
        }
        matches.sort((a, b) => String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt)));
        recentAttempts.value = matches.slice(0, 12);
    } catch (error) {
        if (generation === attemptsGeneration) attemptsError.value = error.message || String(error);
    } finally {
        if (generation === attemptsGeneration) attemptsLoading.value = false;
    }
};
const openDetails = account => {
    selectedAccount.value = account;
    detailsOpen.value = true;
    loadRecentAttempts(account);
};
const attemptLabel = attempt => {
    if (attempt.outcome === "success") return t("accountsAttemptSuccess");
    if (attempt.outcome === "aborted") return t("accountsAttemptAborted");
    return t("accountsAttemptFailed");
};
const refresh = () => {
    emit("refresh");
    loadStats();
    if (detailsOpen.value && selectedAccount.value) loadRecentAttempts(selectedAccount.value);
};

watch(statsRange, () => {
    loadStats();
    if (detailsOpen.value && selectedAccount.value) loadRecentAttempts(selectedAccount.value);
});
watch(
    () => props.accounts,
    accounts => {
        const indices = new Set(accounts.map(account => account.index));
        selected.value = new Set([...selected.value].filter(index => indices.has(index)));
        if (selectedAccount.value) {
            selectedAccount.value = accounts.find(account => account.index === selectedAccount.value.index) || null;
            if (!selectedAccount.value) detailsOpen.value = false;
        }
    }
);
onMounted(() => {
    loadStats();
    clockTimer = window.setInterval(() => {
        if (!document.hidden && statusCounts.value.cooldown) clockNow.value = Date.now();
    }, 1000);
    refreshTimer = window.setInterval(() => {
        if (!document.hidden) loadStats();
    }, 30000);
});
onBeforeUnmount(() => {
    statsGeneration += 1;
    attemptsGeneration += 1;
    if (refreshTimer !== null) window.clearInterval(refreshTimer);
    if (clockTimer !== null) window.clearInterval(clockTimer);
});
defineExpose({ clearSelection: () => (selected.value = new Set()), refresh });
</script>

<style lang="less" scoped>
@import "../styles/variables.less";

.accounts-view {
    color: @text-primary;
    min-width: 0;
}
.sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}
.accounts-header,
.accounts-header-actions,
.accounts-status-strip,
.accounts-toolbar-main,
.accounts-toolbar-secondary,
.accounts-selection,
.accounts-row-actions,
.accounts-card-actions,
.accounts-detail-actions,
.accounts-attempts-heading {
    display: flex;
    align-items: center;
    gap: 12px;
}
.accounts-header {
    justify-content: space-between;
    align-items: flex-end;
    flex-wrap: wrap;
    margin-bottom: 18px;
}
.accounts-header h1 {
    margin: 0;
    font-size: clamp(1.65rem, 2.4vw, 2.2rem);
    line-height: 1.15;
}
.accounts-eyebrow {
    margin: 0 0 4px;
    color: @primary-color;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}
.accounts-subtitle {
    margin: 8px 0 0;
    color: @text-secondary;
    font-size: 0.9rem;
}
.accounts-header-side {
    display: grid;
    justify-items: end;
    gap: 9px;
}
.accounts-updated,
.accounts-range-note,
.accounts-selection-count,
.accounts-muted,
.accounts-footnote,
.accounts-detail-note {
    color: @text-secondary;
    font-size: 0.78rem;
}
.accounts-button {
    min-height: 35px;
    padding: 7px 12px;
    border: 1px solid @border-light;
    border-radius: 8px;
    background: @background-white;
    color: @text-primary;
    font: inherit;
    font-size: 0.82rem;
    font-weight: 650;
    cursor: pointer;
}
.accounts-button:hover:not(:disabled) {
    border-color: @primary-color;
    color: @primary-color;
}
.accounts-button-primary {
    border-color: @primary-color;
    background: @primary-color;
    color: white;
}
.accounts-button-primary:hover:not(:disabled) {
    color: white;
    filter: brightness(1.08);
}
.accounts-button:disabled,
.accounts-text-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.accounts-button.is-danger,
.accounts-text-button.is-danger {
    color: @error-color;
}
.accounts-status-strip {
    flex-wrap: wrap;
    padding: 13px 16px;
    border: 1px solid @border-light;
    border-radius: 12px;
    background: @background-white;
}
.accounts-status-item {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 110px;
    font-size: 0.82rem;
}
.accounts-status-item strong {
    margin-left: auto;
    font-size: 1rem;
}
.accounts-status-dot {
    display: inline-block;
    flex: 0 0 7px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: @text-secondary;
}
.accounts-status-dot.is-ready {
    background: @success-color;
}
.accounts-status-dot.is-cooldown {
    background: @warning-color;
}
.accounts-status-dot.is-reauth {
    background: @error-color;
}
.accounts-status-dot.is-disabled,
.accounts-status-dot.is-excluded {
    background: @text-secondary;
}
.accounts-current-counters {
    display: flex;
    gap: 16px;
    margin-left: auto;
    color: @text-secondary;
    font-size: 0.79rem;
}
.accounts-current-counters strong {
    color: @text-primary;
}
.accounts-toolbar {
    margin: 15px 0 11px;
    padding: 12px 14px;
    border: 1px solid @border-light;
    border-radius: 12px;
    background: @background-white;
}
.accounts-toolbar-main {
    flex-wrap: wrap;
}
.accounts-search {
    flex: 1 1 220px;
}
.accounts-search input,
.accounts-filter select {
    width: 100%;
    min-height: 35px;
    padding: 7px 11px;
    border: 1px solid @border-light;
    border-radius: 8px;
    outline: none;
    background: @background-white;
    color: @text-primary;
    font: inherit;
    font-size: 0.82rem;
}
.accounts-search input:focus-visible,
.accounts-filter select:focus-visible {
    border-color: @primary-color;
}
.accounts-filter {
    flex: 0 1 160px;
}
.accounts-range {
    display: inline-flex;
    padding: 3px;
    border: 1px solid @border-light;
    border-radius: 9px;
}
.accounts-range button {
    padding: 5px 9px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: @text-secondary;
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
    white-space: nowrap;
}
.accounts-range button.is-active {
    background: rgba(var(--color-primary-rgb), 0.1);
    color: @primary-color;
    font-weight: 700;
}
.accounts-toolbar-secondary {
    justify-content: space-between;
    margin-top: 9px;
}
.accounts-text-button {
    padding: 4px 0;
    border: 0;
    background: none;
    color: @primary-color;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 650;
    cursor: pointer;
    white-space: nowrap;
}
.accounts-text-button:hover:not(:disabled) {
    text-decoration: underline;
}
.accounts-inline-error {
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(var(--color-error-rgb), 0.08);
    color: @error-color;
    font-size: 0.82rem;
}
.accounts-inline-error button {
    margin-left: 8px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
}
.accounts-selection {
    justify-content: flex-start;
    flex-wrap: wrap;
    min-height: 39px;
    gap: 11px;
}
.accounts-empty {
    display: grid;
    justify-items: start;
    gap: 8px;
    padding: 40px 22px;
    border: 1px dashed @border-light;
    border-radius: 12px;
    background: @background-white;
}
.accounts-empty p {
    margin: 0;
    color: @text-secondary;
    font-size: 0.85rem;
}
.accounts-table-wrap {
    overflow-x: auto;
    border: 1px solid @border-light;
    border-radius: 12px;
    background: @background-white;
}
.accounts-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
}
.accounts-table th {
    padding: 11px 10px;
    border-bottom: 1px solid @border-light;
    color: @text-secondary;
    font-size: 0.72rem;
    font-weight: 700;
    text-align: left;
    white-space: nowrap;
}
.accounts-table td {
    padding: 12px 10px;
    border-bottom: 1px solid @border-light;
    vertical-align: middle;
    white-space: nowrap;
}
.accounts-table tr:last-child td {
    border-bottom: 0;
}
.accounts-table tbody tr:hover {
    background: rgba(var(--color-primary-rgb), 0.03);
}
.accounts-table tbody tr.is-current {
    background: rgba(var(--color-primary-rgb), 0.045);
}
.accounts-select-column {
    width: 42px;
}
.accounts-name-cell {
    min-width: 175px;
    max-width: 280px;
}
.accounts-name-button {
    display: flex;
    align-items: baseline;
    gap: 7px;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: @text-primary;
    font: inherit;
    text-align: left;
    cursor: pointer;
}
.accounts-name-button strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
.accounts-name-button:hover strong {
    color: @primary-color;
    text-decoration: underline;
}
.accounts-index {
    color: @text-secondary;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
}
.accounts-tags,
.accounts-detail-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 5px;
}
.accounts-tag {
    padding: 2px 5px;
    border-radius: 4px;
    background: @background-light;
    color: @text-secondary;
    font-size: 0.68rem;
    font-weight: 650;
}
.accounts-tag.is-current {
    background: rgba(var(--color-primary-rgb), 0.09);
    color: @primary-color;
}
.accounts-tag.is-issue {
    background: rgba(var(--color-warning-rgb), 0.1);
    color: @warning-color;
}
.accounts-health {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 650;
}
.accounts-health.is-ready {
    color: @success-color;
}
.accounts-health.is-cooldown {
    color: @warning-color;
}
.accounts-health.is-reauth {
    color: @error-color;
}
.accounts-health.is-disabled,
.accounts-health.is-excluded {
    color: @text-secondary;
}
.accounts-muted,
.accounts-number-cell small {
    display: block;
    margin-top: 3px;
}
.accounts-number-cell {
    font-variant-numeric: tabular-nums;
}
.accounts-number-cell small {
    color: @text-secondary;
    font-size: 0.72rem;
}
.accounts-row-actions {
    gap: 10px;
}
.accounts-cards {
    display: none;
}
.accounts-footnote {
    margin: 12px 0 0;
}
.accounts-detail-tags {
    margin: 0 0 8px;
}
.accounts-detail-summary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 16px 0 8px;
}
.accounts-detail-summary div {
    display: grid;
    gap: 4px;
    padding: 11px;
    border: 1px solid @border-light;
    border-radius: 8px;
}
.accounts-detail-summary span {
    color: @text-secondary;
    font-size: 0.75rem;
}
.accounts-detail-summary strong {
    font-size: 1.15rem;
}
.accounts-detail-actions {
    flex-wrap: wrap;
    margin: 18px 0;
}
.accounts-attempts {
    margin-top: 24px;
}
.accounts-attempts-heading {
    justify-content: space-between;
    align-items: start;
}
.accounts-attempts h2 {
    margin: 0;
    font-size: 1rem;
}
.accounts-attempts-heading p {
    margin: 5px 0 0;
    color: @text-secondary;
    font-size: 0.75rem;
}
.accounts-sample-rate {
    color: @text-secondary;
    font-size: 0.75rem;
    white-space: nowrap;
}
.accounts-attempt-list {
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
}
.accounts-attempt-list li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    border-top: 1px solid @border-light;
    font-size: 0.78rem;
}
.accounts-attempt-outcome {
    flex: 0 0 58px;
    font-weight: 700;
}
.accounts-attempt-outcome.is-success {
    color: @success-color;
}
.accounts-attempt-outcome.is-error,
.accounts-attempt-outcome.is-aborted {
    color: @error-color;
}
.accounts-attempt-meta {
    display: grid;
    gap: 3px;
    min-width: 0;
}
.accounts-attempt-meta small {
    overflow: hidden;
    color: @text-secondary;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.accounts-attempt-list strong {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
}
@media (max-width: 900px) {
    .accounts-table-wrap {
        display: none;
    }
    .accounts-cards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
    }
    .accounts-card {
        min-width: 0;
        padding: 13px;
        border: 1px solid @border-light;
        border-radius: 11px;
        background: @background-white;
    }
    .accounts-card-top {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }
    .accounts-card-top .accounts-name-button {
        flex: 1;
        min-width: 0;
    }
    .accounts-card-metrics {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 11px;
        margin: 14px 0;
    }
    .accounts-card-metrics div {
        min-width: 0;
    }
    .accounts-card-metrics dt {
        color: @text-secondary;
        font-size: 0.72rem;
    }
    .accounts-card-metrics dd {
        margin: 3px 0 0;
        overflow: hidden;
        font-size: 0.82rem;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .accounts-card-actions {
        border-top: 1px solid @border-light;
        padding-top: 8px;
    }
}
.accounts-cooldown-note {
    margin: 9px 0 0;
    color: @warning-color;
    font-size: 0.75rem;
}
@media (max-width: 620px) {
    .accounts-header {
        align-items: flex-start;
    }
    .accounts-header-side,
    .accounts-header-actions {
        justify-items: start;
        width: 100%;
    }
    .accounts-header-actions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
    }
    .accounts-header-actions .accounts-button {
        min-width: 0;
        padding: 7px 4px;
    }
    .accounts-status-strip {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
    }
    .accounts-status-item {
        min-width: 0;
    }
    .accounts-current-counters {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-column: 1 / -1;
        width: 100%;
        margin-left: 0;
        padding-top: 7px;
        border-top: 1px solid @border-light;
    }
    .accounts-current-counters span {
        display: grid;
        gap: 2px;
    }
    .accounts-search,
    .accounts-filter {
        flex: 1 1 100%;
    }
    .accounts-range {
        width: 100%;
    }
    .accounts-range button {
        flex: 1;
    }
    .accounts-toolbar-secondary {
        flex-direction: column;
        align-items: flex-start;
    }
    .accounts-range-note {
        max-width: 100%;
    }
    .accounts-cards {
        grid-template-columns: 1fr;
    }
    .accounts-card-top .accounts-health {
        font-size: 0.74rem;
        white-space: nowrap;
    }
    .accounts-selection {
        gap: 7px 12px;
    }
    .accounts-detail-summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}
</style>
