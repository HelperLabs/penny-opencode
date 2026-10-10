# Penny for OpenCode

Use your Penny memory in OpenCode with native OAuth, tool approvals and Penny's operating instructions. Published by Helper Labs from [HelperLabs/penny-opencode](https://github.com/HelperLabs/penny-opencode).

This release targets **OpenCode 1.18.35**. It is a separate adapter release; it does not change the Claude Code, Codex or Cursor plugin releases.

## Install

Add these entries to your OpenCode configuration, preserving any existing providers, plugins and permissions:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@mypenny/opencode@0.1.0"],
  "mcp": {
    "penny": {
      "type": "remote",
      "url": "https://app.mypenny.ai/mcp",
      "headers": { "X-MyPenny-Require-Auth": "true" }
    }
  },
  "permission": {
    "penny_*": "ask"
  }
}
```

OpenCode installs the npm plugin when it starts. The header makes Penny require OAuth even when OpenCode is loading the public tool catalog. Keep it in your configuration: OpenCode's auth command runs before plugin hooks.

Sign in to Penny through OpenCode:

```sh
opencode mcp auth penny
```

Then ask OpenCode:

> Enable Penny private memory for this conversation. Load my Penny context before we start.

Approve `penny_enable` and the requested Penny tools. Each new conversation starts with memory disabled. Native child sessions and sessions with a share URL cannot enable it. Say “Disable Penny for this conversation” to clear the conversation's grant.

The helper command `penny-opencode config` prints the configuration above. It does not edit your files or sign you in.

## What it does

- Bundles Penny's complete operating skill and references.
- Reminds the agent to load context at the start, recall relevant memory before answering, and save durable results after work.
- Adds a public reminder when OpenCode compacts a conversation, asking it to preserve whether a save still needs to happen.
- Gates Penny's native MCP tools behind a conversation-level opt-in and OpenCode's own permission system.
- Uses OpenCode's OAuth discovery, registration, PKCE and credential storage. The plugin does not handle your password or copy tokens from another Penny client.

Native MCP names include `penny_penny_session_start`, `penny_penny_read`, `penny_penny_write`, `penny_penny_edit` and `penny_penny_delete`. The embedded instructions explain this naming to the agent.

## Limits

Hooks contain public instructions only. They do not fetch your profile, upload a transcript or write memory automatically. OpenCode's hook payloads cannot prove that a root conversation came from an interactive person rather than a scheduler. This release therefore relies on your explicit conversation opt-in and approved tool calls.

Recall and capture depend on the agent following the reminders. Saving before compaction is **best effort**: OpenCode 1.18.35 runs its compaction model without tools, so the compaction hook cannot make it save to Penny. A save should happen before the context fills; compaction preserves a reminder if one is still needed.

If another plugin replaces OpenCode's compaction prompt, OpenCode ignores the context Penny adds to that prompt. The reminder is then absent from that compaction request.

Opt-in is held in process memory and does not survive a server restart. Disabling Penny prevents later calls; it does not cancel a native call already waiting for approval or erase context already returned to the conversation. Sharing a conversation may expose earlier tool results through OpenCode. Keep conversations containing private memory unshared.

## Data and permissions

Approved Penny tool calls send their arguments to `https://app.mypenny.ai/mcp`. This can include search text, note content and task or project changes. Penny returns the requested memory to OpenCode; OpenCode can then include those tool results in requests to your configured model provider. Choose the provider and content accordingly.

The adapter has no telemetry and sends no network requests from its lifecycle hooks. OpenCode manages OAuth credentials in its own data directory. Removing this npm plugin does not revoke the connection; run `opencode mcp logout penny` to remove OpenCode's stored authorization. Use Penny's account controls for account-level access changes.

Existing explicit permission rules and disabled tools remain authoritative. The plugin accepts only Penny's fixed auth-challenge header; it does not accept authorization headers, custom headers or an alternate Penny URL. Do not configure Penny with an always-allow wildcard if you want a prompt for each operation.

[Penny](https://mypenny.ai) · [Privacy](https://mypenny.ai/privacy) · [Terms](https://mypenny.ai/terms) · [Support contacts](https://mypenny.ai/privacy)

## Development

The adapter's source is maintained in the Penny repository under `mypenny/integrations/opencode` and published as a separate HelperLabs repository. Its skill tree is copied from Penny's canonical `skills/mypenny` during assembly; it is not a separately maintained edition.

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
```

See [VERIFICATION.md](VERIFICATION.md) for actual release evidence and the host test procedure. The MIT license applies to this client adapter. Penny's hosted service is covered by its terms.
