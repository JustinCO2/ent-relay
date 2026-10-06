/**
 * What a connected client wants to hear about.
 *
 * Clients put their filters on the connection URL, e.g. /ws?type=ENT&world=444, and only receive
 * matching calls. A missing filter (or type=ANY) means "everything", which the plugin's debug
 * mode uses.
 */

export function parseSubscription(url) {
  return {
    type: parseType(url.searchParams.get("type")),
    world: parseWorld(url.searchParams.get("world")),
  };
}

export function callsFor(subscription, calls) {
  return calls.filter((call) => matches(subscription, call));
}

function matches(subscription, call) {
  if (subscription.type !== null && call.event_type !== subscription.type) {
    return false;
  }
  if (subscription.world !== null && call.world !== subscription.world) {
    return false;
  }
  return true;
}

function parseType(value) {
  if (!value || value.toUpperCase() === "ANY") {
    return null;
  }
  return value.toUpperCase();
}

function parseWorld(value) {
  const world = Number.parseInt(value ?? "", 10);
  return Number.isInteger(world) && world > 0 ? world : null;
}
