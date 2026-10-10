import type { OpenCodeClient } from "@opencode/client";

export interface VaultSession {
	id: string;
	title: string;
	directory: string;
	agent: string;
	modelProvider: string;
	modelId: string;
	modelVariant?: string;
	updated: number;
}

export interface ChatPart {
	type: string;
	text?: string;
	tool?: string;
	toolId?: string;
	input?: Record<string, unknown>;
	output?: string;
	status?: string;
	reasoning?: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	reasoning: string[];
	tools: ChatPart[];
	timestamp: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function normalizeDir(dir: string): string {
	return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** List sessions for this vault directory only (shared DB, filtered by cwd). */
export async function listVaultSessions(
	client: OpenCodeClient,
	vaultDir: string,
	limit = 100,
): Promise<VaultSession[]> {
	const res = await client.session.list({
		directory: vaultDir,
		limit,
	} as unknown as Parameters<OpenCodeClient["session"]["list"]>[0]);
	const data = (res as unknown as AnyRecord).data ?? res;
	const arr: AnyRecord[] = Array.isArray(data) ? data : (data.sessions ?? []);
	const want = normalizeDir(vaultDir);
	return arr
		.filter((s) => {
			const d =
				s.directory ?? s.location?.directory ?? s.project?.directory ?? "";
			if (!d) return true; // unscoped listing already filtered server-side
			return normalizeDir(String(d)) === want;
		})
		.map((s) => ({
			id: String(s.id ?? s.sessionID ?? s.sessionId ?? ""),
			title: String(s.title ?? s.name ?? "Untitled session"),
			directory: String(s.directory ?? s.location?.directory ?? vaultDir),
			agent: String(s.agent ?? ""),
			modelProvider: String(s.model?.providerID ?? s.model?.provider ?? ""),
			modelId: String(s.model?.id ?? s.model?.model ?? ""),
			modelVariant:
				(s.model?.variant as string | undefined) ?? undefined,
			updated: Number(
				s.updated ?? s.time?.updated ?? s.time?.created ?? Date.now(),
			),
		}))
		.filter((s) => s.id);
}

export async function createVaultSession(
	client: OpenCodeClient,
	vaultDir: string,
	model?: { providerID: string; id: string },
	agent?: string,
	title?: string,
): Promise<VaultSession> {
	const input: AnyRecord = { location: { directory: vaultDir } };
	if (model) input.model = model;
	if (agent) input.agent = agent;
	if (title) input.title = title;
	const s = (await client.session.create(
		input as Parameters<OpenCodeClient["session"]["create"]>[0],
	)) as unknown as AnyRecord;
	return {
		id: String(s.id),
		title: String(s.title ?? "New session"),
		directory: String(s.directory ?? s.location?.directory ?? vaultDir),
		agent: String(s.agent ?? agent ?? ""),
		modelProvider: String(s.model?.providerID ?? model?.providerID ?? ""),
		modelId: String(s.model?.id ?? model?.id ?? ""),
		updated: Date.now(),
	};
}

export async function removeSession(
	client: OpenCodeClient,
	sessionID: string,
): Promise<void> {
	await client.session.remove({ sessionID } as Parameters<
		OpenCodeClient["session"]["remove"]
	>[0]);
}

export async function renameSession(
	client: OpenCodeClient,
	sessionID: string,
	title: string,
): Promise<void> {
	await client.session.update(
		{ sessionID, title } as Parameters<
			OpenCodeClient["session"]["update"]
		>[0],
	);
}

export async function forkSession(
	client: OpenCodeClient,
	sessionID: string,
	messageID?: string,
): Promise<VaultSession> {
	const s = (await client.session.fork({
		sessionID,
		...(messageID ? { messageID } : {}),
	} as Parameters<OpenCodeClient["session"]["fork"]>[0])) as unknown as AnyRecord;
	return {
		id: String(s.id),
		title: String(s.title ?? "Forked session"),
		directory: String(s.directory ?? s.location?.directory ?? ""),
		agent: String(s.agent ?? ""),
		modelProvider: String(s.model?.providerID ?? ""),
		modelId: String(s.model?.id ?? ""),
		updated: Date.now(),
	};
}

/**
 * Native history hydration via the official API — no extra files, no SQLite.
 * Message shape (client 2.x): user messages carry `text` at top level,
 * assistant messages carry a `content` array (text/reasoning/tool parts).
 */
export async function loadSessionMessages(
	client: OpenCodeClient,
	sessionID: string,
	limit = 200,
): Promise<ChatMessage[]> {
	const out: ChatMessage[] = [];
	// message.list caps limit at 200; follow the cursor for long sessions.
	let cursor: string | undefined;
	for (let page = 0; page < 5; page++) {
		const res = (await client.message.list({
			sessionID,
			limit: Math.min(limit, 200),
			...(cursor ? { cursor } : {}),
		} as unknown as Parameters<OpenCodeClient["message"]["list"]>[0])) as unknown as AnyRecord;
		const data: AnyRecord[] = Array.isArray(res) ? res : (res.data ?? []);
		for (const m of data) out.push(...parseMessage(m));
		const next = (res.cursor as AnyRecord | undefined)?.next as string | undefined;
		if (!next || data.length === 0) break;
		cursor = next;
		if (out.length >= limit) break;
	}
	out.sort((a, b) => a.timestamp - b.timestamp);
	return out.slice(-limit);
}

function parseMessage(m: AnyRecord): ChatMessage[] {
	const type = m.type as string;
	const ts = Number(m.time?.created ?? Date.now());
	if (type === "user") {
		const text = String(
			m.text ?? m.metadata?.displayText ?? "",
		).trim();
		if (!text) return [];
		return [
			{
				id: String(m.id ?? `user-${ts}`),
				role: "user",
				text,
				reasoning: [],
				tools: [],
				timestamp: ts,
			},
		];
	}
	if (type === "assistant") {
		const texts: string[] = [];
		const reasoning: string[] = [];
		const tools: ChatPart[] = [];
		for (const p of (m.content ?? []) as AnyRecord[]) {
			if (!p || typeof p !== "object") continue;
			if (p.type === "text" && typeof p.text === "string" && p.text) {
				texts.push(p.text);
			} else if (
				p.type === "reasoning" &&
				typeof p.text === "string" &&
				p.text
			) {
				reasoning.push(p.text);
			} else if (p.type === "tool") {
				const state: AnyRecord = (p.state ?? {}) as AnyRecord;
				const contentText = Array.isArray(state.content)
					? (state.content as AnyRecord[])
							.filter((c) => c?.type === "text" && typeof c.text === "string")
							.map((c) => c.text as string)
							.join("\n")
					: "";
				const output =
					contentText ||
					(typeof state.output === "string" ? state.output : "") ||
					(typeof state.error === "string" ? state.error : "") ||
					undefined;
				tools.push({
					type: "tool",
					tool: String(p.name ?? "tool"),
					toolId: String(p.id ?? ""),
					input: (state.input as Record<string, unknown>) ?? {},
					output,
					status: mapStatus(state.status),
				});
			}
		}
		const text = texts.join("").trim();
		if (!text && reasoning.length === 0 && tools.length === 0) return [];
		return [
			{
				id: String(m.id ?? `asst-${ts}`),
				role: "assistant",
				text,
				reasoning,
				tools,
				timestamp: ts,
			},
		];
	}
	return [];
}

function mapStatus(status: unknown): string {
	if (status === "running" || status === "pending") return "running";
	if (status === "error" || status === "failed") return "error";
	return "completed";
}

export async function sendPrompt(
	client: OpenCodeClient,
	sessionID: string,
	text: string,
): Promise<void> {
	// Detect local-only slash commands handled by the UI layer.
	await client.session.prompt({
		sessionID,
		text,
	} as unknown as Parameters<OpenCodeClient["session"]["prompt"]>[0]);
}

export async function interruptSession(
	client: OpenCodeClient,
	sessionID: string,
): Promise<void> {
	await client.session.interrupt({ sessionID } as Parameters<
		OpenCodeClient["session"]["interrupt"]
	>[0]);
}

export async function switchModel(
	client: OpenCodeClient,
	sessionID: string,
	providerID: string,
	modelID: string,
	variant?: string,
): Promise<void> {
	await client.session.switchModel({
		sessionID,
		model: {
			providerID,
			id: modelID,
			...(variant && variant !== "default" ? { variant } : {}),
		},
	} as unknown as Parameters<OpenCodeClient["session"]["switchModel"]>[0]);
}

export async function switchAgent(
	client: OpenCodeClient,
	sessionID: string,
	agent: string,
): Promise<void> {
	await client.session.switchAgent({ sessionID, agent } as Parameters<
		OpenCodeClient["session"]["switchAgent"]
	>[0]);
}

export async function runSessionCommand(
	client: OpenCodeClient,
	sessionID: string,
	name: string,
	text: string,
): Promise<void> {
	await client.session.command({
		sessionID,
		name,
		text,
	} as unknown as Parameters<OpenCodeClient["session"]["command"]>[0]);
}

export async function replyPermission(
	client: OpenCodeClient,
	requestID: string,
	reply: "accept" | "reject" | "accept-session",
): Promise<void> {
	await client.permission.reply({
		requestID,
		reply,
	} as unknown as Parameters<OpenCodeClient["permission"]["reply"]>[0]);
}
