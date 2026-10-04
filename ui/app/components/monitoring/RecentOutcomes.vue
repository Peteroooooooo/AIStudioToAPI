<template>
    <div class="mm-recent" :aria-label="m('recentHint')">
        <span
            v-for="(item, index) in items"
            :key="index"
            :class="`is-${item.outcome || 'unknown'}`"
            :title="`${m(item.outcome || 'unknown')} · ${time(item.startedAt)} · ${item.statusCode ?? '—'}`"
        ></span>
        <small v-if="!items.length">—</small>
    </div>
</template>
<script setup>
import { inject } from "vue";
import { time } from "./format";
defineProps({ items: { default: () => [], type: Array } });
const { m } = inject("monitor");
</script>
