// The board's rules (public/board.js). applyOp runs on both sides, so it has
// to be pure: same input, same output, and never a change to its input.
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyOp, BOARD_SIZE, COLORS, EMPTY_BOARD } from "../public/board.js";

const add = (id, extra = {}) => ({ kind: "add", id, x: 10, y: 20, text: "hi", color: COLORS[1], ...extra });

test("add, move, edit and delete a note", () => {
  let state = applyOp(EMPTY_BOARD, add("a"));

  assert.deepEqual(state.notes.a, { x: 10, y: 20, text: "hi", color: COLORS[1] });
  state = applyOp(state, { kind: "move", id: "a", x: 30, y: 40 });
  assert.deepEqual([state.notes.a.x, state.notes.a.y], [30, 40]);
  state = applyOp(state, { kind: "edit", id: "a", text: "bye" });
  assert.equal(state.notes.a.text, "bye");
  state = applyOp(state, { kind: "delete", id: "a" });
  assert.deepEqual(state.notes, {});
});

test("ids that are names on Object.prototype aren't notes", () => {
  for (const id of ["__proto__", "toString", "constructor", "valueOf", "hasOwnProperty"]) {
    assert.throws(() => applyOp(EMPTY_BOARD, add(id)), /Malformed/, id);
    assert.throws(() => applyOp(EMPTY_BOARD, { kind: "move", id, x: 1, y: 1 }), /Malformed/, id);
  }
  assert.equal(Object.getPrototypeOf(applyOp(EMPTY_BOARD, add("a")).notes), Object.prototype);
});

test("never mutates its input", () => {
  const before = applyOp(EMPTY_BOARD, add("a"));
  const frozen = JSON.stringify(before);

  applyOp(before, { kind: "move", id: "a", x: 1, y: 1 });
  applyOp(before, { kind: "delete", id: "a" });
  applyOp(before, add("b"));
  assert.equal(JSON.stringify(before), frozen);
  assert.deepEqual(EMPTY_BOARD, { notes: {} });
});

test("rejects operations that don't apply", () => {
  const state = applyOp(EMPTY_BOARD, add("a"));

  assert.throws(() => applyOp(state, add("a")), /already exists/);
  for (const kind of ["move", "edit", "delete"]) {
    assert.throws(() => applyOp(state, { kind, id: "missing", x: 0, y: 0, text: "" }), /deleted/);
  }
  assert.throws(() => applyOp(state, { kind: "explode", id: "a" }), /Unknown operation/);
});

test("rejects malformed operations", () => {
  for (const op of [null, "add", {}, { kind: "add" }, { kind: "add", id: "" }, { kind: "add", id: "a b" }, { kind: "add", id: "x".repeat(41) }]) {
    assert.throws(() => applyOp(EMPTY_BOARD, op), /Malformed/, JSON.stringify(op));
  }
});

test("clamps positions, truncates text and falls back to a known color", () => {
  const state = applyOp(EMPTY_BOARD, add("a", { x: -50, y: 1e9, text: "x".repeat(900), color: "red" }));

  assert.deepEqual([state.notes.a.x, state.notes.a.y], [0, BOARD_SIZE.height]);
  assert.equal(state.notes.a.text.length, 500);
  assert.equal(state.notes.a.color, COLORS[0]);
  assert.equal(applyOp(EMPTY_BOARD, add("b", { x: "nope" })).notes.b.x, 0);
});

test("caps the number of notes at 200", () => {
  let state = EMPTY_BOARD;

  for (let i = 0; i < 200; i++) {
    state = applyOp(state, add(`n${i}`));
  }
  assert.throws(() => applyOp(state, add("one-more")), /full/);
});
