import { formatInTimeZone } from "./format.js";
import type { OffpeakClientStatus, OffpeakRpcInput, OffpeakRpcOutput } from "./rpc.js";

/**
 * The interactive interface a command was issued from. `/offpeak on|off`
 * changes this interface's own persistent global default; a CLI command never
 * changes the Desktop default through that shorthand (use `desktop on|off`
 * explicitly).
 */
export type OffpeakSurface = "cli" | "desktop";

export interface OffpeakCommandContext {
  surface: OffpeakSurface;
  /** The focused interactive session, resolved by the host extension. */
  sessionID?: string;
  providerID?: string;
  modelID?: string;
}

export interface OffpeakRpcCaller {
  control(input: OffpeakRpcInput): Promise<unknown>;
}

export type OffpeakCommandKind = "status" | "client-global" | "chat" | "pricing";

export interface OffpeakCommandPlan {
  request: OffpeakRpcInput;
  kind: OffpeakCommandKind;
  surface: OffpeakSurface;
  direction?: "on" | "off" | "auto";
  /** The client whose global this command changes, when it is not the surface. */
  client?: "cli" | "desktop";
}

export interface OffpeakCommandResult {
  plan: OffpeakCommandPlan;
  output: OffpeakRpcOutput;
  /** User-facing text shared by the CLI toast and the Desktop toast. */
  text: string;
}

type Direction = "on" | "off";

function isDirection(value: string | undefined): value is Direction {
  return value === "on" || value === "off";
}

function surfaceLabel(surface: OffpeakSurface): string {
  return surface === "cli" ? "CLI" : "Desktop";
}

function withSession(context: OffpeakCommandContext): { sessionID?: string } {
  return context.sessionID ? { sessionID: context.sessionID } : {};
}

function withModel(context: OffpeakCommandContext): {
  providerID?: string;
  modelID?: string;
} {
  return {
    ...(context.providerID ? { providerID: context.providerID } : {}),
    ...(context.modelID ? { modelID: context.modelID } : {}),
  };
}

function statusRequest(context: OffpeakCommandContext): OffpeakRpcInput {
  return { action: "status", ...withSession(context), ...withModel(context) };
}

function clientRequest(context: OffpeakCommandContext): OffpeakRpcInput {
  return { action: "client", ...withSession(context) };
}

/**
 * Parses one `/offpeak` invocation. The TUI passes the full slash text; the
 * Desktop slash command receives the argument text after `/offpeak`.
 *
 * Canonical grammar:
 *   /offpeak                      status
 *   /offpeak on | off             this surface's global default
 *   /offpeak chat on|off|auto     this chat only
 *   /offpeak cli on|off           CLI global explicitly
 *   /offpeak desktop on|off       Desktop global explicitly
 *   /offpeak pricing              pricing status
 *
 * The v0.4.x `protection …`, `client …`, and `session …` forms remain hidden
 * aliases so existing muscle memory keeps working; they are intentionally not
 * advertised.
 */
