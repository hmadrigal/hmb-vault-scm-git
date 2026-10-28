import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Same rules as Obsidian's automated review of community plugins.
export default defineConfig([
	{ ignores: ["main.js", "node_modules/", "test-vault/", "*.mjs"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*"] },
			},
		},
	},
]);
