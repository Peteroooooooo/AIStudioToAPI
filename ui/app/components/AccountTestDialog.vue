<template>
    <el-dialog
        :model-value="visible"
        :title="t('accountTestRequest')"
        width="min(94vw, 580px)"
        :close-on-click-modal="!running"
        :close-on-press-escape="!running"
        :show-close="!running"
        @update:model-value="$emit('update:visible', $event)"
    >
        <template v-if="account">
            <p class="test-account">
                <strong>#{{ account.displayIndex }} {{ account.name }}</strong>
            </p>
            <p class="test-help">{{ t("accountTestExplanation") }}</p>
            <label class="test-model"
                >{{ t("requestModel") }}
                <select v-model="model" :disabled="running || loading">
                    <option v-for="item in models" :key="item.id" :value="item.id">
                        {{ item.displayName || item.id }} ({{ item.id }})
                    </option>
                </select>
            </label>
            <p v-if="loadError" class="test-error" role="alert">{{ loadError }}</p>
            <p v-if="running" class="test-progress" role="status">{{ t(progressKey) }} · {{ elapsed }}s</p>
            <section v-if="result" class="test-result" :class="`is-${result.status}`" aria-live="polite">
                <strong>{{ t(`accountTestStatus_${result.status}`) }}</strong>
                <p v-if="result.reason">{{ t(`accountTestReason_${result.reason}`) }}</p>
                <dl>
                    <div>
                        <dt>{{ t("account") }}</dt>
                        <dd>#{{ result.accountIndex === account.index ? account.displayIndex : "—" }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("requestModel") }}</dt>
                        <dd>{{ result.model }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("accountTestTime") }}</dt>
                        <dd>{{ result.checkedAt ? new Date(result.checkedAt).toLocaleString() : "—" }}</dd>
                    </div>
                    <div>
                        <dt>{{ t("accountTestDuration") }}</dt>
                        <dd>{{ result.durationMs == null ? "—" : `${(result.durationMs / 1000).toFixed(1)}s` }}</dd>
                    </div>
                    <div v-if="result.startupDurationMs != null">
                        <dt>{{ t("accountTestStartupDuration") }}</dt>
                        <dd>{{ (result.startupDurationMs / 1000).toFixed(1) }}s</dd>
                    </div>
                    <div v-if="result.requestDurationMs != null">
                        <dt>{{ t("accountTestRequestDuration") }}</dt>
                        <dd>{{ (result.requestDurationMs / 1000).toFixed(1) }}s</dd>
                    </div>
                    <div>
                        <dt>{{ t("accountTestUpstreamStatus") }}</dt>
                        <dd>{{ result.upstreamStatusCode || "—" }}</dd>
                    </div>
                    <div v-if="result.requestId">
                        <dt>{{ t("requestId") }}</dt>
                        <dd>{{ result.requestId }}</dd>
                    </div>
                </dl>
                <template v-if="result.responseText"
                    ><strong>{{ t("accountTestOutput") }}</strong>
                    <pre>{{ result.responseText }}</pre>
                </template>
                <details v-if="result.error">
                    <summary>{{ t("accountTestErrorDetails") }}</summary>
                    <pre>{{ result.error }}</pre>
                </details>
                <p class="test-help">{{ t("accountTestScope") }}</p>
            </section>
        </template>
        <template #footer>
            <el-button v-if="running" @click="cancel">{{ t("accountTestCancel") }}</el-button>
            <el-button v-else @click="$emit('update:visible', false)">{{ t("accountTestClose") }}</el-button>
            <el-button
                type="primary"
                :loading="running"
                :disabled="loading || !model || running || !!loadError"
                @click="run"
                >{{ t("accountTestStart") }}</el-button
            >
        </template>
    </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
const props = defineProps({
    account: { default: null, type: Object },
    autoRun: { default: false, type: Boolean },
    t: { required: true, type: Function },
    visible: { default: false, type: Boolean },
});
const emit = defineEmits(["completed", "update:visible"]);
const t = (key, options) => props.t(key, options);
const model = ref("");
const models = ref([]);
const loading = ref(false);
const loadError = ref("");
const running = ref(false);
const result = ref(null);
const elapsed = ref(0);
const progressKey = computed(() => {
    const current = props.account?.lastTest;
    if (current?.status !== "running") return "accountTestStarting";
    if (current.stage === "opening") return "accountTestOpening";
    return current.phase === "reading_response" ? "accountTestReading" : "accountTestProgress";
});
let controller,
    timer,
    loadGeneration = 0;
