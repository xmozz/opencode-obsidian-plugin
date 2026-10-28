import { MarkdownRenderer, Notice, type App, type Component } from "obsidian";
import {
	countDiff,
	parseUnifiedDiff,
	type ChatMessage,
} from "../opencode/sessions";
import { convertLatexCodeToMath } from "./math";
import {
	el,
	fmtDuration,
	fmtTime,
	renderRich,
	safeJson,
	summarizeInput,
} from "./chat-utils";

export interface WorkingBlock {
	root: HTMLDetailsElement;
	body: HTMLElement;
	meta: HTMLElement;
}

export interface MessageRendererHost {
	app: App;
	component: Component;
	vaultDir(): string;
	createWorkingBlock(sessionId: string): WorkingBlock;
	paintWorkingMeta(
		working: { meta: HTMLElement },
		hasReasoning: boolean,
		toolNames: string[],
	): void;
}

/** Owns static message/diff rendering; live stream updates remain in the view. */
export class ChatMessageRenderer {
	constructor(private readonly host: MessageRendererHost) {}

	renderMessage(message: ChatMessage, sessionId: string): HTMLElement {
		if (message.role === "compaction") {
			const wrap = el("div", "ocs-msg ocs-compaction");
			const meta = el("div", "ocs-msg-meta", `🧹 Session compacted · ${fmtTime(message.timestamp)}`);
			const bubble = el("div", "ocs-bubble");
			const body = el("div", "ocs-msg-body");
			this.renderBodyText(body, message.text);
			bubble.appendChild(body);
			wrap.appendChild(bubble);
			wrap.appendChild(meta);
			return wrap;
		}
		if (message.role === "assistant") {
			return this.renderAssistantGroup([message], sessionId);
		}

		const wrap = el("div", "ocs-msg ocs-user");
		const meta = el("div", "ocs-msg-meta");
		const stamp = fmtTime(message.timestamp) +
			(message.durationSeconds !== undefined ? ` · ${fmtDuration(message.durationSeconds)}` : "");
		meta.appendChild(el("span", "", stamp));
		if (message.text) {
			const copy = el("button", "ocs-copy-btn", "⧉");
			copy.title = "Copy message text";
			copy.onclick = async (event) => {
				event.stopPropagation();
				try {
					await navigator.clipboard.writeText(message.text);
					new Notice("Message copied");
				} catch {
					new Notice("Could not access clipboard");
				}
			};
			meta.appendChild(copy);
		}
		const bubble = el("div", "ocs-bubble");
		if (message.text) {
			const body = el("div", "ocs-msg-body");
			body.textContent = message.text;
			bubble.appendChild(body);
		}
		if (message.error) bubble.appendChild(el("div", "ocs-error-block", `Error: ${message.error}`));
		wrap.appendChild(bubble);
		wrap.appendChild(meta);
		return wrap;
	}

	/** Renders all assistant steps of one turn as a single answer. */
	renderAssistantGroup(messages: ChatMessage[], sessionId: string): HTMLElement {
		const wrap = el("div", "ocs-msg ocs-assistant");
		const bubble = el("div", "ocs-bubble");
		const reasoning = messages.flatMap((message) => message.reasoning);
		const tools = messages.flatMap((message) => message.tools);
		if (reasoning.length > 0 || tools.length > 0) {
			const working = this.host.createWorkingBlock(sessionId);
			if (reasoning.length > 0) {
				const thinking = document.createElement("details");
				thinking.className = "ocs-working-thinking";
				thinking.open = false;
				thinking.appendChild(el("summary", "ocs-working-sub", "Thinking"));
				const box = el("div", "ocs-working-reasoning");
				for (const text of reasoning) {
					const item = el("div", "ocs-thinking-text");
					item.innerHTML = renderRich(text);
					box.appendChild(item);
				}
				thinking.appendChild(box);
				working.body.appendChild(thinking);
			}
			for (const tool of tools) working.body.appendChild(this.renderTool(tool));
			this.host.paintWorkingMeta(
				working,
				reasoning.length > 0,
				tools.map((tool) => tool.tool ?? "tool"),
			);
			bubble.appendChild(working.root);
		}
		for (const message of messages) {
			if (message.text) {
				const body = el("div", "ocs-msg-body");
				this.renderBodyText(body, message.text);
				bubble.appendChild(body);
			}
			if (message.error) bubble.appendChild(el("div", "ocs-error-block", `Error: ${message.error}`));
		}
		const last = messages[messages.length - 1];
		const text = messages.map((message) => message.text).filter(Boolean).join("\n\n");
		const meta = el("div", "ocs-msg-meta");
		const duration = messages.reduce((total, message) => total + (message.durationSeconds ?? 0), 0);
		const stamp = fmtTime(last.timestamp) +
			(messages.some((message) => message.durationSeconds !== undefined)
				? ` · ${fmtDuration(duration)}`
				: "");
		meta.appendChild(el("span", "", stamp));
		if (text) {
			const copy = el("button", "ocs-copy-btn", "⧉");
			copy.title = "Copy message text";
			copy.onclick = async (event) => {
				event.stopPropagation();
				try {
					await navigator.clipboard.writeText(text);
					new Notice("Message copied");
				} catch {
					new Notice("Could not access clipboard");
				}
			};
			meta.appendChild(copy);
		}
		wrap.appendChild(bubble);
		wrap.appendChild(meta);
		return wrap;
	}

