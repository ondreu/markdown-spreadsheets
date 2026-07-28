/**
 * Keeps manifest.json, versions.json and package.json on the same version.
 *
 * The release tag must equal `version` exactly, with no `v` prefix — that mismatch is the most
 * common reason a community-plugin release fails validation (§15.3).
 *
 * Usage: node scripts/bump-version.mjs 1.1.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const target = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target ?? "")) {
	process.stderr.write("Usage: node scripts/bump-version.mjs <semver>\n");
	process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

const manifest = readJson("manifest.json");
manifest.version = target;
writeJson("manifest.json", manifest);

const versions = readJson("versions.json");
versions[target] = manifest.minAppVersion;
writeJson("versions.json", versions);

const pkg = readJson("package.json");
pkg.version = target;
writeJson("package.json", pkg);

process.stdout.write(`Version set to ${target} (minAppVersion ${manifest.minAppVersion}).\n`);
process.stdout.write(`Tag the release exactly "${target}" — no "v" prefix.\n`);
