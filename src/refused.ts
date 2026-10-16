/**
 * The refused-attempt sentinel.
 *
 * A cancelled hold must end its attempt without contacting the provider, and
 * OpenCode's plugin API has no typed failure channel for model requests: a hook
 * that throws fails the whole execution instead of engaging OpenCode's retry
 * machinery. The one supported way to hand the decision back to OpenCode is a
 * transport failure, so a cancelled request is replaced with a minimal request
 * to a closed loopback endpoint before it is sent.
 *
 * The sentinels are inert by construction:
 *
 * - They point at loopback port 1, where no service can be reached, so the
 *   connection is refused locally and nothing leaves the machine.
 * - The replacement carries no credentials, no provider headers, no user data,
 *   and no body — only a marker header naming the reason.
 * - The pricing guard skips an already-refused request instead of holding it
 *   again at the transport boundary.
 */
export const REFUSED_REQUEST_URL = "http://127.0.0.1:1/opencode-offpeak-hold-cancelled";
export const REFUSED_HANDSHAKE_URL = "ws://127.0.0.1:1/opencode-offpeak-hold-cancelled";
export const REFUSED_HEADER = "x-opencode-offpeak-refused";

/** The credential-free replacement request for a cancelled hold. */
export function refusedRequest(): Request {
  return new Request(REFUSED_REQUEST_URL, {
    method: "GET",
    headers: { [REFUSED_HEADER]: "1" },
  });
}

/** True when a request is the placeholder for a cancelled hold. */
export function isRefusedRequestUrl(url: string | undefined): boolean {
  return url === REFUSED_REQUEST_URL;
}

/** True when a websocket handshake targets the cancelled-hold placeholder. */
export function isRefusedHandshakeUrl(url: string | undefined): boolean {
  return url === REFUSED_HANDSHAKE_URL;
}
