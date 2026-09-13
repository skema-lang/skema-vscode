/**
 * Seeding and adopting the shared project map: task 20's host/guest
 * whole-project logic on top of `@skema/collab-protocol`'s `projectMap.ts`
 * shape (`sharedFiles`/`sharedMeta`/`ROOT_PATH_KEY`,
 * [brain/tasks/21](../../../../brain/tasks/21-extract-shared-project-map-shape.md)),
 * the same one `skema-editor/src/collab/projectBinding.ts` uses - it is the
 * same `Y.Doc` a browser guest reads.
 *
 * Deliberately free of `vscode`: reading a document's live text and writing
 * one to disk are host-specific (`textBinding.ts`, `extension.ts`), but
 * turning that content into the shared map - and back - is not.
 */
import * as Y from "yjs";

import { ROOT_PATH_KEY, sharedFiles, sharedMeta } from "@skema/collab-protocol";

export interface ProjectFile {
  /** The root-relative key both hosts key this file by
   *  (`projectPaths.ts`'s `relativePath`). */
  path: string;
  text: string;
}

/**
 * Host side: writes the whole project into the shared document, so a guest
 * that syncs afterwards receives every file the root's import graph
 * reaches - not only the one open in the active editor
 * (brain/tasks/20's "Done when", second bullet).
 */
export function seedProject(doc: Y.Doc, rootPath: string, files: ProjectFile[]): void {
  const shared = sharedFiles(doc);
  const meta = sharedMeta(doc);
  doc.transact(() => {
    for (const file of files) shared.set(file.path, new Y.Text(file.text));
    meta.set(ROOT_PATH_KEY, rootPath);
  });
}

export interface AdoptedProject {
  /** The key of the file to open once adopted - `undefined` only if the
   *  host has not seeded a root yet. */
  rootPath: string | undefined;
  files: ProjectFile[];
}

/** Guest side: reads what a host has seeded, to write to real files
 *  (`textBinding.ts`'s `writeProjectToDisk`). */
export function adoptProject(doc: Y.Doc): AdoptedProject {
  const shared = sharedFiles(doc);
  return {
    rootPath: sharedMeta(doc).get(ROOT_PATH_KEY),
    files: [...shared.entries()].map(([path, text]) => ({ path, text: text.toString() })),
  };
}
