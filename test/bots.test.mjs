// The demo's simulated users (public/bots.js): what each kind does on its
// turn should be a change that applies to the board it sees.
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyOp, EMPTY_BOARD } from "../public/board.js";
import { KINDS } from "../public/bots.js";

const run = (act, state, turns) => {
  const memory = {};

  for (let turn = 0; turn < turns; turn++) {
    const op = act(state, memory);

    if (op) {
      state = applyOp(state, op);
    }
  }

  return state;
};

test("Writer copes with a note whose id is \"undefined\"", () => {
  const board = applyOp(EMPTY_BOARD, { kind: "add", id: "undefined", x: 1, y: 1, text: "", color: "#ffd166" });

  assert.doesNotThrow(() => run(KINDS.writer.act, board, 50));
});

test("every kind's changes apply to the board it sees", () => {
  for (const { act } of Object.values(KINDS)) {
    run(act, EMPTY_BOARD, 300);
  }
});

test("Writer fills up to eight notes, and Gremlin leaves three", () => {
  const written = run(KINDS.writer.act, EMPTY_BOARD, 300);

  assert.equal(Object.keys(written.notes).length, 8);
  assert.equal(Object.keys(run(KINDS.gremlin.act, written, 300).notes).length, 3);
});

test("Tidy finishes once the notes are in rows", () => {
  const tidied = run(KINDS.tidy.act, run(KINDS.writer.act, EMPTY_BOARD, 300), 20);

  assert.equal(KINDS.tidy.act(tidied), null);
  // Rows start at y = 24 and are 156 apart, give or take 10 pixels.
  assert.deepEqual(
    Object.values(tidied.notes)
      .map(({ y }) => Math.floor(y / 156))
      .sort((a, b) => a - b),
    [0, 0, 0, 0, 0, 0, 1, 1],
  );
});

test("Mover keeps notes in Writer's area, and out of rows", () => {
  let board = run(KINDS.writer.act, EMPTY_BOARD, 300);
  const before = JSON.stringify(board);

  board = run(KINDS.mover.act, board, 200);
  assert.notEqual(JSON.stringify(board), before);
  for (const { x, y } of Object.values(board.notes)) {
    assert.ok(x >= 0 && x <= 900 && y >= 0 && y <= 560, `${x}, ${y}`);
  }
  // Tidy would have work to do.
  assert.notEqual(KINDS.tidy.act(board), null);
});
