import type { Config } from "@opencode-ai/plugin";

const PENNY_MCP_URL = "https://app.mypenny.ai/mcp";
const AUTH_CHALLENGE_HEADER = "X-MyPenny-Require-Auth";

function authChallengeHeaders(): Record<string, string> {
  // Public metadata endpoints are readable without OAuth. This nonsecret Penny
  // header makes native MCP clients receive the authentication challenge.
  return { [AUTH_CHALLENGE_HEADER]: "true" };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Add the public connection without replacing an existing owner's settings. */
export function configurePenny(config: Config): void {
  // The released plugin's legacy SDK types omit arbitrary native permissions.
  const values = config as unknown as Record<string, unknown>;
  const mcp = values.mcp;
  if (mcp !== undefined && !record(mcp)) throw configurationError();
  const existing = record(mcp) ? mcp.penny : undefined;
  if (existing !== undefined) {
    if (!record(existing) || existing.type !== "remote" || existing.url !== PENNY_MCP_URL) {
      throw configurationError();
    }
    if (existing.headers !== undefined) {
      if (!record(existing.headers)) throw configurationError();
      const keys = Object.keys(existing.headers);
      if (keys.length > 0 && (keys.length !== 1 || keys[0] !== AUTH_CHALLENGE_HEADER || existing.headers[AUTH_CHALLENGE_HEADER] !== "true")) {
        throw configurationError();
      }
    }
    if (existing.oauth !== undefined && (!record(existing.oauth) || Object.keys(existing.oauth).length > 0)) {
      throw configurationError();
    }
    if (existing.environment !== undefined || existing.command !== undefined) throw configurationError();
  }

  const permission = values.permission;
  if (permission !== undefined && typeof permission !== "string" && !record(permission)) throw configurationError();
  values.mcp = {
    ...(record(mcp) ? mcp : {}),
    penny: {
      ...(record(existing) ? existing : { type: "remote", url: PENNY_MCP_URL }),
      headers: authChallengeHeaders(),
    },
  };
  if (permission === undefined) values.permission = { "penny_*": "ask" };
  else if (record(permission) && permission["*"] === undefined) {
    // Existing specific rules remain later in the host's last-match-wins order.
    values.permission = { "penny_*": "ask", ...permission };
  }
}

export function configurationError(): Error {
  return new Error("Penny configuration conflicts with the public OAuth connection. Resolve the penny MCP entry before enabling Penny.");
}

export function privateRootSession(
  session: unknown,
  expected: { sessionID: string; projectID: string; directory: string },
): boolean {
  return record(session)
    && session.id === expected.sessionID
    && session.projectID === expected.projectID
    && session.directory === expected.directory
    && session.parentID === undefined
    && session.share === undefined;
}
