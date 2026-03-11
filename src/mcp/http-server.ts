import * as http from "http";
import * as crypto from "crypto";
import { McpRequest, McpResponse, McpNotification } from "./types";

interface HttpReplyFunction {
	(msg: Omit<McpResponse, "jsonrpc" | "id">): void;
	stream?: (msg: McpNotification | McpResponse) => void;
	end?: () => void;
}

interface Session {
	id: string;
	createdAt: number;
	lastAccessedAt: number;
	/** SSE response streams opened via GET /mcp */
	standaloneStreams: Set<http.ServerResponse>;
	/** SSE response streams opened via POST /mcp (keyed by request batch) */
	requestStreams: Map<string, http.ServerResponse>;
	/** Pending response count per request stream (to know when to close) */
	pendingResponses: Map<string, number>;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Supported protocol versions (newest first)
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

export interface McpHttpServerConfig {
	onMessage: (request: McpRequest, reply: HttpReplyFunction) => void;
	onConnection?: () => void;
	onDisconnection?: () => void;
}

export class McpHttpServer {
	private server!: http.Server;
	private port = 0;
	private config: McpHttpServerConfig;
	private sessions: Map<string, Session> = new Map();
	private eventIdCounter = 0;
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config?: McpHttpServerConfig) {
		this.config = config || {
			onMessage: () => {},
		};
	}

	/** returns port number */
	async start(port = 22360): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server = http.createServer((req, res) => {
				this.handleRequest(req, res);
			});

			this.server.on("error", (error: any) => {
				if (error.code === "EADDRINUSE") {
					console.error(`[MCP HTTP] Port ${port} is in use`);
					reject(error);
				} else {
					console.error("[MCP HTTP] Server error:", error);
					reject(error);
				}
			});

