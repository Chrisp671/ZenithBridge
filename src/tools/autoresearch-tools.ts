import { App } from "obsidian";
import { McpReplyFunction } from "../mcp/types";
import { ToolImplementation, ToolDefinition } from "../shared/tool-registry";
import { normalizePath } from "../obsidian/utils";

// Autoresearch tool definitions
export const AUTORESEARCH_TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "autoresearch_parse_results",
		description:
			"Parse an autoresearch results.tsv file and return structured experiment data. " +
			"Reads the TSV log that autoresearch generates (columns: commit, val_bpb, peak_vram_gb, status, description) " +
			"and returns it as structured JSON with summary statistics.",
		category: "autoresearch",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Path to the results.tsv file (relative to vault root)",
				},
			},
		},
	},
	{
		name: "autoresearch_create_report",
		description:
			"Create an Obsidian markdown note summarizing autoresearch experiment results. " +
			"Generates a formatted report with experiment table, statistics, and improvement timeline " +
			"from a results.tsv file or raw results data.",
		category: "autoresearch",
		inputSchema: {
			type: "object",
			properties: {
				results_path: {
					type: "string",
					description:
						"Path to the results.tsv file to generate report from (relative to vault root)",
				},
				output_path: {
					type: "string",
					description:
						"Path where the report note should be created (relative to vault root, e.g. 'autoresearch/report-mar5.md')",
				},
				run_tag: {
					type: "string",
					description:
						"Optional run tag/name for the experiment run (e.g. 'mar5')",
				},
			},
		},
	},
	{
		name: "autoresearch_log_experiment",
		description:
			"Append a single experiment result to a results log note in Obsidian. " +
			"Use this to incrementally build a research journal as experiments complete. " +
			"Creates the note if it doesn't exist.",
		category: "autoresearch",
		inputSchema: {
			type: "object",
			properties: {
				log_path: {
					type: "string",
					description:
						"Path to the experiment log note (relative to vault root, e.g. 'autoresearch/experiment-log.md')",
				},
				commit: {
					type: "string",
					description: "Git commit hash (short, 7 chars)",
				},
				val_bpb: {
					type: "number",
					description: "Validation bits per byte achieved",
				},
				peak_vram_gb: {
					type: "number",
					description: "Peak VRAM usage in GB",
				},
				status: {
					type: "string",
					description:
						"Experiment status: 'keep', 'discard', or 'crash'",
				},
				description: {
					type: "string",
					description: "Short description of what the experiment tried",
				},
			},
		},
	},
	{
		name: "autoresearch_parse_log",
		description:
			"Parse an autoresearch run.log file to extract training metrics and status. " +
			"Reads the training output log and extracts val_bpb, peak_vram_mb, loss curves, " +
			"and error information if the run crashed.",
		category: "autoresearch",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Path to the run.log file (relative to vault root)",
				},
			},
		},
	},
	{
		name: "autoresearch_compare_experiments",
		description:
			"Compare two or more autoresearch experiments side by side. " +
			"Takes commit hashes or experiment indices from a results file and returns " +
			"a comparison of metrics, descriptions, and improvements.",
		category: "autoresearch",
		inputSchema: {
			type: "object",
			properties: {
				results_path: {
					type: "string",
					description: "Path to the results.tsv file (relative to vault root)",
				},
				experiments: {
					type: "array",
					description:
						"Array of commit hashes or 0-based indices to compare",
					items: {
						type: "string",
					},
				},
			},
		},
	},
	{
		name: "autoresearch_init_vault",
		description:
			"Initialize an Obsidian vault folder structure for tracking autoresearch experiments. " +
			"Creates folders and template notes for organizing research runs, program.md files, " +
			"and experiment logs.",
		category: "autoresearch",
		inputSchema: {
			type: "object",
			properties: {
				base_folder: {
					type: "string",
					description:
						"Base folder in vault for autoresearch content (default: 'autoresearch')",
				},
				run_tag: {
					type: "string",
					description:
						"Optional run tag to create a specific run folder (e.g. 'mar5')",
				},
			},
		},
	},
];

interface ExperimentResult {
	commit: string;
	val_bpb: number;
	peak_vram_gb: number;
	status: string;
	description: string;
	index: number;
}

function parseResultsTsv(content: string): ExperimentResult[] {
	const lines = content.trim().split("\n");
	const results: ExperimentResult[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith("#") || line.startsWith("commit")) continue;

		const parts = line.split("\t");
		if (parts.length < 5) continue;

		results.push({
			commit: parts[0].trim(),
			val_bpb: parseFloat(parts[1].trim()),
			peak_vram_gb: parseFloat(parts[2].trim()),
			status: parts[3].trim(),
			description: parts.slice(4).join("\t").trim(),
			index: results.length,
		});
	}

	return results;
}

