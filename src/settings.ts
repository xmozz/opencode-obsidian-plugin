export interface PluginSettings {
	opencodeBin: string;
	opencodeExtraEnv: string;
	model: string;
	agent: string;
	variant: string;
	/** Permission approval mode: "full" (approve everything), "vault" (auto-approve vault files only), "safe" (always ask). */
	permissionMode: "full" | "safe" | "vault";
	/** When true, file edits are blocked (read-only) in full/vault modes. Safe ignores it. */
	permissionReadOnly: boolean;
	maxTabs: number;
	fontSize: number;
	latexHint: boolean;
	autoAttachActiveFile: boolean;
	notifyOnDone: boolean;
	notifyWithContent: boolean;
	sendWithButtonOnly: boolean;
	refreshOnOpen: boolean;
	/** When true, the "Working" block (reasoning + tool calls) starts expanded. */
	workingExpanded: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	opencodeBin: "opencode",
	opencodeExtraEnv: "",
	model: "",
	agent: "",
	variant: "default",
	permissionMode: "safe",
	permissionReadOnly: false,
	maxTabs: 10,
	fontSize: 13,
	latexHint: true,
	autoAttachActiveFile: true,
	notifyOnDone: false,
	notifyWithContent: true,
	sendWithButtonOnly: false,
	refreshOnOpen: true,
	workingExpanded: false,
};

export function parseEnvText(text: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) env[key] = value;
	}
	return env;
}
