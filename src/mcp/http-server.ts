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
	streams: Set<http.ServerResponse>;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface SSEStream {
	response: http.ServerResponse;
	sessionId: string;
	lastEventId?: string;
}

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
	private activeStreams: Set<SSEStream> = new Set();
	private eventIdCounter = 0;
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config?: McpHttpServerConfig) {
		this.config = config || {
			onMessage: () => {},
		};
	}

	/** returns port number */
	start(port = 22360): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server = http.createServer((req, res) => {
				void this.handleRequest(req, res);
			});

			// Increase keep-alive timeout to reduce connection churn
			this.server.keepAliveTimeout = 65000;
			this.server.headersTimeout = 70000;


			this.server.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "EADDRINUSE") {
					console.error(`[MCP HTTP] Port ${port} is in use`);
					reject(error);
				} else {
					console.error("[MCP HTTP] Server error:", error);
					reject(error);
				}
			});

			// Prevent connection errors from crashing the server
			this.server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
				if (error.code === "ECONNRESET" || error.code === "EPIPE") {
					return;
				}
				console.debug("[MCP HTTP] Client error:", error.code || error.message);
				if (socket.writable) {
					socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
				}
			});

			this.server.listen(port, "127.0.0.1", () => {
				this.port = (this.server.address() as { port: number })?.port || port;
				console.debug(`[MCP HTTP] Server started on port ${this.port}`);

				// Start periodic session cleanup
				this.cleanupInterval = setInterval(() => {
					this.cleanupExpiredSessions();
				}, SESSION_CLEANUP_INTERVAL_MS);


				resolve(this.port);
			});
		});
	}

	stop(): void {
		// Stop session cleanup timer
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		// Close all active SSE streams
		for (const stream of this.activeStreams) {
			stream.response.end();
		}
		this.activeStreams.clear();
		this.sessions.clear();

		this.server?.close();
		console.debug("[MCP HTTP] Server stopped");
	}

	get clientCount(): number {
		return this.activeStreams.size;
	}

	get serverPort(): number {
		return this.port;
	}

	broadcast(message: McpNotification): void {
		const data = JSON.stringify(message);
		const eventId = ++this.eventIdCounter;

		for (const stream of this.activeStreams) {
			if (!stream.response.destroyed) {
				this.sendSSEMessage(
					stream.response,
					"message",
					data,
					eventId.toString()
				);
			}
		}
	}

	private async handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		try {
			return await this.handleRequestInner(req, res);
		} catch (error) {
			console.error("[MCP HTTP] Unhandled error in request handler:", error);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32603, message: "Internal server error" },
					id: null,
				}));
			} else if (!res.destroyed) {
				res.end();
			}
		}
	}

	private async handleRequestInner(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		// Add CORS headers
		this.setCORSHeaders(res);

		// Handle preflight requests
		if (req.method === "OPTIONS") {
			res.writeHead(200);
			res.end();
			return;
		}

		// Security validation
		if (!this.validateOrigin(req)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32001,
						message: "Forbidden origin",
					},
				})
			);
			return;
		}

		const url = new URL(req.url || "/", `http://${req.headers.host}`);

		// Route to appropriate endpoint
		if (url.pathname === "/sse") {
			if (req.method === "GET") {
				this.handleSSEConnection(req, res);
			} else {
				res.writeHead(405, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32000,
							message: "Method not allowed. Use GET /sse",
						},
						id: null,
					})
				);
			}
		} else if (url.pathname === "/messages") {
			if (req.method === "POST") {
				await this.handleMessages(req, res, url);
			} else {
				res.writeHead(405, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32000,
							message: "Method not allowed. Use POST /messages",
						},
						id: null,
					})
				);
			}
		} else {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32002,
						message: "Not found. Use /sse or /messages endpoints.",
					},
				})
			);
		}
	}

	private handleSSEConnection(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): void {
		// Validate Accept header (be lenient — some clients may send */*)
		const accept = req.headers.accept || "*/*";
		if (!accept.includes("text/event-stream") && !accept.includes("*/*")) {
			res.writeHead(406, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32600, message: "Accept header must include text/event-stream" },
				id: null,
			}));
			return;
		}

		// Create new session
		const sessionId = crypto.randomUUID();
		const now = Date.now();
		const session: Session = {
			id: sessionId,
			createdAt: now,
			lastAccessedAt: now,
			streams: new Set([res]),
		};
		this.sessions.set(sessionId, session);

		// Set SSE headers
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers":
				"Content-Type, Accept, Last-Event-ID",
		});

		const lastEventId = req.headers["last-event-id"] as string;
		const stream: SSEStream = {
			response: res,
			sessionId,
			lastEventId,
		};

		this.activeStreams.add(stream);
		this.config.onConnection?.();

		// Send endpoint event immediately
		const messagesEndpoint = `/messages?session_id=${sessionId}`;
		this.sendSSEMessage(res, "endpoint", messagesEndpoint);

		// Handle client disconnect
		req.on("close", () => {
			this.activeStreams.delete(stream);
			this.sessions.delete(sessionId);
			this.config.onDisconnection?.();
		});

		// Send periodic ping to keep connection alive
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

	private async handleMessages(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		url: URL
	): Promise<void> {
		const sessionId = url.searchParams.get("session_id");

		// Validate session
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
		let messages: { id?: string | number; method?: string; params?: unknown; [key: string]: unknown }[];

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

		// Check if all messages are responses/notifications (no id + method)
		const hasRequests = messages.some(
			(msg) => msg.id !== undefined && msg.method !== undefined
		);

		if (!hasRequests) {
			// Only responses/notifications - return 202 Accepted
			for (const msg of messages) {
				if (msg.method) {
					// Construct a proper McpRequest for the notification
					// Notifications lack an `id`, so we use a synthetic one
					const notificationRequest: McpRequest = {
						jsonrpc: "2.0",
						id: msg.id ?? 0,
						method: msg.method,
						params: (msg.params as Record<string, unknown>) || {},
					};
					this.config.onMessage(notificationRequest, () => {});
				}
			}
			res.writeHead(202);
			res.end();
			return;
		}

		// Process requests and send responses over SSE
		const stream = Array.from(this.activeStreams).find(
			(s) => s.sessionId === sessionId
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
						id: request.id as string | number,
						...msg,
					};
					const eventId = ++this.eventIdCounter;
					this.sendSSEMessage(
						stream.response,
						"message",
						JSON.stringify(response),
						eventId.toString()
					);
				};

				// Add streaming capabilities
				reply.stream = (msg) => {
					const eventId = ++this.eventIdCounter;
					this.sendSSEMessage(
						stream.response,
						"message",
						JSON.stringify(msg),
						eventId.toString()
					);
				};

				reply.end = () => {
					stream.response.end();
				};

				// Construct a proper McpRequest with required jsonrpc field
			const mcpRequest: McpRequest = {
				jsonrpc: "2.0",
				id: request.id as string | number,
				method: request.method as string,
				params: (request.params as Record<string, unknown>) || {},
			};
			try {
				this.config.onMessage(mcpRequest, reply);
			} catch (error) {
				console.error(`[MCP HTTP] Error processing request ${mcpRequest.method}:`, error);
				reply({
					error: { code: -32603, message: `Internal error: ${(error as Error)?.message || "unknown"}` },
				});
			}
			} else if (request.method) {
				// Notification — just process, no response needed
				try {
					const notifRequest: McpRequest = {
						jsonrpc: "2.0",
						id: 0,
						method: request.method as string,
						params: (request.params as Record<string, unknown>) || {},
					};
					this.config.onMessage(notifRequest, () => {});
				} catch (error) {
					console.error(`[MCP HTTP] Error processing notification ${request.method}:`, error);
				}
			}
		}

		// Return 202 Accepted for POST requests
		res.writeHead(202);
		res.end();
	}

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
		const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_SIZE) {
					req.destroy();
					reject(new Error("Request body too large"));
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				resolve(Buffer.concat(chunks).toString());
			});
			req.on("error", reject);
		});
	}

	private cleanupExpiredSessions(): void {
		const now = Date.now();
		const expiredIds = new Set<string>();
		for (const [id, session] of this.sessions) {
			if (now - session.lastAccessedAt > SESSION_TTL_MS) {
				expiredIds.add(id);
			}
		}

		if (expiredIds.size === 0) return;

		const remaining = new Set<SSEStream>();
		for (const stream of this.activeStreams) {
			if (expiredIds.has(stream.sessionId)) {
				if (!stream.response.destroyed) {
					stream.response.end();
				}
			} else {
				remaining.add(stream);
			}
		}
		this.activeStreams = remaining;

		for (const id of expiredIds) {
			this.sessions.delete(id);
			console.debug(`[MCP HTTP] Cleaned up expired session ${id}`);
		}
	}

	private setCORSHeaders(res: http.ServerResponse): void {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Content-Type, Accept, Last-Event-ID"
		);
		res.setHeader("Access-Control-Max-Age", "86400");
	}

	private validateOrigin(req: http.IncomingMessage): boolean {
		// For local development, allow all origins
		// In production, this should be more restrictive
		return true;
	}
}
