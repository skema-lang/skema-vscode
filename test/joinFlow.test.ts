import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeInvite, tokenFromText, vscodeJoinUri, type Invite } from "@skema/collab-protocol";

import { confirmed, decideFolder, joinConfirmation, parseJoinInvite } from "../src/collab/joinFlow";

// tokenFromText, task 97's query-aware change.

test("tokenFromText reads a bare token", () => {
  assert.equal(tokenFromText("abcXYZ_-123"), "abcXYZ_-123");
});

test("tokenFromText reads an editor-style #collab= fragment", () => {
  assert.equal(tokenFromText("https://example.com/editor#collab=tok"), "tok");
});

test("tokenFromText reads a vscode-style ?collab= query", () => {
  assert.equal(tokenFromText("vscode://skema.skemavscode/join?collab=tok"), "tok");
});

test("tokenFromText reads collab= alongside another query parameter", () => {
  assert.equal(tokenFromText("vscode://skema.skemavscode/join?a=1&collab=tok"), "tok");
});

test("tokenFromText prefers the fragment when both a query and a fragment are present", () => {
  assert.equal(tokenFromText("https://example.com/?collab=wrong#collab=tok"), "tok");
});

test("tokenFromText rejects garbage", () => {
  assert.equal(tokenFromText("not a token at all!"), undefined);
  assert.equal(tokenFromText(""), undefined);
});

test("tokenFromText round-trips through vscodeJoinUri", () => {
  const token = "abcXYZ_-123";
  assert.equal(tokenFromText(vscodeJoinUri(token)), token);
});

// joinFlow: parseJoinInvite.

function autoToken(name = "Alex"): string {
  return encodeInvite({ kind: "auto", id: "room-1", name });
}

function offerToken(name = "Alex"): string {
  return encodeInvite({ kind: "offer", id: "peer-1", name, sdp: "v=0" });
}

function answerToken(name = "Alex"): string {
  return encodeInvite({ kind: "answer", id: "peer-1", name, sdp: "v=0" });
}

test("parseJoinInvite accepts an auto invite", () => {
  const invite = parseJoinInvite(autoToken("Alex")) as Invite;
  assert.equal(invite?.kind, "auto");
  assert.equal(invite?.name, "Alex");
});

test("parseJoinInvite accepts an offer invite", () => {
  const invite = parseJoinInvite(offerToken("Alex"));
  assert.equal(invite?.kind, "offer");
});

test("parseJoinInvite rejects an answer invite", () => {
  assert.equal(parseJoinInvite(answerToken()), undefined);
});

test("parseJoinInvite rejects garbage", () => {
  assert.equal(parseJoinInvite("not an invite"), undefined);
});

test("parseJoinInvite reads a vscode:// join link, not only a bare token", () => {
  const invite = parseJoinInvite(vscodeJoinUri(autoToken("Alex")));
  assert.equal(invite?.kind, "auto");
});

// joinFlow: decideFolder.

test("decideFolder uses the first open workspace folder", () => {
  assert.deepEqual(decideFolder(["/home/alex/project"]), { kind: "use", path: "/home/alex/project" });
});

test("decideFolder asks when no folder is open", () => {
  assert.deepEqual(decideFolder([]), { kind: "ask" });
});

// joinFlow: joinConfirmation.

test("with a folder open, the confirmation names it", () => {
  const { detail } = joinConfirmation("Alex", { kind: "use", path: "/home/alex/project" });
  assert.match(detail, /\/home\/alex\/project/);
});

test("with no folder, the confirmation says one will be chosen", () => {
  const { detail } = joinConfirmation("Alex", { kind: "ask" });
  assert.doesNotMatch(detail, /\//);
  assert.match(detail, /choose a folder/);
});

test("a long inviter name is truncated in the message", () => {
  const longName = "A".repeat(200);
  const { message } = joinConfirmation(longName, { kind: "ask" });
  assert.ok(message.length < longName.length);
  assert.match(message, /…/);
});

test("an odd inviter name (markup-like text) is carried as plain text, still truncated", () => {
  const oddName = `<script>${"x".repeat(100)}</script>`;
  const { message } = joinConfirmation(oddName, { kind: "ask" });
  assert.ok(message.length < oddName.length + 40);
});

// joinFlow: confirmed - cancelling the modal means no join.

test("confirmed is true only for the Join button", () => {
  assert.equal(confirmed("Join"), true);
});

test("cancelling the modal (no button, or a different one) means no join", () => {
  assert.equal(confirmed(undefined), false);
  assert.equal(confirmed("Cancel"), false);
});
