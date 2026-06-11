import { App, TFile } from "obsidian";
import { McpReplyFunction } from "../mcp/types";
import { ToolImplementation, ToolDefinition } from "../shared/tool-registry";
import { normalizePath } from "../obsidian/utils";
// General tool definitions (non-IDE specific)
export const GENERAL_TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "get_current_file",
		description: "Get the currently active file in Obsidian",
		category: "workspace",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "get_workspace_files",
		description: "List all files in the Obsidian vault",
		category: "workspace",
		inputSchema: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "Optional pattern to filter files",
				},
			},
		},
	},
	{
		name: "view",
		description:
			"View the contents of a file or list the contents of a directory in the Obsidian vault",
		category: "file",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Path to the file or directory to view (relative to vault root)",
				},
				view_range: {
					type: "array",
					description:
						"Optional array of two integers [start_line, end_line] to view specific lines (1-indexed, -1 for end means read to end of file)",
					items: {
						type: "integer",
					},
				},
			},
		},
	},
	{
		name: "str_replace",
		description: "Replace specific text in a file with new text",
		category: "file",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Path to the file to modify (relative to vault root)",
				},
				old_str: {
					type: "string",
					description:
						"The exact text to replace (must match exactly, including whitespace and indentation)",
				},
				new_str: {
					type: "string",
					description:
						"The new text to insert in place of the old text",
				},
			},
		},
	},
	{
		name: "create",
		description:
			"Create a new file with specified content in the Obsidian vault",
		category: "file",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Path where the new file should be created (relative to vault root)",
				},
				file_text: {
					type: "string",
					description: "The content to write to the new file",
				},
			},
		},
	},
	{
		name: "insert",
		description: "Insert text at a specific line number in a file",
		category: "file",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Path to the file to modify (relative to vault root)",
				},
				insert_line: {
					type: "integer",
					description:
						"Line number after which to insert the text (0 for beginning of file, 1-indexed)",
				},
				new_str: {
					type: "string",
					description: "The text to insert",
				},
			},
		},
	},
	{
		name: "obsidian_api",
		description: `Perform a safe, predefined Obsidian API action. Use this when the other tools are insufficient.
Supported actions:
- getVaultName: return the name of the current vault.
- listCommands: list the IDs and names of all available commands.
- executeCommand: run a command by its ID (requires commandId; discover IDs with listCommands).
- openFile: open a file in the workspace (requires path).
- getFileMetadata: return cached metadata (frontmatter, links, headings, tags) for a file (requires path).`,
		category: "general",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"getVaultName",
						"listCommands",
						"executeCommand",
						"openFile",
						"getFileMetadata",
					],
					description: "The action to perform",
				},
				commandId: {
					type: "string",
					description:
						"Command ID to execute (required for executeCommand; discover IDs with listCommands)",
				},
				path: {
					type: "string",
					description:
						"Vault-relative file path (required for openFile and getFileMetadata)",
				},
			},
			required: ["action"],
		},
	},
];
// General tool implementations
export class GeneralTools {
	constructor(private app: App) {}
	createImplementations(): ToolImplementation[] {
		return [
			{
				name: "get_current_file",
				handler: (args: Record<string, unknown>, reply: McpReplyFunction) => {
					const activeFile = this.app.workspace.getActiveFile();
					return reply({
						result: {
							content: [
								{
									type: "text",
									text: activeFile
										? `Current file: ${activeFile.path}`
										: "No file currently active",
								},
							],
						},
					});
				},
			},
			{
				name: "get_workspace_files",
				handler: (args: Record<string, unknown>, reply: McpReplyFunction) => {
					const { pattern } = args || {};
					const allFiles = this.app.vault.getFiles();
					let filteredFiles = allFiles.map((file) => file.path);
					if (pattern && typeof pattern === "string") {
						const regex = new RegExp(pattern);
						filteredFiles = filteredFiles.filter((path) =>
							regex.test(path)
						);
					}
					return reply({
						result: {
							content: [
								{
									type: "text",
									text: `Files in vault:\n${filteredFiles.join(
										"\n"
									)}`,
								},
							],
						},
					});
				},
			},
			{
				name: "view",
				handler: async (args: Record<string, unknown>, reply: McpReplyFunction) => {
					try {
						const { path, view_range } = args || {};
						if (!path || typeof path !== "string") {
							return reply({
								error: { code: -32602, message: "invalid path parameter" },
							});
						}
						const normalizedPath = normalizePath(path);
						if (!normalizedPath) {
							return reply({
								error: { code: -32603, message: "invalid file path" },
							});
						}
						// Check if path is a directory by trying to list files
						const allFiles = this.app.vault.getFiles();
						const isDirectory = allFiles.some(
							(file) =>
								file.path.startsWith(normalizedPath + "/") ||
								(normalizedPath.endsWith("/") &&
									file.path.startsWith(normalizedPath))
						);
						if (isDirectory || normalizedPath.endsWith("/")) {
							// List directory contents
							const dirFiles = allFiles
								.filter((file) => {
									const dirPath = normalizedPath.endsWith("/")
										? normalizedPath
										: normalizedPath + "/";
									return (
										file.path.startsWith(dirPath) &&
										!file.path.substring(dirPath.length).includes("/")
									);
								})
								.map((file) => file.path);
							return reply({
								result: {
									content: [
										{
											type: "text",
											text: dirFiles.length > 0
												? `Directory contents:\n${dirFiles.join("\n")}`
												: "Directory is empty or does not exist",
										},
									],
								},
							});
						} else {
							// Read file contents
							const content = await this.app.vault.adapter.read(
								normalizedPath
							);
							let displayContent = content;
							const range: unknown[] = Array.isArray(view_range)
								? (view_range as unknown[])
								: [];
							const startLine = range.length === 2 ? range[0] : undefined;
							const endLine = range.length === 2 ? range[1] : undefined;
							if (
								typeof startLine === "number" &&
								typeof endLine === "number"
							) {
								const lines = content.split("\n");
								const start = Math.max(0, startLine - 1); // Convert to 0-indexed
								const end =
									endLine === -1
										? lines.length
										: Math.min(lines.length, endLine);
								displayContent = lines
									.slice(start, end)
									.map((line, index) => `${start + index + 1}: ${line}`)
									.join("\n");
							} else {
								// Add line numbers to all content
								displayContent = content
									.split("\n")
									.map((line, index) => `${index + 1}: ${line}`)
									.join("\n");
							}
							return reply({
								result: {
									content: [
										{
											type: "text",
											text: displayContent,
										},
									],
								},
							});
						}
					} catch (error: unknown) {
						return reply({
							error: {
								code: -32603,
								message: `failed to view file/directory: ${(error as Error).message}`,
							},
						});
					}
				},
			},
			{
				name: "str_replace",
				handler: async (args: Record<string, unknown>, reply: McpReplyFunction) => {
					try {
						const { path, old_str, new_str } = args || {};
						if (
							!path ||
							typeof path !== "string" ||
							typeof old_str !== "string" ||
							typeof new_str !== "string"
						) {
							return reply({
								error: { code: -32602, message: "invalid parameters" },
							});
						}
						const normalizedPath = normalizePath(path);
						if (!normalizedPath) {
							return reply({
								error: { code: -32603, message: "invalid file path" },
							});
						}
						const content = await this.app.vault.adapter.read(normalizedPath);
						// Check for exact matches
						const matches = content.split(old_str).length - 1;
						if (matches === 0) {
							return reply({
								error: {
									code: -32603,
									message: "No match found for replacement text",
								},
							});
						} else if (matches > 1) {
							return reply({
								error: {
									code: -32603,
									message: `Found ${matches} matches for replacement text. Please provide more specific text to match exactly one location.`,
								},
							});
						}
						const newContent = content.replace(old_str, new_str);
						await this.app.vault.adapter.write(normalizedPath, newContent);
						return reply({
							result: {
								content: [
									{
										type: "text",
										text: "Successfully replaced text at exactly one location.",
									},
								],
							},
						});
					} catch (error: unknown) {
						return reply({
							error: {
								code: -32603,
								message: `failed to replace text: ${(error as Error).message}`,
							},
						});
					}
				},
			},
			{
				name: "create",
				handler: async (args: Record<string, unknown>, reply: McpReplyFunction) => {
					try {
						const { path, file_text } = args || {};
						if (
							!path ||
							typeof path !== "string" ||
							typeof file_text !== "string"
						) {
							return reply({
								error: { code: -32602, message: "invalid parameters" },
							});
						}
						const normalizedPath = normalizePath(path);
						if (!normalizedPath) {
							return reply({
								error: { code: -32603, message: "invalid file path" },
							});
						}
						// Check if file already exists
						try {
							await this.app.vault.adapter.read(normalizedPath);
							return reply({
								error: {
									code: -32603,
									message:
										"File already exists. Use str_replace to modify existing files.",
								},
							});
						} catch {
							// File doesn't exist, which is what we want for create
						}
						await this.app.vault.adapter.write(normalizedPath, file_text);
						return reply({
							result: {
								content: [
									{
										type: "text",
										text: `Successfully created file: ${path}`,
									},
								],
							},
						});
					} catch (error: unknown) {
						return reply({
							error: {
								code: -32603,
								message: `failed to create file: ${(error as Error).message}`,
							},
						});
					}
				},
			},
			{
				name: "insert",
				handler: async (args: Record<string, unknown>, reply: McpReplyFunction) => {
					try {
						const { path, insert_line, new_str } = args || {};
						if (
							!path ||
							typeof path !== "string" ||
							typeof insert_line !== "number" ||
							typeof new_str !== "string"
						) {
							return reply({
								error: { code: -32602, message: "invalid parameters" },
							});
						}
						const normalizedPath = normalizePath(path);
						if (!normalizedPath) {
							return reply({
								error: { code: -32603, message: "invalid file path" },
							});
						}
						const content = await this.app.vault.adapter.read(normalizedPath);
						const lines = content.split("\n");
						// Validate insert_line
						if (insert_line < 0 || insert_line > lines.length) {
							return reply({
								error: {
									code: -32603,
									message: `Invalid insert_line ${insert_line}. Must be between 0 and ${lines.length}`,
								},
							});
						}
						// Insert the new text
						const newLines = new_str.split("\n");
						lines.splice(insert_line, 0, ...newLines);
						const newContent = lines.join("\n");
						await this.app.vault.adapter.write(normalizedPath, newContent);
						return reply({
							result: {
								content: [
									{
										type: "text",
										text: `Successfully inserted text at line ${insert_line} in ${path}`,
									},
								],
							},
						});
					} catch (error: unknown) {
						return reply({
							error: {
								code: -32603,
								message: `failed to insert text: ${(error as Error).message}`,
							},
						});
					}
				},
			},
			{
				name: "obsidian_api",
				handler: async (args: Record<string, unknown>, reply: McpReplyFunction) => {
					try {
						const action = args?.["action"];
						if (typeof action !== "string") {
							return reply({
								error: {
									code: -32602,
									message:
										"action parameter is required and must be a string",
								},
							});
						}
						return await this.handleApiAction(action, args, reply);
					} catch (error: unknown) {
						return reply({
							error: {
								code: -32603,
								message: `Error performing action: ${(error as Error).message}`,
							},
						});
					}
				},
			},
		];
	}

