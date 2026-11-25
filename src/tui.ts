import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createRoot } from "solid-js";
import { runOffpeakCommand } from "./commands.js";
import { assertSupportedOpenCode } from "./compat.js";
import {
  OFFPEAK_RPC,
  type OffpeakHoldEvent,
  type OffpeakResumeEvent,
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
          description: "Peak-price protection for the CLI and this chat",
          id: "opencode-offpeak.command",
          slash: { name: "offpeak", aliases: ["op"], arguments: true },
          run: async (input = "") => {
            registerSession(currentSessionID(context));
            try {
              const result = await invoke(context, input);
              context.ui.toast.show({
                title: "OpenCode Offpeak",
                message: result.text,
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

async function invoke(context: Plugin.Context, rawInput: string) {
  const model = context.ui.model.current();
  const sessionID = currentSessionID(context);
  const cwd = context.location?.directory;
  return runOffpeakCommand(context.client.rpc(OFFPEAK_RPC), rawInput, {
    surface: "cli",
    ...(sessionID ? { sessionID } : {}),
    ...(model ? { providerID: model.providerID, modelID: model.modelID } : {}),
    ...(cwd ? { cwd } : {}),
  });
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
