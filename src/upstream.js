/**
 * Reading the community scouting API.
 *
 * This is the only code in the relay that talks to the API, and the single relay object is its only
 * caller, so the API sees one reader no matter how many players are connected.
 */

export const UPSTREAM_URL =
  "https://g98c6e9efd32fb1-scouting.adb.us-ashburn-1.oraclecloudapps.com/ords/scouting/calls/";

/** How far back to ask for calls. Matches the widest window the plugin tracks anything for. */
const WINDOW_SECONDS = 330;

/** The window rarely holds more than a few dozen calls. This is a ceiling, not a page size. */
const ROW_LIMIT = 500;

const TIMEOUT_MS = 5000;

/**
 * Fetch every call from the last WINDOW_SECONDS, converted to the shape clients receive.
 * Throws on any failure; the caller decides what a failed read means.
 */
export async function readRecentCalls(upstreamUrl, nowSeconds) {
  const response = await fetchWithTimeout(buildUrl(upstreamUrl, nowSeconds), {
    headers: { "User-Agent": "ent-relay (Ent Pathfinder RuneLite plugin)" },
  });
  if (!response.ok) {
    throw new Error(`Scouting API returned HTTP ${response.status}`);
  }

  const body = await response.json();
  const rows = Array.isArray(body.items) ? body.items : [];
  return rows.map(toCall);
}

/**
 * fetch() with a timeout whose timer is cleared the moment the request settles.
 *
 * AbortSignal.timeout() looks equivalent but leaves its timer pending after a fast response, and a
 * Durable Object with a pending timer is never idle: it cannot hibernate and is billed for duration
 * the entire time. On the deployed relay it held every 0.1s read open for the full 1.6s between
 * reads, awake around the clock (~11,000 GB-s/day). Clearing the timer cut each read to ~0.13s
 * (~900 GB-s/day), measured after deploying.
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
  url.searchParams.set("q", JSON.stringify({ discovered_time: { $gt: nowSeconds - WINDOW_SECONDS } }));
  url.searchParams.set("limit", String(ROW_LIMIT));
  return url;
}

/**
 * Keep only what the plugin uses: what the event is, where, and when.
 *
 * The API also returns the name of the scout who reported each sighting. Nothing in the plugin needs
 * it, so it is dropped here, on arrival -- never stored, never transformed, never sent to anyone.
 */
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
