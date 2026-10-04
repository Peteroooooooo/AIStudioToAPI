<template>
    <component
        :is="interactive ? 'button' : 'span'"
        v-if="record.conversationId"
        class="mm-conversation-tag"
        :title="title"
        @click="select"
    >
        {{ conversationLabel(record, m) }}
        <span
            >·
            {{
                m(
                    record.conversationMatch === "history_unmatched"
                        ? "conversationUnmatched"
                        : record.conversationReused
                          ? "continued"
                          : "firstSeen"
                )
            }}</span
        >
        <span v-if="record.conversationSource === 'history' && record.conversationReused"
            >· {{ m("historyMatch") }}</span
        >
    </component>
</template>
<script setup>
import { computed, inject } from "vue";
import { conversationLabel } from "./format";
const props = defineProps({ interactive: { default: true, type: Boolean }, record: { required: true, type: Object } });
const emit = defineEmits(["select"]);
const { m } = inject("monitor");
const title = computed(() => {
    const r = props.record;
    const identity =
        r.conversationMatch === "history_unmatched"
            ? "historyUnmatchedIdentity"
            : r.conversationSource === "session"
              ? "sessionIdentity"
              : r.conversationReused
                ? "historyIdentity"
                : "firstIdentity";
    return [m(identity), r.conversationConfigChanged ? m("conversationConfigChanged") : null, m("viewConversation")]
        .filter(Boolean)
        .join(" · ");
});
const select = event => {
    if (!props.interactive) return;
    event.stopPropagation();
    emit("select", props.record.conversationId);
};
</script>
