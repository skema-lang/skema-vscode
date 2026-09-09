/**
 * The seam between the language server's JSON and the diagram's TypeScript.
 *
 * Everything else in this extension is checked by the compiler or by
 * `skema-lang`'s own tests. This is the one place neither can reach: the
 * types here are *vendored* declarations of what the server promises to
 * send, and nothing would notice if the promise and the reality drifted -
 * a renamed field arrives as `undefined`, and a diagram silently loses its
 * relationship lines rather than failing.
 *
 * So the fixture is a real `skema/model` response, captured from the real
 * server against `examples/generic` in the language repo (with the absolute
 * paths rewritten to `/workspace`). Re-capture it after changing the
 * protocol; the assertions below are about the model, not about the
 * capture.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { ModelResponse } from "../shared/protocol";
import { nodeData, relationEdges, tableId } from "../webview/diagram/graph";
import { readPosition } from "../webview/diagram/positions";
import { collectProjectStyles, readStyleClasses, resolveTableStyle } from "../webview/diagram/style";
import { useProject } from "../webview/store";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "model.json"), "utf8"),
) as ModelResponse;

const ROOT = "/workspace/project.skema";

test("the response fills the store the diagram reads", () => {
  useProject.getState().applyModel(fixture);
  const state = useProject.getState();

  assert.equal(state.analysis?.model.tables.length, 6);
  assert.equal(state.isOwnRoot, false, "lending.skema belongs to project.skema");
  assert.deepEqual(Object.keys(state.metas).sort(), [
    "/workspace/catalog.skema",
    "/workspace/lending.skema",
    "/workspace/project.skema",
    "/workspace/types.skema",
  ]);
  // The path→URI mapping is the only way a dragged table can name a file.
  assert.equal(state.uriOf["/workspace/lending.skema"], "file:///workspace/lending.skema");
});

test("a back-reference is neither a column nor an edge", () => {
  const model = fixture.model;
  const author = model.tables.find((t) => t.name === "Author");
  assert.ok(author, "Author is in the model");

  // `books <Book.author` is a real field with a real relation...
  assert.ok(
    author.fields.some((f) => f.name === "books" && f.relation),
    "the back-reference is a model field",
  );
  // ...but it creates no column (docs/07) and must not be drawn as one.
  const data = nodeData(author, {});
  assert.ok(!data.columns.some((f) => f.name === "books"));
  assert.deepEqual(
    data.backReferences.map((f) => f.name),
    ["books"],
  );

  // And the relationship it names is already described by the `>` side, so
  // exactly one edge exists between Book and Author, not two.
  const edges = relationEdges(model);
  const between = edges.filter(
    (e) =>
      new Set([e.source, e.target]).size === 2 &&
      [e.source, e.target].includes("catalog.Author") &&
      [e.source, e.target].includes("catalog.Book"),
  );
  assert.equal(between.length, 1, `one edge Book↔Author, got ${between.length}`);
});

test("every edge connects two tables that are actually in the model", () => {
  const edges = relationEdges(fixture.model);
  const ids = new Set(fixture.model.tables.map((t) => tableId(t.namespace, t.name)));

  assert.equal(edges.length, 4, "Book→Author, Copy→Book, Loan→Member, Loan→Copy");
  for (const edge of edges) {
    assert.ok(ids.has(edge.source), `${edge.source} exists`);
    assert.ok(ids.has(edge.target), `${edge.target} exists`);
    // A line anchored to a row that is not drawn would float; `undefined`
    // is the documented fallback to the node's own handle.
    assert.ok(edge.sourceField === undefined || typeof edge.sourceField === "string");
  }

  const acrossFiles = edges.find((e) => e.id.startsWith("lending.Loan.copy"));
  assert.ok(acrossFiles, "the relation that crosses an import is drawn");
  assert.equal(acrossFiles.target, "catalog.Copy");
});

test("the Style cascade reaches a table through its class", () => {
  const styles = collectProjectStyles(fixture.styles, ROOT);
  const metas = fixture.metas.find((m) => m.path === "/workspace/catalog.skema");
  const author = metas?.tables.find((t) => t.name === "Author");

  assert.deepEqual(readStyleClasses(author?.entries), ["core"]);

  const resolved = resolveTableStyle(styles, "/workspace/catalog.skema", ["core"]);
  // From `Style @table` in the root file, project-scoped...
  assert.equal(resolved["headerBackgroundColor"], "#1f4e79");
  assert.equal(resolved["headerTextColor"], "white", "a CSS colour name is a colour");
  // ...and from the `core` class the table assigns itself.
  assert.equal(resolved["borderColor"], "#1f4e79");

  // But not its `borderWidth`. The reference model writes `3px`, and the
  // renderer's vocabulary for a width is `thin|medium|thick` - so the value
  // is dropped without a word, exactly as the catalog says it should be
  // ("a Style block is a hint about appearance, never a reason to fail").
  // The browser editor drops it too; `docs/13` still lists the Style
  // property catalog as unfinished, so whether a length should be legal
  // there is a language question, not a rendering one.
  assert.equal(resolved["borderWidth"], undefined);
});

test("a property that does not apply to a table is dropped without a word", () => {
  const styles = collectProjectStyles(fixture.styles, ROOT);
  // `historical` declares `backgroundColor`, which is a *group* property; a
  // table box paints its body with `bodyBackgroundColor`. The language
  // validates nothing here, so the renderer's catalog is the only gate.
  const resolved = resolveTableStyle(styles, "/workspace/lending.skema", ["historical"]);
  assert.ok(!("backgroundColor" in resolved));
  assert.equal(resolved["headerBackgroundColor"], "#1f4e79", "the selector still applies");
});

test("a table with no stored position has none, and one written in is read back", () => {
  const metas = fixture.metas.find((m) => m.path === "/workspace/lending.skema");
  const loan = metas?.tables.find((t) => t.name === "Loan");
  assert.ok(loan);
  assert.equal(readPosition(loan), undefined, "the reference model stores no layout");

  assert.deepEqual(
    readPosition({
      entries: [
        {
          key: "x-editorPosition",
          value: "120,-4",
          keyRange: { start: 0, end: 0 },
          valueRange: { start: 0, end: 0 },
          entryRange: { start: 0, end: 0 },
        },
      ],
    }),
    { x: 120, y: -4 },
  );
});

test("the diagnostics list is the shape the status bar renders", () => {
  assert.ok(Array.isArray(fixture.diagnostics));
  for (const diagnostic of fixture.diagnostics) {
    assert.ok(["error", "warning", "info", "hint"].includes(diagnostic.severity));
    assert.equal(typeof diagnostic.location.line, "number");
  }
});
