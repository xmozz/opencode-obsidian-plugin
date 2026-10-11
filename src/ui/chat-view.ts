import { ItemView, WorkspaceLeaf, Notice, Menu, MarkdownRenderer, getIcon } from "obsidian";
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
	ensureMathInstruction,
	appendCurrentNote,
	appendContextFiles,
	readExternalTextFile,
	appendExternalFile,
	isAbsolutePath,
	parseUnifiedDiff,
	countDiff,
	type VaultSession,
	type ChatMessage,
} from "../opencode/sessions";
import { FileAttachModal } from "./attach-modal";
import { ModelPickerModal } from "./model-modal";

export const VIEW_TYPE_OPENCODE = "opencode-sync-chat";

interface TabState {
	tabId: string;
	sessionId: string;
	title: string;
	streaming: boolean;
	attention: boolean;
	messages: ChatMessage[];
	loaded: boolean;
	usageCost: number;
	usageInput: number;
	usageOutput: number;
	usageCache: number;
	usageHaveData: boolean;
	/** Vault-relative path of the auto/current note context (Grimoire-style). */
	activeNote: string | null;
	/** Manually attached vault-relative context files. */
	contextFiles: string[];
	/** Pasted image attachments (data URLs, sent with the next prompt). */
	images: Array<{ id: string; name: string; dataUrl: string }>;
	/** True while the active note chip purely mirrors the focused file. */
	autoAttached: boolean;
}

interface DiscoveredModel {
	providerID: string;
	id: string;
	name: string;
	variants: string[];
	limit: number | null;
}

