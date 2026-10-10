#!/usr/bin/env node
const config = {
  $schema: "https://opencode.ai/config.json",
  plugin: ["@mypenny/opencode@0.1.0"],
  mcp: { penny: { type: "remote", url: "https://app.mypenny.ai/mcp", headers: { "X-MyPenny-Require-Auth": "true" } } },
  permission: { "penny_*": "ask" },
};
const command = process.argv[2] ?? "help";
if (command === "config") {
  console.log(JSON.stringify(config, null, 2));
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`Penny for OpenCode — HelperLabs

penny-opencode config    Print the configuration to merge into opencode.json.

After adding the configuration, run: opencode mcp auth penny
Then ask OpenCode: Enable Penny private memory for this conversation.
Approve penny_enable and each requested memory operation.

Tested host: OpenCode 1.18.35. Hooks provide reminders, not automatic saves.
Documentation: https://github.com/HelperLabs/penny-opencode`);
} else {
  console.error("Unknown command. Run penny-opencode --help.");
  process.exitCode = 1;
}
