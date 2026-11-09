// Approximate performance numbers, either locally (two instances against the
// Docker database) or against a deploy:
//
//   npm run bench                                  # local, NOTIFY
//   NOTIFY=off npm run bench                       # local, polling only
//   npm run bench -- https://<site>.netlify.app    # a deploy (one instance)
//
// Every change is a "move" of one note, so nothing is ever rejected and the
// numbers are about the plumbing, not the board's rules. Latencies are
// measured in this process, from sending a change to receiving its ack or its
// event, so they include the network both ways.
import { connect, op, roomId, sleep, startInstance, stopInstance, until } from "../test/helpers.mjs";

const site = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const quick = process.argv.includes("--quick");
const SECONDS = quick ? 4 : 8;

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
};
const ms = (value) => `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
const summary = (values) => `p50 ${ms(percentile(values, 50))}, p95 ${ms(percentile(values, 95))}, p99 ${ms(percentile(values, 99))}`;
const report = (name, value) => {
  console.log(`  ${name.padEnd(46)} ${value}`);
};

let instances = [];
let urls;

if (site) {
  const base = `${site.replace(/^http/, "ws")}/api/live`;

  urls = [base, base];
  console.log(`Benchmarking ${site}\n`);
} else {
  instances = await Promise.all([startInstance(), startInstance()]);
  urls = instances.map((instance) => instance.url);
  console.log(`Benchmarking two local instances, NOTIFY=${process.env.NOTIFY ?? "on"}\n`);
}

const [A, B] = urls;

// A room with one note in it, so every later change can be a move.
const prepare = async (url) => {
  const room = roomId("bench");
  const client = await connect(url, { room });

  await client.next((m) => m.type === "ready");
  client.send(op("add", "note"));
  await client.next((m) => m.type === "ack");
  client.close();

  return room;
};

const move = () => op("move", "note", { x: Math.floor(Math.random() * 2000), y: 1 });

const ready = async (url, params) => {
  const client = await connect(url, params);

  await client.next((m) => m.type === "ready", 30_000);

  return client;
};

// Sends one change at a time and waits for its ack.
const sequential = async (client, count) => {
  const latencies = [];

  for (let i = 0; i < count; i++) {
    const change = move();
    const start = performance.now();

    client.send(change);
    await client.next((m) => m.type === "ack" && m.id === change.id, 10_000);
    latencies.push(performance.now() - start);
  }

  return latencies;
};

// Keeps up to `window` changes in flight on each writer for `seconds`.
// Returns the acks per second and their latencies.
const saturate = async (writers, window, seconds) => {
  const latencies = [];
  const deadline = performance.now() + seconds * 1_000;
  let acked = 0;

  await Promise.all(
    writers.map(async (client) => {
      const inFlight = new Map();

      client.socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);

        if (message.type === "ack" && inFlight.has(message.id)) {
          latencies.push(performance.now() - inFlight.get(message.id));
          inFlight.delete(message.id);
          acked++;
        }
      });

      while (performance.now() < deadline) {
        while (inFlight.size < window) {
          const change = move();

          inFlight.set(change.id, performance.now());
          client.send(change);
        }
        await sleep(1);
      }
      await until(() => inFlight.size === 0, 30_000, "the last acks");
    }),
  );

  return { perSecond: acked / seconds, latencies };
};

// How long a change takes to reach other clients: `writer` sends `count`
// changes at `rate` a second, and every reader records when each arrives.
const visibility = async (writer, readers, count, rate) => {
  const sentAt = new Map();
  const latencies = [];

  for (const reader of readers) {
    reader.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);

      if (message.type === "event" && sentAt.has(message.id)) {
        latencies.push(performance.now() - sentAt.get(message.id));
      }
    });
  }

  for (let i = 0; i < count; i++) {
    const change = move();

    sentAt.set(change.id, performance.now());
    writer.send(change);
    await sleep(1_000 / rate);
  }
  await until(() => latencies.length === count * readers.length, 15_000, "every reader to get every change");

  return latencies;
};

const close = (...clients) => clients.flat().forEach((client) => client.close());

// 1. Round trips with no database involved.
{
  const client = await ready(A, { room: roomId("ping") });
  const latencies = [];

  for (let i = 0; i < 100; i++) {
    const start = performance.now();

    client.send({ type: "ping", t: i });
    await client.next((m) => m.type === "pong" && m.t === i);
    latencies.push(performance.now() - start);
  }
  report("WebSocket round trip (ping)", summary(latencies));
  close(client);
}

// 2. One change at a time.
{
  const room = await prepare(A);
  const client = await ready(A, { room });

  report("Commit, one at a time (send -> ack)", summary(await sequential(client, quick ? 100 : 300)));
  close(client);
}

// 3. Visibility to other clients.
{
  const room = await prepare(A);
  const writer = await ready(A, { room });
  const same = await ready(A, { room });
  const other = await ready(B, { room });
  const sentAt = new Map();
  const byReader = { same: [], other: [] };

  for (const [name, reader] of Object.entries({ same, other })) {
    reader.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);

      if (message.type === "event" && sentAt.has(message.id)) {
        byReader[name].push(performance.now() - sentAt.get(message.id));
      }
    });
  }

  const count = quick ? 50 : 150;

  for (let i = 0; i < count; i++) {
    const change = move();

    sentAt.set(change.id, performance.now());
    writer.send(change);
    await sleep(100);
  }
  await until(() => byReader.same.length === count && byReader.other.length === count, 15_000, "both readers");
  report("Change -> other client, same instance", summary(byReader.same));
  if (!site) {
    report("Change -> other client, other instance", summary(byReader.other));
  }
  close(writer, same, other);
}

// 4. Fan-out to 50 readers in one room.
{
  const room = await prepare(A);
  const writer = await ready(A, { room });
  const readers = await Promise.all(Array.from({ length: 50 }, (_, i) => ready(i % 2 && !site ? B : A, { room })));

  report(`Change -> 50 readers${site ? "" : " (on both instances)"}`, summary(await visibility(writer, readers, quick ? 20 : 50, 5)));
  close(writer, readers);
}

// 5. Throughput into one room, and across rooms. With a long round trip to
// the server, few changes in flight limit what the client can send, so the
// last runs keep more in flight to find what the server can do.
for (const [writersCount, window] of [
  [1, 10],
  [4, 10],
  [16, 10],
  [16, 50],
]) {
  const room = await prepare(A);
  const writers = await Promise.all(Array.from({ length: writersCount }, (_, i) => ready(i % 2 && !site ? B : A, { room })));
  const { perSecond, latencies } = await saturate(writers, window, SECONDS);

  report(`One room, ${writersCount} writer${writersCount > 1 ? "s" : ""} (${window} in flight each)`, `${Math.round(perSecond)} changes/s, ack ${summary(latencies)}`);
  close(writers);
}

for (const window of [10, 50]) {
  const rooms = await Promise.all(Array.from({ length: 16 }, () => prepare(A)));
  const writers = await Promise.all(rooms.map((room, i) => ready(i % 2 && !site ? B : A, { room })));
  const { perSecond, latencies } = await saturate(writers, window, SECONDS);

  report(`16 rooms, 1 writer each (${window} in flight each)`, `${Math.round(perSecond)} changes/s, ack ${summary(latencies)}`);
  close(writers);
}

// 6. Joining: a snapshot of a full board, and a replay of 500 events.
{
  const room = roomId("join");
  const seeder = await ready(A, { room });

  for (let i = 0; i < 150; i++) {
    seeder.send(op("add", `n${i}`, { text: "x".repeat(200) }));
  }
  for (let i = 0; i < 350; i++) {
    seeder.send(op("move", `n${i % 150}`, { x: i }));
  }
  await until(() => seeder.of("ack").length === 500, 60_000, "500 acks");
  close(seeder);

  const timeJoin = async (params) => {
    const latencies = [];

    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const client = await ready(A, { room, ...params });

      latencies.push(performance.now() - start);
      client.close();
    }

    return latencies;
  };

  report("Join with a snapshot (150 notes, ~40 KB)", summary(await timeJoin({})));
  report("Join with a replay of 500 events", summary(await timeJoin({ since: "0" })));
}

await Promise.all(instances.map((instance) => stopInstance(instance)));
console.log("\nDone.");
process.exit(0);
