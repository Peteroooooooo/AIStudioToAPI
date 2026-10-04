<template>
    <span v-if="account" class="mm-account-status" :class="`is-${state.tone}`"><span>●</span> {{ t(state.label) }}</span
    ><span v-else class="mm-muted">{{ m("runtimeUnknown") }}</span>
</template>
<script setup>
import { computed, inject } from "vue";
import { accountStatus } from "../../utils/runtimeLabels";
const props = defineProps({ account: { default: null, type: Object }, stale: Boolean });
const { m, t } = inject("monitor");
const state = computed(() => accountStatus({ ...props.account, statusStale: props.stale }));
</script>
