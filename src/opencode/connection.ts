import type { OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { parseEnvText } from "../settings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;

export interface Connection {
	client: OpenCodeClient;
	endpointUrl: string;
	sharedService: boolean;
}

function nodeRequire(id: string): unknown {
	try {
		// Obsidian desktop exposes Node's require at runtime.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return require(id);
	} catch {
		return undefined;
	}
}

function applyExtraEnv(extra: Record<string, string>): void {
	// Service.ensure() spawns `opencode serve --service` inheriting process.env,
	// so extra env (API keys etc.) must be present before ensure().
	for (const [k, v] of Object.entries(extra)) {
		if (!(k in process.env)) process.env[k] = v;
	}
}

/**
 * Connect to the *shared* opencode background service — the same server the
 * CLI TUI uses. This is the core of the "synced sessions" requirement:
 * plugin and CLI read/write the same session DB through the same server,
 * so `/session` on either side lists the same sessions.
 */
export async function connectShared(
	opencodeBin: string,
	extraEnvText: string,
): Promise<Connection> {
	const extra = parseEnvText(extraEnvText);
	applyExtraEnv(extra);

	const command = opencodeBin.trim() || "opencode";
	// Ensure the shared background service is running (spawns
	// `opencode serve --service` if needed) and connect to it.
	const endpoint = await Service.ensure({
		command: [command, "serve", "--service"],
	});
	const headers = Service.headers(endpoint);
	const auth = endpoint.auth
		? {
				username: endpoint.auth.username,
				password: endpoint.auth.password,
			}
		: undefined;
	const client = OpenCode.make({
		baseUrl: endpoint.url,
		headers,
		...(auth ? { auth } : {}),
	} as unknown as Parameters<typeof OpenCode.make>[0]);
	// Probe that the server answers.
	await client.server.info();
	return { client, endpointUrl: endpoint.url, sharedService: true };
}

export function describeConnectionError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export { nodeRequire };
