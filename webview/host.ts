/**
 * The only way out of the webview.
 *
 * A webview is a sandboxed iframe: it cannot open a document, cannot edit
 * one, and cannot speak LSP. Everything it wants done leaves through
 * `postMessage` and is carried out by the extension, which is what makes a
 * dragged table land in VSCode's undo history like any other edit rather
 * than as a write behind the editor's back.
 *
 * The diagram calls the same functions the browser editor's diagram calls
 * (`revealLocation`, `revealTable`, `revealField`, `saveLayout`), with the
 * same signatures, so the view itself does not know which host it is
 * running in.
 */
import type {
  DiagramLayout,
  DiagramPreferences,
  HostMessage,
  Position,
  WebviewMessage,
} from "../shared/protocol";
import type { ExportedField, ExportedTable, Location } from "@skema/model";

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

/** Records the arrangement after a gesture. Fire-and-forget: the extension
 *  writes the file and sends nothing back. */
export function saveLayout(layout: DiagramLayout): void {
  post({ type: "layout", layout });
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

/** This window's in-flight drag, forwarded to the extension's collaboration
 *  session (if one is active - the extension silently drops it otherwise). */
export function publishDrag(positions: Record<string, Position> | null): void {
  post({ type: "publishDrag", positions });
}

/** Subscribes to everything the extension pushes. */
export function onHostMessage(handle: (message: HostMessage) => void): () => void {
  const listener = (event: MessageEvent<HostMessage>): void => handle(event.data);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
