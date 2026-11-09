// Simulated users for the demo. Each one is a LiveRoom of its own, with its
// own socket, so to the server it's just another person on the board: it can
// land on another instance, it shows up in presence, and it reconnects and
// resends after a deploy or a crash like anyone else. Nothing here is part of
// the pattern; it only uses LiveRoom's public API. They run in the page, and
// on the server for a site's always-on ones (netlify/server/demo-bots.mjs).
import { applyOp, BOARD_SIZE, COLORS } from "./board.js";
import { LiveRoom } from "./live/room.js";

// A tab's simulated users, including the ones that left, so a forgotten tab
// can't keep many of them writing to the database for long.
export const MAX_BOTS = 3;
// Milliseconds between actions, on average.
export const SPEEDS = { calm: 2_000, busy: 600 };
// How long a simulated user stays before it leaves.
export const LIFETIME_MS = 3 * 60_000;

const PHRASES = [
  "remember to water the plants",
  "who moved my note",
  "lunch at noon?",
  "ship it on friday",
  "every change gets one answer",
  "versions all the way down",
  "the database is the only truth",
  "is anyone else seeing this",
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (min, max) => Math.round(min + Math.random() * (max - min));

// What each kind of user does on its turn: given the board as it sees it and
// a place to remember things, it returns a change to make, or null.

// A number from -1 to 1 that's the same for a note in every tab.
const wobble = (id, seed) => {
  let result = seed;

  for (const char of id) {
    result = (result * 31 + char.charCodeAt(0)) >>> 0;
  }

  return ((result % 201) - 100) / 100;
};

// Lines the notes up in rows, in order of their ids. A new note shifts the
// ones after it, and a note someone drags away gets put back. Each note sits
// a little off its spot, the same way every time, so the rows look placed by
// hand and Tidy still knows when it's done.
const tidy = (view) => {
  const ids = Object.keys(view.notes).sort();

  for (const [index, id] of ids.entries()) {
    const x = 24 + (index % 6) * 204 + Math.round(wobble(id, 1) * 14);
    const y = Math.min(24 + Math.floor(index / 6) * 156 + Math.round(wobble(id, 2) * 10), BOARD_SIZE.height);
    const note = view.notes[id];

    if (note.x !== x || note.y !== y) {
      return { kind: "move", id, x, y };
    }
  }

  return null;
};

// Types a phrase into a note a word at a time, then moves on to another note,
// adding one while there are fewer than eight.
const write = (view, memory) => {
  if (!memory.words?.length || !Object.hasOwn(view.notes, memory.note ?? "")) {
    const ids = Object.keys(view.notes);

    memory.words = pick(PHRASES).split(" ");
    memory.text = "";

    if (ids.length < 8) {
      memory.note = crypto.randomUUID().slice(0, 8);

      return { kind: "add", id: memory.note, x: between(40, 1000), y: between(40, 600), text: "", color: pick(COLORS) };
    }
    memory.note = pick(ids);
  }

  memory.text = `${memory.text} ${memory.words.shift()}`.trim();

  return { kind: "edit", id: memory.note, text: memory.text };
};

// Deletes notes while there are more than three, and flings the rest around.
const gremlin = (view) => {
  const ids = Object.keys(view.notes);

  if (ids.length === 0) {
    return null;
  }

  const id = pick(ids);

  return ids.length > 3 && Math.random() < 0.6 ? { kind: "delete", id } : { kind: "move", id, x: between(0, 1100), y: between(0, 700) };
};

// Moves a note a short way, and now and then next to another note, so the
// board keeps changing shape the way it does when a few people rearrange
// things, without ever settling into rows. Notes stay in the area Writer adds
// them to, so none drift off-screen.
const AREA = { width: 1100, height: 700 };
const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const move = (view) => {
  const ids = Object.keys(view.notes);

  if (ids.length === 0) {
    return null;
  }

  const id = pick(ids);
  let { x, y } = view.notes[id];

  if (ids.length > 1 && Math.random() < 0.25) {
    const other = view.notes[pick(ids.filter((otherId) => otherId !== id))];
    const [dx, dy] = pick(SIDES);

    x = other.x + dx * between(190, 220) + between(-15, 15);
    y = other.y + dy * between(140, 170) + between(-15, 15);
  } else {
    const angle = Math.random() * 2 * Math.PI;
    const distance = between(40, 200);

    x += Math.cos(angle) * distance;
    y += Math.sin(angle) * distance;
  }

  return { kind: "move", id, x: Math.round(Math.min(Math.max(x, 0), AREA.width - 200)), y: Math.round(Math.min(Math.max(y, 0), AREA.height - 140)) };
};

export const KINDS = {
  tidy: { label: "Tidy", icon: "🧹", about: "Lines the notes up in rows, and puts back any you move", act: tidy },
  writer: { label: "Writer", icon: "✍️", about: "Types into notes a few words at a time", act: write },
  flaky: { label: "Flaky wifi", icon: "📶", about: "Writes like Writer, on a connection that keeps dropping", act: write, flaky: true },
  mover: { label: "Mover", icon: "✋", about: "Moves notes around a little, and now and then next to another one", act: move },
  gremlin: { label: "Gremlin", icon: "👾", about: "Deletes notes and flings the rest around", act: gremlin },
};

export class Bot {
  // `lifetime` is how long it stays, and `WebSocket` is passed on to LiveRoom.
  constructor({ url, room, kind, speed, lifetime = LIFETIME_MS, WebSocket }) {
    this.kind = kind;
    this.color = pick(COLORS);
    this.speed = speed;
    this.memory = {};
    this.made = 0;
    this.rejected = 0;
    this.left = false;
    this.leavesAt = Date.now() + lifetime;

    this.room = new LiveRoom({ url, room, apply: applyOp, WebSocket });
    this.room.on("reject", () => (this.rejected += 1));
    this.room.setPresence({ color: this.color, bot: kind });
    this.room.open();

    this.schedule();
    if (KINDS[kind].flaky) {
      this.flaking = setTimeout(() => this.flake(), between(6_000, 12_000));
    }
  }

  // The server names it once it's connected.
  get name() {
    return this.room.server.name ?? "Someone";
  }

  // Counted this way rather than from events, since after a long gap a
  // reconnect brings a snapshot, without the events of its changes.
  get committed() {
    return this.made - this.rejected - this.room.pending.length;
  }

  schedule() {
    this.timer = setTimeout(() => this.tick(), SPEEDS[this.speed] * (0.5 + Math.random()));
  }

  tick() {
    if (Date.now() > this.leavesAt) {
      this.remove();
      this.left = true;
      this.onleave?.();
      return;
    }

    // It acts on its own view of the board, which includes its unsent
    // changes, so it keeps working while offline, like a person would.
    const view = globalThis.document?.hidden ? null : this.room.view();
    const op = view && KINDS[this.kind].act(view, this.memory);

    if (op) {
      this.room.change(op);
      this.made += 1;
    }
    this.schedule();
  }

  // Offline for 3-6 s, then online for 6-12 s, and so on.
  flake() {
    const offline = !this.room.offline;

    this.room.setOffline(offline);
    this.flaking = setTimeout(() => this.flake(), offline ? between(3_000, 6_000) : between(6_000, 12_000));
  }

  remove() {
    clearTimeout(this.timer);
    clearTimeout(this.flaking);
    this.room.close();
  }
}
