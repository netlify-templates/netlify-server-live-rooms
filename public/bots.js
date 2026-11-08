// Simulated users for the demo. Each one is a LiveRoom of its own, with its
// own socket, so to the server it's just another person on the board: it can
// land on another instance, it shows up in presence, and it reconnects and
// resends after a deploy or a crash like anyone else. Nothing here is part of
// the pattern; it only uses LiveRoom's public API.
import { applyOp, BOARD_SIZE, COLORS } from "./board.js";
import { LiveRoom } from "./live/room.js";

export const MAX_BOTS = 6;
// Milliseconds between actions, on average.
export const SPEEDS = { calm: 2_000, busy: 600, frantic: 100 };
// So a forgotten tab doesn't keep writing to the database.
const LIFETIME_MS = 10 * 60_000;

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
  if (!view.notes[memory.note] || memory.words.length === 0) {
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

export const KINDS = {
  tidy: { label: "Tidy", icon: "🧹", about: "Lines the notes up in rows, and puts back any you move", act: tidy },
  writer: { label: "Writer", icon: "✍️", about: "Types into notes a few words at a time", act: write },
  flaky: { label: "Flaky wifi", icon: "📶", about: "Writes like Writer, on a connection that keeps dropping", act: write, flaky: true },
  gremlin: { label: "Gremlin", icon: "👾", about: "Deletes notes and flings the rest around", act: gremlin },
};

export class Bot {
  constructor({ url, room, kind, speed }) {
    this.kind = kind;
    this.name = `${KINDS[kind].label} ${between(10, 99)}`;
    this.color = pick(COLORS);
    this.speed = speed;
    this.memory = {};
    this.made = 0;
    this.rejected = 0;
    this.leavesAt = Date.now() + LIFETIME_MS;

    this.room = new LiveRoom({ url, room, author: this.name, apply: applyOp });
    this.room.on("reject", () => (this.rejected += 1));
    this.room.setPresence({ name: this.name, color: this.color, bot: true });
    this.room.open();

    this.schedule();
    if (KINDS[kind].flaky) {
      this.flaking = setTimeout(() => this.flake(), between(6_000, 12_000));
    }
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
