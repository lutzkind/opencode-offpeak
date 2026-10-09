import type { Plugin as TuiPlugin } from "@opencode/plugin/tui";
import { formatInTimeZone } from "./policy.js";
import { OFFPEAK_RPC, type OffpeakRpcOutput } from "./rpc.js";

const plugin: TuiPlugin.Definition = {
  id: "opencode-offpeak",
  setup: (context) => {
    context.keymap.layer(() => ({
      mode: "base",
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
  },
};

async function invoke(context: TuiPlugin.Context, rawInput: string): Promise<OffpeakRpcOutput> {
  const input = rawInput.trim();
  const space = input.indexOf(" ");
  const action = (space < 0 ? input : input.slice(0, space)).toLowerCase() || "status";
  const argument = space < 0 ? "" : input.slice(space + 1).trim();
  const model = context.ui.model.current();
  const cwd = context.location?.directory;
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
  if (["cancel", "retry", "resume", "run-now"].includes(action)) {
    if (!argument) throw new Error(`Usage: /offpeak ${action} <task-id>`);
    return client.control({ action, id: argument }) as Promise<OffpeakRpcOutput>;
  }
  return client.control({
    action,
    providerID: model?.providerID,
    modelID: model?.modelID,
  }) as Promise<OffpeakRpcOutput>;
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
    providerID?: string;
    modelID?: string;
    policyID?: string;
    pricingState?: string;
    requestsAllowed?: boolean;
    nextTransition?: number;
    displayTimeZone?: string;
    queued?: number;
    waiting?: number;
    running?: { id?: string; sessionID?: string; state?: string };
    failed?: number;
    configError?: string;
  };
  const next =
    status.nextTransition && status.displayTimeZone
      ? formatInTimeZone(status.nextTransition, status.displayTimeZone)
      : "unknown";
  return [
    `Plugin: ${status.enabled ? "ENABLED" : "DISABLED"}`,
    `Mode: ${status.mode ?? "unknown"}`,
    `Automatic execution: ${status.automaticExecution ?? "PAUSED"}`,
    `Automatic resume: ${status.automaticResume ?? "PAUSED"}`,
    `Override: ${status.override?.active ? `ON for ${status.override.taskID} until ${status.override.expiresAt}` : "OFF"}`,
    `Provider/model: ${status.providerID ?? "unknown"}/${status.modelID ?? "unknown"}`,
    `Policy: ${status.policyID ?? "none"}`,
    `Pricing: ${status.pricingState ?? "UNKNOWN"}`,
    `Requests: ${status.requestsAllowed ? "ALLOWED" : "BLOCKED"}${status.pricingState === "UNTRACKED" ? " (untracked policy)" : ""}`,
    `Next transition: ${next}`,
    `Queue: ${status.queued ?? 0} queued, ${status.waiting ?? 0} waiting, ${status.failed ?? 0} failed`,
    `Running: ${status.running?.id ?? "none"}${status.running?.sessionID ? ` (session ${status.running.sessionID})` : ""}`,
    status.configError ? `Config error: ${status.configError}` : "",
    status.enabled
      ? ""
      : "Queued tasks and sessions are preserved. Peak-price execution is still blocked; OFF is not an override.",
  ]
    .filter(Boolean)
    .join("\n");
}

export default plugin;
