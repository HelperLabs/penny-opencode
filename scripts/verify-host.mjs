#!/usr/bin/env node
// Native-host verification. Model traffic stays on loopback; never log payloads.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = resolve(root, ".live/state");
const cwd = resolve(state, "workspace");
const configFile = resolve(state, "opencode.json");
const binary = resolve(root, "node_modules/.bin/opencode");
const mode = process.argv[2] ?? "--host";
const timeoutMs = 90_000;
const providerID = "penny-verification";
const modelID = "loopback";
let child;
let provider;
let syntheticNoteId;
let mainSession;
let base;
let cleanupComplete = false;
const plans = new Map();
const stats = { modelRequests: 0, systemGuidance: 0, compactionGuidance: 0, calls: {} };
const secretFree = (label, fields = {}) => console.log(JSON.stringify({ check: label, ...fields }));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function prepare(baseURL = "http://127.0.0.1:47889/v1") {
  await mkdir(resolve(root, ".live"), { recursive: true, mode: 0o700 });
  await chmod(resolve(root, ".live"), 0o700);
  for (const name of ["", "data", "config", "config/opencode", "cache", "state", "workspace"]) {
    await mkdir(resolve(state, name), { recursive: true, mode: 0o700 });
    await chmod(resolve(state, name), 0o700);
  }
  const config = {
    $schema: "https://opencode.ai/config.json", logLevel: "ERROR", autoupdate: false,
    snapshot: false, share: "disabled", model: `${providerID}/${modelID}`,
    small_model: `${providerID}/${modelID}`, enabled_providers: [providerID],
    plugin: [pathToFileURL(resolve(root, "dist/index.js")).href],
    provider: {
      [providerID]: {
        npm: "@ai-sdk/openai-compatible", name: "Loopback verification only", env: [],
        options: { baseURL, apiKey: "local-verification-only", timeout: timeoutMs },
        models: { [modelID]: { name: "Loopback", tool_call: true,
          limit: { context: 64_000, output: 4_000 },
          cost: { input: 0, output: 0 },
        } },
      },
    },
    permission: { "*": "deny", penny_enable: "ask", penny_disable: "allow", "penny_penny_*": "ask" },
    // CLI authentication reads config before Plugin.init. Keep the same pinned URL.
    mcp: { penny: { type: "remote", url: "https://app.mypenny.ai/mcp", enabled: true,
      headers: { "X-MyPenny-Require-Auth": "true" },
    } },
    lsp: false, formatter: false, compaction: { auto: false, prune: false },
    agent: { title: { disable: true }, summary: { disable: true } },
    experimental: { continue_loop_on_deny: true },
  };
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(configFile, 0o600);
  return config;
}

