import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { parseEnvText } from "../settings";
import { createNodeFetch } from "./node-fetch";

/** Node-stack fetch (no renderer CORS). One instance reused everywhere. */
const nodeFetch = createNodeFetch();

/**
 * Service.discover() probes via global fetch(), which is CORS-blocked in
 * Obsidian's renderer. Temporarily swap in the Node-stack fetch, then
 * restore the original — always, even on failure.
 */
async function discoverService(): Promise<
	Awaited<ReturnType<typeof Service.discover>>
> {
	const original = globalThis.fetch;
	if (original !== nodeFetch) {
		(globalThis as { fetch: typeof fetch }).fetch = nodeFetch;
		try {
			return await Service.discover();
		} finally {
			(globalThis as { fetch: typeof fetch }).fetch = original;
		}
	}
	return Service.discover();
}

export interface Connection {
	client: OpenCodeClient;
	endpointUrl: string;
	sharedService: boolean;
}

/** Full error chain (the client wraps spawn failures, hiding the cause). */
export function describeConnectionError(error: unknown): string {
	const parts: string[] = [];
	let cur: unknown = error;
	while (cur instanceof Error && parts.length < 4) {
		parts.push(cur.message);
		const cause = (cur as { cause?: unknown }).cause;
		if (!cause || cause === cur) break;
		cur = cause;
	}
	if (parts.length === 0) return String(error);
	const details = (error as { details?: string[] }).details;
	const base = parts.join(" — caused by: ");
	return details?.length ? `${base}\n${details.join("\n")}` : base;
}

export interface AttemptDiagnostics {
	at: string;
	configuredBinary: string;
	resolvedPath: string | null;
	tried: string[];
	events: string[];
	outcome: string;
}

let lastAttempt: AttemptDiagnostics | null = null;

export function getLastAttempt(): AttemptDiagnostics | null {
	return lastAttempt;
}

function isWin(): boolean {
	return process.platform === "win32";
}

