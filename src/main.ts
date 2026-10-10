import { Plugin, WorkspaceLeaf, Notice, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS, type PluginSettings } from "./settings";
import { connectShared, describeConnectionError, getLastAttempt, type Connection } from "./opencode/connection";
import { OpenCodeChatView, VIEW_TYPE_OPENCODE } from "./ui/chat-view";
import type { OpenCodeClient } from "@opencode/client";

export default class OpenCodePlugin extends Plugin {
	settings!: PluginSettings;
	client: OpenCodeClient | null = null;
	endpointUrl = "";
	sharedService = false;
	loadedData: Record<string, unknown> | null = null;
	private connecting = false;

	/** Vault root = opencode project directory. Sessions are scoped to it. */
	vaultDir(): string {
		try {
			const adapter = this.app.vault.adapter as unknown as {
				getBasePath?: () => string;
			};
			if (typeof adapter.getBasePath === "function") return adapter.getBasePath();
		} catch {
			/* mobile / unsupported */
		}
		return "";
	}

	async onload(): Promise<void> {
		this.loadedData = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(this.loadedData.settings ?? {}) as Partial<PluginSettings>,
		);

		this.registerView(VIEW_TYPE_OPENCODE, (leaf) => new OpenCodeChatView(leaf, this));

		this.addRibbonIcon("bot", "Open OpenCode", () => void this.activateView());

		this.addCommand({
			id: "open-opencode",
			name: "Open OpenCode chat",
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "opencode-new-session",
			name: "New OpenCode session",
			callback: async () => {
				await this.activateView();
				const view = this.chatView();
				if (view) void view["newTab"]();
			},
		});
		for (let i = 1; i <= 9; i++) {
			this.addCommand({
				id: `opencode-tab-${i}`,
				name: `Switch to tab ${i}`,
				callback: async () => {
					await this.activateView();
					const view = this.chatView();
					if (view && view.tabs[i - 1]) {
						view.activeTabId = view.tabs[i - 1].tabId;
						view["renderTabs"]();
						view["renderContent"]();
					}
				},
			});
		}

		this.addSettingTab(new OpenCodeSettingTab(this.app, this));

		// Connect lazily but eagerly: shared background service = same sessions as CLI.
		void this.ensureConnected();
		this.registerInterval(window.setInterval(() => void this.ensureConnected(true), 60_000));
	}

	onunload(): void {
		// Shared service stays alive for the CLI — do NOT stop it here.
		this.client = null;
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ ...(this.loadedData ?? {}), settings: this.settings });
		this.loadedData = { ...(this.loadedData ?? {}), settings: this.settings };
	}

	async saveData(data: unknown): Promise<void> {
		this.loadedData = (data ?? {}) as Record<string, unknown>;
		await super.saveData(data);
	}

	chatView(): OpenCodeChatView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE);
		return (leaves[0]?.view as OpenCodeChatView | undefined) ?? null;
	}

	isConnecting(): boolean {
		return this.connecting;
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_OPENCODE);
		if (leaves.length > 0) leaf = leaves[0];
		else leaf = workspace.getRightLeaf(false);
		if (!leaf) leaf = workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_OPENCODE, active: true });
		if (leaf.view instanceof OpenCodeChatView) {
			workspace.revealLeaf(leaf);
		}
		void this.ensureConnected();
	}

	async ensureConnected(quiet = false): Promise<boolean> {
		if (this.client || this.connecting) return this.client !== null;
		this.connecting = true;
		this.chatView()?.setConnecting(true, "opencode is starting…");
		try {
			const conn: Connection = await connectShared(
				this.settings.opencodeBin,
				this.settings.opencodeExtraEnv,
				(line) => {
					const view = this.chatView() as unknown as {
						setStatus?: (s: string) => void;
						setConnecting?: (active: boolean, detail?: string) => void;
					} | null;
					view?.setStatus?.(line);
					view?.setConnecting?.(true, line);
				},
			);
			this.client = conn.client;
			this.endpointUrl = conn.endpointUrl;
			this.sharedService = conn.sharedService;
			this.chatView()?.onConnected();
			return true;
		} catch (e) {
			if (!quiet) {
				new Notice(
					`OpenCode: shared service failed (${describeConnectionError(e)}). Is 'opencode' installed?`,
				);
			}
			const view = this.chatView() as unknown as {
				setStatus?: (s: string) => void;
				setConnecting?: (active: boolean, detail?: string) => void;
			} | null;
			view?.setConnecting?.(false);
			view?.setStatus?.(`Not connected: ${describeConnectionError(e)}`);
			return false;
		} finally {
			this.connecting = false;
		}
	}
}

