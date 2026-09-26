<!--
 * File: ui/app/pages/StatusPage.vue
 * Description: Status page component for displaying system status and logs
 *
 * Author: Ellinav, iBenzene, bbbugg
-->

<template>
    <div class="main-layout">
        <!-- Sidebar Navigation -->
        <aside class="sidebar" :aria-label="t('consoleNavigation')">
            <div class="sidebar-brand">
                <img src="/AIStudio_icon.svg" alt="" />
                <span
                    ><strong>AIStudioToAPI</strong><small>{{ t("consoleBrandSubtitle") }}</small></span
                >
            </div>
            <nav class="sidebar-menu" :aria-label="t('consoleNavigation')">
                <button
                    class="menu-item"
                    :class="{ active: activeTab === 'home' }"
                    :aria-current="activeTab === 'home' ? 'page' : undefined"
                    @click="switchTab('home')"
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                        <rect x="3" y="3" width="7" height="7" rx="1.5" />
                        <rect x="14" y="3" width="7" height="7" rx="1.5" />
                        <rect x="3" y="14" width="7" height="7" rx="1.5" />
                        <rect x="14" y="14" width="7" height="7" rx="1.5" />
                    </svg>
                    <span>{{ t("consoleDashboard") }}</span>
                </button>
                <button
                    class="menu-item"
                    :class="{ active: activeTab === 'accounts' }"
                    :aria-current="activeTab === 'accounts' ? 'page' : undefined"
                    @click="switchTab('accounts')"
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                        <circle cx="9" cy="8" r="3" />
                        <path d="M3 20v-2a6 6 0 0 1 12 0v2" />
                        <path d="M17 5a3 3 0 0 1 0 6" />
                        <path d="M18 14a5 5 0 0 1 3 4v2" />
                    </svg>
                    <span>{{ t("consoleAccounts") }}</span>
                </button>
                <button
                    class="menu-item"
                    :class="{ active: activeTab === 'stats' }"
                    :aria-current="activeTab === 'stats' ? 'page' : undefined"
                    @click="switchTab('stats')"
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                        <path d="M3 20h18" />
                        <path d="M5 16l5-5 4 3 5-8" />
                        <path d="M5 20v-4m5 4v-9m4 9v-6m5 6V6" />
                    </svg>
                    <span>{{ t("consoleAnalytics") }}</span>
                </button>
                <button
                    class="menu-item"
                    :class="{ active: activeTab === 'settings' }"
                    :aria-current="activeTab === 'settings' ? 'page' : undefined"
                    @click="switchTab('settings')"
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                        <path d="M4 6h16M4 12h16M4 18h16" />
                        <circle cx="9" cy="6" r="2" fill="var(--bg-card)" />
                        <circle cx="15" cy="12" r="2" fill="var(--bg-card)" />
                        <circle cx="8" cy="18" r="2" fill="var(--bg-card)" />
                    </svg>
                    <span>{{ t("consoleSettings") }}</span>
                </button>
                <button
                    class="menu-item"
                    :class="{ active: activeTab === 'logs' }"
                    :aria-current="activeTab === 'logs' ? 'page' : undefined"
                    @click="switchTab('logs')"
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <path d="m7 9 2 2-2 2m5 0h5m-5 4h5" />
                    </svg>
                    <span>{{ t("consoleLogs") }}</span>
                </button>
            </nav>
            <div class="sidebar-footer">
                <button class="sidebar-tool" type="button" @click="setTheme(theme === 'dark' ? 'light' : 'dark')">
                    {{ t("theme") }} · {{ theme === "dark" ? t("dark") : t("light") }}
                </button>
                <button
                    class="sidebar-tool"
                    type="button"
                    @click="handleLanguageChange(state.currentLang === 'en' ? 'zh' : 'en')"
                >
                    {{ t("switchLanguage") }} · {{ state.currentLang.toUpperCase() }}
                </button>
                <button class="sidebar-tool is-logout" type="button" @click="handleLogout">{{ t("logout") }}</button>
            </div>
        </aside>
        <!-- Main Content Area -->
        <main class="content-area">
            <header class="console-utility" :aria-label="t('consoleUtilities')">
                <strong>AIStudioToAPI</strong>
                <div>
                    <button type="button" @click="setTheme(theme === 'dark' ? 'light' : 'dark')">
                        {{ t("theme") }}
                    </button>
                    <button type="button" @click="handleLanguageChange(state.currentLang === 'en' ? 'zh' : 'en')">
                        {{ t("switchLanguage") }}
                    </button>
                    <button type="button" @click="handleLogout">{{ t("logout") }}</button>
                </div>
            </header>
            <input
                ref="fileInput"
                class="visually-hidden"
                type="file"
                accept=".json,.zip"
                multiple
                @change="handleFileUpload"
            />
            <!-- DASHBOARD / ACCOUNTS -->
            <DashboardView
                v-if="activeTab === 'home'"
                :app-version="appVersion"
                :status="state"
                :t="t"
                @navigate="switchTab"
                @open-request="openRequestFromDashboard"
            />
            <AccountsView
                v-if="activeTab === 'accounts'"
                ref="accountsViewRef"
                :accounts="state.accountDetails"
                :current-auth-index="state.currentAuthIndex"
                :is-busy="isBusy"
                :usage-count="state.usageCount"
                :failure-count="state.failureCount"
                :t="t"
                @add="addUser"
                @upload="triggerFileUpload"
                @deduplicate="deduplicateAuth"
                @switch="switchAccountByIndex"
                @health="updateAccountHealth"
                @delete="deleteAccountByIndex"
                @download="downloadAccountByIndex"
                @batch-delete="handleAccountBatchDelete"
                @batch-download="handleAccountBatchDownload"
                @refresh="updateContent"
            />
            <!-- SETTINGS VIEW -->
            <div v-if="activeTab === 'settings'" class="view-container settings-view">
                <header class="page-header settings-page-header">
                    <div>
                        <span class="settings-eyebrow">{{ t("consoleSettings") }}</span>
                        <h1>{{ t("settings") }}</h1>
                        <p>{{ t("consoleSettingsSubtitle") }}</p>
                    </div>
                </header>

                <section class="status-card runtime-config-card" aria-labelledby="runtime-config-title">
                    <div class="runtime-config-header">
                        <div>
                            <span class="runtime-config-eyebrow">{{ t("runtimeConfigEyebrow") }}</span>
                            <h2 id="runtime-config-title">{{ t("runtimeConfigTitle") }}</h2>
                            <p>{{ t("runtimeConfigDescription") }}</p>
                        </div>
                        <div class="runtime-config-actions">
                            <button
                                class="runtime-action-button"
                                type="button"
                                :disabled="runtimeConfig.busy"
                                @click="refreshRuntimeConfig"
                            >
                                {{ t("runtimeRefresh") }}
                            </button>
                            <button
                                class="runtime-action-button runtime-action-danger"
                                type="button"
                                :disabled="runtimeConfig.busy || !runtimeConfig.loaded"
                                @click="resetRuntimeConfig"
                            >
                                {{ t("runtimeResetInitial") }}
                            </button>
                            <button
                                class="runtime-action-button runtime-action-primary"
                                type="button"
                                :disabled="!runtimeCanSave"
                                @click="saveRuntimeConfig"
                            >
                                {{ runtimeConfig.busy === "saving" ? t("runtimeSaving") : t("runtimeSave") }}
                            </button>
                        </div>
                    </div>

                    <div v-if="runtimeConfig.error" class="runtime-config-notice is-error" role="alert">
                        {{ runtimeConfig.error }}
                    </div>
                    <div
                        v-else-if="runtimeConfig.externalChangeKey"
                        class="runtime-config-notice is-warning"
                        role="status"
                    >
                        {{ t(runtimeConfig.externalChangeKey) }}
                    </div>
                    <div v-else-if="runtimeConfig.notice" class="runtime-config-notice is-success" role="status">
                        {{ runtimeConfig.notice }}
                    </div>
                    <div v-if="runtimeConfig.loaded" class="runtime-config-meta">
                        <span>{{ t("runtimeRevision", { revision: runtimeConfig.revision }) }}</span>
                        <span v-if="runtimeConfig.configPath" class="runtime-config-path">
                            {{ t("runtimeConfigFile") }}: <code>{{ runtimeConfig.configPath }}</code>
                        </span>
                        <span v-if="runtimeDirtyKeys.length" class="is-dirty">
                            {{ t("runtimeUnsavedCount", { count: runtimeDirtyKeys.length }) }}
                        </span>
                    </div>

                    <div v-if="runtimeConfig.busy === 'loading' && !runtimeConfig.loaded" class="runtime-config-empty">
                        {{ t("loading") }}
                    </div>
                    <div v-else-if="!runtimeConfig.loaded" class="runtime-config-empty">
                        {{ t("runtimeNotLoaded") }}
                    </div>
                    <div v-else class="runtime-config-groups">
                        <div v-for="group in runtimeConfigGroups" :key="group.key" class="runtime-config-group">
                            <div class="runtime-config-group-heading">
                                <h3>{{ t(group.titleKey) }}</h3>
                                <p>{{ t(group.descriptionKey) }}</p>
                            </div>
                            <div class="runtime-config-fields">
                                <div v-for="field in group.fields" :key="field.key" class="runtime-config-field">
                                    <div class="runtime-field-heading">
                                        <label :for="`runtime-${field.key}`">{{ t(field.titleKey) }}</label>
                                    </div>
                                    <code class="runtime-field-key">{{ field.key }}</code>
                                    <p class="runtime-field-description">{{ t(field.descriptionKey) }}</p>
                                    <div class="runtime-field-input-row">
                                        <input
                                            :id="`runtime-${field.key}`"
                                            v-model="runtimeDraft[field.key]"
                                            type="number"
                                            inputmode="numeric"
                                            step="1"
                                            :min="field.min"
                                            :max="field.max"
                                            :disabled="!!runtimeConfig.busy"
                                            :aria-invalid="!!runtimeFieldErrors[field.key]"
                                            :aria-describedby="`runtime-${field.key}-help`"
                                        />
                                        <span v-if="field.unitKey" class="runtime-field-unit">{{
                                            t(field.unitKey)
                                        }}</span>
                                    </div>
                                    <div :id="`runtime-${field.key}-help`" class="runtime-field-footnote">
                                        <span v-if="runtimeFieldErrors[field.key]" class="runtime-field-error">
                                            {{ runtimeFieldErrors[field.key] }}
                                        </span>
                                        <span v-else>
                                            {{ t("runtimeEffective") }}:
                                            <strong>{{
                                                formatRuntimeValue(field, runtimeConfig.effective[field.key])
                                            }}</strong>
                                            <span class="runtime-field-separator">·</span>
                                            {{ t("runtimeInitial") }}:
                                            {{ formatRuntimeValue(field, runtimeConfig.defaults[field.key]) }}
                                            <span v-if="field.key === 'maxContexts'">
                                                ·
                                                {{
                                                    t("consoleInitializedContexts", {
                                                        count: state.activeContextsCount,
                                                    })
                                                }}
                                            </span>
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div v-for="group in runtimeOptionGroups" :key="group.key" class="runtime-config-group">
                            <div class="runtime-config-group-heading">
                                <h3>{{ t(group.titleKey) }}</h3>
                                <p>{{ t(group.descriptionKey) }}</p>
                            </div>
                            <div v-if="group.key === 'cache' && state.cacheStats" class="cache-status">
                                <div class="cache-status-heading">
                                    <strong>{{ t("runtimeCacheActivity") }}</strong>
                                    <small>{{ t("runtimeCacheActivityNote") }}</small>
                                </div>
                                <dl class="cache-status-metrics">
                                    <div v-for="metric in cacheStatusMetrics" :key="metric.key">
                                        <dt>{{ t(metric.labelKey) }}</dt>
                                        <dd>{{ state.cacheStats[metric.key] ?? 0 }}</dd>
                                    </div>
                                </dl>
                            </div>
                            <div class="runtime-option-fields">
                                <div v-for="field in group.fields" :key="field.key" class="runtime-option-field">
                                    <label :for="`runtime-${field.key}`">{{ t(field.titleKey) }}</label>
                                    <code>{{ field.key }}</code>
                                    <div class="runtime-option-control">
                                        <el-switch
                                            v-if="field.type === 'boolean'"
                                            :id="`runtime-${field.key}`"
                                            v-model="runtimeDraft[field.key]"
                                            :disabled="!!runtimeConfig.busy"
                                        />
                                        <el-select
                                            v-else-if="field.type === 'streaming'"
                                            :id="`runtime-${field.key}`"
                                            v-model="runtimeDraft[field.key]"
                                            :disabled="!!runtimeConfig.busy"
                                        >
                                            <el-option :label="t('real')" value="real" />
                                            <el-option :label="t('fake')" value="fake" />
                                        </el-select>
                                        <el-select
                                            v-else-if="field.type === 'logLevel'"
                                            :id="`runtime-${field.key}`"
                                            v-model="runtimeDraft[field.key]"
                                            :disabled="!!runtimeConfig.busy"
                                        >
                                            <el-option :label="t('normal')" value="INFO" />
                                            <el-option :label="t('debug')" value="DEBUG" />
                                        </el-select>
                                        <el-select
                                            v-else
                                            :id="`runtime-${field.key}`"
                                            v-model="runtimeDraft[field.key]"
                                            :disabled="!!runtimeConfig.busy"
                                        >
                                            <el-option
                                                v-for="option in safetySettingsThresholdOptions"
                                                :key="option.value"
                                                :label="t(option.label)"
                                                :value="option.value"
                                            />
                                        </el-select>
                                    </div>
                                    <small>
                                        {{ t("runtimeEffective") }}:
                                        {{ formatRuntimeOption(field, runtimeConfig.effective[field.key]) }}
                                        · {{ t("runtimeInitial") }}:
                                        {{ formatRuntimeOption(field, runtimeConfig.defaults[field.key]) }}
                                    </small>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div v-if="runtimeDirtyKeys.length" class="runtime-save-bar">
                        <span>{{ t("runtimeUnsavedCount", { count: runtimeDirtyKeys.length }) }}</span>
                        <button
                            type="button"
                            class="runtime-action-button"
                            :disabled="!!runtimeConfig.busy"
                            @click="refreshRuntimeConfig"
                        >
                            {{ t("consoleDiscardChanges") }}
                        </button>
                        <button
                            type="button"
                            class="runtime-action-button runtime-action-primary"
                            :disabled="!runtimeCanSave"
                            @click="saveRuntimeConfig"
                        >
                            {{ t("runtimeSave") }}
                        </button>
                    </div>
                </section>

                <div class="settings-secondary-grid">
                    <section class="status-card settings-information-card" aria-labelledby="startup-config-title">
                        <div class="settings-card-heading">
                            <h2 id="startup-config-title">{{ t("consoleStartup") }}</h2>
                            <p>{{ t("consoleStartupDescription") }}</p>
                        </div>
                        <div
                            v-if="runtimeConfig.startup.restartRequired"
                            class="runtime-config-notice is-warning"
                            role="status"
                        >
                            {{ t("consoleRestartPending") }}
                        </div>
                        <dl v-if="runtimeConfig.startup.host" class="settings-facts">
                            <div>
                                <dt>{{ t("consoleCurrentListener") }}</dt>
                                <dd>{{ runtimeConfig.startup.host }}:{{ runtimeConfig.startup.httpPort }}</dd>
                            </div>
                            <div>
                                <dt>{{ t("consoleApiKeysConfigured") }}</dt>
                                <dd>{{ runtimeConfig.startup.apiKeyCount }}</dd>
                            </div>
                            <div>
                                <dt>{{ t("consoleConsoleCredentials") }}</dt>
                                <dd>
                                    {{
                                        runtimeConfig.startup.consoleUsernameConfigured &&
                                        runtimeConfig.startup.consolePasswordConfigured
                                            ? t("consoleConfigured")
                                            : t("consoleNotConfigured")
                                    }}
                                </dd>
                            </div>
                            <div>
                                <dt>{{ t("consoleProxyConfigured") }}</dt>
                                <dd>
                                    {{
                                        runtimeConfig.startup.proxyConfigured
                                            ? t("consoleConfigured")
                                            : t("consoleNotConfigured")
                                    }}
                                </dd>
                            </div>
                            <div>
                                <dt>{{ t("runtimeConfigFile") }}</dt>
                                <dd class="settings-path">{{ runtimeConfig.configPath || "—" }}</dd>
                            </div>
                        </dl>
                        <p v-else class="settings-muted">{{ t("consoleStartupUnavailable") }}</p>
                        <p class="settings-footnote">{{ t("consoleRestartRequired") }}</p>
                    </section>

                    <section class="status-card settings-information-card" aria-labelledby="log-display-title">
                        <div class="settings-card-heading">
                            <h2 id="log-display-title">{{ t("logMaxCount") }}</h2>
                            <p>{{ t("consoleLogDisplayNote") }}</p>
                        </div>
                        <div class="settings-inline-field">
                            <label for="log-display-count">{{ t("logMaxCount") }}</label>
                            <el-input-number
                                id="log-display-count"
                                v-model="state.logMaxCount"
                                :min="1"
                                :max="1000"
                                @change="handleLogMaxCountChange"
                            />
                        </div>
                    </section>

                    <section class="status-card settings-information-card" aria-labelledby="appearance-title">
                        <div class="settings-card-heading">
                            <h2 id="appearance-title">{{ t("appearance") }}</h2>
                            <p>{{ t("consoleAppearanceDescription") }}</p>
                        </div>
                        <div class="settings-inline-field">
                            <label for="theme-select">{{ t("theme") }}</label>
                            <el-select id="theme-select" :model-value="theme" @update:model-value="setTheme">
                                <el-option :label="t('followSystem')" value="auto" />
                                <el-option :label="t('light')" value="light" />
                                <el-option :label="t('dark')" value="dark" />
                            </el-select>
                        </div>
                        <div class="settings-inline-field">
                            <label for="language-select">{{ t("language") }}</label>
                            <el-select id="language-select" v-model="state.currentLang" @change="handleLanguageChange">
                                <el-option label="中文" value="zh" />
                                <el-option label="English" value="en" />
                            </el-select>
                        </div>
                    </section>

                    <section class="status-card settings-information-card" aria-labelledby="version-title">
                        <div class="settings-card-heading">
                            <h2 id="version-title">{{ t("versionInfo") }}</h2>
                            <p>{{ t("consoleVersionDescription") }}</p>
                        </div>
                        <dl class="settings-facts">
                            <div>
                                <dt>{{ t("currentVersion") }}</dt>
                                <dd>{{ appVersion }}</dd>
                            </div>
                            <div>
                                <dt>{{ t("latestVersion") }}</dt>
                                <dd>{{ latestVersionFormatted }}</dd>
                            </div>
                        </dl>
                        <a
                            class="settings-link"
                            :href="state.releaseUrl || forkReleasesUrl"
                            target="_blank"
                            rel="noopener noreferrer"
                            >{{ t("viewRelease") }}</a
                        >
                    </section>
                </div>
            </div>
            <!-- STATS VIEW -->
            <div v-if="activeTab === 'stats'" class="view-container">
                <input
                    ref="usageStatsImportInput"
                    type="file"
                    style="display: none"
                    accept=".jsonl"
                    @change="handleUsageStatsImport"
                />
                <UsageAnalytics
                    ref="usageAnalyticsRef"
                    :language-version="langVersion"
                    :transfer-busy="isUsageStatsTransferBusy"
                    @import="triggerUsageStatsImport"
                    @export="downloadUsageStats"
                />
            </div>
            <!-- LOGS VIEW -->
            <LogsView
                v-if="activeTab === 'logs'"
                :logs="state.logs"
                :log-count="state.logCount"
                :language-version="langVersion"
            />
        </main>
    </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox, ElNotification } from "element-plus";