export function planOffpeakCommand(
  rawInput: string,
  context: OffpeakCommandContext,
): OffpeakCommandPlan {
  const input = (rawInput ?? "").trim().replace(/^\/(?:offpeak|op)(?=\s|$)\s*/i, "");
  const space = input.indexOf(" ");
  const action = (space < 0 ? input : input.slice(0, space)).toLowerCase() || "status";
  const argument = space < 0 ? "" : input.slice(space + 1).trim();

  if (action === "status" || action === "pricing" || action === "help") {
    return {
      request: statusRequest(context),
      kind: action === "pricing" ? "pricing" : "status",
      surface: context.surface,
    };
  }

  if (isDirection(action) && argument === "") {
    return {
      request: {
        action: "client-set",
        client: context.surface,
        protection: action,
        ...withSession(context),
      },
      kind: "client-global",
      surface: context.surface,
      direction: action,
      client: context.surface,
    };
  }

  if (action === "chat" || action === "session") {
    const direction = (argument || (action === "session" ? "" : "status")).toLowerCase();
    if (direction === "" || direction === "status") {
      return { request: clientRequest(context), kind: "chat", surface: context.surface };
    }
    if (direction !== "on" && direction !== "off" && direction !== "auto") {
      throw new Error("Usage: /offpeak chat on|off|auto");
    }
    if (!context.sessionID) {
      throw new Error("Open this chat before changing its off-peak protection.");
    }
    return {
      request: {
        action: "session-set",
        sessionID: context.sessionID,
        protection: direction,
      },
      kind: "chat",
      surface: context.surface,
      direction,
    };
  }

  if (action === "cli" || action === "desktop") {
    if (!isDirection(argument)) {
      throw new Error(`Usage: /offpeak ${action} on|off`);
    }
    return {
      request: {
        action: "client-set",
        client: action,
        protection: argument,
        ...withSession(context),
      },
      kind: "client-global",
      surface: context.surface,
      direction: argument,
      client: action,
    };
  }

  // Hidden v0.4.x aliases.
  if (action === "protection") {
    const parts = argument.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return { request: clientRequest(context), kind: "status", surface: context.surface };
    }
    const [scope, direction] = parts;
    if (scope === "global" && parts.length === 2 && isDirection(direction)) {
      return {
        request: {
          action: "client-set",
          client: context.surface,
          protection: direction,
          ...withSession(context),
        },
        kind: "client-global",
        surface: context.surface,
        direction,
        client: context.surface,
      };
    }
    if (scope === "chat" && parts.length === 2) {
      const chatDirection = direction === "auto" ? "auto" : isDirection(direction) ? direction : "";
      if (!chatDirection) throw new Error("Usage: /offpeak chat on|off|auto");
      if (!context.sessionID) {
        throw new Error("Open this chat before changing its off-peak protection.");
      }
      return {
        request: {
          action: "session-set",
          sessionID: context.sessionID,
          protection: chatDirection,
        },
        kind: "chat",
        surface: context.surface,
        direction: chatDirection,
      };
    }
    throw new Error("Usage: /offpeak chat on|off|auto");
  }

  if (action === "client") {
    const parts = argument.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return { request: clientRequest(context), kind: "status", surface: context.surface };
    }
    const [who, direction] = parts;
    if (parts.length !== 2 || (who !== "cli" && who !== "desktop") || !isDirection(direction)) {
      throw new Error("Usage: /offpeak cli on|off or /offpeak desktop on|off");
    }
    return {
      request: {
        action: "client-set",
        client: who,
        protection: direction,
        ...withSession(context),
      },
      kind: "client-global",
      surface: context.surface,
      direction,
      client: who,
    };
  }

  throw new Error(
    "Usage: /offpeak status | /offpeak on | /offpeak off | /offpeak chat on|off|auto | /offpeak cli on|off | /offpeak desktop on|off",
  );
}

interface StatusShape {
  enabled?: boolean;
  clientDefaults?: { cli?: string; desktop?: string };
  client?: {
    ownership?: string;
    protection?: string;
    source?: string;
    override?: string;
  };
  effectiveProtection?: string;
  providerID?: string;
  modelID?: string;
  policyID?: string;
  pricingState?: string;
  requestsAllowed?: boolean;
  nextTransition?: number;
  providerNote?: string;
  displayTimeZone?: string;
  interactiveWaiting?: number;
  recoveryWaiting?: number;
  compactionRecoveryWaiting?: number;
  configError?: string;
}

function surfaceName(surface: string | undefined): string {
  if (surface === "cli") return "CLI";
  if (surface === "desktop") return "Desktop";
  return "unknown";
}

/** The chat's effective state, with the global it follows when it has no override. */
function chatLabel(
  client: StatusShape["client"] | undefined,
  defaults: StatusShape["clientDefaults"],
): string {
  if (!client) return "no chat focused";
  if (
    client.override === "on" ||
    (client.source === "session-override" && client.protection === "ON")
  ) {
    return "always protect (explicit)";
  }
  if (
    client.override === "off" ||
    (client.source === "session-override" && client.protection === "OFF")
  ) {
    return "allow peak (explicit)";
  }
  if (client.source === "client-default") {
    const owner = client.ownership === "desktop" ? "desktop" : "cli";
    return `follows the ${surfaceName(owner)} global (${defaults?.[owner] ?? client.protection ?? "ON"})`;
  }
  return "protected (no client registration yet)";
}

