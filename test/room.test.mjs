// LiveRoom (public/live/room.js) against a fake WebSocket, so each rule of the
// client can be checked on its own, including the timing of reconnects.
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import { applyOp, EMPTY_BOARD } from "../public/board.js";
import { LiveRoom } from "../public/live/room.js";

class FakeSocket {
  static OPEN = 1;
  static all = [];

  constructor(url) {
    this.url = new URL(url);
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
    FakeSocket.all.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  // Called by LiveRoom. Like a real socket, the close event comes later.
  close(code = 1005) {
    if (this.readyState !== 3) {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code }));
    }
  }

  // The server's side: the server closes the connection.
  serverClose(code) {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  deliver(...messages) {
    messages.forEach((message) => this.onmessage({ data: JSON.stringify(message) }));
  }

  ops() {
    return this.sent.filter((message) => message.type === "op");
  }
}

globalThis.WebSocket = FakeSocket;

const latest = () => FakeSocket.all.at(-1);
const add = (id) => ({ kind: "add", id, x: 1, y: 1, text: id, color: "#ffd166" });
const event = (seq, id, op) => ({ type: "event", seq, id, author: "x", instance: "i1", op });

// A room that's connected and caught up at version 0.
const joined = (options = {}) => {
  const room = new LiveRoom({ url: "ws://test/api/live", room: "r", author: "ana", apply: applyOp, ...options });

  room.open();
  latest().deliver({ type: "hello", instance: "i1", deploy: "d1" }, { type: "snapshot", version: 0, state: EMPTY_BOARD }, { type: "ready", version: 0 });

  return room;
};

beforeEach(() => {
  FakeSocket.all = [];
  mock.timers.reset();
});

test("connects without `since` the first time, and goes live after the snapshot", () => {
  const statuses = [];
  const room = new LiveRoom({ url: "ws://test/api/live", room: "r", author: "ana", apply: applyOp });

  room.on("status", ({ status }) => statuses.push(status));
  room.open();
  assert.equal(latest().url.searchParams.has("since"), false);
  assert.equal(room.view(), null);

  latest().deliver({ type: "snapshot", version: 7, state: { notes: { a: { x: 1, y: 1, text: "a", color: "#ffd166" } } } }, { type: "ready", version: 7 });
  assert.deepEqual(statuses, ["connecting", "live"]);
  assert.equal(room.confirmed.version, 7);
  assert.deepEqual(Object.keys(room.view().notes), ["a"]);
});

test("a change shows right away and stays pending until its event arrives", () => {
  const room = joined();
  const id = room.change(add("a"));

  assert.deepEqual(latest().ops(), [{ type: "op", id, op: add("a") }]);
  assert.ok(room.view().notes.a);
  assert.equal(room.confirmed.state.notes.a, undefined);

  // The ack usually comes before the event: the change must stay visible.
  latest().deliver({ type: "ack", id, seq: 1 });
  assert.equal(room.pending.length, 1);
  assert.ok(room.view().notes.a);

  latest().deliver(event(1, id, add("a")));
  assert.equal(room.pending.length, 0);
  assert.equal(room.confirmed.version, 1);
  assert.ok(room.confirmed.state.notes.a);
});

test("an ack for a change it already has the event for clears it", () => {
  const room = joined();

  latest().deliver(event(1, "other", add("x")), event(2, "other2", add("y")));

  const id = room.change(add("a"));

  // A resent change the server had committed before, at version 2.
  latest().deliver({ type: "ack", id, seq: 2, duplicate: true });
  assert.equal(room.pending.length, 0);
});

test("a rejected change is dropped, and the reason comes with it", () => {
  const room = joined();
  const rejects = [];

  room.on("reject", (reject) => rejects.push(reject));

  const id = room.change({ kind: "move", id: "gone", x: 1, y: 1 });

  latest().deliver({ type: "reject", id, reason: "That note was deleted." });
  assert.equal(room.pending.length, 0);
  assert.deepEqual(rejects, [{ type: "reject", id, reason: "That note was deleted.", op: { kind: "move", id: "gone", x: 1, y: 1 } }]);
});

