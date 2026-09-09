/**
 * The only way out of the webview.
 *
 * A webview is a sandboxed iframe: it cannot open a document, cannot edit
 * one, and cannot speak LSP. Everything it wants done leaves through
 * `postMessage` and is carried out by the extension, which is what makes a
 * dragged table land in VSCode's undo history like any other edit rather
 * than as a write behind the editor's back.
 *
 * The diagram calls the same three functions the browser editor's diagram
 * calls (`revealLocation`, `revealTable`, `revealField`,
 * `applyPositionEdit`), with the same signatures, so the view itself does
 * not know which host it is running in.
 */
import type {
  DeclKind,
  DiagramPreferences,
  HostMessage,
  WebviewMessage,
} from "../shared/protocol";
import type { ExportedField, ExportedTable, Location } from "../shared/skema";

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

/** Opens the file and selects the range - the extension's job, not ours. */
export function revealLocation(location: Location): void {
  post({ type: "reveal", location });
}

export function revealTable(table: ExportedTable): void {
  if (table.location) revealLocation(table.location);
}

export function revealField(field: ExportedField): void {
  if (field.location) revealLocation(field.location);
}

/**
 * Records a dragged position.
 *
 * Deliberately fire-and-forget, and deliberately *not* accompanied by a
 * local model update: the extension asks the server for the edit, applies
 * it, and the resulting document change comes back as a fresh model. The
 * diagram therefore never holds a position the file does not have - the one
 * failure mode a write-then-assume design has.
 */
export function applyPositionEdit(
  file: string,
  name: string,
  position: { x: number; y: number },
  kind: DeclKind = "table",
): void {
  post({ type: "position", file, kind, name, x: position.x, y: position.y });
}

export function setPreference<K extends keyof DiagramPreferences>(
  key: K,
  value: DiagramPreferences[K],
): void {
  post({ type: "setPreference", key, value });
}

export function announceReady(): void {
  post({ type: "ready" });
}

/** Subscribes to everything the extension pushes. */
export function onHostMessage(handle: (message: HostMessage) => void): () => void {
  const listener = (event: MessageEvent<HostMessage>): void => handle(event.data);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
