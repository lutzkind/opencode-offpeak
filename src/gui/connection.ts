import {
  OFFPEAK_RPC,
  type OffpeakClientStatus,
  type OffpeakRpcInput,
  type OffpeakRpcOutput,
} from "../rpc.js";

/**
 * The small structural slice of the Desktop GUI context this plugin uses.
 * Keeping it structural makes the targeting rules testable without rendering
 * Solid components or importing Electron.
 */
export interface GuiRpcClient {
  control(input: OffpeakRpcInput): Promise<unknown>;
}

export interface GuiOpenCodeClientLike {
  rpc(definition: typeof OFFPEAK_RPC): GuiRpcClient;
}

export interface GuiServerLike {
  id: string;
  name: string;
  url: string;
  client: GuiOpenCodeClientLike;
  connected?: boolean;
  builtin?: boolean;
}

export interface GuiSessionLike {
  id: string;
  key?: string;
  pending?: boolean;
  server: GuiServerLike;
}

export interface GuiTabLike {
  key?: string;
  session?: GuiSessionLike | undefined;
  active: boolean;
}

export interface GuiContextLike {
  client: GuiOpenCodeClientLike;
  sessions: {
    current(): GuiSessionLike | undefined;
    list?(): readonly GuiSessionLike[];
  };
  tabs?: {
    list(): readonly GuiTabLike[];
  };
  servers: {
    list(): readonly string[];
    get(id: string): GuiServerLike | undefined;
  };
}

/**
 * The session the user was last viewing. `Sessions.current()` goes undefined as
 * soon as the route leaves the mounted session screen -- which is exactly what
 * opening Settings does -- so the page remembers the last routed session and
 * looks it up among the open tabs while Settings is on screen.
 */
let lastRoutedKey: string | undefined;

/** Records the routed session; call with `undefined` only to clear test state. */
export function rememberRoutedSession(session: GuiSessionLike | undefined): void {
  lastRoutedKey = session?.key;
}

/** Every non-pending session an open shell tab owns, across all servers. */
export function openSessions(context: GuiContextLike): GuiSessionLike[] {
  return (context.sessions.list?.() ?? []).filter((session) => !session.pending);
}

/**
 * The session the page should follow, in precedence order: the explicit pick,
 * the mounted session, the active tab, the last routed session, and finally a
 * single open session. Undefined only when there is no safe single choice.
 */
export function resolveSessionTarget(
  context: GuiContextLike,
  selectedSessionID?: string,
): GuiSessionLike | undefined {
  const opened = openSessions(context);
  if (selectedSessionID) {
    const chosen = opened.find((session) => session.id === selectedSessionID);
    if (chosen) return chosen;
  }
  const routed = context.sessions.current();
  if (routed && !routed.pending) return routed;
  const tabbed = context.tabs
    ?.list()
    .find((tab) => tab.active && tab.session !== undefined && !tab.session.pending)?.session;
  if (tabbed) return tabbed;
  if (lastRoutedKey) {
    const remembered = opened.find((session) => session.key === lastRoutedKey);
    if (remembered) return remembered;
  }
  return opened.length === 1 ? opened[0] : undefined;
}

/**
 * Resolve the server a GUI RPC must target.
 *
 * A selected server wins when the settings page picked one. Otherwise the
 * routed session's actual server wins -- never an assumed local sidecar. The
 * Desktop's own sidecar is just another server and is selected only when no
 * remote session is current.
 */
export function resolveTargetServer(
  context: GuiContextLike,
  preferredServerID?: string,
): GuiServerLike | undefined {
  if (preferredServerID) {
    const preferred = context.servers.get(preferredServerID);
    if (preferred) return preferred;
  }
  return resolveSessionTarget(context)?.server;
}

/**
 * The server selected on first render. The routed/remembered session's own
 * server wins; otherwise the Desktop's local server, which is always present
 * and reachable; a remote is only an explicit choice. A single-server session
 * set is still used when no session has been routed yet.
 */
export function defaultServerID(context: GuiContextLike): string | undefined {
  const session = resolveSessionTarget(context);
  if (session) return session.server.id;
  const opened = openSessions(context);
  const onlyServer = opened[0]?.server.id;
  if (onlyServer && opened.every((candidate) => candidate.server.id === onlyServer)) {
    return onlyServer;
  }
  const listed = context.servers.list();
  const local = listed.find((id) => {
    const server = context.servers.get(id);
    return server !== undefined && (server.builtin === true || server.id === "sidecar");
  });
  return local ?? listed[0];
}

