import { FuzzySuggestModal, TFile, type App } from "obsidian";

/** Vault file picker for attaching context files to the active tab. */
export class FileAttachModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (path: string) => void) {
		super(app);
		this.setPlaceholder("Attach vault file…");
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: "attach" },
			{ command: "esc", purpose: "dismiss" },
		]);
	}

	getItems(): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onPick(item.path);
	}
}
