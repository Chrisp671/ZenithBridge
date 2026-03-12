export interface TerminalProfile {
	id: string;
	name: string;
	launchCommand: string;
	env: Record<string, string>;
	envStrategy?: "claude-code" | "none";
	icon?: string;
	builtin?: boolean;
}

export interface TerminalSessionState extends Record<string, unknown> {
	sessionId: string;
	profileId: string;
	displayName: string;
	ordinal: number;
}

export const BUILTIN_CLAUDE_PROFILE_ID = "claude";

export const BUILTIN_TERMINAL_PROFILES: TerminalProfile[] = [
	{
		id: BUILTIN_CLAUDE_PROFILE_ID,
		name: "Claude",
		launchCommand: "claude",
		env: {},
		envStrategy: "claude-code",
		icon: "claude-logo",
		builtin: true,
	},
];

export function cloneTerminalProfile(
	profile: TerminalProfile,
	overrides: Partial<TerminalProfile> = {}
): TerminalProfile {
	return {
		...profile,
		env: { ...profile.env },
		...overrides,
	};
}

export function getTerminalProfiles(
	customProfiles: TerminalProfile[]
): TerminalProfile[] {
	return [
		...BUILTIN_TERMINAL_PROFILES.map((profile) =>
			cloneTerminalProfile(profile)
		),
		...sanitizeCustomTerminalProfiles(customProfiles),
	];
}

export function getTerminalProfileById(
	customProfiles: TerminalProfile[],
	profileId: string
): TerminalProfile | undefined {
	return getTerminalProfiles(customProfiles).find(
		(profile) => profile.id === profileId
	);
}

export function sanitizeCustomTerminalProfiles(
	profiles: unknown
): TerminalProfile[] {
	if (!Array.isArray(profiles)) {
		return [];
	}

	const seenIds = new Set<string>();
	const sanitized: TerminalProfile[] = [];

	for (const rawProfile of profiles) {
		if (!rawProfile || typeof rawProfile !== "object") {
			continue;
		}

		const candidate = rawProfile as Partial<TerminalProfile>;
		const id = String(candidate.id || "").trim();
		const name = String(candidate.name || "").trim();

		if (!id || !name || seenIds.has(id) || isBuiltinProfileId(id)) {
			continue;
		}

		seenIds.add(id);
		sanitized.push({
			id,
			name,
			launchCommand: String(candidate.launchCommand || "").trim(),
			env: sanitizeProfileEnv(candidate.env),
			envStrategy:
				candidate.envStrategy === "claude-code" ? "claude-code" : "none",
			icon:
				typeof candidate.icon === "string" && candidate.icon.trim()
					? candidate.icon.trim()
					: undefined,
			builtin: false,
		});
	}

	return sanitized;
}

export function parseEnvLines(envText: string): Record<string, string> {
	const env: Record<string, string> = {};

	for (const rawLine of envText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}

		const separatorIndex = line.indexOf("=");
		if (separatorIndex <= 0) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		const value = line.slice(separatorIndex + 1).trim();
		if (key) {
			env[key] = value;
		}
	}

	return env;
}

export function stringifyEnv(env: Record<string, string>): string {
	return Object.entries(sanitizeProfileEnv(env))
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

export function sanitizeProfileEnv(env: unknown): Record<string, string> {
	if (!env || typeof env !== "object" || Array.isArray(env)) {
		return {};
	}

	const sanitized: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		const trimmedKey = String(key).trim();
		if (!trimmedKey) {
			continue;
		}

		sanitized[trimmedKey] = String(value ?? "");
	}

	return sanitized;
}

export function createCustomProfileId(): string {
	return `profile-${Date.now().toString(36)}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
}

export function isBuiltinProfileId(profileId: string): boolean {
	return BUILTIN_TERMINAL_PROFILES.some((profile) => profile.id === profileId);
}
