<template>
    <RequestMonitorPage
        ref="page"
        v-bind="$attrs"
        :focus-request-id="focusRequestId"
        :language-version="languageVersion"
        :transfer-busy="transferBusy"
    />
</template>
<script setup>
import { ref } from "vue";
import RequestMonitorPage from "./RequestMonitorPage.vue";
defineOptions({ inheritAttrs: false });
defineProps({
    focusRequestId: { default: "", type: String },
    languageVersion: { default: 0, type: Number },
    transferBusy: Boolean,
});
const page = ref(null);
defineExpose({
    focusRequest: id => page.value?.focusRequest(id),
    refresh: () => page.value?.refresh(),
    refreshAfterImport: () => page.value?.refreshAfterImport(),
});
</script>
