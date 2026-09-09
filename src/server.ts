/**
 * Finding the `skema-lsp` binary.
 *
 * Three sources, in this order, because they answer three different
 * situations:
 *
 * 1. **`skema.serverPath`** - someone working on the language itself,
 *    pointing the extension at `target/debug/skema-lsp`. It wins outright,
 *    and a path that is not there is an error rather than a silent fallback:
 *    quietly running a different server than the one asked for is how an
 *    afternoon disappears.
 * 2. **The bundled binary**, fetched at packaging time into `server/` for
 *    this platform (`npm run fetch:server`). The normal case for a user, who
 *    should not have to install anything.
 * 3. **`skema-lsp` on `PATH`** - a `cargo install`ed one, and the fallback
 *    that keeps the extension usable when it was built without a binary,
 *    which is exactly what a platform-neutral VSIX is.
 */
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

export interface ServerLocation {
  command: string;
  /** How it was found - shown in the output channel, so a surprising server
   *  is visible rather than mysterious. */
  origin: string;
}

export class ServerNotFound extends Error {}

export function resolveServer(context: vscode.ExtensionContext): ServerLocation {
  const configured = vscode
    .workspace.getConfiguration("skema")
    .get<string>("serverPath", "")
    .trim();

  if (configured) {
    if (!isExecutable(configured)) {
      throw new ServerNotFound(
        `skema.serverPath points at ${configured}, which is not an executable file.`,
      );
    }
    return { command: configured, origin: "skema.serverPath" };
  }

  const bundled = context.asAbsolutePath(join("server", binaryName()));
  if (isExecutable(bundled)) {
    return { command: bundled, origin: "bundled with the extension" };
  }

  // Not verified here: resolving a bare name against `PATH` is the spawner's
  // job, and duplicating that lookup would only get it subtly wrong. If it
  // is not there either, the client reports the spawn failure.
  return { command: binaryName(), origin: "PATH" };
}

function binaryName(): string {
  return process.platform === "win32" ? "skema-lsp.exe" : "skema-lsp";
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
