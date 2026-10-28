const test = require("node:test");
const assert = require("node:assert/strict");
const loadTypeScript = require("./ts-loader.cjs");
const fileContext = loadTypeScript("src/ui/file-context.ts");
const sessions = loadTypeScript("src/opencode/sessions.ts");

test("Electron webUtils supplies the native file path", () => {
	const file = {};
	assert.equal(
		fileContext.getNativeFilePath(file, { getPathForFile: () => "C:\\Users\\me\\Downloads\\notes.txt" }),
		"C:\\Users\\me\\Downloads\\notes.txt",
	);
});

test("legacy File.path remains a fallback and missing paths are not guessed", () => {
	assert.equal(fileContext.getNativeFilePath({ path: "D:\\external.txt" }, {}), "D:\\external.txt");
	assert.equal(fileContext.getNativeFilePath({}, {}), "");
});

test("picked paths become vault-relative only when they are inside the vault", () => {
	assert.equal(
		fileContext.fileContextReference("note.txt", "C:\\Vault", "C:\\Vault\\folder\\note.txt"),
		"folder/note.txt",
	);
	assert.equal(
		fileContext.fileContextReference("note.txt", "C:\\Vault", "C:\\Users\\me\\Downloads\\note.txt"),
		"C:/Users/me/Downloads/note.txt",
	);
});

test("external attachment prompt explicitly carries its absolute path", () => {
	const prompt = sessions.appendExternalFile("Summarize this", {
		path: "C:/Users/me/Downloads/notes.txt",
		text: "Attached text",
	});
	assert.match(prompt, /Absolute filesystem path: C:\/Users\/me\/Downloads\/notes\.txt/);
	assert.match(prompt, /Use the supplied content instead of searching the vault/);
	assert.match(prompt, /Attached text/);
});
