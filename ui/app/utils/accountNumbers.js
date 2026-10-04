export function numberAccounts(accounts) {
    return [...accounts]
        .sort((left, right) => left.index - right.index)
        .map((account, position) => ({ ...account, displayIndex: position + 1 }));
}

export function accountDisplayIndex(accounts, index) {
    return accounts.find(account => account.index === index)?.displayIndex ?? '—';
}

export function accountDisplayLabel(record, accounts) {
    const name = record.finalAccountName || record.accountName || record.name;
    const index = record.finalAuthIndex ?? record.authIndex ?? record.index;
    const current = name
        ? accounts.find(account => account.name?.trim().toLowerCase() === name.trim().toLowerCase())
        : accounts.find(account => account.index === index);
    const number = current?.displayIndex;
    return number == null ? name || '—' : `#${number} ${name || current.name || '—'}`;
}
