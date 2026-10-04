const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function processor(t) {
    const source = fs.readFileSync(path.join(__dirname, "../scripts/client/build.js"), "utf8");
    const definition = source.slice(
        source.indexOf("class RequestProcessor {"),
        source.indexOf("class ProxySystem extends")
    );
    const timers = new Set();
    const context = vm.createContext({
        AbortController,
        clearTimeout: timer => {
            clearTimeout(timer);
            timers.delete(timer);
        },
        DOMException,
        fetch: () => new Promise(() => {}),
        location: { host: "localhost" },
        Logger: { debug() {}, output() {} },
        setTimeout: (...args) => {
            const timer = setTimeout(...args);
            timers.add(timer);
            return timer;
        },
        URL,
        URLSearchParams,
    });
    t.after(() => {
        for (const timer of timers) clearTimeout(timer);
    });
    const RequestProcessor = vm.runInContext(definition + "; RequestProcessor", context);
    const instance = new RequestProcessor();
    instance._constructUrl = () => "https://mock.invalid/";
    instance._buildRequestConfig = (_request, signal) => ({ signal });
    return { instance, timers };
}

test("browser cancellation ends a fetch that ignores AbortSignal without waiting five minutes", async t => {
    const { instance, timers } = processor(t);
    const operation = instance.execute({ request_attempt_id: "attempt-1" }, "request-1");
    instance.cancelOperation("request-1", "attempt-1");
    await assert.rejects(operation.responsePromise, { name: "AbortError" });
    assert.equal(timers.size, 0);
});

test("stale cancellation cannot abort the current retry and a hanging body read is interruptible", async t => {
    const { instance } = processor(t);
    const operation = instance.execute({ request_attempt_id: "attempt-new" }, "request-1");
    instance.cancelOperation("request-1", "attempt-old");
    assert.equal(operation.abortController.signal.aborted, false);
    const read = instance.waitForOperation(new Promise(() => {}), operation.abortController.signal);
    instance.cancelOperation("request-1", "attempt-new");
    await assert.rejects(read, { name: "AbortError" });
    await assert.rejects(operation.responsePromise, { name: "AbortError" });
});
