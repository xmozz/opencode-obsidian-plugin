import { Modal, Setting } from "obsidian";

export class InputModal extends Modal {
	private initial: string;
	private onSubmit: (value: string) => void;
	private inputEl!: HTMLInputElement;

	constructor(
		app: import("obsidian").App,
		private heading: string,
		initial: string,
		onSubmit: (value: string) => void,
	) {
		super(app);
		this.initial = initial;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.heading });
		new Setting(contentEl).setName("Value").addText((t) => {
			t.setValue(this.initial);
			t.inputEl.focus();
			t.inputEl.select();
			this.inputEl = t.inputEl;
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this.submit();
				}
			});
		});
		new Setting(contentEl).addButton((b) =>
			b.setButtonText("OK").setCta().onClick(() => this.submit()),
		);
	}

	private submit(): void {
		const v = this.inputEl?.value.trim() ?? "";
		this.close();
		if (v) this.onSubmit(v);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
