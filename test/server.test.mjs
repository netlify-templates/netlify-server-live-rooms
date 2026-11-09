// The server over real WebSockets: two instances (separate processes) against
// the local database, with clients speaking the protocol directly so each
// test controls exactly what's sent and when. Needs `npm run db:local`.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";

import pg from "pg";

import { applyOp, EMPTY_BOARD } from "../public/board.js";
import { cleanup, connect, op, roomId, sleep, startInstance, stopInstance, until } from "./helpers.mjs";

const skip = !process.env.NETLIFY_DB_URL && "needs NETLIFY_DB_URL (npm run db:local)";

after(cleanup);

// A room's version straight from the database, or undefined if it doesn't exist.
const roomVersion = async (room) => {
  const client = new pg.Client({ connectionString: process.env.NETLIFY_DB_URL });

  await client.connect();
  try {
    const { rows } = await client.query("select version from rooms where id = $1", [room]);

    return rows[0] && Number(rows[0].version);
  } finally {
    await client.end();
  }
};

// Writes `count` notes to a room through one connection, and waits for the acks.
const seed = async (url, room, count) => {
  const client = await connect(url, { room });

  await client.next((message) => message.type === "ready");
  for (let i = 0; i < count; i++) {
    client.send(op("add", `n${i}`));
  }
  await until(() => client.of("ack").length === count, 10_000, `${count} acks`);
  client.close();
};

const upgrade = (port, query) =>
  new Promise((resolve) => {
    const request = http.request({ port, path: `/api/live?${query}`, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });

    request.on("response", (response) => resolve(response.statusCode));
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.end();
  });

for (const notify of [true, false]) {
  describe(notify ? "with NOTIFY" : "with polling only (NOTIFY=off)", { skip }, () => {
    let a;
    let b;

    before(async () => {
      [a, b] = await Promise.all([startInstance({ NOTIFY: notify ? "on" : "off" }), startInstance({ NOTIFY: notify ? "on" : "off" })]);
      // Until LISTEN is set up, an instance only polls. Wait for it, so this
      // suite really tests NOTIFY.
      for (const instance of [a, b]) {
        await until(async () => (await (await fetch(`http://localhost:${instance.port}/api/info`)).json()).notify === notify, 10_000, "LISTEN");
      }
    });

    after(async () => {
      await Promise.all([stopInstance(a), stopInstance(b)]);
    });

    test("a write on one instance reaches clients on the other", async () => {
      const room = roomId("cross");
      const writer = await connect(a.url, { room });
      const reader = await connect(b.url, { room });

      await Promise.all([writer.next((m) => m.type === "ready"), reader.next((m) => m.type === "ready")]);

      const took = [];

      for (let i = 1; i <= 5; i++) {
        const change = op("add", `n${i}`);
        const sentAt = Date.now();

        writer.send(change);

        const event = await reader.next((m) => m.type === "event" && m.id === change.id, 3_000);

        took.push(Date.now() - sentAt);
        assert.equal(event.seq, i);
        assert.equal(event.instance, writer.of("hello")[0].instance);
      }
      // With NOTIFY, each takes a few milliseconds. Polling, once a second,
      // takes up to a second, so it can't make all five that fast.
      assert.ok(Math.max(...took) < (notify ? 100 : 1_500), `took ${took.join(", ")} ms`);
      writer.close();
      reader.close();
    });

    test("every client in a room sees every event once, in order, from both instances", async () => {
      const room = roomId("order");
      const clients = await Promise.all([a, a, b, b].map((instance) => connect(instance.url, { room })));

      await Promise.all(clients.map((client) => client.next((m) => m.type === "ready")));
      for (let i = 0; i < 25; i++) {
        clients[i % 4].send(op("add", `n${i}`));
      }
      for (const client of clients) {
        await until(() => client.of("event").length >= 25, 10_000, "25 events");
        assert.deepEqual(
          client.of("event").map((event) => event.seq),
          Array.from({ length: 25 }, (_, i) => i + 1),
        );
      }
      clients.forEach((client) => client.close());
    });
  });
}