interface LiveToolState {
	node: HTMLElement;
	sumName: HTMLElement;
	sumArg: HTMLElement;
	inputPre: HTMLElement;
	outPre: HTMLElement | null;
	name: string;
	inputText: string;
	output: string;
	status: string;
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

/** Short human duration like Grimoire ("12s", "1m 24s", "2h 3m"). */
function fmtDuration(seconds: number): string {
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

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

import { convertLatexCodeToMath } from "./math";

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
	private modelBtn!: HTMLButtonElement;
	private agentBtn!: HTMLButtonElement;
	private effortBtn!: HTMLButtonElement;
	private variantOptions: string[] = [];
	private restrictBtn!: HTMLButtonElement;
	private attachBtn!: HTMLButtonElement;
	private forkBtn!: HTMLButtonElement;
	private sendBtn!: HTMLButtonElement;
	private chipsRow!: HTMLElement;
	private usageBadge!: HTMLElement;
	private statusLine!: HTMLElement;
	private connectBanner!: HTMLElement;
	private connectDetail!: HTMLElement;
	private historyOpen = false;
	private eventAbort: AbortController | null = null;
	private liveAssistant = new Map<string, HTMLElement>();
	private liveReasoning = new Map<string, HTMLElement>();
	private queued: Array<{ tabId: string; text: string; ts: number }> = [];
	private slashMenu!: HTMLElement;
	private slashOpen = false;
	private slashItems: Array<{ name: string; hint: string; takesArg: boolean }> = [];
	private slashIndex = 0;
	private queueBar!: HTMLElement;
	private lastEsc = 0;
	private liveTools = new Map<string, Map<string, LiveToolState>>();

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
		this.autoAttachOnOpen();
		if (!this.plugin.client) {
			this.setConnecting(true, this.plugin.isConnecting() ? "opencode is starting…" : "opencode has not started yet — starting…");
			// Nudge the plugin to connect (e.g. after reload while starting).
			void this.plugin.ensureConnected(true);
		}
		void this.refreshCatalogs();
		this.startEventLoop();
		if (this.plugin.settings.refreshOnOpen) void this.refreshHistory();
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.syncActiveNote()),
		);
	}

	/** Default: the focused file is attached when the chat starts. */
	private autoAttachOnOpen(): void {
		const tab = this.activeTab();
		if (!tab) return;
		if (!tab.activeNote && tab.contextFiles.length === 0) {
			this.autoAttachActiveFile(tab);
		}
		this.renderChips();
		this.persistTabs();
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
		this.usageBadge.title = "Tokens · cost · context window";
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
		this.content.addEventListener("click", (e) => this.onLinkClick(e as MouseEvent));
		shell.appendChild(this.content);

		// history panel (popover)
		this.historyPanel = el("aside", "ocs-history-menu ocs-hidden");
		shell.appendChild(this.historyPanel);

		// composer: single Grimoire-style box — chips on top, input middle,
		// model/agent/effort + icon actions in one bottom toolbar, no inner borders.
		const composer = el("div", "ocs-composer");
		shell.appendChild(composer);

		// outbox bar: queued messages hover here until the agent is free
		this.queueBar = el("div", "ocs-queue-bar ocs-hidden");
		composer.appendChild(this.queueBar);

		this.chipsRow = el("div", "ocs-chips-row");
		composer.appendChild(this.chipsRow);

		this.modelBtn = el("button", "ocs-picker-btn", "");
		this.modelBtn.onclick = () => this.openModelPicker();

		this.agentBtn = el("button", "ocs-picker-btn", "");
		this.agentBtn.onclick = (e) => this.openAgentPicker(e as MouseEvent);

		this.effortBtn = el("button", "ocs-icon-btn ocs-effort-btn", "");
		this.effortBtn.onclick = (e) => this.openEffortMenu(e as MouseEvent);

		this.attachBtn = el("button", "ocs-icon-btn", "");
		setIconOrText(this.attachBtn, "paperclip", "📎", "Attach file (system explorer)");
		this.attachBtn.onclick = () => this.openSystemExplorer();

		this.restrictBtn = el("button", "ocs-icon-btn", "");
		this.restrictBtn.onclick = () => {
			this.plugin.settings.autoApprove = !this.plugin.settings.autoApprove;
			void this.plugin.saveSettings();
			this.renderApproveBtn();
		};

		this.forkBtn = el("button", "ocs-icon-btn", "");
		setIconOrText(this.forkBtn, "git-fork", "⑂", "Fork session");
		this.forkBtn.onclick = () => void this.forkActive();

		const toolbar = el("div", "ocs-toolbar");
		composer.appendChild(toolbar);
		const left = el("div", "ocs-toolbar-left");
		toolbar.appendChild(left);
		left.appendChild(this.modelBtn);
		left.appendChild(this.agentBtn);
		left.appendChild(this.effortBtn);
		const right = el("div", "ocs-toolbar-right");
		toolbar.appendChild(right);
		right.appendChild(this.attachBtn);
		right.appendChild(this.restrictBtn);
		right.appendChild(this.forkBtn);
		this.composerText = document.createElement("textarea");
		this.composerText.className = "ocs-input";
		this.composerText.placeholder =
			"Ask OpenCode…  (/ for commands, Enter to send)";
		this.composerText.rows = 3;
		this.composerText.onkeydown = (e) => {
			if (this.slashOpen) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					this.slashIndex = (this.slashIndex + 1) % Math.max(1, this.slashItems.length);
					this.renderSlashMenu();
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					this.slashIndex =
						(this.slashIndex - 1 + this.slashItems.length) % Math.max(1, this.slashItems.length);
					this.renderSlashMenu();
					return;
				}
				if (e.key === "Enter" || e.key === "Tab") {
					e.preventDefault();
					this.acceptSlash();
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					this.closeSlashMenu();
					return;
				}
			}
			if (e.key === "Escape" && !e.shiftKey) {
				// Double-Esc stops the agent (single Esc just arms).
				const tab = this.activeTab();
				if (tab?.streaming) {
					e.preventDefault();
					const now = Date.now();
					if (now - this.lastEsc < 600) {
						this.lastEsc = 0;
						void this.stopCurrent();
					} else {
						this.lastEsc = now;
						new Notice("Press Esc again to stop the agent");
					}
					return;
				}
			}
			if (e.key === "Enter" && !e.shiftKey) {
				if (this.plugin.settings.sendWithButtonOnly) return;
				e.preventDefault();
				void this.sendCurrent();
			}
		};
		this.composerText.oninput = () => {
			this.updateSlashMenu();
		};
		this.composerText.onpaste = (e) => {
			const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
				f.type.startsWith("image/"),
			);
			if (files.length === 0) return;
			this.attachImageFiles(files);
		};
		composer.ondragover = (e) => {
			e.preventDefault();
			composer.classList.add("ocs-drop");
		};
		composer.ondragleave = () => composer.classList.remove("ocs-drop");
		composer.ondrop = (e) => {
			e.preventDefault();
			composer.classList.remove("ocs-drop");
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length === 0) return;
			const images = files.filter((f) => f.type.startsWith("image/"));
			const rest = files.filter((f) => !f.type.startsWith("image/"));
			if (images.length > 0) this.attachImageFiles(images);
			if (rest.length > 0) this.addPickedFiles(rest);
		};
		composer.appendChild(this.composerText);
		this.sendBtn = el("button", "ocs-send-btn", "");
		setIconOrText(this.sendBtn, "arrow-up", "↑", "Send");
		this.sendBtn.onclick = () => {
			const tab = this.activeTab();
			if (tab?.streaming) void this.stopCurrent();
			else void this.sendCurrent();
		};
		right.appendChild(this.sendBtn);

		// Slash command menu (anchored above the composer)
		this.slashMenu = el("div", "ocs-slash-menu ocs-hidden");
		composer.appendChild(this.slashMenu);

		const statusRow = el("div", "ocs-status-row");
		composer.appendChild(statusRow);
		this.statusLine = el("div", "ocs-status-line", "Not connected");
		statusRow.appendChild(this.statusLine);

		// Order inside the single box: chips, input, toolbar, popups, status.
		composer.appendChild(this.chipsRow);
		composer.appendChild(this.composerText);
		composer.appendChild(toolbar);
		composer.appendChild(this.slashMenu);
		composer.appendChild(statusRow);

		this.renderApproveBtn();
	}

	/** Central link handling: vault links open in the editor, externals in the browser. */
	private onLinkClick(e: MouseEvent): void {
		const target = e.target as HTMLElement | null;
		const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
		if (!anchor) return;
		const href =
			anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? "";
		if (!href) return;
		e.preventDefault();
		e.stopPropagation();
		if (/^(https?:|mailto:|obsidian:)/i.test(href)) {
			window.open(href, "_blank", "noopener");
			return;
		}
		if (href.startsWith("#")) {
			const dest = this.root.querySelector(href);
			if (dest) dest.scrollIntoView({ block: "nearest" });
			return;
		}
		const dest = this.app.metadataCache.getFirstLinkpathDest(href, "");
		if (!dest) {
			new Notice(`File not found in vault: ${href}`);
			return;
		}
		void this.app.workspace.openLinkText(href, "", false);
	}

	private renderSendBtn(): void {		const streaming = this.activeTab()?.streaming ?? false;
		setIconOrText(
			this.sendBtn,
			streaming ? "square" : "arrow-up",
			streaming ? "■" : "↑",
			streaming ? "Stop" : "Send",
		);
		this.sendBtn.classList.toggle("ocs-busy", streaming);
	}

	private renderApproveBtn(): void {
		const auto = this.plugin.settings.autoApprove;
		setIconOrText(
			this.restrictBtn,
			auto ? "shield-check" : "shield",
			auto ? "Auto" : "Safe",
			auto ? "Auto-approve: permissions are accepted automatically" : "Safe: ask before edits and commands",
		);
		this.restrictBtn.classList.toggle("ocs-auto", auto);
	}

	// ---------- tabs (UI-only; sessions live in opencode, not in files) ----------

	private persistTabs(): void {
		void this.plugin.saveData({
			...((this.plugin.loadedData ?? {}) as Record<string, unknown>),
			openTabs: this.tabs.map((t) => ({
				sessionId: t.sessionId,
				title: t.title,
				activeNote: t.activeNote,
				contextFiles: t.contextFiles,
			})),
			activeSessionId: this.activeTab()?.sessionId ?? null,
		});
	}

	private restoreTabs(): void {
		const data = (this.plugin.loadedData ?? {}) as {
			openTabs?: {
				sessionId: string;
				title: string;
				activeNote?: string | null;
				contextFiles?: string[];
			}[];
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
				usageCost: 0,
				usageInput: 0,
				usageOutput: 0,
				usageCache: 0,
				usageHaveData: false,
				activeNote: o.activeNote ?? null,
				contextFiles: Array.isArray(o.contextFiles) ? o.contextFiles : [],
				images: [],
				autoAttached: false,
			};
			this.tabs.push(tab);
			if (!this.activeTabId) this.activeTabId = tab.tabId;
		}
		this.renderTabs();
		this.renderContent();
		this.renderChips();
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
					this.plugin.settings.agent || undefined,
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
			usageCost: 0,
			usageInput: 0,
			usageOutput: 0,
			usageCache: 0,
			usageHaveData: false,
			activeNote: null,
			contextFiles: [],
			images: [],
			autoAttached: false,
		};
		this.tabs.push(tab);
		this.activeTabId = tab.tabId;
		this.autoAttachActiveFile(tab);
		this.renderTabs();
		this.renderContent();
		this.renderChips();
		this.persistTabs();
		if (sid) void this.ensureLoaded(tab);
	}

	private closeTab(tabId: string): void {
		const idx = this.tabs.findIndex((t) => t.tabId === tabId);
		if (idx < 0) return;
		this.tabs.splice(idx, 1);
		// Queued messages never left the client — discard them with the tab.
		this.queued = this.queued.filter((q) => q.tabId !== tabId);
		this.renderQueueBar();
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
			b.title = t.streaming ? `${t.title}\n● writing…\n${t.sessionId}` : `${t.title}\n${t.sessionId}`;
			if (t.streaming) {
				const spin = el("span", "ocs-spinner ocs-tab-spinner");
				spin.title = "writing…";
				b.appendChild(spin);
			} else {
				const dot = el("span", "ocs-tab-activity-dot");
				b.appendChild(dot);
			}
			b.appendChild(el("span", "ocs-tab-number", String(i + 1)));
			const label = el(
				"span",
				"ocs-tab-label",
				t.title.length > 22 ? t.title.slice(0, 21) + "…" : t.title,
			);
			b.appendChild(label);
			const close = el("span", "ocs-tab-close", "✕");
			close.title = "Close tab";
			close.onclick = (e) => {
				e.stopPropagation();
				this.closeTab(t.tabId);
			};
			b.appendChild(close);
			b.onclick = () => {
				this.activeTabId = t.tabId;
				t.attention = false;
				this.renderTabs();
				this.renderContent();
				this.persistTabs();
			};
			b.onmousedown = (e) => {
				// Middle-click closes (preventDefault also kills autoscroll).
				if ((e as MouseEvent).button === 1) {
					e.preventDefault();
					this.closeTab(t.tabId);
				}
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

	// ---------- file context (Grimoire-style chips) ----------

	/** Currently focused markdown file, vault-relative, if auto-attach applies. */
	private focusedNotePath(): string | null {
		if (!this.plugin.settings.autoAttachActiveFile) return null;
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return null;
		return file.path;
	}

	/** Attach the focused file to a fresh tab (default behavior, like Grimoire). */
	private autoAttachActiveFile(tab: TabState): void {
		const note = this.focusedNotePath();
		if (note) {
			tab.activeNote = note;
			tab.autoAttached = true;
		}
	}

	/** Keep the auto-attached chip mirroring the focused file. */
	private syncActiveNote(): void {
		if (!this.plugin.settings.autoAttachActiveFile) return;
		const tab = this.activeTab();
		if (!tab || !tab.autoAttached) return;
		const note = this.focusedNotePath();
		if (note !== tab.activeNote) {
			tab.activeNote = note;
			this.renderChips();
			this.persistTabs();
		}
	}

	private attachFile(path: string): void {
		const tab = this.activeTab();
		if (!tab) return;
		tab.autoAttached = false;
		if (!tab.contextFiles.includes(path) && tab.activeNote !== path) {
			tab.contextFiles.push(path);
		}
		this.renderChips();
		this.persistTabs();
	}

	private detachActiveNote(): void {
		const tab = this.activeTab();
		if (!tab) return;
		tab.activeNote = null;
		tab.autoAttached = false;
		this.renderChips();
		this.persistTabs();
	}

	private detachContextFile(path: string): void {
		const tab = this.activeTab();
		if (!tab) return;
		tab.contextFiles = tab.contextFiles.filter((f) => f !== path);
		tab.autoAttached = false;
		this.renderChips();
		this.persistTabs();
	}

	private openAttachPicker(): void {
		new FileAttachModal(this.app, (path) => this.attachFile(path)).open();
	}

	/** System file explorer — any file, inside or outside the vault. */
	private openSystemExplorer(): void {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.onchange = () => {
			this.addPickedFiles(Array.from(input.files ?? []));
		};
		input.click();
	}

	/** Shared sink for explorer-picked and dropped files. */
	private addPickedFiles(files: File[]): void {
		const tab = this.activeTab();
		if (!tab || files.length === 0) return;
		const vaultDir = this.plugin
			.vaultDir()
			.replace(/\\/g, "/")
			.replace(/\/+$/, "")
			.toLowerCase();
		for (const f of files) {
			const abs = ((f as unknown as { path?: string }).path ?? "").replace(/\\/g, "/");
			let ref = f.name;
			if (abs && vaultDir && abs.toLowerCase().startsWith(`${vaultDir}/`)) {
				ref = abs.slice(vaultDir.length + 1);
			} else if (abs) {
				ref = abs;
			}
			if (!tab.contextFiles.includes(ref) && tab.activeNote !== ref) {
				tab.contextFiles.push(ref);
			}
		}
		tab.autoAttached = false;
		this.renderChips();
		this.persistTabs();
	}

	/** Shared sink for pasted and dropped images. */
	private attachImageFiles(files: File[]): void {
		const tab = this.activeTab();
		if (!tab) return;
		for (const file of files.slice(0, 5)) {
			if (file.size > 10 * 1024 * 1024) {
				new Notice(`Image too large (max 10 MB): ${file.name || "image"}`);
				continue;
			}
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = String(reader.result ?? "");
				if (dataUrl.startsWith("data:image")) {
					tab.images.push({
						id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
						name: file.name || "image",
						dataUrl,
					});
					this.renderChips();
				}
			};
			reader.readAsDataURL(file);
		}
	}

	private removeImage(id: string): void {
		const tab = this.activeTab();
		if (!tab) return;
		tab.images = tab.images.filter((i) => i.id !== id);
		this.renderChips();
	}

	/** Tokens · cost · context-window %, top-right inside the composer box. */
	private updateUsageBadge(): void {
		const tab = this.activeTab();
		if (!tab || !tab.usageHaveData) {
			this.usageBadge.textContent = "";
			return;
		}
		const total = tab.usageInput + tab.usageOutput + tab.usageCache;
		const parts = [`${fmtTokens(total)} tok`, `$${fmtCost(tab.usageCost)}`];
		const limit = this.contextLimit();
		if (limit && limit > 0) {
			parts.push(`${Math.min(999, Math.round((total / limit) * 100))}% ctx`);
		}
		this.usageBadge.textContent = parts.join(" · ");
		this.usageBadge.title = `Tokens: ${total}\nCost: $${tab.usageCost}\nContext: ${limit ? `${total} / ${limit}` : "unknown limit"}`;
	}

	/** Context window size of the selected model, if the catalog reports it. */
	private contextLimit(): number | null {
		const ref = this.selectedModelRef();
		if (!ref) return null;
		const m = this.models.find((x) => x.providerID === ref.providerID && x.id === ref.id);
		return m?.limit ?? null;
	}

	private renderChips(): void {		this.chipsRow.empty();
		const tab = this.activeTab();
		if (tab?.activeNote) {
			this.chipsRow.appendChild(this.chip(tab.activeNote, true));
		}
		for (const f of tab?.contextFiles ?? []) {
			this.chipsRow.appendChild(this.chip(f, false));
		}
		for (const img of tab?.images ?? []) {
			const thumb = el("span", "ocs-chip ocs-img-chip");
			thumb.title = img.name;
			const im = document.createElement("img");
			im.src = img.dataUrl;
			im.alt = img.name;
			im.className = "ocs-img-thumb";
			thumb.appendChild(im);
			const x = el("button", "ocs-chip-x", "×");
			x.title = "Remove image";
			x.onclick = () => this.removeImage(img.id);
			thumb.appendChild(x);
			this.chipsRow.appendChild(thumb);
		}
		const add = el("button", "ocs-chip-add", "+ Add");
		add.title = "Attach vault file";
		add.onclick = () => this.openAttachPicker();
		this.chipsRow.appendChild(add);
		// Usage text lives top-right inside the composer box (plain text).
		this.chipsRow.appendChild(this.usageBadge);
		this.updateUsageBadge();
	}

	private chip(path: string, isActiveNote: boolean): HTMLElement {
		const chip = el("span", `ocs-chip${isActiveNote ? " ocs-chip-note" : ""}`);
		chip.title = path;
		const base = path.split("/").pop() ?? path;
		chip.appendChild(el("span", "ocs-chip-name", base));
		const x = el("button", "ocs-chip-x", "×");
		x.title = "Remove";
		x.onclick = () => {
			if (isActiveNote) this.detachActiveNote();
			else this.detachContextFile(path);
		};
		chip.appendChild(x);
		return chip;
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
		this.renderSendBtn();
	}

	private renderContent(): void {
		this.content.empty();
		this.renderChips();
		this.renderQueueBar();
		const tab = this.activeTab();
		if (!tab) {
			this.content.appendChild(el("div", "ocs-empty", "Open a session tab to start."));
			this.renderSendBtn();
			return;
		}
		this.renderSendBtn();
		const list = el("div", "ocs-message-list");
		this.content.appendChild(list);
		if (!tab.loaded) {
			list.appendChild(el("div", "ocs-wait", "Loading native session history…"));
			return;
		}
		if (tab.messages.length === 0 && !this.queuedFor(tab.tabId).length) {
			list.appendChild(
				el("div", "ocs-empty", "Empty session — say hello."),
			);
		}
		for (const m of tab.messages) list.appendChild(this.renderMessage(m));
		for (const q of this.queuedFor(tab.tabId)) {
			const wrap = el("div", "ocs-msg ocs-user ocs-queued");
			const bubble = el("div", "ocs-bubble");
			const body = el("div", "ocs-msg-body");
			body.innerHTML = renderRich(q.text);
			bubble.appendChild(body);
			wrap.appendChild(bubble);
			wrap.appendChild(el("div", "ocs-msg-meta", `⏳ queued — will send once opencode is ready · ${fmtTime(q.ts)}`));
			list.appendChild(wrap);
		}
		// live (streaming) containers are appended by the event loop
		const live = this.liveAssistant.get(tab.sessionId);
		if (live && !live.parentElement) list.appendChild(live);
		list.scrollTop = list.scrollHeight;
		this.updateUsageBadge();
	}

	private renderMessage(m: ChatMessage): HTMLElement {
		const wrap = el("div", `ocs-msg ocs-${m.role}`);
		const meta = el("div", "ocs-msg-meta");
		const stamp = fmtTime(m.timestamp) + (m.durationSeconds !== undefined ? ` · ${fmtDuration(m.durationSeconds)}` : "");
		meta.appendChild(el("span", "", stamp));
		if (m.text) {
			const copy = el("button", "ocs-copy-btn", "⧉");
			copy.title = "Copy message text";
			copy.onclick = async (e) => {
				e.stopPropagation();
				try {
					await navigator.clipboard.writeText(m.text);
					new Notice("Message copied");
				} catch {
					new Notice("Could not access clipboard");
				}
			};
			meta.appendChild(copy);
		}
		const bubble = el("div", "ocs-bubble");
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
			bubble.appendChild(det);
		}
		for (const t of m.tools) {
			bubble.appendChild(this.renderTool(t));
		}
		if (m.text) {
			const body = el("div", "ocs-msg-body");
			if (m.role === "user") {
				// Plain text: exactly the line breaks the user typed, no
				// paragraph gaps from Markdown processing.
				body.textContent = m.text;
			} else {
				this.renderBodyText(body, m.text);
			}
			bubble.appendChild(body);
		}
		wrap.appendChild(bubble);
		wrap.appendChild(meta);
		return wrap;
	}

	/**
	 * Renders message text with Obsidian's full Markdown pipeline (callouts,
	 * tables, task lists, highlights, quotes, math, …). Code spans/blocks
	 * that actually contain LaTeX are converted to $ math first so they
	 * typeset instead of showing as code.
	 */
	private renderBodyText(container: HTMLElement, text: string): void {
		const converted = convertLatexCodeToMath(text);
		const div = document.createElement("div");
		container.appendChild(div);
		MarkdownRenderer.render(this.app, converted, div, "", this).catch(() => {
			div.innerHTML = renderRich(text);
		});
	}

	private renderTool(t: {
		tool?: string;
		input?: Record<string, unknown>;
		output?: string;
		status?: string;
		diffs?: Array<{ file: string; patch: string; created?: boolean }>;
		filePath?: string;
	}): HTMLElement {
		const name = t.tool ?? "tool";
		const status = t.status ?? "completed";
		const input = t.input ?? {};
		const det = document.createElement("details");
		det.className = `ocs-toolcall ocs-${status}`;
		const sum = document.createElement("summary");
		const dot = el("span", "ocs-tool-dot");
		sum.appendChild(dot);
		if (t.diffs?.length) {
			const files = t.diffs.map((d) => this.shortPath(d.file)).join(", ");
			const allCreated = t.diffs.every((d) => d.created);
			const total = t.diffs.reduce(
				(acc, d) => {
					const c = countDiff(d.patch);
					return { added: acc.added + c.added, removed: acc.removed + c.removed };
				},
				{ added: 0, removed: 0 },
			);
			sum.appendChild(
				el("span", "ocs-tool-name", `${allCreated ? "Created" : "Edited"} ${files}`),
			);
			sum.appendChild(el("span", "ocs-diff-stats", `+${total.added} −${total.removed}`));
			det.open = false;
		} else {
			sum.appendChild(el("span", "ocs-tool-name", name));
			const short = t.filePath
				? this.shortPath(t.filePath)
				: summarizeInput(input);
			if (short) sum.appendChild(el("span", "ocs-tool-arg", short));
		}
		det.appendChild(sum);
		if (t.diffs?.length) {
			for (const d of t.diffs) det.appendChild(this.renderFileDiff(d.file, d.patch));
		} else if (t.filePath && (name === "write" || name === "edit")) {
			const content = typeof input.content === "string" ? input.content : "";
			const lines = content ? content.split("\n").length : 0;
			det.appendChild(
				el(
					"div",
					"ocs-diff-file",
					`${name === "write" ? "Created" : "Edited"} ${this.shortPath(t.filePath)}${lines ? ` · ${lines} lines` : ""}`,
				),
			);
		}
		const inp = el("pre", "ocs-tool-input", safeJson(input));
		det.appendChild(inp);
		if (t.output) det.appendChild(el("pre", "ocs-tool-output", t.output.slice(0, 4000)));
		return det;
	}

	/** Vault-relative display path (falls back to basename). */
	private shortPath(p: string): string {
		const vault = this.plugin.vaultDir().replace(/\\/g, "/").replace(/\/+$/, "");
		const norm = p.replace(/\\/g, "/");
		if (vault && norm.toLowerCase().startsWith(vault.toLowerCase() + "/")) {
			return norm.slice(vault.length + 1);
		}
		const base = norm.split("/").pop() ?? p;
		return base;
	}

	private renderFileDiff(file: string, patch: string): HTMLElement {
		const box = el("div", "ocs-diff");
		box.appendChild(el("div", "ocs-diff-file", this.shortPath(file)));
		const lines = el("div", "ocs-diff-lines");
		const cls: Record<string, string> = {
			hunk: "ocs-diff-hunk",
			add: "ocs-diff-add",
			del: "ocs-diff-del",
			ctx: "ocs-diff-ctx",
			note: "ocs-diff-note",
		};
		for (const line of parseUnifiedDiff(patch)) {
			lines.appendChild(el("div", cls[line.kind], line.text));
		}
		box.appendChild(lines);
		return box;
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
		try {
			const info = (await client.session.get({
				sessionID: tab.sessionId,
			} as never)) as unknown as {
				cost?: number;
				tokens?: { input?: number; output?: number; cache?: { read?: number } };
			};
			if (typeof info.cost === "number" || info.tokens) {
				tab.usageCost = info.cost ?? 0;
				tab.usageInput = info.tokens?.input ?? 0;
				tab.usageOutput = info.tokens?.output ?? 0;
				tab.usageCache = info.tokens?.cache?.read ?? 0;
				tab.usageHaveData = true;
			}
		} catch {
			/* usage is best-effort; messages matter more */
		}
		if (this.plugin.settings.latexHint) {
			void ensureMathInstruction(client, tab.sessionId);
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
		const v = this.plugin.settings.model;
		if (!v) return null;
		const [providerID, ...rest] = v.split("/");
		const id = rest.join("/");
		if (!providerID || !id) return null;
		return { providerID, id };
	}

	private modelLabel(value: string): string {
		const m = this.models.find((x) => `${x.providerID}/${x.id}` === value);
		return m?.name || value;
	}

	private agentLabel(value: string): string {
		const a = this.agents.find((x) => x.id === value);
		return a?.name || a?.id || value || "Agent";
	}

	private openModelPicker(): void {
		if (this.models.length === 0) {
			new Notice("No models discovered yet — wait for connect, then retry.");
			void this.refreshCatalogs();
			return;
		}
		new ModelPickerModal(
			this.app,
			this.models.map((m) => ({
				value: `${m.providerID}/${m.id}`,
				name: m.name || m.id,
				detail: `${m.providerID}/${m.id}${m.variants.length > 0 ? ` · ${m.variants.join(", ")}` : ""}`,
			})),
			(value) => void this.onModelChanged(value),
		).open();
	}

	private openAgentPicker(e: MouseEvent): void {
		const menu = new Menu();
		if (this.agents.length === 0) {
			menu.addItem((i) => i.setTitle("No agents discovered yet").setDisabled(true));
		}
		for (const a of this.agents) {
			menu.addItem((i) =>
				i
					.setTitle(a.name || a.id)
					.setChecked(a.id === this.plugin.settings.agent)
					.onClick(() => void this.onAgentChanged(a.id)),
			);
		}
		menu.showAtMouseEvent(e);
	}

	private async onModelChanged(value?: string): Promise<void> {
		const tab = this.activeTab();
		const client = this.plugin.client;
		if (value !== undefined) this.plugin.settings.model = value;
		const ref = this.selectedModelRef();
		void this.plugin.saveSettings();
		this.renderModelBtn();
		this.renderVariantOptions();
		this.updateUsageBadge();
		if (tab && client && ref && tab.sessionId && !tab.sessionId.startsWith("pending-")) {
			try {
				await switchModel(client, tab.sessionId, ref.providerID, ref.id);
			} catch (e) {
				new Notice(`Model switch failed: ${errMsg(e)}`);
			}
		}
	}

	private async onVariantChanged(value?: string): Promise<void> {
		const tab = this.activeTab();
		const client = this.plugin.client;
		const ref = this.selectedModelRef();
		if (value !== undefined) this.plugin.settings.variant = value;
		void this.plugin.saveSettings();
		this.renderEffortBtn();
		if (tab && client && ref && tab.sessionId && !tab.sessionId.startsWith("pending-")) {
			try {
				await switchModel(
					client,
					tab.sessionId,
					ref.providerID,
					ref.id,
					this.plugin.settings.variant,
				);
			} catch (e) {
				new Notice(`Variant switch failed: ${errMsg(e)}`);
			}
		}
	}

	private async onAgentChanged(value?: string): Promise<void> {
		const tab = this.activeTab();
		const client = this.plugin.client;
		if (value !== undefined) this.plugin.settings.agent = value;
		void this.plugin.saveSettings();
		this.renderAgentBtn();
		if (tab && client && tab.sessionId && !tab.sessionId.startsWith("pending-")) {
			try {
				await switchAgent(client, tab.sessionId, this.plugin.settings.agent);
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
		this.closeSlashMenu();

		const client = this.plugin.client;
		if (!client || this.plugin.isConnecting()) {
			this.enqueue(tab, raw);
			return;
		}
		if (tab.streaming) {
			this.enqueue(tab, raw);
			new Notice("Agent is working — message queued, sends automatically.");
			return;
		}
		void this.dispatchText(tab, raw);
	}

	private enqueue(tab: TabState, raw: string): void {
		this.queued.push({ tabId: tab.tabId, text: raw, ts: Date.now() });
		this.renderContent();
		if (!this.plugin.client || this.plugin.isConnecting()) {
			new Notice("opencode is still starting — message queued, will send when ready.");
		}
	}

	/** Sends queued messages once its tab is free (oldest first, one per tab). */
	async flushQueue(): Promise<void> {
		if (!this.plugin.client) return;
		let sent = 0;
		for (const tab of this.tabs) {
			if (await this.flushQueueFor(tab)) sent++;
		}
		if (sent > 0) {
			this.renderContent();
			new Notice(`opencode is ready — ${sent} queued message${sent === 1 ? "" : "s"} sent.`);
		}
	}

	private async flushQueueFor(tab: TabState): Promise<boolean> {
		const client = this.plugin.client;
		if (!client || tab.streaming) return false;
		const idx = this.queued.findIndex((q) => q.tabId === tab.tabId);
		if (idx < 0) return false;
		const [item] = this.queued.splice(idx, 1);
		this.renderQueueBar();
		await this.dispatchText(tab, item.text);
		return true;
	}

	/** Outbox bar hovering above the input field. */
	private renderQueueBar(): void {
		this.queueBar.empty();
		const tab = this.activeTab();
		const items = tab ? this.queuedFor(tab.tabId) : [];
		if (items.length === 0) {
			this.queueBar.classList.add("ocs-hidden");
			return;
		}
		this.queueBar.classList.remove("ocs-hidden");
		this.queueBar.appendChild(
			el(
				"div",
				"ocs-queue-head",
				`⏳ Queued (${items.length}) — sends automatically when the agent is done`,
			),
		);
		for (const q of items) {
			const row = el("div", "ocs-queue-row");
			const preview = q.text.length > 80 ? `${q.text.slice(0, 79)}…` : q.text;
			row.appendChild(el("span", "ocs-queue-text", preview));
			const x = el("button", "ocs-chip-x", "×");
			x.title = "Discard queued message";
			x.onclick = () => {
				this.queued = this.queued.filter((o) => o !== q);
				this.renderQueueBar();
			};
			row.appendChild(x);
			this.queueBar.appendChild(row);
		}
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
		// Slash commands never reach the agent raw: local, native, or rejected.
		if (raw.startsWith("/")) {
			if (await this.handleLocalCommand(raw, tab)) return;
			const m = /^\/([\w-]+)\s*([\s\S]*)$/.exec(raw);
			const cmdName = m?.[1] ?? raw.slice(1).split(/\s/, 1)[0];
			if (cmdName === "compact") {
				tab.streaming = true;
				this.renderTabs();
				try {
					await client.session.compact({ sessionID: tab.sessionId } as never);
				} catch (e) {
					tab.streaming = false;
					new Notice(`Compact failed: ${errMsg(e)}`);
				}
				return;
			}
			if (m && this.commands.some((c) => c.name === m[1])) {
				tab.streaming = true;
				this.renderTabs();
				this.renderContent();
				try {
					await runSessionCommand(client, tab.sessionId, m[1], m[2] ?? "");
				} catch (e) {
					tab.streaming = false;
					new Notice(`Command failed: ${errMsg(e)}`);
					this.renderTabs();
					this.renderContent();
				}
				return;
			}
			// Unknown command: do NOT send it to the agent.
			new Notice(`Unknown command: /${cmdName} — type / to see available commands.`);
			this.composerText.value = raw;
			return;
		}
		// optimistic user bubble (clean text; context travels in the prompt only)
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
		// Active note + attached files, Grimoire-style XML suffix (server-side only).
		// Vault files travel as paths; external files are inlined so the
		// agent can always open them (paths alone often fail to resolve).
		let text = raw;
		if (tab.activeNote) text = appendCurrentNote(text, tab.activeNote);
		const extra = tab.contextFiles.filter((f) => f !== tab.activeNote);
		const vaultRefs = extra.filter((f) => !isAbsolutePath(f));
		if (vaultRefs.length > 0) text = appendContextFiles(text, vaultRefs);
		for (const abs of extra.filter((f) => isAbsolutePath(f))) {
			text = appendExternalFile(text, readExternalTextFile(abs));
		}
		const files = tab.images.map((i) => ({ uri: i.dataUrl }));
		try {
			await sendPrompt(client, tab.sessionId, text, files);
			tab.images = [];
			this.renderChips();
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

	private localSlashCommands(): Array<{ name: string; hint: string; takesArg: boolean }> {
		return [
			{ name: "/session", hint: "Show shared sessions", takesArg: false },
			{ name: "/new", hint: "New session tab", takesArg: false },
			{ name: "/compact", hint: "Compact current session", takesArg: false },
			{ name: "/fork", hint: "Fork current session", takesArg: false },
			{ name: "/rename", hint: "Rename current session…", takesArg: true },
			{ name: "/reload", hint: "Reload messages", takesArg: false },
		];
	}

	private updateSlashMenu(): void {
		const m = /^\/([A-Za-z0-9_-]*)$/.exec(this.composerText.value);
		if (!m) {
			this.closeSlashMenu();
			return;
		}
		const prefix = m[1].toLowerCase();
		const seen = new Set<string>();
		const items: Array<{ name: string; hint: string; takesArg: boolean }> = [];
		for (const c of this.localSlashCommands()) {
			if (c.name.toLowerCase().startsWith(`/${prefix}`) && !seen.has(c.name)) {
				seen.add(c.name);
				items.push(c);
			}
		}
		for (const c of this.commands) {
			const name = `/${c.name}`;
			if (name.toLowerCase().startsWith(`/${prefix}`) && !seen.has(name)) {
				seen.add(name);
				items.push({ name, hint: c.description || "opencode command", takesArg: true });
			}
		}
		if (items.length === 0) {
			this.closeSlashMenu();
			return;
		}
		this.slashItems = items;
		this.slashIndex = Math.min(this.slashIndex, items.length - 1);
		this.renderSlashMenu();
	}

	private renderSlashMenu(): void {
		this.slashMenu.empty();
		this.slashItems.forEach((item, i) => {
			const row = el("button", `ocs-slash-row${i === this.slashIndex ? " ocs-selected" : ""}`);
			row.appendChild(el("span", "ocs-slash-name", item.name));
			row.appendChild(el("span", "ocs-slash-hint", item.hint));
			row.onmousedown = (e) => {
				e.preventDefault();
				this.slashIndex = i;
				this.acceptSlash();
			};
			this.slashMenu.appendChild(row);
		});
		this.slashOpen = true;
		this.slashMenu.classList.remove("ocs-hidden");
	}

	private acceptSlash(): void {
		const item = this.slashItems[this.slashIndex];
		this.closeSlashMenu();
		if (!item) return;
		this.composerText.value = item.takesArg ? `${item.name} ` : item.name;
		this.composerText.focus();
	}

	private closeSlashMenu(): void {
		this.slashOpen = false;
		this.slashIndex = 0;
		this.slashMenu?.classList.add("ocs-hidden");
	}

	/** Returns true if the command was handled locally. */
	private async handleLocalCommand(raw: string, tab: TabState): Promise<boolean> {		const client = this.plugin.client;
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
				const limit = r.limit as { context?: unknown } | undefined;
				return {
					providerID: String(r.providerID ?? r.provider ?? ""),
					id: String(r.id ?? ""),
					name: String(r.name ?? r.id ?? ""),
					variants: Array.isArray(r.variants)
						? (r.variants as { id?: string }[]).map((v) => String(v.id ?? v))
						: [],
					limit: typeof limit?.context === "number" ? limit.context : null,
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
		this.renderModelBtn();
		this.renderAgentBtn();
		this.setStatus("");
	}

	private renderModelBtn(): void {
		if (!this.plugin.settings.model && this.models.length > 0) {
			this.plugin.settings.model = `${this.models[0].providerID}/${this.models[0].id}`;
			void this.plugin.saveSettings();
		}
		const label = this.plugin.settings.model
			? this.modelLabel(this.plugin.settings.model)
			: "Model";
		this.modelBtn.empty();
		this.modelBtn.appendChild(el("span", "ocs-picker-label", label));
		this.modelBtn.title = `Model: ${this.plugin.settings.model || "none"} (click to change)`;
		this.renderVariantOptions();
	}

	private renderVariantOptions(): void {
		const ref = this.selectedModelRef();
		const m = this.models.find(
			(x) => ref && x.providerID === ref.providerID && x.id === ref.id,
		);
		this.variantOptions = ["default", ...(m?.variants ?? []).filter((v) => v !== "default")];
		if (!this.variantOptions.includes(this.plugin.settings.variant)) {
			this.plugin.settings.variant = this.variantOptions[0];
			void this.plugin.saveSettings();
		}
		this.renderEffortBtn();
	}

	private renderEffortBtn(): void {
		const v = this.plugin.settings.variant || "default";
		this.effortBtn.empty();
		this.effortBtn.appendChild(el("span", "ocs-picker-label", v === "default" ? "Auto" : v));
		this.effortBtn.appendChild(el("span", "ocs-picker-chev", "▾"));
		this.effortBtn.title = `Reasoning effort: ${v} (click to change)`;
	}

	private openEffortMenu(e: MouseEvent): void {
		const menu = new Menu();
		const opts = this.variantOptions.length > 0 ? this.variantOptions : ["default"];
		for (const v of opts) {
			menu.addItem((i) =>
				i
					.setTitle(v === "default" ? "Auto" : v)
					.setChecked(v === this.plugin.settings.variant)
					.onClick(() => void this.onVariantChanged(v)),
			);
		}
		menu.showAtMouseEvent(e);
	}

	private renderAgentBtn(): void {
		const saved = this.plugin.settings.agent;
		if (!saved && this.agents.length > 0) {
			const preferred = this.agents.find((a) => a.id === "build") ?? this.agents[0];
			this.plugin.settings.agent = preferred.id;
			void this.plugin.saveSettings();
		}
		const label = this.agentLabel(this.plugin.settings.agent);
		this.agentBtn.empty();
		this.agentBtn.appendChild(el("span", "ocs-picker-label", label));
		this.agentBtn.appendChild(el("span", "ocs-picker-chev", "▾"));
		this.agentBtn.title = `Agent: ${this.plugin.settings.agent || "none"} (click to change)`;
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
		const subscribe = client.event.subscribe as unknown as (opts?: {
			signal?: AbortSignal;
		}) => AsyncIterable<Record<string, unknown>>;
		let failures = 0;
		while (!signal.aborted) {
			try {
				const stream = subscribe({ signal });
				failures = 0;
				for await (const raw of stream) {
					if (signal.aborted) return;
					this.handleEvent(raw);
				}
				// Server closed the stream cleanly (e.g. it restarted) —
				// fall through to reconnect instead of dying silently.
				failures++;
				this.setStatus("Event stream closed by server, reconnecting…");
			} catch (e) {
				if (signal.aborted) return;
				failures++;
				this.setStatus(`Event stream lost (${errMsg(e)}), reconnecting…`);
			}
			if (signal.aborted) return;
			await new Promise((r) => setTimeout(r, Math.min(1000 * failures, 10000)));
			if (signal.aborted) return;
			// Re-sync: turns that finished during the outage left no events.
			void this.reconcileStreaming();
		}
	}

	/**
	 * Repairs stuck "working" tabs after an event outage: any tab whose
	 * session already reached a terminal outcome is finalized locally,
	 * then its queue flushes.
	 */
	private async reconcileStreaming(): Promise<void> {
		const client = this.plugin.client;
		if (!client) return;
		for (const tab of this.tabs) {
			if (!tab.streaming || tab.sessionId.startsWith("pending-")) continue;
			try {
				const info = (await client.session.get({
					sessionID: tab.sessionId,
				} as never)) as unknown as { outcome?: string };
				if (
					info.outcome === "succeeded" ||
					info.outcome === "failed" ||
					info.outcome === "interrupted"
				) {
					tab.streaming = false;
					tab.loaded = false;
					this.liveTools.delete(tab.sessionId);
					if (tab.tabId === this.activeTabId) {
						this.renderContent();
						this.renderTabs();
					} else {
						tab.attention = true;
						this.renderTabs();
					}
					void this.ensureLoaded(tab);
					void this.flushQueueFor(tab);
				}
			} catch {
				/* session may be gone; leave the tab as is */
			}
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

	private liveToolState(sessionId: string, toolId: string): LiveToolState | undefined {
		return this.liveTools.get(sessionId)?.get(toolId);
	}

	/** Creates (or updates) a live tool card — visible and expandable while running. */
	private upsertLiveTool(
		tab: TabState,
		toolId: string,
		patch: Partial<Pick<LiveToolState, "name" | "inputText" | "status" | "output">>,
	): LiveToolState {
		let map = this.liveTools.get(tab.sessionId);
		if (!map) {
			map = new Map();
			this.liveTools.set(tab.sessionId, map);
		}
		let st = map.get(toolId);
		if (!st) {
			const live = this.ensureLiveAssistant(tab);
			const node = document.createElement("details");
			node.className = "ocs-toolcall ocs-running";
			node.dataset.tool = toolId;
			const sum = document.createElement("summary");
			const dot = el("span", "ocs-tool-dot");
			sum.appendChild(dot);
			const sumName = el("span", "ocs-tool-name", "tool");
			sum.appendChild(sumName);
			const sumArg = el("span", "ocs-tool-arg", "");
			sum.appendChild(sumArg);
			node.appendChild(sum);
			const inputPre = el("pre", "ocs-tool-input", "");
			inputPre.style.display = "none";
			node.appendChild(inputPre);
			st = {
				node,
				sumName,
				sumArg,
				inputPre,
				outPre: null,
				name: "tool",
				inputText: "",
				output: "",
				status: "running",
			};
			map.set(toolId, st);
			live.appendChild(node);
			const list = this.messageListEl();
			if (list && tab.tabId === this.activeTabId) list.scrollTop = list.scrollHeight;
		}
		if (patch.name !== undefined) st.name = patch.name;
		if (patch.inputText !== undefined) st.inputText = patch.inputText;
		if (patch.status !== undefined) st.status = patch.status;
		if (patch.output !== undefined) st.output = patch.output;
		this.paintLiveTool(st);
		return st;
	}

	private paintLiveTool(st: LiveToolState): void {
		st.sumName.textContent = st.name;
		let parsed: Record<string, unknown> | null = null;
		if (st.inputText) {
			try {
				const v: unknown = JSON.parse(st.inputText);
				if (v && typeof v === "object" && !Array.isArray(v)) {
					parsed = v as Record<string, unknown>;
				}
			} catch {
				parsed = null;
			}
		}
		const rawPath =
			(parsed && typeof parsed.path === "string" && parsed.path) ||
			(parsed && typeof parsed.file === "string" && parsed.file) ||
			"";
		const base = rawPath ? String(rawPath).replace(/\\/g, "/").split("/").pop() ?? "" : "";
		st.sumArg.textContent = base || (parsed ? summarizeInput(parsed) : st.inputText.slice(0, 80));
		const pretty = parsed ? safeJson(parsed) : st.inputText;
		if (pretty.trim()) {
			st.inputPre.style.display = "";
			if (st.inputPre.textContent !== pretty.slice(0, 2000)) {
				st.inputPre.textContent = pretty.slice(0, 2000);
			}
		} else {
			st.inputPre.style.display = "none";
		}
		st.node.classList.remove("ocs-running", "ocs-done", "ocs-error");
		st.node.classList.add(
			st.status === "completed" ? "ocs-done" : st.status === "error" ? "ocs-error" : "ocs-running",
		);
		if (st.output) {
			if (!st.outPre) {
				st.outPre = el("pre", "ocs-tool-output", "");
				st.node.appendChild(st.outPre);
			}
			st.outPre.textContent = st.output.slice(0, 4000);
		} else if (st.outPre) {
			st.outPre.remove();
			st.outPre = null;
		}
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
						this.renderSendBtn();
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
						live.remove();
						this.liveAssistant.delete(tab.sessionId);
						this.liveReasoning.delete(tab.sessionId);
					}
					this.liveTools.delete(tab.sessionId);
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
					// A queued follow-up goes out now that the agent is free.
					void this.flushQueueFor(tab);
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
			case "session.tool.input.started": {
				if (tab) {
					const id = String(data.id ?? "");
					const name = String(data.name ?? "tool");
					if (id) this.upsertLiveTool(tab, id, { name });
				}
				break;
			}
			case "session.tool.input.delta": {
				if (tab) {
					const id = String(data.id ?? "");
					const st = id ? this.liveToolState(tab.sessionId, id) : undefined;
					if (st) {
						st.inputText += String(data.delta ?? "");
						this.paintLiveTool(st);
					}
				}
				break;
			}
			case "session.tool.called": {
				if (tab) {
					const id = String(data.id ?? "");
					if (id) {
						const input = (data as Record<string, unknown>).input as
							| Record<string, unknown>
							| undefined;
						this.upsertLiveTool(tab, id, {
							inputText:
								input && typeof input === "object"
									? JSON.stringify(input, null, 2)
									: "",
						});
					}
				}
				break;
			}
			case "session.tool.success":
			case "session.tool.failed": {
				if (tab) {
					const id = String(data.id ?? "");
					const st = id ? this.liveToolState(tab.sessionId, id) : undefined;
					if (st) {
						const ok = type === "session.tool.success";
						st.status = ok ? "completed" : "error";
						if (!ok) {
							const err = data.error as
								| { message?: string; response?: { body?: string } }
								| undefined;
							const body =
								typeof err?.message === "string" && err.message
									? err.message
									: typeof err?.response?.body === "string"
										? err.response.body
										: "";
							st.output = [toolContentText(data.content), body]
								.filter(Boolean)
								.join("\n");
						} else {
							st.output = toolContentText(data.content);
						}
						this.paintLiveTool(st);
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
					const tokens = data.tokens as
						| { input?: number; output?: number; cache?: { read?: number } }
						| undefined;
					const cost = data.cost as { value?: number } | number | undefined;
					tab.usageCost = typeof cost === "number" ? cost : (cost?.value ?? 0);
					tab.usageInput = tokens?.input ?? 0;
					tab.usageOutput = tokens?.output ?? 0;
					tab.usageCache = tokens?.cache?.read ?? 0;
					tab.usageHaveData = true;
					if (tab.tabId === this.activeTabId) this.updateUsageBadge();
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

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function fmtCost(c: number): string {
	return c.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
}

function toolContentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const c of content as Array<Record<string, unknown>>) {
		if (!c || typeof c !== "object") continue;
		if (c.type === "text" && typeof c.text === "string" && c.text) {
			parts.push(c.text);
		} else if (c.type === "file") {
			parts.push(`[file: ${String(c.name ?? c.uri ?? "file")}]`);
		}
	}
	return parts.join("\n");
}

function cssEsc(s: string): string {
	return s.replace(/["\\]/g, "\\$&");
}

/** Lucide icon with a text fallback when the icon set lacks the name. */
function setIconOrText(btn: HTMLElement, icon: string, fallback: string, title: string): void {
	btn.empty();
	const svg = getIcon(icon);
	if (svg) btn.appendChild(svg);
	else btn.textContent = fallback;
	btn.setAttribute("aria-label", title);
	btn.title = title;
}
