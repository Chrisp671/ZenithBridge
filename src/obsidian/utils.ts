import { DataAdapter } from "obsidian";

export function getVaultBasePath(adapter: DataAdapter): string {
	return (adapter as unknown as { getBasePath?: () => string }).getBasePath?.() || process.cwd();
}

export function normalizePath(path: string): string | null {
	// Remove leading slash if present (vault-relative paths)
	const cleaned = path.startsWith("/") ? path.slice(1) : path;

	// Basic validation - no directory traversal
	if (cleaned.includes("..") || cleaned.includes("~")) {
		return null;
	}

	return cleaned;
}

export function getAbsolutePath(relativePath: string, basePath: string): string {
	return `${basePath}/${relativePath}`;
}