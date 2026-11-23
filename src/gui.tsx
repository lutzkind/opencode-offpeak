import { Command, createKeyed, Plugin, SettingsPage } from "@opencode/plugin/gui";
import { createEffect, onCleanup } from "solid-js";
import {
  registerDesktopSession,
  rememberRoutedSession,
  runDesktopOffpeakCommand,
} from "./gui/connection.js";
import { OffpeakSettings } from "./gui/settings.js";
import { type OffpeakHoldEvent, type OffpeakResumeEvent, offpeakEventType } from "./rpc.js";

/**
 * Desktop GUI entrypoint (`./gui-experimental`).
 *
 * It contributes a native settings page and registers the routed Desktop
 * session with the server that actually owns it. It never imports the server
 * entrypoint or creates an engine: pricing decisions and persistence stay on
 * the server, and the server entrypoint loads once on its own.
 */
export default Plugin.define({
  setup(ctx) {
    // One registration per (server client, session). The key appears only once
    // the session exists and is no longer pending; the routed session's own
    // client is used, so a remote session registers on its remote server.
    const registered = new WeakMap<object, Set<string>>();
    createKeyed(
      () => {
        const current = ctx.sessions.current();
        return current && !current.pending ? current.key : undefined;
      },
      () => {
        const current = ctx.sessions.current();
        if (!current || current.pending) return;
        // Settings unmounts the session screen and clears `sessions.current()`;
        // remembering the key here keeps the settings page pointed at the
        // session the user was viewing.
        rememberRoutedSession(current);
        const client = current.server.client;
        let sessions = registered.get(client as object);
        if (!sessions) {
          sessions = new Set<string>();
          registered.set(client as object, sessions);
        }
        if (sessions.has(current.id)) return;
        sessions.add(current.id);
        void registerDesktopSession(current).catch((error: unknown) => {
          // An unregistered session stays UNKNOWN and protected on the server.
          // The next route visit or plugin reload retries the observation.
          sessions?.delete(current.id);
          console.error("[opencode-offpeak] Desktop session registration failed", error);
        });
      },
    );

    // Non-chat hold/resume feedback from the server plugin, using the same
    // typed RPC events the TUI subscribes to. Each Desktop window follows its
    // listed servers and unsubscribes with the plugin.
    const subscriptions = new Map<string, Array<() => void>>();
    const subscribe = (serverID: string) => {
      const data = ctx.servers.get(serverID)?.data;
      if (!data) return;
      try {
        subscriptions.set(serverID, [
          data.on(offpeakEventType("hold"), (event: { data?: unknown }) => {
            const payload = event.data as OffpeakHoldEvent;
            if (typeof payload?.sessionID !== "string") return;
            ctx.toast.show({
              title: "OpenCode Offpeak",
              description:
                typeof payload.display === "string"
                  ? `Peak pricing active — request held until ${payload.display}. It will resume automatically in this chat.`
                  : "Peak pricing active — the request is held until off-peak returns. It will resume automatically in this chat.",
              variant: "default",
              duration: 15000,
            });
          }),
          data.on(offpeakEventType("resume"), (event: { data?: unknown }) => {
            const payload = event.data as OffpeakResumeEvent;
            if (typeof payload?.sessionID !== "string") return;
            ctx.toast.show({
              title: "OpenCode Offpeak",
              description:
                payload.kind === "continuation"
                  ? "Off-peak pricing started. Continuing this chat from where it stopped."
                  : payload.kind === "override"
                    ? "Protection is OFF for this chat. Releasing the held request now."
                    : "Off-peak pricing started. Resuming the held request in this chat.",
              variant: "success",
              duration: 8000,
            });
          }),
        ]);
      } catch (error) {
        console.error("[opencode-offpeak] Desktop event subscription failed", error);
      }
    };
    const refreshSubscriptions = () => {
      const active = new Set(ctx.servers.list());
      for (const [serverID, offs] of subscriptions) {
        if (active.has(serverID)) continue;
        for (const off of offs) off();
        subscriptions.delete(serverID);
      }
      for (const serverID of active) {
        if (!subscriptions.has(serverID)) subscribe(serverID);
      }
    };
    // Subscribe to the servers already listed; the reactive pass follows any
    // server the app lists or removes later.
    refreshSubscriptions();
    createEffect(refreshSubscriptions);
    onCleanup(() => {
      for (const offs of subscriptions.values()) {
        for (const off of offs) off();
      }
      subscriptions.clear();
    });

    ctx.add(Command, () => ({
      id: "settings",
      title: "OpenCode Offpeak settings",
      description: "Independent CLI and Desktop peak-price protection",
      run: () => ctx.layout.settings("opencode-offpeak"),
    }));

    // The same shared command implementation as the CLI, with the Desktop
    // surface and the routed chat's identity. The GUI SDK offers composer
    // slash commands natively, so no UI injection or duplicate handler exists.
    ctx.add(Command, () => ({
      id: "offpeak",
      title: "OpenCode Offpeak",
      description: "Status, queue controls, and independent Desktop protection",
      keywords: "offpeak peak pricing protection queue desktop",
      section: "session" as const,
      slash: { name: "offpeak", arguments: true as const },
      run: async (input) => {
        try {
          const text = await runDesktopOffpeakCommand(ctx, input ?? "status");
          ctx.toast.show({
            title: "OpenCode Offpeak",
            description: text,
            variant: "success",
            duration: 12000,
          });
        } catch (error) {
          ctx.toast.show({
            title: "OpenCode Offpeak",
            description: error instanceof Error ? error.message : "Offpeak command failed.",
            variant: "error",
            duration: 12000,
          });
        }
      },
    }));

    ctx.add(SettingsPage, {
      id: "opencode-offpeak",
      icon: "server",
      get title() {
        return "Offpeak";
      },
      get entries() {
        return [
          {
            id: "desktop-protection",
            title: "Desktop Protection",
            description: "Enable or disable peak-price protection for Desktop chats by default.",
            keywords: "offpeak peak pricing desktop protection",
          },
          {
            id: "cli-protection",
            title: "CLI Protection",
            description: "Read the separate CLI default; change it from the CLI.",
            keywords: "offpeak peak pricing cli protection",
          },
          {
            id: "chat-protection",
            title: "Protection for this chat",
            description: "Disable verified peak-priced inference for this chat only.",
            keywords: "offpeak chat session override protection",
          },
          {
            id: "session-title",
            title: "Chat title",
            description: "The actual OpenCode title, project, and session ID of this chat.",
            keywords: "offpeak session title project id",
          },
          {
            id: "effective-protection",
            title: "Effective protection",
            description: "The current chat's ownership and effective protection.",
            keywords: "offpeak session ownership shared",
          },
        ];
      },
      render: () => <OffpeakSettings ctx={ctx} />,
    });
  },
});