/** Candidate install locations checked when PATH lookup fails. */
function wellKnownCandidates(): string[] {
	const home = os.homedir();
	const exe = isWin() ? "opencode.exe" : "opencode";
	return [
		path.join(home, "AppData", "Roaming", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
		path.join(home, ".opencode", "bin", exe),
		path.join(home, ".local", "bin", exe),
		path.join("/usr/local/bin", exe),
		path.join("/opt/homebrew/bin", exe),
	];
}

/** Native exe hiding behind an npm shim (…/opencode.cmd -> …/node_modules/@opencode/cli/bin/opencode.exe). */
function exeBehindShim(shimPath: string): string | null {
	if (!isWin()) return null;
	const dir = path.dirname(shimPath);
	const base = path.basename(shimPath, path.extname(shimPath));
	const direct = path.join(dir, `${base}.exe`);
	if (fs.existsSync(direct)) return direct;
	const nested = path.join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
	if (fs.existsSync(nested)) return nested;
	return null;
}

function runWhere(binary: string): string[] {
	try {
		const cmd = isWin() ? "where.exe" : "which";
		const args = isWin() ? [binary] : ["-a", binary];
		const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
		const res = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
		const out = typeof res.stdout === "string" ? res.stdout : "";
		return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

export interface ResolvedBinary {
	path: string;
	tried: string[];
}

/** Resolve a spawnable native binary. Never returns a .cmd/.ps1 shim. */
export function resolveBinary(configured: string): ResolvedBinary {
	const tried: string[] = [];
	const name = (configured || "").trim() || "opencode";

	if (path.isAbsolute(name)) {
		tried.push(name);
		if (fs.existsSync(name)) {
			const behind = exeBehindShim(name);
			return { path: behind ?? name, tried };
		}
		throw new Error(
			`Configured opencode binary not found: ${name}. Tried: ${tried.join(", ")}`,
		);
	}

	for (const found of runWhere(name)) {
		tried.push(found);
		const ext = path.extname(found).toLowerCase();
		if (!isWin() || ext === ".exe") {
			if (fs.existsSync(found)) return { path: found, tried };
			continue;
		}
		const behind = exeBehindShim(found);
		if (behind) return { path: behind, tried };
	}

	for (const candidate of wellKnownCandidates()) {
		// Well-known locations only apply to the default binary name,
		// otherwise any typo would silently resolve to some opencode.exe.
		const base = path.basename(name, path.extname(name)).toLowerCase();
		if (base !== "opencode") break;
		tried.push(candidate);
		if (fs.existsSync(candidate)) return { path: candidate, tried };
	}

	throw new Error(
		`Could not find a spawnable opencode binary (npm .cmd/.ps1 shims don't work without a shell). ` +
			`Set the absolute path to opencode.exe in the plugin settings. Tried: ${tried.join(", ") || "(nothing found)"}`,
	);
}

/** Directories that GUI-launched processes often miss but MCP servers need. */
function extraPathDirs(): string[] {
	const dirs: string[] = [];
	const home = os.homedir();
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? "";
		const localApp = process.env.LOCALAPPDATA ?? "";
		dirs.push(
			path.join(appData, "npm"),
			"C:\\Program Files\\nodejs",
			"C:\\Program Files\\Git\\cmd",
			path.join(localApp, "Programs", "Python", "Python313", "Scripts"),
			"C:\\Windows\\System32",
		);
	} else {
		dirs.push("/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local", "bin"));
	}
	return dirs.filter((d) => {
		try {
			return fs.existsSync(d);
		} catch {
			return false;
		}
	});
}

function enhancedPath(): string {
	const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const seen = new Set(current.map((d) => d.toLowerCase()));
	for (const dir of extraPathDirs()) {
		if (!seen.has(dir.toLowerCase())) {
			current.push(dir);
			seen.add(dir.toLowerCase());
		}
	}
	return current.join(path.delimiter);
}

/** Spawn `opencode serve --service` detached (shared with the CLI) and wait until discoverable. */
async function spawnSharedService(
	binary: string,
	extraEnv: Record<string, string>,
	events: string[],
	onLog?: (line: string) => void,
): Promise<void> {
	// Never pile up contenders from earlier attempts (e.g. 60s reconnect timer).
	if (activeContender && activeContender.exitCode === null) {
		events.push("killing stale contender from previous attempt");
		try {
			activeContender.kill();
		} catch {
			/* already gone */
		}
	}
	activeContender = null;

	const say = (line: string): void => {
		events.push(line);
		onLog?.(line);
	};

	let child: ChildProcess;
	try {
		child = spawn(binary, ["serve", "--service"], {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
			// GUI apps inherit a thin PATH; MCP stdio servers (npx, python…)
			// would fail to resolve without the usual terminal locations.
			env: { ...process.env, ...extraEnv, PATH: enhancedPath() },
		});
	} catch (cause) {
		throw withDetails(
			new Error(`Failed to start opencode background service (${binary})`, { cause }),
			events,
		);
	}
	activeContender = child;
	say(`spawned pid ${child.pid ?? "?"}: ${binary} serve --service`);
	const stderrTail: string[] = [];
	child.stderr?.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString("utf8").split(/\r?\n/)) {
			const t = line.trim();
			if (t) {
				stderrTail.push(t);
				if (stderrTail.length > 10) stderrTail.shift();
			}
		}
	});
	let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	const getEarlyExit = (): { code: number | null; signal: NodeJS.Signals | null } | null => earlyExit;
	child.once("close", (code, signal) => {
		earlyExit = { code, signal };
		if (activeContender === child) activeContender = null;
	});
	const spawnError = await new Promise<Error | null>((resolve) => {
		child.once("error", (e) => resolve(e as Error));
		setTimeout(() => resolve(null), 500);
	});
	if (spawnError) {
		throw withDetails(
			new Error(`Failed to start opencode background service (${binary})`, {
				cause: spawnError,
			}),
			events,
		);
	}

	const deadline = Date.now() + 45_000;
	let lastProgress = 0;
	for (;;) {
		// Fail fast: the server died instead of registering (bad config, crash, …).
		const exited = getEarlyExit();
		if (exited && child.exitCode !== 0) {
			const tail =
				stderrTail.length > 0 ? `\nServer output:\n${stderrTail.join("\n")}` : "";
			throw withDetails(
				new Error(
					`opencode background service exited immediately (code ${exited.code ?? "?"}${exited.signal ? `, signal ${exited.signal}` : ""}) instead of registering.${tail}`,
				),
				events,
			);
		}
		// A second `serve --service` next to a healthy one exits 0 silently —
		// that just means someone else already won; discover below will find it.
		try {
			const found = await discoverService();
			if (found) {
				say(`service ready at ${found.url}`);
				child.unref?.();
				activeContender = null;
				return;
			}
		} catch {
			/* not ready yet */
		}
		if (Date.now() > deadline) {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
			activeContender = null;
			const tail =
				stderrTail.length > 0 ? `\nLast server output:\n${stderrTail.join("\n")}` : "";
			throw withDetails(
				new Error(
					`Timed out waiting for the opencode background service to register (45s). ` +
						`Copy diagnostics from Settings if this persists.${tail}`,
				),
				events,
			);
		}
		if (Date.now() - lastProgress > 5000) {
			lastProgress = Date.now();
			const waited = Math.round((45_000 - (deadline - Date.now())) / 1000);
			say(
				`still waiting for service registration… (${waited}s)` +
					(stderrTail.length > 0 ? ` — server says: ${stderrTail[stderrTail.length - 1]}` : ""),
			);
		}
		await new Promise((r) => setTimeout(r, 250));
	}
}

