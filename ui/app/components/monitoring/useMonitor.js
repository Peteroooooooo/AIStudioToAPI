import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

export function useMonitor(m) {
    const route = useRoute();
    const router = useRouter();
    const defaults = {
        accountKey: '',
        activity: '',
        apiFormat: '',
        apiKeyId: '',
        cacheState: '',
        clientIp: '',
        conversationId: '',
        from: '',
        maxDurationMs: '',
        minDurationMs: '',
        model: '',
        outcome: '',
        q: '',
        range: '24h',
        requestCategory: '',
        requestOrigin: '',
        retried: '',
        scope: 'requests',
        statusCode: '',
        statusOrigin: '',
        to: '',
    };
    const views = ['requests', 'accounts', 'models', 'apiKeys'];
    const query = reactive({ ...defaults });
    const tab = ref('requests');
    const granularity = ref('auto');
    const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const scopeLocked = computed(() => tab.value === 'accounts' || !!query.accountKey);
    const scope = computed(() =>
        query.accountKey === 'unassigned'
            ? 'requests'
            : query.accountKey || tab.value === 'accounts'
              ? 'attempts'
              : query.scope
    );
    const invalid = computed(() => {
        if (
            query.range === 'custom' &&
            (!Number.isFinite(Date.parse(query.from)) ||
                !Number.isFinite(Date.parse(query.to)) ||
                Date.parse(query.from) > Date.parse(query.to))
        )
            return true;
        if (query.statusCode && !/^[1-5]\d{2}$/.test(query.statusCode)) return true;
        const min = query.minDurationMs === '' ? 0 : Number(query.minDurationMs);
        const max = query.maxDurationMs === '' ? Infinity : Number(query.maxDurationMs);
        return !Number.isSafeInteger(min) || min < 0 || (max !== Infinity && (!Number.isSafeInteger(max) || max < min));
    });
    const overview = ref(null);
    const requests = ref({ hasMore: false, items: [], totalMatched: 0 });
    const active = ref({ hasMore: false, items: [], totalMatched: 0 });
    const connected = ref(false);
    const error = ref('');
    const requestsError = ref('');
    const loading = ref(false);
    const refreshing = ref(false);
    const paused = ref(false);
    const page = ref(0);
    const cursors = ref([null]);
    const pending = ref(0);
    const drawerOpen = ref(false);
    const selected = ref(null);
    const parent = ref(null);
    const parentLoading = ref(false);
    const parentError = ref('');
    const accountDetails = ref({});
    const keyDetails = ref({});
    let frozenParams = null;
    const committedQuery = ref('');
    const queryKey = () =>
        JSON.stringify({
            ...query,
            effectiveScope: scope.value,
            granularity: granularity.value,
            timezone: timezone.value,
        });
    const queryPending = computed(() => committedQuery.value !== queryKey());
    let snapshotSequence = null;
    let generation = 0;
    let parentGeneration = 0;
    let pollBusy = false;
    let lastPollAt = 0;
    let debounce;
    let interval;
    let tickInterval;
    let mounted = false;
    const now = ref(Date.now());
    const readUrl = () => {
        for (const [key, value] of Object.entries(defaults))
            query[key] = typeof route.query[`mon_${key}`] === 'string' ? route.query[`mon_${key}`] : value;
        tab.value = views.includes(route.query.mon_tab) ? route.query.mon_tab : 'requests';
        granularity.value = ['auto', 'hour', 'day'].includes(route.query.mon_granularity)
            ? route.query.mon_granularity
            : 'auto';
        timezone.value =
            typeof route.query.mon_timezone === 'string'
                ? route.query.mon_timezone
                : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    };
    readUrl();
    const writeUrl = () => {
        const next = { ...route.query };
        for (const key of Object.keys(next)) if (key.startsWith('mon_')) delete next[key];
        for (const [key, value] of Object.entries(query))
            if (value && value !== defaults[key]) next[`mon_${key}`] = value;
        if (tab.value !== 'requests') next.mon_tab = tab.value;
        if (granularity.value !== 'auto') next.mon_granularity = granularity.value;
        if (timezone.value !== (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'))
            next.mon_timezone = timezone.value;
        if (JSON.stringify(next) !== JSON.stringify(route.query)) router.replace({ query: next });
    };
    const params = () => {
        const values = new URLSearchParams({
            granularity: granularity.value,
            timezone: timezone.value,
            view: scope.value,
        });
        if (query.range === 'custom') {
            values.set('from', new Date(query.from).toISOString());
            values.set('to', new Date(query.to).toISOString());
        } else values.set('range', query.range);
        for (const [key, value] of Object.entries(query))
            if (value && !['scope', 'range', 'from', 'to', 'activity'].includes(key)) values.set(key, value);
        return values;
    };
    const getJson = async url => {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (response.redirected || response.status === 401) {
            window.location.assign('/login');
            throw new Error('Session expired');
        }
        const data = await response.json();
        if (!response.ok)
            throw new Error(typeof data.error === 'string' ? data.error : data.message || `HTTP ${response.status}`);
        return data;
    };
    const activeParams = () => {
        const values = params();
        values.delete('from');
        values.delete('to');
        values.set('range', 'all');
        return values;
    };
    const refresh = async () => {
        if (invalid.value) return;
        clearTimeout(debounce);
        const current = ++generation;
        refreshing.value = true;
        loading.value = !overview.value;
        error.value = '';
        requestsError.value = '';
        const values = params();
        // Freeze the window once. Cards, pages, expansions and export use this same snapshot.
        if (query.range !== 'all' && query.range !== 'custom') {
            const at = Date.now();
            const span = { '7d': 604800000, '24h': 86400000, '30d': 2592000000 }[query.range];
            values.set('from', new Date(at - span).toISOString());
            values.set('to', new Date(at).toISOString());
        }
        try {
            const data = await getJson(`/api/usage-stats/overview?${values}`);
            const sequence = data.latestSequence;
            values.set('snapshotSequence', String(sequence));
            const [history, activity] = await Promise.all([
                getJson(`/api/usage-stats/requests?${values}&limit=20`),
                getJson(`/api/usage-stats/active?${activeParams()}`),
            ]);
            if (current !== generation) return;
            overview.value = data;
            requests.value = history;
            active.value = activity;
            frozenParams = values;
            committedQuery.value = queryKey();
            snapshotSequence = sequence;
            page.value = 0;
            cursors.value = [null];
            pending.value = 0;
            accountDetails.value = {};
            keyDetails.value = {};
            connected.value = true;
        } catch (failure) {
            if (current === generation) {
                error.value = `${m('failedRefresh')}: ${failure.message}`;
                connected.value = false;
            }
        } finally {
            if (current === generation) {
                refreshing.value = false;
                loading.value = false;
            }
        }
    };
    const fetchPage = async target => {
        if (!frozenParams || invalid.value) return;
        const current = generation;
        const values = new URLSearchParams(frozenParams);
        const cursor = cursors.value[target];
        if (cursor != null) values.set('cursor', String(cursor));
        values.set('limit', '20');
        loading.value = true;
        requestsError.value = '';
        try {
            const data = await getJson(`/api/usage-stats/requests?${values}`);
            if (current === generation) {
                requests.value = data;
                page.value = target;
            }
        } catch (failure) {
            if (current === generation) {
                requestsError.value = failure.message;
                connected.value = false;
            }
        } finally {
            if (current === generation) loading.value = false;
        }
    };
    const next = () => {
        if (!requests.value.hasMore || loading.value) return;
        cursors.value[page.value + 1] = requests.value.nextCursor;
        fetchPage(page.value + 1);
    };
    const previous = () => {
        if (page.value > 0 && !loading.value) fetchPage(page.value - 1);
    };
    const poll = async (force = false) => {
        if (paused.value || document.hidden || refreshing.value || pollBusy || invalid.value || !frozenParams) return;
        if (!force && !query.activity && !active.value.totalMatched && Date.now() - lastPollAt < 30000) return;
        const current = generation;
        pollBusy = true;
        lastPollAt = Date.now();
        try {
            const values = new URLSearchParams(frozenParams);
            values.delete('snapshotSequence');
            values.set('afterSequence', String(snapshotSequence));
            if (query.range !== 'custom') {
                values.delete('to');
                if (query.range === 'all') values.set('range', 'all');
            }
            const [newData, activity] = await Promise.all([
                getJson(`/api/usage-stats/overview?${values}`),
                getJson(`/api/usage-stats/active?${activeParams()}`),
            ]);
            if (current !== generation) return;
            pending.value = newData.summary.totalRequests;
            active.value = activity;
            connected.value = true;
            error.value = '';
            if (selected.value?.active) {
                const stillActive = activity.items.find(
                    item =>
                        (selected.value.requestAttemptId || selected.value.requestId) ===
                        (item.requestAttemptId || item.requestId)
                );
                if (stillActive) selected.value = stillActive;
                else {
                    const endedRequestId = selected.value.requestId;
                    const finished = await getJson(
                        `/api/usage-stats/request/${encodeURIComponent(endedRequestId)}`
                    ).catch(() => null);
                    if (
                        current === generation &&
                        finished &&
                        selected.value?.active &&
                        selected.value.requestId === finished.requestId
                    ) {
                        const call = finished.attempts?.find(
                            item => item.requestAttemptId === selected.value.requestAttemptId
                        );
                        const isCall =
                            selected.value.metricScope === 'attempts' || Number.isInteger(selected.value.attemptIndex);
                        selected.value = isCall
                            ? call
                                ? {
                                      ...selected.value,
                                      ...call,
                                      active: Boolean(call.active),
                                      parentAttemptCount: finished.attemptCount,
                                  }
                                : { ...selected.value, active: false, activityEndedUnknown: true, outcome: 'unknown' }
                            : { ...finished, active: Boolean(finished.active) };
                    } else if (
                        current === generation &&
                        !finished &&
                        selected.value?.active &&
                        selected.value.requestId === endedRequestId
                    ) {
                        selected.value = {
                            ...selected.value,
                            active: false,
                            activityEndedUnknown: true,
                            outcome: 'unknown',
                            statusCode: null,
                        };
                    }
                }
            }
            // Keep historical totals and rows together; only real active snapshots advance.
        } catch (failure) {
            if (current === generation) {
                connected.value = false;
                error.value = `${m('failedRefresh')}: ${failure.message}`;
            }
        } finally {
            pollBusy = false;
        }
    };
    const pause = () => {
        paused.value = !paused.value;
        if (!paused.value) poll(true);
    };
    const reset = () => {
        Object.assign(query, defaults);
        tab.value = 'requests';
    };
    const change = patch => {
        Object.assign(query, patch);
        if (patch.range && patch.range !== 'custom') {
            query.from = '';
            query.to = '';
        }
        if (patch.statusOrigin === 'upstream') {
            query.scope = 'attempts';
            if (query.accountKey === 'unassigned') query.accountKey = '';
        }
        if (patch.accountKey === 'unassigned' && tab.value === 'accounts') tab.value = 'requests';
    };
    const shortcut = item => {
        Object.assign(query, {
            activity: '',
            maxDurationMs: '',
            minDurationMs: '',
            outcome: '',
            retried: '',
            statusCode: '',
            statusOrigin: '',
        });
        tab.value = 'requests';
        if (item === 'localReject') {
            query.accountKey = 'unassigned';
            query.statusOrigin = 'local';
            query.scope = 'requests';
        }
        if (item === '429') {
            if (query.accountKey === 'unassigned') query.accountKey = '';
            query.statusCode = '429';
            query.scope = 'attempts';
        }
        if (item === 'timeout') {
            query.outcome = 'error';
            query.statusCode = '504';
        }
        if (item === 'retried') query.retried = 'true';
        if (item === 'active') query.activity = 'active';
    };
    const open = record => {
        selected.value = JSON.parse(JSON.stringify(record));
        drawerOpen.value = true;
        parent.value = null;
        parentError.value = '';
        parentLoading.value = false;
        parentGeneration += 1;
    };
    const loadParent = async () => {
        if (!selected.value || parentLoading.value) return;
        const current = ++parentGeneration;
        parentLoading.value = true;
        parentError.value = '';
        try {
            const data = await getJson(`/api/usage-stats/request/${encodeURIComponent(selected.value.requestId)}`);
            if (current === parentGeneration) parent.value = data;
        } catch (failure) {
            if (current === parentGeneration) parentError.value = failure.message;
        } finally {
            if (current === parentGeneration) parentLoading.value = false;
        }
    };
    const expand = async (kind, row) => {
        if (!frozenParams) return;
        const cache = kind === 'account' ? accountDetails : keyDetails;
        const field = kind === 'account' ? 'accountKey' : 'apiKeyId';
        const key = row[field];
        const current = generation;
        cache.value[key] = { loading: true };
        const values = new URLSearchParams(frozenParams);
        values.set(field, key);
        if (kind === 'account') values.set('view', 'attempts');
        try {
            const data = await getJson(`/api/usage-stats/overview?${values}`);
            if (current === generation) cache.value[key] = { data };
        } catch (failure) {
            if (current === generation) cache.value[key] = { error: failure.message };
        }
    };
    const viewGroup = (kind, row, failed = false, model = null) => {
        const patch = { activity: '', outcome: failed ? 'error' : '' };
        if (kind === 'account') patch.accountKey = row.accountKey;
        if (kind === 'model') patch.model = row.model;
        if (kind === 'key') patch.apiKeyId = row.apiKeyId;
        if (model) patch.model = model.model;
        change(patch);
        tab.value = 'requests';
    };
    const exportFiltered = () => {
        if (frozenParams && !invalid.value && !queryPending.value && !query.activity)
            window.location.assign(`/api/usage-stats/export?${frozenParams}`);
    };
    const focusRequest = async id => {
        reset();
        query.range = 'all';
        query.q = id;
        await nextTick();
        await refresh();
        const record = requests.value.items.find(item => item.requestId === id);
        if (record) open(record);
    };
    const visibleActive = computed(() =>
        active.value.items.map(record => ({
            ...record,
            durationMs: Math.max(0, now.value - Date.parse(record.startedAt)),
        }))
    );
    const summary = computed(() =>
        overview.value
            ? {
                  ...overview.value.summary,
                  inProgressCount: active.value.items.filter(row => row.outcome === 'in_progress').length,
                  queuedCount: active.value.items.filter(row => row.outcome === 'queued').length,
              }
            : null
    );
    const visibility = () => {
        if (!document.hidden) poll(true);
    };
    watch(
        [query, tab, granularity, timezone],
        () => {
            if (!mounted) return;
            ++generation;
            refreshing.value = false;
            loading.value = false;
            clearTimeout(debounce);
            writeUrl();
            debounce = setTimeout(refresh, 300);
        },
        { deep: true }
    );
    watch(() => route.query, readUrl);
    onMounted(() => {
        mounted = true;
        refresh();
        interval = setInterval(poll, 5000);
        tickInterval = setInterval(() => {
            if (!paused.value && connected.value) now.value = Date.now();
        }, 1000);
        document.addEventListener('visibilitychange', visibility);
    });
    onBeforeUnmount(() => {
        mounted = false;
        ++generation;
        ++parentGeneration;
        clearTimeout(debounce);
        clearInterval(interval);
        clearInterval(tickInterval);
        document.removeEventListener('visibilitychange', visibility);
    });
    return {
        accountDetails,
        active,
        change,
        connected,
        drawerOpen,
        error,
        expand,
        exportFiltered,
        fetchPage,
        focusRequest,
        granularity,
        invalid,
        keyDetails,
        loading,
        loadParent,
        next,
        open,
        overview,
        page,
        parent,
        parentError,
        parentLoading,
        pause,
        paused,
        pending,
        previous,
        query,
        queryPending,
        refresh,
        refreshAfterImport: refresh,
        refreshing,
        requests,
        requestsError,
        reset,
        scope,
        scopeLocked,
        selected,
        shortcut,
        summary,
        tab,
        timezone,
        viewGroup,
        visibleActive,
    };
}
