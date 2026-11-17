import { Command, createKeyed, Plugin, SettingsPage } from "@opencode/plugin/gui";
import { registerDesktopSession } from "./gui/connection.js";
import { OffpeakSettings } from "./gui/settings.js";

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

    ctx.add(Command, () => ({
      id: "settings",
      title: "OpenCode Offpeak settings",
      description: "Independent CLI and Desktop peak-price protection",
      run: () => ctx.layout.settings("opencode-offpeak"),
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
            title: "Desktop protection",
            description: "Enable or disable peak-price protection for Desktop sessions.",
            keywords: "offpeak peak pricing desktop protection",
          },
          {
            id: "cli-protection",
            title: "CLI protection",
            description: "Read the separate CLI default; change it from the CLI.",
            keywords: "offpeak peak pricing cli protection",
          },
          {
            id: "effective-protection",
            title: "Effective protection",
            description: "The current session's ownership and effective protection.",
            keywords: "offpeak session ownership shared",
          },
        ];
      },
      render: () => <OffpeakSettings ctx={ctx} />,
    });
  },
});