function environment() {
  // No inherited provider, Penny, GitHub, cloud, or Keychain credentials.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME,
    XDG_DATA_HOME: resolve(state, "data"), XDG_CONFIG_HOME: resolve(state, "config"),
    XDG_CACHE_HOME: resolve(state, "cache"), XDG_STATE_HOME: resolve(state, "state"),
    OPENCODE_CONFIG: configFile, OPENCODE_CONFIG_DIR: resolve(state, "config/opencode"),
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  };
  for (const key of ["TMPDIR", "SYSTEMROOT", "LANG"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}

async function request(route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options, headers: { "content-type": "application/json", ...options.headers },
    signal: AbortSignal.timeout(options.timeout ?? timeoutMs),
  });
  if (!response.ok) throw new Error(`Native route ${route.split("?")[0]} returned HTTP ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? []).map((part) => part?.text ?? "").join("\n");
}

async function modelServer() {
  provider = createServer(async (req, res) => {
    try {
      assert(req.method === "POST" && req.url === "/v1/chat/completions", "Unexpected local provider route");
      let body = "";
      for await (const chunk of req) { body += chunk; assert(body.length < 5_000_000, "Model request too large"); }
      const input = JSON.parse(body);
      stats.modelRequests++;
      const messages = input.messages ?? [];
      const system = messages.filter((m) => m.role === "system" || m.role === "developer").map(messageText).join("\n");
      if (/Penny/.test(system) && /penny_enable/.test(system)) stats.systemGuidance++;
      if (/Penny compaction guidance/.test(messages.map(messageText).join("\n"))) stats.compactionGuidance++;
      const markerOf = (message) => messageText(message).match(/PENNY_NATIVE_VERIFICATION_[a-f0-9-]{36}/)?.[0];
      const markerIndex = messages.findLastIndex((m) => m.role === "user" && plans.has(markerOf(m)));
      // Native compaction carries conversation history but deliberately has no tools.
      // A historical verification marker must not schedule a tool in that request.
      const plan = markerIndex < 0 || !input.tools?.length ? undefined : plans.get(markerOf(messages[markerIndex]));
      const alreadyCalled = plan && messages.slice(markerIndex + 1).some((m) => m.role === "assistant" && m.tool_calls?.some((t) => t.function.name === plan.name));
      let delta;
      let finish;
      if (plan && !alreadyCalled) {
        const definition = input.tools?.find((tool) => tool.function?.name === plan.name);
        assert(definition, `Native host did not offer expected tool ${plan.name}`);
        plan.schema = definition.function.parameters;
        const args = typeof plan.args === "function" ? plan.args(plan.schema) : plan.args;
        delta = { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name: plan.name, arguments: JSON.stringify(args) } }] };
        finish = "tool_calls";
        stats.calls[plan.name] = (stats.calls[plan.name] ?? 0) + 1;
      } else {
        // Includes the compaction prompt: preserve only public Penny guidance.
        delta = { role: "assistant", content: "Verification completed. Penny remains private: use penny_enable only with explicit acknowledgement and host permission; preserve durable context deliberately before compaction. No automatic Penny write occurred in this summary." };
        finish = "stop";
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = `chatcmpl_${randomUUID()}`;
      const chunk = (d, f) => ({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelID, choices: [{ index: 0, delta: d, finish_reason: f }] });
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, finish), usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) {
      // Whitelisted harness assertions only; never serialize the request or response.
      const safe = error instanceof assert.AssertionError ? error.message : "Local provider failed to parse native request";
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: safe, type: "verification_error" } }));
    }
  });
  await new Promise((done) => provider.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${provider.address().port}/v1`;
}

async function start() {
  const version = spawnSync(binary, ["--version"], { cwd, env: environment(), encoding: "utf8", timeout: 10_000 });
  assert.equal(version.status, 0, "Native OpenCode unavailable: run node node_modules/opencode-ai/postinstall.mjs");
  assert.equal(version.stdout.trim(), "1.18.35", "Native binary must be pinned OpenCode 1.18.35");
  let output = "";
  child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "ERROR"], { cwd, env: environment(), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-16_384); });
  // Native stderr is deliberately discarded: it can contain tool/auth data.
  child.stderr.resume();
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
    if (match) { base = match[0]; await request("/global/health"); return; }
    if (child.exitCode !== null) throw new Error(`Native OpenCode exited before readiness (${child.exitCode})`);
    await sleep(100);
  }
  throw new Error("Native OpenCode readiness timed out");
}

async function session(body = {}) {
  return request("/session", { method: "POST", body: JSON.stringify({ title: "Penny native verification", ...body }) });
}

async function turn(sessionId, plan, permissionReply = "once") {
  const marker = `PENNY_NATIVE_VERIFICATION_${randomUUID()}`;
  if (plan) plans.set(marker, plan);
  const before = (await request(`/session/${sessionId}/message`)).length;
  let done = false;
  let result;
  let failure;
  const pending = request(`/session/${sessionId}/message`, { method: "POST", body: JSON.stringify({
    model: { providerID, modelID }, agent: "build", parts: [{ type: "text", text: marker }],
  }) }).then((r) => { result = r; done = true; }, (e) => { failure = e; done = true; });
  const permissions = [];
  while (!done) {
    for (const permission of await request("/permission")) {
      if (permission.sessionID !== sessionId) continue;
      permissions.push(permission.permission);
      await request(`/permission/${permission.id}/reply`, { method: "POST", body: JSON.stringify({ reply: permissionReply }) });
    }
    if (!done) await sleep(100);
  }
  await pending;
  if (failure) throw failure;
  assert(!result?.info?.error, "Native model turn returned an error (payload withheld)");
  const messages = (await request(`/session/${sessionId}/message`)).slice(before);
  assert(messages.some((message) => message.info?.role === "user" && message.parts.some((part) => part.type === "text" && part.synthetic === true && /Penny memory guidance/.test(part.text))), "Native chat.message hook omitted the public Penny reminder");
  const tools = messages.flatMap((m) => m.parts ?? []).filter((part) => part.type === "tool");
  return { tools, permissions, result };
}

