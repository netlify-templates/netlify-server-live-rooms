// Checks the guarantees through a deploy, the overlap, a graceful shutdown, a
// crash and a client going offline, using the local harness
// (scripts/local.mjs). Three clients write as fast as they can while this
// script:
//   1. deploys, so old clients stay on the old instance while new ones join
//      the new instance, and checks that writes cross between them;
//   2. lets the old instance shut down, so its clients reconnect;
//   3. crashes the live instance, with one client offline;
//   4. brings that client back;
//   5. restarts the database, so commits fail and clients have to resend;
//   6. freezes the database, so queries hang rather than fail, and checks
//      that commits give up on it and their clients reconnect and resend.
// Then it stops writing, waits for every outbox to empty, and checks the
// results against the database.
//
//   npm run test:failover              # NOTIFY, with polling as the safety net
//   NOTIFY=off npm run test:failover   # polling only
import { execFileSync } from "node:child_process";

import { checker, checkResults, openDatabase, sleep, startHarness, TestClient, waitFor } from "./lib/client.mjs";

const PORT = Number(process.env.PORT ?? 8899);
const OVERLAP_MS = 4_000;
const ROOM = `test-${Date.now().toString(36)}`;
const url = `ws://localhost:${PORT}/api/live`;
const { check, failures } = checker();

const harness = await startHarness(PORT, { OVERLAP_MS: String(OVERLAP_MS) });

console.log(`Room ${ROOM}, NOTIFY=${process.env.NOTIFY ?? "on"}\n`);

let writing = true;
const clients = [new TestClient("ana", { url, room: ROOM }), new TestClient("ben", { url, room: ROOM })];
const [ana, ben] = clients;
const allReady = () => clients.every((client) => client.ready || client.room.offline);

await waitFor(allReady, 5_000, "the first clients");
const firstInstance = ana.instance;

clients.forEach((client) => client.write(() => writing));
await sleep(1_000);

console.log("Deploying");
await fetch(`http://localhost:${PORT}/_local/deploy`, { method: "POST" });

const cara = new TestClient("cara", { url, room: ROOM });

clients.push(cara);
await waitFor(() => cara.ready, 5_000, "cara");
cara.write(() => writing);
check(cara.instance !== firstInstance, `a client that joins after the deploy lands on the new instance (${firstInstance} -> ${cara.instance})`);
await sleep(1_500);
check(ana.instance === firstInstance && ana.eventsFrom.has(cara.instance), "during the overlap, a client on the old instance gets writes made on the new one");
check(cara.eventsFrom.has(firstInstance), "and a client on the new instance gets writes made on the old one");

console.log(`Waiting for the old instance's shutdown (${OVERLAP_MS / 1000} s overlap)`);
await sleep(OVERLAP_MS);
await waitFor(() => ana.instance !== firstInstance && allReady(), 5_000, "the old instance's clients to move");
check(
  clients.every((client) => client.instance === cara.instance),
  "after the old instance shuts down, its clients reconnect to the new one",
);

console.log("Crashing the live instance, with ben offline");
const crashed = cara.instance;

ben.room.setOffline(true);
cara.room.send({ type: "crash" });
await sleep(500);
await waitFor(() => clients.every((client) => client.room.offline || (client.ready && client.instance !== crashed)), 20_000, "reconnects after the crash");
check(
  clients.every((client) => client.room.offline || client.instance !== crashed),
  "after a crash, clients reconnect to the replacement",
);

console.log("Bringing ben back online");
await sleep(1_000);
ben.room.setOffline(false);
await sleep(1_000);

console.log("Restarting the database");
const beforeRestart = cara.instance;

execFileSync("docker", ["restart", "--time", "1", "live-rooms-db"]);
await sleep(2_000);
await waitFor(allReady, 30_000, "reconnects after the database restart");
check(cara.instance === beforeRestart, `the instance survives the database restart (${beforeRestart} -> ${cara.instance})`);

// Paused, the database keeps its connections open but doesn't answer, like a
// network that drops packets.
console.log("Freezing the database for up to 20 s");
const frozenAt = Date.now();

try {
  execFileSync("docker", ["pause", "live-rooms-db"]);
  const gaveUp = await waitFor(() => clients.some((client) => client.droppedAt > frozenAt), 20_000, "commits to give up on the frozen database");

  check(gaveUp, `commits gave up on the frozen database, and their clients reconnected (after ${((Date.now() - frozenAt) / 1000).toFixed(1)} s)`);
} finally {
  execFileSync("docker", ["unpause", "live-rooms-db"]);
}
await waitFor(allReady, 30_000, "reconnects after the freeze");

writing = false;
await waitFor(() => allReady() && clients.every((client) => client.room.pending.length === 0), 15_000, "outboxes to empty");

const db = await openDatabase();

const { rows: roomRows } = await db.query("select version, state from rooms where id = $1", [ROOM]);
const { rows: events } = await db.query("select seq, client_msg_id from room_events where room_id = $1 order by seq", [ROOM]);
const truth = { version: Number(roomRows[0].version), state: roomRows[0].state, ids: events.map((event) => event.client_msg_id) };

await waitFor(() => clients.every((client) => client.version === truth.version), 5_000, "everyone to reach the last version");

console.log("\nResults");
check(
  events.length === truth.version && events.every((event, index) => Number(event.seq) === index + 1),
  `room_events has versions 1 to ${truth.version}, with no gaps`,
);
checkResults(check, clients, truth);

await db.end();
clients.forEach((client) => client.room.close());
harness.stop();
await sleep(1_500);

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed. Harness log:\n${harness.log}`);
  process.exit(1);
}

console.log("\nAll checks passed.");
process.exit(0);
