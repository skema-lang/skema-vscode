import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { adoptProject, seedProject, sharedFiles } from "../src/collab/projectSync";

test("seedProject writes every file's content into the shared map", () => {
  const doc = new Y.Doc();
  seedProject(doc, "main.skema", [
    { path: "main.skema", text: "import \"orders.skema\";" },
    { path: "orders.skema", text: "Table Order {}" },
  ]);

  const files = sharedFiles(doc);
  assert.equal(files.get("main.skema")?.toString(), "import \"orders.skema\";");
  assert.equal(files.get("orders.skema")?.toString(), "Table Order {}");
});

test("a guest syncing after seedProject adopts the same root and files", () => {
  const host = new Y.Doc();
  seedProject(host, "main.skema", [
    { path: "main.skema", text: "Table Order {}" },
    { path: "shared/types.skema", text: "Table Base {}" },
  ]);

  const guest = new Y.Doc();
  Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));

  const adopted = adoptProject(guest);
  assert.equal(adopted.rootPath, "main.skema");
  assert.deepEqual(
    adopted.files.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "main.skema", text: "Table Order {}" },
      { path: "shared/types.skema", text: "Table Base {}" },
    ],
  );
});

test("adoptProject on a document nothing has seeded yet returns no root and no files", () => {
  const adopted = adoptProject(new Y.Doc());
  assert.equal(adopted.rootPath, undefined);
  assert.deepEqual(adopted.files, []);
});

test("seedProject is one transaction, so a listener never observes a partial file list", () => {
  const doc = new Y.Doc();
  let updates = 0;
  doc.on("update", () => {
    updates += 1;
  });

  seedProject(doc, "main.skema", [
    { path: "main.skema", text: "Table Order {}" },
    { path: "orders.skema", text: "Table Line {}" },
  ]);

  assert.equal(updates, 1);
});
