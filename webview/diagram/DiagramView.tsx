/**
 * The diagram pane.
 *
 * Positions come from the source text (`x-editorPosition`); dragging a
 * table writes them back there, once, on drag stop - the drag itself is
 * React Flow's own state, so a gesture produces one edit rather than one
 * per animation frame. That write goes through the store's layout-only
 * path, which re-reads just that file's `Meta` offsets instead of
 * re-analyzing the project (`store.setLayoutContent`).
 *
 * Nodes are held in state rather than derived on every render: React Flow
 * reports selection, measured size and drag through the same change
 * stream, and a purely derived list throws all of that away - which is
 * what makes selection and multi-node dragging not work at all.
 *
 * A single click only selects. Opening the declaration is a double-click
 * (on the header, or on the row for a single field), because a click that
 * also scrolled the editor made picking several tables for a group drag
 * throw the text pane around on every step.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { Location } from "../../shared/skema";
import { DiagramContextProvider } from "./context";
import type {
  DiagramChrome,
  DiagramHost,
  DiagramPreferences,
  DiagramSource,
} from "./types";
import {
  edgeSides,
  nodeData,
  relationEdges,
  sourceHandleId,
  tableId,
  targetHandleId,
  type TableNodeData,
} from "./graph";
import { layoutGraph } from "./layout";
import { readPosition } from "./positions";
import { resolveTableStyle, readStyleClasses } from "./style";
import { NODE_WIDTH, TableNode, nodeHeight } from "./TableNode";

const nodeTypes = { table: TableNode };

export interface DiagramViewProps {
  /** `null` while the host has no analysis yet - the canvas says so. */
  source: DiagramSource | null;
  preferences: DiagramPreferences;
  host: DiagramHost;
  chrome: DiagramChrome;
}

