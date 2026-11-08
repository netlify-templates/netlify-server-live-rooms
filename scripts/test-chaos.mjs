// A randomized run over the local harness (scripts/local.mjs): clients in
// several rooms write the whole time, while every few seconds something goes
// wrong:
//   - a deploy (the old instance keeps its sockets for a few seconds);
//   - the live instance crashes;
//   - the database restarts;
//   - a client goes offline, or comes back;
//   - a client leaves (once its outbox is empty), or a new one joins.
// At the end, every room is checked against the database, the same way
// test-failover.mjs checks one room.
//
//   npm run test:chaos -- [seconds] [seed]
//
// The seed reproduces the sequence of events, not their timing, so different
// seeds and longer runs find more.
import { execFileSync } from "node:child_process";

import { checker, checkResults, openDatabase, sleep, startHarness, TestClient, waitFor } from "./lib/client.mjs";

const SECONDS = Number(process.argv[2] ?? 90);
const SEED = Number(process.argv[3] ?? Date.now() % 100_000);
const PORT = 8898;
const ROOMS = 3;
const url = `ws://localhost:${PORT}/api/live`;
const run = Date.now().toString(36);
const { check, failures } = checker();

// mulberry32: small, seedable, good enough to pick events.
let state = SEED;
const random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);

  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];

const harness = await startHarness(PORT, { OVERLAP_MS: "4000" });

const rooms = Array.from({ length: ROOMS }, (_, i) => `chaos-${run}-${i}`);
const everyone = [];
let writing = true;
let names = 0;

const join = (room) => {
  const client = new TestClient(`c${++names}`, { url, room });

  client.roomId = room;
  everyone.push(client);
  client.write(() => writing && !client.left, 40 + Math.floor(random() * 80));

  return client;
};

// Two clients per room to start with.
rooms.forEach((room) => [join(room), join(room)]);

const active = () => everyone.filter((client) => !client.left);
const counts = {};

const events = {
  async deploy() {
    await fetch(`http://localhost:${PORT}/_local/deploy`, { method: "POST" });
  },
  async crash() {
    const client = pick(active().filter((candidate) => candidate.ready));

    client?.room.send({ type: "crash" });
  },
  async restartDatabase() {
    execFileSync("docker", ["restart", "--time", "1", "live-rooms-db"]);
  },
  async offline() {
    pick(active().filter((client) => !client.room.offline))?.room.setOffline(true);
  },
  async online() {
    pick(active().filter((client) => client.room.offline))?.room.setOffline(false);
  },
  async leave() {
    const client = pick(active().filter((candidate) => candidate.ready && !candidate.room.offline));

    if (client && active().filter((other) => other.roomId === client.roomId).length > 1) {
      client.left = true;
      // A client leaves like a closed tab with nothing unsent: it waits until
      // its outbox is empty.
      await waitFor(() => client.room.pending.length === 0, 10_000, `${client.name}'s outbox`);
      client.room.close();
    }
  },
  async join() {
    join(pick(rooms));
  },
};

const weights = { deploy: 2, crash: 2, restartDatabase: 1, offline: 2, online: 2, leave: 1, join: 2 };
const bag = Object.entries(weights).flatMap(([name, weight]) => Array(weight).fill(name));

console.log(`Chaos for ${SECONDS} s, seed ${SEED}, ${ROOMS} rooms\n`);

const startedAt = Date.now();

while (Date.now() - startedAt < SECONDS * 1_000) {
  await sleep(1_500 + random() * 3_000);

  const name = pick(bag);

  counts[name] = (counts[name] ?? 0) + 1;
  console.log(`[${((Date.now() - startedAt) / 1000).toFixed(0).padStart(3)} s] ${name} (${active().length} clients)`);
  await events[name]();
}

console.log("\nStopping: everyone back online, then no more writes");
active()
  .filter((client) => client.room.offline)
  .forEach((client) => client.room.setOffline(false));
writing = false;
await waitFor(() => active().every((client) => client.ready && client.room.pending.length === 0), 30_000, "outboxes to empty");

const db = await openDatabase();

for (const room of rooms) {
  const { rows: roomRows } = await db.query("select version, state from rooms where id = $1", [room]);
  const { rows } = await db.query("select seq, client_msg_id from room_events where room_id = $1 order by seq", [room]);
  const truth = { version: Number(roomRows[0].version), state: roomRows[0].state, ids: rows.map((row) => row.client_msg_id) };
  const inRoom = everyone.filter((client) => client.roomId === room);
  const stillHere = inRoom.filter((client) => !client.left);

  await waitFor(() => stillHere.every((client) => client.version === truth.version), 10_000, `${room} to settle`);

  console.log(`\n${room}: ${truth.version} versions, ${inRoom.length} clients (${inRoom.length - stillHere.length} left)`);
  check(
    rows.length === truth.version && rows.every((row, index) => Number(row.seq) === index + 1),
    "room_events has no gaps",
  );
  // Clients that left aren't expected to have the final state, but their
  // changes still have to be committed once or rejected.
  checkResults(check, stillHere, truth);
  checkResults(
    (ok, message) => !message.includes("state matches") && !message.includes("outbox") && check(ok, message),
    inRoom.filter((client) => client.left),
    truth,
  );
}

console.log(`\nEvents: ${JSON.stringify(counts)}`);
await db.end();
everyone.forEach((client) => client.room.close());
harness.stop();
await sleep(1_500);

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed (seed ${SEED}). Harness log:\n${harness.log.slice(-5_000)}`);
  process.exit(1);
}

console.log(`\nAll checks passed (seed ${SEED}).`);
process.exit(0);