function toolPart(result, name) {
  const tool = result.tools.findLast((part) => part.tool === name);
  assert(tool, `Native host did not execute ${name}`);
  return tool;
}

function outputOf(part) {
  if (part.state.status !== "completed") {
    const known = new Set(["Unauthorized", "Forbidden", "Not Found", "Bad Request", "Tool timeout", "fetch failed"]);
    const classification = known.has(part.state.error) ? part.state.error : "payload withheld";
    assert.fail(`Native ${part.tool} did not complete (${classification})`);
  }
  const output = part.state.output;
  const fenced = typeof output === "string" ? output.replace(/^```(?:json)?\s*|\s*```$/g, "") : output;
  try { return typeof fenced === "string" ? JSON.parse(fenced) : fenced; } catch { return output; }
}

async function nativeAuthMetadata() {
  // Inspect token presence/expiry only. Never return credentials or decoded claims.
  try {
    const all = JSON.parse(await readFile(resolve(state, "data/opencode/mcp-auth.json"), "utf8"));
    const entry = all.penny;
    return {
      serverMatches: entry?.serverUrl === "https://app.mypenny.ai/mcp",
      accessPresent: typeof entry?.tokens?.accessToken === "string" && entry.tokens.accessToken.length > 0,
      refreshPresent: typeof entry?.tokens?.refreshToken === "string" && entry.tokens.refreshToken.length > 0,
      expired: typeof entry?.tokens?.expiresAt === "number" && entry.tokens.expiresAt <= Date.now() / 1000,
    };
  } catch { return { serverMatches: false, accessPresent: false, refreshPresent: false, expired: false }; }
}

function walk(value, predicate) {
  if (predicate(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  for (const child of Object.values(value)) { const found = walk(child, predicate); if (found !== undefined) return found; }
}

function unpack(value) {
  // Native MCP output may be a content envelope or a JSON string inside text.
  if (typeof value === "string") { try { return unpack(JSON.parse(value)); } catch { return value; } }
  if (Array.isArray(value)) return value.map(unpack);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unpack(child)]));
  return value;
}

async function compact(sessionId) {
  const callCount = Object.values(stats.calls).reduce((sum, count) => sum + count, 0);
  const old = stats.compactionGuidance;
  await request(`/session/${sessionId}/summarize`, { method: "POST", body: JSON.stringify({ providerID, modelID, auto: false }) });
  assert(stats.compactionGuidance > old, "Native compaction request did not contain public Penny guidance");
  assert.equal(Object.values(stats.calls).reduce((sum, count) => sum + count, 0), callCount, "Verification compaction unexpectedly invoked a tool");
  const messages = await request(`/session/${sessionId}/message`);
  assert(messages.some((m) => m.info?.summary && m.parts.some((p) => p.type === "text" && /Penny/.test(p.text))), "Compaction summary did not retain public guidance");
  secretFree("native-compaction", { publicGuidance: true, toolsInvoked: 0 });
}

