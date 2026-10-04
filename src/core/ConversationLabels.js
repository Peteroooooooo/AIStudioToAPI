const fs = require("node:fs");
const path = require("node:path");

// Display labels are independent of routing IDs and survive history cleanup.
class ConversationLabels {
    constructor(dataDir, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
        this.filePath = dataDir ? path.join(dataDir, "conversation-labels.json") : null;
        this.labels = new Map();
        this.counters = new Map();
        this.dirty = false;
        this.writePromise = Promise.resolve();
        let saved = {};
        if (this.filePath && fs.existsSync(this.filePath)) saved = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        this.timeZone = saved.timeZone || timeZone;
        this.dateFormatter = new Intl.DateTimeFormat("en-CA", {
            day: "2-digit",
            month: "2-digit",
            timeZone: this.timeZone,
            year: "numeric",
        });
        for (const [date, number] of saved.counters || []) this.counters.set(date, number);
        for (const [id, label] of saved.labels || []) {
            this.labels.set(id, label);
            this.counters.set(
                label.conversationDate,
                Math.max(this.counters.get(label.conversationDate) || 0, label.conversationNumber)
            );
        }
    }

    labelFor(id, startedAt, preferred = {}) {
        if (!/^chat_[1-9]\d*$/.test(id || "")) return null;
        if (this.labels.has(id)) return this.labels.get(id);
        let date = preferred.conversationDate;
        let number = preferred.conversationNumber;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !Number.isSafeInteger(number) || number < 1) {
            const timestamp = Date.parse(startedAt);
            if (!Number.isFinite(timestamp)) return null;
            const parts = Object.fromEntries(
                this.dateFormatter.formatToParts(timestamp).map(part => [part.type, part.value])
            );
            date = `${parts.year}-${parts.month}-${parts.day}`;
            number = (this.counters.get(date) || 0) + 1;
        }
        const label = { conversationDate: date, conversationNumber: number };
        this.labels.set(id, label);
        this.counters.set(date, Math.max(this.counters.get(date) || 0, number));
        this.dirty = true;
        return label;
    }

    hydrate(records) {
        // Preserve saved labels first, then allocate legacy labels in first-seen order.
        for (const record of records) {
            if (record.conversationDate && record.conversationNumber)
                this.labelFor(record.conversationId, record.startedAt, record);
        }
        const ordered = [...records].sort(
            (a, b) => Date.parse(a.startedAt || a.finishedAt) - Date.parse(b.startedAt || b.finishedAt)
        );
        for (const record of ordered) {
            this.labelFor(record.conversationId, record.startedAt || record.finishedAt);
        }
        for (const record of records) {
            const label = this.labels.get(record.conversationId);
            if (label) Object.assign(record, label);
        }
    }

    flush() {
        if (!this.filePath || !this.dirty) return this.writePromise;
        const snapshot = JSON.stringify({
            counters: [...this.counters],
            labels: [...this.labels],
            timeZone: this.timeZone,
            version: 1,
        });
        this.dirty = false;
        this.writePromise = this.writePromise
            .catch(() => {})
            .then(async () => {
                await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
                await fs.promises.writeFile(`${this.filePath}.tmp`, snapshot);
                await fs.promises.rename(`${this.filePath}.tmp`, this.filePath);
            });
        return this.writePromise;
    }
}

module.exports = ConversationLabels;
