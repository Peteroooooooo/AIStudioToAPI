<template>
    <section class="mm-card mm-filters" :aria-label="m('filter')">
        <div class="mm-filter-top">
            <div class="mm-segment">
                <button
                    v-for="item in ranges"
                    :key="item[0]"
                    :class="{ active: query.range === item[0] }"
                    @click="change('range', item[0])"
                >
                    {{ m(item[1]) }}
                </button>
            </div>
            <input
                class="mm-search"
                type="search"
                :value="query.q"
                :placeholder="m('search')"
                :aria-label="m('search')"
                @input="change('q', $event.target.value)"
            />
        </div>
        <div v-if="query.range === 'custom'" class="mm-date-range">
            <input
                type="datetime-local"
                :value="query.from"
                :aria-label="m('started')"
                @input="change('from', $event.target.value)"
            /><span>—</span
            ><input
                type="datetime-local"
                :value="query.to"
                :aria-label="m('finished')"
                @input="change('to', $event.target.value)"
            />
        </div>
        <div class="mm-filter-row">
            <label
                ><span>{{ m("scope") }}</span
                ><select :value="scope" :disabled="scopeLocked" @change="change('scope', $event.target.value)">
                    <option value="requests">{{ m("requests") }}</option>
                    <option value="attempts">{{ m("attempts") }}</option>
                </select></label
            >
            <label
                ><span>{{ m("account") }}</span
                ><select :value="query.accountKey" @change="change('accountKey', $event.target.value)">
                    <option value="">{{ m("all") }}</option>
                    <option value="unassigned">{{ m("unassigned") }}</option>
                    <option
                        v-for="item in options.accounts?.filter(a => a.accountKey !== 'unassigned')"
                        :key="item.accountKey"
                        :value="item.accountKey"
                    >
                        {{ item.unattributed ? m("unattributed") : account(item) }}
                    </option>
                </select></label
            >
            <label
                ><span>{{ m("model") }}</span
                ><select :value="query.model" @change="change('model', $event.target.value)">
                    <option value="">{{ m("all") }}</option>
                    <option v-for="item in options.models" :key="item" :value="item">{{ item }}</option>
                </select></label
            >
            <label
                ><span>{{ m("outcome") }}</span
                ><select :value="query.outcome" @change="change('outcome', $event.target.value)">
                    <option value="">{{ m("all") }}</option>
                    <option v-for="item in ['success', 'error', 'aborted', 'unknown']" :key="item" :value="item">
                        {{ m(item) }}
                    </option>
                </select></label
            >
            <button
                class="mm-button"
                :class="{ active: expanded }"
                :aria-expanded="expanded"
                @click="expanded = !expanded"
            >
                {{ m("more") }} {{ expanded ? "▴" : "▾" }}</button
            ><button class="mm-link" @click="$emit('reset')">{{ m("reset") }}</button>
        </div>
        <div v-if="expanded" class="mm-advanced">
            <label
                ><span>API Key</span
                ><select :value="query.apiKeyId" @change="change('apiKeyId', $event.target.value)">
                    <option value="">{{ m("all") }}</option>
                    <option v-for="item in options.apiKeys" :key="item.apiKeyId" :value="item.apiKeyId">
                        {{ keyLabel(item.apiKeyId) }}
                    </option>
                </select></label
            >
            <label
                ><span>{{ m("protocol") }}</span
                ><select :value="query.apiFormat" @change="change('apiFormat', $event.target.value)">
                    <option value="">{{ m("all") }}</option>
                    <option v-for="item in options.apiFormats" :key="item" :value="item">{{ item }}</option>
                </select></label
            >
            <label
                ><span>{{ m("ip") }}</span
                ><input :value="query.clientIp" @input="change('clientIp', $event.target.value)"
            /></label>
            <label
                ><span>{{ m("source") }}</span
                ><select :value="query.statusOrigin" @change="change('statusOrigin', $event.target.value)">
                    <option value="">{{ m("all") }}</option>
                    <option v-for="item in ['client', 'upstream', 'local', 'unknown']" :key="item" :value="item">
                        {{ m(item) }}
                    </option>
                </select></label
            >
            <label
                ><span>{{ m("statusCode") }}</span
                ><input
                    type="number"
                    min="100"
                    max="599"
                    :value="query.statusCode"
                    @input="change('statusCode', $event.target.value)"
            /></label>
            <label
                ><span>{{ m("origin") }}</span
                ><select :value="query.requestOrigin" @change="change('requestOrigin', $event.target.value)">
                    <option value="">{{ m("all") }}</option>
                    <option value="production">{{ m("production") }}</option>
                    <option value="test">{{ m("test") }}</option>
                </select></label
            >
            <label
                ><span>{{ m("category") }}</span
                ><select :value="query.requestCategory" @change="change('requestCategory', $event.target.value)">
                    <option value="">{{ m("all") }}</option>
                    <option v-for="item in options.requestCategories" :key="item" :value="item">{{ item }}</option>
                </select></label
            >
            <label
                ><span>{{ m("cacheState") }}</span
                ><select :value="query.cacheState" @change="change('cacheState', $event.target.value)">
                    <option value="">{{ m("all") }}</option>
                    <option v-for="item in ['hit', 'miss', 'unknown']" :key="item" :value="item">{{ m(item) }}</option>
                </select></label
            >
            <label
                ><span>{{ m("minDuration") }}</span
                ><input
                    type="number"
                    min="0"
                    :value="query.minDurationMs"
                    @input="change('minDurationMs', $event.target.value)"
            /></label>
            <label
                ><span>{{ m("maxDuration") }}</span
                ><input
                    type="number"
                    min="0"
                    :value="query.maxDurationMs"
                    @input="change('maxDurationMs', $event.target.value)"
            /></label>
        </div>
        <div class="mm-quick-filters">
            <button v-for="item in shortcuts" :key="item" class="mm-link" @click="$emit('shortcut', item)">
                {{ item === "429" ? "429" : m(item) }}
            </button>
        </div>
        <div v-if="chips.length" class="mm-chips">
            <button v-for="chip in chips" :key="chip.key" @click="change(chip.key, chip.key === 'range' ? '24h' : '')">
                {{ chip.label }} <span>×</span>
            </button>
        </div>
        <p v-if="invalid" class="mm-danger" role="alert">{{ m("invalidFilters") }}</p>
        <small v-else-if="scopeLocked" class="mm-filter-note">{{
            m(query.accountKey && query.accountKey !== "unassigned" ? "selectedAccountScope" : "accountViewScope")
        }}</small>
    </section>
