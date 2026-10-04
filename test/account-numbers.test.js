const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const labels = import(
    `data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(__dirname, "../ui/app/utils/accountNumbers.js"), "utf8"))}`
);

test("deletion and filtering preserve account action identities while displaying contiguous numbers", async () => {
    const { numberAccounts, accountDisplayIndex } = await labels;
    const original = [{ index: 30 }, { index: 4 }, { index: 22 }];
    const accounts = numberAccounts(original);
    assert.deepEqual(
        accounts.map(account => [account.index, account.displayIndex]),
        [
            [4, 1],
            [22, 2],
            [30, 3],
        ]
    );
    assert.deepEqual(original, [{ index: 30 }, { index: 4 }, { index: 22 }]);
    assert.equal(accounts.filter(account => account.index === 22)[0].displayIndex, 2);
    const afterDeletion = numberAccounts(accounts.filter(account => account.index !== 22));
    assert.deepEqual(
        afterDeletion.map(account => [account.index, account.displayIndex]),
        [
            [4, 1],
            [30, 2],
        ]
    );
    assert.equal(accountDisplayIndex(afterDeletion, 30), 2);
});

test("historical usage follows account identity without relabeling a deleted account as an index replacement", async () => {
    const { numberAccounts, accountDisplayLabel } = await labels;
    const accounts = numberAccounts([
        { index: 4, name: "replacement@example.com" },
        { index: 22, name: "d@example.com" },
    ]);
    assert.equal(accountDisplayLabel({ accountName: "D@example.com", authIndex: 4 }, accounts), "#2 D@example.com");
    assert.equal(
        accountDisplayLabel({ accountName: "deleted@example.com", authIndex: 4 }, accounts),
        "deleted@example.com"
    );
    assert.equal(accountDisplayLabel({ finalAuthIndex: 22 }, accounts), "#2 d@example.com");
    assert.equal(accountDisplayLabel({ finalAuthIndex: null }, accounts), "—");
});
