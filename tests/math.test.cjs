const test = require("node:test");
const assert = require("node:assert/strict");
const loadTypeScript = require("./ts-loader.cjs");
const math = loadTypeScript("src/ui/math.ts");
const chatUtils = loadTypeScript("src/ui/chat-utils.ts");

test("LaTeX code is converted while ordinary code remains unchanged", () => {
	assert.equal(math.convertLatexCodeToMath("`\\frac{1}{2}`"), "$\\frac{1}{2}$");
	assert.equal(math.convertLatexCodeToMath("`const answer = 42`"), "`const answer = 42`");
});

test("inline math detection rejects dollar expressions embedded in identifiers", () => {
	assert.equal(math.isPlausibleInlineMath("x$amount", 1, "amount"), false);
	assert.equal(math.isPlausibleInlineMath("$amount", 0, "amount"), true);
});

test("fallback rich renderer escapes HTML from message text", () => {
	assert.equal(chatUtils.renderRich("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("model references preserve slashes inside model IDs", () => {
	assert.deepEqual(chatUtils.parseModelRef("provider/model/family"), {
		providerID: "provider",
		id: "model/family",
	});
	assert.equal(chatUtils.parseModelRef("missing-provider"), null);
});
