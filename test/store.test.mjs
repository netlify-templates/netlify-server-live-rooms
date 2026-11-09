// The commit (netlify/server/live/store.mjs), straight against the local
// database. These are the guarantees everything else builds on. Needs
// `npm run db:local`.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { applyOp, EMPTY_BOARD } from "../public/board.js";
import * as store from "../netlify/server/live/store.mjs";
import { roomId } from "./helpers.mjs";

const skip = !process.env.NETLIFY_DB_URL && "needs NETLIFY_DB_URL (npm run db:local)";
const add = (id) => ({ kind: "add", id, x: 1, y: 1, text: id, color: "#ffd166" });
const item = (op, id = crypto.randomUUID()) => ({ id, op, author: "test" });
const commitAll = (room, items) => store.commit(room, items, applyOp, "test");
const commit = async (room, op, id) => (await commitAll(room, [item(op, id)])).results[0];
const newRoom = async (prefix) => {
  const room = roomId(prefix);

  await store.openRoom(room, EMPTY_BOARD);

  return room;
};
const version = async (room) => (await store.openRoom(room, EMPTY_BOARD)).version;

after(() => !skip && store.database().pool.end());

test("versions start at 1 and go up by one", { skip }, async () => {
  const room = await newRoom("seq");

  for (let i = 1; i <= 5; i++) {
    assert.deepEqual(await commit(room, add(`n${i}`)), { seq: i });
  }
  assert.equal(await version(room), 5);
});

test("a batch is applied in order, each change seeing the ones before it", { skip }, async () => {
  const room = await newRoom("batch");
  const duplicate = crypto.randomUUID();
  const { results, from, events } = await commitAll(room, [
    item(add("a")),
    item({ kind: "move", id: "a", x: 5, y: 5 }),
    item({ kind: "move", id: "missing", x: 1, y: 1 }),
    item(add("b"), duplicate),
    item(add("b"), duplicate),
    item({ kind: "delete", id: "a" }),
  ]);

  assert.equal(from, 0);
  assert.deepEqual(results, [{ seq: 1 }, { seq: 2 }, { rejected: "That note was deleted." }, { seq: 3 }, { seq: 3, duplicate: true }, { seq: 4 }]);
  assert.deepEqual(
    events.map((event) => [event.seq, event.op.kind]),
    [
      [1, "add"],
      [2, "move"],
      [3, "add"],
      [4, "delete"],
    ],
  );
  assert.deepEqual((await store.openRoom(room, EMPTY_BOARD)).state, { notes: { b: { x: 1, y: 1, text: "b", color: "#ffd166" } } });
});

test("concurrent commits to one room get versions 1 to N with no gaps, and the log replays to the state", { skip }, async () => {
  const room = await newRoom("concurrent");
  // Like several instances writing to the same room at once: each commit
  // that loses the race reads again and retries.
  const outcomes = await Promise.all(Array.from({ length: 30 }, (_, i) => commitAll(room, [item(add(`n${i}a`)), item(add(`n${i}b`))])));
  const seqs = outcomes.flatMap((outcome) => outcome.results.map((result) => result.seq)).sort((a, b) => a - b);

  assert.deepEqual(
    seqs,
    Array.from({ length: 60 }, (_, i) => i + 1),
  );

  const events = await store.readEvents(room, { after: 0, limit: 100 });
  const replayed = events.reduce((state, event) => applyOp(state, event.op), EMPTY_BOARD);

  assert.deepEqual(replayed, (await store.openRoom(room, EMPTY_BOARD)).state);
});

test("the same change sent many times at once is committed once", { skip }, async () => {
  const room = await newRoom("dupe");
  const id = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 10 }, () => commit(room, add("a"), id)));

  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  assert.ok(results.every((result) => result.seq === 1));
  assert.equal(await version(room), 1);
});

test("a change apply() throws on is rejected, and nothing is written", { skip }, async () => {
  const room = await newRoom("reject");

  await commit(room, add("a"));
  assert.deepEqual(await commit(room, add("a")), { rejected: "That note already exists." });

  const outcome = await commitAll(room, [item({ kind: "move", id: "nope", x: 1, y: 1 })]);

  assert.deepEqual(outcome, { results: [{ rejected: "That note was deleted." }], from: 1, events: [] });
  assert.equal(await version(room), 1);
  assert.equal((await store.readEvents(room, { after: 0, limit: 10 })).length, 1);
});

test("a duplicate of a committed change isn't applied again, even when it would apply", { skip }, async () => {
  const room = await newRoom("mixed");
  const id = crypto.randomUUID();

  assert.deepEqual(await commit(room, add("a"), id), { seq: 1 });
  await commit(room, { kind: "delete", id: "a" });
  assert.deepEqual(await commit(room, add("a"), id), { seq: 1, duplicate: true });
  assert.deepEqual((await store.openRoom(room, EMPTY_BOARD)).state, EMPTY_BOARD);
});

test("a rejected change stays rejected when it's sent again, even once it would apply", { skip }, async () => {
  const room = await newRoom("rejected-again");
  const id = crypto.randomUUID();
  const move = { kind: "move", id: "a", x: 5, y: 5 };

  assert.deepEqual(await commit(room, move, id), { rejected: "That note was deleted." });
  await commit(room, add("a"));
  assert.deepEqual(await commit(room, move, id), { rejected: "That note was deleted.", duplicate: true });
  assert.equal(await version(room), 1);

  // The same within one batch: the first answer is the answer.
  const again = crypto.randomUUID();
  const { results } = await commitAll(room, [item({ kind: "move", id: "b", x: 1, y: 1 }, again), item(add("b")), item({ kind: "move", id: "b", x: 1, y: 1 }, again)]);

  assert.deepEqual(results, [{ rejected: "That note was deleted." }, { seq: 2 }, { rejected: "That note was deleted.", duplicate: true }]);
});

