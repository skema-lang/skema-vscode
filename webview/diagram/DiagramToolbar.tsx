/**
 * The view options that sit on the canvas: how lines are routed, and whether
 * a dragged table snaps to the grid.
 *
 * Both write through to VSCode's settings (see `preferences.ts`), so the
 * choice outlives the panel and can equally be made in the settings UI.
 */
import { Panel } from "@xyflow/react";
import type { JSX } from "react";

import { EDGE_ROUTINGS, usePreferences, type EdgeRouting } from "../preferences";

export function DiagramToolbar(): JSX.Element {
  const edgeRouting = usePreferences((s) => s.edgeRouting);
  const setEdgeRouting = usePreferences((s) => s.setEdgeRouting);
  const snapToGrid = usePreferences((s) => s.snapToGrid);
  const setSnapToGrid = usePreferences((s) => s.setSnapToGrid);

  return (
    <Panel position="top-right" className="toolbar">
      <div className="toolbar__group" role="group" aria-label="Line routing">
        {EDGE_ROUTINGS.map((routing) => (
          <button
            key={routing.value}
            type="button"
            className={
              routing.value === edgeRouting ? "toolbar__option is-active" : "toolbar__option"
            }
            aria-pressed={routing.value === edgeRouting}
            onClick={() => setEdgeRouting(routing.value as EdgeRouting)}
          >
            {routing.label}
          </button>
        ))}
      </div>

      <label className="toolbar__switch">
        <input
          type="checkbox"
          checked={snapToGrid}
          onChange={(event) => setSnapToGrid(event.currentTarget.checked)}
        />
        Snap to grid
      </label>
    </Panel>
  );
}
