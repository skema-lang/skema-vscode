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
import type { CSSProperties, JSX } from "react";
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
import { EnumNode, enumNodeHeight } from "./EnumNode";
import { GROUP_DRAG_HANDLE, GroupNode } from "./GroupNode";
import {
  groupFrame,
  toAnchor,
  toChildPosition,
  toStoredPosition,
  type GroupFrame,
  type MemberBox,
} from "./groupFrame";
import type {
  DeclKind,
  DiagramChrome,
  DiagramHost,
  DiagramPreferences,
  DiagramSource,
} from "./types";
import {
  edgeSides,
  enumId,
  enumNodeData,
  groupId,
  groupMemberId,
  groupMembership,
  groupNodeData,
  nodeData,
  relationEdges,
  sourceHandleId,
  tableId,
  targetHandleId,
  type EnumNodeData,
  type GroupNodeData,
  type TableNodeData,
} from "./graph";
import { layoutGraph } from "./layout";
import { readPosition, type Position } from "./positions";
import {
  resolveEnumStyle,
  resolveGroupStyle,
  resolveTableStyle,
  readStyleClasses,
} from "./style";
import { NODE_WIDTH, TableNode, nodeHeight } from "./TableNode";

const nodeTypes = { table: TableNode, enum: EnumNode, group: GroupNode };

const ORIGIN: Position = { x: 0, y: 0 };

/** One entry of the model's own view of the diagram - which kind of node it
 *  is decides both its React Flow `type` and how tall it lays out. */
type NodeEntry =
  | { kind: "table"; data: TableNodeData }
  | { kind: "enum"; data: EnumNodeData };

function entryHeight(entry: NodeEntry): number {
  return entry.kind === "table" ? nodeHeight(entry.data) : enumNodeHeight(entry.data);
}

/** Everything about a node that the model decides, as opposed to what the
 *  canvas does: selection, measured size and an in-flight drag are not in
 *  here, because a re-analysis must not reset them. */
interface NodeSpec {
  id: string;
  type: "table" | "enum" | "group";
  position: Position;
  data: Record<string, unknown>;
  /** Set only on a box inside a frame, and only on a frame. */
  parentId?: string;
  width?: number;
  height?: number;
  dragHandle?: string;
  style?: CSSProperties;
}

/**
 * A frame must not take the pointer: it covers everything it contains, and
 * a click on the canvas inside one has to reach the canvas. The label puts
 * it back for itself (`styles.css`), which leaves that the only place to
 * select or drag a frame by.
 *
 * It goes on the node rather than in the stylesheet because React Flow
 * writes `pointer-events` inline on the wrapper, and only `node.style` is
 * merged over it.
 */
const FRAME_STYLE: CSSProperties = { pointerEvents: "none" };

/** What a drag needs to write back: which file, which declaration, which
 *  kind of `Meta` block it stores its position in. */
function declRefOf(node: Node): { file: string; name: string; kind: DeclKind } {
  if (node.type === "group") {
    const data = node.data as unknown as GroupNodeData;
    return { file: data.group.file, name: data.group.name, kind: "group" };
  }
  if (node.type === "enum") {
    const data = node.data as unknown as EnumNodeData;
    return { file: data.enum.file, name: data.enum.name, kind: "enum" };
  }
  const data = node.data as unknown as TableNodeData;
  return { file: data.table.file, name: data.table.name, kind: "table" };
}

/**
 * A node's position in the coordinate system its own `Meta` block stores.
 *
 * React Flow works in two: a frame sits at its own corner, and a box inside
 * one sits relative to that corner. The model stores neither - a frame
 * stores its anchor, a member its offset from that anchor (`positions.ts`),
 * and `groupFrame.ts` is what converts between them.
 */
function storedPosition(node: Node, frames: Map<string, GroupFrame>): Position {
  if (node.type === "group") {
    const frame = frames.get(node.id);
    return frame ? toAnchor(node.position, frame) : node.position;
  }
  const frame = node.parentId ? frames.get(node.parentId) : undefined;
  return frame ? toStoredPosition(node.position, frame) : node.position;
}

