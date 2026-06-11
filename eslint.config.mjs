import js from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	{
		ignores: [
			"main.js",
			"node_modules/**",
			"esbuild.config.mjs",
			"eslint.config.mjs",
			"version-bump.mjs",
			"test-*.js",
			"docs/**",
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/no-empty-function": "off",
		},
	}
);
