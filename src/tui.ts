import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createRoot } from "solid-js";
import { assertSupportedOpenCode } from "./compat.js";
import { formatInTimeZone } from "./policy.js";
import {
  OFFPEAK_RPC,
  type OffpeakHoldEvent,
  type OffpeakResumeEvent,
  type OffpeakRpcOutput,
  offpeakEventType,
} from "./rpc.js";

export default Plugin.define({
  id: "opencode-offpeak",
  setup: (context) => {
    assertSupportedOpenCode(context.app, "TUI");
    const instanceID = crypto.randomUUID();
    const registered = new Set<string>();
    /**
     * Registers a focused CLI session with the server that owns it. This is a
     * client-side observation, not a server-side guess: the TUI talks to the
     * connected server through its supported client, including a remote one,
     * and the server records the CLI origin for that session. Registration is
     * idempotent and happens as soon as a session is routed (and again on every
     * /offpeak command), so the first prompt cannot silently inherit Desktop's
     * setting. If the server has not finished loading its RPC methods, the
     * session stays UNKNOWN and protected.
     */
    const registerSession = (sessionID: string | undefined) => {
      if (!sessionID || registered.has(sessionID)) return;
      registered.add(sessionID);
      try {
        const client = context.client.rpc(OFFPEAK_RPC);
        void client
          .control({
            action: "client-register",
            client: "cli",
            sessionID,
            instanceID,
          })
          .catch((error: unknown) => {
            // A session the server never saw registered remains UNKNOWN and
            // protected. A later route change or command retries naturally.
            registered.delete(sessionID);
            console.error("[opencode-offpeak] CLI session registration failed", error);
          });
      } catch (error) {
        registered.delete(sessionID);
        console.error("[opencode-offpeak] CLI session registration failed", error);
      }
    };
    // The route and tab APIs are reactive in a Solid computation. A private
    // root keeps the effect correct even when a host invokes setup without an
    // ambient owner, and its disposal is part of the plugin cleanup.
    const disposeRegistration = createRoot((dispose) => {
      createEffect(() => {
        const route = context.ui.router?.current?.();
        const active = context.ui.tabs
          ?.list?.()
          .find((tab) => tab.active && typeof tab.sessionID === "string");
        registerSession(
          route?.type === "session" && typeof route.sessionID === "string"
            ? route.sessionID
            : active?.sessionID,
        );
      });
      return dispose;
    });
    registerSession(currentSessionID(context));
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          title: "OpenCode Offpeak",
          description: "Queue tasks and inspect off-peak pricing controls",
          id: "opencode-offpeak.command",
          slash: { name: "offpeak", aliases: ["op"], arguments: true },
          run: async (input = "") => {
            registerSession(currentSessionID(context));
            try {
              const output = await invoke(context, input);
              context.ui.toast.show({
                title: "OpenCode Offpeak",
                message: summarize(output),
                variant: "success",
                duration: 8000,
              });
            } catch (error) {
              context.ui.toast.show({
                title: "OpenCode Offpeak",
                message: error instanceof Error ? error.message : "Offpeak command failed.",
                variant: "error",
                duration: 10000,
              });
            }
          },
        },
      ],
    }));
    // Non-chat hold/resume feedback. These toasts come from the server plugin's
    // event stream; they never enter the session or the model context, and a
    // headless run simply has no subscriber.
    const unsubscribe = [
      context.data.on(offpeakEventType("hold"), (event) => {
        const data = event.data as OffpeakHoldEvent;
        if (typeof data?.sessionID !== "string") return;
        context.ui.toast.show({
          title: "OpenCode Offpeak",
          message:
            typeof data.display === "string"
              ? `Peak pricing active — request held until ${data.display}. It will resume automatically in this session.`
              : "Peak pricing active — the request is held until off-peak returns. It will resume automatically in this session.",
          variant: "info",
          duration: 15000,
          sessionID: data.sessionID,
        });
      }),
      context.data.on(offpeakEventType("resume"), (event) => {
        const data = event.data as OffpeakResumeEvent;
        if (typeof data?.sessionID !== "string") return;
        context.ui.toast.show({
          title: "OpenCode Offpeak",
          message:
            data.kind === "continuation"
              ? "Off-peak pricing started. Continuing this session from where it stopped."
              : data.kind === "override"
                ? "Session off-peak protection is OFF. Releasing the held request in this session now."
                : "Off-peak pricing started. Resuming the held request in this session.",
          variant: "success",
          duration: 8000,
          sessionID: data.sessionID,
        });
      }),
    ];
    return () => {
      disposeRegistration();
      for (const off of unsubscribe) off();
    };
  },
});

