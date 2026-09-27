<template>
    <section class="status-card api-keys-card" aria-labelledby="api-keys-title">
        <div class="api-keys-heading">
            <div>
                <h2 id="api-keys-title">{{ t("apiKeysTitle") }}</h2>
                <p>{{ t("apiKeysDescription") }}</p>
            </div>
            <span class="api-keys-count">{{ t("apiKeysCount", { count: keys.length }) }}</span>
        </div>

        <div v-if="error" class="api-keys-error" role="alert">{{ error }}</div>

        <form class="api-keys-create" @submit.prevent="createKey">
            <label for="api-key-name">{{ t("apiKeysName") }}</label>
            <div class="api-keys-create-controls">
                <input
                    id="api-key-name"
                    v-model="name"
                    type="text"
                    maxlength="80"
                    autocomplete="off"
                    :placeholder="t('apiKeysNamePlaceholder')"
                    :disabled="!!busy"
                />
                <button class="api-keys-button is-primary" type="submit" :disabled="!!busy">
                    {{ busy === "creating" ? t("apiKeysCreating") : t("apiKeysGenerate") }}
                </button>
            </div>
        </form>

        <div v-if="createdKey" class="api-keys-created" role="status">
            <div>
                <strong>{{ t("apiKeysCreatedTitle") }}</strong>
                <p>{{ t("apiKeysCreatedHint") }}</p>
            </div>
            <div class="api-keys-secret-row">
                <input
                    :value="createdKey"
                    type="text"
                    readonly
                    spellcheck="false"
                    :aria-label="t('apiKeysCreatedTitle')"
                />
                <button class="api-keys-button is-primary" type="button" @click="copyCreatedKey">
                    {{ t("apiKeysCopy") }}
                </button>
                <button class="api-keys-button" type="button" @click="dismissCreatedKey">
                    {{ t("apiKeysDismiss") }}
                </button>
            </div>
        </div>

        <div class="api-keys-list-heading">
            <h3>{{ t("apiKeysExisting") }}</h3>
            <button class="api-keys-button" type="button" :disabled="!!busy" @click="loadKeys">
                {{ t("apiKeysRefresh") }}
            </button>
        </div>
        <p v-if="busy === 'loading' && !loaded" class="api-keys-empty">{{ t("loading") }}</p>
        <p v-else-if="loaded && !keys.length" class="api-keys-empty">{{ t("apiKeysEmpty") }}</p>
        <div v-else class="api-keys-list">
            <div v-for="key in keys" :key="key.id" class="api-keys-item">
                <div class="api-keys-identity">
                    <strong>{{ displayName(key) }}</strong>
                    <code>{{ key.prefix }}</code>
                    <small>
                        {{ formatCreatedAt(key.createdAt) }}
                        <span v-if="key.source === 'legacy'">· {{ t("apiKeysMigrated") }}</span>
                    </small>
                </div>
                <div class="api-keys-item-actions">
                    <button
                        class="api-keys-button"
                        type="button"
                        :disabled="!!busy"
                        :aria-label="t('apiKeysCopyNamed', { name: displayName(key) })"
                        @click="copyKey(key)"
                    >
                        {{ t("apiKeysCopy") }}
                    </button>
                    <button
                        class="api-keys-button is-danger"
                        type="button"
                        :disabled="!!busy"
                        :aria-label="t('apiKeysRevokeNamed', { name: displayName(key) })"
                        @click="revokeKey(key)"
                    >
                        {{ t("apiKeysRevoke") }}
                    </button>
                </div>
            </div>
        </div>
        <p class="api-keys-footnote">{{ t("apiKeysExistingHint") }}</p>
    </section>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";

const props = defineProps({
    t: { required: true, type: Function },
});
const t = (key, options) => props.t(key, options);
const displayName = key => {
    const imported = key.source === "legacy" && /^Imported key (\d+)$/.exec(key.name || "");
    return imported ? t("apiKeysImportedName", { number: imported[1] }) : key.name || t("apiKeysUnnamed");
};

const keys = ref([]);
const name = ref("");
const createdKey = ref("");
const createdKeyId = ref("");
const loaded = ref(false);
const busy = ref("");
const error = ref("");

const readResponse = async response => {
    if (response.status === 204) return {};
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
        window.location.href = "/login";
        throw new Error(t("runtimeSessionExpired"));
    }
    if (response.status === 403) {
        throw new Error(t("apiKeysConsolePasswordRequired"));
    }
    if (!response.ok) throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
    return payload;
};

const loadKeys = async () => {
    if (busy.value) return;
    busy.value = "loading";
    error.value = "";
    try {
        const response = await fetch("/api/settings/api-keys", {
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        const payload = await readResponse(response);
        if (!Array.isArray(payload.keys)) throw new Error(t("apiKeysInvalidResponse"));
        keys.value = payload.keys;
        loaded.value = true;
    } catch (cause) {
        error.value = t("apiKeysLoadFailed", { error: cause.message || cause });
    } finally {
        busy.value = "";
    }
};

const createKey = async () => {
    if (busy.value) return;
    busy.value = "creating";
    error.value = "";
    try {
        const response = await fetch("/api/settings/api-keys", {
            body: JSON.stringify({ name: name.value.trim() }),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "POST",
        });
        const payload = await readResponse(response);
        if (typeof payload.key !== "string" || !payload.record?.id) {
            throw new Error(t("apiKeysInvalidResponse"));
        }
        createdKey.value = payload.key;
        createdKeyId.value = payload.record.id;
        keys.value = [...keys.value, payload.record];
        loaded.value = true;
        name.value = "";
        ElMessage.success(t("apiKeysCreateSuccess"));
    } catch (cause) {
        error.value = t("apiKeysCreateFailed", { error: cause.message || cause });
        ElMessage.error(error.value);
    } finally {
        busy.value = "";
    }
};

const writeClipboard = async value => {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return;
        } catch {
            // Some browsers expose Clipboard API but deny writes on an HTTP origin.
        }
    }
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    try {
        input.select();
        if (!document.execCommand("copy")) throw new Error(t("apiKeysCopyFailed"));
    } finally {
        input.remove();
    }
};