import AccountsView from "../components/AccountsView.vue";
import DashboardView from "../components/DashboardView.vue";
import LogsView from "../components/LogsView.vue";
import UsageAnalytics from "../components/UsageAnalytics.vue";
import JSZip from "jszip";
import escapeHtml from "../utils/escapeHtml";
import I18n from "../utils/i18n";
import { useTheme } from "../utils/useTheme";

const router = useRouter();
const route = useRoute();
const forkReleasesUrl = "https://github.com/Peteroooooooo/AIStudioToAPI/releases";
const fileInput = ref(null);
const usageStatsImportInput = ref(null);
const viewNames = new Set(["home", "accounts", "stats", "settings", "logs"]);
const viewFromQuery = value => (typeof value === "string" && viewNames.has(value) ? value : "home");
const activeTab = ref(viewFromQuery(route.query.view));
const isDownloadingUsageStats = ref(false);
const isImportingUsageStats = ref(false);
const isUsageStatsTransferBusy = computed(() => isDownloadingUsageStats.value || isImportingUsageStats.value);

// Create reactive version counter
const langVersion = ref(0);

// Translation function that tracks language changes
const t = (key, options) => {
    langVersion.value; // Access to track changes
    return I18n.t(key, options);
};

const usageAnalyticsRef = ref(null);
const accountsViewRef = ref(null);
const openRequestFromDashboard = async requestId => {
    switchTab("stats");
    await nextTick();
    usageAnalyticsRef.value?.focusRequest?.(requestId);
};