async function invoke(context: Plugin.Context, rawInput: string): Promise<OffpeakRpcOutput> {
  const input = rawInput.trim().replace(/^\/(?:offpeak|op)(?=\s|$)\s*/i, "");
  const space = input.indexOf(" ");
  const action = (space < 0 ? input : input.slice(0, space)).toLowerCase() || "status";
  const argument = space < 0 ? "" : input.slice(space + 1).trim();
  const model = context.ui.model.current();
  const cwd = context.location?.directory;
  const sessionID = currentSessionID(context);
  const client = context.client.rpc(OFFPEAK_RPC);

  if (action === "queue") {
    if (!argument) throw new Error("Usage: /offpeak queue <task>");
    if (!model) throw new Error("Select an OpenCode model before queueing a task.");
    return client.control({
      action,
      prompt: argument,
      cwd,
      providerID: model.providerID,
      modelID: model.modelID,
    }) as Promise<OffpeakRpcOutput>;
  }
  // Session-scoped off-peak protection for the current interactive session.
  // The session is identified from the supported TUI route, never typed by
  // hand; the state persists until the user changes it and there is no timer.
  if (action === "session") {
    const direction = argument.toLowerCase();
    if (direction !== "on" && direction !== "off") {
      throw new Error("Usage: /offpeak session on|off");
    }
    if (!sessionID) {
      throw new Error(
        "No current OpenCode session is focused. Open the session and run /offpeak session on|off again.",
      );
    }
    return client.control({
      action: `session-${direction}`,
      sessionID,
    }) as Promise<OffpeakRpcOutput>;
  }
  // Client-level defaults are deliberately separate from `/offpeak on|off`
  // (global automation) and `/offpeak session on|off` (one session's explicit
  // authorization). Changing one client's default never writes the other.
  if (action === "client") {
    const parts = argument.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return client.control({
        action: "client",
        ...(sessionID ? { sessionID } : {}),
      }) as Promise<OffpeakRpcOutput>;
    }
    const [who, direction] = parts;
    if (
      parts.length !== 2 ||
      (who !== "cli" && who !== "desktop") ||
      (direction !== "on" && direction !== "off")
    ) {
      throw new Error(
        "Usage: /offpeak client, /offpeak client cli on|off, or /offpeak client desktop on|off",
      );
    }
    return client.control({
      action: "client-set",
      client: who,
      protection: direction,
      ...(sessionID ? { sessionID } : {}),
    }) as Promise<OffpeakRpcOutput>;
  }
  if (["cancel", "remove", "retry", "resume", "run-now"].includes(action)) {
    if (!argument) throw new Error(`Usage: /offpeak ${action} <task-id>`);
    return client.control({ action, id: argument }) as Promise<OffpeakRpcOutput>;
  }
  return client.control({
    action,
    providerID: model?.providerID,
    modelID: model?.modelID,
    ...(sessionID ? { sessionID } : {}),
  }) as Promise<OffpeakRpcOutput>;
}

/**
 * The current interactive session, resolved from OpenCode's supported TUI
 * command context: the focused route first, then the active session tab. The
 * user never has to copy a session ID.
 */
function currentSessionID(context: Plugin.Context): string | undefined {
  try {
    const route = context.ui.router?.current?.();
    if (route?.type === "session" && typeof route.sessionID === "string") {
      return route.sessionID;
    }
  } catch {
    // Fall through to the active tab.
  }
  try {
    const active = context.ui.tabs?.list?.().find((tab) => tab.active);
    if (active && typeof active.sessionID === "string") return active.sessionID;
  } catch {
    // No session context is available from this host generation.
  }
  return undefined;
}

