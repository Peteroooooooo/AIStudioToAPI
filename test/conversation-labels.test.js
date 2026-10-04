const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ConversationLabels = require("../src/core/ConversationLabels");

test("new days restart display numbers while ongoing conversations retain their original label", () => {
    const labels = new ConversationLabels(null, "Asia/Singapore");
    const beforeMidnight = "2026-10-02T15:59:59Z";
    const afterMidnight = "2026-10-02T16:00:00Z";
    assert.deepEqual(labels.labelFor("chat_100", beforeMidnight), {
        conversationDate: "2026-10-02",
        conversationNumber: 1,
    });
    assert.equal(labels.labelFor("chat_200", beforeMidnight).conversationNumber, 2);
    assert.deepEqual(labels.labelFor("chat_300", afterMidnight), {
        conversationDate: "2026-10-03",
        conversationNumber: 1,
    });
    assert.equal(labels.labelFor("chat_100", afterMidnight).conversationDate, "2026-10-02");
    assert.equal(labels.labelFor("chat_100", afterMidnight).conversationNumber, 1);
    assert.equal(labels.labelFor("chat_400", afterMidnight).conversationNumber, 2);
});

test("restart restores labels, timezone and daily counters independently of request history", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-labels-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const labels = new ConversationLabels(directory, "Asia/Singapore");
    const first = labels.labelFor("chat_100", "2026-10-02T16:00:00Z");
    await labels.flush();
    const restored = new ConversationLabels(directory, "UTC");
    assert.deepEqual(restored.labelFor("chat_100", "2026-10-04T16:00:00Z"), first);
    assert.equal(restored.labelFor("chat_200", "2026-10-02T16:01:00Z").conversationNumber, 2);
    assert.deepEqual(restored.labelFor("chat_300", "2026-10-03T16:01:00Z"), {
        conversationDate: "2026-10-04",
        conversationNumber: 1,
    });
    await restored.flush();
});

test("legacy conversion uses each conversation's earliest known request and leaves unknown associations alone", () => {
    const labels = new ConversationLabels(null, "Asia/Singapore");
    const records = [
        { conversationId: "chat_999", startedAt: "2026-10-03T12:00:00Z" },
        { conversationId: "chat_8", startedAt: "2026-10-03T02:00:00Z" },
        { conversationId: "chat_999", startedAt: "2026-10-02T02:00:00Z" },
        { startedAt: "2026-10-02T01:00:00Z", tokenUsage: { cachedInputTokens: 10000 } },
        { conversationId: "chat_999" },
    ];
    labels.hydrate(records);
    assert.equal(records[0].conversationDate, "2026-10-02");
    assert.equal(records[2].conversationDate, records[0].conversationDate);
    assert.equal(records[2].conversationNumber, records[0].conversationNumber);
    assert.equal(records[1].conversationDate, "2026-10-03");
    assert.equal(records[1].conversationNumber, 1);
    assert.equal(records[3].conversationDate, undefined);
    assert.equal(records[4].conversationDate, records[0].conversationDate);
    assert.equal(labels.labelFor("chat_400", undefined), null);
});

test("stored labels do not get renumbered when older records are imported", () => {
    const labels = new ConversationLabels(null, "Asia/Singapore");
    const current = labels.labelFor("chat_100", "2026-10-03T12:00:00Z");
    const imported = [{ conversationId: "chat_200", startedAt: "2026-10-03T01:00:00Z" }];
    labels.hydrate(imported);
    assert.equal(imported[0].conversationNumber, 2);
    assert.equal(labels.labelFor("chat_100", "2026-10-03T12:00:00Z").conversationNumber, current.conversationNumber);
});