const scheduleUpdate = () => {
    if (!isActive) return;
    const randomInterval = 4000 + Math.floor(Math.random() * 3000);
    updateTimer = setTimeout(async () => {
        const updates = [updateContent()];
        if (activeTab.value === "settings") updates.push(pollRuntimeConfig());
        await Promise.all(updates).catch(err => {
            console.error("Error fetching data:", err.message || err);
        });
        scheduleUpdate();
    }, randomInterval);
};

const getApiErrorMessage = data => {
    if (data?.message) {
        return t(data.message, data);
    }

    if (data?.error) {
        return typeof data.error === "string" ? data.error : data.error.message;
    }

    return t("unknownError");
};

const switchTab = tabName => {
    if (!viewNames.has(tabName)) return;
    activeTab.value = tabName;
    if (tabName === "settings" && (!runtimeConfig.loaded || !runtimeDirtyKeys.value.length)) {
        loadRuntimeConfig();
    }
    if (route.query.view !== tabName) {
        router.push({ path: route.path, query: { ...route.query, view: tabName } });
    }
};

const { theme, setTheme } = useTheme();

const state = reactive({
    accountDetails: [],
    activeContextsCount: 0,
    apiKeySource: "",
    browserConnected: false,
    cacheStats: null,
    checkUpdateEnabled: true,
    currentAuthIndex: -1,
    currentLang: I18n.getLang(),
    debugModeEnabled: false,
    enableAuthUpdateEnabled: true,
    failureCount: 0,
    forceCodeExecutionEnabled: false,
    forceThinkingEnabled: false,
    forceUrlContextEnabled: false,
    forceWebSearchEnabled: false,
    hasUpdate: false,
    isSwitchingAccount: false,
    isSystemBusy: false,
    isUpdating: false,
    latestVersion: null,
    logCount: 0,
    logMaxCount: 100,
    logs: t("loading"),
    maxContexts: 1,
    maxRetries: 3,
    releaseUrl: null,
    safetySettingsThreshold: "OFF",
    selectedAccounts: new Set(), // Selected account indices
    serviceConnected: false,
    streamingModeReal: false,
    // theme: handled by useTheme
    usageCount: 0,
});

