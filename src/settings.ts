import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import ClaudeMcpPlugin from "../main";
import { getClaudeConfigDir } from "./claude-config";
import {
	BUILTIN_CLAUDE_PROFILE_ID,
	BUILTIN_TERMINAL_PROFILES,
	TerminalProfile,
	cloneTerminalProfile,
	createCustomProfileId,
	getTerminalProfileById,
	getTerminalProfiles,
	parseEnvLines,
	sanitizeCustomTerminalProfiles,
	stringifyEnv,
} from "./terminal/profiles";

export interface ClaudeCodeSettings {
	autoCloseTerminalOnShellExit: boolean;
	mcpHttpPort: number;
	enableWebSocketServer: boolean;
	enableHttpServer: boolean;
	enableEmbeddedTerminal: boolean;
	maxTerminalSessions: number;
	defaultTerminalProfileId: string;
	terminalProfiles: TerminalProfile[];
}

export const DEFAULT_SETTINGS: ClaudeCodeSettings = {
	autoCloseTerminalOnShellExit: true,
	mcpHttpPort: 22360,
	enableWebSocketServer: true,
	enableHttpServer: true,
	enableEmbeddedTerminal: true,
	maxTerminalSessions: 4,
	defaultTerminalProfileId: BUILTIN_CLAUDE_PROFILE_ID,
	terminalProfiles: [],
};

export function migrateClaudeCodeSettings(rawData: unknown): ClaudeCodeSettings {
	const raw =
		rawData && typeof rawData === "object"
			? (rawData as Record<string, unknown>)
			: {};

	const customProfiles = sanitizeCustomTerminalProfiles(raw.terminalProfiles);
	let defaultTerminalProfileId =
		typeof raw.defaultTerminalProfileId === "string" &&
		raw.defaultTerminalProfileId.trim()
			? raw.defaultTerminalProfileId.trim()
			: DEFAULT_SETTINGS.defaultTerminalProfileId;

	// Migrate the legacy single startup command into one custom profile.
	if (!Array.isArray(raw.terminalProfiles)) {
		const legacyStartupCommand =
			typeof raw.startupCommand === "string" ? raw.startupCommand.trim() : "";
		if (legacyStartupCommand && legacyStartupCommand !== "claude") {
			const migratedProfileId = createCustomProfileId();
			const migratedProfile: TerminalProfile = {
				id: migratedProfileId,
				name: "Migrated profile",
				launchCommand: legacyStartupCommand,
				env: {},
				envStrategy: "none",
				builtin: false,
			};
			customProfiles.push(migratedProfile);
			defaultTerminalProfileId = migratedProfileId;
		}
	}

	if (
		!getTerminalProfileById(customProfiles, defaultTerminalProfileId) &&
		defaultTerminalProfileId !== BUILTIN_CLAUDE_PROFILE_ID
	) {
		defaultTerminalProfileId = BUILTIN_CLAUDE_PROFILE_ID;
	}

	return {
		autoCloseTerminalOnShellExit:
			typeof raw.autoCloseTerminalOnShellExit === "boolean"
				? raw.autoCloseTerminalOnShellExit
				: typeof raw.autoCloseTerminalOnClaudeExit === "boolean"
					? raw.autoCloseTerminalOnClaudeExit
					: DEFAULT_SETTINGS.autoCloseTerminalOnShellExit,
		mcpHttpPort:
			typeof raw.mcpHttpPort === "number" &&
			raw.mcpHttpPort >= 1024 &&
			raw.mcpHttpPort <= 65535
				? raw.mcpHttpPort
				: DEFAULT_SETTINGS.mcpHttpPort,
		enableWebSocketServer:
			typeof raw.enableWebSocketServer === "boolean"
				? raw.enableWebSocketServer
				: DEFAULT_SETTINGS.enableWebSocketServer,
		enableHttpServer:
			typeof raw.enableHttpServer === "boolean"
				? raw.enableHttpServer
				: DEFAULT_SETTINGS.enableHttpServer,
		enableEmbeddedTerminal:
			typeof raw.enableEmbeddedTerminal === "boolean"
				? raw.enableEmbeddedTerminal
				: DEFAULT_SETTINGS.enableEmbeddedTerminal,
		maxTerminalSessions:
			typeof raw.maxTerminalSessions === "number"
				? clampSessionLimit(raw.maxTerminalSessions)
				: DEFAULT_SETTINGS.maxTerminalSessions,
		defaultTerminalProfileId,
		terminalProfiles: customProfiles,
	};
}

export class ClaudeCodeSettingTab extends PluginSettingTab {
	plugin: ClaudeMcpPlugin;

