<template>
    <div
        class="mm-token"
        :title="`${m('input')}: ${number(usage?.inputTokens)} · ${m('output')}: ${number(usage?.outputTokens)} · ${m('cached')}: ${number(usage?.cachedInputTokens)}`"
    >
        <div>
            <span>↑ {{ compact(usage?.inputTokens) }}</span
            ><span>↓ {{ compact(usage?.outputTokens) }}</span>
        </div>
        <small :class="{ 'mm-danger': cacheAnomaly(usage) }">{{
            cacheAnomaly(usage) ? m("countAnomaly") : `${m("cached")} ${compact(usage?.cachedInputTokens)}`
        }}</small>
    </div>
</template>
<script setup>
import { inject } from "vue";
import { number, compact, cacheAnomaly } from "./format";
defineProps({ usage: { default: null, type: Object } });
const { m } = inject("monitor");
</script>