describe("joining", { skip }, () => {
  let a;

  before(async () => {
    a = await startInstance();
  });

  after(() => stopInstance(a));

  test("with `since`, a client gets exactly the events after it, then ready", async () => {
    const room = roomId("since");

    await seed(a.url, room, 10);

    const client = await connect(a.url, { room, since: "4" });
    const ready = await client.next((m) => m.type === "ready");

    assert.equal(ready.version, 10);
    assert.equal(client.of("snapshot").length, 0);
    assert.deepEqual(
      client.of("event").map((event) => event.seq),
      [5, 6, 7, 8, 9, 10],
    );
    assert.ok(client.messages.findIndex((m) => m.type === "ready") > client.messages.findLastIndex((m) => m.type === "event"));
    client.close();
  });

  test("without `since`, ahead of the room, or more than 500 behind, a client gets a snapshot", async () => {
    const room = roomId("snap");

    await seed(a.url, room, 3);

    for (const since of [undefined, "99", "-600"]) {
      const client = await connect(a.url, { room, ...(since && { since }) });

      await client.next((m) => m.type === "ready");
      assert.equal(client.of("snapshot")[0]?.version, 3, `since=${since}`);
      assert.equal(Object.keys(client.of("snapshot")[0].state.notes).length, 3);
      assert.equal(client.of("event").length, 0);
      client.close();
    }
  });

  test("bad parameters are refused before the upgrade", async () => {
    assert.equal(await upgrade(a.port, "room=ok&client=abc12345"), 101);
    assert.equal(await upgrade(a.port, "client=abc12345"), 400);
    assert.equal(await upgrade(a.port, "room=has%20space&client=abc12345"), 400);
    assert.equal(await upgrade(a.port, "room=ok&client=abc12345&since=1.5"), 400);
    assert.equal(await upgrade(a.port, `room=${"x".repeat(41)}&client=abc12345`), 400);
  });

  test("changes sent before ready wait for the join, in order", async () => {
    const room = roomId("early");
    const client = await connect(a.url, { room });
    const changes = [op("add", "a"), op("move", "a", { x: 9 }), op("edit", "a", { text: "z" })];

    changes.forEach((change) => client.send(change));
    await until(() => client.of("ack").length === 3, 5_000, "3 acks");
    assert.equal(client.of("reject").length, 0);
    assert.equal(client.closed, null);
    client.close();
  });

  test("one connection's changes are committed in the order it sent them", async () => {
    const room = roomId("pipeline");
    const client = await connect(a.url, { room });

    await client.next((m) => m.type === "ready");
    // Each move depends on the add right before it.
    for (let i = 0; i < 40; i++) {
      client.send(op("add", `n${i}`));
      client.send(op("move", `n${i}`, { x: i }));
    }
    await until(() => client.of("ack").length + client.of("reject").length === 80, 10_000, "80 answers");
    assert.equal(client.of("reject").length, 0);
    assert.deepEqual(
      client.of("ack").map((ack) => ack.seq),
      Array.from({ length: 80 }, (_, i) => i + 1),
    );
    client.close();
  });

  test("the same change from two connections at once is committed once", async () => {
    const room = roomId("twice");
    const [first, second] = await Promise.all([connect(a.url, { room }), connect(a.url, { room })]);

    await Promise.all([first.next((m) => m.type === "ready"), second.next((m) => m.type === "ready")]);

    const change = op("add", "a");

    first.send(change);
    second.send(change);

    const acks = await Promise.all([first.next((m) => m.type === "ack"), second.next((m) => m.type === "ack")]);

    assert.equal(acks[0].seq, 1);
    assert.equal(acks[1].seq, 1);
    first.send(op("add", "b"));
    await first.next((m) => m.type === "event" && m.seq === 2);
    assert.deepEqual(
      first.of("event").map((event) => event.op.id),
      ["a", "b"],
      "the change appears once in the log",
    );
    first.close();
    second.close();
  });

  test("a rejected change gets a reason, and doesn't use up a version", async () => {
    const room = roomId("rejected");
    const client = await connect(a.url, { room });

    await client.next((m) => m.type === "ready");

    const bad = op("move", "nope");

    client.send(bad);
    client.send(op("add", "a"));

    const reject = await client.next((m) => m.type === "reject");

    assert.deepEqual(reject, { type: "reject", id: bad.id, reason: "That note was deleted." });
    assert.equal((await client.next((m) => m.type === "ack")).seq, 1);
    client.close();
  });

  test("a client joining while the room's last client leaves still gets its changes committed", async () => {
    for (let i = 0; i < 30; i++) {
      const room = roomId("handover");
      const leaving = await connect(a.url, { room });

      await leaving.next((m) => m.type === "ready");

      const joining = connect(a.url, { room });

      leaving.close();

      const client = await joining;

      await client.next((m) => m.type === "ready");
      client.send(op("add", "a"));
      assert.equal((await client.next((m) => m.type === "ack", 2_000)).seq, 1, `round ${i}`);
      client.close();
    }
  });

  test("a change with a malformed id is rejected, and the connection stays up", async () => {
    const client = await connect(a.url, { room: roomId("bad-id") });

    await client.next((m) => m.type === "ready");
    for (const id of ["nope", "ABCDEF00-0000-0000-0000-000000000000", 42]) {
      client.send({ type: "op", id, op: { kind: "add", id: "a", x: 1, y: 1, text: "", color: "#ffd166" } });
      assert.match((await client.next((m) => m.type === "reject" && m.id === id)).reason, /UUID/);
    }
    client.send(op("add", "a"));
    assert.equal((await client.next((m) => m.type === "ack")).seq, 1);
    assert.equal(client.closed, null);
    client.close();
  });

  test("ping gets a pong, and unknown messages are left to the app", async () => {
    const client = await connect(a.url, { room: roomId("ping") });

    client.send({ type: "ping", t: 42 });
    assert.deepEqual(await client.next((m) => m.type === "pong"), { type: "pong", t: 42 });
    client.send({ type: "something-else" });
    client.send("not json at all");
    await sleep(200);
    assert.equal(client.closed, null);
    client.close();
  });
});

