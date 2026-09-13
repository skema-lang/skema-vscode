import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { absoluteUri, relativePath } from "../src/collab/projectPaths";

const root = pathToFileURL(path.join(path.sep, "project", "main.skema")).toString();

test("the root file's own key is its basename", () => {
  assert.equal(relativePath(root, root), "main.skema");
});

test("a file beside the root keys by its own name", () => {
  const file = pathToFileURL(path.join(path.sep, "project", "orders.skema")).toString();
  assert.equal(relativePath(root, file), "orders.skema");
});

test("a file in a subdirectory keys with forward slashes, even on Windows-style separators", () => {
  const file = pathToFileURL(path.join(path.sep, "project", "shared", "types.skema")).toString();
  assert.equal(relativePath(root, file), "shared/types.skema");
});

test("a file outside the project directory has no key", () => {
  const file = pathToFileURL(path.join(path.sep, "elsewhere", "types.skema")).toString();
  assert.equal(relativePath(root, file), undefined);
});

test("absoluteUri is the inverse of relativePath for a sibling file", () => {
  const file = pathToFileURL(path.join(path.sep, "project", "orders.skema")).toString();
  assert.equal(absoluteUri(root, relativePath(root, file)!), file);
});

test("absoluteUri is the inverse of relativePath for a nested file", () => {
  const file = pathToFileURL(path.join(path.sep, "project", "shared", "types.skema")).toString();
  assert.equal(absoluteUri(root, relativePath(root, file)!), file);
});

test("absoluteUri joins a forward-slash key under the root directory", () => {
  assert.equal(
    absoluteUri(root, "shared/types.skema"),
    pathToFileURL(path.join(path.sep, "project", "shared", "types.skema")).toString(),
  );
});
