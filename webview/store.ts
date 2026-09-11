/**
 * The model the diagram draws, as the extension last pushed it.
 *
 * The browser editor's equivalent owns the project: it holds every file's
 * text, re-analyzes on a debounce, and persists to `localStorage`. Here the
 * workspace *is* the project, the language server owns the analysis, and the
 * files are VSCode's. So this store holds no text at all - only the answer
 * to "what does the model look like right now", refreshed whenever the
 * server says it moved.
 *
 * The field names match the editor's store on purpose: the diagram
 * components are the same code, and a rename would be a diff in every one of
 * them for nothing.
 */
import { create } from "zustand";

import type { ModelResponse } from "../shared/protocol";
import type { EnumMeta, ExportedModel, GroupMeta, TableMeta } from "@skema/model";
import {
  collectProjectStyles,
  emptyLayout,
  emptyProjectStyles,
  type DiagramLayout,
  type ProjectStyles,
} from "@skema/diagram";

export interface ProjectState {
  /** `null` until the first model arrives - the diagram shows "analyzing". */
  analysis: { model: ExportedModel } | null;
  /** Per file, the `Meta` blocks of its declarations: the source of every
   *  stored position. */
  metas: Record<string, TableMeta[]>;
  enumMetas: Record<string, EnumMeta[]>;
  groupMetas: Record<string, GroupMeta[]>;
  projectStyles: ProjectStyles;
  /** How the diagram is arranged, as the extension last read it out of
   *  `.skema/layout.json`. */
  layout: DiagramLayout;
  /** Which file declares which path - so a drag can name the file to edit. */
  uriOf: Record<string, string>;
  rootUri: string | null;
  isOwnRoot: boolean;
  diagnostics: ModelResponse["diagnostics"];

  /** Applies what the extension read from, or wrote to, the layout file. */
  applyLayout: (layout: DiagramLayout) => void;
  applyModel: (response: ModelResponse) => void;
}

export const useProject = create<ProjectState>((set, get) => ({
  analysis: null,
  metas: {},
  enumMetas: {},
  groupMetas: {},
  projectStyles: emptyProjectStyles(),
  layout: emptyLayout(),
  uriOf: {},
  rootUri: null,
  isOwnRoot: false,
  diagnostics: [],

  applyLayout: (layout) => set({ layout }),

  applyModel: (response) => {
    const byPath = <T,>(pick: (entry: ModelResponse["metas"][number]) => T): Record<string, T> =>
      Object.fromEntries(response.metas.map((entry) => [entry.path, pick(entry)]));

    // A different project's arrangement describes other tables; the
    // extension sends the new one right after this.
    const switchedProject = get().rootUri !== null && get().rootUri !== response.rootUri;

    set({
      analysis: { model: response.model },
      metas: byPath((entry) => entry.tables),
      enumMetas: byPath((entry) => entry.enums),
      groupMetas: byPath((entry) => entry.groups),
      projectStyles: collectProjectStyles(response.styles, rootPath(response)),
      uriOf: Object.fromEntries(response.files.map((file) => [file.path, file.uri])),
      rootUri: response.rootUri,
      isOwnRoot: response.isOwnRoot,
      diagnostics: response.diagnostics,
      ...(switchedProject ? { layout: emptyLayout() } : {}),
    });
  },
}));

/** The root's *path*, which is how the style cascade keys files - the URI is
 *  what the extension addresses them by. */
function rootPath(response: ModelResponse): string {
  const root = response.files.find((file) => file.uri === response.rootUri);
  return root?.path ?? "";
}