describe("hostile and odd input", { skip }, () => {
  let a;

  before(async () => {
    a = await startInstance();
  });

  after(() => stopInstance(a));

  const alive = () => assert.equal(a.child.exitCode, null, `the instance is still running:\n${a.log()}`);

  test("messages that aren't objects are ignored, and nothing crashes the instance", async () => {
    const client = await connect(a.url, { room: roomId("odd") });

    await client.next((m) => m.type === "ready");
    for (const data of ["null", "42", '"text"', "[]", "true", "{", "{}", '{"type":null}', '{"type":"op"}']) {
      client.socket.send(data);
    }
    client.send(op("add", "a"));
    assert.equal((await client.next((m) => m.type === "ack")).seq, 1);
    alive();
    client.close();
  });

  test("a change is applied as it's stored, so a number JSON can't hold means the same to everyone", async () => {
    const room = roomId("infinity");
    const writer = await connect(a.url, { room });
    const id = crypto.randomUUID();

    await writer.next((m) => m.type === "ready");
    // JSON.parse reads 1e400 as Infinity, and JSON.stringify writes that as null.
    writer.socket.send(`{"type":"op","id":"${id}","op":{"kind":"add","id":"far","x":1e400,"y":0,"text":"far","color":"#ffd166"}}`);

    const event = await writer.next((m) => m.type === "event");
    const late = await connect(a.url, { room });
    const { state } = await late.next((m) => m.type === "snapshot");

    assert.equal(event.op.x, null);
    assert.deepEqual(state, applyOp(EMPTY_BOARD, event.op));
    writer.close();
    late.close();
  });

  test("a message that throws while being handled closes that connection only", async () => {
    const room = roomId("deep");
    const bystander = await connect(a.url, { room });
    const attacker = await connect(a.url, { room });

    await Promise.all([bystander.next((m) => m.type === "ready"), attacker.next((m) => m.type === "ready")]);
    // Parses fine, but is too deep to serialize again.
    attacker.socket.send(`{"type":"presence","data":${"[".repeat(20_000)}${"]".repeat(20_000)}}`);
    await until(() => attacker.closed !== null, 3_000, "the attacker to be dropped");
    assert.ok([1003, 1009].includes(attacker.closed), `closed with ${attacker.closed}`);
    bystander.send(op("add", "a"));
    assert.equal((await bystander.next((m) => m.type === "ack")).seq, 1);
    alive();
    bystander.close();
  });

  test("a message over 64 KB closes the connection with 1009", async () => {
    const client = await connect(a.url, { room: roomId("big") });

    await client.next((m) => m.type === "ready");
    client.send({ ...op("add", "a"), padding: "x".repeat(70_000) });
    await until(() => client.closed !== null, 3_000, "the close");
    assert.equal(client.closed, 1009);
    alive();
  });

  test("text the database can't store is rejected up front, and the connection stays up", async () => {
    const client = await connect(a.url, { room: roomId("unstorable") });

    await client.next((m) => m.type === "ready");
    for (const text of ["nul \u0000 here", "half an emoji \ud83d", "\udc00 low half"]) {
      const change = op("add", `n${text.length}`, { text });

      client.send(change);
      assert.match((await client.next((m) => m.type === "reject" && m.id === change.id)).reason, /can't be stored/);
    }
    // Text that only looks like those escapes is fine.
    const literal = op("add", "literal", { text: "\\u0000 and 😀" });

    client.send(literal);
    assert.equal((await client.next((m) => m.type === "ack" && m.id === literal.id)).seq, 1);
    assert.equal(client.closed, null);
    alive();
    client.close();
  });

  test("the server names each client from its id, whatever name it asks for", async () => {
    const room = roomId("author");
    const client = await connect(a.url, { room, client: "same-client", author: "eve" });
    const again = await connect(a.url, { room, client: "same-client" });
    const hello = await client.next((m) => m.type === "hello");

    assert.match(hello.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.equal((await again.next((m) => m.type === "hello")).name, hello.name, "the same every time");
    await client.next((m) => m.type === "ready");
    client.send(op("add", "a"));
    assert.equal((await client.next((m) => m.type === "event")).author, hello.name);
    client.send({ type: "presence", data: { name: "eve" } });

    const peer = await again.next((m) => m.type === "presence" && m.peers.length > 0, 3_000);

    assert.equal(peer.peers[0].name, hello.name);
    client.close();
    again.close();
  });

  test("a note's text is cut at 500 characters without splitting an emoji", async () => {
    const room = roomId("emoji");
    const client = await connect(a.url, { room });

    await client.next((m) => m.type === "ready");
    client.send(op("add", "a", { text: `${"x".repeat(499)}😀😀` }));
    assert.equal((await client.next((m) => m.type === "event")).seq, 1);

    // What a new client gets is what was stored.
    const stored = await connect(a.url, { room });

    await stored.next((m) => m.type === "ready");
    assert.equal(Array.from(stored.of("snapshot")[0].state.notes.a.text).length, 500);
    assert.ok(stored.of("snapshot")[0].state.notes.a.text.endsWith("😀"));
    client.close();
    stored.close();
  });
});

describe("presence and shutdown", { skip }, () => {
  test("presence crosses instances, goes on a graceful shutdown right away, and on a crash within ~8 s", async () => {
    const [a, b, c] = await Promise.all([startInstance(), startInstance(), startInstance()]);
    const room = roomId("presence");
    const watcher = await connect(a.url, { room });
    const graceful = await connect(b.url, { room });
    const crashing = await connect(c.url, { room });

    await Promise.all([watcher, graceful, crashing].map((client) => client.next((m) => m.type === "ready")));
    graceful.send({ type: "presence", data: { name: "graceful" } });
    crashing.send({ type: "presence", data: { name: "crashing" } });

    const names = () => (watcher.of("presence").at(-1)?.peers ?? []).map((peer) => peer.data.name).sort();

    await until(() => names().join() === "crashing,graceful", 3_000, "both peers");

    assert.equal(await stopInstance(b), 0);
    assert.equal(graceful.closed, 1012, "onShutdown closes sockets with 1012");
    await until(() => names().join() === "crashing", 2_000, "the graceful peer to go");

    const crashedAt = Date.now();

    await stopInstance(c, "SIGKILL");
    await until(() => names().length === 0, 12_000, "the crashed peer to expire");
    const crashedGone = Date.now() - crashedAt;

    assert.ok(crashedGone > 4_000, `a crashed peer lingers until its row goes stale (${crashedGone} ms)`);
    watcher.close();
    await stopInstance(a);
  });

  test("a client that joins gets the room's presence right away, without sending its own", async () => {
    const a = await startInstance();
    const room = roomId("presence-late");
    const first = await connect(a.url, { room });

    await first.next((m) => m.type === "ready");
    first.send({ type: "presence", data: { name: "first" } });
    await first.next((m) => m.type === "presence" && m.peers.length === 1);

    const late = await connect(a.url, { room });
    const { peers } = await late.next((m) => m.type === "presence", 2_000);

    assert.deepEqual(
      peers.map((peer) => peer.data.name),
      ["first"],
    );
    first.close();
    late.close();
    await stopInstance(a);
  });

  test("two connections with the same client id in a room don't stop presence for everyone else", async () => {
    const a = await startInstance();
    const room = roomId("presence-twins");
    const client = crypto.randomUUID();
    const twins = await Promise.all([connect(a.url, { room, client }), connect(a.url, { room, client })]);
    const other = await connect(a.url, { room: roomId("presence-other") });

    await Promise.all([...twins, other].map((conn) => conn.next((m) => m.type === "ready")));
    twins.forEach((twin, i) => twin.send({ type: "presence", data: { name: `twin ${i}` } }));
    other.send({ type: "presence", data: { name: "other" } });

    const { peers } = await other.next((m) => m.type === "presence" && m.peers.length === 1, 3_000);

    assert.equal(peers[0].data.name, "other");
    [...twins, other].forEach((conn) => conn.close());
    await stopInstance(a);
  });

  test("presence the database can't store is ignored, and doesn't stop anyone else's", async () => {
    const a = await startInstance();
    const room = roomId("presence-ok");
    const [bad, good, watcher] = await Promise.all([connect(a.url, { room: roomId("presence-bad") }), connect(a.url, { room }), connect(a.url, { room })]);

    await Promise.all([bad, good, watcher].map((client) => client.next((m) => m.type === "ready")));
    bad.send({ type: "presence", data: { name: "\u0000" } });
    good.send({ type: "presence", data: { name: "good" } });

    const names = () => (watcher.of("presence").at(-1)?.peers ?? []).map((peer) => peer.data.name);

    await until(() => names().join() === "good", 3_000, "the good peer");
    // Past a few 3 s refreshes (which write all of the instance's rows in one
    // statement) and the 8 s a row stays fresh without one.
    await sleep(9_000);
    assert.deepEqual(names(), ["good"]);
    assert.equal(a.child.exitCode, null);
    [bad, good, watcher].forEach((client) => client.close());
    await stopInstance(a);
  });

  test("a stopped instance's clients can resume on another one with nothing missing", async () => {
    const [a, b] = await Promise.all([startInstance(), startInstance()]);
    const room = roomId("resume");
    const client = await connect(a.url, { room });

    await client.next((m) => m.type === "ready");
    client.send(op("add", "a"));
    await client.next((m) => m.type === "event");
    await stopInstance(a);

    // Meanwhile, someone else writes on b.
    const other = await connect(b.url, { room });

    await other.next((m) => m.type === "ready");
    other.send(op("add", "b"));
    other.send(op("add", "c"));
    await until(() => other.of("ack").length === 2);

    const resumed = await connect(b.url, { room, since: "1" });

    await resumed.next((m) => m.type === "ready");
    assert.deepEqual(
      resumed.of("event").map((event) => event.op.id),
      ["b", "c"],
    );
    other.close();
    resumed.close();
    await stopInstance(b);
  });
});

describe("editing with EDIT_TOKEN", { skip }, () => {
  const TOKEN = "a-long-random-test-token";
  let a;
  let base;

  before(async () => {
    a = await startInstance({ EDIT_TOKEN: TOKEN });
    base = `http://localhost:${a.port}`;
  });

  after(() => stopInstance(a));

  const unlock = (token, headers = {}) =>
    fetch(`${base}/api/unlock`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ token }) });

  const editorCookie = async () => (await unlock(TOKEN)).headers.get("set-cookie").split(";")[0];

  test("without the cookie, a connection gets everything but its changes are rejected", async () => {
    const room = roomId("locked");
    const editor = await connect(a.url, { room }, { headers: { cookie: await editorCookie() } });

    assert.equal((await editor.next((m) => m.type === "hello")).readOnly, false);
    await editor.next((m) => m.type === "ready");
    editor.send(op("add", "a"));
    await editor.next((m) => m.type === "ack");

    const viewer = await connect(a.url, { room });

    assert.equal((await viewer.next((m) => m.type === "hello")).readOnly, true);
    await viewer.next((m) => m.type === "ready");

    const change = op("add", "b");

    viewer.send(change);
    assert.equal((await viewer.next((m) => m.type === "reject" && m.id === change.id)).reason, "This board is read-only.");
    editor.send(op("add", "c"));
    assert.equal((await viewer.next((m) => m.type === "event" && m.op.id === "c")).seq, 2, "the rejected change didn't use a version");
    [editor, viewer].forEach((client) => client.close());
  });

  test("a read-only connection doesn't create the room it opens", async () => {
    const room = roomId("unborn");
    const viewer = await connect(a.url, { room });
    const snapshot = await viewer.next((m) => m.type === "snapshot");

    assert.equal(snapshot.version, 0);
    viewer.close();
    assert.equal(await roomVersion(room), undefined);
  });

  test("the token unlocks with a cookie that holds no token, and a wrong one is refused", async () => {
    const wrong = await unlock("nope");

    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers.get("set-cookie"), null);

    const right = await unlock(TOKEN);
    const cookie = right.headers.get("set-cookie");

    assert.equal(right.status, 200);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(!cookie.includes(TOKEN));

    const config = await (await fetch(`${base}/api/config`, { headers: { cookie: cookie.split(";")[0] } })).json();

    assert.deepEqual([config.locked, config.canEdit], [true, true]);
    assert.equal((await (await fetch(`${base}/api/config`)).json()).canEdit, false);
    assert.equal((await fetch(`${base}/api/unlock`)).status, 405);
  });

  test("the cookie doesn't count from another site's page", async () => {
    const cookie = await editorCookie();
    const client = await connect(a.url, { room: roomId("origin") }, { headers: { cookie, origin: "https://elsewhere.example" } });

    assert.equal((await client.next((m) => m.type === "hello")).readOnly, true);
    client.close();
    assert.equal((await unlock(TOKEN, { origin: "https://elsewhere.example" })).status, 403);
  });
});

