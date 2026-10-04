<template>
    <div class="account-actions">
        <el-button
            class="account-test-button"
            size="small"
            :disabled="testDisabled"
            :title="testTitle"
            @click="testAccount"
        >
            {{ t(testLabel) }}
        </el-button>
        <el-switch
            :model-value="accountEnabled(account)"
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
import { accountEnabled } from "../utils/runtimeLabels";

const props = defineProps({
    account: { required: true, type: Object },
    isBusy: { default: false, type: Boolean },
    t: { required: true, type: Function },
});
const emit = defineEmits(["delete", "details", "download", "health", "reauth", "test"]);
const canReauthenticate = computed(
    () => !props.account.isInvalid && (props.account.isExpired || props.account.health?.mode === "reauth")
);
const canRetry = computed(() => canReauthenticate.value && props.account.health?.mode !== "disabled");
const testDisabled = computed(
    () =>
        props.isBusy ||
        props.account.isInvalid ||
        props.account.lastTest?.status === "running" ||
        Boolean(
            props.account.inFlight ||
            props.account.waiting ||
            props.account.activity?.generation ||
            props.account.activity?.maintenance
        )
);
const testLabel = computed(() =>
    canReauthenticate.value
        ? "accountUpdateAuth"
        : props.account.lastTest?.status === "running"
          ? "accountTestCompact_running"
          : "accountTestButton"
);
const testTitle = computed(() =>
    props.account.inFlight || props.account.waiting || props.account.activity?.generation
        ? props.t("accountTestBusyShort")
        : ""
);
const testAccount = () => {
    if (!testDisabled.value) emit(canReauthenticate.value ? "reauth" : "test", props.account.index);
};
const toggleEnabled = () => {
    if (!props.isBusy && !props.account.isInvalid) {
        emit("health", props.account, accountEnabled(props.account) ? "disable" : "enable");
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
