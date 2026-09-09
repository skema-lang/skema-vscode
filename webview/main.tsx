/**
 * The diagram panel: the model on the canvas, its state underneath.
 *
 * Everything below the shell is the browser editor's diagram, unchanged -
 * see `diagram/`. What differs is where its inputs come from: there a WASM
 * analysis in the page, here the language server through the extension.
 */
import { StrictMode, useEffect, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";

import type { Diagnostic } from "../shared/skema";
import { DiagramView } from "./diagram/DiagramView";
import { announceReady, onHostMessage, revealLocation } from "./host";
import { usePreferences } from "./preferences";
import { useProject } from "./store";
import "@xyflow/react/dist/style.css";
import "./styles.css";

/**
 * What the model is, and what is wrong with it - the diagram's own status
 * line, mirroring the editor's.
 *
 * Diagnostics also reach VSCode's Problems panel through ordinary LSP; this
 * repeats the first one because a diagram open next to the text is often the
 * only thing on screen, and a model that silently stopped updating because
 * of a parse error would otherwise look like a bug in the diagram.
 */
function StatusBar({ status }: { status: string | null }): JSX.Element {
  const diagnostics = useProject((s) => s.diagnostics);
  const isOwnRoot = useProject((s) => s.isOwnRoot);
  const tables = useProject((s) => s.analysis?.model.tables.length ?? 0);

  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  const first: Diagnostic | undefined = errors[0] ?? warnings[0];

  return (
    <footer className="status-bar">
      <span>
        {tables} {tables === 1 ? "table" : "tables"}
      </span>
      {isOwnRoot ? (
        <span
          className="status-bar__warn"
          title="No file declaring a Project block imports this one, so it is checked without mode and dialect (docs/02)."
        >
          no Project block reaches this file
        </span>
      ) : null}
      {first ? (
        <button
          type="button"
          className={errors.length > 0 ? "status-bar__error" : "status-bar__warn"}
          onClick={() => revealLocation(first.location)}
          title="Go to this diagnostic"
        >
          {errors.length > 0 ? `${errors.length} error` : `${warnings.length} warning`}
          {(errors.length > 0 ? errors.length : warnings.length) === 1 ? "" : "s"}:{" "}
          {first.message}
        </button>
      ) : (
        <span className="status-bar__ok">no problems</span>
      )}
      {status ? <span className="status-bar__status">{status}</span> : null}
    </footer>
  );
}

function App(): JSX.Element {
  const applyModel = useProject((s) => s.applyModel);
  const applyPreferences = usePreferences((s) => s.apply);
  const [status, setStatus] = useState<string | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const stop = onHostMessage((message) => {
      switch (message.type) {
        case "model":
          applyModel(message.model);
          setSeen(true);
          setStatus(null);
          break;
        case "preferences":
          applyPreferences(message.preferences);
          break;
        case "status":
          setStatus(message.message);
          break;
      }
    });
    // Only now is the listener attached - announcing earlier would race the
    // first model straight past it.
    announceReady();
    return stop;
  }, [applyModel, applyPreferences]);

  return (
    <div className="shell">
      <div className="canvas">
        {seen ? <DiagramView /> : <div className="diagram-empty">Waiting for the model…</div>}
      </div>
      <StatusBar status={status} />
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
