import type { Context } from "@opencode/plugin/gui";
import { createEffect, createSignal, on, Show } from "solid-js";
import type { OffpeakClientStatus as RpcClientStatus } from "../rpc.js";
import {
  defaultServerID,
  ensureSessionMetadata,
  openSessions,
  ownershipLabel,
  readClientStatus,
  registerDesktopSession,
  resolveSessionTarget,
  serverOptions,
  sessionDisplayName,
  sessionProjectName,
  sessionTitle,
  setDesktopProtection,
  setSessionProtection,
  sourceLabel,
} from "./connection.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Offpeak server could not be reached.";
}

function ownerName(ownership: string | undefined): string {
  return ownership === "desktop" ? "Desktop" : "CLI";
}

/**
 * Native Desktop settings page. It reads and writes only through the selected
 * session server's typed RPC; the Desktop default is the only global setting
 * this page can change, so touching it can never modify the CLI default.
 */
export function OffpeakSettings(props: { ctx: Context }) {
  const [selectedServer, setSelectedServer] = createSignal<string | undefined>(undefined);
  const [selectedSession, setSelectedSession] = createSignal<string | undefined>(undefined);
  const [status, setStatus] = createSignal<RpcClientStatus | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [notice, setNotice] = createSignal<string | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);
  let request = 0;

  // `sessions.current()` is undefined while Settings is on screen; the helper
  // follows the mounted session, then the active tab, then the last routed one.
  const opened = () => openSessions(props.ctx);
  const resolvedSession = () => resolveSessionTarget(props.ctx, selectedSession());
  const targetServerID = () =>
    selectedServer() ?? resolvedSession()?.server.id ?? defaultServerID(props.ctx);
  const targetServer = () => {
    const id = targetServerID();
    return id ? props.ctx.servers.get(id) : undefined;
  };
  const targetSession = () => {
    const session = resolvedSession();
    return session && session.server.id === targetServerID() ? session : undefined;
  };
  const targetSessionID = () => targetSession()?.id;
  const currentSession = () => status()?.session;
  const sessionOptions = () =>
    opened()
      .filter((session) => session.server.id === targetServerID())
      .map((session) => ({ value: session.id, label: sessionDisplayName(session) }));
  const options = () => serverOptions(props.ctx);
  const globalDefault = (surface: "cli" | "desktop") => status()?.defaults[surface] ?? "ON";
  const chatProtectionChecked = () => currentSession()?.protection === "ON";

  // Existing sessions opened before this page loaded may not be in the
  // Desktop's synced store yet. This asks the supported session API once per
  // session; renames and moves then arrive through the reactive store.
  createEffect(() => {
    for (const session of opened()) ensureSessionMetadata(session);
  });

  const refresh = async () => {
    const sequence = ++request;
    if (!targetServer()) {
      setStatus(undefined);
      setError("No OpenCode server is available. Open a session or add a server, then retry.");
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const next = await readClientStatus(props.ctx, targetServerID(), targetSessionID());
      if (sequence === request) setStatus(next);
    } catch (failure) {
      if (sequence === request) {
        setStatus(undefined);
        setError(errorMessage(failure));
      }
    } finally {
      if (sequence === request) setBusy(false);
    }
  };

  createEffect(
    on(
      () => [targetServerID(), targetSessionID(), targetServer()?.connected] as const,
      () => void refresh(),
    ),
  );

  const registerCurrent = async () => {
    const current = targetSession();
    if (!current) return;
    setBusy(true);
    setError(undefined);
    try {
      await registerDesktopSession(current);
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const chooseServer = (value: string) => {
    const chosen = selectedSession();
    if (
      chosen &&
      !opened().some((session) => session.id === chosen && session.server.id === value)
    ) {
      setSelectedSession(undefined);
    }
    setSelectedServer(value);
  };

  const chooseSession = (value: string) => {
    setSelectedSession(value);
    const chosen = opened().find((session) => session.id === value);
    if (chosen && chosen.server.id !== selectedServer()) setSelectedServer(undefined);
  };

  const updateDesktop = async (enabled: boolean) => {
    const sequence = ++request;
    setBusy(true);
    setError(undefined);
    try {
      const next = await setDesktopProtection(
        props.ctx,
        enabled ? "on" : "off",
        targetServerID(),
        targetSessionID(),
      );
      if (sequence === request) {
        setStatus(next);
        setNotice(
          `Desktop Protection is now ${next.defaults.desktop}. CLI Protection is ${next.defaults.cli} and was not modified.`,
        );
      }
    } catch (failure) {
      if (sequence === request) setError(errorMessage(failure));
    } finally {
      if (sequence === request) setBusy(false);
    }
  };

  const updateSession = async (protection: "on" | "off") => {
    const sequence = ++request;
    const sessionID = targetSessionID();
    if (!sessionID) {
      setError("Open a chat to change its off-peak protection.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const next = await setSessionProtection(props.ctx, protection, targetServerID(), sessionID);
      if (sequence === request) {
        setStatus(next);
        if (protection === "off") {
          setNotice(
            "Protection is disabled for this chat only. Other chats and both global settings are unchanged.",
          );
        } else if (next.session?.protection === "OFF") {
          setNotice(
            `This chat now follows the ${ownerName(next.session.ownership)} Protection default, which is OFF.`,
          );
        } else {
          setNotice(
            `This chat now follows the ${ownerName(next.session?.ownership)} Protection default (${next.session?.protection ?? "ON"}).`,
          );
        }
      }
    } catch (failure) {
      if (sequence === request) setError(errorMessage(failure));
    } finally {
      if (sequence === request) setBusy(false);
    }
  };

  const chatDescription = () => {
    const session = currentSession();
    if (!session) return "The Offpeak server has not answered for this chat yet.";
    if (session.source === "session-override") {
      return "Disabled for this chat only. Verified peak-priced requests may run here; other chats and both global settings are unchanged.";
    }
    if (session.source === "client-default") {
      return `Following the ${ownerName(session.ownership)} Protection default (${session.protection}). Turn this off to disable protection for this chat only.`;
    }
    if (session.source === "ambiguous") {
      return "Shared session (open in both CLI and Desktop); protected. An explicit off switch applies to this chat only.";
    }
    if (session.source === "queue") {
      return "Queue task; client defaults and chat controls do not apply.";
    }
    return "No reliable client registration; protected. Turn this off to explicitly bypass protection for this chat only.";
  };

  const desktopDescription = () =>
    globalDefault("desktop") === "ON"
      ? "On: Desktop chats without an explicit per-chat override are protected and wait for off-peak. CLI Protection is separate and is never changed here."
      : "Off: Desktop chats without an explicit per-chat override may use verified peak-priced inference. CLI Protection is separate and is never changed here.";

  const copySessionID = (sessionID: string) => {
    void props.ctx.system.copy(sessionID);
    setNotice("Session ID copied.");
  };

  const ui = props.ctx.ui;
  return (
    <ui.SettingsLayout
      title="Offpeak"
      description="Independent peak-price protection for OpenCode CLI and OpenCode Desktop. These two global defaults never modify each other."
    >
      <ui.SettingsSection
        title="Protection defaults"
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
        <Show when={options().length > 1}>
          <ui.SettingsRow
            id="server"
            title="Server"
            description="The OpenCode server whose protection defaults and chats this page reads and writes."
          >
            <ui.Select
              label="Server"
              options={options()}
              value={targetServerID()}
              onChange={(value) => chooseServer(value)}
            />
          </ui.SettingsRow>
        </Show>
        <ui.SettingsRow
          id="desktop-protection"
          title="Desktop Protection"
          description={desktopDescription()}
        >
          <ui.Switch
            label="Desktop Protection"
            hideLabel
            checked={globalDefault("desktop") === "ON"}
            disabled={status() === undefined || busy()}
            onChange={(checked) => void updateDesktop(checked)}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="cli-protection"
          title="CLI Protection"
          description="Read-only on this page. Change it with /offpeak protection global on|off in the CLI; a CLI global command never modifies Desktop Protection."
        >
          <span>{status()?.defaults.cli ?? "Unavailable"}</span>
        </ui.SettingsRow>
      </ui.SettingsSection>

      <ui.SettingsSection title="Current chat">
        <Show when={sessionOptions().length > 1}>
          <ui.SettingsRow
            id="session"
            title="Chat"
            description="The actual OpenCode title, project, and shortened session ID. The page follows the chat you were viewing whenever it is still open. Pick another open chat on this server to inspect or change it."
          >
            <ui.Select
              label="Chat"
              options={sessionOptions()}
              value={targetSessionID()}
              onChange={(value) => chooseSession(value)}
            />
          </ui.SettingsRow>
        </Show>
        <Show
          when={targetSession()}
          fallback={
            <Show
              when={opened().length > 0}
              fallback={
                <ui.SettingsRow
                  id="no-session"
                  title="No chat open"
                  description="Open a chat to see its client ownership and effective protection."
                />
              }
            >
              <ui.SettingsRow
                id="no-session-on-server"
                title="No chat open on this server"
                description="Pick another server above, or open a chat on this server, then return here."
              />
            </Show>
          }
        >
          {(selected) => (
            <>
              <ui.SettingsRow
                id="session-title"
                title="Chat title"
                description="The canonical OpenCode session title. Renames appear here through the Desktop's session store."
              >
                <span>{sessionTitle(selected())}</span>
              </ui.SettingsRow>
              <ui.SettingsRow
                id="session-project"
                title="Project"
                description="The repository or project that owns this chat, when the Desktop reports it."
              >
                <span>{sessionProjectName(selected()) ?? "Unknown project"}</span>
              </ui.SettingsRow>
              <ui.SettingsRow
                id="session-id"
                title="Session ID"
                description="The full OpenCode session ID for troubleshooting. The chat list shows a shortened form."
              >
                <span>{selected().id}</span>{" "}
                <ui.Button
                  variant="ghost"
                  onClick={() => copySessionID(selected().id)}
                  disabled={busy()}
                >
                  Copy
                </ui.Button>
              </ui.SettingsRow>
              <Show
                when={status()?.session}
                fallback={
                  <ui.SettingsRow
                    id="session-loading"
                    title="Chat status"
                    description="The Offpeak server has not answered for this chat yet."
                  />
                }
              >
                {(current) => (
                  <>
                    <ui.SettingsRow
                      id="ownership"
                      title="Ownership"
                      description="A chat opened by both clients is shared and always protected unless you explicitly disable this chat."
                    >
                      <span>{ownershipLabel(current().ownership)}</span>
                    </ui.SettingsRow>
                    <ui.SettingsRow
                      id="chat-protection"
                      title="Protection for this chat"
                      description={chatDescription()}
                    >
                      <ui.Switch
                        label="Protection for this chat"
                        hideLabel
                        checked={chatProtectionChecked()}
                        disabled={busy() || current().ownership === "queue"}
                        onChange={(checked) => void updateSession(checked ? "on" : "off")}
                      />
                    </ui.SettingsRow>
                    <ui.SettingsRow
                      id="effective-protection"
                      title="Effective protection"
                      description={sourceLabel(current().source)}
                    >
                      <span>{current().protection}</span>
                    </ui.SettingsRow>
                    <Show when={current().ownership === "unknown"}>
                      <ui.SettingsRow
                        id="register-session"
                        title="Register this chat"
                        description="The server has not seen a Desktop registration for this chat. Retry the supported session observation."
                      >
                        <ui.Button
                          variant="neutral"
                          onClick={() => void registerCurrent()}
                          disabled={busy()}
                        >
                          Register
                        </ui.Button>
                      </ui.SettingsRow>
                    </Show>
                    <ui.SettingsRow
                      id="peak-permitted"
                      title="Peak-priced inference"
                      description="Permission applies only to verified peak pricing. UNKNOWN pricing and invalid configuration always fail closed."
                    >
                      <span>{current().protection === "OFF" ? "Permitted" : "Blocked"}</span>
                    </ui.SettingsRow>
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
      </ui.SettingsSection>

      <ui.SettingsSection title="Controls">
        <ui.SettingsRow
          id="commands"
          title="Commands"
          description="/offpeak status shows both global defaults, this chat's override, the effective state, and the queue. /offpeak protection global on|off changes this Desktop default only. /offpeak protection chat on|off changes this chat only. The CLI uses the same commands against its own independent global default."
        />
      </ui.SettingsSection>
    </ui.SettingsLayout>
  );
}
