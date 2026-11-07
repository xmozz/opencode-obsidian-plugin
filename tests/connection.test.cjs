const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const loadTypeScript = require("./ts-loader.cjs");

// `@opencode/client` ships ESM-only export conditions, and connection.ts imports
// sibling `.ts` modules with extensionless specifiers. Teach this test process
// to resolve both so the source can be loaded without changing it.
const clientRoot = path.resolve(
	__dirname,
	"..",
	"node_modules",
	"@opencode",
	"client",
);
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
	const mapped =
		request === "@opencode/client"
			? path.join(clientRoot, "dist", "promise", "index.js")
			: request === "@opencode/client/service"
				? path.join(clientRoot, "dist", "promise", "service.js")
				: null;
	return resolveFilename.call(this, mapped ?? request, parent, isMain, options);
};
require.extensions[".ts"] = function (module, filename) {
	const output = ts.transpileModule(fsSync.readFileSync(filename, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2020,
			esModuleInterop: true,
		},
	}).outputText;
	module._compile(output, filename);
};

const connection = loadTypeScript("src/opencode/connection.ts");

function missingPath(label) {
	return path.join(os.tmpdir(), `${label}-${process.pid}-${randomUUID()}`);
}

test("resolveBinary resolves an absolute native executable asynchronously", async () => {
	const pending = connection.resolveBinary(process.execPath);
	assert.ok(pending instanceof Promise, "resolveBinary should return a Promise");
	const resolved = await pending;
	assert.equal(resolved.path, process.execPath);
	assert.deepEqual(resolved.tried, [process.execPath]);
});

test("resolveBinary rejects a missing absolute binary path", async () => {
	await assert.rejects(connection.resolveBinary(missingPath("opencode-missing")), /not found/i);
});

test(
	"resolveBinary rejects a Windows script shim instead of spawning it",
	{ skip: process.platform !== "win32" },
	async (t) => {
		const shim = `${missingPath("opencode-shim")}.cmd`;
		await fs.writeFile(shim, "@echo off\r\n", "utf8");
		t.after(() => fs.rm(shim, { force: true }));
		await assert.rejects(connection.resolveBinary(shim), /script shim/);
	},
);

test("resolveBinary rejects a bare binary name that is not on PATH", async () => {
	const name = `opencode-definitely-missing-${randomUUID()}`;
	await assert.rejects(
		connection.resolveBinary(name),
		/Could not find a spawnable opencode binary/,
	);
});

test("probeVersion reads the version from a native binary", async () => {
	const events = [];
	const version = await connection.probeVersion(process.execPath, events);
	assert.match(version, /^\d+\.\d+\.\d+$/);
	assert.deepEqual(events, [`opencode version: ${version}`]);
});

test("probeVersion returns null when no version can be parsed", async () => {
	const events = [];
	const version = await connection.probeVersion(missingPath("opencode-missing"), events);
	assert.equal(version, null);
	assert.deepEqual(events, ["could not parse opencode version output"]);
});

test("looksLikeHelpText recognizes CLI help output", () => {
	assert.equal(connection.looksLikeHelpText(["Usage:", "Commands:"]), true);
	assert.equal(connection.looksLikeHelpText(["... port to listen on ..."]), true);
});

test("looksLikeHelpText ignores crash output", () => {
	assert.equal(connection.looksLikeHelpText(["some crash trace"]), false);
	assert.equal(connection.looksLikeHelpText([]), false);
});

test("describeConnectionError includes the whole cause chain", () => {
	assert.equal(
		connection.describeConnectionError(
			new Error("outer", { cause: new Error("inner") }),
		),
		"outer — caused by: inner",
	);
});

test("describeConnectionError stops after four cause messages", () => {
	let error = new Error("fifth");
	for (const message of ["fourth", "third", "second", "first"]) {
		error = new Error(message, { cause: error });
	}
	assert.equal(
		connection.describeConnectionError(error),
		"first — caused by: second — caused by: third — caused by: fourth",
	);
});

test("describeConnectionError appends diagnostic details", () => {
	const error = new Error("boom");
	error.details = ["line one", "line two"];
	assert.equal(
		connection.describeConnectionError(error),
		"boom\nline one\nline two",
	);
});

test("describeConnectionError falls back to String for non-Error values", () => {
	assert.equal(connection.describeConnectionError("plain failure"), "plain failure");
	assert.equal(connection.describeConnectionError(42), "42");
});
