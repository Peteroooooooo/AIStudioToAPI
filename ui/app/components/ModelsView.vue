<template>
    <section class="models-view" aria-labelledby="models-heading">
        <header class="models-heading">
            <div>
                <p class="models-eyebrow">{{ t("modelCatalogEyebrow") }}</p>
                <h1 id="models-heading">{{ t("modelCatalogTitle") }}</h1>
                <p>{{ t("modelCatalogDescription") }}</p>
            </div>
            <button class="models-button" type="button" :disabled="!!busy" @click="loadCatalog">
                {{ t("modelCatalogRefresh") }}
            </button>
        </header>

        <div v-if="error" class="models-alert" role="alert">{{ error }}</div>

        <div class="models-summary" aria-live="polite">
            <div class="models-summary-item">
                <span>{{ t("modelCatalogAvailable") }}</span>
                <strong>{{ models.length }}</strong>
            </div>
            <div class="models-summary-item">
                <span>{{ t("modelCatalogExposed") }}</span>
                <strong>{{ enabledCount }}</strong>
            </div>
            <div class="models-summary-item">
                <span>{{ t("modelCatalogHidden") }}</span>
                <strong>{{ models.length - enabledCount }}</strong>
            </div>
            <div class="models-summary-item models-summary-time">
                <span>{{ t("modelCatalogLastSync") }}</span>
                <strong>{{ formatDate(catalog.lastSyncedAt) }}</strong>
            </div>
        </div>

        <section class="models-panel" aria-labelledby="models-sync-heading">
            <div class="models-panel-heading">
                <div>
                    <h2 id="models-sync-heading">{{ t("modelCatalogSyncTitle") }}</h2>
                    <p>{{ t("modelCatalogSyncDescription") }}</p>
                </div>
            </div>
            <div class="models-sync-controls">
                <label class="models-field models-source">
                    <span>{{ t("modelCatalogSource") }}</span>
                    <select v-model="syncSource" :disabled="!!busy">
                        <option value="native">{{ t("modelCatalogNativeSource") }}</option>
                        <option value="public">{{ t("modelCatalogPublicSource") }}</option>
                        <option value="google">{{ t("modelCatalogGoogleSource") }}</option>
                    </select>
                </label>
                <label v-if="syncSource === 'google'" class="models-field models-key">
                    <span>{{ t("modelCatalogGoogleKey") }}</span>
                    <input
                        v-model.trim="syncApiKey"
                        type="password"
                        autocomplete="off"
                        :placeholder="t('modelCatalogGoogleKeyPlaceholder')"
                        :disabled="!!busy"
                    />
                </label>
                <button
                    class="models-button is-primary models-sync-button"
                    type="button"
                    :disabled="!!busy || (syncSource === 'google' && !syncApiKey)"
                    @click="syncCatalog"
                >
                    {{ busy === "sync" ? t("modelCatalogSyncing") : t("modelCatalogSync") }}
                </button>
            </div>
            <p class="models-note">
                {{
                    syncSource === "native"
                        ? t("modelCatalogNativeNote")
                        : syncSource === "google"
                          ? t("modelCatalogGoogleKeyNote")
                          : t("modelCatalogPublicNote")
                }}
            </p>
            <div class="models-add">
                <label class="models-field models-add-field">
                    <span>{{ t("modelCatalogAddTitle") }}</span>
                    <input
                        v-model.trim="newModelId"
                        maxlength="207"
                        :placeholder="t('modelCatalogAddPlaceholder')"
                        :disabled="!!busy"
                    />
                </label>
                <button class="models-button" type="button" :disabled="!!busy || !newModelId" @click="addModel">
                    {{ busy === "add" ? t("modelCatalogAdding") : t("modelCatalogAdd") }}
                </button>
                <p class="models-note">{{ t("modelCatalogAddNote") }}</p>
            </div>
        </section>

        <section class="models-panel models-list-panel" aria-labelledby="models-list-heading">
            <div class="models-panel-heading models-list-heading">
                <div>
                    <h2 id="models-list-heading">{{ t("modelCatalogListTitle") }}</h2>
                    <p>{{ t("modelCatalogListDescription") }}</p>
                </div>
                <span>{{ t("modelCatalogShown", { count: filteredModels.length }) }}</span>
            </div>
            <div class="models-filters">
                <input
                    v-model.trim="search"
                    type="search"
                    :placeholder="t('modelCatalogSearch')"
                    :aria-label="t('modelCatalogSearch')"
                />
                <select v-model="exposureFilter" :aria-label="t('modelCatalogExposureFilter')">
                    <option value="all">{{ t("modelCatalogAllModels") }}</option>
                    <option value="enabled">{{ t("modelCatalogExposedOnly") }}</option>
                    <option value="disabled">{{ t("modelCatalogHiddenOnly") }}</option>
                </select>
                <select v-model="capabilityFilter" :aria-label="t('modelCatalogCapabilityFilter')">
                    <option value="all">{{ t("modelCatalogAllCapabilities") }}</option>
                    <option value="level">{{ t("modelCatalogLevelCapable") }}</option>
                    <option value="other">{{ t("modelCatalogOtherCapabilities") }}</option>
                </select>
            </div>
            <p v-if="busy === 'load' && !loaded" class="models-empty">{{ t("loading") }}</p>
            <p v-else-if="loaded && !models.length" class="models-empty">{{ t("modelCatalogNoModels") }}</p>
            <p v-else-if="loaded && !filteredModels.length" class="models-empty">{{ t("modelCatalogNoMatches") }}</p>
            <div v-else class="models-table-wrap">
                <table class="models-table">
                    <thead>
                        <tr>
                            <th scope="col">{{ t("modelCatalogModel") }}</th>
                            <th scope="col">{{ t("modelCatalogCapability") }}</th>
                            <th scope="col">{{ t("modelCatalogExposure") }}</th>
                            <th scope="col">{{ t("modelCatalogProbeStatus") }}</th>
                            <th scope="col">{{ t("modelCatalogActions") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="model in filteredModels" :key="model.id">
                            <td>
                                <div class="models-identity">
                                    <strong>{{ model.displayName || model.id }}</strong>
                                    <code>{{ model.id }}</code>
                                    <small v-if="model.alias">{{ t("modelCatalogAlias") }}: {{ model.alias }}</small>
                                    <small v-if="model.description" class="models-description">{{
                                        model.description
                                    }}</small>
                                    <span class="models-source-tag">{{ sourceLabel(model.source) }}</span>
                                </div>
                            </td>
                            <td>
                                <div v-if="availableLevels(model).length" class="models-inline-thinking">
                                    <div class="models-thinking-heading">
                                        <strong>{{ t("modelCatalogLevelCapable") }}</strong>
                                        <span>{{ thinkingSelectionLabel(model) }}</span>
                                    </div>
                                    <input
                                        class="models-thinking-slider"
                                        type="range"
                                        min="0"
                                        :max="availableLevels(model).length"
                                        step="1"
                                        :value="thinkingStep(model)"
                                        :disabled="!!busy"
                                        :aria-label="t('modelCatalogThinkingNamed', { name: model.id })"
                                        :aria-valuetext="thinkingSelectionLabel(model)"
                                        @input="event => setThinkingDraft(model, Number(event.target.value))"
                                        @change="event => saveThinking(model, Number(event.target.value))"
                                    />
                                    <div
                                        class="models-thinking-steps"
                                        :style="{
                                            gridTemplateColumns: `repeat(${availableLevels(model).length + 1}, minmax(0, 1fr))`,
                                        }"
                                    >
                                        <button
                                            v-for="(step, index) in ['DEFAULT', ...availableLevels(model)]"
                                            :key="step"
                                            class="models-thinking-step"
                                            :class="{ 'is-selected': thinkingStep(model) === index }"
                                            type="button"
                                            :disabled="!!busy"
                                            :aria-pressed="thinkingStep(model) === index"
                                            @click="saveThinking(model, index)"
                                        >
                                            {{ step === "DEFAULT" ? t("modelCatalogDefault") : levelLabel(step) }}
                                        </button>
                                    </div>
                                    <small class="models-thinking-hint">{{ thinkingDescription(model) }}</small>
                                </div>
                                <span v-else class="models-kind">{{ t("modelCatalogKindnone") }}</span>
                            </td>
                            <td>
                                <el-switch
                                    :model-value="model.enabled"
                                    :disabled="!!busy"
                                    :aria-label="t('modelCatalogToggleNamed', { name: model.id })"
                                    @change="value => setEnabled(model, value)"
                                />
                                <small class="models-exposure-text">
                                    {{ model.enabled ? t("modelCatalogExposed") : t("modelCatalogHidden") }}
                                </small>
                            </td>
                            <td>
                                <span
                                    v-if="model.probeSupported"
                                    class="models-probe-summary"
                                    :class="probeClass(latestProbe(model))"
                                >
                                    {{ probeSummary(model) }}
                                </span>
                                <span v-else>—</span>
                            </td>
                            <td>
                                <div class="models-row-actions">
                                    <button
                                        class="models-text-button"
                                        type="button"
                                        :disabled="!!busy"
                                        @click="openEditor(model)"
                                    >
                                        {{ t("modelCatalogEdit") }}
                                    </button>
                                    <button
                                        v-if="model.probeSupported"
                                        class="models-text-button"
                                        type="button"
                                        :disabled="!!busy"
                                        @click="openProbe(model)"
                                    >
                                        {{ t("modelCatalogProbeAction") }}
                                    </button>
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="models-note models-list-note">{{ t("modelCatalogExposureNote") }}</p>
        </section>

        <el-dialog
            v-model="editorOpen"
            :title="t('modelCatalogEditTitle')"
            width="min(640px, 94vw)"
            :lock-scroll="false"
        >
            <div v-if="selectedModel" class="models-editor">
                <strong>{{ selectedModel.id }}</strong>
                <p v-if="editorError" class="models-alert" role="alert">{{ editorError }}</p>
                <label class="models-field">
                    <span>{{ t("modelCatalogAlias") }}</span>
                    <input v-model.trim="editAlias" maxlength="100" :placeholder="t('modelCatalogAliasPlaceholder')" />
                </label>
                <p class="models-note">{{ t("modelCatalogAliasHint") }}</p>
            </div>
            <template #footer>
                <button class="models-button" type="button" :disabled="!!busy" @click="editorOpen = false">
                    {{ t("cancel") }}
                </button>
                <button class="models-button is-primary" type="button" :disabled="!!busy" @click="saveModel">
                    {{ busy === "model" ? t("modelCatalogSaving") : t("modelCatalogSave") }}
                </button>
            </template>
        </el-dialog>

        <el-dialog
            v-model="probeOpen"
            :title="t('modelCatalogProbeTitle')"
            width="min(540px, 94vw)"
            :lock-scroll="false"
        >
            <div v-if="selectedProbeModel" class="models-probe-dialog">
                <strong>{{ selectedProbeModel.id }}</strong>
                <p class="models-note">{{ t("modelCatalogProbeRequestNote") }}</p>
                <p v-if="probeError" class="models-alert" role="alert">{{ probeError }}</p>
                <label class="models-field">
                    <span>{{ t("modelCatalogProbeAccount") }}</span>
                    <select v-model.number="probeAuthIndex" :disabled="!!busy || probeLoading">
                        <option
                            v-for="account in probeAccounts"
                            :key="account.index"
                            :value="account.index"
                            :disabled="!account.connected"
                        >
                            {{
                                t("modelCatalogProbeAccountOption", {
                                    index: accountDisplayIndex(runtimeAccounts, account.index),
                                })
                            }}
                            {{ account.connected ? "" : `· ${t("modelCatalogProbeDisconnected")}` }}
                        </option>
                    </select>
                </label>
                <p v-if="probeLoading" class="models-note">{{ t("loading") }}</p>
                <p v-else-if="!connectedProbeAccounts.length" class="models-note">
                    {{ t("modelCatalogProbeNoAccounts") }}
                </p>
                <div v-if="probeResult" class="models-probe-result" role="status">
                    <strong :class="probeClass(probeResult)">{{ probeStatusLabel(probeResult.status) }}</strong>
                    <span v-if="probeResult.httpStatus">HTTP {{ probeResult.httpStatus }}</span>
                </div>
                <div v-if="selectedProbeModel.probes?.length" class="models-probe-history">
                    <h3>{{ t("modelCatalogProbeHistory") }}</h3>
                    <div
                        v-for="probe in selectedProbeModel.probes"
                        :key="probe.accountKey"
                        class="models-probe-history-row"
                    >
                        <span>{{ t("modelCatalogProbeAccountOption", { index: probe.accountKey }) }}</span>
                        <strong :class="probeClass(probe)">{{ probeStatusLabel(probe.status) }}</strong>
                        <small
                            >{{ formatDate(probe.checkedAt)
                            }}{{ probe.stale ? ` · ${t("modelCatalogProbeStale")}` : "" }}</small
                        >
                    </div>
                </div>
            </div>
            <template #footer>
                <button class="models-button" type="button" :disabled="!!busy" @click="probeOpen = false">
                    {{ t("cancel") }}
                </button>
                <button
                    class="models-button is-primary"
                    type="button"
                    :disabled="!!busy || probeLoading || !connectedProbeAccounts.length"
                    @click="runProbe"
                >
                    {{ busy === "probe" ? t("modelCatalogProbeRunning") : t("modelCatalogProbeAction") }}
                </button>
            </template>
        </el-dialog>
    </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { accountDisplayIndex } from "../utils/accountNumbers";

const props = defineProps({
    runtimeAccounts: { default: () => [], type: Array },
    t: { required: true, type: Function },
});
const t = (key, options) => props.t(key, options);
const catalog = ref({ models: [] });
const busy = ref("");
const error = ref("");
const loaded = ref(false);
const search = ref("");
const exposureFilter = ref("all");
const capabilityFilter = ref("all");
const syncSource = ref("native");
const syncApiKey = ref("");
const newModelId = ref("");
const editorOpen = ref(false);
const editorError = ref("");
const selectedModel = ref(null);
const editAlias = ref("");
const thinkingDrafts = ref({});
const probeOpen = ref(false);
const probeLoading = ref(false);
const probeError = ref("");
const probeResult = ref(null);
const probeAccounts = ref([]);
const probeAuthIndex = ref(null);
const selectedProbeModelId = ref("");
const levelOrder = ["MINIMAL", "LOW", "MEDIUM", "HIGH"];

const models = computed(() => catalog.value.models || []);
const enabledCount = computed(() => models.value.filter(model => model.enabled).length);
const selectedProbeModel = computed(() => models.value.find(model => model.id === selectedProbeModelId.value));
const connectedProbeAccounts = computed(() => probeAccounts.value.filter(account => account.connected));
const filteredModels = computed(() => {
    const needle = search.value.toLocaleLowerCase();
    return models.value.filter(model => {
        if (exposureFilter.value === "enabled" && !model.enabled) return false;
        if (exposureFilter.value === "disabled" && model.enabled) return false;
        if (capabilityFilter.value === "level" && !availableLevels(model).length) return false;
        if (capabilityFilter.value === "other" && availableLevels(model).length) return false;
        return (
            !needle ||
            [model.id, model.alias, model.displayName, model.description].some(value =>
                String(value || "")
                    .toLocaleLowerCase()
                    .includes(needle)
            )
        );
    });
});

const availableLevels = model =>
    model?.capability?.kind === "level"
        ? levelOrder.filter(level =>
              (model.capability.levels || []).map(value => String(value).toUpperCase()).includes(level)
          )
        : [];
watch(syncSource, source => {
    if (source !== "google") syncApiKey.value = "";
});
const levelLabel = level => t(`modelCatalogLevel${level}`);
const thinkingStep = model => {
    if (Object.hasOwn(thinkingDrafts.value, model.id)) return thinkingDrafts.value[model.id];
    return Math.max(0, availableLevels(model).indexOf(model.thinkingPolicy?.level) + 1);
};
const setThinkingDraft = (model, step) => {
    thinkingDrafts.value = { ...thinkingDrafts.value, [model.id]: step };
};
const thinkingSelectionLabel = model => {
    const level = availableLevels(model)[thinkingStep(model) - 1];
    return level ? levelLabel(level) : t("modelCatalogDefault");
};
const thinkingDescription = model => {
    const level = availableLevels(model)[thinkingStep(model) - 1];
    if (level) return t(`modelCatalogLevel${level}Hint`);
    const defaultLevel = model.defaultThinkingLevel;
    return defaultLevel
        ? t("modelCatalogDefaultLevelHint", { level: levelLabel(defaultLevel) })
        : t("modelCatalogDefaultHint");
};
const sourceLabel = source => t(`modelCatalogSource${source || "Unknown"}`, { fallback: source || "—" });
const probeStatusLabel = status => t(`modelCatalogProbe${status || "unknown"}`);
const latestProbe = model =>
    Array.isArray(model.probes)
        ? [...model.probes].sort((left, right) => String(right.checkedAt).localeCompare(String(left.checkedAt)))[0]
        : null;
const probeClass = probe => {
    if (!probe) return "";
    return probe.stale ? "is-stale" : `is-${probe.status}`;
};
const probeSummary = model => {
    const probe = latestProbe(model);
    if (!probe) return t("modelCatalogProbeNotChecked");
    return `${probeStatusLabel(probe.status)} · #${accountDisplayIndex(props.runtimeAccounts, Number(probe.accountKey))}${probe.stale ? ` · ${t("modelCatalogProbeStale")}` : ""}`;
};
const formatDate = value => {
    if (!value) return t("modelCatalogNeverSynced");
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? t("modelCatalogNeverSynced")
        : date.toLocaleString(document.documentElement.lang);
};

const readResponse = async response => {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 || response.redirected) {
        window.location.href = "/login";
        throw new Error(t("runtimeSessionExpired"));
    }
    if (!response.ok) throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
    return payload;
};
const applyCatalog = payload => {
    if (!Array.isArray(payload.models)) {
        throw new Error(t("modelCatalogInvalidResponse"));
    }
    catalog.value = payload;
    thinkingDrafts.value = Object.fromEntries(
        payload.models.map(model => [
            model.id,
            Math.max(0, availableLevels(model).indexOf(model.thinkingPolicy?.level) + 1),
        ])
    );
    loaded.value = true;
};
const loadCatalog = async () => {
    if (busy.value) return;
    busy.value = "load";
    error.value = "";
    try {
        const response = await fetch("/api/models/catalog", {
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        applyCatalog(await readResponse(response));
    } catch (cause) {
        error.value = t("modelCatalogLoadFailed", { error: cause.message || cause });
    } finally {
        busy.value = "";
    }
};
const syncCatalog = async () => {
    if (busy.value || (syncSource.value === "google" && !syncApiKey.value)) return;
    busy.value = "sync";
    error.value = "";
    try {
        const body = { source: syncSource.value };
        if (syncSource.value === "google") body.apiKey = syncApiKey.value;
        const response = await fetch("/api/models/sync", {
            body: JSON.stringify(body),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "POST",
        });
        applyCatalog(await readResponse(response));
        ElMessage.success(t("modelCatalogSyncSuccess", { count: models.value.length }));
    } catch (cause) {
        error.value = t("modelCatalogSyncFailed", { error: cause.message || cause });
        ElMessage.error(error.value);
    } finally {
        syncApiKey.value = "";
        busy.value = "";
    }
};
const addModel = async () => {
    if (busy.value || !newModelId.value) return;
    const id = newModelId.value.replace(/^models\//i, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
        error.value = t("modelCatalogInvalidModelId");
        return;
    }
    busy.value = "add";
    error.value = "";
    try {
        const response = await fetch("/api/models/catalog", {
            body: JSON.stringify({ id }),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "POST",
        });
        applyCatalog(await readResponse(response));
        newModelId.value = "";
        ElMessage.success(t("modelCatalogAdded"));
    } catch (cause) {
        error.value = t("modelCatalogAddFailed", { error: cause.message || cause });
        ElMessage.error(error.value);
    } finally {
        busy.value = "";
    }
};
const setEnabled = async (model, enabled) => {
    if (busy.value) return;
    busy.value = "exposure";
    error.value = "";
    try {
        const response = await fetch(`/api/models/${encodeURIComponent(model.id)}`, {
            body: JSON.stringify({ enabled }),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "PATCH",
        });
        applyCatalog(await readResponse(response));
        ElMessage.success(enabled ? t("modelCatalogNowExposed") : t("modelCatalogNowHidden"));
    } catch (cause) {
        error.value = t("modelCatalogSaveFailed", { error: cause.message || cause });
        ElMessage.error(error.value);
    } finally {
        busy.value = "";
    }
};
const saveThinking = async (model, step) => {
    if (busy.value) return;
    const levels = availableLevels(model);
    if (!levels.length || !Number.isInteger(step) || step < 0 || step > levels.length) return;
    const originalStep = Math.max(0, levels.indexOf(model.thinkingPolicy?.level) + 1);
    setThinkingDraft(model, step);
    if (step === originalStep) return;
    busy.value = "thinking";
    error.value = "";
    try {
        const level = levels[step - 1];
        const response = await fetch(`/api/models/${encodeURIComponent(model.id)}`, {
            body: JSON.stringify({
                thinkingPolicy: level ? { level, mode: "force" } : { level: null, mode: "respect_client" },
            }),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "PATCH",
        });
        applyCatalog(await readResponse(response));
    } catch (cause) {
        setThinkingDraft(model, originalStep);
        error.value = t("modelCatalogSaveFailed", { error: cause.message || cause });
        ElMessage.error(error.value);
    } finally {
        busy.value = "";
    }
};
const openEditor = model => {
    selectedModel.value = model;
    editorError.value = "";
    editAlias.value = model.alias || "";
    editorOpen.value = true;
};
const saveModel = async () => {
    const model = selectedModel.value;
    if (busy.value || !model) return;
    if (editAlias.value && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(editAlias.value)) {
        editorError.value = t("modelCatalogInvalidAlias");
        return;
    }
    busy.value = "model";
    error.value = "";
    editorError.value = "";
    try {
        const response = await fetch(`/api/models/${encodeURIComponent(model.id)}`, {
            body: JSON.stringify({
                alias: editAlias.value.trim() || null,
            }),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "PATCH",
        });
        applyCatalog(await readResponse(response));
        editorOpen.value = false;
        ElMessage.success(t("modelCatalogSaved"));
    } catch (cause) {
        error.value = t("modelCatalogSaveFailed", { error: cause.message || cause });
        editorError.value = error.value;
        ElMessage.error(error.value);
    } finally {
        busy.value = "";
    }
};
const openProbe = async model => {
    if (busy.value || !model.probeSupported) return;
    selectedProbeModelId.value = model.id;
    probeOpen.value = true;
    probeResult.value = null;
    probeError.value = "";
    probeAccounts.value = [];
    probeAuthIndex.value = null;
    probeLoading.value = true;
    try {
        const response = await fetch("/api/models/probe-accounts", {
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        const payload = await readResponse(response);
        if (!Array.isArray(payload.accounts)) throw new Error(t("modelCatalogInvalidResponse"));
        probeAccounts.value = payload.accounts.filter(account => Number.isSafeInteger(account.index));
        const current = connectedProbeAccounts.value.find(account => account.index === payload.currentIndex);
        probeAuthIndex.value = current?.index ?? connectedProbeAccounts.value[0]?.index ?? null;
    } catch (cause) {
        probeError.value = t("modelCatalogProbeFailed", { error: cause.message || cause });
    } finally {
        probeLoading.value = false;
    }
};
const runProbe = async () => {
    const model = selectedProbeModel.value;
    if (busy.value || !model || !connectedProbeAccounts.value.some(account => account.index === probeAuthIndex.value)) {
        return;
    }
    busy.value = "probe";
    probeError.value = "";
    probeResult.value = null;
    try {
        const response = await fetch(`/api/models/${encodeURIComponent(model.id)}/probe`, {
            body: JSON.stringify({ authIndex: probeAuthIndex.value }),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "POST",
        });
        const result = await readResponse(response);
        if (!["available", "unavailable", "unknown"].includes(result.status)) {
            throw new Error(t("modelCatalogInvalidResponse"));
        }
        probeResult.value = result;
        const catalogResponse = await fetch("/api/models/catalog", {
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        applyCatalog(await readResponse(catalogResponse));
    } catch (cause) {
        probeError.value = t("modelCatalogProbeFailed", { error: cause.message || cause });
    } finally {
        busy.value = "";
    }
};

onMounted(loadCatalog);
</script>

<style scoped lang="less">
.models-view {
    color: var(--text-primary);
    display: grid;
    gap: 16px;
    min-width: 0;
}

.models-heading,
.models-panel-heading,
.models-sync-controls,
.models-filters {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
}

.models-heading,
.models-panel-heading {
    justify-content: space-between;
}

.models-heading h1 {
    font-size: clamp(1.5rem, 2.5vw, 2rem);
    margin: 2px 0 4px;
}

.models-heading p,
.models-panel-heading p {
    color: var(--text-secondary);
    line-height: 1.45;
    margin: 0;
}

.models-eyebrow {
    color: var(--color-primary) !important;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.models-summary {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
}

.models-summary-item,
.models-panel {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: 14px;
}

.models-summary-item {
    display: grid;
    gap: 5px;
    min-width: 0;
    padding: 15px 18px;

    span {
        color: var(--text-secondary);
        font-size: 0.78rem;
    }

    strong {
        font-size: 1.35rem;
        overflow-wrap: anywhere;
    }
}

.models-summary-time strong {
    font-size: 0.92rem;
}

.models-panel {
    padding: 18px;
}

.models-panel-heading h2 {
    font-size: 1rem;
    margin: 0 0 4px;
}

.models-panel-heading p,
.models-list-heading > span {
    font-size: 0.8rem;
}

.models-sync-controls,
.models-filters {
    margin-top: 16px;
}

.models-add {
    align-items: end;
    border-top: 1px solid var(--border-light);
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 16px;
    padding-top: 16px;

    .models-note {
        flex-basis: 100%;
        margin: 0;
    }
}

.models-add-field {
    flex: 1 1 240px;
}

.models-field {
    color: var(--text-secondary);
    display: grid;
    flex: 0 1 200px;
    font-size: 0.8rem;
    font-weight: 600;
    gap: 6px;
    min-width: 0;
}

.models-key {
    flex: 1 1 270px;
}

.models-field input,
.models-field select,
.models-filters input,
.models-filters select {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    color: var(--text-primary);
    font: inherit;
    min-height: 38px;
    padding: 7px 10px;
    width: 100%;
}

.models-filters input {
    flex: 2 1 250px;
}

.models-filters select {
    flex: 1 1 160px;
    width: auto;
}

.models-button {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    color: var(--text-primary);
    cursor: pointer;
    font: inherit;
    font-size: 0.82rem;
    font-weight: 650;
    min-height: 38px;
    padding: 8px 14px;

    &:hover:not(:disabled) {
        border-color: var(--color-primary);
        color: var(--color-primary);
    }

    &:disabled {
        cursor: not-allowed;
        opacity: 0.55;
    }

    &.is-primary {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: var(--text-on-primary);
    }
}

.models-sync-button {
    align-self: end;
}

.models-note {
    color: var(--text-secondary);
    font-size: 0.77rem;
    line-height: 1.5;
    margin: 12px 0 0;
}

.models-alert {
    background: rgba(var(--color-error-rgb), 0.1);
    border: 1px solid var(--color-error);
    border-radius: 8px;
    color: var(--color-error);
    font-size: 0.84rem;
    padding: 10px 14px;
}

.models-table-wrap {
    overflow-x: auto;
}

.models-table {
    border-collapse: collapse;
    font-size: 0.84rem;
    min-width: 900px;
    text-align: left;
    width: 100%;

    th,
    td {
        border-bottom: 1px solid var(--border-light);
        padding: 12px 10px;
        vertical-align: middle;
    }

    th {
        color: var(--text-secondary);
        font-size: 0.75rem;
        font-weight: 650;
    }

    tr:last-child td {
        border-bottom: 0;
    }
}

.models-identity {
    display: grid;
    gap: 3px;
    max-width: 450px;
    min-width: 200px;

    strong,
    code,
    small {
        overflow-wrap: anywhere;
    }

    code,
    small {
        color: var(--text-secondary);
        font-size: 0.73rem;
    }
}

.models-description {
    line-height: 1.35;
}

.models-source-tag {
    background: var(--bg-body);
    border-radius: 5px;
    color: var(--text-secondary);
    font-size: 0.7rem;
    justify-self: start;
    padding: 2px 6px;
}

.models-kind,
.models-exposure-text {
    display: block;
}

.models-exposure-text {
    color: var(--text-secondary);
    font-size: 0.73rem;
    margin-top: 5px;
}

.models-text-button {
    background: none;
    border: 0;
    color: var(--color-primary);
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    padding: 5px;

    &:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }
}

.models-row-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 125px;
}

.models-probe-summary {
    color: var(--text-secondary);
    font-size: 0.78rem;
    white-space: nowrap;
}

.is-available {
    color: var(--color-success);
}

.is-unavailable {
    color: var(--color-error);
}

.is-stale {
    color: var(--text-secondary);
}

.models-empty {
    color: var(--text-secondary);
    margin: 0;
    padding: 38px 12px;
    text-align: center;
}

.models-editor {
    display: grid;
    gap: 14px;

    > strong {
        overflow-wrap: anywhere;
    }

    .models-field {
        width: 100%;
    }

    .models-note {
        margin: -7px 0 0;
    }
}

.models-inline-thinking {
    display: grid;
    gap: 5px;
    min-width: 250px;
}

.models-thinking-heading {
    align-items: center;
    display: flex;
    justify-content: space-between;

    strong {
        font-size: 0.8rem;
    }

    span {
        color: var(--color-primary);
        font-size: 0.75rem;
        font-weight: 650;
    }
}

.models-thinking-slider {
    accent-color: var(--color-primary);
    cursor: pointer;
    width: 100%;

    &:disabled {
        cursor: not-allowed;
    }
}

.models-thinking-steps {
    display: grid;
    gap: 4px;
}

.models-thinking-step {
    background: transparent;
    border: 0;
    border-radius: 8px;
    color: var(--text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 0.7rem;
    padding: 4px 1px;
    text-align: center;

    &.is-selected {
        background: var(--bg-card);
        color: var(--color-primary);
        font-weight: 700;
    }

    &:disabled {
        cursor: not-allowed;
    }
}

.models-thinking-hint {
    color: var(--text-secondary);
    font-size: 0.72rem;
    line-height: 1.35;
}

.models-probe-dialog {
    display: grid;
    gap: 14px;

    > strong {
        overflow-wrap: anywhere;
    }

    .models-field {
        width: 100%;
    }

    .models-note {
        margin: 0;
    }
}

.models-probe-result {
    align-items: center;
    background: var(--bg-body);
    border-radius: 8px;
    display: flex;
    gap: 8px;
    padding: 10px;
}

.models-probe-history {
    border-top: 1px solid var(--border-light);
    display: grid;
    gap: 8px;
    padding-top: 12px;

    h3 {
        font-size: 0.86rem;
        margin: 0;
    }
}

.models-probe-history-row {
    align-items: center;
    background: var(--bg-body);
    border-radius: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 10px;

    strong {
        margin-left: auto;
    }

    small {
        color: var(--text-secondary);
        flex-basis: 100%;
    }
}

@media (max-width: 800px) {
    .models-summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 520px) {
    .models-heading {
        align-items: flex-start;
    }

    .models-summary {
        gap: 6px;
    }

    .models-summary-item {
        padding: 12px;
    }

    .models-panel {
        padding: 14px;
    }

    .models-field,
    .models-sync-button {
        flex: 1 1 100%;
    }
}
</style>
