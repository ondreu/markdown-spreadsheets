import tsparser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	globalIgnores([
		"main.js",
		"node_modules/**",
		"scripts/**",
		"esbuild.config.mjs",
		"eslint.config.mjs",
		"vitest.config.mts",
	]),
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
		},
		rules: {
			// The declarative settings API (getSettingDefinitions) does not exist in the obsidian
			// typings this builds against, and minAppVersion is below 1.13.0, so display() is the
			// correct implementation here. `settings-tab/require-display` enforces that.
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
	{
		// Tests are plain Node modules: they never touch the Obsidian runtime, so the
		// rules about active documents, views and vault access do not apply there.
		files: ["tests/**/*.ts"],
		rules: {
			"obsidianmd/prefer-active-doc": "off",
			"obsidianmd/no-global-this": "off",
			// Tests build stub TFile/Vault objects. There is no real instance to narrow from, and
			// the point of the stub is to exercise our code, not Obsidian's classes.
			"obsidianmd/no-tfile-tfolder-cast": "off",
		},
	},
]);
