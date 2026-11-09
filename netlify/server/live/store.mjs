// All the SQL. The database is the only source of truth: an instance confirms
// a change only after it's committed here.
import { getDatabase } from "@netlify/database";

let db;

export const database = () => {
  if (!db) {
    db = getDatabase();
    // Without timeouts, a query on a connection that died silently (say the
    // network drops its packets) waits forever, and so does every change
    // queued behind it in its room. A query that fails this way gives its
    // connection up, and the changes waiting on it are resent.
    Object.assign(db.pool.options, { connectionTimeoutMillis: 5_000, query_timeout: 10_000, keepAlive: true });
    // When the database drops idle connections (a restart, say), the pool
    // emits an error, and an unhandled one would crash the instance. The pool
    // already discards the connection, so there's nothing else to do.
    db.pool.on("error", (error) => console.error("database connection lost:", error.message));
  }

  return db;
};

const query = (text, values) => database().pool.query(text, values);

// Returns a room's version and state, creating the room if it's new. (One
// statement can't do both: when two instances create the same room at once,
// the one that loses waits for the other's insert, but can't see its row in
// the same statement.) With `create: false`, a room that doesn't exist yet is
// returned as it would start, without being created.
export const openRoom = async (roomId, initialState, { create = true } = {}) => {
  const read = () => query("select version, state from rooms where id = $1", [roomId]);
  let {
    rows: [room],
  } = await read();

  if (!room && !create) {
    return { version: 0, state: initialState };
  }
  if (!room) {
    await query("insert into rooms (id, state) values ($1, $2) on conflict do nothing", [roomId, initialState]);
    [room] = (await read()).rows;
  }

  return { version: Number(room.version), state: room.state };
};

export const readEvents = async (roomId, { after, limit }) => {
  const { rows } = await query(
    `select seq, client_msg_id, author, instance_id, op from room_events
     where room_id = $1 and seq > $2
     order by seq limit $3`,
    [roomId, after, limit],
  );

  return rows.map((row) => ({ type: "event", seq: Number(row.seq), id: row.client_msg_id, author: row.author, instance: row.instance_id, op: row.op }));
};

export const readVersions = async (roomIds) => {
  const { rows } = await query("select id, version from rooms where id = any($1)", [roomIds]);

  return new Map(rows.map((row) => [row.id, Number(row.version)]));
};

