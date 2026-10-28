/** Small DOM and formatting helpers shared by the chat UI modules. */

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (cls) element.className = cls;
	if (text !== undefined) element.textContent = text;
	return element;
}

export function fmtTime(ts: number): string {
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return "";
	}
}

export function fmtDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) {
		const rest = s % 60;
		return rest > 0 ? `${m}m ${rest}s` : `${m}m`;
	}
	const h = Math.floor(m / 60);
	const restM = m % 60;
	return restM > 0 ? `${h}h ${restM}m` : `${h}h`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Minimal safe fallback rendering used if Obsidian Markdown rendering fails. */
export function renderRich(text: string): string {
	const blocks: string[] = [];
	let html = escapeHtml(text);
	html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code: string) => {
		blocks.push(`<pre class="ocs-code"><code>${code.replace(/\n$/, "")}</code></pre>`);
		return `\u0000${blocks.length - 1}\u0000`;
	});
	html = html
		.replace(/`([^`\n]+)`/g, '<code class="ocs-inline-code">$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
		.replace(/^### (.*)$/gm, "<h4>$1</h4>")
		.replace(/^## (.*)$/gm, "<h3>$1</h3>")
		.replace(/^# (.*)$/gm, "<h2>$1</h2>")
		.replace(/\n/g, "<br>");
	return html.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)] ?? "");
}

export function parseModelRef(value: string): { providerID: string; id: string } | null {
	if (!value) return null;
	const [providerID, ...rest] = value.split("/");
	const id = rest.join("/");
	if (!providerID || !id) return null;
	return { providerID, id };
}

export function toArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (Array.isArray(record.data)) return record.data;
	}
	return [];
}

export function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function safeJson(value: Record<string, unknown>): string {
	try {
		return JSON.stringify(value, null, 2).slice(0, 2000);
	} catch {
		return String(value);
	}
}

export function summarizeInput(input: Record<string, unknown>): string {
	const keys = ["file", "path", "files", "command", "pattern", "query", "url"];
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value) {
			return value.length > 60 ? `${value.slice(0, 59)}…` : value;
		}
		if (Array.isArray(value) && value.length > 0) return String(value[0]).slice(0, 60);
	}
	const first = Object.values(input)[0];
	return typeof first === "string" ? first.slice(0, 60) : "";
}

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export function fmtCost(cost: number): string {
	return cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
}

export function toolContentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content as Array<Record<string, unknown>>) {
		if (!item || typeof item !== "object") continue;
		if (item.type === "text" && typeof item.text === "string" && item.text) {
			parts.push(item.text);
		} else if (item.type === "file") {
			parts.push(`[file: ${String(item.name ?? item.uri ?? "file")}]`);
		}
	}
	return parts.join("\n");
}

export function cssEsc(value: string): string {
	return value.replace(/["\\]/g, "\\$&");
}
