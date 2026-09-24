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
import type { MetaEntry } from "@skema/model";
import {
  collectProjectStyles,
  nodeData,
  readStyleClasses,
  relationEdges,
  resolveTableStyle,
  tableId,
} from "@skema/diagram";
import { useProject } from "../webview/store";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "model.json"), "utf8"),
) as ModelResponse;

const ROOT = "/workspace/project.skema";

/** A `Meta`/`Style` entry as the server reports one. The ranges are what an
 *  editor would edit at, and irrelevant to anything asserted here. */
function entry(key: string, value: string | undefined): MetaEntry {
  const nowhere = { start: 0, end: 0 };
  return {
    key,
    value,
    keyRange: nowhere,
    valueRange: value === undefined ? undefined : nowhere,
    entryRange: nowhere,
  };
}

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
  const edges = relationEdges(model);
  // ...but it creates no column (docs/07) and must not be drawn as one.
  const data = nodeData(author, {}, edges);
  assert.ok(!data.columns.some((f) => f.name === "books"));
  assert.deepEqual(
    data.backReferences.map((f) => f.name),
    ["books"],
  );

  // And the relationship it names is already described by the `>` side, so
  // exactly one edge exists between Book and Author, not two.
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
  // A length, which is how `docs/03` writes a border width in its own
  // example. A keywords-only catalog dropped this silently.
  assert.equal(resolved["borderWidth"], "3px");
});

test("a class that styles a table's background reaches it", () => {
  const styles = collectProjectStyles(fixture.styles, ROOT);
  // `docs/03` assigns exactly this class - `historisch { backgroundColor }` -
  // to a `Table` in its own example, so a table box has to honour it.
  const resolved = resolveTableStyle(styles, "/workspace/lending.skema", ["historical"]);
  assert.equal(resolved["backgroundColor"], "#f0f0f0");
  assert.equal(resolved["headerBackgroundColor"], "#1f4e79", "the selector still applies");
});

test("an unrecognized property or value is still dropped without a word", () => {
  // The gate is narrower than CSS on purpose: a `Style` block is a hint
  // about appearance, never a reason to fail, and never a way to hand the
  // renderer arbitrary CSS.
  const styles = collectProjectStyles(
    [
      {
        path: ROOT,
        blocks: [
          {
            scope: "project",
            selector: undefined,
            className: "odd",
            entries: [
              entry("borderWidth", "calc(1px + 2px)"),
              entry("borderColor", "rgba(0,0,0,0.5)"),
              entry("boxShadow", "0 0 4px black"),
              entry("borderStyle", "dashed"),
            ],
          },
        ],
      },
    ],
    ROOT,
  );

  const resolved = resolveTableStyle(styles, ROOT, ["odd"]);
  assert.equal(resolved["borderWidth"], undefined, "an expression is not a length");
  assert.equal(resolved["borderColor"], undefined, "alpha colours stay out");
  assert.equal(resolved["boxShadow"], undefined, "an unknown property is not a property");
  assert.equal(resolved["borderStyle"], "dashed", "the recognized one still lands");
});

test("the diagnostics list is the shape the status bar renders", () => {
  assert.ok(Array.isArray(fixture.diagnostics));
  for (const diagnostic of fixture.diagnostics) {
    assert.ok(["error", "warning", "info", "hint"].includes(diagnostic.severity));
    assert.equal(typeof diagnostic.location.line, "number");
  }
});