test("changes made while connecting are sent in order once it's ready", () => {
  const room = new LiveRoom({ url: "ws://test/api/live", room: "r", author: "ana", apply: applyOp });

  room.open();

  const ids = [room.change(add("a")), room.change({ kind: "move", id: "a", x: 5, y: 5 })];

  assert.equal(latest().ops().length, 0);
  latest().deliver({ type: "snapshot", version: 0, state: EMPTY_BOARD }, { type: "ready", version: 0 });
  assert.deepEqual(
    latest()
      .ops()
      .map((op) => op.id),
    ids,
  );
});

test("a change made when the room goes live is sent after the outbox", () => {
  const room = new LiveRoom({ url: "ws://test/api/live", room: "r", author: "ana", apply: applyOp });
  const ids = [];

  room.on("status", ({ status }) => {
    if (status === "live" && ids.length === 1) {
      ids.push(room.change({ kind: "move", id: "a", x: 5, y: 5 }));
    }
  });
  room.open();
  ids.push(room.change(add("a")));
  latest().deliver({ type: "snapshot", version: 0, state: EMPTY_BOARD }, { type: "ready", version: 0 });
  assert.deepEqual(
    latest()
      .ops()
      .map((op) => op.id),
    ids,
  );
});

test("reconnects with `since`, then resends the outbox and its presence", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  const room = joined();

  latest().deliver(event(1, "x1", add("x")));
  room.setPresence({ name: "ana" });

  const id = room.change(add("a"));
  const first = latest();

  first.serverClose(1012);
  room.change(add("b"));
  mock.timers.tick(1_000);

  const second = latest();

  assert.notEqual(second, first);
  assert.equal(second.url.searchParams.get("since"), "1");
  second.deliver({ type: "ready", version: 1 });
  assert.deepEqual(
    second.ops().map((op) => op.op.id),
    ["a", "b"],
  );
  assert.equal(second.ops()[0].id, id);
  assert.deepEqual(second.sent.at(-1), { type: "presence", data: { name: "ana" } });
});

test("comes back within a second after 1012, and backs off after anything else", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  const room = joined();

  latest().serverClose(1012);
  mock.timers.tick(999);
  assert.equal(FakeSocket.all.length, 2);

  // Without `ready`, failures keep counting. The 1012 above was the first,
  // so the waits go 2 s, 4 s, 8 s, then 10 s at most, each with jitter
  // between half and one and a half times that.
  const waits = [];

  for (let attempt = 0; attempt < 6; attempt++) {
    const before = FakeSocket.all.length;

    latest().serverClose(1006);

    let waited = 0;

    while (FakeSocket.all.length === before) {
      mock.timers.tick(10);
      waited += 10;
    }
    waits.push(waited);
  }

  const bases = [2_000, 4_000, 8_000, 10_000, 10_000, 10_000];

  waits.forEach((waited, index) => assert.ok(waited >= bases[index] * 0.5 && waited <= bases[index] * 1.5 + 10, `attempt ${index}: waited ${waited} ms`));
  assert.equal(room.status, "reconnecting");
});

test("ignores events it already has", () => {
  const room = joined();

  latest().deliver(event(1, "x1", add("x")), event(1, "x1", add("x")));
  assert.equal(room.confirmed.version, 1);
});

test("a gap in versions makes it start over from a snapshot", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  const room = joined();
  const resyncs = [];

  room.on("resync", (reason) => resyncs.push(reason));
  latest().deliver(event(1, "x1", add("x")), event(3, "x3", add("z")));
  assert.equal(resyncs.length, 1);
  assert.equal(latest().readyState, 3);
  mock.timers.tick(10_000);
  assert.equal(latest().url.searchParams.has("since"), false);
});

