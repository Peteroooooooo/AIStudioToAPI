<template>
    <section class="mm-monitor">
        <MonitorToolbar
            :busy="transferBusy"
            :connected="monitor.connected.value"
            :updated-at="overview?.asOf"
            :paused="monitor.paused.value"
            :refreshing="monitor.refreshing.value"
            :failures-only="query.outcome === 'error'"
            :filtered-export-disabled="monitor.queryPending.value || !!query.activity"
            :invalid="monitor.invalid.value"
            @import="$emit('import')"
            @export="$emit('export')"
            @export-filtered="monitor.exportFiltered"
            @failures="monitor.change({ outcome: query.outcome === 'error' ? '' : 'error' })"
            @pause="monitor.pause"
            @refresh="monitor.refresh"
        />
        <MonitorFilters
            :query="query"
            :options="filterOptions"
            :scope="scope"
            :scope-locked="monitor.scopeLocked.value"
            :invalid="monitor.invalid.value"
            @change="monitor.change"
            @reset="monitor.reset"
            @shortcut="monitor.shortcut"
        />
        <div v-if="monitor.error.value" class="mm-notice mm-danger" role="alert">{{ monitor.error.value }}</div>
        <MonitorSummary :summary="monitor.summary.value" :scope="scope" @select="selectSummary" />
        <MonitorTrend
            :items="overview?.trend || []"
            :granularity="monitor.granularity.value"
            :timezone="monitor.timezone.value"
            @granularity="monitor.granularity.value = $event"
            @timezone="monitor.timezone.value = $event"
        />
        <section class="mm-card mm-content">
            <div class="mm-content-header">
                <nav class="mm-tabs" :aria-label="m('title')">
                    <button
                        v-for="view in views"
                        :key="view"
                        :class="{ active: tab === view }"
                        :aria-current="tab === view ? 'page' : undefined"
                        @click="setView(view)"
                    >
                        {{ m(view) }}<span>{{ viewCount(view) }}</span>
                    </button>
                </nav>
                <div class="mm-content-state">
                    <small v-if="monitor.queryPending.value">{{ m("loading") }}</small>
                    <small v-if="monitor.paused.value">{{ m("connectionStale") }}</small
                    ><button v-if="monitor.pending.value" class="mm-new-records" @click="monitor.refresh">
                        +{{ monitor.pending.value }} {{ m("newRecords") }} · {{ m("loadNew") }}
                    </button>
                </div>
            </div>
            <div v-if="monitor.loading.value && !overview" class="mm-empty">{{ m("loading") }}</div>
            <RequestsTable
                v-else-if="tab === 'requests'"
                :items="query.activity ? monitor.visibleActive.value : monitor.requests.value.items"
                :total="query.activity ? monitor.active.value.totalMatched : monitor.requests.value.totalMatched"
                :page="query.activity ? 0 : monitor.page.value"
                :has-more="!query.activity && monitor.requests.value.hasMore"
                :loading="monitor.loading.value"
                :error="monitor.requestsError.value"
                :activity="query.activity"
                :active-count="monitor.active.value.totalMatched"
                @activity="monitor.change({ activity: $event, outcome: '' })"
                @open="monitor.open"
                @conversation="viewConversation"
                @next="monitor.next"
                @previous="monitor.previous"
                @retry="monitor.fetchPage(monitor.page.value)"
            />
            <AccountUsageTable
                v-else-if="tab === 'accounts'"
                :items="overview?.accounts || []"
                :runtime-accounts="runtimeAccounts"
                :stale="statusStale"
                :details="monitor.accountDetails.value"
                @expand="monitor.expand('account', $event)"
                @requests="monitor.viewGroup('account', $event)"
                @account-model="(account, model, failed) => monitor.viewGroup('account', account, failed, model)"
                @manage="$emit('manage-account', $event)"
            />
            <UsageGroupTable
                v-else-if="tab === 'models'"
                :items="overview?.models || []"
                kind="model"
                @requests="monitor.viewGroup('model', $event)"
                @failures="monitor.viewGroup('model', $event, true)"
            />
            <UsageGroupTable
                v-else
                :items="overview?.apiKeys || []"
                kind="key"
                :details="monitor.keyDetails.value"
                @expand="monitor.expand('key', $event)"
                @requests="monitor.viewGroup('key', $event)"
                @failures="monitor.viewGroup('key', $event, true)"
                @key-model="(key, model, failed) => monitor.viewGroup('key', key, failed, model)"
            />
        </section>
        <RequestDetailsDrawer
            v-model:open="monitor.drawerOpen.value"
            :record="monitor.selected.value"
            :parent="monitor.parent.value"
            :parent-loading="monitor.parentLoading.value"
            :parent-error="monitor.parentError.value"
            @parent="monitor.loadParent"
            @logs="$emit('logs', $event)"
            @conversation="viewConversation"
        />
    </section>