const runtimeConfigGroups = [
    {
        descriptionKey: "runtimeCapacityDescription",
        fields: [
            {
                descriptionKey: "runtimeMaxContextsDescription",
                key: "maxContexts",
                max: 32,
                min: 0,
                titleKey: "runtimeMaxContexts",
            },
        ],
        key: "capacity",
        titleKey: "runtimeCapacityTitle",
    },
    {
        descriptionKey: "runtimeRetryDescription",
        fields: [
            {
                descriptionKey: "runtimeMaxRetriesDescription",
                key: "maxRetries",
                max: 10,
                min: 1,
                titleKey: "runtimeMaxRetries",
            },
            {
                descriptionKey: "runtimeFailureThresholdDescription",
                key: "failureThreshold",
                max: 10000,
                min: 0,
                titleKey: "runtimeFailureThreshold",
            },
            {
                descriptionKey: "runtimeSwitchOnUsesDescription",
                key: "switchOnUses",
                max: 10000,
                min: 0,
                titleKey: "runtimeSwitchOnUses",
            },
            {
                descriptionKey: "runtimeRetryDelayDescription",
                key: "retryDelay",
                max: 60000,
                min: 50,
                titleKey: "runtimeRetryDelay",
                unitKey: "runtimeMilliseconds",
            },
        ],
        key: "retry",
        titleKey: "runtimeRetryTitle",
    },
    {
        descriptionKey: "runtimeTimeoutDescription",
        fields: [
            {
                descriptionKey: "runtimeStreamTimeoutDescription",
                key: "streamTimeoutMs",
                max: 300000,
                min: 1,
                titleKey: "runtimeStreamTimeout",
                unitKey: "runtimeMilliseconds",
            },
            {
                descriptionKey: "runtimeFakeStreamTimeoutDescription",
                key: "fakeStreamTimeoutMs",
                max: 300000,
                min: 1,
                titleKey: "runtimeFakeStreamTimeout",
                unitKey: "runtimeMilliseconds",
            },
        ],
        key: "timeouts",
        titleKey: "runtimeTimeoutTitle",
    },
    {
        descriptionKey: "runtimeCacheLimitsDescription",
        fields: [
            {
                descriptionKey: "runtimeCacheTtlDescription",
                key: "cacheTtlSeconds",
                max: 604800,
                min: 60,
                titleKey: "runtimeCacheTtl",
                unitKey: "runtimeSeconds",
            },
            {
                descriptionKey: "runtimeCacheRenewWindowDescription",
                key: "cacheRenewWindowSeconds",
                max: 86400,
                min: 0,
                titleKey: "runtimeCacheRenewWindow",
                unitKey: "runtimeSeconds",
            },
            {
                descriptionKey: "runtimeCacheMinTokensDescription",
                key: "cacheMinTokens",
                max: 100000,
                min: 1024,
                titleKey: "runtimeCacheMinTokens",
            },
            {
                descriptionKey: "runtimeCacheCheckpointTokensDescription",
                key: "cacheCheckpointTokens",
                max: 100000,
                min: 1024,
                titleKey: "runtimeCacheCheckpointTokens",
            },
            {
                descriptionKey: "runtimeCacheMaxEntriesDescription",
                key: "cacheMaxEntries",
                max: 1000,
                min: 1,
                titleKey: "runtimeCacheMaxEntries",
            },
        ],
        key: "cacheLimits",
        titleKey: "runtimeCacheLimitsTitle",
    },
];
const runtimeFields = runtimeConfigGroups.flatMap(group => group.fields);
const runtimeOptionGroups = [
    {
        descriptionKey: "runtimeCacheDescription",
        fields: [{ key: "cacheEnabled", titleKey: "runtimeCacheEnabled", type: "boolean" }],
        key: "cache",
        titleKey: "runtimeCacheTitle",
    },
    {
        descriptionKey: "consoleCapabilitiesDescription",
        fields: [
            { key: "streamingMode", titleKey: "streamingMode", type: "streaming" },
            { key: "forceThinking", titleKey: "forceThinking", type: "boolean" },
            { key: "forceWebSearch", titleKey: "forceWebSearch", type: "boolean" },
            { key: "forceUrlContext", titleKey: "forceUrlContext", type: "boolean" },
            { key: "forceCodeExecution", titleKey: "forceCodeExecution", type: "boolean" },
        ],
        key: "capabilities",
        titleKey: "consoleCapabilities",
    },
    {
        descriptionKey: "consoleOperationsDescription",
        fields: [
            { key: "checkUpdate", titleKey: "checkUpdate", type: "boolean" },
            { key: "enableAuthUpdate", titleKey: "enableAuthUpdate", type: "boolean" },
            { key: "logLevel", titleKey: "logLevel", type: "logLevel" },
            { key: "safetySettingsThreshold", titleKey: "safetySettingsThreshold", type: "safety" },
        ],
        key: "operations",
        titleKey: "consoleOperations",
    },
];
const runtimeOptionFields = runtimeOptionGroups.flatMap(group => group.fields);
const cacheStatusMetrics = [
    { key: "entryCount", labelKey: "runtimeCacheActiveEntries" },
    { key: "localHits", labelKey: "runtimeCacheLocalMatches" },
    { key: "created", labelKey: "runtimeCacheCreated" },
    { key: "createFailed", labelKey: "runtimeCacheCreateFailed" },
    { key: "fallbacks", labelKey: "runtimeCacheFallbacks" },
    { key: "renewals", labelKey: "runtimeCacheRenewals" },
];
const runtimeEditableFields = [...runtimeFields, ...runtimeOptionFields];
const runtimeDraft = reactive({});
const runtimeConfig = reactive({
    busy: "",
    configPath: "",
    defaults: {},
    effective: {},
    error: "",
    externalChangeKey: "",
    loaded: false,
    notice: "",
    revision: 0,
    startup: {},
});
let runtimePollPromise = null;
const runtimeDirtyKeys = computed(() =>
    runtimeConfig.loaded
        ? runtimeEditableFields
              .filter(field =>
                  field.min !== undefined
                      ? String(runtimeDraft[field.key]) !== String(runtimeConfig.effective[field.key])
                      : runtimeDraft[field.key] !== runtimeConfig.effective[field.key]
              )
              .map(field => field.key)
        : []
);
const runtimeFieldErrors = computed(() => {
    if (!runtimeConfig.loaded) return {};
    const errors = {};
    for (const field of runtimeFields) {
        const raw = String(runtimeDraft[field.key] ?? "").trim();
        const value = Number(raw);
        if (!raw || !Number.isSafeInteger(value) || value < field.min || value > field.max) {
            errors[field.key] = t("runtimeInvalidRange", { max: field.max, min: field.min });
        }
    }
    return errors;
});
const runtimeCanSave = computed(
    () =>
        runtimeConfig.loaded &&
        !runtimeConfig.busy &&
        runtimeDirtyKeys.value.length > 0 &&
        !Object.keys(runtimeFieldErrors.value).length
);
const formatRuntimeValue = (field, value) => {
    if (value === undefined || value === null) return "—";
    if (value === 0 && field.key === "maxContexts") return t("runtimeUnlimited");
    if (value === 0 && ["failureThreshold", "switchOnUses"].includes(field.key)) return t("runtimeDisabled");
    return field.unitKey ? `${value} ${t(field.unitKey)}` : String(value);
};
const formatRuntimeOption = (field, value) => {
    if (value === undefined || value === null) return "—";
    if (field.type === "boolean") return value ? t("enabled") : t("disabled");
    if (field.type === "streaming") return t(value);
    if (field.type === "logLevel") return t(value === "DEBUG" ? "debug" : "normal");
    if (field.type === "safety") return t(`safetySettingsThreshold.${value}`);
    return String(value);
};
const applyRuntimeSnapshot = (snapshot, { preserveDraft = false } = {}) => {
    if (!snapshot?.effective || !snapshot?.defaults) {
        throw new Error(t("runtimeInvalidResponse"));
    }
    const dirtyKeys = preserveDraft ? new Set(runtimeDirtyKeys.value) : new Set();
    const changed =
        runtimeConfig.loaded &&
        (runtimeConfig.revision !== snapshot.revision ||
            runtimeEditableFields.some(field => runtimeConfig.effective[field.key] !== snapshot.effective[field.key]));
    runtimeConfig.effective = snapshot.effective;
    runtimeConfig.defaults = snapshot.defaults;
    runtimeConfig.configPath = snapshot.configPath || "";
    runtimeConfig.revision = snapshot.revision ?? 0;
    runtimeConfig.startup = snapshot.startup || {};
    for (const field of runtimeFields) {
        if (!dirtyKeys.has(field.key)) runtimeDraft[field.key] = String(snapshot.effective[field.key]);
    }
    for (const field of runtimeOptionFields) {
        if (!dirtyKeys.has(field.key)) runtimeDraft[field.key] = snapshot.effective[field.key];
    }
    state.maxContexts = snapshot.effective.maxContexts;
    state.maxRetries = snapshot.effective.maxRetries;
    runtimeConfig.loaded = true;
    return { changed, hadDirtyDraft: dirtyKeys.size > 0 };
};
const readRuntimeResponse = async response => {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
        window.location.href = "/login";
        throw new Error(t("runtimeSessionExpired"));
    }
    if (!response.ok) {
        throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
    }
    return payload;
};
const pollRuntimeConfig = async () => {
    if (!isActive || activeTab.value !== "settings" || runtimeConfig.busy || runtimePollPromise) return;
    runtimePollPromise = (async () => {
        try {
            const response = await fetch("/api/settings/runtime", {
                cache: "no-store",
                headers: { Accept: "application/json" },
            });
            const snapshot = await readRuntimeResponse(response);
            if (!isActive) return;
            const { changed, hadDirtyDraft } = applyRuntimeSnapshot(snapshot, { preserveDraft: true });
            runtimeConfig.error = "";
            if (changed) {
                runtimeConfig.notice = "";
                runtimeConfig.externalChangeKey = hadDirtyDraft
                    ? "runtimeExternalChangedDraft"
                    : "runtimeExternalChanged";
            }
        } catch (error) {
            if (isActive) runtimeConfig.error = t("runtimeLoadFailed", { error: error.message || error });
        } finally {
            runtimePollPromise = null;
        }
    })();
    await runtimePollPromise;
};
const loadRuntimeConfig = async () => {
    if (runtimeConfig.busy) return;
    runtimeConfig.busy = "loading";
    runtimeConfig.error = "";
    runtimeConfig.notice = "";
    try {
        if (runtimePollPromise) await runtimePollPromise;
        const response = await fetch("/api/settings/runtime", {
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        applyRuntimeSnapshot(await readRuntimeResponse(response));
        runtimeConfig.externalChangeKey = "";
    } catch (error) {
        runtimeConfig.error = t("runtimeLoadFailed", { error: error.message || error });
    } finally {
        runtimeConfig.busy = "";
    }
};
const refreshRuntimeConfig = async () => {
    if (runtimeDirtyKeys.value.length) {
        try {
            await ElMessageBox.confirm(t("runtimeDiscardConfirm"), t("runtimeRefresh"), {
                cancelButtonText: t("cancel"),
                confirmButtonText: t("ok"),
                lockScroll: false,
                type: "warning",
            });
        } catch {
            return;
        }
    }
    await loadRuntimeConfig();
};
const saveRuntimeConfig = async () => {
    if (!runtimeCanSave.value) return;
    runtimeConfig.busy = "saving";
    runtimeConfig.error = "";
    runtimeConfig.notice = "";
    try {
        if (runtimePollPromise) await runtimePollPromise;
        const numericKeys = new Set(runtimeFields.map(field => field.key));
        const changes = Object.fromEntries(
            runtimeDirtyKeys.value.map(key => [
                key,
                numericKeys.has(key) ? Number(runtimeDraft[key]) : runtimeDraft[key],
            ])
        );
        if (!Object.keys(changes).length) return;
        const capacityChanged = Object.hasOwn(changes, "maxContexts");
        const response = await fetch("/api/settings/runtime", {
            body: JSON.stringify(changes),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "PUT",
        });
        applyRuntimeSnapshot(await readRuntimeResponse(response));
        runtimeConfig.externalChangeKey = "";
        runtimeConfig.notice = t(capacityChanged ? "consoleCapacitySaved" : "runtimeSaveSuccess");
        ElMessage.success(runtimeConfig.notice);
        updateContent();
    } catch (error) {
        runtimeConfig.error = t("runtimeSaveFailed", { error: error.message || error });
        ElMessage.error(runtimeConfig.error);
    } finally {
        runtimeConfig.busy = "";
    }
};
const resetRuntimeConfig = async () => {
    if (runtimeConfig.busy || !runtimeConfig.loaded) return;
    try {
        await ElMessageBox.confirm(t("runtimeResetConfirm"), t("runtimeResetInitial"), {
            cancelButtonText: t("cancel"),
            confirmButtonText: t("ok"),
            lockScroll: false,
            type: "warning",
        });
    } catch {
        return;
    }
    runtimeConfig.busy = "resetting";
    runtimeConfig.error = "";
    runtimeConfig.notice = "";
    try {
        if (runtimePollPromise) await runtimePollPromise;
        const response = await fetch("/api/settings/runtime", {
            headers: { Accept: "application/json" },
            method: "DELETE",
        });
        applyRuntimeSnapshot(await readRuntimeResponse(response));
        runtimeConfig.externalChangeKey = "";
        runtimeConfig.notice = t("runtimeResetSuccess");
        ElMessage.success(runtimeConfig.notice);
        updateContent();
    } catch (error) {
        runtimeConfig.error = t("runtimeResetFailed", { error: error.message || error });
        ElMessage.error(runtimeConfig.error);
    } finally {
        runtimeConfig.busy = "";
    }
};

const safetySettingsThresholdOptions = [
    { label: "safetySettingsThreshold.OFF", value: "OFF" },
    {
        label: "safetySettingsThreshold.HARM_BLOCK_THRESHOLD_UNSPECIFIED",
        value: "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
    },
    { label: "safetySettingsThreshold.BLOCK_LOW_AND_ABOVE", value: "BLOCK_LOW_AND_ABOVE" },
    { label: "safetySettingsThreshold.BLOCK_MEDIUM_AND_ABOVE", value: "BLOCK_MEDIUM_AND_ABOVE" },
    { label: "safetySettingsThreshold.BLOCK_ONLY_HIGH", value: "BLOCK_ONLY_HIGH" },
    { label: "safetySettingsThreshold.BLOCK_NONE", value: "BLOCK_NONE" },
];

const isBusy = computed(() => state.isSwitchingAccount || state.isSystemBusy);

// Clear selection
const clearSelection = () => {
    state.selectedAccounts.clear();
};

// Batch delete accounts
const batchDeleteAccounts = async () => {
    if (state.selectedAccounts.size === 0) {
        ElMessage.warning(t("noAccountSelected"));
        return;
    }

    const indices = Array.from(state.selectedAccounts);
    const count = indices.length;

    // Helper to perform batch delete
    const performBatchDelete = async (forceDelete = false) => {
        const notification = ElNotification({
            duration: 0,
            message: t("operationInProgress"),
            title: t("warningTitle"),
            type: "warning",
        });
        state.isSwitchingAccount = true;
        let shouldUpdate = true;
        try {
            const res = await fetch("/api/accounts/batch", {
                body: JSON.stringify({ force: forceDelete, indices }),
                headers: { "Content-Type": "application/json" },
                method: "DELETE",
            });
            const data = await res.json();

            if (res.status === 409 && data.requiresConfirmation) {
                shouldUpdate = false;
                state.isSwitchingAccount = false;
                ElMessageBox.confirm(t("warningDeleteCurrentAccount"), t("warningTitle"), {
                    cancelButtonText: t("cancel"),
                    confirmButtonText: t("ok"),
                    lockScroll: false,
                    type: "error",
                })
                    .then(() => performBatchDelete(true))
                    .catch(e => {
                        if (e !== "cancel") {
                            console.error(e);
                        }
                    });
                return;
            }

            if (res.status === 207) {
                // Handle partial success (Multi-Status) first, as res.ok is true for 2xx
                ElMessage.warning(
                    t("batchDeletePartial", {
                        failedCount: data.failedIndices?.length || 0,
                        successCount: data.successCount,
                    })
                );
                // Remove deleted items from selection
                data.successIndices?.forEach(idx => state.selectedAccounts.delete(idx));
            } else if (res.ok) {
                // Handle full success (200 OK)
                ElMessage.success(t("batchDeleteSuccess", { count: data.successCount }));
                clearSelection();
            } else {
                ElMessage.error(t(data.message, data));
            }
        } catch (err) {
            ElMessage.error(t("batchDeleteFailed", { error: err.message || err }));
        } finally {
            notification.close();
            if (shouldUpdate) {
                state.isSwitchingAccount = false;
                updateContent();
            }
        }
    };

    ElMessageBox.confirm(t("confirmBatchDelete", { count }), t("warningTitle"), {
        cancelButtonText: t("cancel"),
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "warning",
    })
        .then(() => performBatchDelete(false))
        .catch(e => {
            if (e !== "cancel") {
                console.error(e);
            }
        });
};

// Batch download accounts as ZIP
const batchDownloadAccounts = async () => {
    if (state.selectedAccounts.size === 0) {
        ElMessage.warning(t("noAccountSelected"));
        return;
    }

    const indices = Array.from(state.selectedAccounts);

    try {
        const res = await fetch("/api/accounts/batch/download", {
            body: JSON.stringify({ indices }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });

        if (!res.ok) {
            let errorKey = "batchDownloadFailed";
            let errorParams = { error: res.statusText || `HTTP ${res.status}` };

            try {
                const contentType = res.headers.get("content-type");
                if (contentType && contentType.includes("application/json")) {
                    const data = await res.json();
                    if (data.message) {
                        errorKey = data.message;
                        errorParams = data;
                    } else if (data.error) {
                        const errorDetail = typeof data.error === "string" ? data.error : data.error.message;
                        errorParams = { error: errorDetail };
                    }
                } else {
                    errorParams = { error: `HTTP Error ${res.status}: ${res.statusText}` };
                }
            } catch (e) {
                // Parsing failed, keep default errorParams
            }
            ElMessage.error(t(errorKey, errorParams));
            return;
        }

        // Get the blob and trigger download
        const blob = await res.blob();
        const contentDisposition = res.headers.get("Content-Disposition");
        let filename = "auth_batch.zip";
        if (contentDisposition) {
            const match = contentDisposition.match(/filename="?([^"]+)"?/);
            if (match) {
                filename = match[1];
            }
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Use actual file count from response header, fallback to indices length
        const actualCount = parseInt(res.headers.get("X-File-Count"), 10);
        const requestCount = indices.length;
        const failedCount = requestCount - (isNaN(actualCount) ? requestCount : actualCount);

        if (!isNaN(actualCount) && failedCount > 0) {
            ElMessage.warning(
                t("batchDownloadPartial", {
                    failedCount,
                    successCount: actualCount,
                })
            );
        } else {
            ElMessage.success(t("batchDownloadSuccess", { count: !isNaN(actualCount) ? actualCount : requestCount }));
        }
    } catch (err) {
        ElMessage.error(t("batchDownloadFailed", { error: err.message || err }));
    }
};

const handleAccountBatchDelete = indices => {
    state.selectedAccounts = new Set(indices);
    return batchDeleteAccounts();
};

const handleAccountBatchDownload = indices => {
    state.selectedAccounts = new Set(indices);
    return batchDownloadAccounts();
};

// App version from build-time injection
const appVersion = computed(() => {
    const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
    // Add 'v' prefix only if version starts with a number (e.g. 1.0.0 -> v1.0.0)
    if (/^\d/.test(version)) {
        return `v${version}`;
    }
    // Capitalize 'preview'
    if (version.startsWith("preview")) {
        return version.charAt(0).toUpperCase() + version.slice(1);
    }
    // Keep raw string for others (e.g. main, dev)
    return version;
});

const latestVersionFormatted = computed(() => {
    const v = state.latestVersion || (typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev");
    if (/^\d/.test(v)) {
        return `v${v}`;
    }
    return v;
});

// Get display name for account with i18n support
const getAccountDisplayName = account => {
    if (account.isInvalid) {
        return t("jsonFormatError");
    }
    const name = account.name || t("unnamedAccount");
    if (account.isDuplicate && account.canonicalIndex !== null && account.canonicalIndex !== undefined) {
        return `${name} (${t("duplicateAuthHint", { index: account.canonicalIndex })})`;
    }
    return name;
};

const addUser = () => {
    router.push("/auth");
};

// Delete account by index
const deleteAccountByIndex = async targetIndex => {
    if (targetIndex === null || targetIndex === undefined) {
        ElMessage.warning(t("noAccountSelected"));
        return;
    }

    const targetAccount = state.accountDetails.find(acc => acc.index === targetIndex);
    const accountSuffix = targetAccount ? ` (${getAccountDisplayName(targetAccount)})` : "";

    // Helper function to perform the actual deletion
    const performDelete = async (forceDelete = false) => {
        const notification = ElNotification({
            duration: 0,
            message: t("operationInProgress"),
            title: t("warningTitle"),
            type: "warning",
        });
        state.isSwitchingAccount = true;
        let shouldUpdate = true;
        try {
            const url = forceDelete ? `/api/accounts/${targetIndex}?force=true` : `/api/accounts/${targetIndex}`;
            const res = await fetch(url, {
                method: "DELETE",
            });
            const data = await res.json();

            if (res.status === 409 && data.requiresConfirmation) {
                shouldUpdate = false;
                state.isSwitchingAccount = false;
                ElMessageBox.confirm(t("warningDeleteCurrentAccount"), t("warningTitle"), {
                    cancelButtonText: t("cancel"),
                    confirmButtonText: t("ok"),
                    lockScroll: false,
                    type: "error",
                })
                    .then(() => performDelete(true))
                    .catch(e => {
                        if (e !== "cancel") {
                            console.error(e);
                        }
                    });
                return;
            }

            const message = t(data.message, data);
            if (res.ok) {
                ElMessage.success(message);
            } else {
                ElMessage.error(message);
            }
        } catch (err) {
            ElMessage.error(t("deleteFailed", { message: err.message || err }));
        } finally {
            notification.close();
            if (shouldUpdate) {
                state.isSwitchingAccount = false;
                updateContent();
            }
        }
    };

    ElMessageBox.confirm(`${t("confirmDelete")} #${targetIndex}${accountSuffix}?`, t("warningTitle"), {
        cancelButtonText: t("cancel"),
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "warning",
    })
        .then(() => performDelete(false))
        .catch(e => {
            if (e !== "cancel") {
                console.error(e);
            }
        });
};

const deduplicateAuth = () => {
    ElMessageBox.confirm(t("accountDedupConfirm"), t("warningTitle"), {
        cancelButtonText: t("cancel"),
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "warning",
    })
        .then(async () => {
            const notification = ElNotification({
                duration: 0,
                message: t("operationInProgress"),
                title: t("warningTitle"),
                type: "warning",
            });
            state.isSwitchingAccount = true;
            try {
                const res = await fetch("/api/accounts/deduplicate", { method: "POST" });
                const data = await res.json();

                const removedIndicesText = Array.isArray(data.removedIndices)
                    ? `[${data.removedIndices.join(", ")}]`
                    : "[]";
                const failedText = Array.isArray(data.failed) ? JSON.stringify(data.failed) : "";

                const message = t(data.message, {
                    ...data,
                    failed: failedText,
                    removedIndices: removedIndicesText,
                });

                if (res.ok) {
                    ElMessage.success(message);
                } else {
                    ElMessage.error(message);
                }
            } catch (err) {
                ElMessage.error(t("accountDedupFailed", { error: err.message || err }));
            } finally {
                state.isSwitchingAccount = false;
                notification.close();
                updateContent();
            }
        })
        .catch(e => {
            if (e !== "cancel") {
                console.error(e);
            }
        });
};

const handleLogMaxCountChange = val => {
    if (!val) return;
    fetch("/api/settings/log-max-count", {
        body: JSON.stringify({ count: val }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
    })
        .then(res => res.json())
        .then(data => {
            if (data.message === "settingUpdateSuccess") {
                ElMessage.success(t(data.message, { setting: t("logMaxCount"), value: val }));
                updateContent();
            } else {
                ElMessage.error(t(data.message || "settingFailed", { message: data.error || "" }));
            }
        })
        .catch(err => {
            ElMessage.error(t("settingFailed", { message: err.message || err }));
        });
};

const handleLanguageChange = lang => {
    I18n.setLang(lang);
    state.currentLang = lang;
    langVersion.value++;
    localStorage.setItem("language", lang);
};

const handleLogout = () => {
    ElMessageBox.confirm(t("logoutConfirm"), {
        cancelButtonText: t("cancel"),
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "warning",
    })
        .then(() => {
            fetch("/logout", {
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
                .then(res => res.json())
                .then(data => {
                    const message = t(data.message);
                    if (data.message === "logoutSuccess") {
                        ElMessage.success(message);
                        setTimeout(() => {
                            window.location.href = "/login";
                        }, 500);
                    } else {
                        ElMessage.error(message);
                    }
                })
                .catch(err => {
                    console.error("Logout error:", err);
                    ElMessage.error(t("logoutError"));
                });
        })
        .catch(() => {});
};

const updateAccountHealth = async account => {
    const mode = account.health?.mode || "active";
    const action = mode === "disabled" ? "enable" : mode === "active" ? "disable" : "reset";
    state.isSwitchingAccount = true;
    try {
        const res = await fetch(`/api/accounts/${account.index}/health`, {
            body: JSON.stringify({ action }),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
        ElMessage.success(t("healthUpdated"));
        await updateContent();
    } catch (error) {
        ElMessage.error(t("healthUpdateFailed", { message: error.message || error }));
    } finally {
        state.isSwitchingAccount = false;
    }
};

// Switch account by index
const switchAccountByIndex = targetIndex => {
    if (state.currentAuthIndex === targetIndex) {
        ElMessage.warning(t("alreadyCurrentAccount"));
        return;
    }

    const targetAccount = state.accountDetails.find(acc => acc.index === targetIndex);
    const accountSuffix = targetAccount ? ` (${getAccountDisplayName(targetAccount)})` : "";

    ElMessageBox.confirm(`${t("confirmSwitch")} #${targetIndex}${accountSuffix}?`, {
        cancelButtonText: t("cancel"),
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "warning",
    })
        .then(async () => {
            const notification = ElNotification({
                duration: 0,
                message: t("switchingAccountNotice"),
                title: t("warningTitle"),
                type: "warning",
            });
            state.isSwitchingAccount = true;
            try {
                const res = await fetch("/api/accounts/current", {
                    body: JSON.stringify({ targetIndex }),
                    headers: { "Content-Type": "application/json" },
                    method: "PUT",
                });
                const data = await res.json();
                const message = t(data.message, data);
                if (res.ok) {
                    ElMessage.success(message);
                } else {
                    ElMessage.error(message);
                }
            } catch (err) {
                ElMessage.error(t("settingFailed", { message: err.message || err }));
            } finally {
                state.isSwitchingAccount = false;
                notification.close();
                updateContent();
            }
        })
        .catch(e => {
            if (e !== "cancel") {
                console.error(e);
            }
        });
};

const updateStatus = data => {
    state.serviceConnected = true;

    const isEnabled = val => {
        if (val === true) return true;
        if (val === 1) return true;
        if (String(val).toLowerCase() === "true") return true;
        return false;
    };

    state.isUpdating = true;
    state.checkUpdateEnabled = isEnabled(data.status.checkUpdate);
    state.streamingModeReal = data.status.streamingMode === "real";
    state.enableAuthUpdateEnabled = isEnabled(data.status.enableAuthUpdate);
    state.forceThinkingEnabled = isEnabled(data.status.forceThinking);
    state.forceCodeExecutionEnabled = isEnabled(data.status.forceCodeExecution);
    state.forceWebSearchEnabled = isEnabled(data.status.forceWebSearch);
    state.forceUrlContextEnabled = isEnabled(data.status.forceUrlContext);
    state.debugModeEnabled = isEnabled(data.status.debugMode);
    state.currentAuthIndex = data.status.currentAuthIndex;
    state.accountDetails = data.status.accountDetails || [];
    state.activeContextsCount = data.status.activeContextsCount || 0;
    state.cacheStats = data.status.cacheStats || null;
    state.maxContexts = data.status.maxContexts ?? 1;
    state.maxRetries = data.status.maxRetries ?? 3;
    state.safetySettingsThreshold = data.status.safetySettingsThreshold || "OFF";

    const validIndices = new Set(state.accountDetails.map(acc => acc.index));
    for (const idx of state.selectedAccounts) {
        if (!validIndices.has(idx)) {
            state.selectedAccounts.delete(idx);
        }
    }
    state.browserConnected = data.status.browserConnected;
    state.apiKeySource = data.status.apiKeySource;
    state.usageCount = data.status.usageCount;
    state.failureCount = data.status.failureCount;
    state.logCount = data.logCount || 0;
    state.logMaxCount = data.status.logMaxCount || 100;
    state.logs = data.logs || "";
    state.isSystemBusy = data.status.isSystemBusy;

    nextTick(() => {
        state.isUpdating = false;
    });
};

let updateTimer = null;
let isActive = true;

const updateContent = async () => {
    const dot = document.querySelector(".dot");
    try {
        const res = await fetch("/api/status");
        if (res.redirected) {
            window.location.href = res.url;
            return;
        }
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
        }
        const data = await res.json();

        if (dot) {
            if (state.serviceConnected) dot.classList.add("status-running");
            else dot.classList.remove("status-running");
        }
        updateStatus(data);
    } catch (err) {
        console.error("Error fetching status:", err.message || err);
        state.serviceConnected = false;
    }
};

const triggerFileUpload = () => {
    if (fileInput.value) {
        fileInput.value.click();
    }
};

const handleFileUpload = async event => {
    const files = Array.from(event.target.files);
    if (!files.length) return;

    // Reset input so same files can be selected again
    event.target.value = "";

    // Show notification immediately
    const notification = ElNotification({
        duration: 0,
        message: t("operationInProgress"),
        title: t("warningTitle"),
        type: "warning",
    });

    // Set busy flag to disable UI during upload and rebalance
    state.isSwitchingAccount = true;

    try {
        // Helper function to read file as ArrayBuffer (for zip)
        const readFileAsArrayBuffer = file =>
            new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.onerror = () => reject(new Error(t("fileReadFailed")));
                reader.readAsArrayBuffer(file);
            });

        // Helper function to read file as text (for json)
        const readFileAsText = file =>
            new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve({ content: e.target.result, name: file.name });
                reader.onerror = () => reject(new Error(t("fileReadFailed")));
                reader.readAsText(file);
            });

        // Helper function to upload a single file
        const uploadFile = async fileData => {
            let parsed;
            try {
                parsed = JSON.parse(fileData.content);
            } catch (err) {
                return { error: t("invalidJson"), filename: fileData.name, success: false };
            }

            try {
                const res = await fetch("/api/files", {
                    body: JSON.stringify({ content: parsed }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                });

                if (res.ok) {
                    const data = await res.json();
                    return { filename: data.filename || fileData.name, success: true };
                }

                let errorMsg;
                try {
                    const data = await res.json();
                    errorMsg = getApiErrorMessage(data);
                } catch (e) {
                    // Response is not JSON or cannot be parsed, fallback to status text or unknown error
                    if (res.statusText) {
                        errorMsg = `HTTP Error ${res.status}: ${res.statusText}`;
                    } else {
                        errorMsg = `HTTP Error ${res.status}`;
                    }
                }
                return { error: errorMsg, filename: fileData.name, success: false };
            } catch (err) {
                // Network or other fetch errors
                return { error: err.message || t("networkError"), filename: fileData.name, success: false };
            }
        };

        // Collect all JSON files to upload (including extracted from zip)
        const jsonFilesToUpload = [];
        const extractErrors = [];

        for (const file of files) {
            const lowerName = file.name.toLowerCase();

            if (lowerName.endsWith(".zip")) {
                // Extract JSON files from zip
                try {
                    let arrayBuffer;
                    try {
                        arrayBuffer = await readFileAsArrayBuffer(file);
                    } catch (readErr) {
                        extractErrors.push({ local: file.name, reason: readErr.message || t("fileReadFailed") });
                        continue; // Skip zip processing if read failed
                    }

                    const zip = await JSZip.loadAsync(arrayBuffer);
                    const zipEntries = Object.keys(zip.files);

                    let foundJsonInZip = false;
                    for (const entryName of zipEntries) {
                        const entry = zip.files[entryName];
                        // Skip directories and non-json files
                        if (entry.dir || !entryName.toLowerCase().endsWith(".json")) continue;

                        foundJsonInZip = true;
                        try {
                            const content = await entry.async("string");
                            // Use format: zipName/entryName for display
                            const displayName = `${file.name}/${entryName}`;
                            jsonFilesToUpload.push({ content, name: displayName });
                        } catch (err) {
                            extractErrors.push({
                                local: `${file.name}/${entryName}`,
                                reason: t("zipExtractFailed"), // Prefer localized generic error for extraction issues
                            });
                        }
                    }

                    if (!foundJsonInZip) {
                        extractErrors.push({ local: file.name, reason: t("zipNoJsonFiles") });
                    }
                } catch (err) {
                    // Catch any other errors during zip processing (e.g. invalid zip format)
                    extractErrors.push({ local: file.name, reason: t("zipExtractFailed") });
                }
            } else if (lowerName.endsWith(".json")) {
                // Regular JSON file
                try {
                    const fileData = await readFileAsText(file);
                    jsonFilesToUpload.push(fileData);
                } catch (err) {
                    extractErrors.push({ local: file.name, reason: err.message || t("fileReadFailed") });
                }
            }
        }

        // Check if we have anything to process
        if (jsonFilesToUpload.length === 0 && extractErrors.length === 0) {
            ElMessage.warning(t("noSupportedFiles"));
            return;
        }

        // Upload all collected JSON files
        const successFiles = [];
        const failedFiles = [...extractErrors];

        // Use batch upload API if multiple files, otherwise use single file upload
        if (jsonFilesToUpload.length > 1) {
            // Batch upload
            const parsedFiles = [];
            const parseErrors = [];

            // Parse all files first
            for (const fileData of jsonFilesToUpload) {
                try {
                    const parsed = JSON.parse(fileData.content);
                    parsedFiles.push({ content: parsed, name: fileData.name });
                } catch (err) {
                    parseErrors.push({ local: fileData.name, reason: t("invalidJson") });
                }
            }

            failedFiles.push(...parseErrors);

            // Upload all valid files in one batch
            if (parsedFiles.length > 0) {
                try {
                    const res = await fetch("/api/files/batch", {
                        body: JSON.stringify({ files: parsedFiles.map(f => f.content) }),
                        headers: { "Content-Type": "application/json" },
                        method: "POST",
                    });

                    if (res.ok || res.status === 207) {
                        const data = await res.json();
                        // Process results array with proper index mapping
                        if (data.results && Array.isArray(data.results)) {
                            for (const result of data.results) {
                                const originalFile = parsedFiles[result.index];
                                if (result.success) {
                                    successFiles.push({
                                        local: originalFile?.name || `file-${result.index}`,
                                        saved: result.filename || originalFile?.name || `file-${result.index}`,
                                    });
                                } else {
                                    failedFiles.push({
                                        local: originalFile?.name || `file-${result.index}`,
                                        reason: result.error || t("unknownError"),
                                    });
                                }
                            }
                        }
                    } else {
                        // Batch upload failed completely
                        let errorMsg;
                        try {
                            const data = await res.json();
                            errorMsg = getApiErrorMessage(data);
                        } catch (e) {
                            if (res.statusText) {
                                errorMsg = `HTTP Error ${res.status}: ${res.statusText}`;
                            } else {
                                errorMsg = `HTTP Error ${res.status}`;
                            }
                        }
                        // Mark all parsed files as failed
                        for (const fileData of parsedFiles) {
                            failedFiles.push({ local: fileData.name, reason: errorMsg });
                        }
                    }
                } catch (error) {
                    // Network or other error - mark all parsed files as failed
                    // (parseErrors are already in failedFiles)
                    for (const fileData of parsedFiles) {
                        failedFiles.push({ local: fileData.name, reason: error.message || t("networkError") });
                    }
                }
            }
        } else {
            // Single file upload (use existing logic)
            for (const fileData of jsonFilesToUpload) {
                const result = await uploadFile(fileData);
                if (result.success) {
                    successFiles.push({ local: fileData.name, saved: result.filename });
                } else {
                    failedFiles.push({ local: fileData.name, reason: result.error });
                }
            }
        }

        // Build notification message with file details (scrollable container)
        let messageHtml = '<div style="max-height: 50vh; overflow-y: auto;">';

        if (successFiles.length > 0) {
            messageHtml += `<div style="margin-bottom: 8px;"><strong style="color: var(--el-color-success);">${t("fileUploadBatchSuccess")} (${successFiles.length}):</strong></div>`;
            messageHtml += '<ul style="margin: 0 0 12px 16px; padding: 0;">';
            for (const f of successFiles) {
                messageHtml += `<li style="word-break: break-all;">${escapeHtml(f.local)} → ${escapeHtml(f.saved)}</li>`;
            }
            messageHtml += "</ul>";
        }

        if (failedFiles.length > 0) {
            messageHtml += `<div style="margin-bottom: 8px;"><strong style="color: var(--el-color-danger);">${t("fileUploadBatchFailed")} (${failedFiles.length}):</strong></div>`;
            messageHtml += '<ul style="margin: 0 0 0 16px; padding: 0;">';
            for (const f of failedFiles) {
                messageHtml += `<li style="word-break: break-all;">${escapeHtml(f.local)}: ${escapeHtml(f.reason)}</li>`;
            }
            messageHtml += "</ul>";
        }

        messageHtml += "</div>";

        // Determine notification type
        let notifyType = "success";
        if (failedFiles.length > 0 && successFiles.length === 0) {
            notifyType = "error";
        } else if (failedFiles.length > 0) {
            notifyType = "warning";
        }

        // Build title with counts
        const totalProcessed = successFiles.length + failedFiles.length;
        let notifyTitle;
        if (totalProcessed === 1) {
            notifyTitle = t("fileUploadComplete");
        } else {
            notifyTitle = `${t("fileUploadBatchResult")} (✓${successFiles.length} ✗${failedFiles.length})`;
        }

        // Show result notification (keep open)
        ElNotification({
            dangerouslyUseHTMLString: true,
            duration: 0,
            message: messageHtml,
            position: "top-right",
            title: notifyTitle,
            type: notifyType,
        });

        updateContent();
    } finally {
        // Always close notification and reset busy flag
        notification.close();
        state.isSwitchingAccount = false;
    }
};

// Download account by index
const downloadAccountByIndex = accountIndex => {
    if (accountIndex === null || accountIndex === undefined) return;
    window.location.href = `/api/files/auth-${accountIndex}.json`;
};

const formatDownloadTimestamp = () => {
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, "0");
    const DD = String(now.getDate()).padStart(2, "0");
    const HH = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");

    return `${YYYY}-${MM}-${DD}_${HH}${mm}${ss}`;
};

const readFileAsText = file =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error(t("fileReadFailed")));
        reader.readAsText(file);
    });

const triggerUsageStatsImport = () => {
    if (isUsageStatsTransferBusy.value) return;

    ElMessageBox.confirm(t("usageStatsImportConfirm"), t("warningTitle"), {
        cancelButtonText: t("cancel"),
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "warning",
    })
        .then(() => usageStatsImportInput.value?.click())
        .catch(e => {
            if (e !== "cancel") {
                console.error(e);
            }
        });
};

const handleUsageStatsImport = async event => {
    const [file] = Array.from(event.target.files || []);
    event.target.value = "";
    if (!file) return;
    if (isUsageStatsTransferBusy.value) return;

    if (!file.name.toLowerCase().endsWith(".jsonl")) {
        ElMessage.error(t("usageStatsImportJsonlOnly"));
        return;
    }

    isImportingUsageStats.value = true;
    try {
        const content = await readFileAsText(file);
        const res = await fetch("/api/usage-stats/import", {
            body: JSON.stringify({ content, filename: file.name }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });

        if (res.redirected) {
            window.location.href = res.url;
            return;
        }
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showUsageStatsImportNotification({
                message: t(data.message || "usageStatsImportFailed", { error: data.error || `HTTP ${res.status}` }),
                title: t("usageStatsImportResult"),
                type: "error",
            });
            return;
        }

        showUsageStatsImportNotification({
            message: t("usageStatsImportSuccess", data),
            title: t("usageStatsImportResult"),
            type: "success",
        });
        await usageAnalyticsRef.value?.refreshAfterImport();
    } catch (error) {
        showUsageStatsImportNotification({
            message: t("usageStatsImportFailed", { error: error.message }),
            title: t("usageStatsImportResult"),
            type: "error",
        });
    } finally {
        isImportingUsageStats.value = false;
    }
};

const showUsageStatsImportNotification = ({ message, title, type }) => {
    ElNotification({
        dangerouslyUseHTMLString: true,
        duration: 0,
        message: `<div style="max-height: 50vh; overflow-y: auto; word-break: break-word;">${escapeHtml(message)}</div>`,
        position: "top-right",
        title,
        type,
    });
};

// Download persisted usage stats JSONL
const downloadUsageStats = async () => {
    if (isUsageStatsTransferBusy.value) return;
    isDownloadingUsageStats.value = true;

    try {
        const res = await fetch("/api/usage-stats/download?check=1");
        if (res.redirected) {
            window.location.href = res.url;
            return;
        }
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        if (!res.ok) {
            let message = "usageStatsDownloadFailed";
            try {
                const data = await res.json();
                message = data.message || message;
                ElMessage.error(t(message, { error: data.error || `HTTP ${res.status}` }));
                return;
            } catch {
                // Ignore non-JSON error responses.
            }
            ElMessage.error(t(message, { error: `HTTP ${res.status}` }));
            return;
        }

        const filename = `AIStudioToAPI_usage-stats_${formatDownloadTimestamp()}.jsonl`;
        const a = document.createElement("a");
        a.href = "/api/usage-stats/download";
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } catch (error) {
        ElMessage.error(t("usageStatsDownloadFailed", { error: error.message }));
    } finally {
        isDownloadingUsageStats.value = false;
    }
};

// Check for updates once on page load
const checkForUpdates = async () => {
    try {
        const res = await fetch("/api/version/check");
        if (res.ok) {
            const data = await res.json();
            state.hasUpdate = data.hasUpdate;
            state.latestVersion = data.latest;
            state.releaseUrl = data.releaseUrl;
        }
    } catch (err) {
        // Silently fail - version check is not critical
        console.warn("Failed to check for updates:", err.message);
    }
};

// Theme handling is now managed by useTheme composable

onMounted(() => {
    if (activeTab.value === "settings") loadRuntimeConfig();
    // Listen for language changes
    I18n.onChange(() => {
        langVersion.value++;
        if (state.logCount === 0) {
            state.logs = t("loading");
        }
    });

    Promise.allSettled([updateContent()]).then(scheduleUpdate);

    // Check for updates once on initial load
    checkForUpdates();
});

watch(
    () => route.query.view,
    value => {
        const view = viewFromQuery(value);
        if (activeTab.value === view) return;
        activeTab.value = view;
        if (view === "settings" && (!runtimeConfig.loaded || !runtimeDirtyKeys.value.length)) {
            loadRuntimeConfig();
        }
    }
);

onBeforeUnmount(() => {
    isActive = false;
    if (updateTimer) {
        clearTimeout(updateTimer);
    }
});

watchEffect(() => {
    const titles = {
        accounts: "consoleAccounts",
        home: "consoleDashboard",
        logs: "consoleLogs",
        settings: "consoleSettings",
        stats: "consoleAnalytics",
    };
    document.title = `${t(titles[activeTab.value])} · AIStudioToAPI`;
});
</script>

<style lang="less" scoped>
@import "../styles/variables.less";

.main-layout {
    display: flex;
    min-height: 100vh;
    background-color: @background-light;
}

.sidebar {
    width: 230px;
    background: @background-white;
    border-right: 1px solid @border-light;
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 22px 12px 16px;
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 100;
    overflow-y: auto;
}

.sidebar-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 0 10px;
    color: @text-primary;

    img {
        width: 34px;
        height: 34px;
        flex: none;
    }

    span {
        display: grid;
        min-width: 0;
        line-height: 1.3;
    }

    strong {
        font-size: 0.95rem;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    small {
        color: @text-secondary;
        font-size: 0.72rem;
    }
}

.sidebar-menu,
.sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
}