const copyCreatedKey = async () => {
    if (!createdKey.value) return;
    try {
        await writeClipboard(createdKey.value);
        ElMessage.success(t("apiKeysCopied"));
    } catch {
        ElMessage.error(t("apiKeysCopyFailed"));
    }
};

const copyKey = async key => {
    if (busy.value) return;
    busy.value = "copying";
    error.value = "";
    try {
        const response = await fetch(`/api/settings/api-keys/${encodeURIComponent(key.id)}/secret`, {
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        const payload = await readResponse(response);
        if (typeof payload.key !== "string") throw new Error(t("apiKeysInvalidResponse"));
        await writeClipboard(payload.key);
        ElMessage.success(t("apiKeysCopied"));
    } catch (cause) {
        error.value = t("apiKeysCopyExistingFailed", { error: cause.message || cause });
        ElMessage.error(error.value);
    } finally {
        busy.value = "";
    }
};

const dismissCreatedKey = () => {
    createdKey.value = "";
    createdKeyId.value = "";
};

const revokeKey = async key => {
    if (busy.value) return;
    try {
        await ElMessageBox.confirm(t("apiKeysRevokeConfirm", { name: displayName(key) }), t("apiKeysRevoke"), {
            cancelButtonText: t("cancel"),
            confirmButtonText: t("apiKeysRevoke"),
            lockScroll: false,
            type: "warning",
        });
    } catch {
        return;
    }
    busy.value = "revoking";
    error.value = "";
    try {
        const response = await fetch(`/api/settings/api-keys/${encodeURIComponent(key.id)}`, {
            headers: { Accept: "application/json" },
            method: "DELETE",
        });
        await readResponse(response);
        keys.value = keys.value.filter(item => item.id !== key.id);
        if (createdKeyId.value === key.id) dismissCreatedKey();
        ElMessage.success(t("apiKeysRevoked"));
    } catch (cause) {
        error.value = t("apiKeysRevokeFailed", { error: cause.message || cause });
        ElMessage.error(error.value);
    } finally {
        busy.value = "";
    }
};

const formatCreatedAt = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(document.documentElement.lang || "en");
};

onMounted(loadKeys);
</script>

<style scoped lang="less">
.api-keys-card {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: 16px;
    margin-bottom: 16px;
    padding: 20px 24px;
}

.api-keys-heading,
.api-keys-list-heading {
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    justify-content: space-between;
}

.api-keys-heading {
    border-bottom: 1px solid var(--border-light);
    padding-bottom: 14px;

    h2 {
        font-size: 1rem;
        margin: 0 0 5px;
    }

    p {
        color: var(--text-secondary);
        font-size: 0.82rem;
        line-height: 1.5;
        margin: 0;
    }
}

.api-keys-count {
    background: var(--bg-body);
    border-radius: 99px;
    color: var(--text-secondary);
    font-size: 0.76rem;
    padding: 5px 10px;
}

.api-keys-create {
    margin: 18px 0;

    label {
        display: block;
        font-size: 0.85rem;
        font-weight: 650;
        margin-bottom: 8px;
    }
}

.api-keys-create-controls,
.api-keys-secret-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    input {
        background: var(--bg-card);
        border: 1px solid var(--border-light);
        border-radius: 8px;
        color: var(--text-primary);
        flex: 1 1 260px;
        font: inherit;
        min-width: 0;
        padding: 9px 11px;
    }
}

.api-keys-secret-row input {
    font-family: monospace;
    font-size: 0.79rem;
}

.api-keys-button {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: 8px;
    color: var(--text-primary);
    cursor: pointer;
    font: inherit;
    font-size: 0.79rem;
    font-weight: 650;
    padding: 8px 13px;

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
        color: white;
    }

    &.is-danger {
        color: var(--color-error);
    }
}

.api-keys-created {
    background: var(--bg-body);
    border: 1px solid var(--color-primary);
    border-radius: 10px;
    margin-bottom: 20px;
    padding: 14px;

    strong {
        font-size: 0.87rem;
    }

    p {
        color: var(--text-secondary);
        font-size: 0.78rem;
        margin: 5px 0 11px;
    }
}

.api-keys-list-heading {
    align-items: center;
    border-top: 1px solid var(--border-light);
    padding-top: 15px;

    h3 {
        font-size: 0.9rem;
        margin: 0;
    }
}

.api-keys-list {
    display: grid;
    gap: 8px;
    margin-top: 12px;
}

.api-keys-item {
    align-items: center;
    background: var(--bg-body);
    border: 1px solid var(--border-light);
    border-radius: 9px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    justify-content: space-between;
    padding: 11px 13px;
}

.api-keys-item-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.api-keys-identity {
    display: grid;
    gap: 2px;
    min-width: 0;

    strong {
        font-size: 0.84rem;
        overflow-wrap: anywhere;
    }

    code,
    small {
        color: var(--text-secondary);
        font-size: 0.74rem;
    }
}

.api-keys-empty,
.api-keys-footnote {
    color: var(--text-secondary);
    font-size: 0.78rem;
    line-height: 1.5;
    margin: 12px 0 0;
}

.api-keys-error {
    background: var(--bg-body);
    border-radius: 8px;
    color: var(--color-error);
    font-size: 0.82rem;
    margin-top: 14px;
    padding: 10px 12px;
}
</style>
