import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";

export interface ModelChoice {
	value: string;
	name: string;
	detail: string;
}

/** Searchable model picker (native selects size to the longest option). */
export class ModelPickerModal extends FuzzySuggestModal<ModelChoice> {
	constructor(
		app: App,
		private choices: ModelChoice[],
		private onPick: (value: string) => void,
	) {
		super(app);
		this.setPlaceholder("Select model…");
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: "select" },
			{ command: "esc", purpose: "dismiss" },
		]);
	}

	getItems(): ModelChoice[] {
		return this.choices;
	}

	getItemText(item: ModelChoice): string {
		return `${item.name} ${item.value} ${item.detail}`;
	}

	renderSuggestion(match: FuzzyMatch<ModelChoice>, el: HTMLElement): void {
		const item = match.item;
		const main = el.createDiv({ cls: "ocs-pick-name", text: item.name });
		if (item.name !== item.value) {
			main.createSpan({ cls: "ocs-pick-id", text: ` ${item.value}` });
		}
		if (item.detail) {
			el.createDiv({ cls: "ocs-pick-hint", text: item.detail });
		}
	}

	onChooseItem(item: ModelChoice): void {
		this.onPick(item.value);
	}
}