	private async handleApiAction(
		action: string,
		args: Record<string, unknown>,
		reply: McpReplyFunction
	): Promise<void> {
		switch (action) {
			case "getVaultName": {
				return reply({
					result: {
						content: [
							{
								type: "text",
								text: `Vault name: ${this.app.vault.getName()}`,
							},
						],
					},
				});
			}
			case "listCommands": {
				const commands = this.getCommandRegistry();
				if (!commands) {
					return reply({
						error: {
							code: -32603,
							message: "Command registry is unavailable",
						},
					});
				}
				const list = commands
					.listCommands()
					.map((command) => `${command.id}: ${command.name}`)
					.join("\n");
				return reply({
					result: {
						content: [
							{
								type: "text",
								text: list || "No commands available",
							},
						],
					},
				});
			}
			case "executeCommand": {
				const commandId = args?.["commandId"];
				if (typeof commandId !== "string" || !commandId) {
					return reply({
						error: {
							code: -32602,
							message:
								"commandId parameter is required for executeCommand",
						},
					});
				}
				const commands = this.getCommandRegistry();
				if (!commands) {
					return reply({
						error: {
							code: -32603,
							message: "Command registry is unavailable",
						},
					});
				}
				const executed = commands.executeCommandById(commandId);
				return reply({
					result: {
						content: [
							{
								type: "text",
								text: executed
									? `Executed command: ${commandId}`
									: `Command not found: ${commandId}`,
							},
						],
					},
				});
			}
			case "openFile": {
				const file = this.resolveFileArg(args);
				if (typeof file === "string") {
					return reply({ error: { code: -32602, message: file } });
				}
				await this.app.workspace.getLeaf().openFile(file);
				return reply({
					result: {
						content: [
							{
								type: "text",
								text: `Opened file: ${file.path}`,
							},
						],
					},
				});
			}
			case "getFileMetadata": {
				const file = this.resolveFileArg(args);
				if (typeof file === "string") {
					return reply({ error: { code: -32602, message: file } });
				}
				const cache = this.app.metadataCache.getFileCache(file);
				return reply({
					result: {
						content: [
							{
								type: "text",
								text: cache
									? JSON.stringify(cache, null, 2)
									: "No metadata available",
							},
						],
					},
				});
			}
			default:
				return reply({
					error: {
						code: -32602,
						message: `Unknown action: ${action}. Supported actions: getVaultName, listCommands, executeCommand, openFile, getFileMetadata`,
					},
				});
		}
	}

	// Resolve the `path` argument to a vault file, or return an error message
	private resolveFileArg(args: Record<string, unknown>): TFile | string {
		const path = args?.["path"];
		if (typeof path !== "string" || !path) {
			return "path parameter is required for this action";
		}
		const normalizedPath = normalizePath(path);
		if (!normalizedPath) {
			return `Invalid path: ${path}`;
		}
		const file = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (!(file instanceof TFile)) {
			return `File not found: ${path}`;
		}
		return file;
	}

	// The command registry is not part of the public typed API, so access it
	// through a narrow, explicitly typed view instead of `any`
	private getCommandRegistry(): {
		listCommands(): { id: string; name: string }[];
		executeCommandById(id: string): boolean;
	} | null {
		const appWithCommands = this.app as unknown as {
			commands?: {
				listCommands(): { id: string; name: string }[];
				executeCommandById(id: string): boolean;
			};
		};
		return appWithCommands.commands ?? null;
	}
}