.sidebar-footer {
    margin-top: auto;
    border-top: 1px solid @border-light;
    padding-top: 12px;
}

.menu-item {
    width: 100%;
    min-height: 42px;
    padding: 8px 12px;
    border-radius: 9px;
    display: flex;
    align-items: center;
    gap: 12px;
    color: @text-secondary;
    cursor: pointer;
    border: none;
    background: transparent;
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    text-align: left;

    svg {
        width: 18px;
        height: 18px;
        flex: none;
    }

    &:hover {
        background-color: @background-light;
        color: @primary-color;
    }

    &.active {
        background-color: rgba(var(--color-primary-rgb), 0.11);
        color: @primary-color;
    }
}

.sidebar-tool {
    background: transparent;
    border: 0;
    border-radius: 8px;
    color: @text-secondary;
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
    min-height: 34px;
    padding: 7px 12px;
    text-align: left;
    width: 100%;

    &:hover {
        background: @background-light;
        color: @text-primary;
    }

    &.is-logout:hover {
        color: @error-color;
    }
}

.console-utility {
    display: none;
}

.visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    border: 0;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    overflow: hidden;
}

.content-area {
    flex: 1;
    margin-left: 230px;
    padding: 28px clamp(20px, 3vw, 44px) 48px;
    max-width: calc(100vw - 230px);
    min-width: 0;
}

