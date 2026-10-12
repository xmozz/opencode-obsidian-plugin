import { Modal, Setting } from "obsidian";

/** Theme-consistent confirmation dialog for destructive actions. */
export class ConfirmModal extends Modal {
	constructor(
		app: import("obsidian").App,
		private title: string,
		private message: string,
		private confirmText: string,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.message });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.confirmText)
					.setWarning()
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
