import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { applyLocalChange, editsFromDelta, localEditsFromContentChanges } from "../src/collab/textSync";

test("a local insert lands at the given offset", () => {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  text.insert(0, "Table Order {}");

  applyLocalChange(doc, text, { start: 6, end: 6, text: "Foo " }, "local");

  assert.equal(text.toString(), "Table Foo Order {}");
});

test("a local replace deletes then inserts inside one transaction", () => {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  text.insert(0, "Table Order {}");

  applyLocalChange(doc, text, { start: 6, end: 11, text: "Customer" }, "local");

  assert.equal(text.toString(), "Table Customer {}");
});

test("a local delete removes without inserting", () => {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  text.insert(0, "Table Order {}");

  applyLocalChange(doc, text, { start: 5, end: 11, text: "" }, "local");

  assert.equal(text.toString(), "Table {}");
});

test("applyLocalChange tags its transaction with the given origin", () => {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  const seen: unknown[] = [];
  doc.on("update", (_update, origin) => seen.push(origin));

  const origin = Symbol("local");
  applyLocalChange(doc, text, { start: 0, end: 0, text: "x" }, origin);

  assert.deepEqual(seen, [origin]);
});

test("editsFromDelta turns an insert-only delta into one edit", () => {
  const edits = editsFromDelta([{ retain: 6 }, { insert: "Foo " }]);
  assert.deepEqual(edits, [{ start: 6, end: 6, text: "Foo " }]);
});

test("editsFromDelta turns a delete-only delta into one edit", () => {
  const edits = editsFromDelta([{ retain: 5 }, { delete: 6 }]);
  assert.deepEqual(edits, [{ start: 5, end: 11, text: "" }]);
});

test("editsFromDelta keeps a replace as two adjacent edits", () => {
  const edits = editsFromDelta([{ retain: 6 }, { delete: 5 }, { insert: "Customer" }]);
  assert.deepEqual(edits, [
    { start: 6, end: 11, text: "" },
    { start: 11, end: 11, text: "Customer" },
  ]);
});

test("editsFromDelta advances the cursor across multiple runs", () => {
  const edits = editsFromDelta([
    { insert: "A" },
    { retain: 3 },
    { delete: 2 },
    { retain: 4 },
    { insert: "B" },
  ]);
  assert.deepEqual(edits, [
    { start: 0, end: 0, text: "A" },
    { start: 3, end: 5, text: "" },
    { start: 9, end: 9, text: "B" },
  ]);
});

test("a real Y.Text delta, translated and replayed on plain text, matches what Y.Text itself computed", () => {
  // Against the actual Yjs event shape, not a hand-built delta - the tests
  // above already pin the translation logic; this pins that `event.delta`
  // is shaped the way `editsFromDelta` expects, and that replaying its
  // output the way a `WorkspaceEdit` would reconstructs the same text.
  const local = new Y.Doc();
  const remote = new Y.Doc();
  const localText = local.getText("t");
  const remoteText = remote.getText("t");
  localText.insert(0, "Table Order {}");
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  const before = remoteText.toString();

  let observed: ReturnType<typeof editsFromDelta> | undefined;
  remoteText.observe((event) => {
    observed = editsFromDelta(event.delta);
  });

  localText.delete(6, 5);
  localText.insert(6, "Customer");
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));

  assert.ok(observed, "the observer should have fired");
  assert.equal(applyDeltaToPlainString(before, observed), remoteText.toString());
  assert.equal(remoteText.toString(), "Table Customer {}");
});

test("localEditsFromContentChanges passes a single change through unchanged", () => {
  const edits = localEditsFromContentChanges([{ rangeOffset: 6, rangeLength: 5, text: "Customer" }]);
  assert.deepEqual(edits, [{ start: 6, end: 11, text: "Customer" }]);
});

test("localEditsFromContentChanges orders simultaneous changes from the highest offset down", () => {
  // A two-cursor edit: VSCode reports both against the pre-event document,
  // in no particular order.
  const edits = localEditsFromContentChanges([
    { rangeOffset: 2, rangeLength: 0, text: "X" },
    { rangeOffset: 9, rangeLength: 0, text: "Y" },
  ]);
  assert.deepEqual(edits, [
    { start: 9, end: 9, text: "Y" },
    { start: 2, end: 2, text: "X" },
  ]);
});

test("applying localEditsFromContentChanges highest-offset-first reconstructs the same text a batch WorkspaceEdit would", () => {
  const source = "Table Order { id int; name text; }";
  const changes = [
    { rangeOffset: 6, rangeLength: 5, text: "Customer" },
    { rangeOffset: 27, rangeLength: 4, text: "string" },
  ];
  const edits = localEditsFromContentChanges(changes);

  let result = source;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);

  assert.equal(result, "Table Customer { id int; name string; }");
});

/** Applies `edits` (as {@link editsFromDelta} would produce) to a plain
 *  string, the same way a `WorkspaceEdit` would to a document - used to
 *  check the translated edits against the source text directly, rather
 *  than only against `Y.Text`'s own already-applied result. */
function applyDeltaToPlainString(source: string, edits: { start: number; end: number; text: string }[]): string {
  let result = source;
  let shift = 0;
  for (const edit of edits) {
    const start = edit.start + shift;
    const end = edit.end + shift;
    result = result.slice(0, start) + edit.text + result.slice(end);
    shift += edit.text.length - (edit.end - edit.start);
  }
  return result;
}