function computeStats(results: ExperimentResult[]) {
	const kept = results.filter((r) => r.status === "keep");
	const discarded = results.filter((r) => r.status === "discard");
	const crashed = results.filter((r) => r.status === "crash");

	const bpbValues = results
		.filter((r) => !isNaN(r.val_bpb))
		.map((r) => r.val_bpb);
	const bestBpb = bpbValues.length > 0 ? Math.min(...bpbValues) : null;
	const worstBpb = bpbValues.length > 0 ? Math.max(...bpbValues) : null;

	const bestExperiment = bestBpb !== null
		? results.find((r) => r.val_bpb === bestBpb)
		: null;

	return {
		total: results.length,
		kept: kept.length,
		discarded: discarded.length,
		crashed: crashed.length,
		keepRate: results.length > 0
			? ((kept.length / results.length) * 100).toFixed(1) + "%"
			: "N/A",
		bestBpb,
		worstBpb,
		improvement: bestBpb !== null && worstBpb !== null
			? ((worstBpb - bestBpb) / worstBpb * 100).toFixed(2) + "%"
			: "N/A",
		bestExperiment: bestExperiment
			? { commit: bestExperiment.commit, description: bestExperiment.description }
			: null,
	};
}

function generateReportMarkdown(
	results: ExperimentResult[],
	stats: ReturnType<typeof computeStats>,
	runTag?: string
): string {
	const now = new Date().toISOString().split("T")[0];
	const title = runTag
		? `Autoresearch Report: ${runTag}`
		: `Autoresearch Report`;

	let md = `# ${title}\n\n`;
	md += `**Generated:** ${now}\n`;
	md += `**Total experiments:** ${stats.total}\n\n`;

	// Summary stats
	md += `## Summary\n\n`;
	md += `| Metric | Value |\n`;
	md += `|--------|-------|\n`;
	md += `| Total experiments | ${stats.total} |\n`;
	md += `| Kept (improved) | ${stats.kept} |\n`;
	md += `| Discarded | ${stats.discarded} |\n`;
	md += `| Crashed | ${stats.crashed} |\n`;
	md += `| Keep rate | ${stats.keepRate} |\n`;
	md += `| Best val_bpb | ${stats.bestBpb?.toFixed(6) ?? "N/A"} |\n`;
	md += `| Total improvement | ${stats.improvement} |\n`;

	if (stats.bestExperiment) {
		md += `| Best experiment | \`${stats.bestExperiment.commit}\` - ${stats.bestExperiment.description} |\n`;
	}
	md += `\n`;

	// Improvement timeline (only kept experiments)
	const keptResults = results.filter((r) => r.status === "keep");
	if (keptResults.length > 0) {
		md += `## Improvement Timeline\n\n`;
		md += `| # | Commit | val_bpb | VRAM (GB) | Description |\n`;
		md += `|---|--------|---------|-----------|-------------|\n`;
		keptResults.forEach((r, i) => {
			md += `| ${i + 1} | \`${r.commit}\` | ${r.val_bpb.toFixed(6)} | ${r.peak_vram_gb.toFixed(1)} | ${r.description} |\n`;
		});
		md += `\n`;
	}

	// Full experiment log
	md += `## All Experiments\n\n`;
	md += `| # | Commit | val_bpb | VRAM (GB) | Status | Description |\n`;
	md += `|---|--------|---------|-----------|--------|-------------|\n`;
	results.forEach((r) => {
		const statusEmoji =
			r.status === "keep" ? "+" : r.status === "crash" ? "x" : "-";
		md += `| ${r.index + 1} | \`${r.commit}\` | ${isNaN(r.val_bpb) ? "N/A" : r.val_bpb.toFixed(6)} | ${isNaN(r.peak_vram_gb) ? "N/A" : r.peak_vram_gb.toFixed(1)} | ${statusEmoji} ${r.status} | ${r.description} |\n`;
	});

	return md;
}

// Autoresearch tool implementations
export class AutoresearchTools {
	constructor(private app: App) {}

