/** Tests a text tool protocol. This deliberately makes no claim of native tools support. */
/* global document */
const { createProbe } = require("./localToolProbe");

async function sendAssistant(page, prompt, timeout = 45000) {
    const before = await page.locator("ms-console-turn").count();
    await page
        .getByRole("textbox", { exact: true, name: "Make changes, add new features, ask for anything" })
        .fill(prompt);
    await page.getByRole("button", { exact: true, name: "Send" }).click();
    await page.waitForFunction(
        count => {
            const turns = Array.from(document.querySelectorAll("ms-console-turn")).slice(count);
            return (
                turns.some(e => e.querySelector("ms-chat-turn-error")) ||
                turns.filter(e => e.querySelector(".bubble")).length >= 2
            );
        },
        before,
        { timeout }
    );
    const turns = page.locator("ms-console-turn");
    const last = turns.last();
    if (await last.locator("ms-chat-turn-error").count()) throw new Error((await last.innerText()).slice(0, 250));
    await page
        .getByRole("button", { name: /^Stop/ })
        .waitFor({ state: "hidden", timeout })
        .catch(() => {});
    return page.locator("ms-console-turn .bubble").last().innerText();
}

async function runAssistant(page, directory) {
    const probe = await createProbe(directory, "assistant");
    const result = { nativeToolsVerified: false, protocol: "text_json", route: "build_assistant" };
    try {
        const request = await sendAssistant(
            page,
            "This is a local tool protocol test. Do not create or edit app files, and do not execute your cloud tools. " +
                'My local script can execute read_local_probe with args {"id":"probe"}. ' +
                "To request this tool, output ONLY JSON with a tool_call object containing name and args. " +
                "Wait for the tool result in the next message. You cannot know the local token yet."
        );
        const cleaned = request
            .replace(/^```(?:json)?\s*/, "")
            .replace(/\s*```$/, "")
            .trim();
        const call = JSON.parse(cleaned).tool_call;
        const value = await probe.execute(call);
        const answer = await sendAssistant(
            page,
            `Tool result for read_local_probe: ${JSON.stringify(value)}. Reply with the exact token only. Do not modify files.`
        );
        return { ...result, localExecutions: probe.executions, passed: await probe.verify(answer) };
    } catch (error) {
        return { ...result, error: error.message, localExecutions: probe.executions, passed: false };
    } finally {
        await probe.close();
    }
}

module.exports = { runAssistant, sendAssistant };
