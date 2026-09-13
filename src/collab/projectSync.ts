/**
 * The shared project map: which files a co-editing session carries, keyed
 * the same way on both hosts.
 *
 * `FILES`/`META`/`ROOT` and this map's shape must match
 * `skema-editor/src/collab/projectBinding.ts`'s `sharedFiles(doc)` exactly -
 * it is the same `Y.Doc` a browser guest reads. Duplicated here rather than
 * imported because `skema-editor` is an app, not a published package;
 * [brain/tasks/21](../../../../brain/tasks/21-extract-shared-project-map-shape.md)
 * tracks moving it into `@skema/collab-protocol` so both hosts import one
 * definition instead of two that must be kept in sync by hand.
 *
 * Deliberately free of `vscode`: reading a document's live text and writing
 * one to disk are host-specific (`textBinding.ts`, `extension.ts`), but
 * turning that content into the shared map - and back - is not.
 */
import * as Y from "yjs";

const FILES = "files";
const META = "meta";
const ROOT = "rootPath";

export function sharedFiles(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>(FILES);
}

function sharedMeta(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>(META);
}

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
    meta.set(ROOT, rootPath);
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
    rootPath: sharedMeta(doc).get(ROOT),
    files: [...shared.entries()].map(([path, text]) => ({ path, text: text.toString() })),
  };
}