	createImplementations(): ToolImplementation[] {
		return [
			{
				name: "autoresearch_parse_results",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { path } = args || {};
						if (!path || typeof path !== "string") {
							return reply({
								error: { code: -32602, message: "path parameter is required" },
							});
						}

						const normalizedPath = normalizePath(path);
						if (!normalizedPath) {
							return reply({
								error: { code: -32603, message: "invalid file path" },
							});
						}

						const content = await this.app.vault.adapter.read(normalizedPath);
						const results = parseResultsTsv(content);
						const stats = computeStats(results);

						return reply({
							result: {
								content: [
									{
										type: "text",
										text: JSON.stringify({ results, stats }, null, 2),
									},
								],
							},
						});
					} catch (error) {
						reply({
							error: {
								code: -32603,
								message: `failed to parse results: ${error.message}`,
							},
						});
					}
				},
			},
			{
				name: "autoresearch_create_report",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { results_path, output_path, run_tag } = args || {};
						if (!results_path || typeof results_path !== "string") {
							return reply({
								error: {
									code: -32602,
									message: "results_path parameter is required",
								},
							});
						}
						if (!output_path || typeof output_path !== "string") {
							return reply({
								error: {
									code: -32602,
									message: "output_path parameter is required",
								},
							});
						}

						const normalizedResultsPath = normalizePath(results_path);
						const normalizedOutputPath = normalizePath(output_path);
						if (!normalizedResultsPath || !normalizedOutputPath) {
							return reply({
								error: { code: -32603, message: "invalid file path" },
							});
						}

						const content = await this.app.vault.adapter.read(
							normalizedResultsPath
						);
						const results = parseResultsTsv(content);
						const stats = computeStats(results);
						const report = generateReportMarkdown(results, stats, run_tag);

						// Ensure parent directory exists
						const parentDir = normalizedOutputPath.split("/").slice(0, -1).join("/");
						if (parentDir) {
							try {
								await this.app.vault.adapter.mkdir(parentDir);
							} catch {
								// Directory may already exist
							}
						}

						await this.app.vault.adapter.write(normalizedOutputPath, report);

						return reply({
							result: {
								content: [
									{
										type: "text",
										text: `Report created at ${output_path} with ${results.length} experiments.\n\nSummary: ${stats.kept} kept, ${stats.discarded} discarded, ${stats.crashed} crashed. Best val_bpb: ${stats.bestBpb?.toFixed(6) ?? "N/A"}`,
									},
								],
							},
						});
					} catch (error) {
						reply({
							error: {
								code: -32603,
								message: `failed to create report: ${error.message}`,
							},
						});
					}
				},
			},
			{
				name: "autoresearch_log_experiment",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { log_path, commit, val_bpb, peak_vram_gb, status, description } =
							args || {};
						if (!log_path || typeof log_path !== "string") {
							return reply({
								error: {
									code: -32602,
									message: "log_path parameter is required",
								},
							});
						}
						if (!commit || !status || !description) {
							return reply({
								error: {
									code: -32602,
									message:
										"commit, status, and description parameters are required",
								},
							});
						}

						const normalizedPath = normalizePath(log_path);
						if (!normalizedPath) {
							return reply({
								error: { code: -32603, message: "invalid file path" },
							});
						}

						// Read existing content or create new note
						let content: string;
						try {
							content = await this.app.vault.adapter.read(normalizedPath);
						} catch {
							// Create new experiment log
							const now = new Date().toISOString().split("T")[0];
							content =
								`# Experiment Log\n\n` +
								`**Started:** ${now}\n\n` +
								`| # | Commit | val_bpb | VRAM (GB) | Status | Description |\n` +
								`|---|--------|---------|-----------|--------|-------------|\n`;

							// Ensure parent directory exists
							const parentDir = normalizedPath.split("/").slice(0, -1).join("/");
							if (parentDir) {
								try {
									await this.app.vault.adapter.mkdir(parentDir);
								} catch {
									// Directory may already exist
								}
							}
						}

						// Count existing experiments to get the next number
						const existingRows = content
							.split("\n")
							.filter(
								(line) =>
									line.startsWith("|") &&
									!line.startsWith("| #") &&
									!line.startsWith("|--")
							);
						const nextNum = existingRows.length + 1;

						const statusEmoji =
							status === "keep" ? "+" : status === "crash" ? "x" : "-";
						const bpbStr =
							val_bpb !== undefined && val_bpb !== null
								? val_bpb.toFixed(6)
								: "N/A";
						const vramStr =
							peak_vram_gb !== undefined && peak_vram_gb !== null
								? peak_vram_gb.toFixed(1)
								: "N/A";

						const newRow = `| ${nextNum} | \`${commit}\` | ${bpbStr} | ${vramStr} | ${statusEmoji} ${status} | ${description} |`;
						content = content.trimEnd() + "\n" + newRow + "\n";

						await this.app.vault.adapter.write(normalizedPath, content);

						return reply({
							result: {
								content: [
									{
										type: "text",
										text: `Logged experiment #${nextNum}: ${commit} (${status}) - ${description}`,
									},
								],
							},
						});
					} catch (error) {
						reply({
							error: {
								code: -32603,
								message: `failed to log experiment: ${error.message}`,
							},
						});
					}
				},
			},
			{
				name: "autoresearch_parse_log",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { path } = args || {};
						if (!path || typeof path !== "string") {
							return reply({
								error: { code: -32602, message: "path parameter is required" },
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

						// Extract key metrics
						const metrics: {
							val_bpb: string | null;
							peak_vram_mb: string | null;
							train_losses: string[];
							errors: string[];
							crashed: boolean;
						} = {
							val_bpb: null,
							peak_vram_mb: null,
							train_losses: [],
							errors: [],
							crashed: false,
						};

						for (const line of lines) {
							if (line.startsWith("val_bpb:")) {
								metrics.val_bpb = line.split(":")[1].trim();
							} else if (line.startsWith("peak_vram_mb:")) {
								metrics.peak_vram_mb = line.split(":")[1].trim();
							} else if (line.includes("train_loss:") || line.includes("loss:")) {
								metrics.train_losses.push(line.trim());
							} else if (
								line.includes("Error") ||
								line.includes("Traceback") ||
								line.includes("RuntimeError") ||
								line.includes("CUDA")
							) {
								metrics.errors.push(line.trim());
							}
						}

						metrics.crashed =
							metrics.val_bpb === null && metrics.errors.length > 0;

						// Get last 20 lines for context
						const tail = lines.slice(-20).join("\n");

						return reply({
							result: {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												metrics,
												totalLines: lines.length,
												tail,
											},
											null,
											2
										),
									},
								],
							},
						});
					} catch (error) {
						reply({
							error: {
								code: -32603,
								message: `failed to parse log: ${error.message}`,
							},
						});
					}
				},
			},
			{
				name: "autoresearch_compare_experiments",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { results_path, experiments } = args || {};
						if (!results_path || typeof results_path !== "string") {
							return reply({
								error: {
									code: -32602,
									message: "results_path parameter is required",
								},
							});
						}
						if (
							!experiments ||
							!Array.isArray(experiments) ||
							experiments.length < 2
						) {
							return reply({
								error: {
									code: -32602,
									message:
										"experiments must be an array of at least 2 commit hashes or indices",
								},
							});
						}

						const normalizedPath = normalizePath(results_path);
						if (!normalizedPath) {
							return reply({
								error: { code: -32603, message: "invalid file path" },
							});
						}

						const content = await this.app.vault.adapter.read(normalizedPath);
						const allResults = parseResultsTsv(content);

						// Find matching experiments by commit hash or index
						const selected: ExperimentResult[] = [];
						for (const exp of experiments) {
							const asIndex = parseInt(exp, 10);
							let found: ExperimentResult | undefined;

							if (!isNaN(asIndex) && asIndex >= 0 && asIndex < allResults.length) {
								found = allResults[asIndex];
							} else {
								found = allResults.find((r) => r.commit.startsWith(exp));
							}

							if (found) {
								selected.push(found);
							}
						}

						if (selected.length < 2) {
							return reply({
								error: {
									code: -32603,
									message: `Only found ${selected.length} matching experiments. Need at least 2 to compare.`,
								},
							});
						}

						// Build comparison
						const comparison = selected.map((r) => ({
							index: r.index,
							commit: r.commit,
							val_bpb: r.val_bpb,
							peak_vram_gb: r.peak_vram_gb,
							status: r.status,
							description: r.description,
						}));

						const bpbValues = selected
							.filter((r) => !isNaN(r.val_bpb))
							.map((r) => r.val_bpb);
						const best = Math.min(...bpbValues);
						const worst = Math.max(...bpbValues);
						const delta = worst - best;

						return reply({
							result: {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												experiments: comparison,
												summary: {
													bestBpb: best,
													worstBpb: worst,
													delta: delta.toFixed(6),
													deltaPercent:
														((delta / worst) * 100).toFixed(2) + "%",
												},
											},
											null,
											2
										),
									},
								],
							},
						});
					} catch (error) {
						reply({
							error: {
								code: -32603,
								message: `failed to compare experiments: ${error.message}`,
							},
						});
					}
				},
			},
			{
				name: "autoresearch_init_vault",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { base_folder, run_tag } = args || {};
						const baseDir = normalizePath(base_folder || "autoresearch");
						if (!baseDir) {
							return reply({
								error: { code: -32603, message: "invalid base folder path" },
							});
						}

						const created: string[] = [];

						// Create base folder structure
						const folders = [
							baseDir,
							`${baseDir}/runs`,
							`${baseDir}/programs`,
							`${baseDir}/reports`,
						];

						if (run_tag) {
							folders.push(`${baseDir}/runs/${run_tag}`);
						}

						for (const folder of folders) {
							try {
								await this.app.vault.adapter.mkdir(folder);
								created.push(`${folder}/`);
							} catch {
								// Folder may already exist
							}
						}

						// Create README note
						const readmePath = `${baseDir}/README.md`;
						try {
							await this.app.vault.adapter.read(readmePath);
						} catch {
							const readmeContent =
								`# Autoresearch\n\n` +
								`This folder tracks autonomous ML research experiments using [Karpathy's autoresearch](https://github.com/karpathy/autoresearch) framework.\n\n` +
								`## Structure\n\n` +
								`- **runs/** - Experiment results and logs per run\n` +
								`- **programs/** - program.md files that guide the AI agent\n` +
								`- **reports/** - Generated summary reports\n\n` +
								`## Quick Start\n\n` +
								`1. Copy your \`program.md\` into \`programs/\`\n` +
								`2. Run autoresearch on your GPU machine\n` +
								`3. Copy \`results.tsv\` into \`runs/<tag>/\`\n` +
								`4. Use \`autoresearch_create_report\` to generate a summary\n` +
								`5. Use \`autoresearch_log_experiment\` to incrementally track results\n`;
							await this.app.vault.adapter.write(readmePath, readmeContent);
							created.push(readmePath);
						}

						// Create a template program.md
						const programPath = `${baseDir}/programs/template-program.md`;
						try {
							await this.app.vault.adapter.read(programPath);
						} catch {
							const programContent =
								`# Autoresearch Program Template\n\n` +
								`> Customize this file to guide the AI research agent.\n` +
								`> See [autoresearch](https://github.com/karpathy/autoresearch) for the full format.\n\n` +
								`## Setup\n\n` +
								`- Read README.md, prepare.py, and train.py\n` +
								`- Create branch \`autoresearch/<tag>\`\n` +
								`- Establish baseline val_bpb\n\n` +
								`## Experiment Loop\n\n` +
								`1. Review current state of train.py\n` +
								`2. Propose a modification (architecture, hyperparams, optimizer)\n` +
								`3. Edit train.py and git commit\n` +
								`4. Run: \`uv run train.py > run.log 2>&1\`\n` +
								`5. Check: \`grep "^val_bpb:\\|^peak_vram_mb:" run.log\`\n` +
								`6. If improved (lower val_bpb): keep commit\n` +
								`7. If not improved or crashed: \`git reset HEAD~1\`\n` +
								`8. Log result and repeat\n\n` +
								`## Constraints\n\n` +
								`- Only modify train.py\n` +
								`- Each experiment runs for exactly 5 minutes\n` +
								`- Track results in TSV: commit, val_bpb, peak_vram_gb, status, description\n`;
							await this.app.vault.adapter.write(programPath, programContent);
							created.push(programPath);
						}

						// Create run-specific files if run_tag provided
						if (run_tag) {
							const runLogPath = `${baseDir}/runs/${run_tag}/experiment-log.md`;
							try {
								await this.app.vault.adapter.read(runLogPath);
							} catch {
								const now = new Date().toISOString().split("T")[0];
								const logContent =
									`# Experiment Log: ${run_tag}\n\n` +
									`**Started:** ${now}\n\n` +
									`| # | Commit | val_bpb | VRAM (GB) | Status | Description |\n` +
									`|---|--------|---------|-----------|--------|-------------|\n`;
								await this.app.vault.adapter.write(runLogPath, logContent);
								created.push(runLogPath);
							}
						}

						return reply({
							result: {
								content: [
									{
										type: "text",
										text: `Autoresearch vault structure initialized.\n\nCreated:\n${created.map((p) => `  - ${p}`).join("\n")}`,
									},
								],
							},
						});
					} catch (error) {
						reply({
							error: {
								code: -32603,
								message: `failed to initialize vault structure: ${error.message}`,
							},
						});
					}
				},
			},
		];
	}
}