async function live() {
  const auth = await nativeAuthMetadata();
  secretFree("native-oauth-state", auth);
  assert(auth.serverMatches && auth.accessPresent && !auth.expired, "Native Penny OAuth credentials are absent or expired. Public MCP connected status alone does not prove authentication; authenticate using X-MyPenny-Require-Auth:true.");
  const status = await request("/mcp");
  assert.equal(status.penny?.status, "connected", "Native Penny MCP is not connected. Authenticate via isolated opencode mcp auth penny first.");
  mainSession = await session();
  const unenabled = await turn(mainSession.id, { name: "penny_penny_read", args: { target: "notes", scope: "private", limit: 1, query: "penny-opencode-denied-verification" } });
  assert.equal(toolPart(unenabled, "penny_penny_read").state.status, "error", "Unenabled session unexpectedly reached Penny");
  const missingAcknowledgement = await turn(mainSession.id, { name: "penny_enable", args: { acknowledgement: false } });
  assert.equal(toolPart(missingAcknowledgement, "penny_enable").state.status, "error", "Missing acknowledgement unexpectedly enabled Penny");
  assert.equal(missingAcknowledgement.permissions.length, 0, "Missing acknowledgement reached the native permission prompt");
  const rejected = await turn(mainSession.id, { name: "penny_enable", args: { acknowledgement: true } }, "reject");
  assert(rejected.permissions.length > 0, "Native enable permission was not requested");
  assert.equal(toolPart(rejected, "penny_enable").state.status, "error", "Rejected enable unexpectedly succeeded");
  const enabled = await turn(mainSession.id, { name: "penny_enable", args: { acknowledgement: true } });
  outputOf(toolPart(enabled, "penny_enable"));
  assert(enabled.permissions.length > 0, "Native enable permission was not requested");
  secretFree("native-session-enable", { unenabledBlocked: true, rejectBlocked: true, acceptedOnce: true });

  const childSession = await session({ parentID: mainSession.id });
  const childEnable = await turn(childSession.id, { name: "penny_enable", args: { acknowledgement: true } });
  assert.equal(toolPart(childEnable, "penny_enable").state.status, "error", "Child session unexpectedly enabled Penny");
  const childRead = await turn(childSession.id, { name: "penny_penny_read", args: { target: "notes", scope: "private", limit: 1, query: "penny-opencode-denied-verification" } });
  assert.equal(toolPart(childRead, "penny_penny_read").state.status, "error", "Child session unexpectedly read Penny");
  secretFree("native-child-gate", { enabledBlocked: true, readBlocked: true });

  // Deliberately use a unique harmless note. No profile/session_start/private search.
  const marker = `Penny OpenCode synthetic verification ${randomUUID()}`;
  const note = { content: `${marker}. This temporary synthetic note verifies the OpenCode integration only.`, confidence: 0.8, tags: ["plugin-verification"],
    source: "Penny OpenCode native loopback verification", sampleQuestions: [
      `What does ${marker} verify?`, `Which integration created ${marker}?`, `Is ${marker} temporary?`,
    ] };
  const write = await turn(mainSession.id, { name: "penny_penny_write", args: {
    entityType: "note", scope: "private", notes: [JSON.stringify(note)],
  } });
  const saved = unpack(outputOf(toolPart(write, "penny_penny_write")));
  const found = walk(saved, (v) => v && typeof v === "object" && Array.isArray(v.ok) && v.ok.length === 1 && typeof v.ok[0] === "string" && Array.isArray(v.failed));
  syntheticNoteId = found?.ok[0];
  assert(syntheticNoteId, "Native write returned no synthetic note ID (payload withheld)");
  assert.equal(found.failed.length, 0, "Native write reported a partial failure");
  // depth > 1 uses the graph reader; maxNodes:1 returns this seed only, no neighbors.
  const read = await turn(mainSession.id, { name: "penny_penny_read", args: { target: "note_links", scope: "private", seedIds: [syntheticNoteId], depth: 2, maxNodes: 1 } });
  const readback = unpack(outputOf(toolPart(read, "penny_penny_read")));
  const graph = walk(readback, (v) => v && typeof v === "object" && Array.isArray(v.nodes));
  assert.equal(graph?.nodes.length, 1, "Exact-ID readback did not return exactly the synthetic note");
  assert.equal(graph.nodes[0].id, syntheticNoteId, "Readback returned a different note ID");
  assert.equal(graph.nodes[0].content, note.content, "Native note readback did not match synthetic content");
  secretFree("native-penny-roundtrip", { write: true, readback: true, syntheticNoteId });
  await cleanupNote();
  await compact(mainSession.id);
  const disabled = await turn(mainSession.id, { name: "penny_disable", args: {} });
  outputOf(toolPart(disabled, "penny_disable"));
  const afterDisable = await turn(mainSession.id, { name: "penny_penny_read", args: { target: "note_links", scope: "private", seedIds: [syntheticNoteId], depth: 2, maxNodes: 1 } });
  assert.equal(toolPart(afterDisable, "penny_penny_read").state.status, "error", "Disabled session unexpectedly reached Penny");
  secretFree("native-session-disable", { blocked: true });
}

