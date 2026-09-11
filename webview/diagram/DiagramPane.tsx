/**
 * The extension's wiring of the shared diagram.
 *
 * The counterpart of the browser editor's `DiagramPane`, and the whole
 * reason the diagram takes a host: there the model comes from a WASM
 * analysis in the page and a drag is written straight into CodeMirror; here
 * the model arrives from the language server and a drag leaves as a
 * `postMessage`, because a webview owns no documents and can edit nothing.
 * `DiagramView` is the same code in both.
 */
import { useMemo, type JSX } from "react";

import { applyPositionEdit, revealLocation } from "../host";
import { usePreferences } from "../preferences";
import { useProject } from "../store";
import { DetailCard } from "./DetailCard";
import { DiagramToolbar } from "./DiagramToolbar";
import { DiagramView } from "./DiagramView";
import type { DiagramChrome, DiagramHost, DiagramSource } from "./types";

const chrome: DiagramChrome = { DetailCard, Toolbar: DiagramToolbar };

/** Fire-and-forget, and deliberately without a local model update: the
 *  extension asks the server for the edit, applies it, and the resulting
 *  document change comes back as a fresh model. The diagram therefore never
 *  holds a position the file does not have. */
const host: DiagramHost = {
  rememberLayout: (positions) => useProject.getState().rememberLayout(positions),
  applyPositionEdit: (file, name, position, kind) =>
    applyPositionEdit(file, name, position, kind),
  revealLocation,
};

export function DiagramPane(): JSX.Element {
  const analysis = useProject((s) => s.analysis);
  const metas = useProject((s) => s.metas);
  const enumMetas = useProject((s) => s.enumMetas);
  const projectStyles = useProject((s) => s.projectStyles);
  const layout = useProject((s) => s.layout);

  const edgeRouting = usePreferences((s) => s.edgeRouting);
  const snapToGrid = usePreferences((s) => s.snapToGrid);
  const gridSize = usePreferences((s) => s.gridSize);
  const autoSavePositions = usePreferences((s) => s.autoSavePositions);

  const source = useMemo<DiagramSource | null>(
    () => (analysis ? { model: analysis.model, metas, enumMetas, projectStyles, layout } : null),
    [analysis, metas, enumMetas, projectStyles, layout],
  );

  const preferences = useMemo(
    () => ({ edgeRouting, snapToGrid, gridSize, autoSavePositions }),
    [edgeRouting, snapToGrid, gridSize, autoSavePositions],
  );

  return <DiagramView source={source} preferences={preferences} host={host} chrome={chrome} />;
}
