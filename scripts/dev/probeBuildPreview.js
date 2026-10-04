/** Read-only live function-calling probe inside the project's Google Build Preview. */
/* global document */
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const { createProbe, runGeminiRoundTrip } = require("./localToolProbe");

async function runPreview(context, { directory, model = "gemini-3.8-flash", timeout = 30000 } = {}) {
    const page = await context.newPage();
    const probe = await createProbe(directory, "preview");
    const started = Date.now();
    // Keep Google's preview shim; remove only the app's server-connection client.
    await page.route("https://ais-*.run.app/assets/index-*.js", route =>
        route.fulfill({
            body: 'document.body.textContent="Local function calling probe";',
            contentType: "application/javascript",
            status: 200,
        })
    );
    try {
        await page.goto("https://ai.studio/apps/cab9ab6c-44f9-4e7a-8972-037f8ae177ab", {
            timeout: 45000,
            waitUntil: "domcontentloaded",
        });
        if (new URL(page.url()).hostname === "accounts.google.com") {
            return { error: "Saved session is signed out.", passed: false, route: "build_preview", stage: "login" };
        }
        const continueButton = page.getByRole("button", { exact: true, name: "Continue to the app" });
        await continueButton.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
        if (await continueButton.isVisible()) await continueButton.click();
        await page.waitForFunction(() => Boolean(document.querySelector('iframe[title="Preview"]')), null, {
            timeout: 15000,
        });
        let frame =
            page.frames().find(f => /^https:\/\/ais-.*\.run\.app/.test(f.url())) ||
            (await page.waitForEvent("framenavigated", {
                predicate: frame => /^https:\/\/ais-.*\.run\.app/.test(frame.url()),
                timeout: 15000,
            }));
        // Google replaces the initial warmup iframe after showing the preview.
        await page.waitForTimeout(6000);
        frame = page.frames().find(f => /^https:\/\/ais-.*\.run\.app/.test(f.url()));
        if (!frame) throw new Error("Google Preview frame disappeared after warmup.");
        await frame.waitForLoadState("domcontentloaded", { timeout: 15000 });
        const generate = body =>
            frame.evaluate(
                async ({ body, model, timeout }) => {
                    let timer;
                    try {
                        return await Promise.race([
                            fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                                body: JSON.stringify(body),
                                headers: { "Content-Type": "application/json" },
                                method: "POST",
                            }).then(async response => {
                                const parsed = await response.json();
                                return {
                                    body: parsed,
                                    error: parsed.error?.message,
                                    status: response.status,
                                };
                            }),
                            new Promise(resolve => {
                                timer = setTimeout(
                                    () => resolve({ error: "Google Preview proxy did not respond.", status: null }),
                                    timeout
                                );
                            }),
                        ]);
                    } finally {
                        clearTimeout(timer);
                    }
                },
                { body, model, timeout }
            );
        return {
            model,
            route: "build_preview",
            ...(await runGeminiRoundTrip(generate, probe, model)),
            durationMs: Date.now() - started,
        };
    } catch (error) {
        return { error: error.message, model, passed: false, route: "build_preview", stage: "browser_setup" };
    } finally {
        await page.close(); // Also cancels Google's fetch wrapper if it ignores AbortSignal.
        await probe.close();
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const option = name => args[args.indexOf(name) + 1];
    const authPath = args.includes("--auth") ? option("--auth") : null;
    if (!authPath) throw new Error("Usage: node scripts/dev/probeBuildPreview.js --auth <storage-state.json>");
    (async () => {
        const saved = JSON.parse(await fs.readFile(authPath, "utf8"));
        const browser = await chromium.launch({
            executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
            headless: true,
        });
        try {
            const context = await browser.newContext({
                storageState: { cookies: saved.cookies, origins: saved.origins },
            });
            const result = await runPreview(context, {
                directory: path.resolve(__dirname, "../../data/tool-probe-fixtures"),
                model: args.includes("--model") ? option("--model") : undefined,
            });
            console.log(JSON.stringify(result, null, 2));
            if (result.passed !== true) process.exitCode = 1;
        } finally {
            await browser.close();
        }
    })().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { runPreview };
