<template>
    <section class="usage-analytics">
        <header class="usage-header">
            <div class="usage-heading">
                <p class="usage-eyebrow">{{ t("usageAnalyticsEyebrow") }}</p>
                <h1>{{ t("usageStats") }}</h1>
                <p class="usage-subtitle">{{ t("usageAnalyticsSubtitle") }}</p>
            </div>
            <div class="usage-header-actions">
                <span v-if="overview?.asOf" class="usage-updated">
                    {{ t("usageUpdatedAt") }} {{ formatTime(overview.asOf) }}
                </span>
                <div class="usage-action-row">
                    <button
                        type="button"
                        class="usage-button usage-button-subtle usage-auto-refresh"
                        :aria-pressed="autoRefresh"
                        :title="t('usageAutoRefresh')"
                        @click="toggleAutoRefresh"
                    >
                        <span
                            class="usage-auto-indicator"
                            :class="{ 'is-paused': !autoRefresh }"
                            aria-hidden="true"
                        ></span>
                        {{ autoRefresh ? t("usageAutoRefreshEvery30s") : t("usageAutoRefreshPaused") }}
                    </button>
                    <button type="button" class="usage-button" :disabled="refreshing" @click="refresh">
                        {{ refreshing ? t("loading") : t("usageRefresh") }}
                    </button>
                </div>
                <div class="usage-transfer-actions">
                    <button type="button" class="usage-text-button" :disabled="transferBusy" @click="emit('import')">
                        {{ t("importUsageStats") }}
                    </button>
                    <button type="button" class="usage-text-button" :disabled="transferBusy" @click="emit('export')">
                        {{ t("exportUsageStats") }}
                    </button>
                </div>
            </div>
        </header>

        <div class="usage-toolbar">
            <div class="usage-toolbar-top">
                <div class="usage-range" role="group" :aria-label="t('usageTimeRange')">
                    <button
                        v-for="option in rangeOptions"
                        :key="option.value"
                        type="button"
                        :class="{ 'is-active': range === option.value }"
                        :aria-pressed="range === option.value"
                        @click="setRange(option.value)"
                    >
                        {{ t(option.label) }}
                    </button>
                </div>
                <button v-if="hasActiveFilters" type="button" class="usage-reset" @click="resetFilters">
                    {{ t("resetFilters") }}
                </button>
            </div>
            <div v-if="range === 'custom' && isMobile" class="usage-mobile-dates">
                <label>
                    <span>{{ t("customTimeRangeStart") }}</span>
                    <input v-model="customStartInput" type="datetime-local" />
                </label>
                <label>
                    <span>{{ t("customTimeRangeEnd") }}</span>
                    <input v-model="customEndInput" type="datetime-local" :min="customStartInput || undefined" />
                </label>
            </div>
            <el-date-picker
                v-else-if="range === 'custom'"
                v-model="customDates"
                type="datetimerange"
                class="usage-custom-dates"
                popper-class="usage-date-popover"
                :start-placeholder="t('customTimeRangeStart')"
                :end-placeholder="t('customTimeRangeEnd')"
                :range-separator="'–'"
            />
            <div class="usage-filter-row">
                <input
                    v-model="searchText"
                    type="search"
                    maxlength="200"
                    class="usage-search"
                    :placeholder="t('usageSearchPlaceholder')"
                    :aria-label="t('usageSearchPlaceholder')"
                />
                <el-select
                    v-model="filters.model"
                    clearable
                    filterable
                    :placeholder="t('requestModel')"
                    class="usage-select"
                >
                    <el-option v-for="model in modelOptions" :key="model" :label="model" :value="model" />
                </el-select>
                <el-select
                    v-model="filters.accountKey"
                    clearable
                    filterable
                    :placeholder="t('usageFinalAccount')"
                    class="usage-select"
                >
                    <el-option
                        v-for="account in accountOptions"
                        :key="account.accountKey"
                        :label="formatAccount(account.finalAuthIndex, account.finalAccountName)"
                        :value="account.accountKey"
                    />
                </el-select>
                <el-select v-model="filters.outcome" clearable :placeholder="t('requestOutcome')" class="usage-select">
                    <el-option :label="t('success')" value="success" />
                    <el-option :label="t('failed')" value="error" />
                    <el-option :label="t('aborted')" value="aborted" />
                </el-select>
            </div>
            <details class="usage-more-filters" :open="advancedFiltersOpen || undefined">
                <summary @click.prevent="advancedFiltersOpen = !advancedFiltersOpen">
                    {{ t("usageMoreFilters") }}<span v-if="hasAdvancedFilters" class="usage-filter-dot">●</span>
                </summary>
                <div class="usage-filter-row usage-filter-row-secondary">
                    <el-select
                        v-model="filters.apiKeyId"
                        clearable
                        filterable
                        :placeholder="t('usageApiKey')"
                        class="usage-select"
                    >
                        <el-option
                            v-for="key in apiKeyOptions"
                            :key="key.apiKeyId"
                            :label="formatApiKey(key.apiKeyId)"
                            :value="key.apiKeyId"
                        />
                    </el-select>
                    <el-select
                        v-model="filters.requestCategory"
                        clearable
                        :placeholder="t('usageRequestCategory')"
                        class="usage-select"
                    >
                        <el-option
                            v-for="category in categoryOptions"
                            :key="category"
                            :label="category"
                            :value="category"
                        />
                    </el-select>
                    <el-select
                        v-model="filters.cacheState"
                        clearable
                        :placeholder="t('usageCacheState')"
                        class="usage-select"
                    >
                        <el-option :label="t('usageCacheHit')" value="hit" />
                        <el-option :label="t('usageCacheMiss')" value="miss" />
                        <el-option :label="t('usageCacheUnknown')" value="unknown" />
                    </el-select>
                    <label class="usage-duration-filter usage-status-filter">
                        <span>{{ t("usageStatusCode") }}</span>
                        <input
                            v-model="filters.statusCode"
                            type="number"
                            min="100"
                            max="599"
                            step="1"
                            inputmode="numeric"
                            :aria-label="t('usageStatusCode')"
                        />
                    </label>
                    <label class="usage-duration-filter">
                        <span>{{ t("usageMinDuration") }}</span>
                        <input v-model="filters.minDurationMs" type="number" min="0" step="1" inputmode="numeric" />
                    </label>
                    <label class="usage-duration-filter">
                        <span>{{ t("usageMaxDuration") }}</span>
                        <input v-model="filters.maxDurationMs" type="number" min="0" step="1" inputmode="numeric" />
                    </label>
                </div>
            </details>
        </div>

        <div v-if="overview" class="usage-summary" :aria-label="t('usageStats')">
            <div class="usage-kpis">
                <article class="usage-kpi">
                    <span>{{ t("usageRequests") }}</span>
                    <strong>{{ formatNumber(overview.summary?.totalRequests) }}</strong>
                    <small>{{ t("usageCurrentRange") }}</small>
                </article>
                <article class="usage-kpi">
                    <span>{{ t("successRate") }}</span>
                    <strong>{{ formatPercent(overview.summary?.successRate) }}</strong>
                    <small
                        >{{ formatNumber(overview.summary?.successCount) }} {{ t("success") }} ·
                        {{ formatNumber(overview.summary?.errorCount) }} {{ t("failed") }}</small
                    >
                </article>
                <article class="usage-kpi">
                    <span>{{ t("usageInputTokens") }}</span>
                    <strong>{{ formatTokenCount(overview.summary?.tokenUsage?.inputTokens) }}</strong>
                    <small>{{ tokenCoverageLabel(overview.summary, "inputTokens") }}</small>
                </article>
                <article class="usage-kpi">
                    <span>{{ t("usageOutputTokens") }}</span>
                    <strong>{{ formatTokenCount(overview.summary?.tokenUsage?.outputTokens) }}</strong>
                    <small>{{ tokenCoverageLabel(overview.summary, "outputTokens") }}</small>
                </article>
                <article class="usage-kpi usage-kpi-total">
                    <span>{{ t("usageTotalTokens") }}</span>
                    <strong>{{ formatTokenCount(overview.summary?.tokenUsage?.totalTokens) }}</strong>
                    <small>{{ tokenCoverageLabel(overview.summary) }}</small>
                </article>
            </div>
            <div class="usage-summary-meta">
                <span v-if="filters.accountKey">{{ t("usageSelectedAccountScope") }}</span>
                <span
                    >{{ t("usageCachedInputTokens") }}
                    {{ formatTokenCount(overview.summary?.tokenUsage?.cachedInputTokens) }}</span
                >
                <span>{{ t("usageCacheReadRate") }} {{ formatOptionalPercent(overview.summary?.cacheReadRate) }}</span>
                <span>{{ cacheCoverageLabel(overview.summary) }}</span>
            </div>
        </div>

        <nav class="usage-tabs" :aria-label="t('usageViews')">
            <button
                v-for="view in views"
                :key="view.value"
                type="button"
                :class="{ 'is-active': activeView === view.value }"
                :aria-current="activeView === view.value ? 'page' : undefined"
                @click="activeView = view.value"
            >
                {{ t(view.label) }}
                <span v-if="view.value === 'requests' && overview" class="usage-tab-count">{{
                    overview.summary?.totalRequests || 0
                }}</span>
            </button>
        </nav>

        <div v-if="range === 'custom' && !validCustomDates" class="usage-state">
            {{ invalidCustomOrder ? t("usageCustomRangeOrder") : t("usageChooseCustomDates") }}
        </div>
        <div v-else-if="!validStatusCodeFilter" class="usage-state">{{ t("usageInvalidStatusCode") }}</div>
        <div v-else-if="!validDurationFilter" class="usage-state">{{ t("usageInvalidDurationRange") }}</div>
        <div v-else-if="loading && !overview" class="usage-state" role="status">{{ t("loading") }}</div>
        <div v-else-if="error && !overview" class="usage-state usage-state-error" role="alert">
            <strong>{{ t("usageLoadFailed") }}</strong>
            <span>{{ error }}</span>
            <button type="button" class="usage-button" @click="refresh">{{ t("usageRetry") }}</button>
        </div>
        <template v-else-if="overview">
            <p v-if="error" class="usage-inline-error" role="alert">{{ t("usageRefreshFailed") }}：{{ error }}</p>
            <div v-if="activeView === 'overview'" class="usage-overview">
                <div class="usage-overview-grid">
                    <section class="usage-panel usage-trend-panel">
                        <div class="usage-panel-heading">
                            <div>
                                <h2>{{ t(trendMetric === "requests" ? "usageRequestTrend" : "usageTokenTrend") }}</h2>
                                <p>
                                    {{
                                        t(
                                            trendMetric !== "requests"
                                                ? "usageTokenTrendDescription"
                                                : "usageTrendDescription"
                                        )
                                    }}
                                </p>
                            </div>
                            <div class="usage-trend-toggle" :aria-label="t('usageTrendMetric')">
                                <button
                                    v-for="metric in trendMetrics"
                                    :key="metric.value"
                                    type="button"
                                    :class="{ 'is-active': trendMetric === metric.value }"
                                    @click="trendMetric = metric.value"
                                >
                                    {{ t(metric.label) }}
                                </button>
                            </div>
                        </div>
                        <div class="usage-trend-options">
                            <el-select
                                v-model="timezone"
                                filterable
                                :aria-label="t('usageTimeZone')"
                                class="usage-timezone-select"
                            >
                                <el-option v-for="zone in timeZoneOptions" :key="zone" :label="zone" :value="zone" />
                            </el-select>
                            <el-select
                                v-model="granularity"
                                :aria-label="t('usageGranularity')"
                                class="usage-granularity-select"
                            >
                                <el-option :label="t('usageGranularityAuto')" value="auto" />
                                <el-option :label="t('usageGranularityHour')" value="hour" />
                                <el-option :label="t('usageGranularityDay')" value="day" />
                            </el-select>
                        </div>
                        <div v-if="!hasTrendRequests" class="usage-panel-empty">{{ t("noRequestRecords") }}</div>
                        <div
                            v-else-if="
                                trendMetric !== 'requests' && !overview.summary?.tokenUsageCoverage?.[trendMetric]
                            "
                            class="usage-panel-empty"
                        >
                            {{ t("usageNoTokenData") }}
                        </div>
                        <template v-else>
                            <svg
                                class="usage-chart"
                                viewBox="0 0 720 200"
                                role="img"
                                :aria-label="t(trendMetric === 'requests' ? 'usageRequestTrend' : 'usageTokenTrend')"
                            >
                                <line x1="24" y1="168" x2="704" y2="168" class="usage-chart-axis" />
                                <line x1="24" y1="96" x2="704" y2="96" class="usage-chart-grid" />
                                <path :d="chartArea" class="usage-chart-area" />
                                <polyline :points="chartPoints" class="usage-chart-line" />
                                <circle
                                    v-for="point in chartDots"
                                    :key="point.start"
                                    :cx="point.x"
                                    :cy="point.y"
                                    r="4"
                                    class="usage-chart-dot"
                                >
                                    <title>
                                        {{ formatTime(point.start) }} · {{ formatNumber(point.value) }}
                                        {{ t(trendMetricLabel) }}
                                    </title>
                                </circle>
                            </svg>
                            <div class="usage-chart-labels">
                                <span>{{ formatChartTime(overview.trend?.[0]?.start) }}</span>
                                <span>{{
                                    formatChartTime(
                                        overview.trend?.[Math.floor((overview.trend?.length || 1) / 2)]?.start
                                    )
                                }}</span>
                                <span>{{ formatChartTime(overview.trend?.[overview.trend.length - 1]?.start) }}</span>
                            </div>
                        </template>
                    </section>
                    <section class="usage-panel usage-failures-panel">
                        <div class="usage-panel-heading">
                            <div>
                                <h2>{{ t("usageRecentFailures") }}</h2>
                                <p>{{ t("usageFailureHint") }}</p>
                            </div>
                            <button type="button" class="usage-link" @click="showFailedRequests">
                                {{ t("usageViewAll") }}
                            </button>
                        </div>
                        <div v-if="!overview.recentFailures?.length" class="usage-panel-empty">
                            {{ t("usageNoRecentFailures") }}
                        </div>
                        <button
                            v-for="record in overview.recentFailures || []"
                            :key="record.sequence"
                            type="button"
                            class="usage-failure-row"
                            @click="openRecord(record)"
                        >
                            <span class="usage-outcome is-error">{{ record.statusCode || t("failed") }}</span>
                            <span class="usage-failure-main">
                                <strong>{{ record.model || "–" }}</strong>
                                <small>{{ summarizeError(record.errorMessage) }}</small>
                            </span>
                            <time>{{ formatTime(record.startedAt) }}</time>
                        </button>
                    </section>
                </div>
            </div>

            <section v-else-if="activeView === 'accounts'" class="usage-panel">
                <div class="usage-panel-heading">
                    <div>
                        <h2>{{ t("usageAccountRanking") }}</h2>
                        <p>{{ t("usageFinalAccountHint") }}</p>
                    </div>
                    <span class="usage-count">{{ overview.accounts?.length || 0 }} {{ t("usageAccounts") }}</span>
                </div>
                <div v-if="!overview.accounts?.length" class="usage-panel-empty">{{ t("noUsageStats") }}</div>
                <div v-else class="usage-table-scroll usage-ranking-table-scroll">
                    <table class="usage-table">
                        <thead>
                            <tr>
                                <th>{{ t("usageFinalAccount") }}</th>
                                <th>{{ t("usageFinalHandledRequests") }}</th>
                                <th>{{ t("usageTouchedRequests") }}</th>
                                <th>{{ t("requestAttempts") }}</th>
                                <th>{{ t("success") }}</th>
                                <th>{{ t("failed") }}</th>
                                <th>{{ t("successRate") }}</th>
                                <th>{{ t("usageInputTokens") }}</th>
                                <th>{{ t("usageOutputTokens") }}</th>
                                <th>{{ t("usageTotalTokens") }}</th>
                                <th>{{ t("usageCachedShort") }}</th>
                                <th>{{ t("usageTokenCoverageShort") }}</th>
                                <th>{{ t("avgDuration") }}</th>
                                <th>{{ t("usageLastUsed") }}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="account in overview.accounts" :key="account.accountKey">
                                <td class="usage-name-cell">
                                    <button
                                        type="button"
                                        class="usage-name-link"
                                        :title="t('usageViewTrend')"
                                        @click="openAccountOverview(account)"
                                    >
                                        {{
                                            account.unattributed
                                                ? t("usageUnattributed")
                                                : formatAccount(account.finalAuthIndex, account.finalAccountName)
                                        }}
                                    </button>
                                </td>
                                <td>{{ formatNumber(account.totalRequests) }}</td>
                                <td>{{ formatNumber(account.touchedRequests) }}</td>
                                <td>{{ formatNumber(account.attemptCount) }}</td>
                                <td class="usage-positive">{{ formatNumber(account.successCount) }}</td>
                                <td class="usage-negative">{{ formatNumber(account.errorCount) }}</td>
                                <td>{{ account.totalRequests ? formatPercent(account.successRate) : "–" }}</td>
                                <td>{{ formatTokenCount(account.tokenUsage?.inputTokens) }}</td>
                                <td>{{ formatTokenCount(account.tokenUsage?.outputTokens) }}</td>
                                <td>{{ formatTokenCount(account.tokenUsage?.totalTokens) }}</td>
                                <td>{{ formatTokenCount(account.tokenUsage?.cachedInputTokens) }}</td>
                                <td class="usage-token-cell">{{ tokenCoverageLabel(account) }}</td>
                                <td>{{ formatDuration(account.avgDurationMs) }}</td>
                                <td>{{ formatTime(account.lastUsedAt) }}</td>
                                <td>
                                    <button type="button" class="usage-link" @click="openAccountRequests(account)">
                                        {{ t("usageViewRequests") }}
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div v-if="overview.accounts?.length" class="usage-ranking-cards">
                    <article v-for="account in overview.accounts" :key="account.accountKey" class="usage-ranking-card">
                        <div class="usage-ranking-card-head">
                            <strong>{{
                                account.unattributed
                                    ? t("usageUnattributed")
                                    : formatAccount(account.finalAuthIndex, account.finalAccountName)
                            }}</strong>
                            <span
                                >{{ formatTokenCount(account.tokenUsage?.totalTokens) }}
                                {{ t("usageTotalTokens") }}</span
                            >
                        </div>
                        <dl>
                            <div>
                                <dt>{{ t("usageTouchedRequests") }}</dt>
                                <dd>{{ formatNumber(account.touchedRequests) }}</dd>
                            </div>
                            <div>
                                <dt>{{ t("requestAttempts") }}</dt>
                                <dd>{{ formatNumber(account.attemptCount) }}</dd>
                            </div>
                            <div>
                                <dt>{{ t("successRate") }}</dt>
                                <dd>{{ account.totalRequests ? formatPercent(account.successRate) : "–" }}</dd>
                            </div>
                            <div>
                                <dt>{{ t("usageInputShort") }} / {{ t("usageOutputShort") }}</dt>
                                <dd>
                                    {{ formatTokenCount(account.tokenUsage?.inputTokens) }} /
                                    {{ formatTokenCount(account.tokenUsage?.outputTokens) }}
                                </dd>
                            </div>
                        </dl>
                        <div class="usage-ranking-card-actions">
                            <button type="button" class="usage-link" @click="openAccountOverview(account)">
                                {{ t("usageViewTrend") }}
                            </button>
                            <button type="button" class="usage-link" @click="openAccountRequests(account)">
                                {{ t("usageViewRequests") }}
                            </button>
                        </div>
                    </article>
                </div>
            </section>

            <section v-else-if="activeView === 'models'" class="usage-panel">
                <div class="usage-panel-heading">
                    <div>
                        <h2>{{ t("modelUsageBreakdown") }}</h2>
                        <p>{{ t("usageModelHint") }}</p>
                    </div>
                    <span class="usage-count">{{ overview.models?.length || 0 }} {{ t("usageModels") }}</span>
                </div>
                <div v-if="!overview.models?.length" class="usage-panel-empty">{{ t("noUsageStats") }}</div>
                <div v-else class="usage-table-scroll usage-ranking-table-scroll">
                    <table class="usage-table">
                        <thead>
                            <tr>
                                <th>{{ t("requestModel") }}</th>
                                <th>{{ t("usageRequests") }}</th>
                                <th>{{ t("success") }}</th>
                                <th>{{ t("failed") }}</th>
                                <th>{{ t("successRate") }}</th>
                                <th>{{ t("usageInputTokens") }}</th>
                                <th>{{ t("usageOutputTokens") }}</th>
                                <th>{{ t("usageTotalTokens") }}</th>
                                <th>{{ t("usageCachedShort") }}</th>
                                <th>{{ t("usageTokenCoverageShort") }}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="model in overview.models" :key="model.model">
                                <td class="usage-name-cell">
                                    <button
                                        type="button"
                                        class="usage-name-link"
                                        :title="t('usageViewTrend')"
                                        @click="openModelOverview(model)"
                                    >
                                        {{ model.model || "–" }}
                                    </button>
                                </td>
                                <td>{{ formatNumber(model.totalRequests) }}</td>
                                <td class="usage-positive">{{ formatNumber(model.successCount) }}</td>
                                <td class="usage-negative">{{ formatNumber(model.errorCount) }}</td>
                                <td>{{ formatPercent(model.successRate) }}</td>
                                <td>{{ formatTokenCount(model.tokenUsage?.inputTokens) }}</td>
                                <td>{{ formatTokenCount(model.tokenUsage?.outputTokens) }}</td>
                                <td>{{ formatTokenCount(model.tokenUsage?.totalTokens) }}</td>
                                <td>{{ formatTokenCount(model.tokenUsage?.cachedInputTokens) }}</td>
                                <td class="usage-token-cell">{{ tokenCoverageLabel(model) }}</td>
                                <td>
                                    <button type="button" class="usage-link" @click="openModelRequests(model)">
                                        {{ t("usageViewRequests") }}
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div v-if="overview.models?.length" class="usage-ranking-cards">
                    <article v-for="model in overview.models" :key="model.model" class="usage-ranking-card">
                        <div class="usage-ranking-card-head">
                            <strong>{{ model.model || "–" }}</strong>
                            <span
                                >{{ formatTokenCount(model.tokenUsage?.totalTokens) }} {{ t("usageTotalTokens") }}</span
                            >
                        </div>
                        <dl>
                            <div>
                                <dt>{{ t("usageRequests") }}</dt>
                                <dd>{{ formatNumber(model.totalRequests) }}</dd>
                            </div>
                            <div>
                                <dt>{{ t("successRate") }}</dt>
                                <dd>{{ formatPercent(model.successRate) }}</dd>
                            </div>
                            <div>
                                <dt>{{ t("usageInputShort") }} / {{ t("usageOutputShort") }}</dt>
                                <dd>
                                    {{ formatTokenCount(model.tokenUsage?.inputTokens) }} /
                                    {{ formatTokenCount(model.tokenUsage?.outputTokens) }}
                                </dd>
                            </div>
                            <div>
                                <dt>{{ t("usageCachedShort") }}</dt>
                                <dd>{{ formatTokenCount(model.tokenUsage?.cachedInputTokens) }}</dd>
                            </div>
                        </dl>
                        <div class="usage-ranking-card-actions">
                            <button type="button" class="usage-link" @click="openModelOverview(model)">
                                {{ t("usageViewTrend") }}
                            </button>
                            <button type="button" class="usage-link" @click="openModelRequests(model)">
                                {{ t("usageViewRequests") }}
                            </button>
                        </div>
                    </article>
                </div>
            </section>

            <section v-else-if="activeView === 'apiKeys'" class="usage-panel">
                <div class="usage-panel-heading">
                    <div>
                        <h2>{{ t("usageApiKeys") }}</h2>
                        <p>{{ t("usageApiKeyHint") }}</p>
                    </div>
                    <span class="usage-count">{{ overview.apiKeys?.length || 0 }} {{ t("usageApiKeys") }}</span>
                </div>
                <div v-if="!overview.apiKeys?.length" class="usage-panel-empty">{{ t("noUsageStats") }}</div>
                <div v-else class="usage-table-scroll usage-ranking-table-scroll">
                    <table class="usage-table">
                        <thead>
                            <tr>
                                <th>{{ t("usageApiKey") }}</th>
                                <th>{{ t("usageRequests") }}</th>
                                <th>{{ t("successRate") }}</th>
                                <th>{{ t("usageInputTokens") }}</th>
                                <th>{{ t("usageOutputTokens") }}</th>
                                <th>{{ t("usageTotalTokens") }}</th>
                                <th>{{ t("usageCachedShort") }}</th>
                                <th>{{ t("usageTokenCoverageShort") }}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="key in overview.apiKeys" :key="key.apiKeyId">
                                <td class="usage-name-cell">
                                    <button type="button" class="usage-name-link" @click="openApiKeyOverview(key)">
                                        {{ formatApiKey(key.apiKeyId) }}
                                    </button>
                                </td>
                                <td>{{ formatNumber(key.totalRequests) }}</td>
                                <td>{{ formatPercent(key.successRate) }}</td>
                                <td>{{ formatTokenCount(key.tokenUsage?.inputTokens) }}</td>
                                <td>{{ formatTokenCount(key.tokenUsage?.outputTokens) }}</td>
                                <td>{{ formatTokenCount(key.tokenUsage?.totalTokens) }}</td>
                                <td>{{ formatTokenCount(key.tokenUsage?.cachedInputTokens) }}</td>
                                <td class="usage-token-cell">{{ tokenCoverageLabel(key) }}</td>
                                <td>
                                    <button type="button" class="usage-link" @click="openApiKeyRequests(key)">
                                        {{ t("usageViewRequests") }}
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div v-if="overview.apiKeys?.length" class="usage-ranking-cards">
                    <article v-for="key in overview.apiKeys" :key="key.apiKeyId" class="usage-ranking-card">
                        <div class="usage-ranking-card-head">
                            <strong>{{ formatApiKey(key.apiKeyId) }}</strong>
                            <span>{{ formatTokenCount(key.tokenUsage?.totalTokens) }} {{ t("usageTotalTokens") }}</span>
                        </div>
                        <dl>
                            <div>
                                <dt>{{ t("usageRequests") }}</dt>
                                <dd>{{ formatNumber(key.totalRequests) }}</dd>
                            </div>
                            <div>
                                <dt>{{ t("successRate") }}</dt>
                                <dd>{{ formatPercent(key.successRate) }}</dd>
                            </div>
                            <div>
                                <dt>{{ t("usageInputShort") }} / {{ t("usageOutputShort") }}</dt>
                                <dd>
                                    {{ formatTokenCount(key.tokenUsage?.inputTokens) }} /
                                    {{ formatTokenCount(key.tokenUsage?.outputTokens) }}
                                </dd>
                            </div>
                            <div>
                                <dt>{{ t("usageCachedShort") }}</dt>
                                <dd>{{ formatTokenCount(key.tokenUsage?.cachedInputTokens) }}</dd>
                            </div>
                        </dl>
                        <div class="usage-ranking-card-actions">
                            <button type="button" class="usage-link" @click="openApiKeyOverview(key)">
                                {{ t("usageViewTrend") }}
                            </button>
                            <button type="button" class="usage-link" @click="openApiKeyRequests(key)">
                                {{ t("usageViewRequests") }}
                            </button>
                        </div>
                    </article>
                </div>
            </section>

            <section v-else class="usage-panel">
                <div class="usage-panel-heading">
                    <div>
                        <h2>{{ t("requestRecords") }}</h2>
                        <p>{{ t("usageRequestHint") }}</p>
                        <p v-if="filters.accountKey">{{ t("usageRequestAccountScope") }}</p>
                    </div>
                    <span class="usage-count">{{ formatNumber(requests.totalMatched) }} {{ t("usageMatched") }}</span>
                </div>
                <div v-if="requestsLoading" class="usage-panel-empty" role="status">{{ t("loading") }}</div>
                <div v-else-if="requestsError" class="usage-panel-empty usage-state-error" role="alert">
                    {{ requestsError }}
                    <button type="button" class="usage-link" @click="fetchRequests">{{ t("usageRetry") }}</button>
                </div>
                <div v-else-if="!requests.items?.length" class="usage-panel-empty">{{ t("noRequestRecords") }}</div>
                <template v-else>
                    <div class="usage-table-scroll usage-request-table-scroll">
                        <table class="usage-table usage-request-table">
                            <thead>
                                <tr>
                                    <th>{{ t("requestTime") }}</th>
                                    <th>{{ t("requestModel") }}</th>
                                    <th>{{ t("requestOutcome") }}</th>
                                    <th>{{ t("usageFinalAccount") }}</th>
                                    <th>{{ t("usageInputShort") }}</th>
                                    <th>{{ t("usageOutputShort") }}</th>
                                    <th>{{ t("usageTotalTokens") }}</th>
                                    <th>{{ t("usageCachedShort") }}</th>
                                    <th>{{ t("requestDuration") }}</th>
                                    <th>{{ t("requestAttempts") }}</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="record in requests.items" :key="record.sequence">
                                    <td>{{ formatTime(record.startedAt) }}</td>
                                    <td class="usage-name-cell">{{ record.model || "–" }}</td>
                                    <td>
                                        <span class="usage-outcome" :class="`is-${record.outcome}`">{{
                                            outcomeLabel(record.outcome)
                                        }}</span>
                                    </td>
                                    <td>{{ formatAccount(record.finalAuthIndex, record.finalAccountName) }}</td>
                                    <td>{{ formatTokenCount(displayTokenUsage(record)?.inputTokens) }}</td>
                                    <td>{{ formatTokenCount(displayTokenUsage(record)?.outputTokens) }}</td>
                                    <td>{{ formatTokenCount(displayTokenUsage(record)?.totalTokens) }}</td>
                                    <td>{{ formatTokenCount(displayTokenUsage(record)?.cachedInputTokens) }}</td>
                                    <td>{{ formatDuration(record.durationMs) }}</td>
                                    <td>{{ formatNumber(record.attemptCount) }}</td>
                                    <td>
                                        <button type="button" class="usage-link" @click="openRecord(record)">
                                            {{ t("usageDetails") }}
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="usage-request-cards">
                        <button
                            v-for="record in requests.items"
                            :key="record.sequence"
                            type="button"
                            class="usage-request-card"
                            @click="openRecord(record)"
                        >
                            <span class="usage-request-card-top"
                                ><strong>{{ record.model || "–" }}</strong
                                ><span class="usage-outcome" :class="`is-${record.outcome}`">{{
                                    outcomeLabel(record.outcome)
                                }}</span></span
                            >
                            <span class="usage-request-card-meta"
                                >{{ formatTime(record.startedAt) }} · {{ formatDuration(record.durationMs) }}</span
                            >
                            <span class="usage-request-card-tokens">
                                <span
                                    >{{ t("usageInputShort") }}
                                    <strong>{{
                                        formatTokenCount(displayTokenUsage(record)?.inputTokens)
                                    }}</strong></span
                                >
                                <span
                                    >{{ t("usageOutputShort") }}
                                    <strong>{{
                                        formatTokenCount(displayTokenUsage(record)?.outputTokens)
                                    }}</strong></span
                                >
                                <span
                                    >{{ t("usageTotalTokens") }}
                                    <strong>{{
                                        formatTokenCount(displayTokenUsage(record)?.totalTokens)
                                    }}</strong></span
                                >
                            </span>
                            <span class="usage-request-card-meta"
                                >{{ t("usageCachedShort") }}
                                {{ formatTokenCount(displayTokenUsage(record)?.cachedInputTokens) }}</span
                            >
                            <span class="usage-request-card-meta"
                                >{{ formatAccount(record.finalAuthIndex, record.finalAccountName) }} ·
                                {{ formatNumber(record.attemptCount) }} {{ t("requestAttempts") }}</span
                            >
                        </button>
                    </div>
                </template>
                <div class="usage-pagination">
                    <span>{{ t("usagePage", { page: requestPage + 1 }) }}</span>
                    <div>
                        <button
                            type="button"
                            class="usage-button usage-button-subtle"
                            :disabled="requestPage === 0 || requestsLoading"
                            @click="previousPage"
                        >
                            {{ t("paginationPrevious") }}
                        </button>
                        <button
                            type="button"
                            class="usage-button usage-button-subtle"
                            :disabled="!requests.hasMore || requestsLoading"
                            @click="nextPage"
                        >
                            {{ t("paginationNext") }}
                        </button>
                    </div>
                </div>
            </section>
        </template>

        <el-drawer
            v-model="detailOpen"
            :title="t('usageRequestDetails')"
            :size="drawerSize"
            class="usage-detail-drawer"
        >
            <template v-if="selectedRecord">
                <div class="usage-detail-head">
                    <span class="usage-outcome" :class="`is-${selectedRecord.outcome}`">{{
                        outcomeLabel(selectedRecord.outcome)
                    }}</span>
                    <strong>{{ selectedRecord.model || "–" }}</strong>
                </div>
                <p class="usage-detail-scope">{{ t("usageFullRequestTokens") }}</p>
                <dl class="usage-detail-list">
                    <div>
                        <dt>{{ t("requestTime") }}</dt>
                        <dd>{{ formatTime(selectedRecord.startedAt) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("requestId") }}</dt>
                        <dd class="usage-mono">{{ selectedRecord.requestId || "–" }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("usageFinalAccount") }}</dt>
                        <dd>{{ formatAccount(selectedRecord.finalAuthIndex, selectedRecord.finalAccountName) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("usageApiKey") }}</dt>
                        <dd class="usage-mono">{{ formatApiKey(selectedRecord.apiKeyId) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("usageRequestCategory") }}</dt>
                        <dd>{{ selectedRecord.requestCategory || "–" }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("requestStatus") }}</dt>
                        <dd>{{ selectedRecord.statusCode ?? "–" }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("requestDuration") }}</dt>
                        <dd>{{ formatDuration(selectedRecord.durationMs) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("usageInputTokens") }}</dt>
                        <dd>{{ formatTokenCount(selectedRecord.tokenUsage?.inputTokens) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("usageOutputTokens") }}</dt>
                        <dd>{{ formatTokenCount(selectedRecord.tokenUsage?.outputTokens) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("usageThoughtTokens") }}</dt>
                        <dd>{{ formatTokenCount(selectedRecord.tokenUsage?.thoughtTokens) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("usageCachedInputTokens") }}</dt>
                        <dd>{{ formatTokenCount(selectedRecord.tokenUsage?.cachedInputTokens) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("usageCacheState") }}</dt>
                        <dd>{{ cacheStateLabel(selectedRecord) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("usageTotalTokens") }}</dt>
                        <dd>{{ formatTokenCount(selectedRecord.tokenUsage?.totalTokens) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("usageReportState") }}</dt>
                        <dd>{{ usageStateLabel(selectedRecord.usageState) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("requestAttempts") }}</dt>
                        <dd>{{ formatNumber(selectedRecord.attemptCount) }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("apiFormat") }}</dt>
                        <dd>{{ selectedRecord.apiFormat || "–" }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("streamingMode") }}</dt>
                        <dd>{{ selectedRecord.streamMode || "–" }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("requestIp") }}</dt>
                        <dd class="usage-mono">{{ selectedRecord.clientIp || "–" }}</dd>
                    </div>
                </dl>
                <section v-if="selectedAccountScope" class="usage-detail-section usage-scoped-usage">
                    <h3>{{ t("usageSelectedAccountScope") }}</h3>
                    <div>
                        <span
                            >{{ t("usageInputShort") }}
                            {{ formatTokenCount(selectedRecord.scopedTokenUsage?.inputTokens) }}</span
                        >
                        <span
                            >{{ t("usageOutputShort") }}
                            {{ formatTokenCount(selectedRecord.scopedTokenUsage?.outputTokens) }}</span
                        >
                        <span
                            >{{ t("usageTotalTokens") }}
                            {{ formatTokenCount(selectedRecord.scopedTokenUsage?.totalTokens) }}</span
                        >
                        <span
                            >{{ t("usageCachedShort") }}
                            {{ formatTokenCount(selectedRecord.scopedTokenUsage?.cachedInputTokens) }}</span
                        >
                    </div>
                </section>
                <section v-if="selectedRecord.attempts?.length" class="usage-detail-section">
                    <h3>{{ t("attemptsPathTitle") }}</h3>
                    <ol class="usage-attempt-list">
                        <li
                            v-for="(attempt, index) in selectedRecord.attempts"
                            :key="attempt.requestAttemptId || index"
                        >
                            <div class="usage-attempt-header">
                                <strong
                                    >{{ t("usageAttemptNumber", { number: index + 1 }) }} ·
                                    {{ formatAttemptAccount(attempt) }}</strong
                                >
                                <span>{{ attempt.statusCode ?? outcomeLabel(attempt.outcome) }}</span>
                            </div>
                            <div class="usage-attempt-meta">
                                {{ formatTime(attempt.startedAt) }} · {{ usageStateLabel(attempt.usageState) }}
                            </div>
                            <div class="usage-attempt-tokens">
                                <span
                                    >{{ t("usageInputShort") }}
                                    {{ formatTokenCount(attempt.tokenUsage?.inputTokens) }}</span
                                >
                                <span
                                    >{{ t("usageOutputShort") }}
                                    {{ formatTokenCount(attempt.tokenUsage?.outputTokens) }}</span
                                >
                                <span
                                    >{{ t("usageTotalTokens") }}
                                    {{ formatTokenCount(attempt.tokenUsage?.totalTokens) }}</span
                                >
                                <span
                                    >{{ t("usageThoughtTokens") }}
                                    {{ formatTokenCount(attempt.tokenUsage?.thoughtTokens) }}</span
                                >
                                <span
                                    >{{ t("usageCachedShort") }}
                                    {{ formatTokenCount(attempt.tokenUsage?.cachedInputTokens) }}</span
                                >
                            </div>
                        </li>
                    </ol>
                </section>
                <section v-if="selectedRecord.errorMessage" class="usage-detail-section">
                    <h3>{{ t("errorDetailTitle") }}</h3>
                    <pre>{{ selectedRecord.errorMessage }}</pre>
                </section>
            </template>
        </el-drawer>
    </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import I18n from "../utils/i18n";

