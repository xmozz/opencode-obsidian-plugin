export interface PluginSettings {
	opencodeBin: string;
	opencodeExtraEnv: string;
	model: string;
	agent: string;
	variant: string;
	autoApprove: boolean;
	maxTabs: number;
	fontSize: number;
	latexHint: boolean;
	sendWithButtonOnly: boolean;
	refreshOnOpen: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	opencodeBin: "opencode",
	opencodeExtraEnv: "",
	model: "",
	agent: "",
	variant: "default",
	autoApprove: false,
	maxTabs: 10,
	fontSize: 13,
	latexHint: true,
	sendWithButtonOnly: false,
	refreshOnOpen: true,
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
