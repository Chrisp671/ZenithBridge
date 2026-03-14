import {
	App,
	ItemView,
	Notice,
	ViewStateResult,
	WorkspaceLeaf,
} from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
	ChildProcessPseudoterminal,
	Pseudoterminal,
	UnixPseudoterminal,
	WindowsPseudoterminal,
} from "./pseudoterminal";
import { PythonManager } from "./python-detection";
import type ClaudeMcpPlugin from "main";
import { getVaultBasePath } from "../obsidian/utils";
import {
	BUILTIN_CLAUDE_PROFILE_ID,
	TerminalProfile,
	TerminalSessionState,
} from "./profiles";

export const TERMINAL_VIEW_TYPE = "claude-terminal-view";

export class ClaudeTerminalView extends ItemView {
	private terminal: Terminal;
	private fitAddon: FitAddon;
	private pseudoterminal: Pseudoterminal | null = null;
	private pythonManager = new PythonManager();
	private isDestroyed = false;
	private sessionState: TerminalSessionState = {
		sessionId: "pending-session",
		profileId: BUILTIN_CLAUDE_PROFILE_ID,
		displayName: "Claude 1",
		ordinal: 1,
	};
	public app: App;
	private plugin: ClaudeMcpPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: ClaudeMcpPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.app = this.leaf.view.app;
		this.terminal = new Terminal({
			cursorBlink: true,
			fontSize: 14,
			fontFamily: "Monaco, Menlo, 'Ubuntu Mono', monospace",
		});
		this.fitAddon = new FitAddon();
		this.terminal.loadAddon(this.fitAddon);
	}

	getViewType(): string {
		return TERMINAL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.sessionState.displayName;
	}

	getIcon(): string {
		return this.getResolvedProfile()?.icon || "terminal";
	}

	getState(): Record<string, unknown> {
		return { ...this.sessionState };
	}

	async setState(state: unknown, _result: ViewStateResult): Promise<void> {
		const previousSessionId = this.sessionState.sessionId;
		this.sessionState = this.normalizeSessionState(state);

		const terminalManager = this.plugin.getTerminalManager();
		if (previousSessionId && previousSessionId !== this.sessionState.sessionId) {
			terminalManager?.unregisterSession(previousSessionId);
		}

		terminalManager?.registerSessionLeaf(this.sessionState, this.leaf);
	}

	async onOpen(): Promise<void> {
		console.debug("[Terminal] Opening terminal view", this.sessionState);

		const container = this.containerEl.children[1];
		container.empty();

		const terminalEl = container.createDiv({
			cls: "claude-terminal-container",
		});
		terminalEl.addClass("claude-terminal-inner");

		this.terminal.open(terminalEl);
		this.plugin
			.getTerminalManager()
			?.registerSessionLeaf(this.sessionState, this.leaf);
		this.plugin.getTerminalManager()?.markSessionActive(this.sessionState.sessionId);

		await this.pythonManager.initialize();
		await this.startShell();

		this.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
			if (event.type !== "keydown") {
				return true;
			}

			if (
				event.key === "Enter" &&
				event.shiftKey &&
				!event.altKey &&
				!event.ctrlKey &&
				!event.metaKey
			) {
				if (this.pseudoterminal?.shell) {
					event.preventDefault();

					this.pseudoterminal.shell
						.then((shell) => {
							if (shell?.stdin?.writable) {
								shell.stdin.write("\n");
							}
						})
						.catch((error) => {
							console.error(
								"[Terminal] Failed to write newline to PTY stdin:",
								error
							);
						});

					return false;
				}
			}

			return true;
		});

		this.terminal.onResize(({ cols, rows }) => {
			if (this.pseudoterminal?.resize) {
				this.pseudoterminal.resize(cols, rows).catch((error: unknown) => {
					console.warn("[Terminal] Resize failed:", error);
				});
			}
		});

		window.setTimeout(() => {
			this.fitAddon.fit();
			this.focusTerminal();
		}, 100);
	}

	onShow(): void {
		this.plugin.getTerminalManager()?.markSessionActive(this.sessionState.sessionId);
		window.setTimeout(() => {
			this.focusTerminal();
		}, 50);
	}

	async onClose(): Promise<void> {
		this.isDestroyed = true;
		this.plugin.getTerminalManager()?.unregisterSession(this.sessionState.sessionId);

		if (this.pseudoterminal) {
			this.pseudoterminal.kill().catch((error: unknown) => {
				console.error(
					"[Terminal] Failed to kill pseudoterminal:",
					error
				);
			});
			this.pseudoterminal = null;
		}

		if (this.terminal) {
			this.terminal.dispose();
		}
	}

	onResize(): void {
		if (this.fitAddon && !this.isDestroyed) {
			window.setTimeout(() => {
				this.fitAddon.fit();
			}, 100);
		}
	}

	private async startShell(): Promise<void> {
		try {
			const vaultPath =
				(this.app.vault.adapter as unknown as { basePath?: string }).basePath ||
				getVaultBasePath(this.app.vault.adapter);

			const isWindows = process.platform === "win32";
			const shell = isWindows
				? "powershell.exe"
				: process.env.SHELL || "/bin/zsh";
			const args = isWindows ? ["-NoLogo"] : ["-l"];

			console.debug(`[Terminal] Starting shell: ${shell}`, args);
			console.debug(`[Terminal] Working directory: ${vaultPath}`);
			console.debug(
				`[Terminal] Python available: ${this.pythonManager.isAvailable()}`
			);

			if (this.pythonManager.isAvailable()) {
				try {
					if (isWindows) {
						console.debug("[Terminal] Using Windows ConPTY via pywinpty");
						await this.startWindowsPTY(shell, args, vaultPath);
					} else {
						console.debug("[Terminal] Using Unix Python PTY approach");
						await this.startPythonPTY(shell, args, vaultPath);
					}
					return;
				} catch (error) {
					console.warn(
						"[Terminal] Python PTY failed, falling back to child_process:",
						error
					);
					new Notice(
						"Terminal: PTY not available. Install Python 3.7+ (Windows: also run 'pip install pywinpty') for full terminal support.",
						8000
					);
				}
			}

			console.debug("[Terminal] Using child_process fallback");
			await this.startChildProcess(shell, args, vaultPath);
		} catch (error: unknown) {
			console.error("[Terminal] Failed to start shell:", error);
			this.terminal.write(`Failed to start shell: ${(error as Error).message}\r\n`);
		}
	}

	private async startChildProcess(
		shell: string,
		args: string[],
		vaultPath: string
	): Promise<void> {
		this.pseudoterminal = new ChildProcessPseudoterminal({
			executable: shell,
			args,
			cwd: vaultPath,
			env: this.getTerminalEnv(),
		});

		await this.pseudoterminal.pipe(this.terminal);
		this.attachExitHandler("Shell");
		window.setTimeout(() => void this.launchStartupCommand(), 500);
	}

	private async startPythonPTY(
		shell: string,
		args: string[],
		vaultPath: string
	): Promise<void> {
		const pythonExecutable = this.pythonManager.getExecutable();
		if (!pythonExecutable) {
			throw new Error("Python executable not available");
		}

		this.pseudoterminal = new UnixPseudoterminal({
			executable: shell,
			args,
			cwd: vaultPath,
			pythonExecutable,
			terminal: "xterm-256color",
			env: this.getTerminalEnv(),
		});

		await this.pseudoterminal.pipe(this.terminal);
		this.attachExitHandler("PTY");
		window.setTimeout(() => void this.launchStartupCommand(), 100);
	}

	private async startWindowsPTY(
		shell: string,
		args: string[],
		vaultPath: string
	): Promise<void> {
		const pythonExecutable = this.pythonManager.getExecutable();
		if (!pythonExecutable) {
			throw new Error("Python executable not available");
		}

		const env = this.getTerminalEnv();
		env["TERM_COLS"] = String(this.terminal.cols || 120);
		env["TERM_ROWS"] = String(this.terminal.rows || 30);

		this.pseudoterminal = new WindowsPseudoterminal({
			executable: shell,
			args,
			cwd: vaultPath,
			pythonExecutable,
			terminal: "xterm-256color",
			env,
		});

		await this.pseudoterminal.pipe(this.terminal);
		this.attachExitHandler("Windows PTY");
		window.setTimeout(() => void this.launchStartupCommand(), 1500);
	}

	private attachExitHandler(label: string): void {
		this.pseudoterminal?.onExit
			.then((exitCode) => {
				console.debug(`[Terminal] ${label} exited with code ${exitCode}`);
				if (this.isDestroyed) {
					return;
				}

				if (this.plugin.settings.autoCloseTerminalOnShellExit) {
					window.setTimeout(() => this.leaf.detach(), 0);
					return;
				}

				this.terminal.write(`\r\n\r\nShell exited with code ${exitCode}\r\n`);
			})
			.catch((error: unknown) => {
				console.error(`[Terminal] ${label} error:`, error);
			});
	}

	private getTerminalEnv(): NodeJS.ProcessEnv {
		const profile = this.getResolvedProfile();
		return {
			...process.env,
			...this.getProfileBaseEnv(profile),
			...profile?.env,
		};
	}

	private getProfileBaseEnv(profile?: TerminalProfile): NodeJS.ProcessEnv {
		if (!profile || profile.envStrategy !== "claude-code") {
			return {};
		}

		return {
			CLAUDE_CODE_SSE_PORT: process.env.CLAUDE_CODE_SSE_PORT || "",
			ENABLE_IDE_INTEGRATION:
				process.env.ENABLE_IDE_INTEGRATION || "true",
			FORCE_CODE_TERMINAL: "true",
			TERM_PROGRAM: "obsidian-claude-terminal",
			TERM_PROGRAM_VERSION: "1.0.0",
			VSCODE_GIT_ASKPASS_NODE: process.env.VSCODE_GIT_ASKPASS_NODE || "",
			VSCODE_GIT_ASKPASS_EXTRA_ARGS:
				process.env.VSCODE_GIT_ASKPASS_EXTRA_ARGS || "",
			CLAUDE_CODE_IDE_INTEGRATION: "obsidian",
			CLAUDE_CODE_INTEGRATED_TERMINAL: "true",
		};
	}

	private async launchStartupCommand(): Promise<void> {
		if (this.isDestroyed || !this.pseudoterminal) {
			return;
		}

		const startupCommand = this.getResolvedProfile()?.launchCommand.trim() || "";
		if (!startupCommand) {
			console.debug(
				"[Terminal] Startup command is empty, skipping auto-launch"
			);
			return;
		}

		try {
			const shell = await this.pseudoterminal.shell;
			if (shell?.stdin && !shell.stdin.destroyed) {
				shell.stdin.write(`${startupCommand}\r`);
			}
		} catch (error) {
			console.warn(
				"[Terminal] Failed to auto-launch startup command:",
				error
			);
		}
	}

	public focusTerminal(): void {
		this.plugin.getTerminalManager()?.markSessionActive(this.sessionState.sessionId);
		if (this.terminal && !this.isDestroyed) {
			if (
				this.containerEl.isConnected &&
				this.containerEl.offsetParent !== null
			) {
				this.terminal.focus();
			} else {
				window.setTimeout(() => {
					if (this.terminal && !this.isDestroyed) {
						this.terminal.focus();
					}
				}, 100);
			}
		}
	}

	private getResolvedProfile(): TerminalProfile | undefined {
		return (
			this.plugin.getTerminalProfileById(this.sessionState.profileId) ||
			this.plugin.getTerminalProfileById(BUILTIN_CLAUDE_PROFILE_ID) ||
			this.plugin.getTerminalProfiles()[0]
		);
	}

	private normalizeSessionState(state: unknown): TerminalSessionState {
		const fallbackProfile =
			this.plugin.getTerminalProfileById(BUILTIN_CLAUDE_PROFILE_ID) ||
			this.plugin.getTerminalProfiles()[0];

		const fallbackDisplayName = fallbackProfile
			? `${fallbackProfile.name} 1`
			: "Terminal 1";

		if (!state || typeof state !== "object") {
			return {
				sessionId: `session-${Date.now().toString(36)}`,
				profileId: fallbackProfile?.id || BUILTIN_CLAUDE_PROFILE_ID,
				displayName: fallbackDisplayName,
				ordinal: 1,
			};
		}

		const rawState = state as Partial<TerminalSessionState>;
		const normalizedProfileId =
			typeof rawState.profileId === "string" ? rawState.profileId.trim() : "";
		const profileId =
			normalizedProfileId || fallbackProfile?.id || BUILTIN_CLAUDE_PROFILE_ID;
		const resolvedProfile =
			this.plugin.getTerminalProfileById(profileId) || fallbackProfile;
		const ordinal =
			typeof rawState.ordinal === "number" && rawState.ordinal > 0
				? Math.floor(rawState.ordinal)
				: 1;
		const normalizedSessionId =
			typeof rawState.sessionId === "string" ? rawState.sessionId.trim() : "";
		const normalizedDisplayName =
			typeof rawState.displayName === "string"
				? rawState.displayName.trim()
				: "";

		return {
			sessionId: normalizedSessionId || `session-${Date.now().toString(36)}`,
			profileId,
			displayName:
				normalizedDisplayName || `${resolvedProfile?.name || "Terminal"} ${ordinal}`,
			ordinal,
		};
	}
}