const props = defineProps({
    focusRequestId: { default: "", type: String },
    languageVersion: { default: 0, type: Number },
    transferBusy: { default: false, type: Boolean },
});
const emit = defineEmits(["import", "export"]);
const t = (key, options) => {
    props.languageVersion;
    return I18n.t(key, options);
};

const views = [
    { label: "usageViewOverview", value: "overview" },
    { label: "usageAccountRanking", value: "accounts" },
    { label: "usageViewModels", value: "models" },
    { label: "usageApiKeys", value: "apiKeys" },
    { label: "usageViewRequests", value: "requests" },
];
const trendMetrics = [
    { label: "usageRequests", value: "requests" },
    { label: "usageInputShort", value: "inputTokens" },
    { label: "usageOutputShort", value: "outputTokens" },
    { label: "usageTotalTokens", value: "totalTokens" },
    { label: "usageCachedShort", value: "cachedInputTokens" },
];
const rangeOptions = [
    { label: "timeRange24h", value: "24h" },
    { label: "timeRange7d", value: "7d" },
    { label: "timeRange30d", value: "30d" },
    { label: "timeRangeAll", value: "all" },
    { label: "usageCustom", value: "custom" },
];
const activeView = ref("overview");
const trendMetric = ref("requests");
const granularity = ref("auto");
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const timezone = ref(browserTimeZone);
const timeZoneOptions = [...new Set([browserTimeZone, "UTC", ...(Intl.supportedValuesOf?.("timeZone") || [])])];
const range = ref("24h");
const customDates = ref(null);
const customStartInput = ref("");
const customEndInput = ref("");
const isMobile = ref(false);
const searchText = ref("");
const filters = reactive({
    accountKey: "",
    apiKeyId: "",
    cacheState: "",
    maxDurationMs: "",
    minDurationMs: "",
    model: "",
    outcome: "",
    requestCategory: "",
    statusCode: "",
});
const advancedFiltersOpen = ref(false);
const overview = ref(null);
const loading = ref(false);
const refreshing = ref(false);
const autoRefresh = ref(true);
const error = ref("");
const requests = ref({ hasMore: false, items: [], nextCursor: null, totalMatched: 0 });
const requestsLoading = ref(false);
const requestsError = ref("");
const pageCursors = ref([null]);
const requestPage = ref(0);
const detailOpen = ref(false);
const drawerSize = ref("560px");
const selectedRecord = ref(null);
const selectedAccountScope = ref("");
let overviewGeneration = 0;
let requestsGeneration = 0;
let pollTimer = null;
let filterTimer = null;
let lastRefreshAt = 0;
const formatLocalDateTime = date => {
    const pad = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const syncViewport = () => {
    const mobile = window.innerWidth <= 700;
    drawerSize.value = mobile ? "100%" : "560px";
    if (mobile && !isMobile.value && validCustomDates.value) {
        customStartInput.value = formatLocalDateTime(customDates.value[0]);
        customEndInput.value = formatLocalDateTime(customDates.value[1]);
    }
    isMobile.value = mobile;
};

const validCustomDates = computed(
    () =>
        Array.isArray(customDates.value) &&
        customDates.value.length === 2 &&
        customDates.value.every(value => value instanceof Date && !Number.isNaN(value.getTime())) &&
        customDates.value[1].getTime() >= customDates.value[0].getTime()
);
const invalidCustomOrder = computed(() => {
    if (isMobile.value) {
        if (!customStartInput.value || !customEndInput.value) return false;
        const start = new Date(customStartInput.value).getTime();
        const end = new Date(customEndInput.value).getTime();
        return Number.isFinite(start) && Number.isFinite(end) && end < start;
    }
    if (!Array.isArray(customDates.value) || customDates.value.length !== 2) return false;
    const [start, end] = customDates.value;
    return start instanceof Date && end instanceof Date && end.getTime() < start.getTime();
});
const hasAdvancedFilters = computed(() =>
    [
        filters.apiKeyId,
        filters.requestCategory,
        filters.cacheState,
        filters.statusCode,
        filters.minDurationMs,
        filters.maxDurationMs,
    ].some(value => value !== "")
);
const hasActiveFilters = computed(
    () =>
        range.value !== "24h" ||
        !!searchText.value ||
        !!filters.accountKey ||
        !!filters.model ||
        !!filters.outcome ||
        hasAdvancedFilters.value
);
const validDurationFilter = computed(() => {
    const min = filters.minDurationMs === "" ? 0 : Number(filters.minDurationMs);
    const max = filters.maxDurationMs === "" ? Infinity : Number(filters.maxDurationMs);
    return (
        Number.isSafeInteger(min) &&
        min >= 0 &&
        ((max === Infinity && filters.maxDurationMs === "") || (Number.isSafeInteger(max) && max >= min))
    );
});
const validStatusCodeFilter = computed(() =>
    filters.statusCode === "" ? true : /^[1-5]\d{2}$/.test(String(filters.statusCode))
);
const modelOptions = computed(() => {
    const options = overview.value?.filterOptions?.models || [];
    return filters.model && !options.includes(filters.model) ? [filters.model, ...options] : options;
});
const accountOptions = computed(() => {
    const options = overview.value?.filterOptions?.accounts || [];
    return filters.accountKey && !options.some(item => item.accountKey === filters.accountKey)
        ? [{ accountKey: filters.accountKey, finalAccountName: filters.accountKey, finalAuthIndex: null }, ...options]
        : options;
});
const apiKeyOptions = computed(() => {
    const options = overview.value?.filterOptions?.apiKeys || [];
    return filters.apiKeyId && !options.some(item => item.apiKeyId === filters.apiKeyId)
        ? [{ apiKeyId: filters.apiKeyId }, ...options]
        : options;
});
const categoryOptions = computed(() => {
    const options = overview.value?.filterOptions?.requestCategories || [];
    return filters.requestCategory && !options.includes(filters.requestCategory)
        ? [filters.requestCategory, ...options]
        : options;
});
const hasTrendRequests = computed(() => (overview.value?.trend || []).some(item => item.totalRequests > 0));
const trendMetricLabel = computed(
    () => trendMetrics.find(metric => metric.value === trendMetric.value)?.label || "usageRequests"
);
const chartDots = computed(() => {
    const items = overview.value?.trend || [];
    const values = items.map(item =>
        trendMetric.value === "requests" ? item.totalRequests || 0 : item.tokenUsage?.[trendMetric.value] || 0
    );
    const max = Math.max(1, ...values);
    return items.map((item, index) => ({
        start: item.start,
        value: values[index],
        x: 24 + (items.length === 1 ? 340 : (index / (items.length - 1)) * 680),
        y: 168 - (values[index] / max) * 136,
    }));
});
const chartPoints = computed(() => chartDots.value.map(point => `${point.x},${point.y}`).join(" "));
const chartArea = computed(() => {
    if (!chartDots.value.length) return "";
    const first = chartDots.value[0];
    const last = chartDots.value[chartDots.value.length - 1];
    return `M ${first.x} 168 L ${chartDots.value.map(point => `${point.x} ${point.y}`).join(" L ")} L ${last.x} 168 Z`;
});

const formatNumber = value =>
    new Intl.NumberFormat(I18n.getLang() === "zh" ? "zh-CN" : "en-US").format(Number(value) || 0);
const formatTokenCount = value =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? formatNumber(value) : "–";
const tokenCoverageLabel = (group, field = "totalTokens") =>
    t(group?.attemptCount !== undefined ? "usageAttemptTokenCoverage" : "usageTokenCoverage", {
        known: formatNumber(group?.tokenUsageCoverage?.[field]),
        total: formatNumber(group?.attemptCount ?? group?.totalRequests),
    });
const cacheCoverageLabel = group =>
    t("usageCacheCoverage", {
        known: formatNumber(group?.tokenUsageCoverage?.cachedInputTokens),
        total: formatNumber(group?.attemptCount ?? group?.totalRequests),
    });
const formatPercent = value => `${Number(value || 0).toFixed(1)}%`;
const formatOptionalPercent = value => (value === null || value === undefined ? "–" : formatPercent(value));
const formatDuration = value => {
    const ms = Number(value);
    if (!Number.isFinite(ms)) return "–";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${(ms / 60000).toFixed(1)} min`;
};
const formatTime = value => {
    if (!value) return "–";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "–" : date.toLocaleString();
};
const formatChartTime = value => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, { day: "2-digit", hour: "2-digit", minute: "2-digit", month: "2-digit" });
};
const formatAccount = (index, name) =>
    index === null || index === undefined ? name || "–" : `#${index} ${name || "–"}`;
const formatAttempt = key => {
    if (!key) return "–";
    const separator = key.indexOf(":");
    return separator < 0 ? key : formatAccount(key.slice(0, separator), key.slice(separator + 1));
};
const formatAttemptAccount = attempt => {
    if ((attempt.authIndex !== null && attempt.authIndex !== undefined) || attempt.accountName) {
        return formatAccount(attempt.authIndex, attempt.accountName);
    }
    return formatAttempt(attempt.accountKey);
};
const formatApiKey = id =>
    id && id !== "unknown" ? (id.length > 18 ? `${id.slice(0, 12)}…` : id) : t("usageUnknownApiKey");
const usageStateLabel = state =>
    ({ partial: t("usagePartiallyReported"), reported: t("usageReported"), unreported: t("usageNotReported") })[
        state
    ] || t("usageUnknownReportState");
const cacheStateLabel = record => {
    const cached = record?.tokenUsage?.cachedInputTokens;
    return cached === null || cached === undefined
        ? t("usageCacheUnknown")
        : cached > 0
          ? t("usageCacheHit")
          : t("usageCacheMiss");
};
const displayTokenUsage = record => (filters.accountKey ? record.scopedTokenUsage : record.tokenUsage);
const outcomeLabel = outcome => ({ aborted: t("aborted"), error: t("failed"), success: t("success") })[outcome] || "–";
const summarizeError = message => (message ? String(message).replace(/\s+/g, " ").slice(0, 100) : t("errorUnknown"));

const setRange = value => {
    range.value = value;
    if (value !== "custom") {
        customDates.value = null;
        customStartInput.value = "";
        customEndInput.value = "";
    }
};
const resetFilters = () => {
    range.value = "24h";
    customDates.value = null;
    customStartInput.value = "";
    customEndInput.value = "";
    searchText.value = "";
    filters.accountKey = "";
    filters.model = "";
    filters.outcome = "";
    filters.apiKeyId = "";
    filters.requestCategory = "";
    filters.cacheState = "";
    filters.statusCode = "";
    filters.minDurationMs = "";
    filters.maxDurationMs = "";
};
const queryParams = () => {
    if (
        (range.value === "custom" && !validCustomDates.value) ||
        !validDurationFilter.value ||
        !validStatusCodeFilter.value
    )
        return null;
    const params = new URLSearchParams();
    if (range.value === "custom") {
        params.set("from", customDates.value[0].toISOString());
        params.set("to", customDates.value[1].toISOString());
    } else {
        params.set("range", range.value);
    }
    if (filters.accountKey) params.set("accountKey", filters.accountKey);
    if (filters.model) params.set("model", filters.model);
    if (filters.outcome) params.set("outcome", filters.outcome);
    if (filters.apiKeyId) params.set("apiKeyId", filters.apiKeyId);
    if (filters.requestCategory) params.set("requestCategory", filters.requestCategory);
    if (filters.cacheState) params.set("cacheState", filters.cacheState);
    if (filters.statusCode !== "") params.set("statusCode", String(filters.statusCode));
    if (filters.minDurationMs !== "") params.set("minDurationMs", String(filters.minDurationMs));
    if (filters.maxDurationMs !== "") params.set("maxDurationMs", String(filters.maxDurationMs));
    params.set("granularity", granularity.value);
    params.set("timezone", timezone.value);
    if (searchText.value.trim()) params.set("q", searchText.value.trim());
    return params;
};
const getJson = async url => {
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
const fetchOverview = async () => {
    const params = queryParams();
    if (!params) return;
    const generation = ++overviewGeneration;
    loading.value = true;
    refreshing.value = true;
    error.value = "";
    try {
        const data = await getJson(`/api/usage-stats/overview?${params}`);
        if (generation === overviewGeneration) {
            overview.value = data;
            lastRefreshAt = Date.now();
        }
    } catch (cause) {
        if (generation === overviewGeneration) error.value = cause.message || String(cause);
    } finally {
        if (generation === overviewGeneration) {
            loading.value = false;
            refreshing.value = false;
        }
    }
};
const fetchRequests = async () => {
    const params = queryParams();
    if (!params) return;
    const generation = ++requestsGeneration;
    requestsLoading.value = true;
    requestsError.value = "";
    params.set("limit", "20");
    const cursor = pageCursors.value[requestPage.value];
    if (cursor !== null && cursor !== undefined) params.set("cursor", String(cursor));
    try {
        const data = await getJson(`/api/usage-stats/requests?${params}`);
        if (generation === requestsGeneration) requests.value = data;
    } catch (cause) {
        if (generation === requestsGeneration) requestsError.value = cause.message || String(cause);
    } finally {
        if (generation === requestsGeneration) requestsLoading.value = false;
    }
};
const resetRequestPaging = () => {
    pageCursors.value = [null];
    requestPage.value = 0;
    requests.value = { hasMore: false, items: [], nextCursor: null, totalMatched: 0 };
};
const nextPage = () => {
    if (!requests.value.hasMore || requests.value.nextCursor === null) return;
    pageCursors.value = [...pageCursors.value.slice(0, requestPage.value + 1), requests.value.nextCursor];
    requestPage.value += 1;
    fetchRequests();
};
const previousPage = () => {
    if (requestPage.value === 0) return;
    requestPage.value -= 1;
    fetchRequests();
};
const refresh = async () => {
    await fetchOverview();
    if (activeView.value === "requests") await fetchRequests();
};
const refreshAfterImport = async () => {
    resetRequestPaging();
    await refresh();
};
const toggleAutoRefresh = () => {
    autoRefresh.value = !autoRefresh.value;
    if (autoRefresh.value && !document.hidden && Date.now() - lastRefreshAt >= 30000) refresh();
};
const pollIfVisible = () => {
    if (!autoRefresh.value || document.hidden || refreshing.value) return;
    refresh();
};
const resumeWhenVisible = () => {
    if (!document.hidden && autoRefresh.value && Date.now() - lastRefreshAt >= 30000) pollIfVisible();
};
const openRecord = record => {
    selectedRecord.value = record;
    selectedAccountScope.value = filters.accountKey;
    detailOpen.value = true;
};
const showFailedRequests = () => {
    filters.outcome = "error";
    activeView.value = "requests";
};
const openAccountRequests = account => {
    filters.accountKey = account.accountKey;
    activeView.value = "requests";
};
const openAccountOverview = account => {
    filters.accountKey = account.accountKey;
    activeView.value = "overview";
};
const openModelRequests = model => {
    filters.model = model.model;
    activeView.value = "requests";
};
const openModelOverview = model => {
    filters.model = model.model;
    activeView.value = "overview";
};
const openApiKeyRequests = key => {
    filters.apiKeyId = key.apiKeyId;
    activeView.value = "requests";
};
const openApiKeyOverview = key => {
    filters.apiKeyId = key.apiKeyId;
    activeView.value = "overview";
};
const focusRequest = async requestId => {
    if (!requestId) return;
    resetFilters();
    range.value = "all";
    searchText.value = requestId;
    activeView.value = "requests";
    detailOpen.value = false;
    selectedRecord.value = null;
    await nextTick();
    if (filterTimer) {
        clearTimeout(filterTimer);
        filterTimer = null;
    }
    resetRequestPaging();
    await refresh();
    const matched = requests.value.items?.find(record => record.requestId === requestId);
    if (matched) openRecord(matched);
};

watch([customStartInput, customEndInput], () => {
    if (!isMobile.value) return;
    const start = customStartInput.value ? new Date(customStartInput.value) : null;
    const end = customEndInput.value ? new Date(customEndInput.value) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
        customDates.value = null;
        return;
    }
    if (
        validCustomDates.value &&
        customDates.value[0].getTime() === start.getTime() &&
        customDates.value[1].getTime() === end.getTime()
    ) {
        return;
    }
    customDates.value = [start, end];
});

watch(
    [
        range,
        customDates,
        searchText,
        granularity,
        timezone,
        () => filters.accountKey,
        () => filters.model,
        () => filters.outcome,
        () => filters.apiKeyId,
        () => filters.requestCategory,
        () => filters.cacheState,
        () => filters.statusCode,
        () => filters.minDurationMs,
        () => filters.maxDurationMs,
    ],
    () => {
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => {
            filterTimer = null;
            resetRequestPaging();
            if (
                (range.value === "custom" && !validCustomDates.value) ||
                !validDurationFilter.value ||
                !validStatusCodeFilter.value
            ) {
                overview.value = null;
                return;
            }
            refresh();
        }, 300);
    }
);
watch(activeView, value => {
    if (value === "requests" && !filterTimer && !requests.value.items?.length) fetchRequests();
});
watch(() => props.focusRequestId, focusRequest);
onMounted(() => {
    syncViewport();
    window.addEventListener("resize", syncViewport);
    document.addEventListener("visibilitychange", resumeWhenVisible);
    if (props.focusRequestId) focusRequest(props.focusRequestId);
    else refresh();
    pollTimer = setInterval(pollIfVisible, 30000);
});
onBeforeUnmount(() => {
    window.removeEventListener("resize", syncViewport);
    document.removeEventListener("visibilitychange", resumeWhenVisible);
    if (pollTimer) clearInterval(pollTimer);
    if (filterTimer) clearTimeout(filterTimer);
    overviewGeneration += 1;
    requestsGeneration += 1;
});
defineExpose({ focusRequest, refresh, refreshAfterImport });
</script>

<style lang="less" scoped>
@import "../styles/variables.less";

.usage-analytics {
    color: @text-primary;
    min-width: 0;
}
.usage-header,
.usage-toolbar-top,
.usage-panel-heading,
.usage-pagination,
.usage-detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
}
.usage-header {
    margin-bottom: 18px;
    align-items: center;
    padding-bottom: 17px;
    border-bottom: 1px solid @border-light;
}
.usage-heading {
    min-width: 0;
}
.usage-eyebrow {
    margin: 0 0 4px;
    color: @primary-color;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
}
.usage-header h1 {
    margin: 0;
    font-size: clamp(1.45rem, 2vw, 1.8rem);
    line-height: 1.2;
}
.usage-subtitle {
    margin: 6px 0 0;
    color: @text-secondary;
    font-size: 0.82rem;
}
.usage-header-actions,
.usage-range,
.usage-filter-row,
.usage-tabs,
.usage-pagination > div {
    display: flex;
    align-items: center;
    gap: 8px;
}
.usage-header-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 7px;
    flex: none;
}
.usage-action-row,
.usage-transfer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}
.usage-transfer-actions {
    gap: 14px;
}
.usage-updated {
    color: @text-secondary;
    font-size: 0.73rem;
}
.usage-text-button {
    padding: 0;
    border: 0;
    background: transparent;
    color: @text-secondary;
    font: inherit;
    font-size: 0.73rem;
    cursor: pointer;
}
.usage-text-button:hover {
    color: @primary-color;
    text-decoration: underline;
}
.usage-text-button:disabled {
    opacity: 0.45;
    cursor: default;
}
.usage-auto-refresh {
    display: inline-flex;
    align-items: center;
    gap: 7px;
}
.usage-auto-indicator {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: @success-color;
}
.usage-auto-indicator.is-paused {
    background: @text-secondary;
}
.usage-button,
.usage-range button,
.usage-reset,
.usage-tabs button {
    font: inherit;
    cursor: pointer;
}
.usage-button {
    border: 1px solid @primary-color;
    border-radius: 8px;
    padding: 7px 11px;
    background: @primary-color;
    color: white;
    font-size: 0.82rem;
    font-weight: 600;
}
.usage-button-subtle {
    border-color: @border-light;
    background: @background-white;
    color: @text-primary;
}
.usage-button:disabled,
.usage-reset:disabled {
    opacity: 0.48;
    cursor: default;
}
.usage-toolbar,
.usage-panel,
.usage-summary {
    background: @background-white;
    border: 1px solid @border-light;
    border-radius: 11px;
}
.usage-toolbar {
    padding: 12px 14px;
}
.usage-range {
    flex-wrap: wrap;
}
.usage-range button {
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 6px 10px;
    background: transparent;
    color: @text-secondary;
    font-size: 0.84rem;
    font-weight: 600;
}
.usage-range button.is-active {
    border-color: rgba(var(--color-primary-rgb), 0.18);
    background: rgba(var(--color-primary-rgb), 0.09);
    color: @primary-color;
}
.usage-reset,
.usage-link {
    border: 0;
    background: transparent;
    color: @primary-color;
    font-size: 0.83rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
}
.usage-custom-dates {
    margin-top: 12px;
    width: min(100%, 400px) !important;
}
.usage-mobile-dates {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 12px;
}
.usage-mobile-dates label {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 5px;
    color: @text-secondary;
    font-size: 0.75rem;
    font-weight: 600;
}
.usage-mobile-dates input {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    padding: 9px 10px;
    border: 1px solid @border-light;
    border-radius: 9px;
    background: @background-white;
    color: @text-primary;
    font: inherit;
    font-size: 0.85rem;
}
:global(.el-popper.usage-date-popover) {
    max-width: calc(100vw - 20px);
    overflow-x: auto;
}
.usage-filter-row {
    margin-top: 10px;
    flex-wrap: wrap;
}
.usage-search {
    flex: 2 1 240px;
    min-width: 180px;
    border: 1px solid @border-light;
    border-radius: 9px;
    padding: 8px 11px;
    background: @background-white;
    color: @text-primary;
    font: inherit;
    font-size: 0.86rem;
    outline: none;
}
.usage-search:focus {
    border-color: @primary-color;
}
.usage-select {
    flex: 1 1 150px;
    min-width: 140px;
}
.usage-more-filters {
    margin-top: 10px;
}
.usage-more-filters summary {
    width: fit-content;
    color: @primary-color;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
}
.usage-filter-dot {
    margin-left: 5px;
    color: @warning-color;
}
.usage-duration-filter {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: 1 1 150px;
    min-width: 135px;
    color: @text-secondary;
    font-size: 0.76rem;
}
.usage-status-filter {
    flex-basis: 115px;
    min-width: 110px;
}
.usage-duration-filter input {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    padding: 7px 9px;
    border: 1px solid @border-light;
    border-radius: 8px;
    background: @background-white;
    color: @text-primary;
    font: inherit;
}
.usage-tabs {
    overflow-x: auto;
    margin: 15px 0 13px;
    padding-bottom: 2px;
    border-bottom: 1px solid @border-light;
}
.usage-tabs button {
    flex: 0 0 auto;
    border: 0;
    border-bottom: 2px solid transparent;
    padding: 9px 14px;
    background: transparent;
    color: @text-secondary;
    font-size: 0.88rem;
    font-weight: 600;
}
.usage-tabs button.is-active {
    border-bottom-color: @primary-color;
    color: @primary-color;
}
.usage-tab-count {
    margin-left: 6px;
    color: @text-secondary;
    font-size: 0.73rem;
}
.usage-state,
.usage-panel-empty {
    padding: 52px 20px;
    text-align: center;
    color: @text-secondary;
}
.usage-state-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    color: @error-color;
}
.usage-inline-error {
    padding: 10px 14px;
    border-radius: 9px;
    background: rgba(var(--color-error-rgb), 0.08);
    color: @error-color;
    font-size: 0.85rem;
}
.usage-kpis {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
}
.usage-kpi {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    padding: 14px 16px;
    border-right: 1px solid @border-light;
}
.usage-kpi:last-child {
    border-right: 0;
}
.usage-kpi span {
    color: @text-secondary;
    font-size: 0.74rem;
    font-weight: 600;
}
.usage-kpi strong {
    font-size: clamp(1.25rem, 1.8vw, 1.7rem);
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
}
.usage-kpi small {
    color: @text-secondary;
    font-size: 0.69rem;
    line-height: 1.3;
}
.usage-summary-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 5px 18px;
    padding: 9px 16px;
    border-top: 1px solid @border-light;
    color: @text-secondary;
    font-size: 0.72rem;
}
.usage-positive {
    color: @success-color;
}
.usage-negative {
    color: @error-color;
}
.usage-overview-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.55fr) minmax(290px, 1fr);
    gap: 11px;
}
.usage-panel {
    min-width: 0;
    padding: 16px;
}
.usage-panel-heading {
    margin-bottom: 16px;
    align-items: flex-start;
    flex-wrap: wrap;
}
.usage-panel-heading h2 {
    margin: 0;
    font-size: 1rem;
}
.usage-panel-heading p {
    margin: 5px 0 0;
    color: @text-secondary;
    font-size: 0.77rem;
}
.usage-trend-toggle {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 2px;
    padding: 3px;
    border: 1px solid @border-light;
    border-radius: 8px;
}
.usage-trend-toggle button {
    padding: 4px 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: @text-secondary;
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
}
.usage-trend-toggle button.is-active {
    background: rgba(var(--color-primary-rgb), 0.1);
    color: @primary-color;
}
.usage-trend-options {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin: -5px 0 10px;
}
.usage-timezone-select {
    width: 155px;
}
.usage-granularity-select {
    width: 125px;
}
.usage-count {
    color: @text-secondary;
    font-size: 0.8rem;
    white-space: nowrap;
}
.usage-chart {
    display: block;
    width: 100%;
    height: 175px;
    overflow: visible;
}
.usage-chart-axis,
.usage-chart-grid {
    stroke: @border-light;
    stroke-width: 1;
}
.usage-chart-grid {
    stroke-dasharray: 4 5;
}
.usage-chart-area {
    fill: rgba(var(--color-primary-rgb), 0.09);
}
.usage-chart-line {
    fill: none;
    stroke: @primary-color;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.usage-chart-dot {
    fill: @background-white;
    stroke: @primary-color;
    stroke-width: 3;
}
.usage-chart-labels {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    color: @text-secondary;
    font-size: 0.72rem;
}
.usage-failure-row {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    padding: 10px 0;
    border: 0;
    border-top: 1px solid @border-light;
    background: transparent;
    color: @text-primary;
    text-align: left;
    cursor: pointer;
}
.usage-failure-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
}
.usage-failure-main strong,
.usage-failure-main small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.usage-failure-main strong {
    font-size: 0.83rem;
}
.usage-failure-main small,
.usage-failure-row time {
    color: @text-secondary;
    font-size: 0.73rem;
}
.usage-failure-row time {
    white-space: nowrap;
}
.usage-table-scroll {
    overflow-x: auto;
}
.usage-ranking-cards {
    display: none;
}
.usage-ranking-card {
    min-width: 0;
    border: 1px solid @border-light;
    border-radius: 9px;
    padding: 12px;
}
.usage-ranking-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 8px;
}
.usage-ranking-card-head strong {
    overflow-wrap: anywhere;
    font-size: 0.86rem;
}
.usage-ranking-card-head span {
    color: @text-secondary;
    font-size: 0.73rem;
    white-space: nowrap;
}
.usage-ranking-card dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px 12px;
    margin: 13px 0;
}
.usage-ranking-card dl div {
    min-width: 0;
}
.usage-ranking-card dt {
    color: @text-secondary;
    font-size: 0.7rem;
}
.usage-ranking-card dd {
    margin: 3px 0 0;
    overflow-wrap: anywhere;
    font-size: 0.83rem;
    font-variant-numeric: tabular-nums;
}
.usage-ranking-card-actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding-top: 10px;
    border-top: 1px solid @border-light;
}
.usage-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.84rem;
}
.usage-table th,
.usage-table td {
    padding: 10px 9px;
    border-top: 1px solid @border-light;
    text-align: left;
    white-space: nowrap;
}
.usage-table th {
    color: @text-secondary;
    font-size: 0.73rem;
    font-weight: 650;
}
.usage-table td {
    font-variant-numeric: tabular-nums;
}
.usage-table tbody tr:hover {
    background: rgba(var(--color-primary-rgb), 0.035);
}
.usage-token-cell small {
    display: block;
    margin-top: 3px;
    color: @text-secondary;
    font-size: 0.72rem;
}
.usage-name-cell {
    max-width: 270px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
}
.usage-name-link {
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
}
.usage-name-link:hover {
    color: @primary-color;
    text-decoration: underline;
}
.usage-outcome {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 56px;
    padding: 4px 8px;
    border-radius: 999px;
    background: @background-light;
    color: @text-secondary;
    font-size: 0.74rem;
    font-weight: 700;
}
.usage-outcome.is-success {
    background: rgba(var(--color-success-rgb), 0.11);
    color: @success-color;
}
.usage-outcome.is-error {
    background: rgba(var(--color-error-rgb), 0.11);
    color: @error-color;
}
.usage-outcome.is-aborted {
    background: rgba(var(--color-warning-rgb), 0.12);
    color: @warning-color;
}
.usage-request-cards {
    display: none;
}
.usage-pagination {
    margin-top: 15px;
    color: @text-secondary;
    font-size: 0.82rem;
}
.usage-detail-head {
    justify-content: flex-start;
    margin-bottom: 20px;
}
.usage-detail-head strong {
    overflow-wrap: anywhere;
}
.usage-detail-scope {
    margin: 0 0 10px;
    color: @text-secondary;
    font-size: 0.78rem;
}
.usage-detail-list {
    margin: 0;
}
.usage-detail-list div {
    display: grid;
    grid-template-columns: 135px minmax(0, 1fr);
    gap: 12px;
    padding: 11px 0;
    border-bottom: 1px solid @border-light;
}
.usage-detail-list dt {
    color: @text-secondary;
}
.usage-detail-list dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
}
.usage-mono,
.usage-detail-section pre {
    font-family: @font-family-mono;
    font-size: 0.8rem;
}
.usage-detail-section {
    margin-top: 24px;
}
.usage-detail-section h3 {
    margin: 0 0 10px;
    font-size: 0.9rem;
}
.usage-scoped-usage {
    padding: 12px;
    border-radius: 9px;
    background: @background-light;
}
.usage-scoped-usage > div {
    display: flex;
    flex-wrap: wrap;
    gap: 7px 14px;
    font-size: 0.8rem;
}
.usage-detail-section ol {
    padding-left: 22px;
}
.usage-detail-section li {
    margin: 6px 0;
}
.usage-attempt-list {
    margin: 0;
    list-style: none;
    padding: 0 !important;
}
.usage-attempt-list li {
    padding: 11px;
    border: 1px solid @border-light;
    border-radius: 9px;
}
.usage-attempt-header {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    overflow-wrap: anywhere;
}
.usage-attempt-meta {
    margin-top: 5px;
    color: @text-secondary;
    font-size: 0.73rem;
}
.usage-attempt-tokens {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    margin-top: 9px;
    font-size: 0.78rem;
}
.usage-detail-section pre {
    overflow: auto;
    padding: 13px;
    border-radius: 9px;
    background: @background-light;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
@media (max-width: 1000px) {
    .usage-kpis {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .usage-kpi:nth-child(3) {
        border-right: 0;
    }
    .usage-kpi:nth-child(n + 4) {
        border-top: 1px solid @border-light;
    }
    .usage-overview-grid {
        grid-template-columns: 1fr;
    }
}
@media (max-width: 700px) {
    .usage-header {
        flex-direction: column;
        align-items: stretch;
        gap: 12px;
    }
    .usage-header-actions {
        align-items: flex-start;
    }
    .usage-action-row {
        width: 100%;
        justify-content: space-between;
    }
    .usage-kpis {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .usage-kpi:nth-child(3) {
        border-right: 1px solid @border-light;
    }
    .usage-kpi:nth-child(even) {
        border-right: 0;
    }
    .usage-kpi:nth-child(n + 3) {
        border-top: 1px solid @border-light;
    }
    .usage-summary-meta {
        gap: 4px 12px;
    }
    .usage-tabs {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 4px;
        overflow: visible;
    }
    .usage-tabs button {
        min-width: 0;
        padding: 8px 4px;
        white-space: nowrap;
    }
    .usage-mobile-dates {
        grid-template-columns: 1fr;
    }
    .usage-detail-list div {
        grid-template-columns: 105px minmax(0, 1fr);
    }
    .usage-toolbar {
        padding: 11px;
    }
    .usage-toolbar-top {
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
    }
    .usage-range {
        flex-wrap: wrap;
        width: 100%;
        gap: 4px;
    }
    .usage-range button {
        white-space: nowrap;
        padding: 6px 8px;
        font-size: 0.78rem;
    }
    .usage-reset {
        align-self: flex-end;
    }
    .usage-select {
        flex: 1 1 calc(50% - 8px);
    }
    .usage-search {
        flex-basis: 100%;
    }
    .usage-kpi {
        padding: 12px;
    }
    .usage-kpi strong {
        font-size: 1.3rem;
    }
    .usage-table-scroll.usage-request-table-scroll {
        display: none;
    }
    .usage-table-scroll.usage-ranking-table-scroll {
        display: none;
    }
    .usage-ranking-cards {
        display: grid;
        gap: 8px;
    }
    .usage-request-cards {
        display: grid;
        gap: 8px;
    }
    .usage-request-card {
        display: flex;
        flex-direction: column;
        gap: 7px;
        width: 100%;
        padding: 12px;
        border: 1px solid @border-light;
        border-radius: 10px;
        background: @background-white;
        color: @text-primary;
        text-align: left;
        cursor: pointer;
    }
    .usage-request-card-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }
    .usage-request-card-top strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .usage-request-card-meta {
        color: @text-secondary;
        font-size: 0.76rem;
    }
    .usage-request-card-tokens {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        font-size: 0.8rem;
    }
    .usage-request-card-tokens strong {
        margin-left: 3px;
    }
    .usage-trend-options {
        justify-content: flex-start;
        flex-wrap: wrap;
    }
    .usage-pagination {
        flex-wrap: wrap;
    }
}
</style>
