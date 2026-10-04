<template>
    <span class="mm-badge" :class="`is-${outcome}`">{{ m(outcome || "unknown") }}</span>
</template>
<script setup>
import { inject } from "vue";
defineProps({ outcome: { default: "unknown", type: String } });
const { m } = inject("monitor");
</script>
