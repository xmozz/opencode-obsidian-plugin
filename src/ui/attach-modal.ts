import { FuzzySuggestModal, TFile, type App } from "obsidian";

/** Vault file extensions the agent can take as context (notes and PDFs). */
export const ATTACHABLE_EXTENSIONS = ["md", "pdf"] as const;

/** True when a vault path can be attached as context (note or PDF). */
export function isAttachablePath(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return (ATTACHABLE_EXTENSIONS as readonly string[]).includes(ext);
}

/** Vault file picker for attaching context files to the active tab. */
export class FileAttachModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (path: string) => void) {
		super(app);
		this.setPlaceholder("Attach vault file (note or PDF)…");
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: "attach" },
			{ command: "esc", purpose: "dismiss" },
		]);
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) => isAttachablePath(f.path))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onPick(item.path);
	}
}
