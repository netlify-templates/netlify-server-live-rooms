// Live rooms over WebSockets on Netlify Server, with the database as the only
// source of truth. Instances can be replaced, recycled, crash or run side by
// side, and every client still ends up with the same state, without losing or
// repeating a change. The rules:
//
// 1. A change is confirmed only after it's committed (store.mjs).
// 2. Every change gets its room's next version, so each room has an ordered
//    log of changes.
// 3. A client remembers the last version it saw, and after any reconnect asks
//    for the events after it (relay.mjs).
// 4. A client keeps its unconfirmed changes and resends them after a
//    reconnect. Each has an id, so a change already committed is ignored.
// 5. Instances keep no state that matters: they relay what's in the database,
//    and on shutdown they only tell their clients to reconnect.
//
// The app supplies `apply(state, op)`, a pure function that returns the new
// state or throws if the operation doesn't apply, the state a new room starts
// with, and optionally `nameOf(client)`, the name a client id goes by in
// events and presence. Clients can't pick their own names, so nobody can show
// everyone else a name of their choosing. The browser side is
// public/live/room.js.
//
// A connection can be read-only: it gets everything, but its changes are
// rejected, and it can't create a room by opening it.
//
// The protocol, as JSON messages:
//   server -> client  hello { instance, deploy, name, readOnly }   on connect
//                     snapshot { version, state }        or the events since `since`
//                     event { seq, id, author, instance, op }
//                     ready { version }                  caught up: send your outbox
//                     ack { id, seq } | reject { id, reason }
//                     presence { peers: [{ client, name, instance, data }] }
//                     pong { t }
//   client -> server  op { id, op }                      processed once the join is done
//                     presence { data }
//                     ping { t }                         for heartbeats and round trips
//                     anything else goes to the app's onMessage
//
// The server closes a connection with 1012 when the instance stops, 1011 when
// it can't load the room or save a change, 1013 when the client is too far
// behind on reading, 1009 for a message over 64 KB and 1003 for one that
// breaks the handler. The client reconnects and resumes after any of them.
import { getContext, upgradeWebSocket } from "@netlify/server";

import { createPresence } from "./presence.mjs";
import { createRelay } from "./relay.mjs";
import * as store from "./store.mjs";

