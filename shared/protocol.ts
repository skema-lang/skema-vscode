/**
 * What crosses the two boundaries this extension has.
 *
 * 1. **Extension ↔ language server**, over LSP. Three requests LSP has no
 *    word for, all namespaced `skema/` and all defined in
 *    `skema-lang/crates/skema-lsp/src/protocol.rs`. Their payloads are
 *    `skema-api`'s own structures, which is why the types below are built
 *    from the generated `skema.d.ts` rather than described a second time.
 * 2. **Extension ↔ diagram webview**, over `postMessage`. A webview cannot
 *    speak LSP or touch a document, so every model update arrives as a
 *    message and every edit leaves as one.
 *
 * The webview is deliberately kept unable to edit anything itself: it says
 * *what* was dragged, and the extension turns that into a `WorkspaceEdit`,
 * which is what puts a drag into VSCode's own undo history.
 */
import type { Diagnostic, EnumMeta, ExportedModel, GroupMeta, Location, TableMeta } from "./skema";
// The payload types the diagram already defines are reused rather than
// restated: `skema/model` exists to feed the diagram, so a second
// description of the same shape could only ever drift from it. Both modules
// are free of React, so importing them here does not pull a UI framework
// into the extension host.
import type { FileStyles } from "../webview/diagram/style";
import type { DeclKind, DiagramPreferences } from "../webview/diagram/types";

export type { DeclKind, DiagramPreferences, FileStyles };

// ---------------------------------------------------------------- LSP side

export const MODEL_REQUEST = "skema/model";
export const POSITION_EDIT_REQUEST = "skema/positionEdit";
export const MODEL_CHANGED_NOTIFICATION = "skema/modelChanged";

export interface ProjectFileRef {
  uri: string;
  /** The same string the model's `file` fields use. */
  path: string;
}

export interface FileMetas {
  path: string;
  tables: TableMeta[];
  enums: EnumMeta[];
  groups: GroupMeta[];
}

export interface ModelResponse {
  rootUri: string | null;
  /** No `Project`-declaring file reaches this one, so it was analyzed as its
   *  own root and lacks `mode`/`dialect` (`docs/02`). Worth showing rather
   *  than letting the model look quietly under-checked. */
  isOwnRoot: boolean;
  files: ProjectFileRef[];
  model: ExportedModel;
  diagnostics: Diagnostic[];
  metas: FileMetas[];
  styles: FileStyles[];
}

export interface PositionEditParams {
  uri: string;
  kind: DeclKind;
  name: string;
  x: number;
  y: number;
}

export interface PositionEditResponse {
  /** `null` when the file declares no such thing - a stale diagram after a
   *  rename, not an error. */
  edit: { range: LspRange; newText: string } | null;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

// ------------------------------------------------------------ webview side

/** Extension → webview. */
export type HostMessage =
  | { type: "model"; model: ModelResponse }
  | { type: "preferences"; preferences: DiagramPreferences }
  | { type: "status"; message: string };

/** Webview → extension. */
export type WebviewMessage =
  | { type: "ready" }
  | {
      /** The toolbar changing a view option. It goes to VSCode's own
       *  settings rather than to webview state, so it survives closing the
       *  panel and is editable where every other setting is. */
      type: "setPreference";
      key: keyof DiagramPreferences;
      value: DiagramPreferences[keyof DiagramPreferences];
    }
  | { type: "reveal"; location: Location }
  | {
      type: "position";
      /** The file declaring `name` - not necessarily the open one. */
      file: string;
      kind: DeclKind;
      name: string;
      x: number;
      y: number;
    };
