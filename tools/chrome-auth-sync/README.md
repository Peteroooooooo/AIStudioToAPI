# 从本机 Chrome 导出 AI Studio 账号

这个扩展读取当前 Chrome Profile 中已登录的 AI Studio 标签及其 Cookie，生成项目使用的 Playwright `storageState` JSON 文件。它只在本机下载文件，不连接 AIStudioToAPI 控制台。

## 安装

1. Chrome 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本目录 `tools/chrome-auth-sync`。
3. 每个需要导出的 Chrome Profile 各安装一次。扩展只能读取它所在 Profile 的当前标签和 Cookie。

## 使用

1. 在目标 Profile 中打开并登录 AI Studio，切到 AI Studio 标签。
2. 点击扩展图标，再点击“从当前标签导出 JSON”。
3. JSON 会下载到 Chrome 的下载目录。可按需自行上传到控制台。

认证 JSON 包含登录状态，使用后请妥善保管或删除。如果同一个 Profile 登录了多个 Google 账号，导出的 Google Cookie 可能包含这些账号的会话；建议每个账号使用独立 Profile。不要把导出的 JSON 提交到 GitHub。

## English

Load this unpacked extension from `tools/chrome-auth-sync` in each Chrome profile you use for AI Studio. Open a signed-in AI Studio tab in that profile, click the extension icon, and choose **从当前标签导出 JSON**. The extension only downloads a local JSON file; it does not upload anything.

The file contains login cookies and local storage. If a profile has multiple Google accounts, it may include cookies for all of them. Keep the file private and never commit it to GitHub.