export function serverOptions(context: GuiContextLike): Array<{ value: string; label: string }> {
  return context.servers.list().map((id) => {
    const server = context.servers.get(id);
    if (!server) return { value: id, label: id };
    const suffix = server.connected === false ? " (offline)" : "";
    return { value: id, label: `${server.name || id}${suffix}` };
  });
}

/**
 * Reads the authoritative client defaults and the effective protection of the
 * routed session from the server that owns that session.
 */
export async function readClientStatus(
  context: GuiContextLike,
  preferredServerID?: string,
  sessionID?: string,
): Promise<OffpeakClientStatus> {
  const server = resolveTargetServer(context, preferredServerID);
  if (!server) throw new Error("No OpenCode server is available for Offpeak client settings.");
  const result = (await server.client.rpc(OFFPEAK_RPC).control({
    action: "client",
    ...(sessionID ? { sessionID } : {}),
  })) as OffpeakRpcOutput;
  if (!result.client) throw new Error("The Offpeak server returned no client status.");
  return result.client;
}

/** Writes only the Desktop default through the selected server's typed RPC. */
export async function setDesktopProtection(
  context: GuiContextLike,
  protection: "on" | "off",
  preferredServerID?: string,
  sessionID?: string,
): Promise<OffpeakClientStatus> {
  const server = resolveTargetServer(context, preferredServerID);
  if (!server) throw new Error("No OpenCode server is available for Offpeak client settings.");
  const result = (await server.client.rpc(OFFPEAK_RPC).control({
    action: "client-set",
    client: "desktop",
    protection,
    ...(sessionID ? { sessionID } : {}),
  })) as OffpeakRpcOutput;
  if (!result.client) throw new Error("The Offpeak server returned no client status.");
  return result.client;
}

/**
 * Sets the explicit per-session override through the server that owns the
 * session, then re-reads the authoritative status. The server's session action
 * answers with a message and state only, so the page always renders the
 * effective protection instead of guessing it.
 */
export async function setSessionProtection(
  context: GuiContextLike,
  protection: "on" | "off",
  preferredServerID?: string,
  sessionID?: string,
): Promise<OffpeakClientStatus> {
  const server = resolveTargetServer(context, preferredServerID);
  if (!server) throw new Error("No OpenCode server is available for Offpeak session settings.");
  if (!sessionID) throw new Error("Open a session to change its off-peak protection.");
  await server.client.rpc(OFFPEAK_RPC).control({
    action: protection === "off" ? "session-off" : "session-on",
    sessionID,
  });
  return readClientStatus(context, preferredServerID, sessionID);
}

/**
 * Registers a Desktop session with the server that owns it. The routed
 * session's own client is used, so a remote session is registered on its
 * remote server rather than on the Desktop's local sidecar.
 */
export async function registerDesktopSession(
  session: GuiSessionLike,
): Promise<OffpeakClientStatus> {
  const result = (await session.server.client.rpc(OFFPEAK_RPC).control({
    action: "client-register",
    client: "desktop",
    sessionID: session.id,
  })) as OffpeakRpcOutput;
  if (!result.client) throw new Error("The Offpeak server returned no client status.");
  return result.client;
}

export function ownershipLabel(ownership: string | undefined): string {
  switch (ownership) {
    case "cli":
      return "CLI session";
    case "desktop":
      return "Desktop session";
    case "ambiguous":
      return "Shared session (CLI + Desktop); protected";
    case "queue":
      return "Queue task; client defaults do not apply";
    default:
      return "Unknown client; protected";
  }
}

export function sourceLabel(source: string | undefined): string {
  switch (source) {
    case "session-override":
      return "Explicit session override";
    case "client-default":
      return "Client default";
    case "ambiguous":
      return "Shared ownership; fail-closed";
    case "queue":
      return "Queue task; explicit task override only";
    default:
      return "No reliable client registration; fail-closed";
  }
}

/** True only when this exact session may use verified peak-priced inference. */
export function peakInferencePermitted(status: OffpeakClientStatus | undefined): boolean {
  return status?.session?.protection === "OFF";
}

/**
 * True only when the session carries an explicit per-session override. This is
 * deliberately not the same as effective protection: a client default can
 * permit peak pricing without any override, and the override is the only state
 * this switch owns.
 */
export function sessionOverrideActive(status: OffpeakClientStatus | undefined): boolean {
  return status?.session?.source === "session-override";
}
