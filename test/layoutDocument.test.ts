import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyLayout, serializeLayout } from "@skema/diagram";

import { applyThenSave, loadLayout } from "../src/diagram/layoutDocument";

const hiddenLine = { ...emptyLayout(), hiddenEdges: ["Order.customer"] };
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

test("an open document's unsaved text wins over the disk", async () => {
  let diskRead = false;
  const layout = await loadLayout(serializeLayout(hiddenLine), async () => {
    diskRead = true;
    return bytesOf(serializeLayout(emptyLayout()));
  });
  assert.deepEqual(layout.hiddenEdges, ["Order.customer"]);
  assert.equal(diskRead, false);
});

test("the disk is read when no document is open", async () => {
  const layout = await loadLayout(undefined, async () => bytesOf(serializeLayout(hiddenLine)));
  assert.deepEqual(layout.hiddenEdges, ["Order.customer"]);
});

test("a file that cannot be read is an empty arrangement", async () => {
  const layout = await loadLayout(undefined, () => Promise.reject(new Error("FileNotFound")));
  assert.deepEqual(layout, emptyLayout());
});

test("an applied edit is saved", async () => {
  const calls: string[] = [];
  await applyThenSave(
    async () => (calls.push("apply"), true),
    async () => (calls.push("save"), true),
    (reason) => calls.push(`unsaved: ${reason}`),
  );
  assert.deepEqual(calls, ["apply", "save"]);
});

test("an edit VS Code refused is not saved", async () => {
  const calls: string[] = [];
  await applyThenSave(
    async () => (calls.push("apply"), false),
    async () => (calls.push("save"), true),
    (reason) => calls.push(`unsaved: ${reason}`),
  );
  assert.deepEqual(calls, ["apply"]);
});

test("a save that reports failure is logged, not thrown", async () => {
  const reasons: string[] = [];
  await applyThenSave(
    async () => true,
    async () => false,
    (reason) => reasons.push(reason),
  );
  assert.equal(reasons.length, 1);
});

test("a save that throws is logged, not thrown", async () => {
  const reasons: string[] = [];
  await assert.doesNotReject(
    applyThenSave(
      async () => true,
      () => Promise.reject(new Error("EACCES")),
      (reason) => reasons.push(reason),
    ),
  );
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? "", /EACCES/);
});
