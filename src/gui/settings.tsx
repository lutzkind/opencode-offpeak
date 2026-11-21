import type { Context } from "@opencode/plugin/gui";
import { createEffect, createSignal, on, Show } from "solid-js";
import type { OffpeakClientStatus as RpcClientStatus } from "../rpc.js";
import {
  defaultServerID,
  openSessions,
  ownershipLabel,
  readClientStatus,
  registerDesktopSession,
  resolveSessionTarget,
  serverOptions,
  sessionOverrideActive,
  setDesktopProtection,
  setSessionProtection,
  sourceLabel,
} from "./connection.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Offpeak server could not be reached.";
}

/**
 * Native Desktop settings page. It reads and writes only through the selected
 * session server's typed RPC; the Desktop default is the only setting this
 * page can change, so touching it can never modify the CLI default.
 */
export function OffpeakSettings(props: { ctx: Context }) {
  const [selectedServer, setSelectedServer] = createSignal<string | undefined>(undefined);
  const [selectedSession, setSelectedSession] = createSignal<string | undefined>(undefined);
  const [status, setStatus] = createSignal<RpcClientStatus | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
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
  const sessionOptions = () =>
    opened()
      .filter((session) => session.server.id === targetServerID())
      .map((session) => ({ value: session.id, label: session.id }));
  const options = () => serverOptions(props.ctx);

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
      if (sequence === request) setStatus(next);
    } catch (failure) {
      if (sequence === request) setError(errorMessage(failure));
    } finally {
      if (sequence === request) setBusy(false);
    }
  };

  const updateSession = async (allowPeak: boolean) => {
    const sequence = ++request;
    const sessionID = targetSessionID();
    if (!sessionID) {
      setError("Open a session to change its off-peak protection.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const next = await setSessionProtection(
        props.ctx,
        allowPeak ? "off" : "on",
        targetServerID(),
        sessionID,
      );
      if (sequence === request) setStatus(next);
    } catch (failure) {
      if (sequence === request) setError(errorMessage(failure));
    } finally {
      if (sequence === request) setBusy(false);
    }
  };

  const ui = props.ctx.ui;
  return (
    <ui.SettingsLayout
      title="Offpeak"
      description="Independent peak-price protection for OpenCode CLI and OpenCode Desktop sessions."
    >
      <ui.SettingsSection
        title="Client defaults"
        footer={
          <Show when={error()}>
            <div>
              {error()}{" "}
              <ui.Button variant="ghost" onClick={() => void refresh()} disabled={busy()}>
                Retry
              </ui.Button>
            </div>
          </Show>
        }
      >
        <Show when={options().length > 1}>
          <ui.SettingsRow
            id="server"
            title="Server"
            description="The OpenCode server whose client defaults and sessions this page reads and writes."
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
          title="Desktop protection"
          description="Applies to every Desktop session on this server without an explicit session override. The CLI default is separate and is never changed here."
        >
          <ui.Switch
            label="Desktop protection"
            hideLabel
            checked={status()?.defaults.desktop === "ON"}
            disabled={status() === undefined || busy()}
            onChange={(checked) => void updateDesktop(checked)}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="cli-protection"
          title="CLI protection"
          description="Change it with /offpeak client cli on|off in the CLI. This page cannot modify it."
        >
          <span>{status()?.defaults.cli ?? "Unavailable"}</span>
        </ui.SettingsRow>
      </ui.SettingsSection>

      <ui.SettingsSection title="Current session">
        <Show when={sessionOptions().length > 1}>
          <ui.SettingsRow
            id="session"
            title="Session"
            description="The page follows the session you were viewing whenever it is still open. Pick another open session on this server to inspect or change it."
          >
            <ui.Select
              label="Session"
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
                  title="No session open"
                  description="Open a session to see its client ownership and effective protection."
                />
              }
            >
              <ui.SettingsRow
                id="no-session-on-server"
                title="No session open on this server"
                description="Pick another server above, or open a session on this server, then return here."
              />
            </Show>
          }
        >
          <Show
            when={status()?.session}
            fallback={
              <ui.SettingsRow
                id="session-loading"
                title="Session status"
                description="The Offpeak server has not answered for this session yet."
              />
            }
          >
            {(current) => (
              <>
                <ui.SettingsRow
                  id="ownership"
                  title="Ownership"
                  description="A session opened by both clients is shared and always protected."
                >
                  <span>{ownershipLabel(current().ownership)}</span>
                </ui.SettingsRow>
                <ui.SettingsRow
                  id="effective-protection"
                  title="Effective protection"
                  description={sourceLabel(current().source)}
                >
                  <span>{current().protection}</span>
                </ui.SettingsRow>
                <ui.SettingsRow
                  id="session-override"
                  title="Allow peak pricing in this session"
                  description="Per-session override, the Desktop equivalent of /offpeak session off. On permits verified peak-priced requests in this session and releases one already waiting; off returns it to its client default. Neither the Desktop nor the CLI default changes."
                >
                  <ui.Switch
                    label="Allow peak pricing in this session"
                    hideLabel
                    checked={sessionOverrideActive(status())}
                    disabled={busy() || current().ownership === "queue"}
                    onChange={(checked) => void updateSession(checked)}
                  />
                </ui.SettingsRow>
                <Show when={current().ownership === "unknown"}>
                  <ui.SettingsRow
                    id="register-session"
                    title="Register this session"
                    description="The server has not seen a Desktop registration for this session. Retry the supported session observation."
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
        </Show>
      </ui.SettingsSection>

      <ui.SettingsSection title="Controls">
        <ui.SettingsRow
          id="cli-commands"
          title="CLI commands"
          description="/offpeak client shows these defaults. /offpeak client cli on|off and /offpeak client desktop on|off change one client each. /offpeak on|off remains global automation, and /offpeak session on|off remains the explicit per-session override."
        />
      </ui.SettingsSection>
    </ui.SettingsLayout>
  );
}
