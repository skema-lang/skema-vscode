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

import { revealLocation, saveLayout } from "../host";
import { usePreferences } from "../preferences";
import { useProject } from "../store";
import { DetailCard } from "./DetailCard";
import { DiagramToolbar } from "./DiagramToolbar";
import {
  DiagramView,
  type DiagramChrome,
  type DiagramHost,
  type DiagramSource,
} from "@skema/diagram";

const chrome: DiagramChrome = { DetailCard, Toolbar: DiagramToolbar };

/**
 * The arrangement is applied here *and* sent out, unlike a document edit.
 *
 * A webview cannot write a file, so the round trip through the extension
 * takes a frame - and a drag that waited for it would snap back to where the
 * box started before landing where it was dropped. The cost is that a write
 * the extension could not carry out leaves the panel a step ahead of the
 * file until the next refresh reads it back.
 */
const host: DiagramHost = {
  saveLayout: (layout) => {
    useProject.getState().applyLayout(layout);
    saveLayout(layout);
  },
  revealLocation,
};

export function DiagramPane(): JSX.Element {
  const analysis = useProject((s) => s.analysis);
  const metas = useProject((s) => s.metas);
  const enumMetas = useProject((s) => s.enumMetas);
  const groupMetas = useProject((s) => s.groupMetas);
  const projectStyles = useProject((s) => s.projectStyles);
  const layout = useProject((s) => s.layout);

  const edgeRouting = usePreferences((s) => s.edgeRouting);
  const snapToGrid = usePreferences((s) => s.snapToGrid);
  const gridSize = usePreferences((s) => s.gridSize);

  const source = useMemo<DiagramSource | null>(
    () =>
      analysis
        ? { model: analysis.model, metas, enumMetas, groupMetas, projectStyles, layout }
        : null,
    [analysis, metas, enumMetas, groupMetas, projectStyles, layout],
  );

  const preferences = useMemo(
    () => ({ edgeRouting, snapToGrid, gridSize }),
    [edgeRouting, snapToGrid, gridSize],
  );

  return <DiagramView source={source} preferences={preferences} host={host} chrome={chrome} />;
}