export function formatOffpeakStatus(
  rawStatus: Record<string, unknown> | undefined,
  context: OffpeakCommandContext,
): string {
  if (!rawStatus) return "No Offpeak status was returned.";
  const status = rawStatus as StatusShape;
  const pricing = status.pricingState ?? "UNKNOWN";
  const next =
    status.nextTransition && status.displayTimeZone
      ? formatInTimeZone(status.nextTransition, status.displayTimeZone)
      : pricing === "FLAT" || pricing === "UNTRACKED"
        ? "none (no peak window)"
        : "unknown";
  const detail =
    pricing === "FLAT"
      ? " (flat all-hours pricing; never waits)"
      : pricing === "UNTRACKED"
        ? status.providerNote
          ? ` (no policy needed: ${status.providerNote})`
          : " (untracked provider; no policy installed)"
        : pricing === "UNKNOWN"
          ? " (no verified pricing policy for this model)"
          : "";
  const defaults = status.clientDefaults;
  return [
    `CLI protection: ${defaults?.cli ?? "ON"}`,
    `Desktop protection: ${defaults?.desktop ?? "ON"}`,
    `This chat: ${chatLabel(status.client, defaults)}`,
    `Pricing: ${pricing}${detail}`,
    `Requests: ${status.requestsAllowed ? "ALLOWED" : "BLOCKED"}`,
    `Next transition: ${next}`,
    status.interactiveWaiting
      ? `Waiting: ${status.interactiveWaiting} request${status.interactiveWaiting === 1 ? "" : "s"} for off-peak`
      : "",
    status.recoveryWaiting
      ? `Recovery: ${status.recoveryWaiting} session${status.recoveryWaiting === 1 ? "" : "s"} waiting for off-peak`
      : "",
    status.compactionRecoveryWaiting
      ? `Compaction recovery: ${status.compactionRecoveryWaiting} session${status.compactionRecoveryWaiting === 1 ? "" : "s"}`
      : "",
    status.configError ? `Config error: ${status.configError}` : "",
    `Surface: ${surfaceLabel(context.surface)} · change this global with /offpeak on|off · this chat with /offpeak chat on|off|auto`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatClientGlobal(plan: OffpeakCommandPlan, output: OffpeakRpcOutput): string {
  const defaults = output.client?.defaults;
  const target = plan.client ?? plan.surface;
  const other = target === "cli" ? "desktop" : "cli";
  const own = defaults ? defaults[target] : plan.direction === "off" ? "OFF" : "ON";
  return [
    `${surfaceLabel(target)} protection: ${own}`,
    `${surfaceLabel(other)} protection: ${defaults ? defaults[other] : "unknown"} (not modified)`,
    `Applies to ${target === "cli" ? "CLI" : "Desktop"} chats without an explicit per-chat setting.`,
  ].join("\n");
}

function formatChat(plan: OffpeakCommandPlan, output: OffpeakRpcOutput): string {
  const client = output.client;
  const session = client?.session;
  const defaults = client?.defaults;
  if (!session) {
    return plan.direction === "auto"
      ? "This chat now follows its client global."
      : plan.direction === "on"
        ? "This chat is now always protected."
        : plan.direction === "off"
          ? "This chat may now use verified peak pricing."
          : "No chat is focused.";
  }
  const state =
    session.source === "session-override"
      ? session.protection === "ON"
        ? "always protect (explicit)"
        : "allow peak (explicit)"
      : session.source === "client-default"
        ? `follows the ${surfaceName(session.ownership)} global (${session.protection})`
        : "protected (no client registration yet)";
  return [
    `This chat: ${state}`,
    `Effective protection: ${session.protection}`,
    `CLI protection: ${defaults?.cli ?? "ON"} (unchanged)`,
    `Desktop protection: ${defaults?.desktop ?? "ON"} (unchanged)`,
    session.protection === "OFF"
      ? "Verified peak-priced requests may run immediately in this chat."
      : "Verified peak-priced requests wait for off-peak and continue automatically.",
  ].join("\n");
}

export function formatOffpeakResult(
  plan: OffpeakCommandPlan,
  output: OffpeakRpcOutput,
  context: OffpeakCommandContext,
): string {
  switch (plan.kind) {
    case "client-global":
      return formatClientGlobal(plan, output);
    case "chat":
      return formatChat(plan, output);
    case "pricing":
    case "status":
    default:
      if (output.status) return formatOffpeakStatus(output.status, context);
      if (output.client) return formatChat(plan, output);
      return output.message ?? "No Offpeak state was returned.";
  }
}

/**
 * Runs one parsed command against the caller's server RPC. The TUI and GUI pass
 * their own supported RPC client and their own surface, so there is exactly one
 * command implementation and no duplicated protection logic.
 */
export async function runOffpeakCommand(
  caller: OffpeakRpcCaller,
  rawInput: string,
  context: OffpeakCommandContext,
): Promise<OffpeakCommandResult> {
  const plan = planOffpeakCommand(rawInput, context);
  const output = (await caller.control(plan.request)) as OffpeakRpcOutput;
  return { plan, output, text: formatOffpeakResult(plan, output, context) };
}

export type { OffpeakClientStatus };
