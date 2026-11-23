import { formatInTimeZone } from "./format.js";
import type { OffpeakClientStatus, OffpeakRpcInput, OffpeakRpcOutput } from "./rpc.js";

/**
 * The interactive interface a command was issued from. The global protection
 * command always targets this interface's own default; a CLI command can never
 * change the Desktop default (and the reverse) through this surface.
 */
export type OffpeakSurface = "cli" | "desktop";

export interface OffpeakCommandContext {
  surface: OffpeakSurface;
  /** The focused interactive session, resolved by the host extension. */
  sessionID?: string;
  providerID?: string;
  modelID?: string;
  cwd?: string;
}

export interface OffpeakRpcCaller {
  control(input: OffpeakRpcInput): Promise<unknown>;
}

export type OffpeakCommandKind =
  | "status"
  | "protection-global"
  | "protection-chat"
  | "client"
  | "session"
  | "queue"
  | "list"
  | "task"
  | "pricing"
  | "automation"
  | "other";

export interface OffpeakCommandPlan {
  request: OffpeakRpcInput;
  kind: OffpeakCommandKind;
  surface: OffpeakSurface;
  direction?: "on" | "off";
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

function otherSurface(surface: OffpeakSurface): OffpeakSurface {
  return surface === "cli" ? "desktop" : "cli";
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

function clientStatusRequest(context: OffpeakCommandContext): OffpeakRpcInput {
  return { action: "client", ...withSession(context) };
}

function statusRequest(context: OffpeakCommandContext): OffpeakRpcInput {
  return { action: "status", ...withSession(context), ...withModel(context) };
}

/**
 * Parses one `/offpeak` invocation. The TUI passes the full slash text; the
 * Desktop slash command receives the argument text after `/offpeak`.
 *
 * This is the single command grammar for both interfaces. It returns a typed
 * RPC request and never writes state itself, so the TUI and Desktop share the
 * same behavior and only differ in the surface passed in.
 */
export function planOffpeakCommand(
  rawInput: string,
  context: OffpeakCommandContext,
): OffpeakCommandPlan {
  const input = (rawInput ?? "").trim().replace(/^\/(?:offpeak|op)(?=\s|$)\s*/i, "");
  const space = input.indexOf(" ");
  const action = (space < 0 ? input : input.slice(0, space)).toLowerCase() || "status";
  const argument = space < 0 ? "" : input.slice(space + 1).trim();

  if (action === "protection") {
    const parts = argument.toLowerCase().split(/\s+/).filter(Boolean);
    // `/offpeak protection` without arguments is a read-only status.
    if (parts.length === 0) {
      return { request: clientStatusRequest(context), kind: "client", surface: context.surface };
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
        kind: "protection-global",
        surface: context.surface,
        direction,
      };
    }
    if (scope === "chat" && parts.length === 2 && isDirection(direction)) {
      if (!context.sessionID) {
        throw new Error(
          "No current OpenCode session is focused. Open this chat and run /offpeak protection chat on|off again.",
        );
      }
      return {
        request: {
          action: direction === "off" ? "session-off" : "session-on",
          sessionID: context.sessionID,
        },
        kind: "protection-chat",
        surface: context.surface,
        direction,
      };
    }
    throw new Error("Usage: /offpeak protection global on|off or /offpeak protection chat on|off");
  }

  // Legacy aliases remain available. They target the same server actions and
  // the same persisted state as the canonical `/offpeak protection` commands.
  if (action === "client") {
    const parts = argument.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return { request: clientStatusRequest(context), kind: "client", surface: context.surface };
    }
    const [who, direction] = parts;
    if (parts.length !== 2 || (who !== "cli" && who !== "desktop") || !isDirection(direction)) {
      throw new Error(
        "Usage: /offpeak client, /offpeak client cli on|off, or /offpeak client desktop on|off",
      );
    }
    return {
      request: {
        action: "client-set",
        client: who,
        protection: direction,
        ...withSession(context),
      },
      kind: "client",
      surface: context.surface,
    };
  }

