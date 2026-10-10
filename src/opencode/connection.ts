import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { parseEnvText } from "../settings";

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
	return parts.join(" — caused by: ");
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

/** Spawn `opencode serve --service` detached (shared with the CLI) and wait until discoverable. */
async function spawnSharedService(
	binary: string,
	extraEnv: Record<string, string>,
	onLog?: (line: string) => void,
): Promise<void> {
	let child: ChildProcess;
	try {
		child = spawn(binary, ["serve", "--service"], {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, ...extraEnv },
		});
	} catch (cause) {
		throw new Error(`Failed to start opencode background service (${binary})`, { cause });
	}
	const stderrTail: string[] = [];
	child.stderr?.on("data", (chunk: Buffer) => {
		const line = chunk.toString("utf8").trim();
		if (line) {
			stderrTail.push(line);
			if (stderrTail.length > 10) stderrTail.shift();
		}
	});
	const spawnError = await new Promise<Error | null>((resolve) => {
		child.once("error", (e) => resolve(e as Error));
		setTimeout(() => resolve(null), 500);
	});
	if (spawnError) {
		throw new Error(`Failed to start opencode background service (${binary})`, {
			cause: spawnError,
		});
	}

	const deadline = Date.now() + 20_000;
	for (;;) {
		try {
			const found = await Service.discover();
			if (found) {
				onLog?.(`opencode background service ready at ${found.url}`);
				child.unref?.();
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
			const tail = stderrTail.length > 0 ? `\nServer output: ${stderrTail.join("\n")}` : "";
			throw new Error(`Timed out waiting for the opencode background service to register.${tail}`);
		}
		await new Promise((r) => setTimeout(r, 250));
	}
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

	const discovered = await Service.discover().catch(() => undefined);
	if (discovered) {
		onLog?.(`Found running opencode service at ${discovered.url}`);
		return finishConnect(discovered);
	}

	const resolved = resolveBinary(opencodeBin);
	onLog?.(`Starting opencode background service (${resolved.path})…`);
	await spawnSharedService(resolved.path, extra, onLog);
	const endpoint = await Service.discover();
	if (!endpoint) {
		throw new Error("opencode service started but is not discoverable.");
	}
	return finishConnect(endpoint);
}

async function finishConnect(endpoint: {
	url: string;
	auth?: { type: "basic"; username: string; password: string } | undefined;
}): Promise<Connection> {
	const client = OpenCode.make({
		baseUrl: endpoint.url,
		headers: Service.headers(endpoint),
	});
	try {
		await client.server.info();
	} catch (cause) {
		throw new Error(`opencode service at ${endpoint.url} did not answer`, { cause });
	}
	return { client, endpointUrl: endpoint.url, sharedService: true };
}
