const EMAIL_PATTERN = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
const ACCOUNT_SWITCHER_SELECTOR = "button.account-switcher-button[aria-label]";
const ACCOUNT_LABEL_PATTERN = /^\s*Google\s+(?:Account|账号|帳號|帳戶|帐号)\s*[:：]/i;

async function detectAccountEmail(page) {
    // The account switcher is rendered by AI Studio itself on /apps. Project
    // content and embedded JSON can contain unrelated email addresses, so neither
    // is authoritative for deciding which Google account is signed in.
    const switches = page.locator(ACCOUNT_SWITCHER_SELECTOR);
    if ((await switches.count()) !== 1) return null;
    const label = await switches.first().getAttribute("aria-label");
    if (!label || !ACCOUNT_LABEL_PATTERN.test(label)) return null;
    const emails = [...label.matchAll(EMAIL_PATTERN)];
    return emails.length === 1 ? emails[0][1].toLowerCase() : null;
}

module.exports = { detectAccountEmail };
