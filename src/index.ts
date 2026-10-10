import { randomUUID } from "node:crypto";
import { tool, type Hooks, type Plugin, type PluginModule } from "@opencode-ai/plugin";
import { configurePenny, configurationError, privateRootSession } from "./policy.js";

declare const PENNY_CANONICAL_SKILL: string;

const BEFORE_TURN = `Penny memory guidance: do not use private Penny memory in shared conversations, child/subagent runs, scheduled jobs or background automation. Root-session identity alone does not prove foreground or a private audience. When the user explicitly requests Penny for this private foreground conversation, call penny_enable with acknowledgement:true and wait for OpenCode approval. After enablement, call penny_penny_session_start once, then penny_penny_read before an answer that depends on prior work. Before finishing substantive work, use approved penny_penny_write calls to save durable facts and decisions. Use penny_disable to revoke this conversation's access. Every Penny operation remains subject to OpenCode's configured permissions. Never put credentials in memory or tool arguments.`;

const COMPACTION = `Penny compaction guidance: preserve whether the user enabled Penny in this conversation, the current objective, verified decisions and outstanding work. Do not include credentials or copy private memory into a shared context. Durable work should be saved with approved penny_penny_write calls before compaction. This hook performs no memory read or write, and the compaction model has no tools: it cannot guarantee a save before compaction. After continuation, re-check the current conversation's enablement before calling Penny.`;

function canonicalSkill(): string {
  const text = typeof PENNY_CANONICAL_SKILL === "string" ? PENNY_CANONICAL_SKILL : "";
  return text.replace(/\bpenny_(?=[a-z])/g, "penny_penny_");
}

const server: Plugin = async (input) => {
  const grants = new Set<string>();
  const generations = new Map<string, number>();
  let configured = false;
  let configurationGeneration = 0;

  function revoke(sessionID: string): void {
    grants.delete(sessionID);
    generations.set(sessionID, (generations.get(sessionID) ?? 0) + 1);
  }

  async function verifySession(sessionID: string): Promise<void> {
    let session: unknown;
    try {
      const result = await input.client.session.get({ path: { id: sessionID } });
      if (result.error) throw new Error("lookup failed");
      session = result.data;
    } catch {
      revoke(sessionID);
      throw new Error("Penny could not verify this conversation. Private memory access has been revoked.");
    }
    if (!privateRootSession(session, { sessionID, projectID: input.project.id, directory: input.directory })) {
      revoke(sessionID);
      throw new Error("Penny requires the same private root conversation in this workspace. Private memory access has been revoked.");
    }
  }

  const hooks: Hooks = {
    async config(config) {
      configured = false;
      configurationGeneration += 1;
      grants.clear();
      try {
        configurePenny(config);
        configured = true;
      } catch {
        grants.clear();
        throw configurationError();
      }
    },
    tool: {
      penny_enable: tool({
        description: "Enable approved Penny memory calls for this private foreground conversation only. Requires explicit user intent and acknowledgement of the disclosure. Root identity does not attest a private audience; do not enable from cron, background or subagent runs.",
        args: { acknowledgement: tool.schema.boolean().describe("True only after the user requests Penny for this private foreground conversation and acknowledges that approved queries and saved content leave the device for Penny, while retrieved memory enters the model context.") },
        async execute(args, context) {
          if (!configured) throw configurationError();
          if (args.acknowledgement !== true) throw new Error("Penny requires an explicit acknowledgement before enabling private memory.");
          const sessionID = context.sessionID;
          const generation = generations.get(sessionID) ?? 0;
          generations.set(sessionID, generation);
          const configuration = configurationGeneration;
          function verifyEnablement(): void {
            if (context.abort.aborted || !configured || configuration !== configurationGeneration || generation !== (generations.get(sessionID) ?? 0)) {
              throw new Error("Penny enablement was canceled or revoked. Request enablement again if needed.");
            }
          }
          await verifySession(sessionID);
          verifyEnablement();
          await context.ask({
            permission: "penny_enable",
            patterns: ["private memory for this conversation"],
            always: [],
            metadata: {
              disclosure: "Approved Penny queries and saved content go to app.mypenny.ai. Retrieved memory becomes visible to the configured model. This grant stays in memory for this conversation and does not enable automatic transcript upload or hook writes.",
            },
          });
          await verifySession(sessionID);
          verifyEnablement();
          grants.add(sessionID);
          return `Penny is enabled for approved tool calls in this conversation. The connection uses OpenCode's native OAuth; if disconnected, run opencode mcp auth penny.\n\n${BEFORE_TURN}\n\n${canonicalSkill()}`;
        },
      }),
      penny_disable: tool({
        description: "Revoke Penny access for this conversation. This changes local in-memory consent only and leaves OpenCode's OAuth credentials intact.",
        args: {},
        async execute(_args, context) {
          revoke(context.sessionID);
          return "Penny access is disabled for this conversation. To remove the native OAuth credentials too, run opencode mcp logout penny.";
        },
      }),
    },
    async "tool.execute.before"({ tool: name, sessionID }) {
      if (!name.startsWith("penny_") || name === "penny_enable" || name === "penny_disable") return;
      if (!configured) throw configurationError();
      if (!grants.has(sessionID)) throw new Error("Ask the user to enable Penny for this private foreground conversation with penny_enable before calling Penny.");
      await verifySession(sessionID);
      // Disable may run while the fresh identity lookup is pending.
      if (!grants.has(sessionID)) throw new Error("Penny access was revoked. Enable Penny again before using private memory.");
    },
    async "chat.message"({ sessionID }, output) {
      output.parts.push({
        id: `prt_${randomUUID().replaceAll("-", "")}`,
        sessionID, messageID: output.message.id, type: "text", synthetic: true,
        text: BEFORE_TURN,
      });
    },
    async "experimental.chat.system.transform"(_input, output) {
      output.system.push(BEFORE_TURN);
    },
    async "experimental.session.compacting"(_input, output) {
      output.context.push(COMPACTION);
    },
    async event({ event }) {
      if (event.type === "session.deleted") revoke(event.properties.info.id);
      if (event.type === "session.updated" && (event.properties.info.parentID !== undefined || event.properties.info.share !== undefined)) {
        revoke(event.properties.info.id);
      }
    },
    async dispose() {
      configured = false;
      configurationGeneration += 1;
      for (const sessionID of new Set([...grants, ...generations.keys()])) revoke(sessionID);
    },
  };
  return hooks;
};

export default { id: "penny", server } satisfies PluginModule;
