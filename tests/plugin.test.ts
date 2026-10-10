import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin";
import PennyPlugin from "../src/index.js";

const SESSION = "ses_test";
const DIRECTORY = "/penny-plugin-test";

type State = { id: string; projectID: string; directory: string; parentID?: string; share?: { url: string } };

async function setup(overrides: Partial<State> = {}) {
  let session: State = { id: SESSION, projectID: "project_test", directory: DIRECTORY, ...overrides };
  let failure = false;
  let reads = 0;
  const input = {
    project: { id: "project_test" }, directory: DIRECTORY, worktree: DIRECTORY,
    client: { session: { get: async () => {
      reads += 1;
      if (failure) throw new Error("private account detail must never escape");
      return { data: session };
    } } },
  } as unknown as PluginInput;
  const hooks = await PennyPlugin.server(input);
  await hooks.config?.({});
  let asks = 0;
  let approve: () => Promise<void> = async () => {};
  const context = {
    sessionID: SESSION, messageID: "msg_test", agent: "build", directory: DIRECTORY,
    worktree: DIRECTORY, abort: new AbortController().signal,
    metadata() {}, ask: async () => { asks += 1; await approve(); },
  } satisfies ToolContext;
  return {
    hooks, context,
    get asks() { return asks; }, get reads() { return reads; },
    changeSession(value: Partial<State>) { session = { ...session, ...value }; },
    failSession() { failure = true; },
    approval(fn: () => Promise<void>) { approve = fn; },
  };
}

async function invoke(hooks: Hooks, name: string, args: Record<string, unknown>, context: ToolContext) {
  const item = hooks.tool?.[name];
  assert.ok(item, `missing custom tool ${name}`);
  return item.execute(args, context);
}

async function gate(hooks: Hooks, tool = "penny_penny_read", sessionID = SESSION) {
  return hooks["tool.execute.before"]?.({ tool, sessionID, callID: "call_test" }, { args: {} });
}

test("private native calls require an explicitly approved grant for the same session", async () => {
  const s = await setup();
  await assert.rejects(gate(s.hooks), /enable Penny/i);
  await assert.rejects(invoke(s.hooks, "penny_enable", { acknowledgement: false }, s.context), /acknowledg/i);
  assert.equal(s.asks, 0);
  await invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context);
  assert.equal(s.asks, 1);
  await gate(s.hooks);
  await assert.rejects(gate(s.hooks, "penny_penny_read", "ses_other"), /enable Penny/i);
  await gate(s.hooks, "read");
});

test("native approval denial never grants private access", async () => {
  const s = await setup();
  s.approval(async () => { throw new Error("rejected"); });
  await assert.rejects(invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context));
  await assert.rejects(gate(s.hooks), /enable Penny/i);
});

test("children, shared sessions and mismatched workspace identity cannot enable Penny", async () => {
  for (const override of [
    { parentID: "ses_parent" }, { share: { url: "https://example.test/shared" } },
    { id: "ses_other" }, { projectID: "other" }, { directory: "/other" },
  ]) {
    const s = await setup(override);
    await assert.rejects(invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context), /private root conversation/i);
    assert.equal(s.asks, 0);
  }
});

test("fresh identity is checked after approval and before every native operation", async () => {
  const s = await setup();
  s.approval(async () => { s.changeSession({ share: { url: "https://example.test/shared" } }); });
  await assert.rejects(invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context), /private root conversation/i);
  const active = await setup();
  await invoke(active.hooks, "penny_enable", { acknowledgement: true }, active.context);
  active.changeSession({ parentID: "ses_parent" });
  await assert.rejects(gate(active.hooks, "penny_penny_delete"), /private root conversation/i);
  active.changeSession({ parentID: undefined });
  await assert.rejects(gate(active.hooks), /enable Penny/i);
});