export interface DiagramViewProps {
  /** `null` while the host has no analysis yet - the canvas says so. */
  source: DiagramSource | null;
  preferences: DiagramPreferences;
  host: DiagramHost;
  chrome: DiagramChrome;
}

function DiagramCanvas({ source, preferences, host, chrome }: DiagramViewProps): JSX.Element {
  const { rememberLayout, applyPositionEdit, revealLocation } = host;
  const { edgeRouting, snapToGrid, gridSize, autoSavePositions } = preferences;
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
    const { model: exported, metas, enumMetas, groupMetas, projectStyles, layout } = source;

    const relations = relationEdges(exported);
    const data = new Map<string, NodeEntry>();
    for (const table of exported.tables) {
      const meta = metas[table.file]?.find((m) => m.name === table.name);
      const style = resolveTableStyle(projectStyles, table.file, readStyleClasses(meta?.entries));
      data.set(tableId(table.namespace, table.name), {
        kind: "table",
        data: nodeData(table, style),
      });
    }
    for (const en of exported.enums) {
      const meta = enumMetas[en.file]?.find((m) => m.name === en.name);
      const style = resolveEnumStyle(projectStyles, en.file, readStyleClasses(meta?.entries));
      data.set(enumId(en.namespace, en.name), { kind: "enum", data: enumNodeData(en, style) });
    }

    const frameOf = groupMembership(exported);

    // Source position wins; then one from an earlier pass; only a table or
    // enum seen for the first time is laid out - see layout.ts. What the
    // number *means* depends on group membership: an offset into the frame
    // for a member, an absolute canvas position for everything else.
    const placed = new Map<string, Position>();
    const unplaced: string[] = [];
    for (const table of exported.tables) {
      const id = tableId(table.namespace, table.name);
      const stored = readPosition(metas[table.file]?.find((m) => m.name === table.name));
      const known = stored ?? layout[id];
      if (known) placed.set(id, known);
      else unplaced.push(id);
    }
    for (const en of exported.enums) {
      const id = enumId(en.namespace, en.name);
      const stored = readPosition(enumMetas[en.file]?.find((m) => m.name === en.name));
      const known = stored ?? layout[id];
      if (known) placed.set(id, known);
      else unplaced.push(id);
    }

    const anchors = new Map<string, Position>();
    const unplacedGroups: string[] = [];
    for (const group of exported.groups) {
      const id = groupId(group);
      const stored = readPosition(groupMetas[group.file]?.find((m) => m.name === group.name));
      const known = stored ?? layout[id];
      if (known) anchors.set(id, known);
      else unplacedGroups.push(id);
    }

    if (unplaced.length > 0 || unplacedGroups.length > 0) {
      const computed = layoutGraph({
        ids: [...data.keys()],
        edges: relations,
        sizeOf: (id) => {
          const entry = data.get(id);
          return {
            width: NODE_WIDTH,
            height: entry ? entryHeight(entry) : 120,
          };
        },
        groups: exported.groups.map((group) => ({
          id: groupId(group),
          memberIds: group.members.map(groupMemberId),
        })),
      });
      const fresh: Record<string, Position> = {};
      for (const id of unplacedGroups) {
        const position = computed.get(id) ?? ORIGIN;
        anchors.set(id, position);
        fresh[id] = position;
      }
      for (const id of unplaced) {
        const absolute = computed.get(id) ?? ORIGIN;
        const frame = frameOf.get(id);
        // A member is stored as an offset into its group, measured from the
        // cluster this same pass produced - not from wherever the group's
        // anchor already is, which would drag the whole frame across the
        // canvas every time a table is added to it.
        const cluster = frame ? (computed.get(frame) ?? ORIGIN) : ORIGIN;
        const position = frame
          ? { x: absolute.x - cluster.x, y: absolute.y - cluster.y }
          : absolute;
        placed.set(id, position);
        fresh[id] = position;
      }
      // Remembered so the next pass does not lay them out again.
      queueMicrotask(() => rememberLayout(fresh));
    }

    const frames = new Map<string, GroupFrame>();
    const specs: NodeSpec[] = [];
    for (const group of exported.groups) {
      const id = groupId(group);
      const meta = groupMetas[group.file]?.find((m) => m.name === group.name);
      const style = resolveGroupStyle(projectStyles, group.file, readStyleClasses(meta?.entries));
      // A member the diagram draws no box for - a `Partial`, say - takes up
      // no room in the frame, so it simply does not contribute one.
      const boxes = group.members.flatMap((member): MemberBox[] => {
        const memberId = groupMemberId(member);
        const entry = data.get(memberId);
        const at = placed.get(memberId);
        return entry && at ? [{ ...at, width: NODE_WIDTH, height: entryHeight(entry) }] : [];
      });
      const frame = groupFrame(anchors.get(id) ?? ORIGIN, boxes);
      frames.set(id, frame);
      specs.push({
        id,
        type: "group",
        position: frame.position,
        width: frame.width,
        height: frame.height,
        dragHandle: GROUP_DRAG_HANDLE,
        style: FRAME_STYLE,
        data: groupNodeData(group, style, frame) as unknown as Record<string, unknown>,
      });
    }

    // Frames come first: React Flow resolves a child against a parent it has
    // already seen in this list, and warns and gives up on one it has not.
    for (const [id, entry] of data) {
      const frameId = frameOf.get(id);
      const frame = frameId ? frames.get(frameId) : undefined;
      const at = placed.get(id) ?? ORIGIN;
      specs.push({
        id,
        type: entry.kind,
        position: frame ? toChildPosition(at, frame) : at,
        ...(frame && frameId ? { parentId: frameId } : {}),
        data: entry.data as unknown as Record<string, unknown>,
      });
    }

    return { specs, frames, relations };
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
      const next = model.specs.map((spec) => {
        const previous = existing.get(spec.id);
        const position =
          previous && dragging.current.has(spec.id) ? previous.position : spec.position;
        const node: Node = { ...previous, ...spec, position };
        // A table dropped from a `Group` has to lose its frame, and `spec`
        // says so by leaving the key out rather than setting it empty.
        if (spec.parentId === undefined) delete node.parentId;
        return node;
      });
      live.current = next;
      return next;
    });
  }, [model]);

  const edges = useMemo((): Edge[] => {
    if (!model) return [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    // Sides are decided from where the nodes actually are, so a line always
    // leaves towards the other table instead of looping around its own. A
    // box inside a frame is positioned relative to it, so its own number
    // says nothing about the gap to a box outside - only the sum does.
    const positionOf = (id: string): { x: number } | undefined => {
      const node = byId.get(id);
      if (!node) return undefined;
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      return parent ? { x: node.position.x + parent.position.x } : node.position;
    };

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
    const selected = live.current.filter((other) => other.selected);
    // A frame already carries its own members, so a box selected next to the
    // frame it sits in must not be given the same delta a second time.
    const carried = new Set(
      selected.filter((other) => other.type === "group").map((other) => other.id),
    );
    const isCarried = (other: Node): boolean =>
      other.parentId !== undefined && carried.has(other.parentId);

    const others = selected.filter((other) => other.id !== node.id && !isCarried(other));
    if (!node.selected || isCarried(node) || others.length === 0) {
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

  /**
   * One write per box or frame that actually moved, whether one was dragged
   * or a whole selection was. Only reaches the source when `autoSavePositions`
   * is on; otherwise the position is remembered for this session only, the
   * same fallback an unplaced node gets on its first layout.
   *
   * A frame is one write however many members it holds: they are stored as
   * offsets from its anchor, and dragging the frame changed only the anchor.
   */
  const persistPositions = useCallback(
    (moved: Node[]) => {
      const frames = model?.frames;
      for (const node of moved) {
        dragging.current.delete(node.id);
        const position = frames ? storedPosition(node, frames) : node.position;
        if (autoSavePositions) {
          const { file, name, kind } = declRefOf(node);
          applyPositionEdit(file, name, position, kind);
        } else {
          rememberLayout({ [node.id]: position });
        }
      }
    },
    [applyPositionEdit, rememberLayout, autoSavePositions, model],
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
        Nothing to show yet. Declare a table:
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
