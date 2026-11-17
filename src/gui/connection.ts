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

export interface GuiContextLike {
  client: GuiOpenCodeClientLike;
  sessions: {
    current(): GuiSessionLike | undefined;
  };
  servers: {
    list(): readonly string[];
    get(id: string): GuiServerLike | undefined;
  };
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
  return context.sessions.current()?.server;
}

/** The server selected on first render: current session, then a remote, then sidecar. */
export function defaultServerID(context: GuiContextLike): string | undefined {
  const current = context.sessions.current()?.server.id;
  if (current) return current;
  const listed = context.servers.list();
  const remote = listed.find((id) => {
    const server = context.servers.get(id);
    return server !== undefined && server.builtin !== true && server.id !== "sidecar";
  });
  if (remote) return remote;
  if (listed.includes("sidecar")) return "sidecar";
  return listed[0];
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