const stopTimer = () => {
    if (timer) window.clearInterval(timer);
    timer = null;
};
watch([() => props.visible, () => props.account?.index], async ([visible]) => {
    if (!visible) return;
    result.value = props.account?.lastTest || null;
    const generation = ++loadGeneration;
    loading.value = true;
    loadError.value = "";
    try {
        const response = await fetch("/api/models/catalog", { headers: { Accept: "application/json" } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (generation !== loadGeneration) return;
        models.value = (data.models || []).filter(item => item.enabled && item.probeSupported);
        const remembered = window.localStorage.getItem(`account-test-model-${props.account.index}`);
        const preferred = props.account.health?.failureModel || result.value?.model || remembered || "gemini-3.8-flash";
        model.value = models.value.find(item => item.id === preferred)?.id || models.value[0]?.id || "";
        if (!model.value) loadError.value = t("accountTestReason_model_unavailable");
    } catch (error) {
        if (generation === loadGeneration) loadError.value = error.message;
    } finally {
        if (generation === loadGeneration) loading.value = false;
    }
    if (
        generation === loadGeneration &&
        props.visible &&
        !loadError.value &&
        props.autoRun &&
        (props.account.health?.failureModel || result.value?.model || rememberedModel())
    )
        run();
});
const rememberedModel = () => window.localStorage.getItem(`account-test-model-${props.account.index}`);
const cancel = () => controller?.abort();
const run = async () => {
    if (running.value || loading.value || loadError.value || !props.account || !model.value) return;
    const accountIndex = props.account.index;
    const selectedModel = model.value;
    window.localStorage.setItem(`account-test-model-${accountIndex}`, selectedModel);
    running.value = true;
    result.value = null;
    elapsed.value = 0;
    const started = Date.now();
    controller = new AbortController();
    timer = window.setInterval(() => {
        elapsed.value = Math.floor((Date.now() - started) / 1000);
    }, 1000);
    try {
        const response = await fetch(`/api/accounts/${accountIndex}/test`, {
            body: JSON.stringify({ model: selectedModel, recovery: true }),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "POST",
            signal: controller.signal,
        });
        const data = await response.json();
        if (!data.status) throw new Error(data.error || `HTTP ${response.status}`);
        result.value = data;
    } catch (error) {
        result.value = {
            accountIndex,
            checkedAt: new Date(started).toISOString(),
            durationMs: Date.now() - started,
            error: error.name === "AbortError" ? null : error.message,
            model: selectedModel,
            reason: error.name === "AbortError" ? "cancelled" : "network_error",
            status: "not_tested",
        };
    } finally {
        stopTimer();
        running.value = false;
        controller = null;
        emit("completed");
    }
};
onBeforeUnmount(() => {
    ++loadGeneration;
    cancel();
    stopTimer();
});
</script>

<style scoped>
.test-account {
    overflow-wrap: anywhere;
}
.test-help {
    color: var(--text-secondary);
    line-height: 1.6;
    font-size: 0.85rem;
}
.test-model {
    display: grid;
    gap: 8px;
}
.test-model select {
    width: 100%;
    min-height: 36px;
    color: var(--text-primary);
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 6px;
}
.test-progress {
    color: var(--color-primary);
}
.test-error,
.test-result.is-failed > strong {
    color: var(--color-error);
}
.test-result {
    margin-top: 16px;
    padding: 14px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
}
.test-result.is-success > strong {
    color: var(--color-success);
}
.test-result dl > div {
    display: grid;
    grid-template-columns: 110px minmax(0, 1fr);
    gap: 8px;
    margin: 8px 0;
}
.test-result dt {
    color: var(--text-secondary);
}
.test-result dd {
    margin: 0;
    overflow-wrap: anywhere;
}
.test-result pre {
    margin: 8px 0;
    padding: 10px;
    background: var(--bg-body);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
</style>