	constructor(app: App, plugin: ClaudeMcpPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		new Setting(containerEl).setName("Claude Code settings").setHeading();

		this.displayServerStatus(containerEl);
		this.displayServerSettings(containerEl);
		this.displayTerminalSettings(containerEl);
	}

	private displayServerSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("MCP server configuration").setHeading();

		new Setting(containerEl)
			.setName("Enable WebSocket server")
			.setDesc(
				"Enable WebSocket server for Claude Code IDE integration. This allows auto-discovery via lock files."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableWebSocketServer)
					.onChange(async (value) => {
						this.plugin.settings.enableWebSocketServer = value;
						await this.plugin.saveSettings();
						await this.plugin.restartMcpServer();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Enable HTTP/SSE server")
			.setDesc(
				"Enable HTTP/SSE server for Claude Desktop and other MCP clients. Required for manual MCP client configuration."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableHttpServer)
					.onChange(async (value) => {
						this.plugin.settings.enableHttpServer = value;
						await this.plugin.saveSettings();
						await this.plugin.restartMcpServer();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("HTTP server port")
			.setDesc(
				"Port for the HTTP/SSE MCP server. Default is 22360. Changes apply when you leave this field."
			)
			.addText((text) => {
				text
					.setPlaceholder("22360")
					.setValue(this.plugin.settings.mcpHttpPort.toString())
					.onChange(async (value) => {
						const port = parseInt(value, 10);
						if (Number.isNaN(port) || port < 1024 || port > 65535) {
							return;
						}

						this.plugin.settings.mcpHttpPort = port;
						await this.plugin.saveSettings();
					});

				text.inputEl.addEventListener("blur", async () => {
					const port = parseInt(text.getValue(), 10);
					if (Number.isNaN(port) || port < 1024 || port > 65535) {
						text.setValue(this.plugin.settings.mcpHttpPort.toString());
						return;
					}

					if (this.plugin.settings.enableHttpServer) {
						await this.plugin.restartMcpServer();
						this.display();
					}
				});
			});
	}

	private displayTerminalSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Terminal configuration").setHeading();

		new Setting(containerEl)
			.setName("Enable embedded terminal")
			.setDesc(
				"Enable the built-in terminal feature within Obsidian. Requires plugin reload to fully apply."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableEmbeddedTerminal)
					.onChange(async (value) => {
						this.plugin.settings.enableEmbeddedTerminal = value;
						await this.plugin.saveSettings();

						if (value) {
							this.plugin.addTerminalRibbonIcon();
						} else {
							this.plugin.removeTerminalRibbonIcon();
						}

						new Notice(
							"Terminal setting changed. Reload the plugin for full changes to take effect.",
							5000
						);
					})
			);

		if (!this.plugin.settings.enableEmbeddedTerminal) {
			return;
		}

		new Setting(containerEl)
			.setName("Auto-close terminal on shell exit")
			.setDesc(
				"Close the terminal leaf when its shell process exits. Disable this to leave the pane open and show the exit message."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoCloseTerminalOnShellExit)
					.onChange(async (value) => {
						this.plugin.settings.autoCloseTerminalOnShellExit = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max terminal sessions")
			.setDesc("Maximum number of concurrent terminal sessions.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 12, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.maxTerminalSessions)
					.onChange(async (value) => {
						this.plugin.settings.maxTerminalSessions = clampSessionLimit(
							value
						);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default terminal profile")
			.setDesc(
				"Used by the ribbon button and the default terminal command."
			)
			.addDropdown((dropdown) => {
				for (const profile of this.getAllProfiles()) {
					const suffix = profile.builtin ? " (built-in)" : "";
					dropdown.addOption(profile.id, `${profile.name}${suffix}`);
				}

				dropdown
					.setValue(this.getResolvedDefaultProfileId())
					.onChange(async (value) => {
						this.plugin.settings.defaultTerminalProfileId = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("Built-in profiles").setHeading();
		for (const profile of BUILTIN_TERMINAL_PROFILES) {
			const builtInCard = containerEl.createDiv({
				cls: "terminal-profile-card",
			});
			new Setting(builtInCard)
				.setName(profile.name)
				.setDesc(profile.launchCommand || "Shell only")
				.addButton((button) =>
					button
						.setButtonText("Duplicate")
						.setCta()
						.onClick(async () => {
							await this.duplicateBuiltInProfile(profile);
						})
				);
		}

		new Setting(containerEl).setName("Custom profiles").setHeading();
		const customProfiles = this.plugin.settings.terminalProfiles;
		if (customProfiles.length === 0) {
			containerEl.createEl("p", {
				text: "No custom profiles yet. Duplicate the Claude preset or add one below.",
				cls: "terminal-profile-empty",
			});
		}

		for (const profile of customProfiles) {
			this.renderCustomProfileEditor(containerEl, profile);
		}

		new Setting(containerEl)
			.setName("Add custom profile")
			.setDesc("Create a new profile for another terminal command.")
			.addButton((button) =>
				button.setButtonText("Add profile").onClick(async () => {
					const customProfile: TerminalProfile = {
						id: createCustomProfileId(),
						name: this.getNextCustomProfileName(),
						launchCommand: "",
						env: {},
						envStrategy: "none",
						builtin: false,
					};
					this.plugin.settings.terminalProfiles = [
						...this.plugin.settings.terminalProfiles,
						customProfile,
					];
					await this.plugin.saveSettings();
					this.display();
				})
			);
	}

	private renderCustomProfileEditor(
		containerEl: HTMLElement,
		profile: TerminalProfile
	): void {
		const profileCard = containerEl.createDiv({
			cls: "terminal-profile-card",
		});

		new Setting(profileCard)
			.setName(profile.name)
			.setDesc(profile.launchCommand || "Shell only")
			.addExtraButton((button) =>
				button
					.setIcon("trash")
					.setTooltip("Delete profile")
					.onClick(async () => {
						this.plugin.settings.terminalProfiles =
							this.plugin.settings.terminalProfiles.filter(
								(candidate) => candidate.id !== profile.id
							);

						if (
							this.plugin.settings.defaultTerminalProfileId === profile.id
						) {
							this.plugin.settings.defaultTerminalProfileId =
								BUILTIN_CLAUDE_PROFILE_ID;
						}

						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(profileCard)
			.setName("Name")
			.addText((text) =>
				text.setValue(profile.name).onChange(async (value) => {
					await this.updateCustomProfile(profile.id, {
						name: value.trim() || "Custom profile",
					});
				})
			);

		new Setting(profileCard)
			.setName("Launch command")
			.setDesc("Raw shell command to run after the shell opens.")
			.addText((text) =>
				text.setPlaceholder("kimi").setValue(profile.launchCommand).onChange(
					async (value) => {
						await this.updateCustomProfile(profile.id, {
							launchCommand: value,
						});
					}
				)
			);

		new Setting(profileCard)
			.setName("Environment")
			.setDesc("One KEY=VALUE entry per line.")
			.addTextArea((textArea) =>
				textArea
					.setPlaceholder("OPENAI_API_KEY=...\nKIMI_API_KEY=...")
					.setValue(stringifyEnv(profile.env))
					.onChange(async (value) => {
						await this.updateCustomProfile(profile.id, {
							env: parseEnvLines(value),
						});
					})
			);
	}

	private async duplicateBuiltInProfile(profile: TerminalProfile): Promise<void> {
		const duplicate = cloneTerminalProfile(profile, {
			id: createCustomProfileId(),
			name: this.getUniqueProfileName(`${profile.name} Copy`),
			builtin: false,
		});

		this.plugin.settings.terminalProfiles = [
			...this.plugin.settings.terminalProfiles,
			duplicate,
		];
		await this.plugin.saveSettings();
		this.display();
	}

	private async updateCustomProfile(
		profileId: string,
		changes: Partial<TerminalProfile>
	): Promise<void> {
		this.plugin.settings.terminalProfiles =
			this.plugin.settings.terminalProfiles.map((profile) => {
				if (profile.id !== profileId) {
					return profile;
				}

				return {
					...profile,
					...changes,
					env:
						changes.env !== undefined ? changes.env : { ...profile.env },
					envStrategy:
						changes.envStrategy !== undefined
							? changes.envStrategy
							: profile.envStrategy || "none",
					builtin: false,
				};
			});
		await this.plugin.saveSettings();
	}

	private getAllProfiles(): TerminalProfile[] {
		return getTerminalProfiles(this.plugin.settings.terminalProfiles);
	}

	private getResolvedDefaultProfileId(): string {
		return (
			this.getAllProfiles().find(
				(profile) =>
					profile.id === this.plugin.settings.defaultTerminalProfileId
			)?.id || BUILTIN_CLAUDE_PROFILE_ID
		);
	}

	private getNextCustomProfileName(): string {
		return this.getUniqueProfileName("Custom profile");
	}

	private getUniqueProfileName(baseName: string): string {
		const existingNames = new Set(
			this.getAllProfiles().map((profile) => profile.name.toLowerCase())
		);
		if (!existingNames.has(baseName.toLowerCase())) {
			return baseName;
		}

		let nextIndex = 2;
		while (existingNames.has(`${baseName} ${nextIndex}`.toLowerCase())) {
			nextIndex += 1;
		}

		return `${baseName} ${nextIndex}`;
	}

	private displayServerStatus(containerEl: HTMLElement): void {
		const statusSection = containerEl.createEl("div", {
			cls: "mcp-server-status",
		});
		new Setting(statusSection).setName("MCP server status").setHeading();

		const serverInfo = this.plugin.mcpServer?.getServerInfo() || {};

		const wsContainer = statusSection.createEl("div", {
			cls: "server-status-item",
		});
		new Setting(wsContainer).setName("WebSocket server (Claude Code)").setHeading();

		const wsStatus = wsContainer.createEl("div", { cls: "status-line" });
		if (this.plugin.settings.enableWebSocketServer && serverInfo.wsPort) {
			wsStatus.createEl("span", { cls: "status-indicator status-running", text: "\u25CF" });
			wsStatus.createEl("span", { cls: "status-text", text: `Running on port ${serverInfo.wsPort}` });
			wsStatus.createEl("span", { cls: "status-clients", text: `(${serverInfo.wsClients || 0} clients)` });

			const wsDetails = wsContainer.createEl("div", {
				cls: "status-details",
			});
			const configDir = getClaudeConfigDir();
			const detail1 = wsDetails.createEl("div");
			detail1.setText("\u2022 Auto-discovery enabled via lock files");
			const detail2 = wsDetails.createEl("div");
			detail2.appendText("\u2022 Lock file: ");
			detail2.createEl("code", { text: `${configDir}/ide/${serverInfo.wsPort}.lock` });
			const detail3 = wsDetails.createEl("div");
			detail3.appendText("\u2022 Use ");
			detail3.createEl("code", { text: "claude" });
			detail3.appendText(" CLI and select \"Obsidian\" from ");
			detail3.createEl("code", { text: "/ide" });
			detail3.appendText(" list");
		} else if (!this.plugin.settings.enableWebSocketServer) {
			wsStatus.createEl("span", { cls: "status-indicator status-disabled", text: "\u25CF" });
			wsStatus.createEl("span", { cls: "status-text", text: "Disabled" });
		} else {
			wsStatus.createEl("span", { cls: "status-indicator status-error", text: "\u25CF" });
			wsStatus.createEl("span", { cls: "status-text", text: "Failed to start" });
		}

		const httpContainer = statusSection.createEl("div", {
			cls: "server-status-item",
		});
		new Setting(httpContainer).setName("MCP server (HTTP/SSE transport)").setHeading();

		const httpStatus = httpContainer.createEl("div", {
			cls: "status-line",
		});
		if (this.plugin.settings.enableHttpServer && serverInfo.httpPort) {
			httpStatus.createEl("span", { cls: "status-indicator status-running", text: "\u25CF" });
			httpStatus.createEl("span", { cls: "status-text", text: `Running on port ${serverInfo.httpPort}` });
			httpStatus.createEl("span", { cls: "status-clients", text: `(${serverInfo.httpClients || 0} clients)` });

			const httpDetails = httpContainer.createEl("div", {
				cls: "status-details",
			});
			const httpDetail1 = httpDetails.createEl("div");
			httpDetail1.appendText("\u2022 SSE Stream: ");
			httpDetail1.createEl("code", { text: `http://localhost:${serverInfo.httpPort}/sse` });
			const httpDetail2 = httpDetails.createEl("div");
			httpDetail2.appendText("\u2022 Add to Claude Desktop config: ");
			httpDetail2.createEl("code", { text: `"url": "http://localhost:${serverInfo.httpPort}/sse"` });
		} else if (!this.plugin.settings.enableHttpServer) {
			httpStatus.createEl("span", { cls: "status-indicator status-disabled", text: "\u25CF" });
			httpStatus.createEl("span", { cls: "status-text", text: "Disabled" });
		} else {
			httpStatus.createEl("span", { cls: "status-indicator status-error", text: "\u25CF" });
			httpStatus.createEl("span", { cls: "status-text", text: "Failed to start" });
		}

		const refreshContainer = statusSection.createEl("div", {
			cls: "status-refresh",
		});
		const refreshButton = refreshContainer.createEl("button", {
			text: "Refresh status",
			cls: "mod-cta",
		});
		refreshButton.addEventListener("click", () => {
			this.display();
		});
	}
}

function clampSessionLimit(value: number): number {
	return Math.max(1, Math.min(Math.round(value), 12));
}
