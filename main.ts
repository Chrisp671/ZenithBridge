/***********************************************************************
 * Zenith Bridge for Obsidian – main.ts
 *
 * 1. `npm i ws node-pty @types/ws @types/node --save`
 * 2. Compile with the normal Obsidian plugin build pipeline
 **********************************************************************/
import { Plugin, Notice, addIcon } from "obsidian";
import { McpDualServer } from "./src/mcp/dual-server";
import { WorkspaceManager } from "./src/obsidian/workspace-manager";
import {
	ClaudeCodeSettings,
	ClaudeCodeSettingTab,
	migrateClaudeCodeSettings,
} from "./src/settings";
import claudeLogo from "./assets/claude-logo.png";
import { TerminalManager } from "./src/terminal/terminal-manager";
import {
	TerminalProfile,
	getTerminalProfileById,
	getTerminalProfiles,
} from "./src/terminal/profiles";

export default class ClaudeMcpPlugin extends Plugin {
	public mcpServer!: McpDualServer;
	private workspaceManager!: WorkspaceManager;
	public settings!: ClaudeCodeSettings;
	private terminalRibbonIcon: HTMLElement | null = null;
	private terminalManager: TerminalManager | null = null;

	/* ---------------- core lifecycle ---------------- */

	async onload() {
		// Load settings
		await this.loadSettings();

		// Register custom Claude icon
		addIcon(
			"claude-logo",
			`<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
				<image href="${claudeLogo}" width="16" height="16" />
			</svg>`
		);

		// Conditionally initialize terminal features (lazy-loaded to save resources)
		if (this.settings.enableEmbeddedTerminal) {
			await this.initializeTerminalFeatures();
		}

		// Add settings tab
		this.addSettingTab(new ClaudeCodeSettingTab(this.app, this));

		// Initialize workspace manager first
		this.workspaceManager = new WorkspaceManager(this.app, this, {
			onSelectionChange: (notification) => {
				this.mcpServer?.broadcast(notification);
			},
		});

		// Initialize dual server (WebSocket + HTTP/SSE)
		await this.initializeMcpServer();

		this.workspaceManager.setupListeners();
	}

	onunload() {
		this.terminalManager?.closeAllTerminalLeaves();
		this.mcpServer?.stop();
		this.removeTerminalRibbonIcon();
	}

	async initializeMcpServer(): Promise<void> {
		try {
			// Initialize dual server (WebSocket + HTTP/SSE)
			this.mcpServer = new McpDualServer({
				app: this.app,
				workspaceManager: this.workspaceManager,
				wsPort: undefined, // Use random port for WebSocket
				httpPort: this.settings.mcpHttpPort,
				enableWebSocket: this.settings.enableWebSocketServer,
				enableHttp: this.settings.enableHttpServer,
			});

			// Start services
			const serverInfo = await this.mcpServer.start();
			console.debug(`[MCP] Dual server started:`, serverInfo);

			// Update lock file with workspace path
			const basePath =
				(this.app.vault.adapter as any).getBasePath?.() ||
				process.cwd();
			console.debug(`[MCP] Vault base path: ${basePath}`);
			this.mcpServer.updateWorkspaceFolders(basePath);
			
			// Validate tool registration
			this.mcpServer.validateToolRegistration();

			// Show success notification
			const wsStatus = serverInfo.wsPort
				? `WebSocket: ${serverInfo.wsPort}`
				: "WebSocket: disabled";
			const httpStatus = serverInfo.httpPort
				? `HTTP: ${serverInfo.httpPort}`
				: "HTTP: disabled";
			new Notice(`Zenith Bridge running - ${wsStatus}, ${httpStatus}`);
		} catch (error) {
			console.error("[MCP] Failed to start server:", error);

			// Handle specific error types
			if (
				error.message?.includes("EADDRINUSE") ||
				error.name === "PortInUseError"
			) {
				// Enhanced message for port conflicts, especially multiple vaults
				new Notice(
					`Port ${this.settings.mcpHttpPort} is already in use. This might be because:\n` +
						`• Another Obsidian vault is running this plugin\n` +
						`• Another application is using this port\n\n` +
						`Please configure a different port in Settings → Community Plugins → Zenith Bridge.`,
					10000
				);
			} else if (
				error.message?.includes("EACCES") ||
				error.name === "PermissionError"
			) {
				new Notice(
					`Permission denied for port ${this.settings.mcpHttpPort}. ` +
						`Try using a port above 1024 in Settings → Community Plugins → Zenith Bridge.`,
					8000
				);
			} else {
				new Notice(
					`Failed to start MCP server: ${error.message}`,
					8000
				);
			}
		}
	}

