/* global chrome, document, localStorage, location */
import { buildStorageState, isAiStudioUrl, isRelevantCookieDomain } from "./core.mjs";

const exportButton = document.getElementById("export");
const statusBox = document.getElementById("status");

function setStatus(message, kind = "") {
    statusBox.textContent = message;
    statusBox.className = kind;
}

function readAiStudioPage() {
    const matches = new Set();
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
        for (const email of script.textContent.match(emailPattern) || []) matches.add(email.toLowerCase());
    }
    const localStorageEntries = [];
    for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        localStorageEntries.push({ name, value: localStorage.getItem(name) });
    }
    return {
        accountName: matches.size === 1 ? [...matches][0] : null,
        localStorage: localStorageEntries,
        origin: location.origin,
    };
}

async function getBrowserCookies(tabId) {
    const stores = await chrome.cookies.getAllCookieStores();
    const store = stores.find(item => item.tabIds.includes(tabId));
    if (!store) throw new Error("无法确定当前标签的 Cookie 存储区，请重新打开 AI Studio 后重试");
    const groups = await Promise.all(
        ["google.com", "ai.studio"].map(domain => chrome.cookies.getAll({ domain, storeId: store.id }))
    );
    return groups.map(group => group.filter(cookie => isRelevantCookieDomain(cookie.domain)));
}

async function captureActiveTab() {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const aiTab = activeTabs[0];
    if (!aiTab?.id || !isAiStudioUrl(aiTab.url)) {
        throw new Error("请先切换到已登录的 AI Studio 标签页，再点击扩展按钮");
    }

    setStatus("正在读取当前 AI Studio 标签的登录状态…");
    const pageResults = await chrome.scripting.executeScript({
        func: readAiStudioPage,
        target: { tabId: aiTab.id },
    });
    return buildStorageState(pageResults[0]?.result, await getBrowserCookies(aiTab.id));
}

function exportJson(storageState) {
    const content = JSON.stringify(storageState, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `aistudio-auth-${Date.now()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function runExport() {
    exportButton.disabled = true;
    try {
        const storageState = await captureActiveTab();
        exportJson(storageState);
        setStatus(`${storageState.accountName} 的 JSON 已开始下载。`, "success");
    } catch (error) {
        setStatus(error.message || String(error), "error");
    } finally {
        exportButton.disabled = false;
    }
}

exportButton.addEventListener("click", runExport);
