export function runtimeReasonLabel(reason, t) {
    if (!reason) return '';
    const known = new Set([
        'not_loaded',
        'initialization_in_progress',
        'initialization_cancelled',
        'save_auth',
        'install_client',
        'create_context',
        'inject_privacy',
        'create_page',
        'focus_page',
        'focus_window',
        'move_mouse',
        'navigate',
        'check_identity',
        'wait_websocket',
        'websocket_mouse',
        'websocket_reconnect',
        'close_unresponsive_context',
        'probe_in_progress',
        'probe_required',
        'connection_recovery',
        'transport_failure',
        'connection_not_ready',
        'disabled',
        'cooldown',
        'reauth',
        'excluded',
        'active',
        'generation_deadline_exceeded',
        'request_deadline_exceeded',
        'pool_shrink',
        'no_longer_eligible',
        'websocket_continue',
        'websocket_skip',
        'websocket_launch',
        'page_errors',
        'websocket_page_errors',
        'mouse',
        'browser_launch',
        'context_launch',
        'page_navigation',
        'waiting_for_websocket',
        'request_deadline',
        'execution_timeout',
    ]);
    return known.has(reason) ? t(`poolReason_${reason}`) : reason;
}

// The slot owns the current request; historical tests and conversation owners are not activity.
export function accountExecution(account) {
    const slot = account.slot;
    if (slot?.requestId && slot.inFlight > 0) return { ...slot, state: slot.phase || 'generating' };
    return account.activity?.requests?.[0] || { requestId: null, startedAt: null, state: 'idle' };
}

export function accountEnabled(account) {
    if (account.isInvalid || account.isExpired || account.isDuplicate) return false;
    const health = account.health || {};
    return typeof health.enabled === 'boolean'
        ? health.enabled
        : !['disabled', 'cooldown', 'reauth'].includes(health.mode);
}

// The main status follows the switch and actual work; connection details are secondary.
export function accountStatus(account) {
    const health = account.health || {};
    const runtime = account.runtime || {};
    const execution = accountExecution(account);
    const enabled = accountEnabled(account);
    const working = account.testRunning || execution.state !== 'idle' || account.activity?.maintenance > 0;
    const state = !account.statusStale && working ? 'processing' : enabled ? 'enabled' : 'disabled';
    let note = null;
    if (account.statusStale) note = 'accountNote_stale';
    else if (account.isInvalid) note = 'jsonFormatError';
    else if (account.isExpired || health.mode === 'reauth') note = 'accountUpdateAuth';
    else if (account.isDuplicate) note = 'duplicateAuth';
    else if (!enabled && health.disabledBy === 'auto') note = 'accountNote_autoDisabled';
    else if (account.testRunning || execution.state === 'testing') note = 'accountTestCompact_running';
    else if (enabled && ['initializing', 'reconnecting'].includes(runtime.state)) note = 'accountNote_connecting';
    else if (enabled && runtime.state === 'stalled') note = 'accountNote_connectionError';
    else if (enabled && account.slot?.waiting) note = 'accountNote_queued';
    else if (enabled && (runtime.state === 'standby' || !account.hasContext)) note = 'accountNote_waitingSlot';
    else if (enabled && !account.poolMember && runtime.state !== 'ready' && state !== 'processing')
        note = 'accountNote_notReady';
    return {
        description: `accountStatusHelp_${state}`,
        filterState: state,
        label: `accountCompact_${state}`,
        note,
        state,
        tone: account.statusStale ? 'muted' : state === 'processing' ? 'primary' : enabled ? 'success' : 'muted',
    };
}