let activeContender: ChildProcess | null = null;

function withDetails(error: Error, events: string[]): Error {
	(error as { details?: string[] }).details = [...events];
	return error;
}

/**
 * Connect to the *shared* opencode background service — the same server the
 * CLI TUI uses. Plugin and CLI read/write the same session DB through the
 * same server, so `/session` on either side lists the same sessions.
 *
 * Deliberately does NOT use Service.ensure(): its internal spawn cannot run
 * npm .cmd/.ps1 shims on Windows, which surfaces as a bare
 * "Failed to start server". We resolve a native binary ourselves and only
 * then spawn `serve --service`.
 */
export async function connectShared(
	opencodeBin: string,
	extraEnvText: string,
	onLog?: (line: string) => void,
): Promise<Connection> {
	const extra = parseEnvText(extraEnvText);
	for (const [k, v] of Object.entries(extra)) {
		if (!(k in process.env)) process.env[k] = v;
	}

	const attempt: AttemptDiagnostics = {
		at: new Date().toISOString(),
		configuredBinary: (opencodeBin || "").trim() || "opencode",
		resolvedPath: null,
		tried: [],
		events: [],
		outcome: "pending",
	};
	lastAttempt = attempt;
	const say = (line: string): void => {
		attempt.events.push(line);
		onLog?.(line);
	};

	try {
		const discovered = await discoverService().catch(() => undefined);
		if (discovered) {
			say(`Found running opencode service at ${discovered.url}`);
			const conn = await finishConnect(discovered);
			attempt.outcome = `connected to ${discovered.url}`;
			return conn;
		}
		say("no running service discovered");

		const resolved = resolveBinary(opencodeBin);
		attempt.resolvedPath = resolved.path;
		attempt.tried = resolved.tried;
		say(`resolved binary: ${resolved.path}`);
		say("starting opencode background service…");
		await spawnSharedService(resolved.path, extra, attempt.events, onLog);
		const endpoint = await discoverService();
		if (!endpoint) {
			throw withDetails(
				new Error("opencode service started but is not discoverable."),
				attempt.events,
			);
		}
		const conn = await finishConnect(endpoint);
		attempt.outcome = `connected to ${endpoint.url}`;
		return conn;
	} catch (e) {
		attempt.outcome = `failed: ${e instanceof Error ? e.message : String(e)}`;
		throw e;
	}
}

async function finishConnect(endpoint: {
	url: string;
	auth?: { type: "basic"; username: string; password: string } | undefined;
}): Promise<Connection> {
	const client = OpenCode.make({
		baseUrl: endpoint.url,
		headers: Service.headers(endpoint),
		fetch: nodeFetch,
	});
	try {
		await client.server.info();
	} catch (cause) {
		throw new Error(`opencode service at ${endpoint.url} did not answer`, { cause });
	}
	return { client, endpointUrl: endpoint.url, sharedService: true };
}