  if (action === "session") {
    const direction = argument.toLowerCase();
    if (!isDirection(direction)) {
      throw new Error("Usage: /offpeak session on|off");
    }
    if (!context.sessionID) {
      throw new Error(
        "No current OpenCode session is focused. Open the session and run /offpeak session on|off again.",
      );
    }
    return {
      request: {
        action: direction === "off" ? "session-off" : "session-on",
        sessionID: context.sessionID,
      },
      kind: "session",
      surface: context.surface,
      direction,
    };
  }

  if (action === "queue") {
    if (!argument) throw new Error("Usage: /offpeak queue <task>");
    if (!context.modelID || !context.providerID) {
      throw new Error("Select an OpenCode model before queueing a task.");
    }
    return {
      request: {
        action,
        prompt: argument,
        ...(context.cwd ? { cwd: context.cwd } : {}),
        providerID: context.providerID,
        modelID: context.modelID,
      },
      kind: "queue",
      surface: context.surface,
    };
  }

  if (["cancel", "remove", "retry", "resume", "run-now"].includes(action)) {
    if (!argument) throw new Error(`Usage: /offpeak ${action} <task-id>`);
    return {
      request: { action, id: argument },
      kind: "task",
      surface: context.surface,
    };
  }

  if (action === "list") {
    return { request: { action }, kind: "list", surface: context.surface };
  }

  if (action === "status") {
    return { request: statusRequest(context), kind: "status", surface: context.surface };
  }

  if (action === "pricing") {
    return {
      request: { action, ...withSession(context), ...withModel(context) },
      kind: "pricing",
      surface: context.surface,
    };
  }

  if (action === "on" || action === "off") {
    return {
      request: { action, ...withSession(context), ...withModel(context) },
      kind: "automation",
      surface: context.surface,
    };
  }

  return {
    request: { action, ...withSession(context), ...withModel(context) },
    kind: "other",
    surface: context.surface,
  };
}

function statusOf(output: OffpeakRpcOutput): Record<string, unknown> | undefined {
  return output.status;
}

function clientStatus(output: OffpeakRpcOutput): OffpeakClientStatus | undefined {
  return output.client;
}

