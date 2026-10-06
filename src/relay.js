import { DurableObject } from "cloudflare:workers";
import { readRecentCalls, UPSTREAM_URL } from "./upstream.js";
import { callsFor, parseSubscription } from "./subscription.js";

const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Floor on the poll interval, so a mistyped config value cannot hammer the API. */
const MIN_POLL_INTERVAL_MS = 500;

/** Longest wait between reads while the scouting API keeps failing. */
const MAX_FAILURE_DELAY_MS = 60_000;

/** Enough doublings to reach the cap from any sensible poll interval. */
const MAX_DOUBLINGS = 6;

const FAILURES_KEY = "consecutiveFailures";

/**
 * The one place the scouting API is read from.
 *
 * Every connected player holds a WebSocket to this single object. While at least one is connected,
 * an alarm reads the API every POLL_INTERVAL_MS and pushes any change out. With nobody connected,
 * polling stops entirely.
 *
 * Connections use the WebSocket Hibernation API: between reads the object can be evicted from
 * memory with every connection still open, and nothing is billed for that idle time. Anything kept
 * in memory can therefore disappear between alarms -- the fields below are written with that in mind.
 */
export class CallRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    /**
     * The most recent read. Used to greet new connections and to skip pushing a snapshot that has
     * not changed. Lost whenever the object hibernates, which costs at most one repeated push --
     * clients already ignore reports they have seen.
     */
    this.latestCalls = null;
    this.latestSnapshotKey = null;

    /** Reads failed in a row. Null until loaded from storage; see loadFailureCount(). */
    this.consecutiveFailures = null;

    /** Counters for /health. Like everything in memory, they reset when the object hibernates. */
    this.stats = {
      upstreamReads: 0,
      upstreamFailures: 0,
      broadcasts: 0,
      lastReadAt: null,
      lastError: null,
    };

    // Keep-alive pings are answered without waking the object, so quiet connections cost nothing.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return this.healthResponse();
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    return this.acceptClient(url);
  }

  async acceptClient(url) {
    const { 0: client, 1: server } = new WebSocketPair();

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(parseSubscription(url));

    // A new player should see what is already running, not wait for the next change.
    if (this.latestCalls !== null) {
      this.sendCalls(server, this.latestCalls);
    }
    await this.startPollingIfStopped();

    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      // Nobody is listening. Not rescheduling lets polling stop until someone connects.
      return;
    }

    try {
      await this.readAndBroadcast();
      await this.recordSuccess();
    } catch (error) {
      this.stats.upstreamFailures++;
      this.stats.lastError = String(error);
      await this.recordFailure();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + this.nextReadDelayMs());
    }
  }

  /**
   * Normally the poll interval. While the scouting API is failing, each further failure doubles the
   * wait, up to a minute, rather than keep hitting a server that may be struggling -- possibly
   * because it is overloaded. The first successful read returns to full speed.
   */
  nextReadDelayMs() {
    const interval = this.pollIntervalMs();
    const backedOff = interval * 2 ** Math.min(this.consecutiveFailures ?? 0, MAX_DOUBLINGS);
    return Math.min(backedOff, Math.max(interval, MAX_FAILURE_DELAY_MS));
  }

  /**
   * The failure count lives in storage, not just memory: the relay sleeps between reads and can be
   * evicted, and an in-memory count would reset to zero each time, so the backoff would never grow.
   * It is written only when it changes -- on a failure, and on recovery -- never on a normal read.
   */
  async loadFailureCount() {
    if (this.consecutiveFailures === null) {
      this.consecutiveFailures = (await this.ctx.storage.get(FAILURES_KEY)) ?? 0;
    }
    return this.consecutiveFailures;
  }

  async recordFailure() {
    this.consecutiveFailures = (await this.loadFailureCount()) + 1;
    await this.ctx.storage.put(FAILURES_KEY, this.consecutiveFailures);
  }

  async recordSuccess() {
    if ((await this.loadFailureCount()) > 0) {
      this.consecutiveFailures = 0;
      await this.ctx.storage.delete(FAILURES_KEY);
    }
  }

  async readAndBroadcast() {
    const calls = await readRecentCalls(this.upstreamUrl(), nowSeconds());
    this.stats.upstreamReads++;
    this.stats.lastReadAt = new Date().toISOString();

    const snapshotKey = JSON.stringify(calls);
    if (snapshotKey === this.latestSnapshotKey) {
      return; // nothing new, so nothing to push
    }

    this.latestCalls = calls;
    this.latestSnapshotKey = snapshotKey;
    this.broadcast(calls);
  }

  broadcast(calls) {
    for (const socket of this.ctx.getWebSockets()) {
      this.sendCalls(socket, calls);
    }
    this.stats.broadcasts++;
  }

  /**
   * Send a client every current call matching its subscription. Each message is a full snapshot
   * rather than a diff, so a client that missed a message, or reconnected, is never out of step.
   */
  sendCalls(socket, calls) {
    const subscription = socket.deserializeAttachment();
    const message = {
      type: "calls",
      serverTime: nowSeconds(),
      calls: callsFor(subscription, calls),
    };

    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The socket closed between being listed and being sent to. Its close handler tidies up.
    }
  }

  async startPollingIfStopped() {
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  async webSocketMessage() {
    // Clients have nothing to say. "ping" is answered automatically, without reaching here.
  }

  async webSocketClose(socket) {
    closeQuietly(socket);
  }

  async webSocketError(socket) {
    closeQuietly(socket);
  }

  /**
   * The scouting API, unless overridden. The override exists for testing -- pointing a local relay
   * at a deliberately broken address is how the failure backoff is exercised.
   */
  upstreamUrl() {
    return this.env.UPSTREAM_URL || UPSTREAM_URL;
  }

  pollIntervalMs() {
    const configured = Number.parseInt(this.env.POLL_INTERVAL_MS ?? "", 10);
    const interval = Number.isInteger(configured) ? configured : DEFAULT_POLL_INTERVAL_MS;
    return Math.max(MIN_POLL_INTERVAL_MS, interval);
  }

  healthResponse() {
    return Response.json({
      connections: this.ctx.getWebSockets().length,
      pollIntervalMs: this.pollIntervalMs(),
      consecutiveFailures: this.consecutiveFailures ?? 0,
      nextReadDelayMs: this.nextReadDelayMs(),
      ...this.stats,
    });
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** Finish a close handshake, ignoring a socket that is already gone. */
function closeQuietly(socket) {
  try {
    socket.close(1000, "closing");
  } catch {
    // already closed
  }
}
