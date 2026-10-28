import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const prod = process.argv[2] === "production";

// When a local test vault exists, every successful build is copied into it.
const TEST_VAULT = "test-vault";
const TEST_PLUGIN_DIR = path.join(TEST_VAULT, ".obsidian", "plugins", "hmb-vault-scm-git");
const RELEASE_FILES = ["main.js", "manifest.json", "styles.css"];

const copyToTestVault = {
	name: "copy-to-test-vault",
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length > 0 || !existsSync(TEST_VAULT)) return;
			await mkdir(TEST_PLUGIN_DIR, { recursive: true });
			for (const file of RELEASE_FILES) {
				await copyFile(file, path.join(TEST_PLUGIN_DIR, file));
			}
			console.log(`[copy-to-test-vault] copied build to ${TEST_PLUGIN_DIR}`);
		});
	},
};

const context = await esbuild.context({
	banner: { js: "/* hmb-vault-scm-git: bundled by esbuild, see the repository for sources. */" },
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2021",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
	plugins: [copyToTestVault],
});

if (prod) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