</template>
<script setup>
import { computed, inject, ref } from "vue";
import { conversationLabel, keyLabel } from "./format";
const props = defineProps({
    invalid: Boolean,
    options: { default: () => ({}), type: Object },
    query: { required: true, type: Object },
    scope: { default: "requests", type: String },
    scopeLocked: Boolean,
});
const emit = defineEmits(["change", "reset", "shortcut"]);
const { account, m } = inject("monitor");
const expanded = ref(false);
const ranges = [
    ["24h", "last24h"],
    ["7d", "last7d"],
    ["30d", "last30d"],
    ["all", "all"],
    ["custom", "custom"],
];
const shortcuts = ["localReject", "429", "timeout", "active", "retried"];
const change = (key, value) => emit("change", { [key]: value });
const chips = computed(() =>
    Object.entries(props.query)
        .filter(
            ([key, value]) => value && !["scope", "from", "to"].includes(key) && !(key === "range" && value === "24h")
        )
        .map(([key, value]) => {
            let label = value;
            if (key === "conversationId")
                return {
                    key,
                    label: conversationLabel(
                        props.options.conversations?.find(item => item.conversationId === value),
                        m
                    ),
                };
            if (key === "accountKey")
                label =
                    value === "unassigned"
                        ? m("unassigned")
                        : account(
                              props.options.accounts?.find(item => item.accountKey === value) || { accountName: value }
                          );
            else if (key === "apiKeyId") label = keyLabel(value);
            else if (key === "range") label = m(ranges.find(item => item[0] === value)?.[1] || value);
            else if (["outcome", "cacheState", "statusOrigin", "requestOrigin"].includes(key)) label = m(value);
            else if (key === "retried") label = m("retried");
            else if (key === "activity") label = m("active");
            return {
                key,
                label: `${key === "q" ? m("search").split(" ")[0] : key === "range" ? "" : m({ accountKey: "account", apiFormat: "protocol", apiKeyId: "apiKeys", clientIp: "ip", maxDurationMs: "maxDuration", minDurationMs: "minDuration", requestCategory: "category", requestOrigin: "origin", statusOrigin: "source" }[key] || key)}${key === "range" ? "" : ": "}${label}`,
            };
        })
);
</script>
