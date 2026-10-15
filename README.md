# Ent Relay

A push relay between [Ent Pathfinder](https://github.com/JustinCO2/ent-pathfinder) players and the
community scouting API, run on Cloudflare Workers. Players connect once and are sent ent calls as
they happen, while the scouting API is read by the relay alone: **once every 1.5 seconds, however
many players are connected**.

```
 scouting API  <── one read every 1.5s ──  relay (one Durable Object)  ── push ──>  every player
```

Measured locally with `npm run test:load`, at a 1s poll interval:

| Connected players | Upstream reads |
|---|---|
| 10 | 0.95 / s |
| 300 | 1.00 / s |
| 0 | none — polling stops |

## How it works

- **One relay object.** Every connection goes to a single Durable Object, so the API has exactly
  one reader. It runs in eastern North America, near the API.
- **Reads only while someone listens.** An alarm reads the API every `POLL_INTERVAL_MS` (set in
  `wrangler.toml`) while anyone is connected, and stops when the last player leaves.
- **Push on change, as full snapshots.** A read identical to the last one sends nothing. Each message
  holds every current call for that player, so a missed message or a reconnect never leaves them
  out of step.
- **Hibernation.** Between reads the object can sleep with every connection left open, and idle
  time is not billed. Keep-alive pings are answered without waking it.
- **Ents only, and nothing about scouts.** The relay asks the API for ents only and filters again
  on arrival. Each call carries what the event is, where and when; nothing about who reported it
  is kept or forwarded.

## Protocol

Connect to `wss://<relay>/ws`, optionally filtered by world:

```
/ws?world=444     ents on world 444
/ws               ents on every world
```

Every message is a full snapshot:

```json
{
  "type": "calls",
  "serverTime": 1790000000,
  "calls": [
    { "event_type": "ENT", "world": 444, "x_coord": 1383, "y_coord": 3281, "plane": 0,
      "discovered_time": 1789999990 }
  ]
}
```

Send the text `ping` to keep a quiet connection alive; the reply is `pong`.

`GET /health` reports connections and read counters, which reset whenever the object sleeps. It is
public, so a failed read shows only the relay's own message (an HTTP status, or a missing secret);
any other error shows just its type, with the details in `wrangler tail`.

## Running it locally

Needs Node 18 or newer, and no Cloudflare account. The scouting API's read address is not in this
repository; put it in `.dev.vars`, which is gitignored:

```
UPSTREAM_URL=https://...
```

```
npm install
npm run dev          # relay on http://127.0.0.1:8787
npm run test:load    # in a second terminal
```

The load test connects 10 clients and then 300, half of them filtered by world. It checks that every
client is pushed to, that only ents arrive and filters hold, that pings are answered, that the
upstream rate stays flat, and that polling stops once everyone leaves. `CLIENTS` and
`PHASE_SECONDS` override the defaults.

## Deploying

`wrangler.toml` has no `account_id`, so deploying always asks which account to use:

```
npx wrangler login
npx wrangler whoami                    # confirm it is the right account
npx wrangler secret put UPSTREAM_URL   # paste the read address when prompted
npm run deploy
```

Without the secret the relay still accepts connections, but every read fails and `/health` shows
`UPSTREAM_URL is not set`. On Windows PowerShell, use `npx.cmd` and `npm.cmd` if script execution is
restricted.

## Cost and limits

- **Fits the free plan.** Reads are fixed at one per 1.5 seconds whatever the player count, an idle
  relay is not billed, and pushes are free. That is why the relay pushes rather than having every
  player poll.
- **Connections per object.** Cloudflare documents no hard maximum for one object. 300 were tested
  locally, and the plugin only connects from world 444, which holds at most 2,000 players.
- **Single point of failure.** If the relay is down, players receive nothing. The plugin waits rather
  than falling back to polling the API, which would bring back the load problem.
- **Latency.** A call reaches players a median of about 3 seconds after a scout sees it, most of it
  the scouting plugin's own 3-second upload batching.
