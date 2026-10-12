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
	/** First user message preview (filled lazily for untitled sessions). */
	preview?: string;
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
	/** Unified-diff patches for file edits (from tool metadata). */
	diffs?: Array<{ file: string; patch: string; created?: boolean }>;
	/** Resolved file path for file tools (edit/write/read/…). */
	filePath?: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	reasoning: string[];
	tools: ChatPart[];
	timestamp: number;
	/** Turn duration in seconds (assistant only, when the server reports it). */
	durationSeconds?: number;
	/** Provider/model error reported for this turn (rendered as an error block). */
	error?: string;
	/** Per-message token usage (that turn's context, not the session total). */
	tokens?: { input: number; output: number; cache: number };
	/** Per-message cost in USD. */
	cost?: number;
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
			title: String(s.title ?? s.name ?? ""),
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
	before?: string,
): Promise<VaultSession> {
	const s = (await client.session.fork({
		sessionID,
		...(before ? { before } : {}),
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
		const text = stripXmlContext(
			String(m.text ?? m.metadata?.displayText ?? "").trim(),
		);
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
				const input = (state.input as Record<string, unknown>) ?? {};
				const diffs: Array<{ file: string; patch: string; created?: boolean }> = [];
				const files = (state.metadata as AnyRecord | undefined)?.files;
				if (Array.isArray(files)) {
					for (const f of files as AnyRecord[]) {
						if (typeof f?.patch === "string" && f.patch) {
							diffs.push({
								file: String(f.file ?? input.path ?? "file"),
								patch: f.patch as string,
							});
						}
					}
				}
				const filePath =
					[String(input.path), String(input.file), String(input.filePath)].find(
						(v) => v && v !== "undefined",
					) ?? undefined;
				// New files have no server-side patch — synthesize an all-green diff.
				if (
					diffs.length === 0 &&
					String(p.name ?? "") === "write" &&
					typeof input.content === "string" &&
					filePath
				) {
					const lines = (input.content as string).split("\n");
					const patch = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
					diffs.push({ file: filePath, patch, created: true });
				}
				tools.push({
					type: "tool",
					tool: String(p.name ?? "tool"),
					toolId: String(p.id ?? ""),
					input,
					output,
					status: mapStatus(state.status),
					...(diffs.length > 0 ? { diffs } : {}),
					...(filePath ? { filePath } : {}),
				});
			}
		}
		const text = texts.join("").trim();
		const created = Number(m.time?.created ?? ts);
		const completed = Number(m.time?.completed ?? NaN);
		const errorText = extractMessageError(m);
		if (!text && reasoning.length === 0 && tools.length === 0 && !errorText) {
			return [];
		}
		return [
			{
				id: String(m.id ?? `asst-${ts}`),
				role: "assistant",
				text,
				reasoning,
				tools,
				timestamp: ts,
				...(errorText ? { error: errorText } : {}),
				...(Number.isFinite(completed) && completed >= created
					? { durationSeconds: Math.max(0, (completed - created) / 1000) }
					: {}),
				...perMessageUsage(m),
			},
		];
	}
	return [];
}

/** Per-message token usage: the context that turn actually used. */
function perMessageUsage(m: AnyRecord): { tokens?: ChatMessage["tokens"]; cost?: number } {
	const t = m.tokens as AnyRecord | undefined;
	if (!t || typeof t !== "object") return {};
	const input = Number(t.input ?? 0) || 0;
	const output = Number(t.output ?? 0) || 0;
	const cache = Number((t.cache as AnyRecord | undefined)?.read ?? 0) || 0;
	const tokens = { input, output, cache };
	return {
		tokens,
		...(typeof m.cost === "number" ? { cost: m.cost } : {}),
	};
}

