// The relay's write path (netlify/server/live/relay.mjs) in this process,
// against the local database, with stand-in connections and an app whose
// apply() can be told to misbehave. Needs `npm run db:local`.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createRelay } from "../netlify/server/live/relay.mjs";
import * as store from "../netlify/server/live/store.mjs";
import { roomId, until } from "./helpers.mjs";

const skip = !process.env.NETLIFY_DB_URL && "needs NETLIFY_DB_URL (npm run db:local)";

// A counter app. `{ add: n }` adds n. `{ poison: true }` returns a state the
// database can't store, the way a buggy apply() might, so the commit fails.
const apply = (state, op) => {
  if (op.poison) {
    return { ...state, label: "half an emoji \ud83d" };
  }
  if (typeof op.add !== "number") {
    throw new Error("Not a number.");
  }

  return { ...state, count: state.count + op.add };
};

const relay = createRelay({ apply, initialState: { count: 0 }, instance: "relay-test" });

after(() => !skip && store.database().pool.end());

const connection = async (room) => {
  const conn = {
    room,
    client: crypto.randomUUID(),
    author: "test",
    sent: 0,
    closed: false,
    messages: [],
    closedWith: null,
    send: (message) => conn.messages.push(message),
    socket: { close: (code) => (conn.closedWith = code) },
  };

  conn.joined = relay.join(conn, null);
  await conn.joined;

  return conn;
};

const answers = (conn) => conn.messages.filter((message) => message.type === "ack" || message.type === "reject");

test("in a batch, rejections go to their connection only, and stay rejected when resent", { skip }, async () => {
  const room = roomId("mixed");
  const [alice, bob] = await Promise.all([connection(room), connection(room)]);
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID());

  relay.write(alice, { id: ids[0], op: { add: 1 } });
  relay.write(bob, { id: ids[1], op: { add: 10 } });
  relay.write(alice, { id: ids[2], op: { add: "x" } });
  relay.write(bob, { id: ids[3], op: { add: 100 } });
  await until(() => answers(alice).length === 2 && answers(bob).length === 2, 5_000, "every change to be answered");

  const byId = new Map([...answers(alice), ...answers(bob)].map((message) => [message.id, message]));

  assert.equal(byId.get(ids[0]).type, "ack");
  assert.equal(byId.get(ids[1]).type, "ack");
  assert.deepEqual(byId.get(ids[2]), { type: "reject", id: ids[2], reason: "Not a number." });
  assert.equal(byId.get(ids[3]).type, "ack");
  assert.deepEqual(await store.openRoom(room, { count: 0 }), { version: 3, state: { count: 111 } });

  // Resent, even as a change that would apply, it gets the same answer.
  relay.write(alice, { id: ids[2], op: { add: 1 } });
  await until(() => answers(alice).length === 3, 5_000, "the resent change to be answered");
  assert.equal(answers(alice)[2].reason, "Not a number.");
  assert.equal((await store.openRoom(room, { count: 0 })).version, 3);

  // Both connections got all three events, in order.
  for (const conn of [alice, bob]) {
    await until(() => conn.messages.filter((message) => message.type === "event").length === 3, 2_000, "the events");
    assert.deepEqual(
      conn.messages.filter((message) => message.type === "event").map((event) => event.seq),
      [1, 2, 3],
    );
  }
});

test("a batch that fails for a reason other than apply() is not written, and its connections are closed to resend", { skip }, async () => {
  const room = roomId("poison");
  const conn = await connection(room);

  relay.write(conn, { id: crypto.randomUUID(), op: { poison: true } });
  await until(() => conn.closedWith !== null, 5_000, "the connection to close");
  assert.equal(conn.closedWith, 1011);
  assert.equal(answers(conn).length, 0);
  assert.equal((await store.openRoom(room, { count: 0 })).version, 0);
});

test("an apply() that throws something without a message still rejects, with a reason", { skip }, async () => {
  const room = roomId("silent");
  const throwing = createRelay({
    apply: () => {
      throw "";
    },
    initialState: { count: 0 },
    instance: "relay-test",
  });
  const conn = { room, client: crypto.randomUUID(), author: "t", sent: 0, closed: false, messages: [], send: (m) => conn.messages.push(m), socket: { close() {} } };

  conn.joined = throwing.join(conn, null);
  await conn.joined;
  throwing.write(conn, { id: crypto.randomUUID(), op: {} });
  await until(() => answers(conn).length === 1, 5_000, "the answer");
  assert.deepEqual(answers(conn)[0].type, "reject");
  assert.equal(answers(conn)[0].reason, "Rejected");
});

test("a connection's changes are committed in the order it sent them, even in one batch", { skip }, async () => {
  const room = roomId("order");
  const conn = await connection(room);
  const ids = Array.from({ length: 50 }, () => crypto.randomUUID());

  ids.forEach((id, i) => relay.write(conn, { id, op: { add: i } }));
  await until(() => answers(conn).length === 50, 5_000, "50 answers");
  assert.deepEqual(
    answers(conn).map((answer) => answer.seq),
    Array.from({ length: 50 }, (_, i) => i + 1),
  );
});
