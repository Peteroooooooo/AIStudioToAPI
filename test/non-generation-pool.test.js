const test = require("node:test");
const assert = require("node:assert/strict");
const RequestHandler = require("../src/core/RequestHandler");

function fixture() {
    const handler = Object.create(RequestHandler.prototype);
    const selections = [];
    const queueAccounts = [];
    const finalized = [];
    const requests = [];
    handler.config = { fakeStreamTimeoutMs: 1000 };
    handler.logger = { debug() {}, error() {}, info() {}, warn() {} };
    handler.authSwitcher = { currentAuthIndex: 0, failureCount: 0 };
    handler.formatConverter = {
        translateClaudeToGoogle: async () => ({ cleanModelName: "model", googleRequest: { contents: [] } }),
        translateOpenAIEmbeddingsToGoogle: () => ({
            cleanModelName: "embedding",
            googleRequest: {},
            path: "/v1beta/models/embedding:batchEmbedContents",
        }),
        translateOpenAIResponseToGoogle: async () => ({ cleanModelName: "model", googleRequest: { contents: [] } }),
    };
    handler._generateRequestId = () => "request";
    handler._initializeProxyRequestAttempt = request => {
        request.request_attempt_id = "attempt";
    };
    handler._startTrackedRequest = () => {};
    handler._updateTrackedRequest = () => {};
    handler._finalizeTrackedRequest = id => finalized.push(id);
    handler._ensureBrowserBackedRequestReady = async () => true;
    handler._setupClientDisconnectHandler = () => {};
    handler._selectServingAccount = async request => {
        selections.push(request);
        return 2;
    };
    handler._handleRequestError = error => {
        throw error;
    };
    handler._handleNonStreamResponse = async (request, queue, req, res) => {
        requests.push(request);
        res.end();
    };
    handler._executeRequestWithRetries = async () => {
        const chunks = [{ data: JSON.stringify({ totalTokens: 23 }) }, { type: "STREAM_END" }];
        return {
            message: { event_type: "response_headers" },
            queue: { dequeue: async () => chunks.shift() },
            success: true,
        };
    };
    handler.connectionRegistry = {
        createMessageQueue(id, account) {
            queueAccounts.push(account);
            return {};
        },
        getAuthIndexForRequest: () => 2,
        removeMessageQueue() {},
    };
    const res = {
        end() {
            this.writableEnded = true;
        },
        json(value) {
            this.body = value;
            this.end();
            return this;
        },
        status() {
            return this;
        },
    };
    return { finalized, handler, queueAccounts, requests, res, selections };
}

test("embeddings use the pool-selected account rather than the compatibility current", async () => {
    const { finalized, handler, queueAccounts, res, selections } = fixture();
    await handler.processOpenAIEmbeddingsRequest({ body: {}, headers: {}, query: {} }, res);
    assert.deepEqual(queueAccounts, [2]);
    assert.equal(selections[0].is_generative, false);
    assert.deepEqual(finalized, ["request"]);
});

test("upload uses its pool-selected resource account and is marked non-idempotent", async () => {
    const { finalized, handler, queueAccounts, requests, res } = fixture();
    await handler.processUploadRequest(
        { headers: {}, method: "POST", path: "/upload/v1beta/files", query: {}, rawBody: Buffer.from("data") },
        res
    );
    assert.deepEqual(queueAccounts, [2]);
    assert.equal(requests[0].is_upload, true);
    assert.deepEqual(finalized, ["request"]);
});

for (const method of ["processClaudeCountTokens", "processOpenAIResponseInputTokens"]) {
    test(`${method} uses the selected account and the queue returned after scheduled retries`, async () => {
        const { finalized, handler, queueAccounts, res, selections } = fixture();
        await handler[method]({ body: {}, headers: {} }, res);
        assert.deepEqual(queueAccounts, [2]);
        assert.equal(selections[0].is_generative, false);
        assert.deepEqual(res.body, { input_tokens: 23 });
        assert.deepEqual(finalized, ["request"]);
    });
}
