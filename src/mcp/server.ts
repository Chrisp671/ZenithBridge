import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as http from "http";
import * as os from "os";
import { McpRequest, McpNotification } from "./types";
import { getClaudeIdeDir } from "../claude-config";

export interface McpServerConfig {
	onMessage: (ws: WebSocket, request: McpRequest) => void;
	onConnection?: (ws: WebSocket) => void;
	onDisconnection?: (ws: WebSocket) => void;
}

export class McpServer {
	private wss!: WebSocketServer;
	private lockFilePath = "";
	private lockFilePaths: string[] = [];
	private connectedClients: Set<WebSocket> = new Set();
	private config: McpServerConfig;
	private port = 0;
	private authToken = "";

	constructor(config: McpServerConfig) {
		this.config = config;
	}

	start(): number {
		// Generate a unique auth token for this session
		this.authToken = crypto.randomUUID();

		// 0 = choose a random free port
		this.wss = new WebSocketServer({ port: 0 });

		// address() is cast-safe once server is listening
		this.port = (this.wss.address() as { port: number }).port;

		this.wss.on("connection", (sock: WebSocket, request: http.IncomingMessage) => {
			// Validate auth token from query parameter
			const url = new URL(request.url || "", `http://localhost:${this.port}`);
			const token = url.searchParams.get("authToken");
			if (token !== this.authToken) {
				console.warn("[MCP] Client rejected: invalid or missing auth token");
				sock.close(4001, "Unauthorized");
				return;
			}

			console.debug("[MCP] Client connected (authenticated)");
			this.connectedClients.add(sock);
			console.debug(`[MCP] Total connected clients: ${this.connectedClients.size}`);

			sock.on("message", (data) => {
				try {
					const raw = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
					this.handleMessage(sock, raw);
				} catch (error) {
					console.error("[MCP] Unhandled error in message handler:", error);
					try {
						sock.send(JSON.stringify({
							jsonrpc: "2.0",
							error: { code: -32603, message: "Internal server error" },
							id: null,
						}));
					} catch {
						// Socket may already be closed
					}
				}
			});

			sock.on("close", () => {
				console.debug("[MCP] Client disconnected");
				this.connectedClients.delete(sock);
				console.debug(`[MCP] Total connected clients: ${this.connectedClients.size}`);
				this.config.onDisconnection?.(sock);
			});

			sock.on("error", (error) => {
				console.debug("[MCP] Client error:", error);
				this.connectedClients.delete(sock);
			});

			this.config.onConnection?.(sock);
		});

		this.wss.on("error", (error) => {
			console.error("WebSocket server error:", error);
		});

		// Write the discovery lock-file Claude looks for
		this.createLockFile(this.port);

		// Set environment variables that Claude Code CLI expects
		process.env.CLAUDE_CODE_SSE_PORT = this.port.toString();
		process.env.ENABLE_IDE_INTEGRATION = "true";

		return this.port;
	}

	stop(): void {
		this.wss?.close();
		// Clean up all lock file copies
		for (const lockPath of this.lockFilePaths) {
			try {
				if (fs.existsSync(lockPath)) {
					fs.unlinkSync(lockPath);
				}
			} catch (error) {
				console.warn(`[MCP] Failed to clean up lock file ${lockPath}:`, error);
			}
		}
	}

	broadcast(message: McpNotification): void {
		const messageStr = JSON.stringify(message);
		for (const client of this.connectedClients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(messageStr);
			}
		}
	}

	get clientCount(): number {
		return this.connectedClients.size;
	}

	get serverPort(): number {
		return this.port;
	}

	private createLockFile(port: number): void {
		const lockFileContent = {
			pid: process.pid,
			workspaceFolders: [] as string[],
			ideName: "Obsidian",
			transport: "ws",
			authToken: this.authToken,
			runningInWindows: process.platform === "win32",
		};
		const lockJson = JSON.stringify(lockFileContent);

		// Write lock file to the primary IDE directory
		const ideDir = getClaudeIdeDir();
		fs.mkdirSync(ideDir, { recursive: true });
		this.lockFilePath = path.join(ideDir, `${port}.lock`);
		fs.writeFileSync(this.lockFilePath, lockJson, { mode: 0o600 });
		this.lockFilePaths.push(this.lockFilePath);

		// Also write to the alternate config location so Claude Code can find it
		// regardless of whether it checks ~/.config/claude/ide/ or ~/.claude/ide/
		const homeDir = os.homedir();
		const altDirs = [
			path.join(homeDir, ".claude", "ide"),
			path.join(homeDir, ".config", "claude", "ide"),
		];
		for (const altDir of altDirs) {
			if (altDir === ideDir) continue; // Already written above
			try {
				fs.mkdirSync(altDir, { recursive: true });
				const altPath = path.join(altDir, `${port}.lock`);
				fs.writeFileSync(altPath, lockJson, { mode: 0o600 });
				this.lockFilePaths.push(altPath);
			} catch {
				// Alternate location not writable, skip
			}
		}
	}

	updateWorkspaceFolders(basePath: string): void {
		// Update all lock file copies with the workspace path
		for (const lockPath of this.lockFilePaths) {
			try {
				if (fs.existsSync(lockPath)) {
					const lockContent = JSON.parse(fs.readFileSync(lockPath, "utf8"));
					lockContent.workspaceFolders = [basePath];
					fs.writeFileSync(lockPath, JSON.stringify(lockContent), { mode: 0o600 });
				}
			} catch (error) {
				console.warn(`[MCP] Failed to update workspace in lock file ${lockPath}:`, error);
			}
		}
	}

	private handleMessage(sock: WebSocket, raw: string): void {
		let req: McpRequest;
		try {
			req = JSON.parse(raw);
		} catch {
			console.debug("[MCP] Invalid JSON received");
			sock.send(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32700, message: "Parse error" },
				id: null,
			}));
			return;
		}

		// Notifications (no id) don't expect a response
		if (req.id === undefined) {
			const notifRequest: McpRequest = {
				jsonrpc: "2.0",
				id: 0,
				method: req.method,
				params: req.params || {},
			};
			this.config.onMessage(sock, notifRequest);
			return;
		}

		this.config.onMessage(sock, req);
	}
}
