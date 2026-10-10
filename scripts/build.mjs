import { build } from "esbuild";
import { readFileSync, chmodSync } from "node:fs";
// Canonical skill assembly happens before export. Public builds read only
// committed inputs in this repository, regardless of neighboring checkouts.
const skillRoot = new URL("../skills/penny/", import.meta.url);
const skill = readFileSync(new URL("SKILL.md", skillRoot), "utf8");
await build({
  entryPoints: ["src/index.ts", "src/cli.ts"], outdir: "dist", bundle: true,
  platform: "node", format: "esm", target: "node22", legalComments: "inline",
  external: ["@opencode-ai/plugin", "@opencode-ai/plugin/*"],
  define: { PENNY_CANONICAL_SKILL: JSON.stringify(skill) }
});
chmodSync("dist/cli.js", 0o755);