	shortPath(path: string): string {
		const vault = this.host.vaultDir().replace(/\\/g, "/").replace(/\/+$/, "");
		const normalized = path.replace(/\\/g, "/");
		if (vault && normalized.toLowerCase().startsWith(vault.toLowerCase() + "/")) {
			return normalized.slice(vault.length + 1);
		}
		return normalized.split("/").pop() ?? path;
	}

	private renderBodyText(container: HTMLElement, text: string): void {
		const converted = convertLatexCodeToMath(text);
		const rendered = document.createElement("div");
		rendered.classList.add("markdown-rendered");
		container.appendChild(rendered);
		MarkdownRenderer.render(this.host.app, converted, rendered, "", this.host.component).catch(() => {
			rendered.innerHTML = renderRich(text);
		});
	}

	private renderTool(tool: ChatMessage["tools"][number]): HTMLElement {
		const name = tool.tool ?? "tool";
		const status = tool.status ?? "completed";
		const input = tool.input ?? {};
		const details = document.createElement("details");
		details.className = `ocs-toolcall ocs-${status}`;
		const summary = document.createElement("summary");
		summary.appendChild(el("span", "ocs-tool-dot"));
		if (tool.diffs?.length) {
			const files = tool.diffs.map((diff) => this.shortPath(diff.file)).join(", ");
			const allCreated = tool.diffs.every((diff) => diff.created);
			const total = tool.diffs.reduce(
				(acc, diff) => {
					const counts = countDiff(diff.patch);
					return { added: acc.added + counts.added, removed: acc.removed + counts.removed };
				},
				{ added: 0, removed: 0 },
			);
			summary.appendChild(el("span", "ocs-tool-name", `${allCreated ? "Created" : "Edited"} ${files}`));
			summary.appendChild(el("span", "ocs-diff-stats", `+${total.added} −${total.removed}`));
			details.open = false;
		} else {
			summary.appendChild(el("span", "ocs-tool-name", name));
			const short = tool.filePath ? this.shortPath(tool.filePath) : summarizeInput(input);
			if (short) summary.appendChild(el("span", "ocs-tool-arg", short));
		}
		details.appendChild(summary);
		if (tool.diffs?.length) {
			for (const diff of tool.diffs) details.appendChild(this.renderFileDiff(diff.file, diff.patch));
		} else if (tool.filePath && (name === "write" || name === "edit")) {
			const content = typeof input.content === "string" ? input.content : "";
			const lines = content ? content.split("\n").length : 0;
			details.appendChild(
				el(
					"div",
					"ocs-diff-file",
					`${name === "write" ? "Created" : "Edited"} ${this.shortPath(tool.filePath)}${lines ? ` · ${lines} lines` : ""}`,
				),
			);
		}
		details.appendChild(el("pre", "ocs-tool-input", safeJson(input)));
		if (tool.output) details.appendChild(el("pre", "ocs-tool-output", tool.output.slice(0, 4000)));
		return details;
	}

	private renderFileDiff(file: string, patch: string): HTMLElement {
		const box = el("div", "ocs-diff");
		box.appendChild(el("div", "ocs-diff-file", this.shortPath(file)));
		const lines = el("div", "ocs-diff-lines");
		const classes: Record<string, string> = {
			hunk: "ocs-diff-hunk",
			add: "ocs-diff-add",
			del: "ocs-diff-del",
			ctx: "ocs-diff-ctx",
			note: "ocs-diff-note",
		};
		for (const line of parseUnifiedDiff(patch)) {
			lines.appendChild(el("div", classes[line.kind], line.text));
		}
		box.appendChild(lines);
		return box;
	}
}
