// What the tests share: a board client built on the browser's own LiveRoom,
// which records what happened to it so a test can check the guarantees
// afterwards, and makes random changes to the board.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { applyOp, EMPTY_BOARD } from "../../public/board.js";
import { LiveRoom } from "../../public/live/room.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// jsonb doesn't keep key order, so compare with sorted keys.
export const canonical = (value) =>
  value && typeof value === "object"
    ? `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(",")}}`
    : JSON.stringify(value);

export const waitFor = async (condition, ms, label) => {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await sleep(50);
  }
  console.log(`  (timed out waiting for ${label})`);

  return false;
};

// A database connection for reading the results. The tests restart the
// database, so it retries, and an error on it is logged rather than crashing
// the test before it can report.
export const openDatabase = async () => {
  for (let attempt = 1; ; attempt++) {
    const db = new pg.Client({ connectionString: process.env.NETLIFY_DB_URL });

    db.on("error", (error) => console.log(`  (results connection: ${error.message})`));
    try {
      await db.connect();

      return db;
    } catch (error) {
      if (attempt === 10) {
        throw error;
      }
      await sleep(1_000);
    }
  }
};

// Starts the local harness (scripts/local.mjs) on `port`, and makes sure it
// stops however this process exits. Resolves with { log, stop }.
export const startHarness = async (port, env = {}) => {
  const harness = spawn(process.execPath, [fileURLToPath(new URL("../local.mjs", import.meta.url))], {
    env: { ...process.env, PORT: String(port), GRACE_MS: "3000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { log: "", stop: () => harness.kill("SIGINT") };

  harness.stdout.on("data", (chunk) => (state.log += chunk));
  harness.stderr.on("data", (chunk) => (state.log += chunk));
  process.on("exit", () => harness.kill("SIGINT"));

  if (!(await waitFor(() => state.log.includes("Live board on"), 15_000, "the harness"))) {
    console.log(state.log);
    process.exit(1);
  }

  return state;
};

export const checker = () => {
  const failures = [];
  const check = (ok, message) => {
    console.log(`${ok ? "  ok  " : "  FAIL"} ${message}`);
    if (!ok) {
      failures.push(message);
    }
  };

  return { check, failures };
};

export class TestClient {
  constructor(name, { url, room }) {
    this.name = name;
    this.room = new LiveRoom({ url, room, author: name, apply: applyOp });
    this.sent = new Set();
    this.rejected = new Set();
    this.seen = [];
    this.instances = [];
    this.eventsFrom = new Set();
    this.droppedAt = 0;
    this.problems = [];

    let last = null;

    this.room
      .on("server", (server) => this.instances.at(-1) !== server.instance && this.instances.push(server.instance))
      .on("duplicate", (event) => this.problems.push(`got version ${event.seq} again`))
      .on("snapshot", ({ version }) => (last = version))
      .on("event", (event) => {
        if (event.seq !== last + 1) {
          this.problems.push(`went from version ${last} to ${event.seq}`);
        }
        last = event.seq;
        this.seen.push(event.id);
        this.eventsFrom.add(event.instance);
      })
      .on("reject", ({ id }) => this.rejected.add(id))
      .on("status", ({ status }) => status === "reconnecting" && (this.droppedAt = Date.now()))
      .on("resync", (reason) => this.problems.push(`resynced: ${reason}`));
    this.room.open();
  }

  get instance() {
    return this.room.server.instance;
  }

  get deploy() {
    return this.room.server.deploy;
  }

  get ready() {
    return this.room.ready;
  }

  get version() {
    return this.room.confirmed.version;
  }

  // Adds, moves, edits and deletes, some of them on notes another client may
  // have just deleted, so rejections get exercised too.
  act() {
    const view = this.room.view() ?? EMPTY_BOARD;
    const ids = Object.keys(view.notes);
    const id = ids[Math.floor(Math.random() * ids.length)];
    const roll = Math.random();
    let op;

    if (!id || (roll < 0.3 && ids.length < 150)) {
      op = { kind: "add", id: crypto.randomUUID().slice(0, 8), x: Math.random() * 2000, y: Math.random() * 1400, text: this.name, color: "#ffd166" };
    } else if (roll < 0.7) {
      op = { kind: "move", id, x: Math.random() * 2000, y: Math.random() * 1400 };
    } else if (roll < 0.9) {
      op = { kind: "edit", id, text: `${this.name} ${Date.now()}` };
    } else {
      op = { kind: "delete", id };
    }

    this.sent.add(this.room.change(op));
  }

  // Writes until `isWriting()` turns false, once every `every` ms on average.
  async write(isWriting, every = 50) {
    while (isWriting()) {
      this.act();
      await sleep(every * (0.6 + Math.random() * 0.8));
    }
  }
}

// Checks the guarantees once everyone has stopped writing. `truth` is the
// room's final state and the ids of every committed change, in order, from
// the database or from a client that saw every event.
export const checkResults = (check, clients, truth) => {
  check(
    clients.every((client) => client.room.pending.length === 0),
    `every outbox emptied (${clients.map((client) => client.room.pending.length).join(", ")})`,
  );

  for (const client of clients) {
    check(
      client.version === truth.version && canonical(client.room.confirmed.state) === canonical(truth.state),
      `${client.name}'s state matches at version ${truth.version} (has ${client.version})`,
    );
  }

  const committed = new Map();

  for (const id of truth.ids) {
    committed.set(id, (committed.get(id) ?? 0) + 1);
  }

  for (const client of clients) {
    const lost = [...client.sent].filter((id) => !committed.has(id) && !client.rejected.has(id));
    const twice = [...client.sent].filter((id) => committed.get(id) > 1);
    const both = [...client.rejected].filter((id) => committed.has(id));

    check(
      lost.length + twice.length + both.length === 0,
      `${client.name}: ${client.sent.size} changes, ${client.sent.size - client.rejected.size} committed once, ${client.rejected.size} rejected, ${lost.length} lost, ${twice.length} twice`,
    );
  }

  // `sent` is a Set, so it keeps the order the client made its changes in.
  for (const client of clients) {
    const made = [...client.sent].filter((id) => committed.has(id));
    const logged = truth.ids.filter((id) => client.sent.has(id));

    check(made.join() === logged.join(), `${client.name}'s changes were committed in the order it made them`);
  }

  for (const client of clients) {
    check(
      client.problems.length === 0,
      `${client.name} applied each version once, in order, across ${client.instances.join(" -> ")}${client.problems.length ? `: ${client.problems.join("; ")}` : ""}`,
    );
  }
};
