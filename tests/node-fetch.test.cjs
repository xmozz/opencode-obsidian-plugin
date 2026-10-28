const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const loadTypeScript = require("./ts-loader.cjs");
const { createNodeFetch } = loadTypeScript("src/opencode/node-fetch.ts");

test("aborting after response headers closes a streaming response body", async (t) => {
	let clientClosed;
	const closed = new Promise((resolve) => {
		clientClosed = resolve;
	});
	const server = http.createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write("data: ready\n\n");
		response.on("close", clientClosed);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const address = server.address();
	const controller = new AbortController();
	const response = await createNodeFetch()(
		`http://127.0.0.1:${address.port}/events`,
		{ signal: controller.signal },
	);
	const reader = response.body.getReader();
	const first = await reader.read();
	assert.match(new TextDecoder().decode(first.value), /data: ready/);
	controller.abort(new Error("test abort"));
	await assert.rejects(reader.read(), /test abort/);
	await closed;
});