describe("simulated users on the server (DEMO_BOTS)", { skip }, () => {
  test("they run on one instance while someone watches, and stop when nobody does", async () => {
    const room = roomId("bots");
    const env = { DEMO_BOTS: "writer,tidy", DEMO_BOTS_ROOM: room };
    const [a, b] = await Promise.all([startInstance(env), startInstance(env)]);

    try {
      const viewers = [await connect(a.url, { room }), await connect(b.url, { room })];
      const events = () => viewers[0].of("event");

      await until(() => events().length >= 6, 20_000, "the bots' changes");

      const peers = (await viewers[1].next((m) => m.type === "presence" && m.peers.filter((peer) => peer.data?.bot).length === 2, 5_000)).peers;

      assert.deepEqual(peers.filter((peer) => peer.data?.bot).map((peer) => peer.data.bot).sort(), ["tidy", "writer"]);
      assert.equal(new Set(events().map((event) => event.instance)).size, 1, "only one instance runs them");

      viewers.forEach((viewer) => viewer.close());
      // The next check (every 5 s) stops them.
      await sleep(7_000);

      const stoppedAt = await roomVersion(room);

      await sleep(5_000);
      assert.equal(await roomVersion(room), stoppedAt, "no changes once nobody watches");
    } finally {
      await Promise.all([stopInstance(a), stopInstance(b)]);
    }
  });
});
