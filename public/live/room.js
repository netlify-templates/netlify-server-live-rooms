// The browser side of netlify/server/live: one client's connection to one
// room. It runs in Node too (the tests use it as is).
//
// It keeps two things apart:
// - `confirmed`: the room as the server committed it, at `version`. It only
//   changes through events from the server, applied in order.
// - `pending`: this client's changes that the server hasn't confirmed yet,
//   each with an id. view() shows them on top of `confirmed`.
// After every (re)connect, it asks for the events after its version, then
// resends everything in `pending`. The server answers a change it has seen
// before the same way as the first time, so a change is applied once however
// often it's sent. `pending` lives in memory: it survives reconnects, but not
// a reload of the page.
//
//   const room = new LiveRoom({ url, room: "demo", apply });
//   room.on("change", () => render(room.view()));
//   room.open();
//   room.change({ kind: "add", ... });
//
// The server names each client (`room.server.name` once connected), and may
// make the connection read-only (`room.server.readOnly`).
//
// Events: "status" ({ status, detail }), "server" (which instance and deploy
// it's connected to, and the client's name), "change", "event" (each confirmed event),
// "snapshot", "reject" ({ id, op, reason }), "presence" (the other clients),
// "resync" (reason) and "duplicate" (an event it already had; this shouldn't
// happen, so it's there for tests).
const HEARTBEAT_MS = 10_000;
const SILENCE_MS = 20_000;
// WebSocket.OPEN, which a WebSocket class passed in may not have.
const OPEN = 1;

export class LiveRoom {
  // `WebSocket` is for a client in the server's own process (the live
  // module's loopback()).
  constructor({ url, room, apply, WebSocket = globalThis.WebSocket }) {
    this.url = url;
    this.room = room;
    this.apply = apply;
    this.WebSocket = WebSocket;
    this.client = crypto.randomUUID();
    this.confirmed = { version: null, state: null };
    this.pending = [];
    this.server = {};
    this.status = "connecting";
    this.ready = false;
    this.offline = false;
    this.presence = null;
    this.attempts = 0;
    this.listeners = {};
  }

  on(type, listener) {
    (this.listeners[type] ??= []).push(listener);

    return this;
  }

  emit(type, detail) {
    this.listeners[type]?.forEach((listener) => listener(detail));
  }