const ID = /^[\w-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MESSAGE = 64 * 1024;
// A client this far behind on reading is dropped rather than buffered for:
// it resumes with `since` when it reconnects.
const MAX_BUFFERED = 1024 * 1024;

// The deploy the current request is for. Netlify Server doesn't set
// DEPLOY_ID in the environment, but the local harness does.
const deployId = () => {
  try {
    return getContext().deploy.id;
  } catch {
    return process.env.DEPLOY_ID ?? "local";
  }
};

export const createLive = ({ apply, initialState, nameOf = (client) => client.slice(0, 8) }) => {
  const instance = Math.random().toString(36).slice(2, 6);
  const startedAt = Date.now();
  const conns = new Set();
  let stopping = false;
  const relay = createRelay({ apply, initialState, instance });
  const presence = createPresence({ relay, instance, nameOf });

  const info = () => ({
    instance,
    deploy: deployId(),
    // Whether NOTIFY is working. Without it, instances learn about each
    // other's writes by polling.
    notify: relay.listening(),
    sockets: relay.connectionCount(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });

  // The connection parameters from /...?room=&client=&since=, or an error.
  const parse = (search) => {
    const params = new URLSearchParams(search);
    const since = params.has("since") ? Number(params.get("since")) : null;

    if (!ID.test(params.get("room") ?? "") || !ID.test(params.get("client") ?? "") || (since !== null && !Number.isSafeInteger(since))) {
      return { error: "Expected room and client ids, and an integer since." };
    }

    return { room: params.get("room"), client: params.get("client"), since };
  };

  // Upgrades a request for /...?room=&client=&since= and returns the response
  // to send. `onMessage(message, conn)` gets the messages that aren't part of
  // the protocol, and `readOnly` makes the connection read-only.
  const connect = (request, options = {}) => {
    const params = parse(new URL(request.url).search);

    if (params.error) {
      return Response.json({ error: params.error }, { status: 400 });
    }
    if (stopping) {
      return Response.json({ error: "This instance is stopping. Try again." }, { status: 503 });
    }

    // On Netlify Server, a WebSocket isn't cut off by the request time limit,
    // and an instance with open sockets doesn't scale to zero. A client that
    // stops answering pings for 30 s is dropped.
    const { socket, response } = upgradeWebSocket(request, { idleTimeout: 30 });

    attach(socket, params, options);

    return response;
  };

  // A WebSocket class for clients in this process (LiveRoom takes one), whose
  // sockets connect straight to this instance, with no network in between.
  // They go through the same protocol as everyone else's.
  const loopback = (options = {}) =>
    function LoopbackSocket(url) {
      const [client, server] = socketPair();
      const params = parse(new URL(url, "http://loopback").search);

      if (params.error || stopping) {
        client.close(stopping ? 1012 : 1008, params.error ?? "Service restart");
      } else {
        attach(server, params, options);
      }

      return client;
    };

  const attach = (socket, params, { onMessage, readOnly = false }) => {
    const conn = {
      socket,
      room: params.room,
      client: params.client,
      author: nameOf(params.client),
      readOnly,
      sent: 0,
      presence: null,
      closed: false,
      send: (message) => {
        if (socket.readyState !== socket.OPEN) {
          return;
        }
        if (socket.bufferedAmount > MAX_BUFFERED) {
          conn.closed = true;
          socket.close(1013, "Too far behind");
          return;
        }
        socket.send(JSON.stringify(message));
      },
    };

    conns.add(conn);
    conn.send({ type: "hello", ...info(), name: conn.author, readOnly });
    // The connection's changes queue up behind the join, so none is committed
    // before the room exists and the client is caught up.
    conn.joined = relay.join(conn, params.since).then(
      () => presence.join(conn),
      (error) => {
        console.error(`[${instance}] join failed:`, error.message);
        conn.closed = true;
        socket.close(1011, "Couldn't load the room");
      },
    );

    // Runs inside the socket's data handler, where an exception would take
    // the whole instance down, so nothing a client sends can throw out of it.
    socket.onmessage = ({ data }) => {
      try {
        if (typeof data !== "string" || Buffer.byteLength(data) > MAX_MESSAGE) {
          socket.close(1009, "Message too big");
          return;
        }

        let message;

        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (!message || typeof message !== "object") {
          return;
        }

        if (message.type === "op") {
          // apply() gets the change as it will be stored and sent to other
          // clients: through JSON, which turns 1e400 (Infinity) into null,
          // say. A change that can never be committed would be resent
          // forever, so it's rejected up front.
          const json = JSON.stringify(message.op ?? null);

          if (typeof message.id !== "string" || !UUID.test(message.id)) {
            conn.send({ type: "reject", id: message.id, reason: "A change's id must be a lowercase UUID." });
          } else if (conn.readOnly) {
            conn.send({ type: "reject", id: message.id, reason: "This board is read-only." });
          } else if (!store.storableJson(json)) {
            conn.send({ type: "reject", id: message.id, reason: "This change has text that can't be stored." });
          } else {
            relay.write(conn, { id: message.id, op: JSON.parse(json) });
          }
        } else if (message.type === "presence") {
          presence.update(conn, message.data);
        } else if (message.type === "ping") {
          conn.send({ type: "pong", t: message.t });
        } else {
          onMessage?.(message, conn);
        }
      } catch (error) {
        console.error(`[${instance}] bad message:`, error.message);
        conn.closed = true;
        socket.close(1003, "Bad message");
      }
    };

    socket.onclose = () => {
      conn.closed = true;
      conns.delete(conn);
      relay.leave(conn);
      presence.leave(conn);
    };
  };

  // The client ids connected to a room on this instance.
  const clients = (roomId) => [...(relay.rooms.get(roomId)?.conns ?? [])].map((conn) => conn.client);

  const start = () => {
    relay.start();
    presence.start();
    console.log(`[${instance}] started`);
  };

  // Tells every client to reconnect (1012 is "service restart"), which takes
  // them to an instance that's still running. There's nothing to flush, since
  // every change was committed before it was confirmed. The database pool is
  // closed last, once the instance's other work is done: onShutdown passes
  // `drained`, which resolves when it is.
  const stop = async ({ drained } = {}) => {
    stopping = true;
    console.log(`[${instance}] stopping, closing ${conns.size} sockets`);
    for (const conn of conns) {
      conn.closed = true;
      conn.socket.close(1012, "Service restart");
    }
    await presence.stop();
    await relay.stop();
    await drained;
    await store.database().pool.end().catch(() => {});
  };

  return { connect, loopback, clients, info, start, stop };
};

// Two linked ends of an in-process socket, with the part of the WebSocket API
// that this file and LiveRoom use. Like a network, it delivers messages and
// the close event later, in order.
const socketPair = () => {
  const end = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, onmessage: null, onclose: null });
  const ends = [end(), end()];

  ends.forEach((self, index) => {
    const other = ends[1 - index];

    self.send = (data) => {
      if (self.readyState === 1) {
        setImmediate(() => other.readyState !== 3 && other.onmessage?.({ data }));
      }
    };
    self.close = (code = 1005, reason = "") => {
      if (self.readyState !== 1) {
        return;
      }
      self.readyState = other.readyState = 2;
      setImmediate(() => {
        for (const side of ends) {
          side.readyState = 3;
          side.onclose?.({ code, reason });
        }
      });
    };
  });

  return ends;
};
