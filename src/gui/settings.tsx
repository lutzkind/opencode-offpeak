import type { Context } from "@opencode/plugin/gui";
import { createEffect, createSignal, on, Show } from "solid-js";
import type { OffpeakClientStatus as RpcClientStatus } from "../rpc.js";
import {
  defaultServerID,
  readClientStatus,
  resolveSessionTarget,
  sessionDisplayName,
  setClientProtection,
  setSessionProtection,
} from "./connection.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Offpeak server could not be reached.";
}

type ChatSetting = "auto" | "on" | "off";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Native Desktop settings page, reduced to the two decisions that matter:
 * each client has one global switch, and the current chat can override its
 * client global (force protection on, or allow peak pricing).
 */
export function OffpeakSettings(props: { ctx: Context }) {
  const [status, setStatus] = createSignal<RpcClientStatus | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [notice, setNotice] = createSignal<string | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);
  let request = 0;

  const resolvedSession = () => resolveSessionTarget(props.ctx);
  const targetServerID = () => resolvedSession()?.server.id ?? defaultServerID(props.ctx);
  const targetServer = () => {
    const id = targetServerID();
    return id ? props.ctx.servers.get(id) : undefined;
  };
  const targetSessionID = () => resolvedSession()?.id;
  const currentSession = () => status()?.session;
  const globalDefault = (client: "cli" | "desktop") => status()?.defaults[client] ?? "ON";
  const chatSetting = (): ChatSetting => {
    const session = currentSession();
    if (session?.override === "on" || session?.override === "off") return session.override;
    return "auto";
  };

  const refresh = async () => {
    const sequence = ++request;
    if (!targetServer()) {
      setStatus(undefined);
      setError("No OpenCode server is available. Open a session, then retry.");
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(undefined);
    // A freshly started Desktop SSH server can receive this read a few
    // milliseconds before the server plugin registers its RPC methods. Retry
    // briefly instead of leaving the page stuck on a startup error.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const next = await readClientStatus(props.ctx, targetServerID(), targetSessionID());
        if (sequence !== request) return;
        setStatus(next);
        setBusy(false);
        return;
      } catch (failure) {
        if (sequence !== request) return;
        if (attempt === 4) {
          setStatus(undefined);
          setError(errorMessage(failure));
          setBusy(false);
          return;
        }
        await delay(600);
      }
    }
  };

  createEffect(
    on(
      () => [targetServerID(), targetSessionID(), targetServer()?.connected] as const,
      () => void refresh(),
    ),
  );

  const updateClient = async (client: "cli" | "desktop", enabled: boolean) => {
    const sequence = ++request;
    setBusy(true);
    setError(undefined);
    try {
      const next = await setClientProtection(
        props.ctx,
        client,
        enabled ? "on" : "off",
        targetServerID(),
        targetSessionID(),
      );
      if (sequence !== request) return;
      setStatus(next);
      setNotice(
        `${client === "cli" ? "CLI" : "Desktop"} protection is now ${next.defaults[client]}. ${
          client === "cli" ? "Desktop" : "CLI"
        } protection is ${next.defaults[client === "cli" ? "desktop" : "cli"]} and was not changed.`,
      );
    } catch (failure) {
      if (sequence === request) setError(errorMessage(failure));
    } finally {
      if (sequence === request) setBusy(false);
    }
  };

  const updateSession = async (setting: ChatSetting) => {
    const sequence = ++request;
    const sessionID = targetSessionID();
    if (!sessionID) {
      setError("Open a chat to change its off-peak protection.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const next = await setSessionProtection(props.ctx, setting, targetServerID(), sessionID);
      if (sequence !== request) return;
      setStatus(next);
      setNotice(
        setting === "on"
          ? "This chat always waits for off-peak, even while its client global is off."
          : setting === "off"
            ? "This chat may use verified peak pricing. Other chats are unchanged."
            : "This chat follows its client global again.",
      );
    } catch (failure) {
      if (sequence === request) setError(errorMessage(failure));
    } finally {
      if (sequence === request) setBusy(false);
    }
  };

  const chatDescription = () => {
    const session = currentSession();
    if (!session) return "Open a chat to give it its own setting.";
    if (session.override === "on") {
      return "Explicitly protected. This survives the client global being switched off.";
    }
    if (session.override === "off") {
      return "Explicitly allowed at peak. Verified peak-priced requests run immediately in this chat only.";
    }
    if (session.source === "client-default") {
      return `Following the ${session.ownership === "desktop" ? "Desktop" : "CLI"} global (${session.protection}).`;
    }
    return "No client has registered this chat yet, so it stays protected. Pick a setting to make it explicit.";
  };

  const globalDescription = (client: "cli" | "desktop") =>
    globalDefault(client) === "ON"
      ? `On: ${client === "cli" ? "CLI" : "Desktop"} chats wait for off-peak and continue automatically.`
      : `Off: ${client === "cli" ? "CLI" : "Desktop"} chats run at verified peak prices unless a chat is set to Always protect.`;

  const title = () => {
    const session = resolvedSession();
    return session ? sessionDisplayName(session) : undefined;
  };

  const ui = props.ctx.ui;
  return (
    <ui.SettingsLayout
      title="Offpeak"
      description="Two global switches and one optional per-chat override. Peak requests wait in place and continue when off-peak starts."
    >
      <ui.SettingsSection
        title="Global protection"
        footer={
          <>
            <Show when={error()}>
              <div>
                {error()}{" "}
                <ui.Button variant="ghost" onClick={() => void refresh()} disabled={busy()}>
                  Retry
                </ui.Button>
              </div>
            </Show>
            <Show when={notice()}>
              <div>{notice()}</div>
            </Show>
          </>
        }
      >
        <ui.SettingsRow
          id="cli-protection"
          title="CLI Protection"
          description={globalDescription("cli")}
        >
          <ui.Switch
            label="CLI Protection"
            hideLabel
            checked={globalDefault("cli") === "ON"}
            disabled={status() === undefined || busy()}
            onChange={(checked) => void updateClient("cli", checked)}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="desktop-protection"
          title="Desktop Protection"
          description={globalDescription("desktop")}
        >
          <ui.Switch
            label="Desktop Protection"
            hideLabel
            checked={globalDefault("desktop") === "ON"}
            disabled={status() === undefined || busy()}
            onChange={(checked) => void updateClient("desktop", checked)}
          />
        </ui.SettingsRow>
      </ui.SettingsSection>

      <ui.SettingsSection title="This chat">
        <Show
          when={resolvedSession()}
          fallback={
            <ui.SettingsRow
              id="no-session"
              title="No chat open"
              description="Open a chat, then return here to give it its own setting. The globals above still apply."
            />
          }
        >
          <ui.SettingsRow id="session-title" title="Chat" description={title()}>
            <span>{currentSession()?.protection ?? "…"}</span>
          </ui.SettingsRow>
          <ui.SettingsRow
            id="chat-protection"
            title="Off-peak protection"
            description={chatDescription()}
          >
            <ui.Select
              label="Off-peak protection for this chat"
              options={[
                {
                  value: "auto",
                  label:
                    currentSession()?.ownership === "desktop"
                      ? `Follow Desktop global (${globalDefault("desktop")})`
                      : `Follow CLI global (${globalDefault("cli")})`,
                },
                { value: "on", label: "Always protect" },
                { value: "off", label: "Allow peak" },
              ]}
              value={chatSetting()}
              disabled={busy() || status() === undefined}
              onChange={(value) => void updateSession(value)}
            />
          </ui.SettingsRow>
          <Show when={currentSession()}>
            <ui.SettingsRow
              id="effective"
              title="Effective now"
              description={
                currentSession()?.protection === "OFF"
                  ? "Verified peak-priced requests may run immediately."
                  : "Verified peak-priced requests wait for off-peak and continue automatically."
              }
            >
              <span>{currentSession()?.protection ?? "ON"}</span>
            </ui.SettingsRow>
          </Show>
        </Show>
      </ui.SettingsSection>
    </ui.SettingsLayout>
  );
}
