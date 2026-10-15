/** Reading ent calls from the scouting API. The single relay object is the only caller. */

/** The only event the plugin follows, and so the only one read. */
const EVENT_TYPE = "ENT";

/**
 * Two ent lifetimes, as long as the plugin keeps an ent: a client connecting mid-event then gets
 * every earlier report of each running ent, so a late report joins its ent instead of looking new.
 */
const WINDOW_SECONDS = 240;

/** The window rarely holds more than a few dozen calls. A ceiling, not a page size. */
const ROW_LIMIT = 500;

const TIMEOUT_MS = 5000;

/** A failure described by the relay itself, so its message is safe to show publicly. */
export class UpstreamError extends Error {}

/**
 * Every ent call from the last WINDOW_SECONDS, in the shape clients receive. The query asks for
 * ents only, and the rows are filtered again in case an endpoint ignores that.
 */
export async function readRecentCalls(upstreamUrl, nowSeconds) {
  const response = await fetchWithTimeout(buildUrl(upstreamUrl, nowSeconds), {
    headers: { "User-Agent": "ent-relay (Ent Pathfinder RuneLite plugin)" },
  });
  if (!response.ok) {
    throw new UpstreamError(`Scouting API returned HTTP ${response.status}`);
  }

  const body = await response.json();
  const rows = Array.isArray(body.items) ? body.items : [];
  return rows.filter((row) => row.event_type === EVENT_TYPE).map(toCall);
}

/**
 * fetch() with a timeout that is cleared the moment the request settles. AbortSignal.timeout()
 * leaves its timer pending after a fast response, and a Durable Object with a pending timer never
 * sleeps, so it would be billed awake around the clock.
 */
async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(upstreamUrl, nowSeconds) {
  const url = new URL(upstreamUrl);
  url.searchParams.set("q", JSON.stringify({
    event_type: EVENT_TYPE,
    discovered_time: { $gt: nowSeconds - WINDOW_SECONDS },
  }));
  url.searchParams.set("limit", String(ROW_LIMIT));
  return url;
}

/** What the event is, where, and when. Nothing about who reported it is kept or forwarded. */
function toCall(row) {
  return {
    event_type: row.event_type,
    world: row.world,
    x_coord: row.x_coord,
    y_coord: row.y_coord,
    plane: row.plane ?? 0,
    discovered_time: row.discovered_time,
  };
}
