/**
 * Load test for a local relay: `npm run dev` in one terminal, `npm run test:load` in another.
 * See the README for what it checks.
 *
 * Environment overrides: RELAY_URL, CLIENTS (default 300), PHASE_SECONDS (default 20).
 */

const BASE_URL = process.env.RELAY_URL ?? "http://127.0.0.1:8787";
const WS_URL = BASE_URL.replace(/^http/, "ws");
const SMALL_CLIENTS = 10;
const LARGE_CLIENTS = Number(process.env.CLIENTS ?? 300);
const PHASE_SECONDS = Number(process.env.PHASE_SECONDS ?? 20);
const IDLE_CHECK_SECONDS = 5;

/** Comfortably longer than the relay's poll interval. */
const SETTLE_MS = 3000;

/** Half the clients ask for the forestry world, like the plugin; half take every world. */
const FILTERED_QUERY = "?world=444";

const failures = [];

await main();

async function main() {
  console.log(`Relay: ${BASE_URL}\n`);

  const small = await runPhase(SMALL_CLIENTS);
  const large = await runPhase(LARGE_CLIENTS);
  const idleReads = await readsWhileIdle();

  printPhase("Small", small);
  printPhase("Large", large);
  console.log(`Idle  ${IDLE_CHECK_SECONDS}s with no clients: ${idleReads} upstream reads\n`);

  checkUpstreamLoadIsFlat(small, large);
  check(idleReads === 0, "polling stops when no clients are connected");

  if (failures.length > 0) {
    console.log("FAILED:");
    failures.forEach((failure) => console.log(`  - ${failure}`));
    process.exit(1);
  }
  console.log("All checks passed.");
}

/** Connect `count` clients, hold them for PHASE_SECONDS, and measure what happened. */
async function runPhase(count) {
  const before = await health();
  const clients = await connectClients(count);
  const pingAnswered = await pingAnswers(clients[0]);

  await sleep(PHASE_SECONDS * 1000);

  const after = await health();
  clients.forEach((client) => client.socket.close());
  await sleep(1000);

  const reads = after.upstreamReads - before.upstreamReads;
  const silentClients = clients.filter((client) => client.messages === 0).length;
  const filterViolations = clients.reduce((sum, client) => sum + client.filterViolations, 0);

  check(silentClients === 0, `all ${count} clients received at least one push (${silentClients} did not)`);
  check(filterViolations === 0, `clients only received ents, and filtered ones only on world 444 (${filterViolations} stray)`);
  check(pingAnswered, "a keep-alive ping was answered with pong");

  return {
    count,
    reads,
    readsPerSecond: reads / PHASE_SECONDS,
    messages: clients.reduce((sum, client) => sum + client.messages, 0),
    peakConnections: after.connections,
    failures: after.upstreamFailures - before.upstreamFailures,
  };
}

async function connectClients(count) {
  const clients = [];
  for (let i = 0; i < count; i++) {
    clients.push(connectClient(i % 2 === 0));
  }
  await Promise.all(clients.map((client) => client.opened));
  return clients;
}

function connectClient(filtered) {
  const socket = new WebSocket(`${WS_URL}/ws${filtered ? FILTERED_QUERY : ""}`);
  const client = { socket, filtered, messages: 0, filterViolations: 0 };

  client.opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("connection failed")), { once: true });
  });

  socket.addEventListener("message", (event) => {
    if (event.data === "pong") {
      return;
    }
    const message = JSON.parse(event.data);
    client.messages++;
    client.filterViolations += message.calls.filter((call) => isStray(call, filtered)).length;
  });

  return client;
}

function isStray(call, filtered) {
  return call.event_type !== "ENT" || (filtered && call.world !== 444);
}

function pingAnswers(client) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    client.socket.addEventListener("message", (event) => {
      if (event.data === "pong") {
        clearTimeout(timer);
        resolve(true);
      }
    });
    client.socket.send("ping");
  });
}

/**
 * Waits out one poll interval first: an alarm already due when the last clients disconnect can
 * still see sockets that are mid-close and make one final read. Polling has stopped once that
 * settles, and from then on there must be no reads at all.
 */
async function readsWhileIdle() {
  await sleep(SETTLE_MS);
  const before = await health();
  await sleep(IDLE_CHECK_SECONDS * 1000);
  const after = await health();
  return after.upstreamReads - before.upstreamReads;
}

/** Hundreds of clients must not read the API more often than a handful, give or take timing. */
function checkUpstreamLoadIsFlat(small, large) {
  const tolerance = 1.25;
  check(
    large.readsPerSecond <= small.readsPerSecond * tolerance,
    `upstream rate with ${large.count} clients (${large.readsPerSecond.toFixed(2)}/s) ` +
      `matches ${small.count} clients (${small.readsPerSecond.toFixed(2)}/s)`,
  );
}

function printPhase(label, phase) {
  console.log(
    `${label.padEnd(5)} ${String(phase.count).padStart(4)} clients | ` +
      `${phase.reads} upstream reads (${phase.readsPerSecond.toFixed(2)}/s) | ` +
      `${phase.messages} messages delivered | ${phase.failures} upstream failures`,
  );
}

async function health() {
  const response = await fetch(`${BASE_URL}/health`);
  return response.json();
}

function check(passed, description) {
  console.log(`${passed ? "PASS" : "FAIL"}  ${description}`);
  if (!passed) {
    failures.push(description);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
