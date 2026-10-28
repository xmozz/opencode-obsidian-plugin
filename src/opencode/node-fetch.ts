import * as http from "node:http";
import * as https from "node:https";

/**
 * fetch() built on Node's HTTP stack instead of the renderer's DOM fetch.
 * Obsidian's renderer enforces CORS, so browser fetch() against the local
 * opencode server (which does not allow the app origin) always fails —
 * while Node's stack has no CORS concept. Same approach as Grimoire's
 * createNodeFetch, implemented here from scratch.
 *
 * Supports what @opencode/client needs: GET/POST with string or binary
 * bodies, response.text()/json(), and streaming bodies (SSE event stream).
 */
export function createNodeFetch(): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = toUrl(input);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const headers = mergeHeaders(input, init);
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const body = await toBodyBytes(init?.body ?? (input instanceof Request ? input.body : undefined));

		return new Promise<Response>((resolve, reject) => {
			let settled = false;
			const fail = (error: unknown): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			};
			const onAbort = (): void => {
				req.destroy(new Error("Request aborted"));
				fail(signal?.reason ?? new Error("Request aborted"));
			};

			const requestHeaders: Record<string, string> = {};
			headers.forEach((value, key) => {
				requestHeaders[key] = value;
			});
			if (body) requestHeaders["content-length"] = String(body.byteLength);

			const transport = url.protocol === "https:" ? https : http;
			const req = transport.request(url, { method, headers: requestHeaders }, (res) => {
				if (settled) return;
				signal?.removeEventListener("abort", onAbort);
				// buildResponse can throw (e.g. a null-body status such as 204
				// passed to the Response constructor). Reject instead of leaving
				// the promise pending forever.
				let response: Response;
				try {
					response = buildResponse(res, signal);
				} catch (error) {
					res.destroy();
					fail(error);
					return;
				}
				settled = true;
				resolve(response);
			});
			req.on("error", (error: Error) => fail(error));

			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			if (body) req.end(body);
			else req.end();
		});
	}) as typeof fetch;
}

function toUrl(input: string | URL | Request): URL {
	if (typeof input === "string") return new URL(input);
	if (input instanceof URL) return input;
	return new URL(input.url);
}

function mergeHeaders(input: string | URL | Request, init?: RequestInit): Headers {
	const headers = new Headers();
	if (input instanceof Request) {
		input.headers.forEach((value, key) => headers.append(key, value));
	}
	const extra = init?.headers;
	if (!extra) return headers;
	if (extra instanceof Headers) {
		extra.forEach((value, key) => headers.set(key, value));
	} else if (Array.isArray(extra)) {
		for (const [key, value] of extra) headers.set(key, value);
	} else {
		for (const [key, value] of Object.entries(extra)) headers.set(key, value);
	}
	return headers;
}

async function toBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
	if (body == null) return null;
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	if (typeof (body as ReadableStream).getReader === "function") {
		const reader = (body as ReadableStream<Uint8Array>).getReader();
		const chunks: Uint8Array[] = [];
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		const total = chunks.reduce((n, c) => n + c.byteLength, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		for (const c of chunks) {
			out.set(c, offset);
			offset += c.byteLength;
		}
		return out;
	}
	throw new Error(`Unsupported request body type: ${typeof body}`);
}

function buildResponse(res: http.IncomingMessage, signal?: AbortSignal): Response {
	const headers = new Headers();
	for (const [key, value] of Object.entries(res.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v);
		} else {
			headers.append(key, value);
		}
	}
	const status = res.statusCode ?? 200;
	// Null-body statuses must not carry a body: the Response constructor throws
	// for a 204/205/304 with a stream attached.
	if (status === 204 || status === 205 || status === 304) {
		res.resume(); // drain so the keep-alive socket is freed
		return new Response(null, {
			status,
			statusText: res.statusMessage ?? "",
			headers,
		});
	}
	let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
	let streamSettled = false;
	const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
	const settle = (error?: Error): void => {
		if (streamSettled) return;
		streamSettled = true;
		cleanup();
		try {
			if (error) controllerRef?.error(error);
			else controllerRef?.close();
		} catch {
			/* The consumer may already have canceled the stream. */
		}
	};
	const onAbort = (): void => {
		const reason = signal?.reason ?? new Error("Request aborted");
		res.destroy(reason instanceof Error ? reason : new Error(String(reason)));
		settle(reason instanceof Error ? reason : new Error(String(reason)));
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controllerRef = controller;
			res.on("data", (chunk: Buffer | string) => {
				if (streamSettled) return;
				// Copy: Node reuses Buffer pool memory, views would corrupt.
				const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				controller.enqueue(new Uint8Array(buffer));
			});
			res.on("end", () => settle());
			res.on("error", (error: Error) => settle(error));
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		},
		cancel(reason?: unknown) {
			streamSettled = true;
			cleanup();
			res.destroy(reason instanceof Error ? reason : undefined);
		},
	});
	return new Response(stream, {
		status,
		statusText: res.statusMessage ?? "",
		headers,
	});
}