interface StatusShape {
  enabled?: boolean;
  mode?: string;
  automaticExecution?: string;
  automaticResume?: string;
  override?: { active?: boolean; taskID?: string; expiresAt?: string };
  sessionProtection?: string;
  clientDefaults?: { cli?: string; desktop?: string };
  client?: {
    ownership?: string;
    protection?: string;
    source?: string;
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
  queued?: number;
  waiting?: number;
  interactiveWaiting?: number;
  recoveryWaiting?: number;
  compactionRecoveryWaiting?: number;
  running?: { id?: string; sessionID?: string; state?: string };
  failed?: number;
  configError?: string;
}

function ownershipName(ownership: string | undefined): string {
  switch (ownership) {
    case "cli":
      return "CLI";
    case "desktop":
      return "Desktop";
    case "ambiguous":
      return "shared (CLI + Desktop; protected)";
    case "queue":
      return "queue task (client defaults do not apply)";
    default:
      return "unknown (protected)";
  }
}

function sourceName(source: string | undefined): string {
  switch (source) {
    case "session-override":
      return "explicit /offpeak protection chat off";
    case "client-default":
      return "interface global default";
    case "ambiguous":
      return "shared ownership; fail-closed";
    case "queue":
      return "queue task; explicit task override only";
    default:
      return "no reliable client registration; fail-closed";
  }
}

/**
 * Human-readable state of the current chat. `sessionProtection` alone cannot
 * distinguish "follows the global" from "explicitly disabled", so the
 * authoritative client status supplies the source.
 */
function chatProtectionLabel(
  session: { ownership?: string; protection?: string; source?: string } | undefined,
  defaults: { cli?: string; desktop?: string } | undefined,
): string {
  if (!session) return "unknown (protected)";
  if (session.source === "session-override") {
    return `OFF (explicit override; bypasses the ${ownershipName(session.ownership)} global)`;
  }
  if (session.source === "client-default") {
    const owner = session.ownership === "desktop" ? "Desktop" : "CLI";
    const value = owner === "Desktop" ? defaults?.desktop : defaults?.cli;
    return `follows the ${owner} global (${value ?? session.protection ?? "ON"})`;
  }
  if (session.source === "queue") return "queue task; client defaults do not apply";
  if (session.source === "ambiguous") return "ON (shared session; fail-closed)";
  return "ON (no reliable client registration; fail-closed)";
}

function formatClientInfo(client: OffpeakClientStatus | undefined): string {
  if (!client) return "Client settings are unavailable.";
  const { defaults, session, error } = client;
  const lines = [
    "Client-level off-peak protection",
    `CLI default: ${defaults.cli}`,
    `Desktop default: ${defaults.desktop}`,
  ];
  if (session) {
    lines.push(
      `This session: ${ownershipName(session.ownership)}`,
      `Effective protection: ${session.protection}`,
      `Source: ${sourceName(session.source)}`,
      `Session override: ${session.source === "session-override" ? "OFF (explicit)" : "not set"}`,
    );
  } else {
    lines.push("This session: none focused");
  }
  if (error) lines.push(`Client settings error: ${error}`);
  lines.push(
    "CLI and Desktop defaults are independent. Change this interface with /offpeak protection global on|off; change this chat with /offpeak protection chat on|off.",
  );
  return lines.join("\n");
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
  const sessionOverride = status.effectiveProtection === "OFF" && pricing === "PEAK";
  const requestDetail = sessionOverride
    ? status.client?.source === "client-default"
      ? " (interface default)"
      : " (chat override)"
    : pricing === "FLAT"
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
    `Plugin: ${status.enabled ? "ENABLED" : "DISABLED"}`,
    `Mode: ${status.mode ?? "unknown"}`,
    `Automatic execution: ${status.automaticExecution ?? "PAUSED"}`,
    `Automatic resume: ${status.automaticResume ?? "PAUSED"}`,
    `Override: ${status.override?.active ? `ON for ${status.override.taskID} until ${status.override.expiresAt}` : "OFF"}`,
    `Provider/model: ${status.providerID ?? "unknown"}/${status.modelID ?? "unknown"}`,
    `Policy: ${status.policyID ?? (pricing === "UNKNOWN" ? "none (model not in any verified policy)" : "none")}`,
    `Pricing: ${pricing}`,
    defaults
      ? `Client defaults: CLI ${defaults.cli ?? "ON"}, Desktop ${defaults.desktop ?? "ON"}`
      : "",
    defaults ? `CLI global protection: ${defaults.cli ?? "ON"}` : "",
    defaults ? `Desktop global protection: ${defaults.desktop ?? "ON"}` : "",
    status.client ? `Client ownership: ${status.client.ownership ?? "unknown"}` : "",
    status.sessionProtection ? `Session protection (explicit): ${status.sessionProtection}` : "",
    status.client
      ? `Protection for this chat: ${chatProtectionLabel(status.client, defaults)}`
      : "",
    status.effectiveProtection
      ? `Effective protection: ${status.effectiveProtection}${status.client?.source ? ` (${status.client.source})` : ""}`
      : "",
    `Requests: ${status.requestsAllowed ? "ALLOWED" : "BLOCKED"}${requestDetail}`,
    `Next transition: ${next}`,
    `Queue: ${status.queued ?? 0} queued, ${status.waiting ?? 0} waiting, ${status.failed ?? 0} failed`,
    status.interactiveWaiting
      ? `Interactive: ${status.interactiveWaiting} request${status.interactiveWaiting === 1 ? "" : "s"} waiting for off-peak`
      : "",
    status.recoveryWaiting
      ? `Recovery: ${status.recoveryWaiting} session${status.recoveryWaiting === 1 ? "" : "s"} waiting for off-peak`
      : "",
    status.compactionRecoveryWaiting
      ? `Compaction recovery: ${status.compactionRecoveryWaiting} session${status.compactionRecoveryWaiting === 1 ? "" : "s"} waiting for off-peak`
      : "",
    `Running: ${status.running?.id ?? "none"}${status.running?.sessionID ? ` (session ${status.running.sessionID})` : ""}`,
    status.configError ? `Config error: ${status.configError}` : "",
    status.enabled
      ? ""
      : "Queued tasks and sessions are preserved. Peak-price execution is still blocked; OFF is not an override.",
    `This surface: ${surfaceLabel(context.surface)}. Session-level control here is /offpeak protection chat on|off.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatProtectionGlobal(plan: OffpeakCommandPlan, output: OffpeakRpcOutput): string {
  const defaults = output.client?.defaults;
  const other = otherSurface(plan.surface);
  const own = defaults ? defaults[plan.surface] : plan.direction === "off" ? "OFF" : "ON";
  const lines = [
    `${surfaceLabel(plan.surface)} global protection: ${own}`,
    `${surfaceLabel(other)} global protection: ${defaults ? defaults[other] : "unknown"} (not modified)`,
    plan.surface === "cli"
      ? "Applies to CLI sessions without an explicit per-chat override."
      : "Applies to Desktop sessions without an explicit per-chat override.",
    "Queued tasks keep their existing queue behavior; this setting never adopts or starts a queue task.",
  ];
  if (output.client?.error) lines.push(`Client settings error: ${output.client.error}`);
  return lines.join("\n");
}

function formatProtectionChat(plan: OffpeakCommandPlan, output: OffpeakRpcOutput): string {
  const client = output.client;
  const session = client?.session;
  const defaults = client?.defaults;
  if (!session) {
    return (
      output.message ??
      `Protection for this chat: ${plan.direction === "off" ? "OFF" : "follows the interface global"}.`
    );
  }
  const label =
    session.source === "session-override"
      ? "OFF (explicit override for this chat only)"
      : session.source === "client-default"
        ? `follows the ${session.ownership === "desktop" ? "Desktop" : "CLI"} global (${session.protection})`
        : session.source === "queue"
          ? "queue task; client defaults do not apply"
          : session.source === "ambiguous"
            ? "ON (shared session; fail-closed)"
            : "ON (no reliable client registration; fail-closed)";
  const lines = [
    `Protection for this chat: ${label}`,
    `Effective protection: ${session.protection}`,
  ];
  if (defaults) {
    lines.push(
      `${surfaceLabel(plan.surface)} global protection: ${defaults[plan.surface]} (not modified)`,
      `${surfaceLabel(otherSurface(plan.surface))} global protection: ${defaults[otherSurface(plan.surface)]} (not modified)`,
    );
  }
  if (session.source === "session-override") {
    lines.push("This chat may use verified peak-priced inference; other chats are unchanged.");
  }
  lines.push(
    "Queued tasks keep their existing queue behavior; this setting never adopts or starts a queue task.",
  );
  return lines.join("\n");
}

function formatTasks(tasks: unknown[] | undefined): string {
  if (!tasks?.length) return "Queue is empty.";
  return tasks
    .map((raw) => {
      const task = raw as { id?: string; state?: string; sessionID?: string; lastError?: string };
      return `${task.id ?? "?"} ${task.state ?? "UNKNOWN"}${task.sessionID ? ` session=${task.sessionID}` : ""}${task.lastError ? ` error=${task.lastError}` : ""}`;
    })
    .join("\n");
}

export function formatOffpeakResult(
  plan: OffpeakCommandPlan,
  output: OffpeakRpcOutput,
  context: OffpeakCommandContext,
): string {
  switch (plan.kind) {
    case "status":
      return formatOffpeakStatus(statusOf(output), context);
    case "protection-global":
      return formatProtectionGlobal(plan, output);
    case "protection-chat":
      return formatProtectionChat(plan, output);
    case "client":
      return formatClientInfo(clientStatus(output));
    case "session":
      return (
        output.message ?? `Session protection ${plan.direction === "off" ? "disabled" : "enabled"}.`
      );
    case "list":
      return formatTasks(output.tasks);
    case "queue":
    case "task":
    case "automation":
      return output.message ?? "Done.";
    case "pricing":
      return formatOffpeakStatus(statusOf(output), context);
    default:
      return output.message ?? "Done.";
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
