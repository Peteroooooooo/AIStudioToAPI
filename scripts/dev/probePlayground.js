/** Native function-calling round trip through the real Playground UI. */
/* global document */
const { createProbe, declaration, prompt } = require("./localToolProbe");

async function runPlayground(page, directory, { model = "gemini-3.8-flash", timeout = 90000 } = {}) {
    const probe = await createProbe(directory, "playground");
    const network = [];
    const capture = response => {
        if (new URL(response.url()).pathname.endsWith("/GenerateContent")) {
            network.push({ status: response.status() });
        }
    };
    page.on("response", capture);
    try {
        await page.goto(`https://aistudio.google.com/prompts/new_chat?model=${encodeURIComponent(model)}`, {
            timeout: 45000,
            waitUntil: "domcontentloaded",
        });
        if (new URL(page.url()).hostname === "accounts.google.com") throw new Error("Saved session is signed out.");
        if (!(await page.getByRole("switch", { exact: true, name: "Function calling" }).count())) {
            await page.getByRole("button", { exact: true, name: "Toggle run settings panel" }).click();
        }
        for (const label of [
            "Grounding with Google Search",
            "Grounding with Google Maps",
            "Code execution",
            "Browse the url context",
        ]) {
            const toggle = page.getByRole("switch", { exact: true, name: label });
            if ((await toggle.count()) && (await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
        }
        const functions = page.getByRole("switch", { exact: true, name: "Function calling" });
        if ((await functions.getAttribute("aria-checked")) !== "true") await functions.click();
        await page.getByRole("button", { exact: true, name: "Edit function declarations" }).click();
        await page.getByRole("tab", { exact: true, name: "Code Editor" }).click();
        await page.locator('textarea[placeholder^="Press Tab"]').fill(JSON.stringify([declaration], null, 2));
        await page.getByRole("button", { exact: true, name: "Save the current function declarations" }).click();
        await page.getByRole("textbox", { exact: true, name: "Enter a prompt" }).fill(prompt);
        await page.getByRole("button", { name: /^Run(?:\s|$)/ }).click();
        const responseEditor = page.getByRole("textbox", { exact: true, name: "Enter a function response" });
        await responseEditor.waitFor({ state: "visible", timeout });
        const region = page.getByRole("region", { name: /^read_local_probe/ });
        const match = (await region.innerText()).match(/\{[\s\S]*?\}/);
        if (!match) throw new Error("Native function call arguments were absent.");
        const result = await probe.execute({ args: JSON.parse(match[0]), name: declaration.name });
        await responseEditor.fill(JSON.stringify(result));
        await page.getByRole("button", { exact: true, name: "Send" }).click();
        await page.waitForFunction(
            token =>
                Array.from(document.querySelectorAll("ms-cmark-node,p")).some(
                    e => !e.closest("form") && e.textContent.trim() === token
                ),
            result.token,
            { timeout }
        );
        return {
            localExecutions: probe.executions,
            model,
            nativeToolCall: true,
            network,
            passed: await probe.verify(result.token),
            protocol: "native_function_calling",
            route: "playground",
        };
    } catch (error) {
        return {
            error: error.message,
            localExecutions: probe.executions,
            model,
            network,
            passed: false,
            route: "playground",
        };
    } finally {
        page.off("response", capture);
        await probe.close();
    }
}

module.exports = { runPlayground };