.page-header {
    margin-bottom: 2rem;

    h1 {
        font-size: 1.5rem;
        font-weight: 600;
        color: @text-primary;
        display: flex;
        align-items: center;
        gap: 10px;
    }
}

.view-container {
    animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
    from {
        opacity: 0;
        transform: translateY(10px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

/* Common Card Styles */
.status-card {
    background: @background-white;
    border-radius: 16px;
    padding: 24px;
    box-shadow: @shadow-light;
    border: 1px solid @border-light;
    min-width: 0;
}

/* Settings View Specifics */
.runtime-config-card {
    margin-bottom: 24px;
}

.runtime-config-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 20px;

    h2 {
        color: @text-primary;
        font-size: 1.3rem;
        line-height: 1.3;
        margin: 4px 0 6px;
    }

    p {
        color: @text-secondary;
        font-size: 0.9rem;
        line-height: 1.5;
        margin: 0;
        max-width: 620px;
    }
}

.runtime-config-eyebrow {
    color: @primary-color;
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.runtime-config-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
}

.runtime-action-button {
    background: @background-white;
    border: 1px solid @border-color;
    border-radius: 9px;
    color: @text-primary;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    min-height: 36px;
    padding: 7px 12px;
    transition:
        border-color 0.2s,
        background-color 0.2s;

    &:hover:not(:disabled) {
        border-color: @primary-color;
        background: rgba(var(--color-primary-rgb), 0.07);
    }

    &:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }
}

.runtime-action-primary {
    background: @primary-color;
    border-color: @primary-color;
    color: @text-on-primary;

    &:hover:not(:disabled) {
        background: var(--color-primary-hover);
        border-color: var(--color-primary-hover);
    }
}

.runtime-action-danger:hover:not(:disabled) {
    background: rgba(var(--color-error-rgb), 0.08);
    border-color: @error-color;
    color: @error-color;
}

.runtime-config-notice {
    border-radius: 9px;
    font-size: 0.85rem;
    line-height: 1.45;
    margin-bottom: 16px;
    padding: 10px 12px;

    &.is-error {
        background: rgba(var(--color-error-rgb), 0.09);
        color: @error-color;
    }

    &.is-success {
        background: rgba(var(--color-success-rgb), 0.1);
        color: @success-color;
    }

    &.is-warning {
        background: rgba(var(--color-warning-rgb), 0.1);
        color: @warning-color;
    }
}

.runtime-config-meta {
    color: @text-secondary;
    display: flex;
    flex-wrap: wrap;
    font-size: 0.78rem;
    gap: 8px 18px;
    margin-bottom: 18px;

    .is-dirty {
        color: @warning-color;
        font-weight: 600;
    }
}

.runtime-config-path {
    overflow-wrap: anywhere;

    code {
        color: @text-primary;
    }
}

.runtime-config-empty {
    color: @text-secondary;
    padding: 26px 0;
    text-align: center;
}

.runtime-config-groups {
    display: grid;
    gap: 20px;
}

.runtime-config-group {
    border-top: 1px solid @border-light;
    padding-top: 18px;
}

.runtime-config-group-heading {
    margin-bottom: 14px;

    h3 {
        color: @text-primary;
        font-size: 0.95rem;
        margin: 0 0 4px;
    }

    p {
        color: @text-secondary;
        font-size: 0.8rem;
        line-height: 1.4;
        margin: 0;
    }
}

.cache-status {
    background: @background-light;
    border: 1px solid @border-light;
    border-radius: 11px;
    margin-bottom: 12px;
    padding: 12px 14px;
}

.cache-status-heading {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin-bottom: 10px;

    strong {
        color: @text-primary;
        font-size: 0.86rem;
    }

    small {
        color: @text-secondary;
        font-size: 0.72rem;
    }
}

.cache-status-metrics {
    display: grid;
    gap: 8px 16px;
    grid-template-columns: repeat(auto-fit, minmax(115px, 1fr));
    margin: 0;

    div {
        min-width: 0;
    }

    dt {
        color: @text-secondary;
        font-size: 0.72rem;
    }

    dd {
        color: @text-primary;
        font-size: 1rem;
        font-weight: 700;
        margin: 2px 0 0;
    }
}

.runtime-config-fields {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
}

.runtime-config-field {
    background: @background-light;
    border: 1px solid @border-light;
    border-radius: 12px;
    min-width: 0;
    padding: 15px;
}

.runtime-field-heading {
    align-items: flex-start;
    display: flex;
    gap: 8px;
    justify-content: space-between;

    label {
        color: @text-primary;
        font-size: 0.87rem;
        font-weight: 700;
        line-height: 1.4;
    }
}

.runtime-field-description {
    color: @text-secondary;
    font-size: 0.78rem;
    line-height: 1.45;
    margin: 8px 0 12px;
    min-height: 2.25em;
}

.runtime-field-key {
    color: @text-secondary;
    display: inline-block;
    font-size: 0.7rem;
    margin-top: 4px;
}

.runtime-field-input-row {
    align-items: center;
    display: flex;
    gap: 8px;

    input {
        background: @background-white;
        border: 1px solid @border-color;
        border-radius: 8px;
        color: @text-primary;
        font: inherit;
        font-size: 0.94rem;
        max-width: 160px;
        min-height: 38px;
        padding: 7px 10px;
        width: 100%;

        &:focus-visible {
            border-color: @primary-color;
            outline: 2px solid rgba(var(--color-primary-rgb), 0.18);
        }

        &[aria-invalid="true"] {
            border-color: @error-color;
        }
    }
}

.runtime-field-unit,
.runtime-field-footnote {
    color: @text-secondary;
    font-size: 0.74rem;
}

.runtime-field-footnote {
    line-height: 1.45;
    margin-top: 10px;

    strong {
        color: @text-primary;
    }
}

.runtime-field-separator {
    margin: 0 5px;
}

.runtime-field-error {
    color: @error-color;
}

.settings-page-header {
    margin-bottom: 20px;

    h1 {
        font-size: clamp(1.45rem, 2vw, 1.9rem);
        margin: 4px 0 5px;
    }

    p {
        color: @text-secondary;
        font-size: 0.9rem;
        margin: 0;
    }
}

.settings-eyebrow {
    color: @primary-color;
    font-size: 0.73rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
}

.runtime-option-fields {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
}

.runtime-option-field {
    align-items: center;
    background: @background-light;
    border: 1px solid @border-light;
    border-radius: 11px;
    display: grid;
    gap: 3px 10px;
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 12px 14px;

    label {
        color: @text-primary;
        font-size: 0.88rem;
        font-weight: 650;
    }

    code,
    small {
        color: @text-secondary;
        font-size: 0.72rem;
        grid-column: 1;
    }

    .runtime-option-control {
        grid-column: 2;
        grid-row: 1 / span 3;
        min-width: 58px;

        :deep(.el-select) {
            width: 140px;
            max-width: 100%;
        }
    }
}

.runtime-save-bar {
    align-items: center;
    background: @background-white;
    border-top: 1px solid @border-light;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
    margin: 20px -24px -24px;
    padding: 12px 24px;
    position: sticky;
    bottom: 0;
    z-index: 8;

    span {
        color: @warning-color;
        font-size: 0.82rem;
        font-weight: 700;
        margin-right: auto;
    }
}

.settings-secondary-grid {
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.settings-information-card {
    padding: 20px;
}

.settings-card-heading {
    border-bottom: 1px solid @border-light;
    margin-bottom: 14px;
    padding-bottom: 12px;

    h2 {
        color: @text-primary;
        font-size: 1rem;
        margin: 0 0 5px;
    }

    p {
        color: @text-secondary;
        font-size: 0.8rem;
        line-height: 1.5;
        margin: 0;
    }
}

.settings-facts {
    display: grid;
    gap: 0;
    margin: 0;

    div {
        align-items: baseline;
        border-bottom: 1px solid @border-light;
        display: flex;
        gap: 14px;
        justify-content: space-between;
        padding: 9px 0;
    }

    dt {
        color: @text-secondary;
        flex: none;
        font-size: 0.81rem;
    }

    dd {
        color: @text-primary;
        font-size: 0.84rem;
        margin: 0;
        overflow-wrap: anywhere;
        text-align: right;
    }
}

.settings-path {
    font-family: @font-family-mono;
    font-size: 0.72rem !important;
}

.settings-footnote,
.settings-muted {
    color: @text-secondary;
    font-size: 0.78rem;
    line-height: 1.5;
    margin: 12px 0 0;
}

.settings-inline-field {
    align-items: center;
    display: flex;
    gap: 12px;
    justify-content: space-between;
    margin-top: 12px;

    label {
        color: @text-primary;
        font-size: 0.87rem;
    }

    :deep(.el-select) {
        max-width: 55%;
        width: 160px;
    }
}

.settings-link {
    color: @primary-color;
    display: inline-block;
    font-size: 0.82rem;
    margin-top: 14px;
    text-decoration: none;

    &:hover {
        text-decoration: underline;
    }
}

@media (max-width: 1050px) {
    .settings-secondary-grid {
        grid-template-columns: 1fr;
    }
}

@media (max-width: 700px) {
    .runtime-config-header {
        flex-direction: column;
        gap: 16px;
    }

    .runtime-config-actions {
        justify-content: flex-start;
        width: 100%;
    }
}

/* Mobile Adaptation */
@media (max-width: 768px) {
    .runtime-save-bar {
        bottom: calc(68px + env(safe-area-inset-bottom, 0px));
    }

    .sidebar {
        width: 100%;
        height: calc(68px + env(safe-area-inset-bottom, 0px));
        bottom: 0;
        top: auto;
        flex-direction: row;
        border-right: none;
        border-top: 1px solid @border-light;
        padding: 3px 6px env(safe-area-inset-bottom, 0px);
        overflow: visible;
    }

    .sidebar-brand {
        display: none;
    }

    .sidebar-menu {
        flex-direction: row;
        width: 100%;
        align-items: stretch;
        gap: 1px;
    }

    .menu-item {
        flex: 1;
        flex-direction: column;
        justify-content: center;
        gap: 3px;
        min-width: 0;
        min-height: 60px;
        padding: 5px 1px;
        text-align: center;
        font-size: 0.67rem;
        line-height: 1.1;

        svg {
            width: 18px;
            height: 18px;
        }
    }

    .sidebar-footer {
        display: none;
    }

    .content-area {
        margin-left: 0;
        max-width: 100vw;
        padding: 16px 14px calc(88px + env(safe-area-inset-bottom, 0px));
    }

    .console-utility {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: space-between;
        margin-bottom: 16px;
        min-height: 36px;
        color: @text-primary;

        strong {
            font-size: 0.88rem;
        }

        div {
            display: flex;
            flex-wrap: wrap;
            gap: 3px;
        }

        button {
            background: transparent;
            border: 0;
            border-radius: 6px;
            color: @text-secondary;
            cursor: pointer;
            font: inherit;
            font-size: 0.72rem;
            padding: 6px;
        }

        button:hover {
            background: @background-white;
            color: @text-primary;
        }
    }
}
</style>
