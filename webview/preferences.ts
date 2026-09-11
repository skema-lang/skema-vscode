/**
 * How the diagram is drawn, not what it contains.
 *
 * Deliberately separate from the model store, and deliberately *not* stored
 * in the webview: these are VSCode settings (`skema.diagram.*`). The panel
 * is closed and reopened often, and a view option that survived only as long
 * as the panel would be a setting that forgets itself. The toolbar therefore
 * writes through the extension into the workspace configuration, which sends
 * the new value straight back here - so what the toolbar shows is always what
 * the settings say, including when they are edited in the settings UI.
 *
 * Line routing is a view option on purpose, unlike a table's position. A
 * position is a decision worth writing into the model the moment it moves;
 * how a line is drawn is adjusted while hunting for a readable layout, and
 * writing that to the source on every change would churn the file for
 * nothing.
 */
import { create } from "zustand";

// Which routings exist is the diagram's business - this store only records
// which one the settings picked.
import { EDGE_ROUTINGS, type DiagramPreferences, type EdgeRouting } from "./diagram/types";
import { setPreference } from "./host";

export { EDGE_ROUTINGS };
export type { EdgeRouting };

export interface PreferencesState extends DiagramPreferences {
  /** Applies what the extension read from the settings. */
  apply: (preferences: DiagramPreferences) => void;
  setEdgeRouting: (routing: EdgeRouting) => void;
  setSnapToGrid: (snap: boolean) => void;
  setAutoSavePositions: (autoSave: boolean) => void;
}

export const usePreferences = create<PreferencesState>((set) => ({
  edgeRouting: "smoothstep",
  snapToGrid: false,
  gridSize: 16,
  autoSavePositions: false,

  apply: (preferences) => set(preferences),

  // Optimistic locally so the control responds at once, then confirmed by
  // the settings change coming back.
  setEdgeRouting: (edgeRouting) => {
    set({ edgeRouting });
    setPreference("edgeRouting", edgeRouting);
  },
  setSnapToGrid: (snapToGrid) => {
    set({ snapToGrid });
    setPreference("snapToGrid", snapToGrid);
  },
  setAutoSavePositions: (autoSavePositions) => {
    set({ autoSavePositions });
    setPreference("autoSavePositions", autoSavePositions);
  },
}));