test("offline keeps the outbox, and back online sends it", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  const room = joined();

  room.setOffline(true);
  room.change(add("a"));
  mock.timers.tick(60_000);
  assert.equal(FakeSocket.all.length, 1);
  assert.equal(room.status, "offline");

  room.setOffline(false);
  assert.equal(FakeSocket.all.length, 2);
  latest().deliver({ type: "ready", version: 0 });
  assert.deepEqual(
    latest()
      .ops()
      .map((op) => op.op.id),
    ["a"],
  );
});

test("view() skips pending changes that no longer apply", () => {
  const room = joined();

  room.change(add("a"));
  room.change({ kind: "edit", id: "b", text: "never existed" });
  assert.deepEqual(Object.keys(room.view().notes), ["a"]);
});

test("presence leaves out this client, and clears on disconnect", () => {
  const room = joined();
  const seen = [];

  room.on("presence", (peers) => seen.push(peers.map((peer) => peer.client)));
  latest().deliver({
    type: "presence",
    peers: [
      { client: room.client, instance: "i1", data: {} },
      { client: "other", instance: "i2", data: {} },
    ],
  });
  room.close();
  assert.deepEqual(seen, [["other"], []]);
});

test("a late close from a socket it moved on from changes nothing", async () => {
  const room = joined();
  const first = latest();

  // Offline and straight back online: the first socket's close event only
  // arrives after the second socket exists.
  room.setOffline(true);
  room.setOffline(false);

  const second = latest();

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(FakeSocket.all.length, 2, "no extra reconnect");
  second.deliver({ type: "snapshot", version: 0, state: EMPTY_BOARD }, { type: "ready", version: 0 });
  assert.equal(room.status, "live");

  // Anything the old socket still delivers is ignored.
  first.onmessage?.({ data: JSON.stringify({ type: "event", seq: 1, id: "x", author: "x", instance: "i1", op: add("x") }) });
  assert.equal(room.confirmed.version, 0);
});

test("pings every 10 s, and gives up on a connection that's been silent for 20 s", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });

  const room = joined();
  const socket = latest();

  mock.timers.tick(10_000);
  assert.equal(socket.sent.filter((message) => message.type === "ping").length, 1);

  // Any message counts as hearing from the server.
  socket.deliver({ type: "pong", t: 0 });
  mock.timers.tick(15_000);
  assert.equal(socket.readyState, 1);

  mock.timers.tick(10_000);
  assert.equal(socket.readyState, 3, "closed after 20 s of silence");
  assert.equal(room.status, "reconnecting");
  mock.timers.tick(2_000);
  assert.equal(FakeSocket.all.length, 2);
});

test("the backoff grows while connections fail, and starts over once one is ready", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });

  const room = joined();
  const waitAfterClose = () => {
    const before = FakeSocket.all.length;
    let waited = 0;

    latest().serverClose(1006);
    while (FakeSocket.all.length === before) {
      mock.timers.tick(10);
      waited += 10;
    }

    return waited;
  };
  const ready = () => latest().deliver({ type: "ready", version: 0 });

  assert.ok(waitAfterClose() <= 1_510);
  assert.ok(waitAfterClose() >= 1_000);
  assert.ok(waitAfterClose() >= 2_000);

  ready();
  assert.ok(waitAfterClose() <= 1_510);
  assert.equal(room.attempts, 1);
});

test("reports an event it already had as a duplicate, and the server's details as they change", () => {
  const room = joined();
  const duplicates = [];
  const servers = [];

  room.on("duplicate", (event) => duplicates.push(event.seq)).on("server", (server) => servers.push(server.instance));
  latest().deliver(event(1, "x1", add("x")), event(1, "x1", add("x")), { type: "hello", instance: "i2", deploy: "d2" });
  assert.deepEqual(duplicates, [1]);
  assert.deepEqual(servers, ["i2"]);
  assert.equal(room.server.deploy, "d2");
});
