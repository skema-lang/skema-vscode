/**
 * What crosses the two boundaries this extension has.
 *
 * 1. **Extension ↔ language server**, over LSP. Two requests LSP has no
 *    word for, both namespaced `skema/` and both defined in
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
import type { Diagnostic, EnumMeta, ExportedModel, GroupMeta, Location, TableMeta } from "@skema/model";
// The payload types the diagram already defines are reused rather than
// restated: `skema/model` exists to feed the diagram, so a second
// description of the same shape could only ever drift from it. Both modules
// are free of React, so importing them here does not pull a UI framework
// into the extension host.
import type {
  DiagramLayout,
  DiagramPreferences,
  FileStyles,
  Position,
  RemoteDrag,
} from "@skema/diagram";

export type { DiagramLayout, DiagramPreferences, FileStyles, Position, RemoteDrag };

// ---------------------------------------------------------------- LSP side

export const MODEL_REQUEST = "skema/model";
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

// ------------------------------------------------------------ webview side

/** Extension → webview. */
export type HostMessage =
  | { type: "model"; model: ModelResponse }
  | { type: "layout"; layout: DiagramLayout }
  | { type: "preferences"; preferences: DiagramPreferences }
  | { type: "status"; message: string }
  | {
      /** Everyone else's in-flight drag, from the extension host's
       *  collaboration session (`src/collab/session.ts`) - the webview
       *  never touches Yjs/awareness directly, per the CSP boundary. */
      type: "presence";
      remoteDrags: RemoteDrag[];
    };

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
      /** The arrangement after a gesture, whole. It lands in a file beside
       *  the model rather than in any `.skema` source. */
      type: "layout";
      layout: DiagramLayout;
    }
  | {
      /** This window's own in-flight drag; `null` ends it. Forwarded to the
       *  collaboration session's awareness, if one is active. */
      type: "publishDrag";
      positions: Record<string, Position> | null;
    };