class OpenCodeSettingTab extends PluginSettingTab {
	plugin: OpenCodePlugin;

	constructor(app: import("obsidian").App, plugin: OpenCodePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "OpenCode — shared native sessions" });
		containerEl.createEl("p", {
			text: "Conversations are native opencode sessions in this vault's project scope. The plugin talks to the same background service as the CLI, so /session lists the same sessions everywhere. Nothing is stored in extra conversation files — only UI state (open tabs) lives in Obsidian's plugin data.",
		});

		new Setting(containerEl)
			.setName("OpenCode binary")
			.setDesc(
				"Command or absolute path used for the shared background service. On Windows, npm shims (opencode.cmd/.ps1) cannot be spawned directly — point this at opencode.exe if auto-detection fails.",
			)
			.addText((t) =>
				t.setValue(this.plugin.settings.opencodeBin).onChange(async (v) => {
					this.plugin.settings.opencodeBin = v.trim() || "opencode";
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Extra environment")
			.addTextArea((t) => {
				t.setValue(this.plugin.settings.opencodeExtraEnv);
				t.inputEl.rows = 4;
				t.inputEl.placeholder = "OPENCODE_ENABLE_EXA=1\nANTHROPIC_API_KEY=…";
				t.onChange(async (v) => {
					this.plugin.settings.opencodeExtraEnv = v;
					await this.plugin.saveSettings();
				});
				return t;
			});
		new Setting(containerEl)
			.setName("Auto-approve permissions")
			.setDesc("When on, permission requests are accepted automatically (like CLI --auto).")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoApprove).onChange(async (v) => {
					this.plugin.settings.autoApprove = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Base font size of the chat panel (everything scales with it).")
			.addSlider((s) =>
				s
					.setLimits(10, 20, 1)
					.setValue(this.plugin.settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.fontSize = v;
						await this.plugin.saveSettings();
						this.plugin.chatView()?.applyFontSize();
					}),
			);
		new Setting(containerEl)
			.setName("LaTeX math hint")
			.setDesc("Stores a per-session instruction so the model formats math as LaTeX instead of code blocks. Applies when a session is opened.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.latexHint).onChange(async (v) => {
					this.plugin.settings.latexHint = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Auto-attach focused file")
			.setDesc("Automatically attach the focused markdown file as context when the chat starts, like Grimoire.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoAttachActiveFile).onChange(async (v) => {
					this.plugin.settings.autoAttachActiveFile = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Max tabs")
			.addSlider((s) =>
				s.setLimits(1, 20, 1).setValue(this.plugin.settings.maxTabs).onChange(async (v) => {
					this.plugin.settings.maxTabs = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Send only with button")
			.setDesc("Disable Enter-to-send in the composer.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.sendWithButtonOnly).onChange(async (v) => {
					this.plugin.settings.sendWithButtonOnly = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Refresh sessions on open")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.refreshOnOpen).onChange(async (v) => {
					this.plugin.settings.refreshOnOpen = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Reconnect")
			.setDesc("Reconnect to the shared opencode background service.")
			.addButton((b) =>
				b.setButtonText("Reconnect").onClick(async () => {
					this.plugin.client = null;
					const ok = await this.plugin.ensureConnected();
					new Notice(ok ? "OpenCode reconnected" : "OpenCode reconnect failed");
				}),
			);
		new Setting(containerEl)
			.setName("Copy connection diagnostics")
			.setDesc("Copies the last connection attempt (binary, log) for troubleshooting.")
			.addButton((b) =>
				b.setButtonText("Copy").onClick(async () => {
					const attempt = getLastAttempt();
					const text = JSON.stringify(
						{
							endpoint: this.plugin.endpointUrl || null,
							connected: this.plugin.client !== null,
							vaultDir: this.plugin.vaultDir(),
							attempt,
						},
						null,
						2,
					);
					try {
						await navigator.clipboard.writeText(text);
						new Notice("Diagnostics copied to clipboard");
					} catch {
						new Notice("Could not access clipboard");
					}
				}),
			);
	}
}
