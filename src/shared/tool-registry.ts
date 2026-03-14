import { Tool, McpRequest, McpReplyFunction } from "../mcp/types";

export interface ToolImplementation {
	name: string;
	handler: (args: Record<string, unknown>, reply: McpReplyFunction) => Promise<void>;
}

export interface ToolDefinition extends Tool {
	category: "general" | "ide-specific" | "file" | "workspace";
}

export class ToolRegistry {
	private tools = new Map<
		string,
		{
			definition: ToolDefinition;
			implementation: ToolImplementation;
		}
	>();

	register(
		definition: ToolDefinition,
		implementation: ToolImplementation
	): void {
		if (definition.name !== implementation.name) {
			throw new Error(
				`Tool definition name "${definition.name}" doesn't match implementation name "${implementation.name}"`
			);
		}

		this.tools.set(definition.name, { definition, implementation });
	}

	async handleToolCall(
		req: McpRequest,
		reply: McpReplyFunction
	): Promise<void> {
		const { name, arguments: args } = req.params || {};
		const toolName = name as string;
		const toolArgs = (args || {}) as Record<string, unknown>;

		const tool = this.tools.get(toolName);
		if (!tool) {
			console.error(`[ToolRegistry] Unknown tool called: ${toolName}`, toolArgs);
			return reply({
				result: {
					content: [
						{
							type: "text",
							text: `Tool '${toolName}' is not registered`,
						},
					],
				},
			});
		}

		try {
			await tool.implementation.handler(toolArgs, reply);
		} catch (error) {
			reply({
				error: {
					code: -32603,
					message: `failed to call tool ${name}: ${(error as Error).message}`,
				},
			});
		}
	}

	getToolDefinitions(category?: string): Tool[] {
		const definitions: Tool[] = [];
		for (const { definition } of this.tools.values()) {
			if (!category || definition.category === category) {
				// Return Tool without the category field
				const toolDef: Tool = {
					name: definition.name,
					description: definition.description,
					inputSchema: definition.inputSchema,
				};
				definitions.push(toolDef);
			}
		}
		return definitions;
	}

	getRegisteredToolNames(): string[] {
		return Array.from(this.tools.keys());
	}

	hasImplementation(name: string): boolean {
		return this.tools.has(name);
	}
}