test("disable revokes all native operations and invalidates a pending enable", async () => {
  const s = await setup();
  await invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context);
  await invoke(s.hooks, "penny_disable", {}, s.context);
  for (const tool of ["penny_penny_read", "penny_penny_write", "penny_penny_delete", "penny_penny_session_start", "penny_future_tool"]) {
    await assert.rejects(gate(s.hooks, tool), /enable Penny/i);
  }
  let release!: () => void;
  s.approval(() => new Promise<void>((resolve) => { release = resolve; }));
  const pending = invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await invoke(s.hooks, "penny_disable", {}, s.context);
  release();
  await assert.rejects(pending, /revoked/i);
  await assert.rejects(gate(s.hooks), /enable Penny/i);
});

test("lookup failures revoke grants and hide host error details", async () => {
  const s = await setup();
  await invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context);
  s.failSession();
  await assert.rejects(gate(s.hooks), (error: unknown) => error instanceof Error && /verify/i.test(error.message) && !error.message.includes("private account"));
  await assert.rejects(gate(s.hooks), /enable Penny/i);
});

test("hooks contain public guidance only, make no session requests and tolerate missing session IDs", async () => {
  const s = await setup();
  const before = s.reads;
  const system = { system: ["Existing system"] };
  await s.hooks["experimental.chat.system.transform"]?.({ model: {} as never }, system);
  assert.equal(system.system[0], "Existing system");
  assert.match(system.system.join("\n"), /Penny/i);
  const parts: { message: never; parts: never[] } = { message: { id: "msg_test", sessionID: SESSION } as never, parts: [] };
  await s.hooks["chat.message"]?.({ sessionID: SESSION }, parts);
  assert.match(JSON.stringify(parts.parts), /penny_penny_read/);
  const compact = { context: ["Existing compaction context"], prompt: "Other plugin prompt" };
  await s.hooks["experimental.session.compacting"]?.({ sessionID: SESSION }, compact);
  assert.equal(compact.context[0], "Existing compaction context");
  assert.equal(compact.prompt, "Other plugin prompt");
  assert.match(compact.context.join("\n"), /cannot guarantee/i);
  assert.equal(s.reads, before);
  assert.equal(s.asks, 0);
});

test("enable returns the embedded canonical skill with native tool-name mapping", async () => {
  (globalThis as unknown as { PENNY_CANONICAL_SKILL: string }).PENNY_CANONICAL_SKILL = "Canonical contract: penny_session_start then penny_read and penny_write.";
  const s = await setup();
  const output = await invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context);
  assert.match(JSON.stringify(output), /Canonical contract: penny_penny_session_start then penny_penny_read and penny_penny_write/);
});

test("configuration preserves foreign settings and explicit Penny permissions or disabled tools", async () => {
  const s = await setup();
  const config = {
    plugin: ["foreign-plugin"],
    mcp: { foreign: { type: "remote", url: "https://example.test/mcp" } },
    permission: { bash: "deny", "penny_penny_write": "deny" },
    tools: { penny_penny_write: false, foreign: true },
    instructions: ["RULES.md"],
  };
  await s.hooks.config?.(config as never);
  assert.deepEqual(config.plugin, ["foreign-plugin"]);
  assert.deepEqual(config.mcp.foreign, { type: "remote", url: "https://example.test/mcp" });
  assert.equal((config.mcp as Record<string, unknown>).penny && true, true);
  assert.deepEqual(config.permission, { "penny_*": "ask", bash: "deny", penny_penny_write: "deny" });
  assert.deepEqual(config.tools, { penny_penny_write: false, foreign: true });
  assert.deepEqual(config.instructions, ["RULES.md"]);
  const empty: Record<string, unknown> = {};
  await s.hooks.config?.(empty as never);
  assert.deepEqual(empty.permission, { "penny_*": "ask" });
  assert.deepEqual(empty.mcp, { penny: { type: "remote", url: "https://app.mypenny.ai/mcp", headers: { "X-MyPenny-Require-Auth": "true" } } });
  const global = { permission: "deny" };
  await s.hooks.config?.(global as never);
  assert.equal(global.permission, "deny");
});