	async restartMcpServer(): Promise<void> {
		try {
			// Stop existing server
			if (this.mcpServer) {
				console.debug("[MCP] Stopping server for restart...");
				this.mcpServer.stop();
			}

			// Small delay to ensure clean shutdown
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Restart server with new settings
			await this.initializeMcpServer();
		} catch (error) {
			console.error("[MCP] Failed to restart server:", error);

			// Handle specific error types
			if (
				error.message?.includes("EADDRINUSE") ||
				error.name === "PortInUseError"
			) {
				new Notice(
					`Port ${this.settings.mcpHttpPort} is already in use. This might be because:\n` +
						`• Another Obsidian vault is running this plugin\n` +
						`• Another application is using this port\n\n` +
						`Please configure a different port in Settings → Community Plugins → Zenith Bridge.`,
					10000
				);
			} else if (
				error.message?.includes("EACCES") ||
				error.name === "PermissionError"
			) {
				new Notice(
					`Permission denied for port ${this.settings.mcpHttpPort}. ` +
						`Try using a port above 1024 in Settings → Community Plugins → Zenith Bridge.`,
					8000
				);
			} else {
				new Notice(
					`Failed to restart MCP server: ${error.message}`,
					8000
				);
			}
		}
	}

	/* ---------------- terminal management ---------------- */

	public addTerminalRibbonIcon(): void {
		if (!this.terminalRibbonIcon) {
			this.terminalRibbonIcon = this.addRibbonIcon(
				"claude-logo",
				"Open or Focus Default Terminal",
				() => {
					void this.focusOrCreateTerminal();
				}
			);
		}
	}

	public removeTerminalRibbonIcon(): void {
		if (this.terminalRibbonIcon) {
			this.terminalRibbonIcon.remove();
			this.terminalRibbonIcon = null;
		}
	}

	private async initializeTerminalFeatures(): Promise<void> {
		try {
			this.terminalManager = new TerminalManager(this);

			// Dynamic import to avoid loading terminal code when not needed
			const { ClaudeTerminalView, TERMINAL_VIEW_TYPE } = await import(
				"./src/terminal/terminal-view"
			);

			// Register terminal view
			this.registerView(
				TERMINAL_VIEW_TYPE,
				(leaf) => new ClaudeTerminalView(leaf, this)
			);

			// Add ribbon button for terminal toggle
			this.addTerminalRibbonIcon();

			// Register commands
			this.addCommand({
				id: "toggle-claude-terminal",
				name: "Open or Focus Default Terminal",
				callback: () => void this.focusOrCreateTerminal(),
				hotkeys: [{ modifiers: ["Ctrl"], key: "`" }],
			});

			this.addCommand({
				id: "new-default-agent-terminal",
				name: "New Default Agent Terminal",
				callback: () => void this.openDefaultTerminal(),
			});

			this.addCommand({
				id: "new-agent-terminal",
				name: "New Agent Terminal...",
				callback: () => this.openTerminalPicker(),
			});
		} catch (error) {
			console.error(
				"[Terminal] Failed to initialize terminal features:",
				error
			);
			new Notice("Failed to initialize terminal features");
		}
	}

	public async focusOrCreateTerminal(): Promise<void> {
		if (!this.ensureEmbeddedTerminalEnabled()) {
			return;
		}

		try {
			await this.terminalManager?.focusOrCreateTerminal();
		} catch (error) {
			console.error("[Terminal] Failed to focus or create terminal:", error);
			new Notice("Failed to open the default terminal");
		}
	}

	public async openDefaultTerminal(): Promise<void> {
		if (!this.ensureEmbeddedTerminalEnabled()) {
			return;
		}

		try {
			await this.terminalManager?.openDefaultTerminal();
		} catch (error) {
			console.error("[Terminal] Failed to open default terminal:", error);
			new Notice("Failed to open the default terminal");
		}
	}

	public openTerminalPicker(): void {
		if (!this.ensureEmbeddedTerminalEnabled()) {
			return;
		}

		this.terminalManager?.openTerminalPicker();
	}

	public getTerminalProfiles(): TerminalProfile[] {
		return getTerminalProfiles(this.settings.terminalProfiles);
	}

	public getTerminalProfileById(profileId: string): TerminalProfile | undefined {
		return getTerminalProfileById(this.settings.terminalProfiles, profileId);
	}

	public getTerminalManager(): TerminalManager | null {
		return this.terminalManager;
	}

	private ensureEmbeddedTerminalEnabled(): boolean {
		if (!this.settings.enableEmbeddedTerminal) {
			new Notice(
				"Embedded terminal is disabled. Enable it in settings to use this feature."
			);
			return false;
		}

		if (!this.terminalManager) {
			new Notice("Terminal features are not initialized.");
			return false;
		}

		return true;
	}

	async loadSettings() {
		this.settings = migrateClaudeCodeSettings(await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