function summarize(output: OffpeakRpcOutput): string {
  if (output.client) {
    const { defaults, session, error } = output.client;
    const lines = [
      "Client-level off-peak protection",
      `CLI default: ${defaults.cli}`,
      `Desktop default: ${defaults.desktop}`,
    ];
    if (session) {
      const owner =
        session.ownership === "cli"
          ? "CLI"
          : session.ownership === "desktop"
            ? "Desktop"
            : session.ownership === "ambiguous"
              ? "shared (CLI + Desktop; protected)"
              : session.ownership === "queue"
                ? "queue task (client defaults do not apply)"
                : "unknown (protected)";
      const source =
        session.source === "session-override"
          ? "explicit /offpeak session off"
          : session.source === "client-default"
            ? "client default"
            : session.source === "ambiguous"
              ? "shared ownership; fail-closed"
              : session.source === "queue"
                ? "queue task; explicit task override only"
                : "no reliable client registration; fail-closed";
      lines.push(
        `This session: ${owner}`,
        `Effective protection: ${session.protection}`,
        `Source: ${source}`,
        `Session override: ${session.source === "session-override" ? "OFF (explicit)" : "not set"}`,
      );
    } else {
      lines.push("This session: none focused");
    }
    if (error) lines.push(`Client settings error: ${error}`);
    lines.push(
      "CLI and Desktop defaults are independent; change one with /offpeak client cli|desktop on|off.",
    );
    return lines.join("\n");
  }
  if (output.message) return output.message;
  if (output.tasks) {
    if (!output.tasks.length) return "Queue is empty.";
    return output.tasks
      .map((raw) => {
        const task = raw as { id?: string; state?: string; sessionID?: string; lastError?: string };
        return `${task.id ?? "?"} ${task.state ?? "UNKNOWN"}${task.sessionID ? ` session=${task.sessionID}` : ""}${task.lastError ? ` error=${task.lastError}` : ""}`;
      })
      .join("\n");
  }
  if (!output.status) return "Done.";
  const status = output.status as {
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
  };
  const pricing = status.pricingState ?? "UNKNOWN";
  const sessionOverride = status.effectiveProtection === "OFF" && pricing === "PEAK";
  const next =
    status.nextTransition && status.displayTimeZone
      ? formatInTimeZone(status.nextTransition, status.displayTimeZone)
      : pricing === "FLAT" || pricing === "UNTRACKED"
        ? "none (no peak window)"
        : "unknown";
  const requestDetail = sessionOverride
    ? status.client?.source === "client-default"
      ? " (client default)"
      : " (session override)"
    : pricing === "FLAT"
      ? " (flat all-hours pricing; never waits)"
      : pricing === "UNTRACKED"
        ? status.providerNote
          ? ` (no policy needed: ${status.providerNote})`
          : " (untracked provider; no policy installed)"
        : pricing === "UNKNOWN"
          ? " (no verified pricing policy for this model)"
          : "";
  return [
    `Plugin: ${status.enabled ? "ENABLED" : "DISABLED"}`,
    `Mode: ${status.mode ?? "unknown"}`,
    `Automatic execution: ${status.automaticExecution ?? "PAUSED"}`,
    `Automatic resume: ${status.automaticResume ?? "PAUSED"}`,
    `Override: ${status.override?.active ? `ON for ${status.override.taskID} until ${status.override.expiresAt}` : "OFF"}`,
    `Provider/model: ${status.providerID ?? "unknown"}/${status.modelID ?? "unknown"}`,
    `Policy: ${status.policyID ?? (pricing === "UNKNOWN" ? "none (model not in any verified policy)" : "none")}`,
    `Pricing: ${pricing}`,
    status.clientDefaults
      ? `Client defaults: CLI ${status.clientDefaults.cli ?? "ON"}, Desktop ${status.clientDefaults.desktop ?? "ON"}`
      : "",
    status.client ? `Client ownership: ${status.client.ownership ?? "unknown"}` : "",
    status.sessionProtection ? `Session protection (explicit): ${status.sessionProtection}` : "",
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
  ]
    .filter(Boolean)
    .join("\n");
}
