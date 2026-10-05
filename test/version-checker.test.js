const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const VersionChecker = require("../src/utils/VersionChecker");

test("P releases migrate from the previous fork series and compare numerically", () => {
    const checker = new VersionChecker();
    assert.equal(checker.getCurrentVersion(), process.env.VERSION || require("../package.json").releaseName);
    assert.equal(checker.compareVersions("P.18", "v1.3.5-peter.17"), 1);
    assert.equal(checker.compareVersions("P.18", "v1.3.5-peter.18"), 0);
    assert.equal(checker.compareVersions("P.100", "P.99"), 1);
    assert.equal(checker.compareVersions("P.18", "P.19"), -1);
});

test("update discovery selects the newest published fork image and ignores unrelated upstream tags", async t => {
    const checker = new VersionChecker();
    t.mock.method(checker, "getCurrentVersion", () => "P.18");
    const get = axios.get;
    axios.get = async () => ({
        data: [
            { name: "v99.0.0" },
            { name: "P.20" },
            { name: "P.19" },
            { name: "v1.3.5-peter.17" },
            { name: "P.preview" },
        ],
    });
    const checked = [];
    checker.checkDockerImageExists = async tag => {
        checked.push(tag);
        return tag === "P.19";
    };
    try {
        const result = await checker.checkForUpdates();
        assert.deepEqual(checked, ["P.20", "P.19"]);
        assert.equal(result.current, "P.18");
        assert.equal(result.latest, "P.19");
        assert.equal(result.hasUpdate, true);
    } finally {
        axios.get = get;
    }
});