test("writers racing on one change agree on its answer, whether it was rejected or committed", { skip }, async () => {
  // Like two instances that each got the change (a client resending after a
  // reconnect), where one rejects it and the other would commit it.
  const rejecting = () => {
    throw new Error("No.");
  };
  const accepting = (state) => state;

  for (let i = 0; i < 20; i++) {
    const room = await newRoom("decide");
    const id = crypto.randomUUID();
    const [first, second] = await Promise.all([store.commit(room, [item({}, id)], rejecting, "a"), store.commit(room, [item({}, id)], accepting, "b")]);

    assert.equal(first.results[0].seq, second.results[0].seq);
    assert.equal(first.results[0].rejected, second.results[0].rejected);
  }
});

test("a state the database can't store fails with a Postgres data error (class 22)", { skip }, async () => {
  const room = await newRoom("class-22");
  const poisoned = () => ({ notes: {}, label: "half an emoji \ud83d" });

  await assert.rejects(store.commit(room, [item(add("a"))], poisoned, "test"), (error) => error.code?.startsWith("22"));
  assert.equal(await version(room), 0);
});

test("anything other than apply() throwing is an error the caller can retry", { skip }, async () => {
  await assert.rejects(commit(roomId("missing"), add("a")), /doesn't exist/);
  await assert.rejects(commit(await newRoom("bad-id"), add("a"), "not-a-uuid"));
});

test("the same change id in two rooms is two changes, committed at once without an error", { skip }, async () => {
  const [one, two] = await Promise.all([newRoom("id-a"), newRoom("id-b")]);
  const id = crypto.randomUUID();
  const [inOne, inTwo] = await Promise.all([commit(one, add("a"), id), commit(two, { kind: "move", id: "a", x: 1, y: 1 }, id)]);

  assert.deepEqual(inOne, { seq: 1 });
  assert.deepEqual(inTwo, { rejected: "That note was deleted." });
  assert.deepEqual(await commit(two, add("a"), id), { rejected: "That note was deleted.", duplicate: true });
});

test("openRoom creates a room once, and doesn't reset it", { skip }, async () => {
  const room = roomId("open");

  assert.deepEqual(await store.openRoom(room, EMPTY_BOARD), { version: 0, state: EMPTY_BOARD });
  await commit(room, add("a"));
  assert.equal((await store.openRoom(room, EMPTY_BOARD)).version, 1);

  const race = roomId("race");
  const [first, second] = await Promise.all([store.openRoom(race, EMPTY_BOARD), store.openRoom(race, EMPTY_BOARD)]);

  assert.equal(first.version, 0);
  assert.equal(second.version, 0);
});

test("readEvents respects after and limit", { skip }, async () => {
  const room = await newRoom("read");

  await commitAll(
    room,
    Array.from({ length: 10 }, (_, i) => item(add(`n${i}`))),
  );

  const seqs = async (options) => (await store.readEvents(room, options)).map((event) => event.seq);

  assert.deepEqual(await seqs({ after: 7, limit: 100 }), [8, 9, 10]);
  assert.deepEqual(await seqs({ after: 0, limit: 3 }), [1, 2, 3]);
});

test("opening a room without create doesn't create it", { skip }, async () => {
  const room = roomId("nocreate");

  assert.deepEqual(await store.openRoom(room, EMPTY_BOARD, { create: false }), { version: 0, state: EMPTY_BOARD });
  assert.equal((await store.readVersions([room])).size, 0);
});

test("a lease has one holder until it's released or expires", { skip }, async () => {
  const name = roomId("lease");

  assert.equal(await store.takeLease(name, "a", 1), true);
  assert.equal(await store.takeLease(name, "b", 1), false);
  assert.equal(await store.takeLease(name, "a", 1), true, "the holder renews it");
  await store.releaseLease(name, "b");
  assert.equal(await store.takeLease(name, "b", 1), false, "only the holder releases it");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(await store.takeLease(name, "b", 1), true, "an expired lease is free");
  await store.releaseLease(name, "b");
  assert.equal(await store.takeLease(name, "a", 1), true);
});

test("compacting keeps each room's last 1,000 events and anything from the last day, and every id", { skip }, async () => {
  const room = await newRoom("compact");
  const first = crypto.randomUUID();

  await commit(room, add("a"), first);
  await commitAll(room, Array.from({ length: 1_004 }, (_, i) => item({ kind: "move", id: "a", x: i, y: 1 })));
  await store.compactEvents();

  const ops = async () => (await store.readEvents(room, { after: 0, limit: 2_000 })).map((event) => event.op);

  assert.equal((await ops()).filter((op) => op === null).length, 0, "recent events stay whole");

  await store.database().pool.query("update room_events set created_at = now() - interval '2 days' where room_id = $1", [room]);
  await store.compactEvents();
  assert.deepEqual(
    (await ops()).map((op) => op === null),
    Array.from({ length: 1_005 }, (_, i) => i < 5),
  );
  assert.deepEqual(await commit(room, add("a"), first), { seq: 1, duplicate: true }, "a late resend still gets its answer");
});
