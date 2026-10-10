import { ItemView, WorkspaceLeaf, Notice, Menu, MarkdownRenderer } from "obsidian";
import type { OpenCodeClient } from "@opencode/client";
import type OpenCodePlugin from "../main";
import {
	listVaultSessions,
	loadSessionMessages,
	createVaultSession,
	removeSession,
	renameSession,
	forkSession,
	sendPrompt,
	interruptSession,
	switchModel,
	switchAgent,
	runSessionCommand,
	replyPermission,
	type VaultSession,
	type ChatMessage,
} from "../opencode/sessions";

export const VIEW_TYPE_OPENCODE = "opencode-sync-chat";

interface TabState {
	tabId: string;
	sessionId: string;
	title: string;
	streaming: boolean;
	attention: boolean;
	messages: ChatMessage[];
	loaded: boolean;
	usageText: string;
}

interface DiscoveredModel {
	providerID: string;
	id: string;
	name: string;
	variants: string[];
}

let tabCounter = 0;
function newTabId(): string {
	tabCounter += 1;
	return `tab-${Date.now().toString(36)}-${tabCounter}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

function fmtTime(ts: number): string {
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return "";
	}
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Avoids turning prices ("costs $5 and $10") into math. */
function isPlausibleInlineMath(text: string, dollarIndex: number, content: string): boolean {
	if (!content || /^\s|\s$/.test(content)) return false;
	if (dollarIndex > 0 && /[0-9A-Za-z]/.test(text[dollarIndex - 1] ?? "")) return false;
	return true;
}

/** Minimal markdown-ish rendering: code blocks, inline code, bold, links, line breaks. */
function renderRich(text: string): string {
	const blocks: string[] = [];
	let html = escapeHtml(text);
	html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
		blocks.push(
			`<pre class="ocs-code"><code>${code.replace(/\n$/, "")}</code></pre>`,
		);
		return `\u0000${blocks.length - 1}\u0000`;
	});
	html = html
		.replace(/`([^`\n]+)`/g, "<code class=\"ocs-inline-code\">$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
		.replace(/^### (.*)$/gm, "<h4>$1</h4>")
		.replace(/^## (.*)$/gm, "<h3>$1</h3>")
		.replace(/^# (.*)$/gm, "<h2>$1</h2>")
		.replace(/\n/g, "<br>");
	html = html.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)] ?? "");
	return html;
}

export class OpenCodeChatView extends ItemView {
	plugin: OpenCodePlugin;
	tabs: TabState[] = [];
	activeTabId: string | null = null;
	models: DiscoveredModel[] = [];
	agents: { id: string; name: string }[] = [];
	commands: { name: string; description?: string }[] = [];
	historyCache: VaultSession[] = [];

	private root!: HTMLElement;
	private tabBar!: HTMLElement;
	private content!: HTMLElement;
	private historyPanel!: HTMLElement;
	private composerText!: HTMLTextAreaElement;
	private modelSelect!: HTMLSelectElement;
	private agentSelect!: HTMLSelectElement;
	private variantSelect!: HTMLSelectElement;
	private approveBtn!: HTMLButtonElement;
	private sendBtn!: HTMLButtonElement;
	private usageBadge!: HTMLElement;
	private statusLine!: HTMLElement;
	private connectBanner!: HTMLElement;
	private connectDetail!: HTMLElement;
	private historyOpen = false;
	private eventAbort: AbortController | null = null;
	private liveAssistant = new Map<string, HTMLElement>();
	private liveReasoning = new Map<string, HTMLElement>();
	private queued: Array<{ tabId: string; text: string; ts: number }> = [];

	constructor(leaf: WorkspaceLeaf, plugin: OpenCodePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_OPENCODE;
	}

	getDisplayText(): string {
		return "OpenCode";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.root = this.containerEl.children[1] as HTMLElement;
		this.root.empty();
		this.root.addClass("ocs-container");
		this.applyFontSize();
		this.buildShell();
		this.restoreTabs();
		if (!this.plugin.client) {
			this.setConnecting(true, this.plugin.isConnecting() ? "opencode is starting…" : "opencode has not started yet — starting…");
			// Nudge the plugin to connect (e.g. after reload while starting).
			void this.plugin.ensureConnected(true);
		}
		void this.refreshCatalogs();
		this.startEventLoop();
		if (this.plugin.settings.refreshOnOpen) void this.refreshHistory();
	}

	async onClose(): Promise<void> {
		this.eventAbort?.abort();
		this.persistTabs();
	}

	// ---------- shell ----------

	private buildShell(): void {
		const shell = el("div", "ocs-chat-window-shell");
		this.root.appendChild(shell);

		// session strip: tab bar + actions (Grimoire-like)
		const strip = el("div", "ocs-session-strip");
		shell.appendChild(strip);
		const nav = el("div", "ocs-input-nav-content");
		strip.appendChild(nav);
		const tabWrap = el("div", "ocs-tab-bar-container");
		nav.appendChild(tabWrap);
		this.tabBar = el("div", "ocs-tab-badges");
		tabWrap.appendChild(this.tabBar);
		const newBtn = el("button", "ocs-new-tab-btn", "+");
		newBtn.title = "New session tab";
		newBtn.onclick = () => void this.newTab();
		tabWrap.appendChild(newBtn);

		const actions = el("div", "ocs-header-actions");
		nav.appendChild(actions);
		this.usageBadge = el("span", "ocs-usage-badge", "");
		this.usageBadge.title = "Session cost / tokens";
		actions.appendChild(this.usageBadge);
		const histBtn = el("button", "ocs-icon-btn", "☰");
		histBtn.title = "Sessions (/session) — shared with CLI";
		histBtn.onclick = () => this.toggleHistory();
		actions.appendChild(histBtn);
		const menuBtn = el("button", "ocs-icon-btn", "⋯");
		menuBtn.title = "Tab actions";
		menuBtn.onclick = (e) => this.openTabMenu(e as MouseEvent);
		actions.appendChild(menuBtn);

		// connection banner (loading indicator while opencode starts)
		this.connectBanner = el("div", "ocs-connect-banner ocs-hidden");
		const spinner = el("span", "ocs-spinner");
		this.connectBanner.appendChild(spinner);
		this.connectDetail = el("span", "ocs-connect-text", "opencode is starting…");
		this.connectBanner.appendChild(this.connectDetail);
		shell.appendChild(this.connectBanner);

		// tab content
		this.content = el("div", "ocs-tab-content-container");
		shell.appendChild(this.content);

		// history panel (popover)
		this.historyPanel = el("aside", "ocs-history-menu ocs-hidden");
		shell.appendChild(this.historyPanel);

		// composer
		const composer = el("div", "ocs-composer");
		shell.appendChild(composer);
		const row1 = el("div", "ocs-composer-controls");
		composer.appendChild(row1);

		this.modelSelect = document.createElement("select");
		this.modelSelect.className = "ocs-model-selector";
		this.modelSelect.title = "Model";
		this.modelSelect.onchange = () => void this.onModelChanged();
		row1.appendChild(this.modelSelect);

		this.variantSelect = document.createElement("select");
		this.variantSelect.className = "ocs-thinking-selector";
		this.variantSelect.title = "Reasoning effort / variant";
		this.variantSelect.onchange = () => void this.onVariantChanged();
		row1.appendChild(this.variantSelect);

		this.agentSelect = document.createElement("select");
		this.agentSelect.className = "ocs-mode-selector";
		this.agentSelect.title = "Agent / permission mode";
		this.agentSelect.onchange = () => void this.onAgentChanged();
		row1.appendChild(this.agentSelect);

		this.approveBtn = el("button", "ocs-permission-toggle", "Safe");
		this.approveBtn.title = "Toggle auto-approve permissions";
		this.approveBtn.onclick = () => {
			this.plugin.settings.autoApprove = !this.plugin.settings.autoApprove;
			void this.plugin.saveSettings();
			this.renderApproveBtn();
		};
		row1.appendChild(this.approveBtn);

		const row2 = el("div", "ocs-composer-input-row");
		composer.appendChild(row2);
		this.composerText = document.createElement("textarea");
		this.composerText.className = "ocs-input";
		this.composerText.placeholder =
			"Ask OpenCode…  (/session, /new, /compact, /fork, Enter to send)";
		this.composerText.rows = 3;
		this.composerText.onkeydown = (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				if (this.plugin.settings.sendWithButtonOnly) return;
				e.preventDefault();
				void this.sendCurrent();
			}
		};
		// "/" shortcut: open session picker like CLI /session
		this.composerText.oninput = () => {
			if (this.composerText.value.trim() === "/session") {
				this.openHistory();
			}
		};
		row2.appendChild(this.composerText);
		this.sendBtn = el("button", "ocs-send-btn", "Send");
		this.sendBtn.onclick = () => {
			const tab = this.activeTab();
			if (tab?.streaming) void this.stopCurrent();
			else void this.sendCurrent();
		};
		row2.appendChild(this.sendBtn);

		this.statusLine = el("div", "ocs-status-line", "Not connected");
		composer.appendChild(this.statusLine);

		this.renderApproveBtn();
	}

	private renderApproveBtn(): void {
		const auto = this.plugin.settings.autoApprove;
		this.approveBtn.textContent = auto ? "Auto-approve" : "Safe";
		this.approveBtn.classList.toggle("ocs-auto", auto);
	}

	// ---------- tabs (UI-only; sessions live in opencode, not in files) ----------

	private persistTabs(): void {
		void this.plugin.saveData({
			...((this.plugin.loadedData ?? {}) as Record<string, unknown>),
			openTabs: this.tabs.map((t) => ({
				sessionId: t.sessionId,
				title: t.title,
			})),
			activeSessionId: this.activeTab()?.sessionId ?? null,
		});
	}

	private restoreTabs(): void {
		const data = (this.plugin.loadedData ?? {}) as {
			openTabs?: { sessionId: string; title: string }[];
		};
		const open = data.openTabs ?? [];
		this.tabs = [];
		this.activeTabId = null;
		if (open.length === 0) {
			void this.newTab();
			return;
		}
		for (const o of open.slice(0, this.plugin.settings.maxTabs)) {
			const tab: TabState = {
				tabId: newTabId(),
				sessionId: o.sessionId,
				title: o.title || "Session",
				streaming: false,
				attention: false,
				messages: [],
				loaded: false,
				usageText: "",
			};
			this.tabs.push(tab);
			if (!this.activeTabId) this.activeTabId = tab.tabId;
		}
		this.renderTabs();
		this.renderContent();
		for (const t of this.tabs) void this.ensureLoaded(t);
	}

	activeTab(): TabState | undefined {
		return this.tabs.find((t) => t.tabId === this.activeTabId);
	}

	private async newTab(sessionId?: string, title?: string): Promise<void> {
		if (this.tabs.length >= this.plugin.settings.maxTabs) {
			new Notice(`Max ${this.plugin.settings.maxTabs} tabs open`);
			return;
		}
		const client = this.plugin.client;
		const vaultDir = this.plugin.vaultDir();
		let sid = sessionId;
		let t = title ?? "New session";
		if (!sid) {
			if (!client) {
				new Notice("OpenCode not connected yet");
				return;
			}
			try {
				const created = await createVaultSession(
					client,
					vaultDir,
					this.selectedModelRef() ?? undefined,
					this.agentSelect?.value || undefined,
				);
				sid = created.id;
				t = created.title;
			} catch (e) {
				new Notice(`Could not create session: ${errMsg(e)}`);
				return;
			}
		}
		// If the session already has a tab, just focus it.
		const existing = this.tabs.find((x) => x.sessionId === sid);
		if (existing) {
			this.activeTabId = existing.tabId;
			this.renderTabs();
			this.renderContent();
			return;
		}
		const tab: TabState = {
			tabId: newTabId(),
			sessionId: sid ?? `pending-${Date.now()}`,
			title: t,
			streaming: false,
			attention: false,
			messages: [],
			loaded: false,
			usageText: "",
		};
		this.tabs.push(tab);
		this.activeTabId = tab.tabId;
		this.renderTabs();
		this.renderContent();
		this.persistTabs();
		if (sid) void this.ensureLoaded(tab);
	}

	private closeTab(tabId: string): void {
		const idx = this.tabs.findIndex((t) => t.tabId === tabId);
		if (idx < 0) return;
		this.tabs.splice(idx, 1);
		if (this.activeTabId === tabId) {
			this.activeTabId = this.tabs[Math.max(0, idx - 1)]?.tabId ?? null;
		}
		this.renderTabs();
		this.renderContent();
		this.persistTabs();
	}

	private openTabMenu(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((i) =>
			i.setTitle("New session tab").onClick(() => void this.newTab()),
		);
		menu.addItem((i) =>
			i.setTitle("Refresh session list").onClick(() => void this.refreshHistory()),
		);
		menu.addItem((i) =>
			i.setTitle("Fork active session").onClick(() => void this.forkActive()),
		);
		menu.addItem((i) =>
			i.setTitle("Close active tab").onClick(() => {
				if (this.activeTabId) this.closeTab(this.activeTabId);
			}),
		);
		menu.showAtMouseEvent(e);
	}

	private renderTabs(): void {
		this.tabBar.empty();
		this.tabs.forEach((t, i) => {
			const b = el(
				"button",
				`ocs-tab-badge ${t.tabId === this.activeTabId ? "ocs-active" : "ocs-idle"} ${t.streaming ? "ocs-streaming" : ""} ${t.attention ? "ocs-attention" : ""}`,
			);
			b.title = `${t.title}\n${t.sessionId}`;
			const dot = el("span", "ocs-tab-activity-dot");
			b.appendChild(dot);
			b.appendChild(el("span", "ocs-tab-number", String(i + 1)));
			const label = el(
				"span",
				"ocs-tab-label",
				t.title.length > 22 ? t.title.slice(0, 21) + "…" : t.title,
			);
			b.appendChild(label);
			b.onclick = () => {
				this.activeTabId = t.tabId;
				t.attention = false;
				this.renderTabs();
				this.renderContent();
				this.persistTabs();
			};
			b.onauxclick = (e) => {
				if ((e as MouseEvent).button === 1) this.closeTab(t.tabId);
			};
			b.oncontextmenu = (e) => {
				e.preventDefault();
				const menu = new Menu();
				menu.addItem((it) =>
					it.setTitle("Rename session").onClick(() => void this.renameActive()),
				);
				menu.addItem((it) =>
					it.setTitle("Fork into new tab").onClick(() => void this.forkActive()),
				);
				menu.addItem((it) =>
					it.setTitle("Reload messages").onClick(() => void this.reloadActive()),
				);
				menu.addItem((it) =>
					it.setTitle("Delete session (opencode)").onClick(() =>
						void this.deleteActive(),
					),
				);
				menu.addItem((it) =>
					it.setTitle("Close tab").onClick(() => this.closeTab(t.tabId)),
				);
				menu.showAtMouseEvent(e as MouseEvent);
			};
			this.tabBar.appendChild(b);
		});
	}

	// ---------- messages ----------

	/** Applies the configured base font size (all UI text scales with it). */
	applyFontSize(): void {
		const size = Math.min(24, Math.max(9, this.plugin.settings.fontSize || 13));
		this.root?.style.setProperty("--ocs-fs", `${size}px`);
	}

	/** Loading state while the opencode service is (re)starting. */
	setConnecting(active: boolean, detail?: string): void {
		this.connectBanner.classList.toggle("ocs-hidden", !active);
		if (detail) this.connectDetail.textContent = detail;
		else if (active) this.connectDetail.textContent = "opencode is starting…";
		this.sendBtn.textContent = this.activeTab()?.streaming ? "Stop" : "Send";
	}

	private renderContent(): void {
		this.content.empty();
		const tab = this.activeTab();
		if (!tab) {
			this.content.appendChild(el("div", "ocs-empty", "Open a session tab to start."));
			this.sendBtn.textContent = "Send";
			return;
		}
		this.sendBtn.textContent = tab.streaming ? "Stop" : "Send";
		const list = el("div", "ocs-message-list");
		this.content.appendChild(list);
		if (!tab.loaded) {
			list.appendChild(el("div", "ocs-wait", "Loading native session history…"));
			return;
		}
		if (tab.messages.length === 0 && !this.queuedFor(tab.tabId).length) {
			list.appendChild(
				el("div", "ocs-empty", "Empty session — say hello. History is shared with the CLI."),
			);
		}
		for (const m of tab.messages) list.appendChild(this.renderMessage(m));
		for (const q of this.queuedFor(tab.tabId)) {
			const wrap = el("div", "ocs-msg ocs-user ocs-queued");
			wrap.appendChild(el("div", "ocs-msg-meta", `⏳ queued — will send once opencode is ready · ${fmtTime(q.ts)}`));
			const body = el("div", "ocs-msg-body");
			body.innerHTML = renderRich(q.text);
			wrap.appendChild(body);
			list.appendChild(wrap);
		}
		// live (streaming) containers are appended by the event loop
		const live = this.liveAssistant.get(tab.sessionId);
		if (live && !live.parentElement) list.appendChild(live);
		list.scrollTop = list.scrollHeight;
		this.usageBadge.textContent = tab.usageText;
	}

	private renderMessage(m: ChatMessage): HTMLElement {
		const wrap = el("div", `ocs-msg ocs-${m.role}`);
		const meta = el("div", "ocs-msg-meta", fmtTime(m.timestamp));
		wrap.appendChild(meta);
		if (m.reasoning.length > 0) {
			const det = document.createElement("details");
			det.className = "ocs-thinking";
			const sum = document.createElement("summary");
			sum.textContent = `Thinking (${m.reasoning.length})`;
			det.appendChild(sum);
			for (const r of m.reasoning) {
				const d = el("div", "ocs-thinking-text");
				d.innerHTML = renderRich(r);
				det.appendChild(d);
			}
			wrap.appendChild(det);
		}
		for (const t of m.tools) {
			wrap.appendChild(this.renderTool(t.tool ?? "tool", t.input ?? {}, t.output, t.status ?? "completed"));
		}
		if (m.text) {
			const body = el("div", "ocs-msg-body");
			this.renderBodyText(body, m.text);
			wrap.appendChild(body);
		}
		return wrap;
	}

	/**
	 * Renders message text: code stays code, $…$/$$…$$ is typeset with
	 * Obsidian's built-in MathJax, everything else goes through the
	 * lightweight rich renderer.
	 */
	private renderBodyText(container: HTMLElement, text: string): void {
		const token = /(```[\s\S]*?```)|(`[^`\n]+`)|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
		let last = 0;
		let match: RegExpExecArray | null;
		const frag = document.createDocumentFragment();
		const mathJobs: Array<{ el: HTMLElement; src: string; block: boolean }> = [];
		const appendRich = (segment: string): void => {
			if (!segment) return;
			const div = document.createElement("div");
			div.innerHTML = renderRich(segment);
			while (div.firstChild) frag.appendChild(div.firstChild);
		};
		while ((match = token.exec(text)) !== null) {
			const [full, fence, inlineCode, blockMath, inlineMath] = match;
			if (match.index > last) appendRich(text.slice(last, match.index));
			if (fence || inlineCode) {
				appendRich(full);
			} else if (blockMath !== undefined) {
				const span = document.createElement("span");
				span.className = "ocs-math-block";
				frag.appendChild(span);
				mathJobs.push({ el: span, src: `$$\n${blockMath}\n$$`, block: true });
			} else if (inlineMath !== undefined && isPlausibleInlineMath(text, match.index, inlineMath)) {
				const span = document.createElement("span");
				span.className = "ocs-math-inline";
				frag.appendChild(span);
				mathJobs.push({ el: span, src: `$${inlineMath}$`, block: false });
			} else {
				appendRich(full);
			}
			last = match.index + full.length;
		}
		if (last < text.length) appendRich(text.slice(last));
		container.appendChild(frag);
		for (const job of mathJobs) {
			MarkdownRenderer.render(this.app, job.src, job.el, "", this).catch(() => {
				job.el.textContent = job.src;
			});
		}
	}

	private renderTool(
		name: string,
		input: Record<string, unknown>,
		output?: string,
		status = "completed",
	): HTMLElement {
		const det = document.createElement("details");
		det.className = `ocs-toolcall ocs-${status}`;
		const sum = document.createElement("summary");
		const dot = el("span", "ocs-tool-dot");
		sum.appendChild(dot);
		sum.appendChild(el("span", "ocs-tool-name", name));
		const short = summarizeInput(input);
		if (short) sum.appendChild(el("span", "ocs-tool-arg", short));
		det.appendChild(sum);
		const inp = el("pre", "ocs-tool-input", safeJson(input));
		det.appendChild(inp);
		if (output) det.appendChild(el("pre", "ocs-tool-output", output.slice(0, 4000)));
		return det;
	}

	private async ensureLoaded(tab: TabState): Promise<void> {
		if (tab.loaded) {
			this.renderContent();
			return;
		}
		const client = this.plugin.client;
		if (!client || tab.sessionId.startsWith("pending-")) return;
		try {
			tab.messages = await loadSessionMessages(client, tab.sessionId);
			tab.loaded = true;
		} catch {
			tab.messages = [];
			tab.loaded = true;
		}
		if (this.activeTabId === tab.tabId) this.renderContent();
	}

	private async reloadActive(): Promise<void> {
		const tab = this.activeTab();
		if (!tab) return;
		tab.loaded = false;
		this.renderContent();
		await this.ensureLoaded(tab);
	}

	// ---------- composer actions ----------

	private selectedModelRef(): { providerID: string; id: string } | null {
		const v = this.modelSelect?.value;
		if (!v) return null;
		const [providerID, ...rest] = v.split("/");
		const id = rest.join("/");
		if (!providerID || !id) return null;
		return { providerID, id };
	}

	private async onModelChanged(): Promise<void> {
		const tab = this.activeTab();
		const client = this.plugin.client;
		const ref = this.selectedModelRef();
		this.plugin.settings.model = this.modelSelect.value;
		void this.plugin.saveSettings();
		this.renderVariantOptions();
		if (tab && client && ref && tab.sessionId && !tab.sessionId.startsWith("pending-")) {
			try {
				await switchModel(client, tab.sessionId, ref.providerID, ref.id);
			} catch (e) {
				new Notice(`Model switch failed: ${errMsg(e)}`);
			}
		}
	}

	private async onVariantChanged(): Promise<void> {
		const tab = this.activeTab();
		const client = this.plugin.client;
		const ref = this.selectedModelRef();
		this.plugin.settings.variant = this.variantSelect.value;
		void this.plugin.saveSettings();
		if (tab && client && ref && tab.sessionId && !tab.sessionId.startsWith("pending-")) {
			try {
				await switchModel(
					client,
					tab.sessionId,
					ref.providerID,
					ref.id,
					this.variantSelect.value,
				);
			} catch (e) {
				new Notice(`Variant switch failed: ${errMsg(e)}`);
			}
		}
	}

	private async onAgentChanged(): Promise<void> {
		const tab = this.activeTab();
		const client = this.plugin.client;
		this.plugin.settings.agent = this.agentSelect.value;
		void this.plugin.saveSettings();
		if (tab && client && tab.sessionId && !tab.sessionId.startsWith("pending-")) {
			try {
				await switchAgent(client, tab.sessionId, this.agentSelect.value);
			} catch (e) {
				new Notice(`Agent switch failed: ${errMsg(e)}`);
			}
		}
	}

	private async sendCurrent(): Promise<void> {
		const tab = this.activeTab();
		if (!tab) return;
		const raw = this.composerText.value.trim();
		if (!raw) return;
		this.composerText.value = "";

		const client = this.plugin.client;
		if (!client || this.plugin.isConnecting()) {
			this.queued.push({ tabId: tab.tabId, text: raw, ts: Date.now() });
			this.renderContent();
			new Notice("opencode is still starting — message queued, will send when ready.");
			return;
		}
		void this.dispatchText(tab, raw);
	}

	/** Sends queued messages (oldest first) once the service is ready. */
	async flushQueue(): Promise<void> {
		if (this.queued.length === 0) return;
		const client = this.plugin.client;
		if (!client) return;
		const items = [...this.queued].sort((a, b) => a.ts - b.ts);
		this.queued = [];
		let sent = 0;
		for (const q of items) {
			const tab = this.tabs.find((t) => t.tabId === q.tabId) ?? this.activeTab();
			if (!tab) continue;
			sent++;
			await this.dispatchText(tab, q.text);
		}
		this.renderContent();
		if (sent > 0) new Notice(`opencode is ready — ${sent} queued message${sent === 1 ? "" : "s"} sent.`);
	}

	private queuedFor(tabId: string): Array<{ tabId: string; text: string; ts: number }> {
		return this.queued.filter((q) => q.tabId === tabId);
	}

	private async dispatchText(tab: TabState, raw: string): Promise<void> {
		const client = this.plugin.client;
		if (!client) return;
		if (tab.sessionId.startsWith("pending-")) {
			new Notice("Session not ready yet");
			return;
		}
		// Local slash commands (mirrors CLI ergonomics)
		if (await this.handleLocalCommand(raw, tab)) {
			this.composerText.value = "";
			return;
		}
		this.composerText.value = "";
		// optimistic user bubble
		tab.messages.push({
			id: `local-${Date.now()}`,
			role: "user",
			text: raw,
			reasoning: [],
			tools: [],
			timestamp: Date.now(),
		});
		tab.streaming = true;
		this.renderTabs();
		this.renderContent();
		try {
			if (raw.startsWith("/compact")) {
				await client.session.compact({ sessionID: tab.sessionId } as never);
			} else if (/^\/[\w-]+\b/.test(raw) && this.commands.some((c) => raw.startsWith(`/${c.name}`))) {
				const m = /^\/([\w-]+)\s*([\s\S]*)$/.exec(raw);
				if (m) await runSessionCommand(client, tab.sessionId, m[1], m[2] ?? "");
			} else {
				await sendPrompt(client, tab.sessionId, raw);
			}
		} catch (e) {
			tab.streaming = false;
			tab.messages.push({
				id: `err-${Date.now()}`,
				role: "assistant",
				text: `Error: ${errMsg(e)}`,
				reasoning: [],
				tools: [],
				timestamp: Date.now(),
			});
			this.renderTabs();
			this.renderContent();
		}
	}

	/** Returns true if the command was handled locally. */
	private async handleLocalCommand(raw: string, tab: TabState): Promise<boolean> {
		const client = this.plugin.client;
		if (raw === "/session") {
			this.openHistory();
			return true;
		}
		if (raw === "/new") {
			void this.newTab();
			return true;
		}
		if (raw === "/fork") {
			void this.forkActive();
			return true;
		}
		if (raw.startsWith("/rename ")) {
			const title = raw.slice(8).trim();
			if (title && client) {
				try {
					await renameSession(client, tab.sessionId, title);
					tab.title = title;
					this.renderTabs();
					void this.refreshHistory();
				} catch (e) {
					new Notice(`Rename failed: ${errMsg(e)}`);
				}
			}
			return true;
		}
		if (raw === "/reload") {
			void this.reloadActive();
			return true;
		}
		return false;
	}

	private async stopCurrent(): Promise<void> {
		const tab = this.activeTab();
		const client = this.plugin.client;
		if (!tab || !client) return;
		try {
			await interruptSession(client, tab.sessionId);
		} catch (e) {
			new Notice(`Interrupt failed: ${errMsg(e)}`);
		}
	}

	private async forkActive(): Promise<void> {
		const tab = this.activeTab();
		const client = this.plugin.client;
		if (!tab || !client) return;
		try {
			const fork = await forkSession(client, tab.sessionId);
			void this.newTab(fork.id, fork.title);
			new Notice(`Forked as "${fork.title}"`);
		} catch (e) {
			new Notice(`Fork failed: ${errMsg(e)}`);
		}
	}

	private async renameActive(): Promise<void> {
		const tab = this.activeTab();
		const client = this.plugin.client;
		if (!tab || !client) return;
		const { InputModal } = await import("./input-modal");
		new InputModal(this.app, "Rename session", tab.title, async (title) => {
			try {
				await renameSession(client, tab.sessionId, title);
				tab.title = title;
				this.renderTabs();
				void this.refreshHistory();
			} catch (e) {
				new Notice(`Rename failed: ${errMsg(e)}`);
			}
		}).open();
	}

	private async deleteActive(): Promise<void> {
		const tab = this.activeTab();
		const client = this.plugin.client;
		if (!tab || !client) return;
		try {
			await removeSession(client, tab.sessionId);
			this.closeTab(tab.tabId);
			void this.refreshHistory();
			new Notice("Session deleted in opencode (visible in CLI too)");
		} catch (e) {
			new Notice(`Delete failed: ${errMsg(e)}`);
		}
	}

	// ---------- catalogs (models / agents / commands) ----------

	async refreshCatalogs(): Promise<void> {
		const client = this.plugin.client;
		if (!client) return;
		const vaultDir = this.plugin.vaultDir();
		try {
			const [models, agents, commands] = await Promise.all([
				client.model.list({ directory: vaultDir } as never) as Promise<unknown>,
				client.agent.list({ directory: vaultDir } as never) as Promise<unknown>,
				client.command.list({ directory: vaultDir } as never) as Promise<unknown>,
			]);
			this.models = toArray(models).map((m) => {
				const r = m as Record<string, unknown>;
				return {
					providerID: String(r.providerID ?? r.provider ?? ""),
					id: String(r.id ?? ""),
					name: String(r.name ?? r.id ?? ""),
					variants: Array.isArray(r.variants)
						? (r.variants as { id?: string }[]).map((v) => String(v.id ?? v))
						: [],
				};
			});
			this.agents = toArray(agents).map((a) => {
				const r = a as Record<string, unknown>;
				return { id: String(r.id ?? ""), name: String(r.name ?? r.id ?? "") };
			});
			this.commands = toArray(commands).map((c) => {
				const r = c as Record<string, unknown>;
				return { name: String(r.name ?? ""), description: r.description as string | undefined };
			});
		} catch (e) {
			this.setStatus(`Catalog load failed: ${errMsg(e)}`);
			return;
		}
		this.renderModelOptions();
		this.renderAgentOptions();
		this.setStatus(
			this.plugin.sharedService
				? `Shared server · ${this.plugin.endpointUrl} · sessions synced with CLI`
				: `Connected · ${this.plugin.endpointUrl}`,
		);
	}

	private renderModelOptions(): void {
		const sel = this.modelSelect;
		sel.empty();
		const saved = this.plugin.settings.model;
		let found = false;
		for (const m of this.models) {
			const opt = document.createElement("option");
			opt.value = `${m.providerID}/${m.id}`;
			opt.textContent = m.name || opt.value;
			if (opt.value === saved) {
				opt.selected = true;
				found = true;
			}
			sel.appendChild(opt);
		}
		if (!found && this.models.length > 0) {
			sel.selectedIndex = 0;
			this.plugin.settings.model = sel.value;
			void this.plugin.saveSettings();
		}
		this.renderVariantOptions();
	}

	private renderVariantOptions(): void {
		const sel = this.variantSelect;
		sel.empty();
		const ref = this.selectedModelRef();
		const m = this.models.find(
			(x) => ref && x.providerID === ref.providerID && x.id === ref.id,
		);
		const variants = ["default", ...(m?.variants ?? []).filter((v) => v !== "default")];
		for (const v of variants) {
			const opt = document.createElement("option");
			opt.value = v;
			opt.textContent = v === "default" ? "Effort: default" : `Effort: ${v}`;
			if (v === this.plugin.settings.variant) opt.selected = true;
			sel.appendChild(opt);
		}
	}

	private renderAgentOptions(): void {
		const sel = this.agentSelect;
		sel.empty();
		const saved = this.plugin.settings.agent;
		let found = false;
		for (const a of this.agents) {
			const opt = document.createElement("option");
			opt.value = a.id;
			opt.textContent = a.name || a.id;
			if (a.id === saved) {
				opt.selected = true;
				found = true;
			}
			sel.appendChild(opt);
		}
		if (!found && this.agents.length > 0) {
			const preferred =
				this.agents.find((a) => a.id === "build") ?? this.agents[0];
			sel.value = preferred.id;
			this.plugin.settings.agent = preferred.id;
			void this.plugin.saveSettings();
		}
	}

	// ---------- history: THE shared session list (/session) ----------

	private toggleHistory(): void {
		if (this.historyOpen) this.closeHistory();
		else this.openHistory();
	}

	private openHistory(): void {
		this.historyOpen = true;
		this.historyPanel.removeClass("ocs-hidden");
		void this.refreshHistory();
	}

	private closeHistory(): void {
		this.historyOpen = false;
		this.historyPanel.addClass("ocs-hidden");
	}

	async refreshHistory(): Promise<void> {
		const client = this.plugin.client;
		if (!client) {
			this.historyPanel.empty();
			this.historyPanel.appendChild(el("div", "ocs-history-empty", "Not connected"));
			if (this.historyOpen) this.openHistoryRender([]);
			return;
		}
		try {
			this.historyCache = await listVaultSessions(client, this.plugin.vaultDir());
		} catch (e) {
			new Notice(`Session list failed: ${errMsg(e)}`);
			return;
		}
		if (this.historyOpen) this.openHistoryRender(this.historyCache);
	}

	private openHistoryRender(sessions: VaultSession[]): void {
		this.historyPanel.empty();
		const head = el("div", "ocs-history-head");
		head.appendChild(el("span", "ocs-history-title", `Sessions · ${sessions.length} (shared with CLI)`));
		const refBtn = el("button", "ocs-icon-btn", "⟳");
		refBtn.title = "Refresh (/session)";
		refBtn.onclick = () => void this.refreshHistory();
		head.appendChild(refBtn);
		const newBtn = el("button", "ocs-icon-btn", "+");
		newBtn.title = "New session";
		newBtn.onclick = () => void this.newTab();
		head.appendChild(newBtn);
		const closeBtn = el("button", "ocs-icon-btn", "✕");
		closeBtn.onclick = () => this.closeHistory();
		head.appendChild(closeBtn);
		this.historyPanel.appendChild(head);

		const search = document.createElement("input");
		search.className = "ocs-history-search";
		search.placeholder = "Search sessions…";
		search.oninput = () => {
			const q = search.value.toLowerCase();
			list.empty();
			for (const s of sessions.filter(
				(x) =>
					x.title.toLowerCase().includes(q) ||
					x.id.toLowerCase().includes(q),
			)) {
				list.appendChild(this.historyRow(s));
			}
		};
		this.historyPanel.appendChild(search);
		const list = el("div", "ocs-history-list");
		this.historyPanel.appendChild(list);
		if (sessions.length === 0) {
			list.appendChild(
				el("div", "ocs-history-empty", "No sessions in this vault yet — create one or use the CLI here."),
			);
		}
		const sorted = [...sessions].sort((a, b) => b.updated - a.updated);
		for (const s of sorted) list.appendChild(this.historyRow(s));
	}

	private historyRow(s: VaultSession): HTMLElement {
		const row = el("div", "ocs-history-row");
		const main = el("button", "ocs-history-main");
		const title = el("div", "ocs-history-name", s.title || "Untitled session");
		const sub = el(
			"div",
			"ocs-history-sub",
			`${s.modelProvider ? `${s.modelProvider}/${s.modelId}` : s.modelId || "model ?"} · ${fmtTime(s.updated)}`,
		);
		main.appendChild(title);
		main.appendChild(sub);
		main.title = s.id;
		main.onclick = () => void this.openSessionInActiveTab(s);
		row.appendChild(main);
		const del = el("button", "ocs-icon-btn", "🗑");
		del.title = "Delete session in opencode";
		del.onclick = async () => {
			const client = this.plugin.client;
			if (!client) return;
			try {
				await removeSession(client, s.id);
				const tab = this.tabs.find((t) => t.sessionId === s.id);
				if (tab) this.closeTab(tab.tabId);
				void this.refreshHistory();
			} catch (e) {
				new Notice(`Delete failed: ${errMsg(e)}`);
			}
		};
		row.appendChild(del);
		return row;
	}

	/** Switch the active tab to a native session (CLI sessions included). */
	private async openSessionInActiveTab(s: VaultSession): Promise<void> {
		let tab = this.activeTab();
		if (!tab) {
			await this.newTab(s.id, s.title);
			this.closeHistory();
			return;
		}
		tab.sessionId = s.id;
		tab.title = s.title;
		tab.messages = [];
		tab.loaded = false;
		tab.streaming = false;
		this.renderTabs();
		this.renderContent();
		this.persistTabs();
		this.closeHistory();
		await this.ensureLoaded(tab);
	}

	// ---------- live event loop (shared server → all clients see everything) ----------

	private startEventLoop(): void {
		this.eventAbort?.abort();
		const ac = new AbortController();
		this.eventAbort = ac;
		void this.runEvents(ac.signal);
	}

	private async runEvents(signal: AbortSignal): Promise<void> {
		const client = this.plugin.client;
		if (!client) return;
		try {
			const stream = client.event.subscribe();
			for await (const raw of stream) {
				if (signal.aborted) return;
				this.handleEvent(raw as Record<string, unknown>);
			}
		} catch (e) {
			if (!signal.aborted) this.setStatus(`Event stream ended: ${errMsg(e)}`);
		}
	}

	private tabFor(sessionID: string): TabState | undefined {
		return this.tabs.find((t) => t.sessionId === sessionID);
	}

	private messageListEl(): HTMLElement | null {
		return this.content.querySelector(".ocs-message-list");
	}

	private ensureLiveAssistant(tab: TabState): HTMLElement {
		let live = this.liveAssistant.get(tab.sessionId);
		if (!live || !live.parentElement) {
			live = el("div", "ocs-msg ocs-assistant ocs-live");
			this.liveAssistant.set(tab.sessionId, live);
			if (tab.tabId === this.activeTabId) {
				this.messageListEl()?.appendChild(live);
				const list = this.messageListEl();
				if (list) list.scrollTop = list.scrollHeight;
			} else {
				tab.attention = true;
				this.renderTabs();
			}
		}
		return live;
	}

	private handleEvent(raw: Record<string, unknown>): void {
		const type = String(raw.type ?? "");
		const data = (raw.data ?? {}) as Record<string, unknown>;
		const sessionID =
			(data.sessionID as string) ??
			(data.sessionId as string) ??
			((data.form as Record<string, unknown> | undefined)?.sessionID as string) ??
			"";
		const tab = sessionID ? this.tabFor(sessionID) : undefined;

		switch (type) {
			case "session.created": {
				void this.refreshHistory();
				break;
			}
			case "session.deleted": {
				void this.refreshHistory();
				const sid = (data.sessionID ?? data.id) as string;
				const t = sid && this.tabFor(sid);
				if (t) {
					t.title += " (deleted)";
					if (t.tabId === this.activeTabId) this.renderContent();
					this.renderTabs();
				}
				break;
			}
			case "session.renamed":
			case "session.title.updated": {
				void this.refreshHistory();
				const sid = String(
					(data.sessionID ?? data.sessionId ?? "") as string,
				);
				const title = typeof data.title === "string" ? data.title : undefined;
				if (sid && title) {
					const t = this.tabFor(sid);
					if (t) {
						t.title = title;
						this.renderTabs();
					}
				}
				break;
			}
			case "session.execution.started": {
				if (tab) {
					tab.streaming = true;
					this.ensureLiveAssistant(tab);
					if (tab.tabId === this.activeTabId) {
						this.renderTabs();
						this.sendBtn.textContent = "Stop";
					} else this.renderTabs();
				}
				break;
			}
			case "session.execution.succeeded":
			case "session.execution.failed":
			case "session.execution.interrupted": {
				if (tab) {
					tab.streaming = false;
					const live = this.liveAssistant.get(tab.sessionId);
					if (live) {
						// fold live DOM into message history
						const textParts: string[] = [];
						live.querySelectorAll(".ocs-live-text").forEach((n) => {
							textParts.push(n.textContent ?? "");
						});
						if (textParts.join("").trim()) {
							tab.messages.push({
								id: `stream-${Date.now()}`,
								role: "assistant",
								text: textParts.join(""),
								reasoning: [],
								tools: [],
								timestamp: Date.now(),
							});
						}
						this.liveAssistant.delete(tab.sessionId);
						this.liveReasoning.delete(tab.sessionId);
					}
					if (type === "session.execution.failed") {
						const err = (data.error as { message?: string } | undefined)?.message;
						if (err) {
							tab.messages.push({
								id: `err-${Date.now()}`,
								role: "assistant",
								text: `Error: ${err}`,
								reasoning: [],
								tools: [],
								timestamp: Date.now(),
							});
						}
					}
					if (tab.tabId === this.activeTabId) {
						this.renderContent();
						this.renderTabs();
					} else {
						tab.attention = true;
						this.renderTabs();
					}
					// Re-hydrate from server so CLI-written turns appear too.
					tab.loaded = false;
					void this.ensureLoaded(tab);
					void this.refreshHistory();
				}
				break;
			}
			case "session.text.started": {
				if (tab) {
					const live = this.ensureLiveAssistant(tab);
					const d = el("div", "ocs-live-text");
					d.dataset.msg = String(data.assistantMessageID ?? "");
					live.appendChild(d);
				}
				break;
			}
			case "session.text.delta": {
				if (tab) {
					const live = this.ensureLiveAssistant(tab);
					let target = live.querySelector(
						`.ocs-live-text[data-msg="${cssEsc(String(data.assistantMessageID ?? ""))}"]`,
					) as HTMLElement | null;
					if (!target) {
						target = el("div", "ocs-live-text");
						live.appendChild(target);
					}
					target.textContent = (target.textContent ?? "") + String(data.delta ?? "");
					if (tab.tabId === this.activeTabId) {
						const list = this.messageListEl();
						if (list) list.scrollTop = list.scrollHeight;
					}
				}
				break;
			}
			case "session.reasoning.delta": {
				if (tab) {
					const live = this.ensureLiveAssistant(tab);
					let r = this.liveReasoning.get(`${tab.sessionId}-r`);
					if (!r || !r.parentElement) {
						r = el("div", "ocs-live-reasoning");
						this.liveReasoning.set(`${tab.sessionId}-r`, r);
						live.appendChild(r);
					}
					r.textContent = (r.textContent ?? "") + String(data.delta ?? "");
				}
				break;
			}
			case "session.tool.input.started":
			case "session.tool.called": {
				if (tab) {
					const live = this.ensureLiveAssistant(tab);
					const id = String(data.id ?? "");
					if (id && !live.querySelector(`[data-tool="${cssEsc(id)}"]`)) {
						const tool = el("div", "ocs-toolcall ocs-running");
						tool.dataset.tool = id;
						const name = String(
							(data as Record<string, unknown>).name ?? "tool",
						);
						tool.innerHTML = `<span class="ocs-tool-dot"></span><span class="ocs-tool-name">${escapeHtml(name)}</span>`;
						live.appendChild(tool);
					}
				}
				break;
			}
			case "session.tool.success":
			case "session.tool.failed": {
				if (tab) {
					const live = this.liveAssistant.get(tab.sessionId);
					const node = live?.querySelector(
						`[data-tool="${cssEsc(String(data.id ?? ""))}"]`,
					);
					if (node) {
						node.classList.remove("ocs-running");
						node.classList.add(
							type === "session.tool.success" ? "ocs-done" : "ocs-error",
						);
					}
				}
				break;
			}
			case "permission.asked": {
				const auto = this.plugin.settings.autoApprove;
				const client = this.plugin.client;
				const requestID = String(data.id ?? "");
				if (auto && client && requestID) {
					void replyPermission(client, requestID, "accept").catch(() => {});
					break;
				}
				if (tab && tab.tabId === this.activeTabId) {
					this.renderPermissionCard(tab, {
						requestID,
						action: String(data.action ?? "permission"),
						resources: Array.isArray(data.resources)
							? (data.resources as string[])
							: [],
						message: typeof data.message === "string" ? data.message : undefined,
					});
				} else if (tab) {
					tab.attention = true;
					this.renderTabs();
				}
				break;
			}
			case "form.created": {
				if (tab && tab.tabId === this.activeTabId) {
					this.renderFormCard(tab, (data.form ?? data) as Record<string, unknown>);
				} else if (tab) {
					tab.attention = true;
					this.renderTabs();
				}
				break;
			}
			case "session.usage.updated": {
				if (tab) {
					const tokens = data.tokens as { input?: number; output?: number } | undefined;
					const cost = data.cost as { value?: number } | number | undefined;
					const costNum =
						typeof cost === "number" ? cost : (cost?.value ?? 0);
					tab.usageText =
						`$${Number(costNum).toFixed(4)}` +
						(tokens ? ` · ${(tokens.input ?? 0) + (tokens.output ?? 0)} tok` : "");
					if (tab.tabId === this.activeTabId) {
						this.usageBadge.textContent = tab.usageText;
					}
				}
				break;
			}
			default:
				break;
		}
	}

	private renderPermissionCard(
		tab: TabState,
		req: { requestID: string; action: string; resources: string[]; message?: string },
	): void {
		const list = this.messageListEl();
		if (!list) return;
		const card = el("div", "ocs-permission-card");
		card.appendChild(
			el("div", "ocs-permission-title", `Permission: ${req.action}`),
		);
		if (req.message) card.appendChild(el("div", "ocs-permission-msg", req.message));
		if (req.resources.length > 0) {
			card.appendChild(
				el("div", "ocs-permission-res", req.resources.slice(0, 5).join("\n")),
			);
		}
		const row = el("div", "ocs-card-row");
		const accept = el("button", "ocs-btn ocs-accept", "Allow");
		const reject = el("button", "ocs-btn", "Deny");
		accept.onclick = () => {
			const client = this.plugin.client;
			if (client) void replyPermission(client, req.requestID, "accept").catch((e) => new Notice(errMsg(e)));
			card.remove();
		};
		reject.onclick = () => {
			const client = this.plugin.client;
			if (client) void replyPermission(client, req.requestID, "reject").catch((e) => new Notice(errMsg(e)));
			card.remove();
		};
		row.appendChild(accept);
		row.appendChild(reject);
		card.appendChild(row);
		list.appendChild(card);
		list.scrollTop = list.scrollHeight;
	}

	private renderFormCard(tab: TabState, form: Record<string, unknown>): void {
		const list = this.messageListEl();
		if (!list) return;
		const card = el("div", "ocs-question-card");
		const title = el("div", "ocs-question-title", String(form.title ?? "Question"));
		const chev = el("button", "ocs-icon-btn", "⌄");
		chev.onclick = () => card.classList.toggle("ocs-collapsed");
		title.appendChild(chev);
		card.appendChild(title);
		const fields = form.fields as Record<string, unknown> | undefined;
		const answer: Record<string, string | boolean | string[]> = {};
		if (fields) {
			for (const [key, f] of Object.entries(fields)) {
				const fld = f as Record<string, unknown>;
				const label = String(fld.label ?? key);
				card.appendChild(el("div", "ocs-field-label", label));
				const opts = fld.options as { value?: string; label?: string }[] | undefined;
				if (Array.isArray(opts) && opts.length > 0) {
					const box = el("div", "ocs-options");
					for (const o of opts) {
						const b = el("button", "ocs-btn", String(o.label ?? o.value));
						b.onclick = () => {
							answer[key] = String(o.value ?? o.label);
							b.classList.toggle("ocs-selected");
						};
						box.appendChild(b);
					}
					card.appendChild(box);
				} else {
					const input = document.createElement("input");
					input.className = "ocs-field-input";
					input.onchange = () => {
						answer[key] = input.value;
					};
					card.appendChild(input);
				}
			}
		}
		const row = el("div", "ocs-card-row");
		const submit = el("button", "ocs-btn ocs-accept", "Submit");
		submit.onclick = () => {
			const client = this.plugin.client;
			if (!client) return;
			void client.session.form
				.reply({
					sessionID: tab.sessionId,
					formID: String(form.id ?? ""),
					answer,
				} as never)
				.catch((e: unknown) => new Notice(errMsg(e)));
			card.remove();
		};
		row.appendChild(submit);
		card.appendChild(row);
		list.appendChild(card);
		list.scrollTop = list.scrollHeight;
	}

	private setStatus(text: string): void {
		this.statusLine.textContent = text;
	}

	onConnected(): void {
		this.setConnecting(false);
		this.setStatus("Connected — loading…");
		void this.refreshCatalogs();
		for (const t of this.tabs) {
			if (!t.loaded) void this.ensureLoaded(t);
		}
		void this.refreshHistory();
		this.startEventLoop();
		void this.flushQueue();
	}
}

function toArray(v: unknown): unknown[] {
	if (Array.isArray(v)) return v;
	if (v && typeof v === "object") {
		const r = v as Record<string, unknown>;
		if (Array.isArray(r.data)) return r.data as unknown[];
	}
	return [];
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function safeJson(v: Record<string, unknown>): string {
	try {
		return JSON.stringify(v, null, 2).slice(0, 2000);
	} catch {
		return String(v);
	}
}

function summarizeInput(input: Record<string, unknown>): string {
	const keys = ["file", "path", "files", "command", "pattern", "query", "url"];
	for (const k of keys) {
		const v = input[k];
		if (typeof v === "string" && v) return v.length > 60 ? v.slice(0, 59) + "…" : v;
		if (Array.isArray(v) && v.length > 0) return String(v[0]).slice(0, 60);
	}
	const first = Object.values(input)[0];
	if (typeof first === "string") return first.slice(0, 60);
	return "";
}

function cssEsc(s: string): string {
	return s.replace(/["\\]/g, "\\$&");
}
