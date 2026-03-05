import { ItemView, WorkspaceLeaf, Notice, App } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
	Pseudoterminal,
	UnixPseudoterminal,
	WindowsPseudoterminal,
	ChildProcessPseudoterminal,
} from "./pseudoterminal";
import { PythonManager } from "./python-detection";
import type ClaudeMcpPlugin from "main";

export const TERMINAL_VIEW_TYPE = "claude-terminal-view";

export class ClaudeTerminalView extends ItemView {
	private terminal: Terminal;
	private fitAddon: FitAddon;
	private pseudoterminal: Pseudoterminal | null = null;
	private pythonManager = new PythonManager();
	private isDestroyed = false;
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
		return "Claude Terminal";
	}

	getIcon(): string {
		return "claude-logo";
	}

	async onOpen(): Promise<void> {
		console.debug("[Terminal] Opening terminal view");

		const container = this.containerEl.children[1];
		container.empty();

		// Create terminal container
		const terminalEl = container.createDiv({
			cls: "claude-terminal-container",
		});
		terminalEl.style.width = "100%";
		terminalEl.style.height = "100%";
		terminalEl.style.padding = "8px";

		// Open terminal in DOM
		this.terminal.open(terminalEl);

		// Initialize Python detection but defer shell start
		await this.pythonManager.initialize();

		// Set up shell process - now includes environment setup
		await this.startShell();

		// Add custom key handler for Shift+Enter to insert a newline
		this.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
			// We only care about keydown events.
			if (event.type !== "keydown") {
				return true;
			}

			// Check for Shift+Enter without other modifiers
			if (
				event.key === "Enter" &&
				event.shiftKey &&
				!event.altKey &&
				!event.ctrlKey &&
				!event.metaKey
			) {
				// Ensure we have a pseudoterminal with a shell property
				if (this.pseudoterminal?.shell) {
					// Prevent the default Enter behavior (sending \r)
					event.preventDefault();

					// Manually send a newline character to the PTY's stdin
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

					// Stop xterm.js from processing the event further
					return false;
				}
			}

			// Allow xterm.js to process all other key events
			return true;
		});

		// Set up terminal resizing
		this.terminal.onResize(({ cols, rows }) => {
			if (this.pseudoterminal?.resize) {
				this.pseudoterminal
					.resize(cols, rows)
					.catch((error: unknown) => {
						console.warn("[Terminal] Resize failed:", error);
					});
			}
		});

		// Fit terminal to container and focus after a brief delay
		setTimeout(() => {
			this.fitAddon.fit();
			this.focusTerminal();
		}, 100);
	}

	// Called when the view becomes active/visible
	onShow(): void {
		console.debug("[Terminal] Terminal view shown");
		// Focus the terminal when the view becomes active
		setTimeout(() => {
			this.focusTerminal();
		}, 50);
	}

	async onClose(): Promise<void> {
		console.debug("[Terminal] Closing terminal view");
		this.isDestroyed = true;

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
			setTimeout(() => {
				this.fitAddon.fit();
			}, 100);
		}
	}

	private async startShell(): Promise<void> {
		try {
			// Get vault root directory for PWD
			const vaultPath =
				(this.app.vault.adapter as any).basePath ||
				(this.app.vault.adapter as any).getBasePath?.() ||
				process.cwd();

			// Determine shell command based on platform
			const isWindows = process.platform === "win32";
			const shell = isWindows
				? "powershell.exe"
				: process.env.SHELL || "/bin/zsh";
			const args = isWindows ? ["-NoLogo"] : ["-l"];

			console.debug(`[Terminal] Starting shell: ${shell}`, args);
			console.debug(`[Terminal] Working directory: ${vaultPath}`);
			console.debug(`[Terminal] Python available: ${this.pythonManager.isAvailable()}`);

			// Try Python PTY approach first (required for interactive TUI apps)
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
					new Notice("Terminal: PTY initialization failed, using basic mode");
				}
			}

			// Fallback: use child_process (works on all platforms but no true PTY)
			console.debug("[Terminal] Using child_process fallback");
			await this.startChildProcess(shell, args, vaultPath);
		} catch (error: any) {
			console.error("[Terminal] Failed to start shell:", error);
			this.terminal.write(`Failed to start shell: ${error.message}\r\n`);
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

		this.pseudoterminal.onExit
			.then((exitCode) => {
				console.debug(`[Terminal] Shell exited with code ${exitCode}`);
				if (!this.isDestroyed) {
					this.terminal.write(
						`\r\n\r\nShell exited with code ${exitCode}\r\n`
					);
				}
			})
			.catch((error: unknown) => {
				console.error("[Terminal] Shell error:", error);
			});

		// Auto-launch startup command after a brief delay
		setTimeout(() => this.launchStartupCommand(), 500);
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

		// Pipe pseudoterminal to xterm
		await this.pseudoterminal.pipe(this.terminal);

		// Handle exit
		this.pseudoterminal.onExit
			.then((exitCode) => {
				console.debug(`[Terminal] PTY exited with code ${exitCode}`);
				if (!this.isDestroyed) {
					this.terminal.write(
						`\r\n\r\nShell exited with code ${exitCode}\r\n`
					);
				}
			})
			.catch((error: unknown) => {
				console.error("[Terminal] PTY error:", error);
			});

		// Auto-launch startup command after a brief delay
		setTimeout(() => this.launchStartupCommand(), 100);
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

		console.debug(`[Terminal] Windows ConPTY: python=${pythonExecutable}, shell=${shell}, args=${args}`);

		// Pass terminal dimensions via environment so ConPTY starts with correct size
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

		// Pipe pseudoterminal to xterm
		await this.pseudoterminal.pipe(this.terminal);

		// Handle exit
		this.pseudoterminal.onExit
			.then((exitCode) => {
				console.debug(`[Terminal] Windows PTY exited with code ${exitCode}`);
				if (!this.isDestroyed) {
					this.terminal.write(
						`\r\n\r\nShell exited with code ${exitCode}\r\n`
					);
				}
			})
			.catch((error: unknown) => {
				console.error("[Terminal] Windows PTY error:", error);
			});

		// Auto-launch startup command after shell initializes
		// Give PowerShell enough time to start inside the ConPTY
		setTimeout(() => this.launchStartupCommand(), 1500);
	}

	private getTerminalEnv(): NodeJS.ProcessEnv {
		return {
			...process.env,

			// These are just taken from the nvim plugin: https://github.com/coder/claudecode.nvim/blob/c1cdcd5a61d5a18f262d5c8c53929e3a27cb7821/lua/claudecode/terminal.lua#L346
			// Since none of this is officially documented it may change.
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

	/**
	 * Sends the configured startup command to the running shell.
	 * Used by all PTY modes (Unix, Windows ConPTY, and child_process fallback).
	 */
	private async launchStartupCommand(): Promise<void> {
		if (!this.isDestroyed && this.pseudoterminal) {
			const startupCommand = this.plugin.settings.startupCommand.trim();

			// Skip if no startup command is configured
			if (!startupCommand) {
				console.debug(
					"[Terminal] Startup command is empty, skipping auto-launch"
				);
				return;
			}

			console.debug(
				`[Terminal] Auto-launching startup command: ${startupCommand}`
			);
			try {
				const shell = await this.pseudoterminal.shell;
				if (shell && shell.stdin && !shell.stdin.destroyed) {
					// Use \r (carriage return) as that's the correct terminal Enter key
					shell.stdin.write(`${startupCommand}\r`);
				}
			} catch (error) {
				console.warn(
					"[Terminal] Failed to auto-launch startup command:",
					error
				);
			}
		}
	}

	public focusTerminal(): void {
		if (this.terminal && !this.isDestroyed) {
			// Ensure the terminal is properly loaded and visible
			if (
				this.containerEl.isConnected &&
				this.containerEl.offsetParent !== null
			) {
				this.terminal.focus();
				console.debug("[Terminal] Terminal focused");
			} else {
				// Retry focus after a short delay if terminal isn't ready
				setTimeout(() => {
					if (this.terminal && !this.isDestroyed) {
						this.terminal.focus();
						console.debug("[Terminal] Terminal focused (delayed)");
					}
				}, 100);
			}
		}
	}
}
