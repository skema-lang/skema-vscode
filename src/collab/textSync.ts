/**
 * Bidirectional sync between one `Y.Text` and one open document's text - the
 * role `y-codemirror.next` plays for `skema-editor`'s CodeMirror.
 *
 * Speaks only offsets and strings, never `vscode.TextDocument` or
 * `vscode.WorkspaceEdit`: this is the part of a Yjs↔editor binding that has
 * nothing to do with which editor, so it is exercised here without a
 * running Extension Host (`brain/decisions.md`, "Environment limits"). The
 * still-open question of *which* files a session shares
 * (`brain/tasks/20-vscode-live-text-coediting.md`) is deliberately not this
 * module's concern - whichever answer that gets, wiring one shared file to
 * one open document still needs exactly this.
 */
import type * as Y from "yjs";

/** `Y.YTextEvent["delta"]`'s own element type - re-declared instead of
 *  imported because Yjs exposes it only as the getter's inline return type,
 *  not a named export. */
type YTextDeltaOp = Y.YTextEvent["delta"][number];

/** Replaces `[start, end)` with `text` - the same shape both directions
 *  produce: a VSCode content-change event already comes this way
 *  (`rangeOffset`/`rangeLength`/`text`), and so does one run out of a
 *  `Y.Text` delta ({@link editsFromDelta}). */
export interface OffsetEdit {
  start: number;
  end: number;
  text: string;
}

/** Applies one already-minimal local edit onto `text`, inside `origin`'s
 *  transaction so a caller watching `doc.on("update", ...)` can tell its
 *  own write apart from a remote one (the same pattern `session.ts`
 *  already uses for the awareness/doc sync it does today). */
export function applyLocalChange(doc: Y.Doc, text: Y.Text, edit: OffsetEdit, origin: unknown): void {
  doc.transact(() => {
    if (edit.end > edit.start) text.delete(edit.start, edit.end - edit.start);
    if (edit.text.length > 0) text.insert(edit.start, edit.text);
  }, origin);
}

/** VSCode's own shape for one run of a content-change event - duck-typed
 *  rather than imported so this stays free of a `vscode` dependency. */
export interface ContentChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/**
 * Turns one `onDidChangeTextDocument` event's changes into {@link OffsetEdit}s
 * safe to apply one after another onto the same `Y.Text`.
 *
 * Every change's `rangeOffset`/`rangeLength` is reported against the
 * document as it stood *before* the whole event - true for a single
 * keystroke, and also for the several simultaneous changes a multi-cursor
 * edit produces. Applying them highest-offset-first means each edit lands
 * before anything below it has been touched, so an offset computed against
 * the pre-event document is still valid when its turn comes; the reverse
 * order would need every later offset re-adjusted by how much earlier ones
 * shifted the text.
 */
export function localEditsFromContentChanges(changes: readonly ContentChange[]): OffsetEdit[] {
  return changes
    .map((change) => ({
      start: change.rangeOffset,
      end: change.rangeOffset + change.rangeLength,
      text: change.text,
    }))
    .sort((a, b) => b.start - a.start);
}

/**
 * Turns a `Y.Text` delta into the minimal offset edits a `WorkspaceEdit`
 * needs - one edit per insert/delete run, not one per character. A
 * delete immediately followed by an insert at the same cursor (a typed-over
 * selection) becomes two adjacent edits rather than one replace; VSCode
 * applies a batch of edits against the pre-edit document regardless of
 * order, so two edits that only touch at a shared boundary are as valid as
 * one - simpler than detecting the merge case for no behavioural gain.
 *
 * A non-string `insert` (Quill's delta format also allows an embedded
 * object) never occurs for a `.skema` file's plain-text `Y.Text`, and is
 * skipped rather than trusted, since inserting `String(embed)` would silently
 * corrupt the document instead of failing loudly.
 */
export function editsFromDelta(delta: YTextDeltaOp[]): OffsetEdit[] {
  const edits: OffsetEdit[] = [];
  let cursor = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      cursor += op.retain;
    } else if (op.delete !== undefined) {
      edits.push({ start: cursor, end: cursor + op.delete, text: "" });
      cursor += op.delete;
    } else if (typeof op.insert === "string") {
      edits.push({ start: cursor, end: cursor, text: op.insert });
    }
  }
  return edits;
}