</template>
<script setup>
import { computed, provide, watch } from "vue";
import I18n from "../utils/i18n";
import { accountDisplayLabel } from "../utils/accountNumbers";
import MonitorToolbar from "./monitoring/MonitorToolbar.vue";
import MonitorFilters from "./monitoring/MonitorFilters.vue";
import MonitorSummary from "./monitoring/MonitorSummary.vue";
import MonitorTrend from "./monitoring/MonitorTrend.vue";
import RequestsTable from "./monitoring/RequestsTable.vue";
import AccountUsageTable from "./monitoring/AccountUsageTable.vue";
import UsageGroupTable from "./monitoring/UsageGroupTable.vue";
import RequestDetailsDrawer from "./monitoring/RequestDetailsDrawer.vue";
import { monitorLabel } from "./monitoring/labels";
import { useMonitor } from "./monitoring/useMonitor";
const props = defineProps({
    focusRequestId: { default: "", type: String },
    languageVersion: { default: 0, type: Number },
    runtimeAccounts: { default: () => [], type: Array },
    statusStale: Boolean,
    transferBusy: Boolean,
});
defineEmits(["import", "export", "manage-account", "logs"]);
const m = key => {
    props.languageVersion;
    return monitorLabel(key, I18n.getLang());
};
const t = (key, options) => {
    props.languageVersion;
    return I18n.t(key, options);
};
provide("monitor", { account: record => accountDisplayLabel(record, props.runtimeAccounts), m, t });
const monitor = useMonitor(m);
const { query, tab, scope, overview } = monitor;
const views = ["requests", "accounts", "models", "apiKeys"];
const setView = view => {
    if (view === "accounts" && query.accountKey === "unassigned") query.accountKey = "";
    tab.value = view;
};
const viewCount = view =>
    view === "requests" ? (overview.value?.summary.totalRequests ?? 0) : (overview.value?.[view]?.length ?? 0);
const filterOptions = computed(() => {
    const options = { ...overview.value?.filterOptions };
    const conversations = new Map((options.conversations || []).map(item => [item.conversationId, item]));
    for (const record of [
        ...(monitor.requests.value.items || []),
        ...(monitor.active.value.items || []),
        ...(monitor.selected.value ? [monitor.selected.value] : []),
    ])
        if (record.conversationId) conversations.set(record.conversationId, record);
    options.conversations = [...conversations.values()];
    options.accounts = [...(options.accounts || [])];
    for (const row of props.runtimeAccounts) {
        const key = row.name ? `name:${row.name.toLowerCase()}` : `index:${row.index}`;
        if (!options.accounts.some(item => item.accountKey === key))
            options.accounts.push({ accountKey: key, finalAccountName: row.name, finalAuthIndex: row.index });
    }
    // URL links can reference records outside the selected time range.
    if (
        query.accountKey &&
        query.accountKey !== "unassigned" &&
        !options.accounts.some(row => row.accountKey === query.accountKey)
    )
        options.accounts.push({
            accountKey: query.accountKey,
            finalAccountName: query.accountKey.replace(/^name:/, ""),
        });
    if (query.model && !options.models?.includes(query.model))
        options.models = [...(options.models || []), query.model];
    if (query.apiKeyId && !options.apiKeys?.some(row => row.apiKeyId === query.apiKeyId))
        options.apiKeys = [...(options.apiKeys || []), { apiKeyId: query.apiKeyId }];
    return options;
});
const selectSummary = key => {
    if (["success", "error"].includes(key)) {
        query.outcome = key;
        tab.value = "requests";
        query.activity = "";
    }
    if (key === "completed") {
        query.outcome = "";
        tab.value = "requests";
        query.activity = "";
    }
    if (key === "cached") {
        query.cacheState = "hit";
        tab.value = "requests";
    }
};
const viewConversation = id => {
    tab.value = "requests";
    monitor.drawerOpen.value = false;
    monitor.change({ activity: "", conversationId: id });
};
watch(
    () => props.focusRequestId,
    id => {
        if (id) monitor.focusRequest(id);
    }
);
defineExpose({
    focusRequest: monitor.focusRequest,
    refresh: monitor.refresh,
    refreshAfterImport: monitor.refreshAfterImport,
});
</script>
<style lang="less" src="./monitoring/monitor.less"></style>