/** Pulls the provider error text out of an assistant message, if any. */
function extractMessageError(m: AnyRecord): string | undefined {	const err = m.error as AnyRecord | undefined;
	if (err && typeof err === "object") {
		const message = typeof err.message === "string" ? err.message.trim() : "";
		const type = typeof err.type === "string" ? err.type.trim() : "";
		if (message) return message;
		if (type) return type;
	}
	if (m.finish === "error" && typeof m.rawFinish === "string" && m.rawFinish.trim()) {
		return m.rawFinish.trim();
	}
	return undefined;
}

export interface DiffLine {
	kind: "hunk" | "add" | "del" | "ctx" | "note";
	text: string;
}

/** Parses a unified diff into renderable lines (skips Index/---/+++ headers). */
export function parseUnifiedDiff(patch: string): DiffLine[] {
	const out: DiffLine[] = [];
	let started = false;
	for (const raw of patch.split("\n")) {
		if (!started) {
			if (!raw.startsWith("@@")) continue;
			started = true;
		}
		if (raw.startsWith("@@")) out.push({ kind: "hunk", text: raw });
		else if (raw.startsWith("+") && !raw.startsWith("+++"))
			out.push({ kind: "add", text: raw });
		else if (raw.startsWith("-") && !raw.startsWith("---"))
			out.push({ kind: "del", text: raw });
		else if (raw.startsWith("\\")) out.push({ kind: "note", text: raw });
		else out.push({ kind: "ctx", text: raw.length > 0 ? raw : " " });
	}
	return out;
}

export function countDiff(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of parseUnifiedDiff(patch)) {
		if (line.kind === "add") added++;
		else if (line.kind === "del") removed++;
	}
	return { added, removed };
}

function mapStatus(status: unknown): string {
	if (status === "running" || status === "pending") return "running";
	if (status === "error" || status === "failed") return "error";
	return "completed";
}

/**
 * Context-block format adapted 1:1 from Grimoire (MIT, (c) Michael Makarov):
 * user text first, `<current_note>` / `<context_files>` XML appended after.
 * Same for the display-stripping pattern below.
 */
const CURRENT_NOTE_TARGET_HINT =
	"Default target: If the user asks to edit, rewrite, update, or apply instructions without naming another target file, use this note as the target file.";

export function appendCurrentNote(prompt: string, notePath: string): string {
	return `${prompt}\n\n${["<current_note>", notePath, CURRENT_NOTE_TARGET_HINT, "</current_note>"].join("\n")}`;
}

export function appendContextFiles(prompt: string, files: string[]): string {
	const fileLines = files.map((file) => `- ${file}`).join("\n");
	return `${prompt}\n\n${[
		"<context_files>",
		"The user selected these files as active context.",
		"Inspect the relevant selected files before answering broad or deictic requests.",
		"Do not ignore these files just because the user did not name them explicitly in the message.",
		"",
		fileLines,
		"</context_files>",
	].join("\n")}`;
}

const XML_CONTEXT_SUFFIX =
	/\n\n<(?:current_note|editor_selection|editor_cursor|context_files?|excluded_folders|canvas_selection|browser_selection|vault_search|project_workspace)[\s>][\s\S]*$/;

/** Strips appended XML context blocks so history shows the clean user text. */
export function stripXmlContext(text: string): string {
	let out = text;
	for (;;) {
		const stripped = out.replace(XML_CONTEXT_SUFFIX, "").trimEnd();
		if (stripped === out) return out;
		out = stripped;
	}
}

/** True for absolute filesystem paths (posix or Windows drive). */
export function isAbsolutePath(p: string): boolean {
	return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
}

export interface ExternalFileContent {
	path: string;
	text?: string;
	truncated?: boolean;
	binary?: boolean;
	error?: string;
}

const EXTERNAL_INLINE_LIMIT = 65536;

/**
 * Reads an out-of-vault file so its content can travel with the prompt.
 * Vault files are passed by path (the agent reads them natively); external
 * files are inlined because the agent may not resolve them otherwise.
 */
