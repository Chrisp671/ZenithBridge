import { McpReplyFunction } from "../mcp/types";
import { ToolDefinition, ToolImplementation } from "../shared/tool-registry";

/**
 * Maps plugin tool names (qmd_ prefixed) to QMD's actual MCP tool names.
 */
const QMD_TOOL_NAME_MAP: Record<string, string> = {
	qmd_query: "query",
	qmd_get: "get",
	qmd_multi_get: "multi_get",
	qmd_status: "status",
};

export const QMD_TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "qmd_query",
		description:
			"Search indexed documents using QMD's hybrid semantic search. Combines keyword (BM25), vector similarity, and LLM re-ranking for high-quality results across your knowledge base.",
		category: "qmd",
		inputSchema: {
			type: "object",
			properties: {
				searches: {
					type: "array",
					description:
						'Typed sub-queries. Each item has a "type" (lex, vec, or hyde) and a "query" string. Use "lex" for keyword matching, "vec" for semantic similarity, "hyde" for hypothetical document embedding.',
					items: {
						type: "object",
						properties: {
							type: {
								type: "string",
								enum: ["lex", "vec", "hyde"],
								description: "Search type",
							},
							query: {
								type: "string",
								description: "The search query text",
							},
						},
						required: ["type", "query"],
					},
					maxItems: 10,
				},
				limit: {
					type: "number",
					description: "Maximum number of results (default: 10)",
				},
				minScore: {
					type: "number",
					description:
						"Minimum relevance score 0-1 (default: 0)",
				},
				collections: {
					type: "array",
					description: "Filter to specific collections",
					items: { type: "string" },
				},
				intent: {
					type: "string",
					description:
						"Background context to help disambiguate queries",
				},
			},
			required: ["searches"],
		},
	},
	{
		name: "qmd_get",
		description:
			"Retrieve the full content of a document from QMD by file path or doc ID. Use paths or docids from search results.",
		category: "qmd",
		inputSchema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description:
						"File path or docid (e.g. #abc123) from search results",
				},
				fromLine: {
					type: "number",
					description: "Start line number (1-indexed)",
				},
				maxLines: {
					type: "number",
					description: "Maximum lines to return",
				},
				lineNumbers: {
					type: "boolean",
					description: "Add line numbers (default: false)",
				},
			},
			required: ["file"],
		},
	},
	{
		name: "qmd_multi_get",
		description:
			"Retrieve multiple documents from QMD by glob pattern or comma-separated file list. Skips files larger than maxBytes.",
		category: "qmd",
		inputSchema: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description:
						"Glob pattern or comma-separated list of file paths",
				},
				maxLines: {
					type: "number",
					description: "Maximum lines per file",
				},
				maxBytes: {
					type: "number",
					description:
						"Skip files larger than this (default: 10240)",
				},
				lineNumbers: {
					type: "boolean",
					description: "Add line numbers (default: false)",
				},
			},
			required: ["pattern"],
		},
	},
	{
		name: "qmd_status",
		description:
			"Show the status of the QMD index: collections, document counts, and health information.",
		category: "qmd",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
];

export class QmdTools {
	private endpoint: string;

	constructor(endpoint: string) {
		// Ensure endpoint doesn't have trailing slash
		this.endpoint = endpoint.replace(/\/+$/, "");
	}

	private async callQmd(
		toolName: string,
		args: Record<string, unknown>
	): Promise<any> {
		const qmdToolName = QMD_TOOL_NAME_MAP[toolName] || toolName;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 30000);

		try {
			const response = await fetch(`${this.endpoint}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: Date.now().toString(),
					method: "tools/call",
					params: {
						name: qmdToolName,
						arguments: args,
					},
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(
					`QMD returned HTTP ${response.status}: ${response.statusText}`
				);
			}

			const result = await response.json();
			if (result.error) {
				throw new Error(
					result.error.message || JSON.stringify(result.error)
				);
			}
			return result.result;
		} finally {
			clearTimeout(timeout);
		}
	}

	createImplementations(): ToolImplementation[] {
		return [
			{
				name: "qmd_query",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { searches, limit, minScore, collections, intent } =
							args || {};
						if (!searches || !Array.isArray(searches)) {
							return reply({
								error: {
									code: -32602,
									message:
										"searches parameter is required (array of {type, query} objects)",
								},
							});
						}
						const result = await this.callQmd("qmd_query", {
							searches,
							...(limit !== undefined && { limit }),
							...(minScore !== undefined && { minScore }),
							...(collections !== undefined && { collections }),
							...(intent !== undefined && { intent }),
						});
						return reply({ result });
					} catch (error) {
						return reply({
							error: {
								code: -32603,
								message: `QMD query failed: ${error.message}. Is QMD running at ${this.endpoint}?`,
							},
						});
					}
				},
			},
			{
				name: "qmd_get",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { file, fromLine, maxLines, lineNumbers } =
							args || {};
						if (!file || typeof file !== "string") {
							return reply({
								error: {
									code: -32602,
									message: "file parameter is required",
								},
							});
						}
						const result = await this.callQmd("qmd_get", {
							file,
							...(fromLine !== undefined && { fromLine }),
							...(maxLines !== undefined && { maxLines }),
							...(lineNumbers !== undefined && { lineNumbers }),
						});
						return reply({ result });
					} catch (error) {
						return reply({
							error: {
								code: -32603,
								message: `QMD get failed: ${error.message}. Is QMD running at ${this.endpoint}?`,
							},
						});
					}
				},
			},
			{
				name: "qmd_multi_get",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { pattern, maxLines, maxBytes, lineNumbers } =
							args || {};
						if (!pattern || typeof pattern !== "string") {
							return reply({
								error: {
									code: -32602,
									message: "pattern parameter is required",
								},
							});
						}
						const result = await this.callQmd("qmd_multi_get", {
							pattern,
							...(maxLines !== undefined && { maxLines }),
							...(maxBytes !== undefined && { maxBytes }),
							...(lineNumbers !== undefined && { lineNumbers }),
						});
						return reply({ result });
					} catch (error) {
						return reply({
							error: {
								code: -32603,
								message: `QMD multi_get failed: ${error.message}. Is QMD running at ${this.endpoint}?`,
							},
						});
					}
				},
			},
			{
				name: "qmd_status",
				handler: async (_args: any, reply: McpReplyFunction) => {
					try {
						const result = await this.callQmd("qmd_status", {});
						return reply({ result });
					} catch (error) {
						return reply({
							error: {
								code: -32603,
								message: `QMD status failed: ${error.message}. Is QMD running at ${this.endpoint}?`,
							},
						});
					}
				},
			},
		];
	}
}