			this.server.listen(port, "127.0.0.1", () => {
				this.port = (this.server.address() as any)?.port || port;
				console.log(`[MCP HTTP] Server started on port ${this.port}`);

				this.cleanupInterval = setInterval(() => {
					this.cleanupExpiredSessions();
				}, SESSION_CLEANUP_INTERVAL_MS);

				resolve(this.port);
			});
		});
	}

	stop(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		// Close all active streams
		for (const session of this.sessions.values()) {
			for (const stream of session.standaloneStreams) {
				if (!stream.destroyed) stream.end();
			}
			for (const stream of session.requestStreams.values()) {
				if (!stream.destroyed) stream.end();
			}
		}
		this.sessions.clear();

		this.server?.close();
		console.log("[MCP HTTP] Server stopped");
	}

	get clientCount(): number {
		let count = 0;
		for (const session of this.sessions.values()) {
			count += session.standaloneStreams.size;
		}
		return count;
	}

	get serverPort(): number {
		return this.port;
	}

	broadcast(message: McpNotification): void {
		const data = JSON.stringify(message);
		const eventId = ++this.eventIdCounter;

		for (const session of this.sessions.values()) {
			for (const stream of session.standaloneStreams) {
				if (!stream.destroyed) {
					this.sendSSEMessage(stream, "message", data, eventId.toString());
				}
			}
		}
	}

	private async handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		this.setCORSHeaders(res);

		if (req.method === "OPTIONS") {
			res.writeHead(200);
			res.end();
			return;
		}

		const url = new URL(req.url || "/", `http://${req.headers.host}`);

		// ── Streamable HTTP transport (2025-03-26) ────────────────────────
		// Single endpoint: /mcp
		if (url.pathname === "/mcp") {
			switch (req.method) {
				case "POST":
					return this.handleStreamablePost(req, res);
				case "GET":
					return this.handleStreamableGet(req, res);
				case "DELETE":
					return this.handleStreamableDelete(req, res);
				default:
					res.writeHead(405, {
						Allow: "GET, POST, DELETE, OPTIONS",
						"Content-Type": "application/json",
					});
					res.end(JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32000, message: "Method not allowed" },
						id: null,
					}));
					return;
			}
		}

		// ── Legacy transport (2024-11-05) ─────────────────────────────────
		// Keep /sse and /messages for backward compatibility
		if (url.pathname === "/sse" && req.method === "GET") {
			return this.handleLegacySSEConnection(req, res);
		}
		if (url.pathname === "/messages" && req.method === "POST") {
			return this.handleLegacyMessages(req, res, url);
		}

		// 404 for everything else
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32002,
				message: "Not found. Use /mcp (Streamable HTTP) or /sse + /messages (legacy SSE).",
			},
		}));
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Streamable HTTP transport (MCP 2025-03-26)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * POST /mcp — Client sends JSON-RPC messages.
	 * Response is either SSE stream (for requests) or 202 (for notifications).
	 */
	private async handleStreamablePost(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		// Validate Accept header: must accept both application/json and text/event-stream
		const accept = req.headers.accept || "";
		if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
			res.writeHead(406, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message: "Not Acceptable: Client must accept both application/json and text/event-stream" },
				id: null,
			}));
			return;
		}

		// Validate Content-Type
		const contentType = req.headers["content-type"] || "";
		if (!contentType.includes("application/json")) {
			res.writeHead(415, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message: "Unsupported Media Type: Content-Type must be application/json" },
				id: null,
			}));
			return;
		}

		const body = await this.readRequestBody(req);
		let messages: any[];
		try {
			const parsed = JSON.parse(body);
			messages = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32700, message: "Parse error: Invalid JSON" },
				id: null,
			}));
			return;
		}

		// Detect initialization request
		const isInit = messages.some(
			(m) => m.method === "initialize" && m.id !== undefined
		);

		if (isInit) {
			// Create a new session
			const sessionId = crypto.randomUUID();
			const now = Date.now();
			const session: Session = {
				id: sessionId,
				createdAt: now,
				lastAccessedAt: now,
				standaloneStreams: new Set(),
				requestStreams: new Map(),
				pendingResponses: new Map(),
			};
			this.sessions.set(sessionId, session);
			this.config.onConnection?.();

			// Process the init request — respond as SSE stream
			return this.processStreamableRequests(messages, session, res);
		}

		// For non-init requests, validate session
		const sessionId = req.headers["mcp-session-id"] as string | undefined;
		if (!sessionId || !this.sessions.has(sessionId)) {
			const status = !sessionId ? 400 : 404;
			const message = !sessionId
				? "Bad Request: Mcp-Session-Id header is required"
				: "Session not found";
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message },
				id: null,
			}));
			return;
		}

		const session = this.sessions.get(sessionId)!;
		session.lastAccessedAt = Date.now();

		// Check if all messages are notifications/responses (no id + has method)
		const hasRequests = messages.some(
			(msg) => msg.id !== undefined && msg.method !== undefined
		);

		if (!hasRequests) {
			// Only notifications — return 202 Accepted
			for (const msg of messages) {
				if (msg.method) {
					this.config.onMessage(msg as McpRequest, () => {});
				}
			}
			res.writeHead(202);
			res.end();
			return;
		}

		return this.processStreamableRequests(messages, session, res);
	}

	/**
	 * Process JSON-RPC requests and respond via SSE stream on the POST response.
	 */
	private processStreamableRequests(
		messages: any[],
		session: Session,
		res: http.ServerResponse
	): void {
		const streamKey = crypto.randomUUID();
		const requests = messages.filter(
			(m) => m.id !== undefined && m.method !== undefined
		);

		// Set up SSE response
		const headers: Record<string, string> = {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Mcp-Session-Id": session.id,
		};
		res.writeHead(200, headers);

		// Track this stream and pending response count
		session.requestStreams.set(streamKey, res);
		session.pendingResponses.set(streamKey, requests.length);

		// Handle client disconnect
		res.on("close", () => {
			session.requestStreams.delete(streamKey);
			session.pendingResponses.delete(streamKey);
		});

		// Process each message
		for (const message of messages) {
			if (message.method && message.id !== undefined) {
				const reply: HttpReplyFunction = (msg) => {
					const response: McpResponse = {
						jsonrpc: "2.0",
						id: message.id,
						...msg,
					};
					const eventId = ++this.eventIdCounter;
					if (!res.destroyed) {
						this.sendSSEMessage(
							res,
							"message",
							JSON.stringify(response),
							eventId.toString()
						);
					}

					// Decrement pending count and close stream when all responses are sent
					const pending = (session.pendingResponses.get(streamKey) || 1) - 1;
					if (pending <= 0) {
						session.requestStreams.delete(streamKey);
						session.pendingResponses.delete(streamKey);
						if (!res.destroyed) {
							res.end();
						}
					} else {
						session.pendingResponses.set(streamKey, pending);
					}
				};

				// Add streaming capabilities for intermediate messages
				reply.stream = (msg) => {
					const eventId = ++this.eventIdCounter;
					if (!res.destroyed) {
						this.sendSSEMessage(
							res,
							"message",
							JSON.stringify(msg),
							eventId.toString()
						);
					}
				};

				reply.end = () => {
					if (!res.destroyed) {
						res.end();
					}
				};

				this.config.onMessage(message as McpRequest, reply);
			} else if (message.method) {
				// Notification — just process, no response needed
				this.config.onMessage(message as McpRequest, () => {});
			}
		}
	}

	/**
	 * GET /mcp — Client opens a standalone SSE stream for server-initiated messages.
	 */
	private async handleStreamableGet(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		// Must accept text/event-stream
		const accept = req.headers.accept || "";
		if (!accept.includes("text/event-stream")) {
			res.writeHead(406, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message: "Not Acceptable: Client must accept text/event-stream" },
				id: null,
			}));
			return;
		}

		// Validate session
		const sessionId = req.headers["mcp-session-id"] as string | undefined;
		if (!sessionId || !this.sessions.has(sessionId)) {
			const status = !sessionId ? 400 : 404;
			const message = !sessionId
				? "Bad Request: Mcp-Session-Id header is required"
				: "Session not found";
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message },
				id: null,
			}));
			return;
		}

		const session = this.sessions.get(sessionId)!;
		session.lastAccessedAt = Date.now();

		// Set SSE headers
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Mcp-Session-Id": session.id,
		});

		session.standaloneStreams.add(res);

		// Handle client disconnect
		req.on("close", () => {
			session.standaloneStreams.delete(res);
		});

		// Keep-alive ping
		const pingInterval = setInterval(() => {
			if (res.destroyed) {
				clearInterval(pingInterval);
				return;
			}
			res.write(": ping\n\n");
		}, 30000);

		req.on("close", () => {
			clearInterval(pingInterval);
		});
	}

	/**
	 * DELETE /mcp — Client terminates the session.
	 */
	private async handleStreamableDelete(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		const sessionId = req.headers["mcp-session-id"] as string | undefined;
		if (!sessionId || !this.sessions.has(sessionId)) {
			const status = !sessionId ? 400 : 404;
			const message = !sessionId
				? "Bad Request: Mcp-Session-Id header is required"
				: "Session not found";
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message },
				id: null,
			}));
			return;
		}

		const session = this.sessions.get(sessionId)!;

		// Close all streams for this session
		for (const stream of session.standaloneStreams) {
			if (!stream.destroyed) stream.end();
		}
		for (const stream of session.requestStreams.values()) {
			if (!stream.destroyed) stream.end();
		}

		this.sessions.delete(sessionId);
		this.config.onDisconnection?.();

		res.writeHead(200);
		res.end();
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Legacy SSE transport (MCP 2024-11-05) — backward compatibility
	// ═══════════════════════════════════════════════════════════════════════

	private async handleLegacySSEConnection(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		const accept = req.headers.accept || "";
		if (!accept.includes("text/event-stream")) {
			res.writeHead(406, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32600, message: "Accept header must include text/event-stream" },
				id: null,
			}));
			return;
		}

		const sessionId = crypto.randomUUID();
		const now = Date.now();
		const session: Session = {
			id: sessionId,
			createdAt: now,
			lastAccessedAt: now,
			standaloneStreams: new Set([res]),
			requestStreams: new Map(),
			pendingResponses: new Map(),
		};
		this.sessions.set(sessionId, session);

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "Content-Type, Accept, Last-Event-ID",
		});

		this.config.onConnection?.();

		// Send endpoint event (legacy protocol)
		const messagesEndpoint = `/messages?session_id=${sessionId}`;
		this.sendSSEMessage(res, "endpoint", messagesEndpoint);

		req.on("close", () => {
			session.standaloneStreams.delete(res);
			this.sessions.delete(sessionId);
			this.config.onDisconnection?.();
		});

		const pingInterval = setInterval(() => {
			if (res.destroyed) {
				clearInterval(pingInterval);
				return;
			}
			this.sendSSEMessage(res, "ping", new Date().toISOString());
		}, 30000);

		req.on("close", () => {
			clearInterval(pingInterval);
		});
	}

	private async handleLegacyMessages(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		url: URL
	): Promise<void> {
		const sessionId = url.searchParams.get("session_id");

		if (!sessionId || !this.sessions.has(sessionId)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32001, message: "Session not found" },
				id: null,
			}));
			return;
		}

		const session = this.sessions.get(sessionId)!;
		session.lastAccessedAt = Date.now();
		const body = await this.readRequestBody(req);
		let messages: any[];

		try {
			const parsed = JSON.parse(body);
			messages = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32700, message: "Parse error" },
				id: null,
			}));
			return;
		}

		const hasRequests = messages.some(
			(msg) => msg.id !== undefined && msg.method !== undefined
		);

		if (!hasRequests) {
			for (const msg of messages) {
				if (msg.method) {
					this.config.onMessage(msg as McpRequest, () => {});
				}
			}
			res.writeHead(202);
			res.end();
			return;
		}

		// Find the SSE stream for this session
		const stream = Array.from(session.standaloneStreams).find(
			(s) => !s.destroyed
		);
		if (!stream) {
			res.writeHead(410, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message: "SSE connection lost" },
				id: null,
			}));
			return;
		}

		for (const request of messages) {
			if (request.method && request.id !== undefined) {
				const reply: HttpReplyFunction = (msg) => {
					const response: McpResponse = {
						jsonrpc: "2.0",
						id: request.id,
						...msg,
					};
					const eventId = ++this.eventIdCounter;
					this.sendSSEMessage(
						stream,
						"message",
						JSON.stringify(response),
						eventId.toString()
					);
				};

				reply.stream = (msg) => {
					const eventId = ++this.eventIdCounter;
					this.sendSSEMessage(
						stream,
						"message",
						JSON.stringify(msg),
						eventId.toString()
					);
				};

				reply.end = () => {
					stream.end();
				};

				this.config.onMessage(request as McpRequest, reply);
			}
		}

		res.writeHead(202);
		res.end();
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Shared utilities
	// ═══════════════════════════════════════════════════════════════════════

	private sendSSEMessage(
		res: http.ServerResponse,
		event: string,
		data: string,
		id?: string
	): void {
		if (res.destroyed) return;

		if (id) {
			res.write(`id: ${id}\n`);
		}
		res.write(`event: ${event}\n`);
		res.write(`data: ${data}\n\n`);
	}

	private async readRequestBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				resolve(body);
			});
			req.on("error", reject);
		});
	}

	private setCORSHeaders(res: http.ServerResponse): void {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Content-Type, Accept, Mcp-Session-Id, Last-Event-ID"
		);
		res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
		res.setHeader("Access-Control-Max-Age", "86400");
	}

	private cleanupExpiredSessions(): void {
		const now = Date.now();
		for (const [id, session] of this.sessions) {
			if (now - session.lastAccessedAt > SESSION_TTL_MS) {
				for (const stream of session.standaloneStreams) {
					if (!stream.destroyed) stream.end();
				}
				for (const stream of session.requestStreams.values()) {
					if (!stream.destroyed) stream.end();
				}
				this.sessions.delete(id);
				console.debug(`[MCP HTTP] Cleaned up expired session ${id}`);
			}
		}
	}
}
