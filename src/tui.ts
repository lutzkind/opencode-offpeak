import { Plugin } from "@opencode/plugin/tui";
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
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          title: "OpenCode Offpeak",
          description: "Queue tasks and inspect off-peak pricing controls",
          id: "opencode-offpeak.command",
          slash: { name: "offpeak", aliases: ["op"], arguments: true },
          run: async (input = "") => {
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
  const sessionOverride = status.sessionProtection === "OFF" && pricing === "PEAK";
  const next =
    status.nextTransition && status.displayTimeZone
      ? formatInTimeZone(status.nextTransition, status.displayTimeZone)
      : pricing === "FLAT" || pricing === "UNTRACKED"
        ? "none (no peak window)"
        : "unknown";
  const requestDetail = sessionOverride
    ? " (session override)"
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
    status.sessionProtection ? `Session protection: ${status.sessionProtection}` : "",
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
