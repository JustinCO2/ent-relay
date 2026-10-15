/**
 * Which ents a connected client wants to hear about. The relay only carries ents, so the one filter
 * is the world, on the connection URL: /ws?world=444 sends ents on world 444; /ws sends every world.
 */

export function parseSubscription(url) {
  return { world: parseWorld(url.searchParams.get("world")) };
}

export function callsFor(subscription, calls) {
  return subscription.world === null ? calls : calls.filter((call) => call.world === subscription.world);
}

function parseWorld(value) {
  const world = Number.parseInt(value ?? "", 10);
  return Number.isInteger(world) && world > 0 ? world : null;
}
