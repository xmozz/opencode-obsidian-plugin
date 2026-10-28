const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const cache = new Map();

module.exports = function loadTypeScript(relativePath) {
	const filename = path.resolve(__dirname, "..", relativePath);
	if (cache.has(filename)) return cache.get(filename);
	const source = fs.readFileSync(filename, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2020,
			esModuleInterop: true,
		},
	}).outputText;
	const compiled = new Module(filename, module);
	compiled.filename = filename;
	compiled.paths = Module._nodeModulePaths(path.dirname(filename));
	compiled._compile(output, filename);
	cache.set(filename, compiled.exports);
	return compiled.exports;
};