  open() {
    const params = new URLSearchParams({ room: this.room, client: this.client });

    if (this.confirmed.version !== null) {
      params.set("since", this.confirmed.version);
    }

    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");

    // Events from a socket this room has moved on from (say a close that
    // arrives after going offline and back) are ignored.
    const socket = new this.WebSocket(`${this.url}?${params}`);

    this.socket = socket;
    this.heardAt = Date.now();
    socket.onmessage = ({ data }) => {
      if (socket === this.socket) {
        this.heardAt = Date.now();
        this.receive(JSON.parse(data));
      }
    };
    socket.onclose = ({ code }) => socket === this.socket && this.closed(code);

    // A browser can keep a dead connection "open" for minutes (after a
    // network change, say), so the client pings too, and gives up on a
    // connection it hasn't heard from in a while.
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.heardAt > SILENCE_MS) {
        this.disconnect();
        this.closed(1006);
      } else if (socket.readyState === OPEN) {
        socket.send(JSON.stringify({ type: "ping", t: Date.now() }));
      }
    }, HEARTBEAT_MS);
    // In Node, this alone shouldn't keep the process running.
    this.heartbeat.unref?.();
  }

  // Closes the socket without waiting for its close event.
  disconnect() {
    clearInterval(this.heartbeat);
    if (this.socket) {
      this.socket.onmessage = this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }

  close() {
    this.offline = true;
    clearTimeout(this.retry);
    this.disconnect();
    this.closed();
  }

  // Going offline keeps the outbox: changes made meanwhile are sent when the
  // room is back online.
  setOffline(offline) {
    if (offline) {
      this.close();
      this.setStatus("offline");
    } else if (this.offline) {
      this.offline = false;
      this.attempts = 0;
      this.open();
    }
  }

  closed(code) {
    clearInterval(this.heartbeat);
    this.ready = false;
    this.emit("presence", []);

    if (this.offline) {
      return;
    }

    // 1012 is the server restarting: come back right away, with a little
    // jitter so a whole instance's clients don't arrive at once. Anything else
    // (a crash, a network error) backs off, up to 10 s, until a connection
    // gets to `ready`.
    this.attempts += 1;
    const delay = code === 1012 ? Math.random() * 1_000 : Math.min(10_000, 500 * 2 ** this.attempts * (0.5 + Math.random()));

    this.setStatus("reconnecting", `retrying in ${(delay / 1000).toFixed(1)} s`);
    this.retry = setTimeout(() => this.open(), delay);
  }

  receive(message) {
    switch (message.type) {
      case "hello":
        this.server = message;
        this.emit("server", this.server);
        break;

      case "snapshot":
        this.confirmed = { version: message.version, state: message.state };
        this.emit("snapshot", message);
        this.settle();
        break;

      case "event":
        if (this.confirmed.version !== null && message.seq <= this.confirmed.version) {
          this.emit("duplicate", message);
          return;
        }
        try {
          if (message.seq !== this.confirmed.version + 1) {
            throw new Error(`expected version ${this.confirmed.version + 1}, got ${message.seq}`);
          }
          this.confirmed = { version: message.seq, state: this.apply(this.confirmed.state, message.op) };
        } catch (error) {
          // Can't happen while the server keeps its promises. If it ever
          // does, start over from a snapshot rather than show a wrong state.
          this.emit("resync", error.message);
          this.confirmed = { version: null, state: null };
          this.disconnect();
          this.closed(1006);
          return;
        }
        this.pending = this.pending.filter((change) => change.id !== message.id);
        this.emit("event", message);
        this.settle();
        break;

      case "ready":
        this.ready = true;
        this.attempts = 0;
        // The outbox goes out before anyone hears the room is live, so a
        // change a listener makes then can't overtake the ones before it.
        for (const { id, op } of this.pending) {
          this.send({ type: "op", id, op });
        }
        if (this.presence) {
          this.send({ type: "presence", data: this.presence });
        }
        this.setStatus("live");
        break;

      case "ack":
        // The event confirms the change. This only matters for a resent
        // change whose event this client already had.
        this.pending = this.pending.map((change) => (change.id === message.id ? { ...change, seq: message.seq } : change));
        this.settle();
        break;

      case "reject": {
        const change = this.pending.find(({ id }) => id === message.id);

        this.pending = this.pending.filter(({ id }) => id !== message.id);
        this.emit("reject", { ...message, op: change?.op });
        this.settle();
        break;
      }

      case "presence":
        this.emit(
          "presence",
          message.peers.filter((peer) => peer.client !== this.client),
        );
        break;
    }
  }

  settle() {
    this.pending = this.pending.filter((change) => change.seq === undefined || change.seq > this.confirmed.version);
    this.emit("change");
  }

  // Makes a change: shown right away, and sent now or after the next
  // reconnect. Returns its id.
  change(op) {
    const id = crypto.randomUUID();

    this.pending.push({ id, op });
    this.send({ type: "op", id, op });
    this.settle();

    return id;
  }

  // The room as this client sees it: the confirmed state with its pending
  // changes on top (skipping any that no longer apply). null until the first
  // snapshot arrives.
  view() {
    if (this.confirmed.state === null) {
      return null;
    }

    return this.pending.reduce((state, { op }) => {
      try {
        return this.apply(state, op);
      } catch {
        return state;
      }
    }, this.confirmed.state);
  }

  setPresence(data) {
    this.presence = data;
    this.send({ type: "presence", data });
  }

  // Sends a message if connected and caught up. Returns whether it did.
  send(message) {
    if (!this.ready || this.socket?.readyState !== OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(message));

    return true;
  }

  setStatus(status, detail = "") {
    this.status = status;
    this.emit("status", { status, detail });
  }
}
