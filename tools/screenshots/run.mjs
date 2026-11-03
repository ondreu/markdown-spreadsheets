/**
 * Renders the README screenshots from the plugin's real view code.
 *
 *   npm install --no-save lucide-static@0.460.0   # icons; Obsidian ships a Lucide release like it
 *   node tools/screenshots/run.mjs
 *
 * `GridView` is bundled against `obsidian-shim.ts`, a small stand-in for the Obsidian API, loaded
 * into headless Chromium with the real `styles.css`, and driven by `shoot.cjs`. The images land in
 * `docs/images`. It is also the quickest way to see a view change working outside Obsidian —
 * which is what it was first written for.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const icons = join(root, "node_modules", "lucide-static", "icons");
const map = {};
if (existsSync(icons)) {
	const wanted = new Set([...readFileSync(join(root, "src/view/icons.ts"), "utf8").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]));
	for (const file of readdirSync(icons)) {
		const name = file.replace(/\.svg$/, "");
		if (wanted.has(name)) map[name] = readFileSync(join(icons, file), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
	}
} else {
	process.stdout.write("lucide-static is not installed; icons will be blank.\n");
}
writeFileSync(join(here, "icons.js"), `window.LUCIDE=${JSON.stringify(map)};`);
execFileSync(
	join(root, "node_modules", ".bin", "esbuild"),
	[join(here, "entry.ts"), "--bundle", "--format=iife", `--alias:obsidian=${join(here, "obsidian-shim.ts")}`, `--outfile=${join(here, "bundle.js")}`, "--log-level=warning"],
	{ stdio: "inherit" },
);
const out = join(root, "docs", "images");
mkdirSync(out, { recursive: true });
execFileSync("node", [join(here, "shoot.cjs"), out], { cwd: here, stdio: "inherit" });
