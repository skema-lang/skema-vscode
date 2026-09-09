/**
 * Which `skema-lsp` gets run.
 *
 * The order matters more than it looks: someone who set `skema.serverPath`
 * is almost always testing a server they just built, and an extension that
 * quietly ran a different one instead would send them debugging the wrong
 * binary.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ServerNotFound, resolveServer } from "../src/server";
import { settings } from "./vscode-stub";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "skemavscode-"));
}

function executable(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

function context(extensionRoot: string) {
  return {
    asAbsolutePath: (relative: string) => join(extensionRoot, relative),
  } as never;
}

test("an explicitly configured path wins over everything else", () => {
  const root = scratch();
  executable(join(root, "server"), "skema-lsp");
  const configured = executable(scratch(), "skema-lsp");

  settings.set("skema.serverPath", configured);
  try {
    const resolved = resolveServer(context(root));
    assert.equal(resolved.command, configured);
    assert.equal(resolved.origin, "skema.serverPath");
  } finally {
    settings.clear();
  }
});

test("a configured path that is not there is an error, not a fallback", () => {
  const root = scratch();
  // A perfectly good bundled binary exists - and must still not be used.
  executable(join(root, "server"), "skema-lsp");

  settings.set("skema.serverPath", join(scratch(), "gone"));
  try {
    assert.throws(() => resolveServer(context(root)), ServerNotFound);
  } finally {
    settings.clear();
  }
});

test("the bundled binary is used when nothing is configured", () => {
  const root = scratch();
  const bundled = executable(join(root, "server"), "skema-lsp");
  const resolved = resolveServer(context(root));
  assert.equal(resolved.command, bundled);
  assert.equal(resolved.origin, "bundled with the extension");
});

test("with no binary bundled it falls back to PATH", () => {
  // The platform-neutral VSIX: no `server/` directory at all.
  const resolved = resolveServer(context(scratch()));
  assert.equal(resolved.command, "skema-lsp");
  assert.equal(resolved.origin, "PATH");
});
