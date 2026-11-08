// This instance's side of the rooms: the connections it holds, how their
// changes get committed, and how each committed event reaches them, whichever
// instance wrote it.
//
// Events always reach connections the same way: the instance reads the room's
// events after the last one it relayed, and sends each to the connections that
// don't have it yet. What makes it read:
// - a commit on this instance;
// - a NOTIFY from a commit on another instance. It's fast, but a
//   notification can be lost (say the listening connection drops);
// - polling every room's version once a second, which never misses anything.
// So a lost notification only costs latency.
import pg from "pg";

import { every } from "./every.mjs";
import * as store from "./store.mjs";

const MAX_REPLAY = 500;
const MAX_BATCH = 200;
const POLL_MS = 1_000;

export const createRelay = ({ apply, initialState, instance }) => {
  // roomId -> { conns, joining, cursor, queue, writes, writing }. `cursor` is
  // the last seq this instance has relayed for the room, and each connection
  // keeps its own `sent`, so nobody gets an event twice. `queue` runs a room's
  // joins and relays one at a time. `writes` holds the changes waiting to be
  // committed. A room is dropped once it has no connections and no joins in
  // progress.
  const rooms = new Map();
  let listener;
  let listening = false;
  let retryTimer;
  let stopPolling;
  let stopped = false;

  const serially = (room, task) => {
    const run = room.queue.then(task);

    room.queue = run.catch((error) => console.error(`[${instance}] room task failed:`, error.message));

    return run;
  };

  const sendAll = (conn, events) => {
    for (const event of events) {
      conn.send(event);
      conn.sent = event.seq;
    }
  };

  // Brings a new connection up to date, then adds it to the room. `since` is
  // the last version the client saw: a reconnecting client gets only what it
  // missed, and a new one (or one too far behind) gets a snapshot.
  const join = async (conn, since) => {
    if (!rooms.has(conn.room)) {
      rooms.set(conn.room, { conns: new Set(), joining: 0, cursor: null, queue: Promise.resolve(), writes: [], writing: false });
    }

    const room = rooms.get(conn.room);

    room.joining++;
    await serially(room, async () => {
      const { version, state } = await store.openRoom(conn.room, initialState);

      if (since !== null && since <= version && version - since <= MAX_REPLAY) {
        conn.sent = since;
        sendAll(conn, await store.readEvents(conn.room, { after: since, limit: MAX_REPLAY }));
      } else {
        conn.sent = version;
        conn.send({ type: "snapshot", version, state });
      }

      // Joins and relays run one at a time per room, so what this just read is
      // never behind what the room's other connections have been sent.
      room.cursor ??= conn.sent;

      // The client may have gone while this ran.
      if (!conn.closed) {
        room.conns.add(conn);
        conn.send({ type: "ready", version: conn.sent });
      }
    }).finally(() => {
      room.joining--;
      dropIfEmpty(conn.room, room);
    });

    relay(conn.room);
  };

  const dropIfEmpty = (roomId, room) => {
    if (room.conns.size === 0 && room.joining === 0 && rooms.get(roomId) === room) {
      rooms.delete(roomId);
    }
  };

  const leave = (conn) => {
    const room = rooms.get(conn.room);

    if (room) {
      room.conns.delete(conn);
      dropIfEmpty(conn.room, room);
    }
  };

  // Sends every event after the room's cursor to the connections that haven't
  // had it.
  const relay = (roomId) => {
    const room = rooms.get(roomId);

    return (
      room &&
      serially(room, async () => {
        for (;;) {
          const events = await store.readEvents(roomId, { after: room.cursor, limit: MAX_REPLAY });

          for (const event of events) {
            for (const conn of room.conns) {
              if (conn.sent < event.seq) {
                sendAll(conn, [event]);
              }
            }
            room.cursor = event.seq;
          }

          if (events.length < MAX_REPLAY) {
            return;
          }
        }
      })
    );
  };

  // Changes wait for their connection's join, then queue up per room, and
  // each room's queue is committed in batches, one batch at a time. So a
  // connection's changes are committed in the order it sent them ("add a
  // note" can't lose a race to "move that note"), and a busy room needs two
  // database round trips per batch rather than per change.
  //
  // If a batch can't be committed for a reason other than apply() rejecting a
  // change, its connections are closed: their clients reconnect and resend
  // everything they haven't had confirmed, and duplicates are ignored.
  const write = (conn, { id, op }) => {
    conn.joined.then(() => {
      const room = rooms.get(conn.room);

      if (!conn.closed && room) {
        room.writes.push({ conn, id, op });
        if (!room.writing) {
          drain(conn.room, room);
        }
      }
    });
  };

  const drain = async (roomId, room) => {
    room.writing = true;

    while (room.writes.length > 0) {
      const batch = room.writes.splice(0, MAX_BATCH).filter(({ conn }) => !conn.closed);

      if (batch.length === 0) {
        continue;
      }

      try {
        await commit(roomId, batch);
      } catch (error) {
        fail(batch, error);
      }
    }

    room.writing = false;
  };

  const commit = async (roomId, batch) => {
    const { results, events } = await store.commit(
      roomId,
      batch.map(({ conn, id, op }) => ({ id, op, author: conn.author })),
      apply,
      instance,
    );

    batch.forEach(({ conn, id }, index) => {
      const result = results[index];

      conn.send("rejected" in result ? { type: "reject", id, reason: result.rejected } : { type: "ack", id, seq: result.seq });
    });
    if (events.length > 0) {
      relay(roomId);
    }
  };

  const fail = (batch, error) => {
    console.error(`[${instance}] commit failed:`, error.message);
    for (const { conn } of batch) {
      conn.closed = true;
      conn.socket.close(1011, "Couldn't save a change");
    }
  };

  // LISTEN needs a long-lived connection of its own, outside the pool. When
  // it fails, polling covers until it's back. (Through a pooler in
  // transaction mode, LISTEN succeeds but notifications never arrive, and
  // polling is all there is.)
  const listen = async () => {
    const client = new pg.Client({ connectionString: store.database().connectionString });
    let failed = false;

    const fail = (error) => {
      if (failed) {
        return;
      }
      failed = true;
      listening = false;
      client.end().catch(() => {});
      if (!stopped) {
        console.log(`[${instance}] LISTEN failed, polling only for now: ${error.message}`);
        retryTimer = setTimeout(listen, 5_000);
      }
    };

    listener = client;
    client.on("error", fail);
    client.on("end", () => fail(new Error("the connection closed")));
    client.on("notification", ({ payload }) => relay(payload));

    try {
      await client.connect();
      await client.query("listen room_events");
      listening = true;
    } catch (error) {
      fail(error);
    }
  };

  const start = () => {
    if (process.env.NOTIFY !== "off") {
      listen();
    }

    // Only queries while this instance has connections, so an idle site
    // doesn't keep the database awake.
    stopPolling = every(
      POLL_MS,
      async () => {
        for (const [roomId, version] of await store.readVersions([...rooms.keys()])) {
          if (version > (rooms.get(roomId)?.cursor ?? Infinity)) {
            relay(roomId);
          }
        }
      },
      () => rooms.size > 0,
    );
  };

  const stop = async () => {
    stopped = true;
    stopPolling?.();
    clearTimeout(retryTimer);
    rooms.clear();
    await listener?.end().catch(() => {});
  };

  return {
    rooms,
    join,
    leave,
    write,
    start,
    stop,
    listening: () => listening,
    connectionCount: () => [...rooms.values()].reduce((total, room) => total + room.conns.size, 0),
  };
};
