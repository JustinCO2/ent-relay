# Ent Relay

A push relay between [Ent Pathfinder](https://github.com/JustinCO2/ent-pathfinder) players and the community scouting API, run on Cloudflare
Workers. Players connect once and are sent new calls as they happen; the scouting API is read by
the relay alone, **once every 1.5 seconds, however many players are connected**.

## Why it exists

Without it, every installed copy of the plugin polls the scouting API directly, so load on a
community-run database grows with every install — hundreds of always-on players would be hundreds
of requests every few seconds. The relay turns that into one reader:

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

- **One relay object.** Every connection is routed to a single Durable Object, which is what
  guarantees a single reader. It is placed in eastern North America, next to the API.
- **Alarm-driven reads.** While anyone is connected, an alarm reads the API every
  `POLL_INTERVAL_MS` (1500, set in wrangler.toml). When the last player disconnects, the alarm is not
  rescheduled and polling stops.
- **Push on change only.** A read identical to the last one sends nothing.
- **Full snapshots, not diffs.** Each message holds every current call matching the player's
  subscription, so a dropped message or a reconnect can never leave a player out of step.
- **Hibernation.** Between reads the object can be evicted from memory with every connection
  left open, and idle time is not billed. Keep-alive pings are answered without waking it.
- **Only what the plugin uses.** Each call carries what the event is, where, and when. The API
  also returns the name of the scout who reported it; the relay drops that on arrival, so it is
  never stored or sent to anyone.

## Protocol

Connect to `wss://<relay>/ws`, optionally filtered:

```
/ws?type=ENT&world=444     ents on world 444 only
/ws                        everything (type=ANY is the same)
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

`GET /health` reports connection count and read counters. The counters reset whenever the object
hibernates.

## Running it locally

Needs Node 18 or newer. No Cloudflare account is required — this is Cloudflare's local runtime.

```
npm install
npm run dev          # relay on http://127.0.0.1:8787
npm run test:load    # in a second terminal
```

The load test connects 10 clients and then 300 (half filtered, half not), and checks that every
client is pushed to, that filters hold, that pings are answered, that the upstream rate does not
change between the two, and that polling stops once everyone disconnects. `CLIENTS` and
`PHASE_SECONDS` override the defaults.

## Deploying

This should live in a **personal Cloudflare account** created for the purpose. `wrangler.toml`
deliberately has no `account_id`, so deploying always goes through an interactive login and can
never land in whichever account a machine happens to be signed into.

```
npx wrangler login    # sign in to the account you created
npx wrangler whoami   # confirm it is that account before going further
npm run deploy
```

On Windows PowerShell, use `npx.cmd` and `npm.cmd` if script execution is restricted.

The relay is then at `https://ent-relay.<your-subdomain>.workers.dev`, with players connecting to
`wss://ent-relay.<your-subdomain>.workers.dev/ws`.

## Cost

Estimated for **500 players connected around the clock**, against the published free-plan limits:

| Billed as | Use per day | Free limit per day |
|---|---|---|
| Requests (one per connection; players send nothing else) | ~12,000, assuming each reconnects hourly | 100,000 |
| Rows written (one per alarm, every 1.5s) | 57,600 | 100,000 |
| Duration (awake ~0.13s per read; measured on the deployed relay) | ~910 GB-s | 13,000 GB-s |
| Outgoing pushes | any | not billed |

That fits the free plan with room to spare. Rows written depends only on the poll interval, not
on player count. Duration cannot run out at all: one object awake around the clock would use
~11,000 GB-s.

The free plan never bills. Past a limit, further operations of that kind fail until the daily
reset at 00:00 UTC, so the worst case is an outage, never a charge. Upgrading to Workers Paid
($5/month) is the only way to start being charged.

What actually threatens the allowance is not popularity but a misbehaving client reconnecting in
a loop, which is why the plugin's client is built to prevent it — see *Keeping the relay free to
run* in the [plugin's README](https://github.com/JustinCO2/ent-pathfinder#keeping-the-relay-free-to-run).

A per-request alternative — the plugin polling a cached endpoint every 3s — would cost roughly
$28/month at 100 always-on players and $130/month at 500, which is why this is push-based.

## Limits and open questions

- **Connections per object.** Cloudflare documents no hard maximum; its WebSocket guidance
  describes one object serving "thousands of clients". 300 was tested locally. The plugin only
  connects while players are on a single forestry world, which holds at most 2,000. If that ever
  proves too many, connections can be spread over a few objects with only one reading the API.
- **Single point of failure.** If the relay is down, players receive nothing. The plugin says so
  on screen and waits, rather than falling back to the scouting API, which would bring back the
  exact load problem at the worst moment.
- **Latency floor.** Measured end to end at a 1s poll interval, a call reached players a median of ~2.9s after a scout
  saw it; 1.5s adds about a quarter-second on average. Most of it is the scouting plugin batching uploads every 3s, which only its author
  can change; the relay itself adds at most one poll interval.
- **Open endpoint.** Anyone can connect. Each connection costs one request, so abuse would show up
  as request volume; Cloudflare rate limiting can be added if it ever does.
