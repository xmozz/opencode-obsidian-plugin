interface ElectronWebUtils {
	getPathForFile(file: File): string;
}

function getElectronWebUtils(): ElectronWebUtils | undefined {
	try {
		const electron = require("electron") as { webUtils?: ElectronWebUtils };
		return electron.webUtils;
	} catch {
		return undefined;
	}
}

/** Resolves a selected desktop File to its native path across Electron versions. */
export function getNativeFilePath(
	file: File,
	webUtils: ElectronWebUtils | undefined = getElectronWebUtils(),
): string {
	try {
		const nativePath = webUtils?.getPathForFile(file);
		if (nativePath) return nativePath;
	} catch {
		/* Older Obsidian/Electron builds may not expose webUtils. */
	}
	const legacyPath = (file as File & { path?: unknown }).path;
	return typeof legacyPath === "string" ? legacyPath : "";
}

/** Converts a picked file to a vault-relative reference or keeps its full path. */
export function fileContextReference(
	fileName: string,
	vaultRoot: string,
	nativePath: string,
): string {
	const absolutePath = nativePath.replace(/\\/g, "/");
	const normalizedRoot = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	if (
		absolutePath &&
		normalizedRoot &&
		absolutePath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
	) {
		return absolutePath.slice(normalizedRoot.length + 1);
	}
	return absolutePath || fileName;
}
