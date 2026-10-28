const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const loadTypeScript = require("./ts-loader.cjs");
const sessions = loadTypeScript("src/opencode/sessions.ts");

test("safe mode asks for every permission even when read-only is selected", () => {
	assert.deepEqual(sessions.permissionRulesForMode("safe", { readOnly: true }), [
		{ action: "*", resource: "*", effect: "ask" },
	]);
});

test("full read-only mode asks for shell and blocks edits when plan agent is absent", () => {
	assert.deepEqual(sessions.permissionRulesForMode("full", { readOnly: true }), [
		{ action: "edit", resource: "*", effect: "deny" },
		{ action: "shell", resource: "*", effect: "ask" },
	]);
});

test("vault mode asks for access outside the vault", () => {
	assert.deepEqual(sessions.permissionRulesForMode("vault"), [
		{ action: "*", resource: "*", effect: "allow" },
		{ action: "external_directory", resource: "*", effect: "ask" },
	]);
});

test("context suffix stripping preserves the user-authored prompt", () => {
	assert.equal(
		sessions.stripXmlContext("Explain this note\n\n<current_note>note.md</current_note>"),
		"Explain this note",
	);
});

test("unified diff parser counts additions and removals", () => {
	assert.deepEqual(sessions.countDiff("@@ -1 +1 @@\n-old\n+new\n same"), {
		added: 1,
		removed: 1,
	});
});

test("external text files are read asynchronously", async (t) => {
	const filename = path.join(os.tmpdir(), `opencode-obsidian-${process.pid}.txt`);
	await fs.writeFile(filename, "external context", "utf8");
	t.after(() => fs.rm(filename, { force: true }));
	const result = await sessions.readExternalTextFile(filename);
	assert.equal(result.text, "external context");
	assert.equal(result.error, undefined);
});
