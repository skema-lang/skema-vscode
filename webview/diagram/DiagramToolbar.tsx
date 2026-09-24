/**
 * The view options that sit on the canvas: how lines are routed, and whether
 * a dragged table snaps to the grid.
 *
 * Both write through to VSCode's settings (see `preferences.ts`), so the
 * choice outlives the panel and can equally be made in the settings UI.
 */
import { Panel } from "@xyflow/react";
import type { JSX } from "react";

import { useHiddenEdges } from "@skema/diagram";

import { EDGE_ROUTINGS, usePreferences, type EdgeRouting } from "../preferences";

export function DiagramToolbar(): JSX.Element {
  const edgeRouting = usePreferences((s) => s.edgeRouting);
  const setEdgeRouting = usePreferences((s) => s.setEdgeRouting);
  const snapToGrid = usePreferences((s) => s.snapToGrid);
  const setSnapToGrid = usePreferences((s) => s.setSnapToGrid);
  const { count: hiddenEdgeCount, showAll } = useHiddenEdges();

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

      {hiddenEdgeCount > 0 ? (
        <div className="toolbar__group">
          <button type="button" className="toolbar__option" onClick={showAll}>
            Show hidden lines ({hiddenEdgeCount})
          </button>
        </div>
      ) : null}
    </Panel>
  );
}
