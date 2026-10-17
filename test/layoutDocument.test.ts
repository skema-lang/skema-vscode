import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyLayout, serializeLayout } from "@skema/diagram";

import { applyThenSave, loadLayout, serializeWrites } from "../src/diagram/layoutDocument";

const hiddenLine = { ...emptyLayout(), hiddenEdges: ["Order.customer"] };
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const layoutFile = "file:///project/.skema/layout.json";
const otherLayoutFile = "file:///other/.skema/layout.json";
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const noFailure = (error: unknown): void => assert.fail(String(error));

/** A write that records each value as it starts and finishes only when the test says so. */
function heldWrite(): {
  started: string[];
  finish: () => void;
  write: (file: string, value: string) => Promise<void>;
} {
  const started: string[] = [];
  const pending: Array<() => void> = [];
  return {
    started,
    finish: () => pending.shift()?.(),
    write: (_file, value) => {
      started.push(value);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
}

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

test("a write starts only after the previous one settles", async () => {
  const { started, finish, write } = heldWrite();
  const queue = serializeWrites(write, noFailure);
  void queue.write(layoutFile, "first gesture");
  await settle();
  const done = queue.write(layoutFile, "second gesture");
  await settle();
  assert.deepEqual(started, ["first gesture"]);

  finish();
  await settle();
  assert.deepEqual(started, ["first gesture", "second gesture"]);
  finish();
  await done;
});

test("a burst during a write keeps only the latest layout", async () => {
  const { started, finish, write } = heldWrite();
  const queue = serializeWrites(write, noFailure);
  void queue.write(layoutFile, "first gesture");
  await settle();
  void queue.write(layoutFile, "second gesture");
  const done = queue.write(layoutFile, "third gesture");

  finish();
  await settle();
  finish();
  await done;
  assert.deepEqual(started, ["first gesture", "third gesture"]);
});

test("a layout waiting for another file is not replaced", async () => {
  const { started, finish, write } = heldWrite();
  const queue = serializeWrites(write, noFailure);
  void queue.write(layoutFile, "first gesture");
  await settle();
  void queue.write(layoutFile, "second gesture");
  void queue.write(otherLayoutFile, "other project");
  const done = queue.write(layoutFile, "third gesture");

  for (let step = 0; step < 3; step++) {
    finish();
    await settle();
  }
  await done;
  assert.deepEqual(started, ["first gesture", "third gesture", "other project"]);
});

test("a failed write is reported and the next one still runs", async () => {
  const failures: unknown[] = [];
  const written: string[] = [];
  const queue = serializeWrites<string>(
    async (_file, value) => {
      if (value === "first gesture") throw new Error("EROFS");
      written.push(value);
    },
    (error) => failures.push(error),
  );
  void queue.write(layoutFile, "first gesture");
  await queue.write(otherLayoutFile, "other project");
  assert.equal(failures.length, 1);
  assert.deepEqual(written, ["other project"]);
});

test("a reporter that throws does not stop the writes after it", async () => {
  const written: string[] = [];
  const queue = serializeWrites<string>(
    async (_file, value) => {
      if (value === "first gesture") throw new Error("EROFS");
      written.push(value);
    },
    () => {
      throw new Error("Channel has been closed");
    },
  );
  await assert.doesNotReject(queue.write(layoutFile, "first gesture"));
  await assert.doesNotReject(queue.write(otherLayoutFile, "other project"));
  assert.deepEqual(written, ["other project"]);
});

test("a read waits for the write pending for its file", async () => {
  const { finish, write } = heldWrite();
  const queue = serializeWrites(write, noFailure);
  let read = false;
  void queue.write(layoutFile, "gesture");
  const idle = queue.idle(layoutFile).then(() => {
    read = true;
  });
  await settle();
  assert.equal(read, false);

  finish();
  await idle;
  assert.equal(read, true);
});

test("a read also waits for a write queued while it was waiting", async () => {
  const { started, finish, write } = heldWrite();
  const queue = serializeWrites(write, noFailure);
  let read = false;
  void queue.write(layoutFile, "first gesture");
  await settle();
  const idle = queue.idle(layoutFile).then(() => {
    read = true;
  });
  void queue.write(layoutFile, "second gesture");

  finish();
  await settle();
  assert.deepEqual(started, ["first gesture", "second gesture"]);
  assert.equal(read, false);
  finish();
  await idle;
  assert.equal(read, true);
});

test("a read does not wait for a write to another file", async () => {
  const { finish, write } = heldWrite();
  const queue = serializeWrites(write, noFailure);
  void queue.write(otherLayoutFile, "other project");
  await queue.idle(layoutFile);
  finish();
});
