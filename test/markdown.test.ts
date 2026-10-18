/**
 * `modelToMarkdown` against the same captured `skema/model` response
 * `model.test.ts` uses - see that file's module doc for where it comes
 * from and why it, not a hand-written model, is the fixture.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { modelToMarkdown } from "@skema/docs";
import type { ExportedModel } from "@skema/model";
import type { ModelResponse } from "../shared/protocol";
import { getNoteFrom } from "../src/docs/notes";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "model.json"), "utf8"),
) as ModelResponse;

const markdown = modelToMarkdown(fixture.model, getNoteFrom(fixture.metas));

test("tables are grouped under their document namespace", () => {
  assert.match(markdown, /## catalog/);
  assert.match(markdown, /## lending/);
  assert.match(markdown, /### Author/);
});

test("a table's note comes from its Meta block, not the model", () => {
  // `Author` carries no `note` field of its own in `ExportedTable` - this
  // text exists only in the fixture's `metas`, which is the whole reason
  // `modelToMarkdown` takes both arguments.
  assert.match(markdown, /Creator of a work/);
  assert.match(markdown, /A loan transaction\. returned_at empty = still ongoing\./);
});

test("a back-reference is listed separately, not as a column", () => {
  const authorSection = markdown.slice(markdown.indexOf("### Author"), markdown.indexOf("### Book"));
  assert.doesNotMatch(
    authorSection,
    /\| `books` \|/,
    "a back-reference must not appear in the column table",
  );
  assert.match(authorSection, /\*\*Referenced by\*\*/);
  assert.match(authorSection, /- `books` - Book\.author/);
});

test("an ordinary column carries its type and flags", () => {
  const authorSection = markdown.slice(markdown.indexOf("### Author"), markdown.indexOf("### Book"));
  assert.match(authorSection, /\| `name` \| `varchar\(120\)` \| required \| {2}\|/);
});

test("enums list their entries with the stored value", () => {
  const enumSection = markdown.slice(markdown.indexOf("## Enums"));
  assert.match(enumSection, /### CopyState/);
  assert.match(enumSection, /\| `lost` \| Lost \| `X` \|/);
  // No explicit `value` falls back to the entry's own name.
  assert.match(enumSection, /\| `available` \| Available \| `available` \|/);
});

test("groups list their members, qualified", () => {
  const groupSection = markdown.slice(markdown.indexOf("## Groups"));
  assert.match(groupSection, /### Catalog/);
  assert.match(groupSection, /- Table `catalog\.Author`/);
});

test("an empty model says so instead of rendering nothing", () => {
  // Asserted: in an @skema/model without `documents`/`datatypes` these are excess keys.
  const emptyModel = {
    tables: [],
    enums: [],
    groups: [],
    documents: [],
    datatypes: [],
    dialect: undefined,
  } as ExportedModel;
  const empty = modelToMarkdown(emptyModel, () => undefined);
  assert.match(empty, /Nothing to document yet/);
});
