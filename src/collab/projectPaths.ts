/**
 * Converts between `skema-lsp`'s absolute file URIs and the root-relative
 * keys `skema-editor`'s shared project map uses
 * (`skema-editor/src/collab/projectBinding.ts`, `sharedFiles`), so a
 * `skema-vscode` session and a browser guest address the same file with the
 * same key. Nothing today derives one from the other -
 * [brain/tasks/20](../../../../brain/tasks/20-vscode-live-text-coediting.md)
 * calls this out as new work.
 *
 * `ModelResponse.rootUri` (`shared/protocol.ts`) is the project's root
 * *file*, the same one `diagram/panel.ts` derives the layout file's
 * directory from - every other file's key is relative to its parent
 * directory.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";

function rootDirectory(rootUri: string): string {
  return path.dirname(fileURLToPath(rootUri));
}

/**
 * `undefined` if `fileUri` is not under the project's root directory. The
 * model only ever lists files the root's import graph reached, so this
 * should not happen - but a caller must not silently mis-key a file it
 * cannot place, so it is checked rather than assumed.
 */
export function relativePath(rootUri: string, fileUri: string): string | undefined {
  const relative = path.relative(rootDirectory(rootUri), fileURLToPath(fileUri));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

/** The inverse: where a shared key would live on disk, under this
 *  project's root directory. Used to write a guest's adopted project to
 *  real files (task 20's guest-side "Done when" bullet). */
export function absoluteUri(rootUri: string, relative: string): string {
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  return pathToFileURL(path.join(rootDirectory(rootUri), ...segments)).toString();
}
