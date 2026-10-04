<template>
    <header class="mm-heading">
        <h1>{{ m("title") }}</h1>
        <div class="mm-update">
            <span class="mm-badge" :class="connected ? 'is-success' : 'is-error'">{{
                m(connected ? "connected" : "disconnected")
            }}</span
            ><small>{{ m("updated") }} {{ time(updatedAt, true) }}</small>
        </div>
    </header>
    <div class="mm-card mm-toolbar">
        <div>
            <button class="mm-button mm-primary" :disabled="busy" @click="$emit('import')">{{ m("import") }}</button
            ><button class="mm-button" :disabled="busy" @click="$emit('export')">{{ m("export") }}</button
            ><button
                class="mm-button"
                :disabled="busy || invalid || filteredExportDisabled"
                @click="$emit('export-filtered')"
            >
                {{ m("exportFiltered") }}
            </button>
        </div>
        <div>
            <button class="mm-button" :class="{ 'mm-failure-selected': failuresOnly }" @click="$emit('failures')">
                {{ m("failuresOnly") }}</button
            ><button class="mm-button" @click="$emit('pause')">{{ m(paused ? "resume" : "pause") }}</button
            ><button class="mm-button" :disabled="refreshing || invalid" @click="$emit('refresh')">
                {{ m("refresh") }}<span v-if="refreshing">…</span>
            </button>
        </div>
    </div>
</template>
<script setup>
import { inject } from "vue";
import { time } from "./format";
defineProps({
    busy: Boolean,
    connected: Boolean,
    failuresOnly: Boolean,
    filteredExportDisabled: Boolean,
    invalid: Boolean,
    paused: Boolean,
    refreshing: Boolean,
    updatedAt: { default: "", type: String },
});
defineEmits(["import", "export", "export-filtered", "failures", "pause", "refresh"]);
const { m } = inject("monitor");
</script>
