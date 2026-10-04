export const number = value => (Number.isFinite(value) ? value.toLocaleString() : '—');
export const compact = value => {
    if (!Number.isFinite(value)) return '—';
    if (value < 1000) return number(value);
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, notation: 'compact' }).format(value);
};
export const percent = value => (Number.isFinite(value) ? `${value.toFixed(1)}%` : '—');
export const duration = value => {
    if (!Number.isFinite(value)) return '—';
    if (value < 1000) return `${Math.round(value)} ms`;
    if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
    return `${(value / 60000).toFixed(1)} min`;
};
export const time = (value, short = false) => {
    if (!value || !Number.isFinite(Date.parse(value))) return '—';
    return new Date(value).toLocaleString(
        undefined,
        short ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : undefined
    );
};
export const conversationLabel = (record, m, currentYear = new Date().getFullYear()) => {
    const date = record?.conversationDate;
    const number = record?.conversationNumber;
    if (!date || !Number.isSafeInteger(number) || number < 1) return `${m('conversation')} ${m('unknown')}`;
    const [year, month, day] = date.split('-');
    const prefix = Number(year) === currentYear ? `${month}/${day}` : `${year}/${month}/${day}`;
    return `${m('conversation')} ${prefix}-${String(number).padStart(2, '0')}`;
};
export const keyLabel = value =>
    !value || value === 'unknown' ? '—' : value.length > 16 ? `${value.slice(0, 12)}…` : value;
export const status = (record, m) => {
    if (record.active) return m(record.outcome);
    if (record.metricScope !== 'attempts' && record.attemptIndex === undefined) {
        return `${m(record.attemptCount === 0 ? 'local' : 'client')} ${record.statusCode ?? '—'}`;
    }
    if (
        record.upstreamStatusCode != null &&
        record.localStatusCode != null &&
        record.upstreamStatusCode !== record.localStatusCode
    )
        return `${m('upstream')} ${record.upstreamStatusCode} · ${m('local')} ${record.localStatusCode}`;
    if (record.upstreamStatusCode != null) return `${m('upstream')} ${record.upstreamStatusCode}`;
    if (record.localStatusCode != null) return `${m('local')} ${record.localStatusCode}`;
    return record.legacyStatusCode != null ? `${m('unclassified')} ${record.legacyStatusCode}` : '—';
};
export const nonCached = usage => {
    const input = usage?.inputTokens;
    const cached = usage?.cachedInputTokens;
    return Number.isFinite(input) && Number.isFinite(cached) && cached <= input ? input - cached : null;
};
export const cacheAnomaly = usage =>
    Number.isFinite(usage?.inputTokens) &&
    Number.isFinite(usage?.cachedInputTokens) &&
    usage.cachedInputTokens > usage.inputTokens;
export const shortError = value => (value ? String(value).replace(/\s+/g, ' ').slice(0, 100) : '');