async function cleanupNote() {
  if (!syntheticNoteId || cleanupComplete || !mainSession) return;
  const deleted = await turn(mainSession.id, { name: "penny_penny_delete", args: { entityType: "note", scope: "private", ids: [syntheticNoteId] } });
  const response = unpack(outputOf(toolPart(deleted, "penny_penny_delete")));
  const receipt = walk(response, (v) => v && typeof v === "object" && Array.isArray(v.ok) && v.ok.includes(syntheticNoteId) && Array.isArray(v.failed));
  assert(receipt && receipt.failed.length === 0, "Penny delete did not confirm synthetic note removal");
  cleanupComplete = true;
  const check = await turn(mainSession.id, { name: "penny_penny_read", args: { target: "note_links", scope: "private", seedIds: [syntheticNoteId], depth: 2, maxNodes: 1 } });
  const graph = walk(unpack(outputOf(toolPart(check, "penny_penny_read"))), (v) => v && typeof v === "object" && Array.isArray(v.nodes));
  assert.equal(graph?.nodes.length, 0, "Soft-deleted synthetic note remained visible");
  secretFree("synthetic-note-cleanup", { completed: true, syntheticNoteId });
}

async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((done) => child.once("exit", done)), sleep(5_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (provider) { provider.closeAllConnections(); await new Promise((done) => provider.close(done)); }
}

try {
  assert(["--prepare", "--host", "--live"].includes(mode), "Usage: node scripts/verify-host.mjs --prepare|--host|--live");
  await readFile(resolve(root, "dist/index.js"));
  if (mode === "--prepare") {
    await prepare();
    secretFree("isolated-config-ready", { configFile, workspace: cwd, hostVersion: "1.18.35" });
  } else {
    await prepare(await modelServer());
    await start();
    const config = await request("/config");
    assert.equal(config.mcp?.penny?.url, "https://app.mypenny.ai/mcp", "Plugin did not configure the pinned production MCP URL");
    assert.equal(config.mcp?.penny?.type, "remote", "Plugin did not configure native remote MCP");
    assert.deepEqual(config.mcp?.penny?.headers, { "X-MyPenny-Require-Auth": "true" }, "Plugin did not require native discovery authentication");
    secretFree("native-loader", { plugin: true, productionMcp: true, hostVersion: "1.18.35" });
    if (mode === "--live") await live();
    else { const smoke = await session(); await turn(smoke.id); assert(stats.systemGuidance > 0, "Native system transform omitted Penny guidance"); await compact(smoke.id); }
    secretFree("complete", { mode: mode.slice(2), modelRequests: stats.modelRequests, systemGuidanceRequests: stats.systemGuidance, compactionGuidanceRequests: stats.compactionGuidance, cleanupComplete });
  }
} catch (error) {
  // Do not print native tool outputs, memory, token material, or model requests.
  secretFree("failed", { reason: error instanceof assert.AssertionError ? error.message : (error instanceof Error && /^(Native|Usage:)/.test(error.message) ? error.message : "Verification failed; payload withheld") });
  try { await cleanupNote(); } catch { secretFree("synthetic-note-cleanup", { completed: false, syntheticNoteId: syntheticNoteId ?? null }); }
  process.exitCode = 1;
} finally { await stop(); }
