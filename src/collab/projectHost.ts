/**
 * The `vscode`-touching half of task 20's whole-project seeding: asking the
 * language server which files the current project's import graph reaches,
 * reading each one's live content, and writing an adopted project back to
 * real files. `projectSync.ts` keeps the Yjs side of this free of `vscode`;
 * this is the part that cannot be.
 */
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { MODEL_REQUEST, type ModelResponse } from "../../shared/protocol";
import { relativePath } from "./projectPaths";
import type { ProjectFile } from "./projectSync";

export interface HostProject {
  /** The project root's own absolute URI, so a caller can key
   *  newly-opened documents against it (`textBinding.ts`) without
   *  depending on a second, independently-timed fetch of the same model. */
  rootUri: string;
  rootPath: string;
  files: ProjectFile[];
}

/**
 * `undefined` when the language server has no project for `subject` yet, or
 * when it has no elected root (`rootUri: null` - a file no `Project` block
 * reaches is analyzed as its own root, per `docs/02`, and there is nothing
 * to key the rest of the project against).
 */
export async function readHostProject(
  client: LanguageClient,
  subject: vscode.Uri,
): Promise<HostProject | undefined> {
  const model = await client.sendRequest<ModelResponse | null>(MODEL_REQUEST, {
    uri: subject.toString(),
  });
  if (!model?.rootUri) return undefined;
  const rootPath = relativePath(model.rootUri, model.rootUri);
  if (!rootPath) return undefined;

  const files: ProjectFile[] = [];
  for (const file of model.files) {
    const path = relativePath(model.rootUri, file.uri);
    if (!path) continue;
    // The unsaved buffer, if the file is open - the same source
    // `skema-loader::load_with` prefers on the server side.
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(file.uri));
    files.push({ path, text: document.getText() });
  }
  return { rootUri: model.rootUri, rootPath, files };
}

/**
 * Guest side: writes an adopted project to real files under the open
 * workspace folder, mirroring `skema-editor`'s own guest-side `adopt()`
 * (`skema-editor/src/collab/projectBinding.ts`) - unconditional and without
 * a prompt, the same accepted risk recorded for that side
 * (brain/decisions.md, "Collaboration across hosts").
 *
 * A one-time bootstrap, not an edit a user would want to undo, so this
 * writes directly rather than through a `WorkspaceEdit` - `writeLayout` in
 * `diagram/panel.ts` is the case that does need undo, this is not it.
 */
export async function writeProjectToDisk(folder: vscode.Uri, files: ProjectFile[]): Promise<void> {
  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment.length > 0);
    const uri = vscode.Uri.joinPath(folder, ...segments);
    if (segments.length > 1) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
    }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(file.text));
  }
}
