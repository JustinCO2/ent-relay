import { CallRelay } from "./relay.js";

export { CallRelay };

/** Every connection goes to this one relay object, so the scouting API has a single reader. */
const RELAY_NAME = "global";

/** Keep the object near the scouting API: the read every 1.5s is the hop worth keeping short. */
const RELAY_LOCATION = "enam";

const ROUTES = new Set(["/ws", "/health"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!ROUTES.has(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }

    // Turn junk away here, so it costs one request rather than also waking the relay object.
    if (url.pathname === "/ws" && request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const id = env.CALL_RELAY.idFromName(RELAY_NAME);
    const relay = env.CALL_RELAY.get(id, { locationHint: RELAY_LOCATION });
    return relay.fetch(request);
  },
};