export function readExternalTextFile(absPath: string): ExternalFileContent {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		const stat = fs.statSync(absPath);
		if (!stat.isFile()) return { path: absPath, error: "not a file" };
		if (stat.size > 4 * 1024 * 1024) return { path: absPath, error: "file too large" };
		const buffer = fs.readFileSync(absPath);
		const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
		if (probe.includes(0)) return { path: absPath, binary: true };
		let text = buffer.toString("utf8");
		let truncated = false;
		if (buffer.length > EXTERNAL_INLINE_LIMIT) {
			text = buffer.subarray(0, EXTERNAL_INLINE_LIMIT).toString("utf8");
			truncated = true;
		}
		return { path: absPath, text, ...(truncated ? { truncated: true } : {}) };
	} catch (e) {
		return { path: absPath, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Inline block for one external file (content or path fallback). */
export function appendExternalFile(prompt: string, file: ExternalFileContent): string {
	if (file.text !== undefined) {
		const note = file.truncated ? "\n[... truncated, ask for specific parts if needed]" : "";
		return `${prompt}\n\n<context_file path="${file.path}">\n${file.text}${note}\n</context_file>`;
	 }
	if (file.binary) {
		return appendContextFiles(prompt, [`${file.path} (binary file, read it with an appropriate tool)`]);
	}
	return appendContextFiles(prompt, [file.path]);
}

export async function sendPrompt(
	client: OpenCodeClient,
	sessionID: string,
	text: string,
	files?: Array<{ uri: string }>,
): Promise<void> {
	// Local-only slash commands are handled by the UI layer.
	await client.session.prompt({
		sessionID,
		text,
		...(files && files.length > 0 ? { files } : {}),
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
	sessionID: string,
	requestID: string,
	decision: "once" | "always" | "reject",
): Promise<void> {
	await client.permission.reply({
		sessionID,
		requestID,
		decision,
	} as unknown as Parameters<OpenCodeClient["permission"]["reply"]>[0]);
}

const MATH_INSTRUCTION_KEY = "opencode-sync-math";
const FORMAT_INSTRUCTION_VALUE =
	"Format chat answers with Obsidian-flavored Markdown: # headings (##, ###), **bold**, *italic*, ==highlight==, `inline code`, fenced code blocks with language, > quotes, callouts like > [!note] / > [!tip] / > [!warning] / > [!example] / > [!question], bullet, numbered and task lists (- [ ]), tables, footnotes. " +
	"Format all mathematics using LaTeX: inline $...$ for short formulas, display $$...$$ for multi-line derivations. Never wrap formulas or equations in code blocks or backticks.";

/**
 * Stores formatting instructions as a native session instruction entry —
 * no files, per session, honored by the model (verified). Updates the
 * value when it changed, so existing sessions pick up new rules.
 */
export async function ensureFormatInstruction(
	client: OpenCodeClient,
	sessionID: string,
): Promise<void> {
	try {
		const list = (await client.session.instructions.entry.list({
			sessionID,
		} as unknown as Parameters<
			OpenCodeClient["session"]["instructions"]["entry"]["list"]
		>[0])) as unknown as AnyRecord;
		const arr: AnyRecord[] = Array.isArray(list) ? list : (list.data ?? []);
		const existing = arr.find((e) => e?.key === MATH_INSTRUCTION_KEY);
		if (existing?.value === FORMAT_INSTRUCTION_VALUE) return;
		await client.session.instructions.entry.put({
			sessionID,
			key: MATH_INSTRUCTION_KEY,
			value: FORMAT_INSTRUCTION_VALUE,
		} as unknown as Parameters<
			OpenCodeClient["session"]["instructions"]["entry"]["put"]
		>[0]);
	} catch {
		/* older servers may lack the API — rendering still works for LaTeX output */
	}
}

/** Backwards-compatible alias. */
export const ensureMathInstruction = ensureFormatInstruction;
