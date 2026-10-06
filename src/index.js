import { CallRelay } from "./relay.js";

export { CallRelay };

/**
 * Every connection is routed to the same single relay object. That is what guarantees the scouting
 * API has exactly one reader, however many players are connected.
 */
const RELAY_NAME = "global";

/**
 * Run the relay object near the scouting API, which is hosted in Oracle's us-ashburn region.
 * Players connect to it from anywhere; the hop that happens every second is the one kept short.
 */
const RELAY_LOCATION = "enam";

const ROUTES = new Set(["/ws", "/health"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!ROUTES.has(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }

    // Refuse anything that is not a real connection attempt here, before it reaches the relay
    // object. Junk traffic then costs one request rather than two.
    if (url.pathname === "/ws" && request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const id = env.CALL_RELAY.idFromName(RELAY_NAME);
    const relay = env.CALL_RELAY.get(id, { locationHint: RELAY_LOCATION });
    return relay.fetch(request);
  },
};