function DiagramCanvas({ source, preferences, host, chrome }: DiagramViewProps): JSX.Element {
  const { rememberLayout, applyPositionEdit, revealLocation } = host;
  const { edgeRouting, snapToGrid, gridSize } = preferences;
  const Toolbar = chrome.Toolbar;

  const [nodes, setNodes] = useState<Node[]>([]);
  /** The same list, readable from a drag handler without making every
   *  handler depend on it. */
  const live = useRef<Node[]>([]);
  /** Ids being dragged right now: their position is the pointer's, not the
   *  model's, until the gesture ends. */
  const dragging = useRef<Set<string>>(new Set());

  /** The model's own view of the diagram, rebuilt only when the model or
   *  the stored positions actually change. */
  const model = useMemo(() => {
    if (!source) return null;
    const { model: exported, metas, projectStyles, layout } = source;

    const relations = relationEdges(exported);
    const data = new Map<string, TableNodeData>(
      exported.tables.map((table) => {
        const meta = metas[table.file]?.find((m) => m.name === table.name);
        const style = resolveTableStyle(
          projectStyles,
          table.file,
          readStyleClasses(meta?.entries),
        );
        return [tableId(table.namespace, table.name), nodeData(table, style)];
      }),
    );

    // Source position wins; then one from an earlier pass; only a table
    // seen for the first time is laid out - see layout.ts.
    const placed = new Map<string, { x: number; y: number }>();
    const unplaced: string[] = [];
    for (const table of exported.tables) {
      const id = tableId(table.namespace, table.name);
      const stored = readPosition(metas[table.file]?.find((m) => m.name === table.name));
      const known = stored ?? layout[id];
      if (known) placed.set(id, known);
      else unplaced.push(id);
    }

    if (unplaced.length > 0) {
      const computed = layoutGraph({
        ids: [...data.keys()],
        edges: relations,
        sizeOf: (id) => {
          const entry = data.get(id);
          return {
            width: NODE_WIDTH,
            height: entry ? nodeHeight(entry) : 120,
          };
        },
      });
      const fresh: Record<string, { x: number; y: number }> = {};
      for (const id of unplaced) {
        const position = computed.get(id) ?? { x: 0, y: 0 };
        placed.set(id, position);
        fresh[id] = position;
      }
      // Remembered so the next pass does not lay them out again.
      queueMicrotask(() => rememberLayout(fresh));
    }

    return { data, placed, relations };
  }, [source, rememberLayout]);

  // Reconcile the model into the live nodes: content and stored positions
  // come from the model, while selection, measured size and an in-flight
  // drag stay with the node that already exists.
  useEffect(() => {
    if (!model) {
      setNodes([]);
      return;
    }
    setNodes((current) => {
      const existing = new Map(current.map((node) => [node.id, node]));
      const next = [...model.data.entries()].map(([id, data]) => {
        const previous = existing.get(id);
        const position =
          previous && dragging.current.has(id)
            ? previous.position
            : (model.placed.get(id) ?? previous?.position ?? { x: 0, y: 0 });
        return {
          ...(previous ?? {}),
          id,
          type: "table",
          position,
          data: data as unknown as Record<string, unknown>,
        };
      });
      live.current = next;
      return next;
    });
  }, [model]);

  const edges = useMemo((): Edge[] => {
    if (!model) return [];
    // Sides are decided from where the nodes actually are, so a line always
    // leaves towards the other table instead of looping around its own.
    const positionOf = (id: string): { x: number } | undefined =>
      nodes.find((node) => node.id === id)?.position ?? model.placed.get(id);

    return model.relations.map((relation) => {
      const sides = edgeSides(positionOf(relation.source), positionOf(relation.target), NODE_WIDTH);
      return {
        id: relation.id,
        source: relation.source,
        target: relation.target,
        // A row's handle when the referenced field is drawn, the node's own
        // otherwise - see `relationEdges`.
        ...(relation.sourceField
          ? { sourceHandle: sourceHandleId(relation.sourceField, sides.source) }
          : {}),
        ...(relation.targetField
          ? { targetHandle: targetHandleId(relation.targetField, sides.target) }
          : {}),
        type: edgeRouting,
        label: relation.label,
        className: relation.oneToOne ? "edge-one-to-one" : "edge-one-to-many",
        data: { location: relation.location },
      };
    });
  }, [model, nodes, edgeRouting]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === "position") {
        if (change.dragging) dragging.current.add(change.id);
        else dragging.current.delete(change.id);
      }
    }
    setNodes((current) => {
      const next = applyNodeChanges(changes, current);
      live.current = next;
      return next;
    });
  }, []);

  /**
   * Dragging one table of a selection moves the whole selection.
   *
   * React Flow does this on its own only for a box-selection (the gesture
   * that produces its selection rectangle); after picking tables with
   * Shift-click, grabbing one of them would otherwise leave the rest
   * behind. The other members are moved by the same delta here, and their
   * ids are held in `dragging` so the reconciliation does not pull them
   * back to their stored positions mid-gesture.
   */
  const groupDrag = useRef<{ id: string; origin: XYPosition; others: Map<string, XYPosition> } | null>(
    null,
  );

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    const others = live.current.filter((other) => other.selected && other.id !== node.id);
    if (!node.selected || others.length === 0) {
      groupDrag.current = null;
      return;
    }
    for (const other of others) dragging.current.add(other.id);
    groupDrag.current = {
      id: node.id,
      origin: { ...node.position },
      others: new Map(others.map((other) => [other.id, { ...other.position }])),
    };
  }, []);

  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    const group = groupDrag.current;
    if (!group || group.id !== node.id) return;
    const dx = node.position.x - group.origin.x;
    const dy = node.position.y - group.origin.y;
    setNodes((current) => {
      const next = current.map((other) => {
        const from = group.others.get(other.id);
        return from ? { ...other, position: { x: from.x + dx, y: from.y + dy } } : other;
      });
      live.current = next;
      return next;
    });
  }, []);

  /** One write per table that actually moved, whether one was dragged or a
   *  whole selection was. */
  const persistPositions = useCallback(
    (moved: Node[]) => {
      for (const node of moved) {
        dragging.current.delete(node.id);
        const data = node.data as unknown as TableNodeData;
        applyPositionEdit(data.table.file, data.table.name, node.position, "table");
      }
    },
    [applyPositionEdit],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      const group = groupDrag.current;
      groupDrag.current = null;
      const alsoMoved = group
        ? live.current.filter((other) => group.others.has(other.id))
        : [];
      persistPositions([node, ...alsoMoved]);
    },
    [persistPositions],
  );

  const onSelectionDragStop = useCallback(
    (_: unknown, moved: Node[]) => persistPositions(moved),
    [persistPositions],
  );

  // Clicking a line goes to where that relationship is written.
  const onEdgeClick = useCallback(
    (_: unknown, edge: Edge) => {
      const location = (edge.data as { location?: Location } | undefined)?.location;
      if (location) revealLocation(location);
    },
    [revealLocation],
  );

  if (!source) return <div className="diagram-empty">Analyzing…</div>;
  if (nodes.length === 0) {
    return (
      <div className="diagram-empty">
        No tables yet. Declare one:
        <pre>{"Table Customer {\n  id int [pk];\n}"}</pre>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      onSelectionDragStop={onSelectionDragStop}
      onEdgeClick={onEdgeClick}
      snapToGrid={snapToGrid}
      snapGrid={[gridSize, gridSize]}
      // Shift-drag on the canvas draws a selection box; Shift/Ctrl-click
      // adds a table to the selection, and a selection drags as one.
      multiSelectionKeyCode={["Shift", "Control", "Meta"]}
      selectionOnDrag={false}
      selectNodesOnDrag={false}
      elevateNodesOnSelect
      fitView
      proOptions={{ hideAttribution: false }}
      minZoom={0.15}
    >
      {Toolbar ? <Toolbar /> : null}
      <Background gap={snapToGrid ? gridSize : 18} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        // The defaults are tuned for a light canvas and render as a grey
        // slab on this one.
        bgColor="var(--sk-surface)"
        maskColor="rgba(20, 22, 28, 0.72)"
        nodeColor="var(--sk-surface-raised)"
        nodeStrokeColor="var(--sk-border)"
      />
    </ReactFlow>
  );
}

export function DiagramView(props: DiagramViewProps): JSX.Element {
  const { host, chrome } = props;
  // Memoized because the nodes React Flow renders read this on every pass;
  // a fresh object per render would re-render every node for nothing.
  const context = useMemo(() => ({ host, chrome }), [host, chrome]);

  return (
    <DiagramContextProvider value={context}>
      <ReactFlowProvider>
        <DiagramCanvas {...props} />
      </ReactFlowProvider>
    </DiagramContextProvider>
  );
}
