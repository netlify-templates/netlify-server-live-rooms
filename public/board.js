// The board's rules: its state and the operations on it. This is the only
// board-specific part of the server. The same applyOp runs on the server,
// inside the transaction that commits a change, and in the browser, which
// applies changes optimistically while they're on their way.
//
// A board's state is { notes: { [id]: { x, y, text, color } } }.

export const EMPTY_BOARD = { notes: {} };
export const COLORS = ["#ffd166", "#9be7c4", "#a0c4ff", "#ffadad", "#d7b9ff"];
export const BOARD_SIZE = { width: 2400, height: 1600 };

const MAX_NOTES = 200;
const MAX_TEXT = 500;

const clamp = (value, max) => Math.min(Math.max(Math.round(Number(value) || 0), 0), max);

// By characters (code points), not UTF-16 units, so an emoji at the limit
// isn't cut in half: half of one can't be stored.
export const truncate = (text) => Array.from(String(text ?? "")).slice(0, MAX_TEXT).join("");

// Note ids are keys of a plain object, so names like "__proto__" or
// "toString" would reach Object.prototype rather than a note.
const validId = (id) => typeof id === "string" && /^[\w-]{1,40}$/.test(id) && !(id in Object.prototype);

// Returns the new state, or throws if the operation doesn't apply, for example
// editing a note someone else just deleted. The server then rejects the
// change, with the error's message as the reason. Never mutates `state`.
export const applyOp = (state, op) => {
  if (!op || typeof op !== "object" || !validId(op.id)) {
    throw new Error("Malformed operation.");
  }

  const notes = { ...state.notes };
  const note = Object.hasOwn(notes, op.id) ? notes[op.id] : undefined;

  switch (op.kind) {
    case "add":
      if (note) {
        throw new Error("That note already exists.");
      }
      if (Object.keys(notes).length >= MAX_NOTES) {
        throw new Error("The board is full.");
      }
      notes[op.id] = {
        x: clamp(op.x, BOARD_SIZE.width),
        y: clamp(op.y, BOARD_SIZE.height),
        text: truncate(op.text),
        color: COLORS.includes(op.color) ? op.color : COLORS[0],
      };
      break;

    case "move":
    case "edit":
    case "delete":
      if (!note) {
        throw new Error("That note was deleted.");
      }
      if (op.kind === "move") {
        notes[op.id] = { ...note, x: clamp(op.x, BOARD_SIZE.width), y: clamp(op.y, BOARD_SIZE.height) };
      } else if (op.kind === "edit") {
        notes[op.id] = { ...note, text: truncate(op.text) };
      } else {
        delete notes[op.id];
      }
      break;

    default:
      throw new Error(`Unknown operation "${op.kind}".`);
  }

  return { ...state, notes };
};