test("canonical server configuration is preserved and conflicting endpoint/auth disables access without disclosure", async () => {
  const s = await setup();
  const canonical = { mcp: { penny: { type: "remote", url: "https://app.mypenny.ai/mcp", headers: { "X-MyPenny-Require-Auth": "true" }, enabled: false, timeout: 7000, oauth: {} } } };
  const prior = structuredClone(canonical);
  await s.hooks.config?.(canonical as never);
  assert.deepEqual(canonical.mcp, prior.mcp);
  for (const server of [
    { type: "remote", url: "https://malicious.test/private-secret" },
    { type: "local", command: ["private-secret"] },
    { type: "remote", url: "https://app.mypenny.ai/mcp", headers: { Authorization: "private-secret" } },
    { type: "remote", url: "https://app.mypenny.ai/mcp", headers: { "X-MyPenny-Require-Auth": "false" } },
    { type: "remote", url: "https://app.mypenny.ai/mcp", headers: { "X-MyPenny-Require-Auth": "true", "X-Custom": "private-secret" } },
    { type: "remote", url: "https://app.mypenny.ai/mcp", oauth: false },
    { type: "remote", url: "https://app.mypenny.ai/mcp", oauth: { clientId: "private-secret" } },
  ]) {
    const bad = { mcp: { penny: server } };
    await assert.rejects(s.hooks.config!(bad as never), (error: unknown) => error instanceof Error && /configuration/i.test(error.message) && !error.message.includes("private-secret"));
    assert.deepEqual(bad.mcp.penny, server);
    await assert.rejects(invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context), /configuration/i);
  }
});

test("existing URL-only and empty-header Penny entries receive the nonsecret native OAuth challenge", async () => {
  const s = await setup();
  for (const headers of [undefined, {}]) {
    const config = { mcp: { penny: { type: "remote", url: "https://app.mypenny.ai/mcp", enabled: false, timeout: 8000, ...(headers ? { headers } : {}) } } };
    await s.hooks.config?.(config as never);
    assert.deepEqual(config.mcp.penny, { type: "remote", url: "https://app.mypenny.ai/mcp", enabled: false, timeout: 8000, headers: { "X-MyPenny-Require-Auth": "true" } });
  }
});

test("disposed plugin instances lose all private grants", async () => {
  const s = await setup();
  await invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context);
  await s.hooks.dispose?.();
  await assert.rejects(gate(s.hooks), /configuration/i);
});

test("configuration reload invalidates approved grants and a pending enable", async () => {
  const s = await setup();
  await invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context);
  await s.hooks.config?.({});
  await assert.rejects(gate(s.hooks), /enable Penny/i);
  s.approval(async () => { await s.hooks.config?.({}); });
  await assert.rejects(invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context), /revoked/i);
  await assert.rejects(gate(s.hooks), /enable Penny/i);
});

test("deleted or shared session events revoke grants without contacting Penny", async () => {
  for (const event of [
    { type: "session.deleted", properties: { info: { id: SESSION } } },
    { type: "session.updated", properties: { info: { id: SESSION, share: { url: "https://example.test/shared" } } } },
  ]) {
    const s = await setup();
    await invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context);
    const prior = s.reads;
    await s.hooks.event?.({ event: event as never });
    assert.equal(s.reads, prior);
    await assert.rejects(gate(s.hooks), /enable Penny/i);
  }
});

test("disposal while enable approval is pending cannot commit a grant", async () => {
  const s = await setup();
  let release!: () => void;
  s.approval(() => new Promise<void>((resolve) => { release = resolve; }));
  const pending = invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await s.hooks.dispose?.();
  release();
  await assert.rejects(pending, /revoked/i);
  await assert.rejects(gate(s.hooks), /configuration/i);
});

test("invalid configuration followed by restoration cannot revive pending approval", async () => {
  const s = await setup();
  let release!: () => void;
  s.approval(() => new Promise<void>((resolve) => { release = resolve; }));
  const pending = invoke(s.hooks, "penny_enable", { acknowledgement: true }, s.context);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(s.hooks.config!({ mcp: { penny: { type: "remote", url: "https://example.test/mcp" } } }), /configuration/i);
  await s.hooks.config?.({});
  release();
  await assert.rejects(pending, /revoked/i);
  await assert.rejects(gate(s.hooks), /enable Penny/i);
});