// Commits a batch of changes to a room, in order, in two round trips:
// 1. Read the room, and which of the batch's ids were committed or rejected
//    before (a client resending after a dropped connection).
// 2. Apply each change, then write the new state and version, the events and
//    the rejections in one statement, only if no other write to the room
//    happened meanwhile (its `writes` count is the same). If one did (another
//    instance wrote to the room), start over.
//
// The check makes versions follow commit order: a reader that has seen
// version 105 can never later find a 104 it missed. (A global sequence
// doesn't give you that, because inserts can commit out of order.) It also
// makes every change get one answer, however often it's sent: committed once,
// or rejected. And since nothing is locked between the round trips, a room's
// writers don't wait on each other's network latency.
//
// Returns { results, from, events }: a result per change, in order, which is
// { seq } or { rejected: reason } if apply() threw (the change doesn't apply
// to the current state), with `duplicate: true` if it was answered before;
// the version before the batch; and the new events. Anything else (the
// database is unreachable, say) throws, and the whole batch can be retried.
export const commit = async (roomId, items, apply, instance) => {
  const deadline = Date.now() + 5_000;
  const ids = items.map((item) => item.id);

  for (;;) {
    const {
      rows: [room],
    } = await query(
      `select version, writes, state,
         (select coalesce(jsonb_object_agg(client_msg_id, seq), '{}') from room_events where room_id = $1 and client_msg_id = any($2::uuid[])) as committed,
         (select coalesce(jsonb_object_agg(client_msg_id, reason), '{}') from room_rejections where room_id = $1 and client_msg_id = any($2::uuid[])) as rejected
       from rooms where id = $1`,
      [roomId, ids],
    );

    if (!room) {
      throw new Error(`Room ${roomId} doesn't exist`);
    }

    const from = Number(room.version);
    const seqs = new Map(Object.entries(room.committed).map(([id, seq]) => [id, Number(seq)]));
    const reasons = new Map(Object.entries(room.rejected));
    const events = [];
    const rejections = [];
    let { state } = room;

    const results = items.map(({ id, op, author }) => {
      if (seqs.has(id)) {
        return { seq: seqs.get(id), duplicate: true };
      }
      if (reasons.has(id)) {
        return { rejected: reasons.get(id), duplicate: true };
      }

      try {
        state = apply(state, op);
      } catch (error) {
        const reason = String(error?.message || error || "Rejected");

        reasons.set(id, reason);
        rejections.push({ id, reason });

        return { rejected: reason };
      }

      const seq = from + events.length + 1;

      seqs.set(id, seq);
      events.push({ type: "event", seq, id, author, instance, op });

      return { seq };
    });

    if (events.length === 0 && rejections.length === 0) {
      return { results, from, events };
    }

    // The notification is only a wake-up call (listeners read room_events),
    // and it's sent only if there are new events.
    const {
      rows: [written],
    } = await query(
      `with bumped as (
         update rooms set version = $3, state = $4, writes = writes + 1 where id = $1 and writes = $2 returning id
       ), inserted as (
         insert into room_events (room_id, seq, client_msg_id, author, instance_id, op)
         select $1, e.seq, e.id, e.author, $5, e.op from bumped, jsonb_to_recordset($6) as e(seq bigint, id uuid, author text, op jsonb)
       ), rejected as (
         insert into room_rejections (client_msg_id, room_id, reason)
         select r.id, $1, r.reason from bumped, jsonb_to_recordset($7) as r(id uuid, reason text)
       )
       select (select count(*) from bumped)::int as count, (select pg_notify('room_events', $1) from bumped where $8) as notified`,
      [roomId, room.writes, from + events.length, state, instance, JSON.stringify(events), JSON.stringify(rejections), events.length > 0],
    );

    if (written.count === 1) {
      return { results, from, events };
    }
    if (Date.now() > deadline) {
      throw new Error(`Room ${roomId} kept changing under this commit`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
  }
};

// Postgres can't store a NUL character or half of a UTF-16 surrogate pair (a
// lone surrogate), in text or in jsonb. In a string, those are the characters
// in `unstorable`. In JSON.stringify's output, they're the only characters it
// writes as these escapes (an odd number of backslashes, so not a literal
// backslash followed by "u0000").
export const unstorable = /[\0\ud800-\udfff]/u;
export const storableJson = (json) => !/(?<!\\)(?:\\\\)*\\u(?:0000|d[89a-f][0-9a-f]{2})/i.test(json);

export const writePresence = (entries) =>
  entries.length > 0 &&
  query(
    `insert into room_presence (room_id, client_id, instance_id, data, last_seen)
     select *, now() from unnest($1::text[], $2::text[], $3::text[], $4::jsonb[])
     on conflict (room_id, client_id) do update set instance_id = excluded.instance_id, data = excluded.data, last_seen = now()`,
    [entries.map((entry) => entry.roomId), entries.map((entry) => entry.clientId), entries.map((entry) => entry.instance), entries.map((entry) => JSON.stringify(entry.data))],
  );

export const readPresence = async (roomIds, freshSeconds) => {
  const { rows } = await query(
    `select room_id, client_id, instance_id, data from room_presence
     where room_id = any($1) and last_seen > now() - make_interval(secs => $2)
     order by client_id`,
    [roomIds, freshSeconds],
  );

  return rows;
};

// Only this instance's row for the client in that room: the client may have
// reconnected elsewhere already.
export const deleteClientPresence = (roomId, clientId, instance) =>
  query("delete from room_presence where room_id = $1 and client_id = $2 and instance_id = $3", [roomId, clientId, instance]);

export const deleteInstancePresence = (instance) => query("delete from room_presence where instance_id = $1", [instance]);

// Drops the change itself (the bulk of a row) from events older than a day,
// except each room's last 1,000, which covers every client that can still
// resume from its version (a client more than 500 behind gets a snapshot).
// The rows stay, with their ids, so a change resent however late still gets
// its one answer.
export const compactEvents = () =>
  query(
    `update room_events e set op = 'null'::jsonb from rooms r
     where e.room_id = r.id and e.created_at < now() - interval '1 day' and e.seq <= r.version - 1000 and e.op <> 'null'::jsonb`,
  );

// Takes or renews a lease for `seconds`, if it's free, expired or already
// `holder`'s. Returns whether `holder` has it.
export const takeLease = async (name, holder, seconds) => {
  const { rows } = await query(
    `insert into leases (name, holder, expires_at) values ($1, $2, now() + make_interval(secs => $3))
     on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at
     where leases.holder = excluded.holder or leases.expires_at < now()
     returning holder`,
    [name, holder, seconds],
  );

  return rows.length === 1;
};

export const releaseLease = (name, holder) => query("delete from leases where name = $1 and holder = $2", [name, holder]);

export const deleteStalePresence = () => query("delete from room_presence where last_seen < now() - interval '1 minute'");
