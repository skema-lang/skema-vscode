import assert from "node:assert/strict";
import { test } from "node:test";

import { tokenFromText } from "@skema/collab-protocol";

import { editorInviteUrl } from "../src/collab/editorLink";

const DEFAULT_EDITOR_URL = "https://skema-language.gitlab.io/skema-editor/";

test("the default editor URL gets a collab fragment", () => {
  assert.equal(
    editorInviteUrl(DEFAULT_EDITOR_URL, "t"),
    "https://skema-language.gitlab.io/skema-editor/#collab=t",
  );
});

test("an existing query is kept, an existing fragment is replaced", () => {
  assert.equal(
    editorInviteUrl("https://example.com/editor/?ref=x#old", "t"),
    "https://example.com/editor/?ref=x#collab=t",
  );
});

test("a URL without a trailing slash still works", () => {
  assert.equal(editorInviteUrl("https://example.com/editor", "t"), "https://example.com/editor#collab=t");
});

test("a javascript: URL is rejected", () => {
  assert.throws(() => editorInviteUrl("javascript:alert(1)", "t"), /http\(s\)/);
});

test("a file: URL is rejected", () => {
  assert.throws(() => editorInviteUrl("file:///etc/passwd", "t"), /http\(s\)/);
});

test("tokenFromText recovers the token round-tripped through editorInviteUrl", () => {
  const token = "abcXYZ_-123";
  assert.equal(tokenFromText(editorInviteUrl(DEFAULT_EDITOR_URL, token)), token);
});
