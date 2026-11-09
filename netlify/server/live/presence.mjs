// Who's in each room, and whatever the app wants to show about them (a name,
// a cursor). Presence is soft state, so it stays out of the event log. Every
// 300 ms, each instance:
// 1. writes, in one statement, the rows of its clients whose data changed or
//    that it hasn't written in 3 s;
// 2. reads its rooms' rows seen in the last 8 s, and sends each room's list to
//    the room's clients when it has changed.
// When an instance stops, it deletes its rows. When it crashes, its clients
// disappear once their rows are 8 s old.
import { every } from "./every.mjs";
import * as store from "./store.mjs";

const MAX_BYTES = 1_000;
const REFRESH_MS = 3_000;
const FRESH_SECONDS = 8;

export const createPresence = ({ relay, instance, nameOf }) => {
  // roomId -> { json, peers }: the list each room's clients were last sent.
  const sent = new Map();
  let stopLoop;
  let stopped = false;
  let ticks = 0;

  // Data the database can't store would fail the write for every client of
  // this instance, so it's ignored.
  const update = (conn, data) => {
    const json = JSON.stringify(data ?? null);

    if (Buffer.byteLength(json) <= MAX_BYTES && store.storableJson(json)) {
      conn.presence = JSON.parse(json);
      conn.presenceWrittenAt = 0;
    }
  };

  // A client that just joined gets the room's current list, rather than wait
  // for it to change.
  const join = (conn) => {
    const peers = sent.get(conn.room)?.peers;

    if (peers) {
      conn.send({ type: "presence", peers });
    }
  };

  const leave = (conn) => {
    if (!stopped && conn.presence !== null) {
      store.deleteClientPresence(conn.room, conn.client, instance).catch(() => {});
    }
  };

  const tick = async () => {
    const now = Date.now();
    const due = [...relay.rooms.values()]
      .flatMap((room) => [...room.conns])
      .filter((conn) => conn.presence !== null && now - conn.presenceWrittenAt >= REFRESH_MS);

    due.forEach((conn) => (conn.presenceWrittenAt = now));
    // Two connections can use the same client id in a room, and one statement
    // can't upsert a row twice, so the last one's data is written.
    const entries = new Map(due.map((conn) => [`${conn.room} ${conn.client}`, { roomId: conn.room, clientId: conn.client, instance, data: conn.presence }]));

    await store.writePresence([...entries.values()]);
    // A client that left while that write was on its way had its row deleted
    // before the write landed, so delete it again.
    due.filter((conn) => conn.closed).forEach(leave);
    // About once a minute, rows that crashed instances left behind.
    if (++ticks % 200 === 0) {
      await store.deleteStalePresence();
    }

    const rows = await store.readPresence([...relay.rooms.keys()], FRESH_SECONDS);

    for (const [roomId, room] of relay.rooms) {
      const peers = rows.filter((row) => row.room_id === roomId).map((row) => ({ client: row.client_id, name: nameOf(row.client_id), instance: row.instance_id, data: row.data }));
      const json = JSON.stringify(peers);

      if (json !== sent.get(roomId)?.json) {
        sent.set(roomId, { json, peers });
        room.conns.forEach((conn) => conn.send({ type: "presence", peers }));
      }
    }
    for (const roomId of sent.keys()) {
      if (!relay.rooms.has(roomId)) {
        sent.delete(roomId);
      }
    }
  };

  // Only queries while this instance has connections.
  const start = () => {
    stopLoop = every(300, tick, () => relay.rooms.size > 0);
  };

  const stop = async () => {
    stopped = true;
    // A write that's on its way would bring back rows deleted before it lands.
    await stopLoop?.();
    await store.deleteInstancePresence(instance).catch(() => {});
  };

  return { update, join, leave, start, stop };
};
