#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

// Generate from the immutable release checkout. No timestamps or local paths.
const args = process.argv.slice(2);
const output = args[0] ?? "release-dependencies.json";
const releaseRef = args[1] ?? "v0.1.0";
const command = (bin, argv) => execFileSync(bin, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
assert.equal(realpathSync(command("git", ["rev-parse", "--show-toplevel"])), realpathSync(process.cwd()), "Generate only at the public adapter repository root");
const commit = command("git", ["rev-parse", "HEAD"]);
assert(/^[a-f0-9]{40}$/.test(commit), "Release must identify an immutable commit");
assert.equal(command("git", ["status", "--porcelain", "--untracked-files=all"]), "", "Committed release inputs must be clean, with no untracked source");
for (const file of ["package.json", "package-lock.json", "release-toolchains.json", "src/index.ts", "src/policy.ts", "src/cli.ts", "scripts/build.mjs", "skills/penny/SKILL.md"])
  command("git", ["ls-files", "--error-unmatch", file]);
const hash = (name) => createHash("sha256").update(readFileSync(name)).digest("hex");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(pkg.name, "@mypenny/opencode", "Expected the OpenCode adapter package");
assert.equal(pkg.repository.url, "https://github.com/HelperLabs/penny-opencode.git", "Expected HelperLabs release repository metadata");
const pins = JSON.parse(readFileSync("release-toolchains.json", "utf8"));
const npmVersion = command("npm", ["--version"]);
assert.equal(process.versions.node, pins.node, "Use the pinned release Node version");
assert.equal(npmVersion, pins.npm, "Use the pinned release npm version");
assert.equal(releaseRef, `v${pkg.version}`, "Release ref must match package version");
const tree = JSON.parse(command("npm", ["ls", "--omit=dev", "--all", "--json"]));
const emptyOptional = (entry) => entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length === 0;
const validate = (entry) => {
  // npm ls emits {} for absent optional peers/platform packages. These are
  // declarations, not installed packages; any diagnostic field still fails.
  if (emptyOptional(entry)) return;
  assert(!entry.extraneous && !entry.invalid && !entry.missing && !entry.problems?.length, "Installed production tree must match the frozen lock without problems or extraneous packages");
  assert(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(entry.version), "Dependency versions must be immutable registry versions");
  for (const child of Object.values(entry.dependencies ?? {})) validate(child);
};
validate(tree);
const sanitize = (entry) => ({
  version: entry.version,
  ...(entry.dependencies ? { dependencies: Object.fromEntries(Object.keys(entry.dependencies).sort().filter((name) => !emptyOptional(entry.dependencies[name])).map((name) => [name, sanitize(entry.dependencies[name])])) } : {}),
});
const manifest = {
  schemaVersion: 1,
  package: { name: pkg.name, version: pkg.version, repository: pkg.repository.url },
  release: { ref: releaseRef, commit },
  toolchains: { node: process.versions.node, npm: npmVersion },
  inputs: { "package.json": hash("package.json"), "package-lock.json": hash("package-lock.json"), "release-toolchains.json": hash("release-toolchains.json") },
  production: sanitize(tree),
};
writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ artifact: output, commit, package: pkg.name, version: pkg.version }));
