<template>
    <div class="account-actions">
        <el-switch
            :model-value="account.health?.mode !== 'disabled'"
            :disabled="isBusy || account.isInvalid"
            :aria-label="t('accountsEnabledNamed', { index: account.index })"
            :before-change="toggleEnabled"
        />
        <el-dropdown trigger="click" @command="handleCommand">
            <button type="button" class="account-more" :aria-label="t('accountsMoreNamed', { index: account.index })">
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <circle cx="5" cy="12" r="2" />
                    <circle cx="12" cy="12" r="2" />
                    <circle cx="19" cy="12" r="2" />
                </svg>
            </button>
            <template #dropdown>
                <el-dropdown-menu>
                    <el-dropdown-item command="details">{{ t("usageDetails") }}</el-dropdown-item>
                    <el-dropdown-item v-if="canRetry" command="retry" :disabled="isBusy">
                        {{ t("accountsRetryWithoutReauth") }}
                    </el-dropdown-item>
                    <el-dropdown-item
                        v-if="account.health?.mode === 'cooldown' && !account.isInvalid"
                        command="reset"
                        :disabled="isBusy"
                    >
                        {{ t("accountsClearCooldown") }}
                    </el-dropdown-item>
                    <el-dropdown-item v-if="canReauthenticate" command="reauth" :disabled="isBusy">
                        {{ t("accountsReauthenticate") }}
                    </el-dropdown-item>
                    <el-dropdown-item command="download" :disabled="isBusy" divided>
                        {{ t("download") }}
                    </el-dropdown-item>
                    <el-dropdown-item command="delete" :disabled="isBusy">
                        {{ t("btnDeleteUser") }}
                    </el-dropdown-item>
                </el-dropdown-menu>
            </template>
        </el-dropdown>
    </div>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
    account: { required: true, type: Object },
    isBusy: { default: false, type: Boolean },
    t: { required: true, type: Function },
});
const emit = defineEmits(["delete", "details", "download", "health", "reauth"]);
const canReauthenticate = computed(
    () => !props.account.isInvalid && (props.account.isExpired || props.account.health?.mode === "reauth")
);
const canRetry = computed(() => canReauthenticate.value && props.account.health?.mode !== "disabled");
const toggleEnabled = () => {
    if (!props.isBusy && !props.account.isInvalid) {
        emit("health", props.account, props.account.health?.mode === "disabled" ? "enable" : "disable");
    }
    // The server response updates the switch; failed requests keep its previous value.
    return false;
};
const handleCommand = command => {
    if (command === "details") emit("details", props.account);
    else if (!props.isBusy) {
        if (command === "retry" || command === "reset") emit("health", props.account);
        else emit(command, props.account.index);
    }
};
</script>

<style scoped>
.account-actions {
    display: flex;
    align-items: center;
    gap: 12px;
}
.account-more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
}
.account-more svg {
    fill: currentColor;
}
.account-more:hover {
    background: var(--bg-body);
    color: var(--color-primary);
}
.account-more:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
}
</style>
