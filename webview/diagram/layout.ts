/**
 * Automatic placement for tables that carry no position of their own yet.
 *
 * Only ever consulted for nodes the diagram has not seen before: a table
 * whose position is in the source text, or that was placed on an earlier
 * pass, keeps it. Re-laying out everything on each analysis would make the
 * diagram jump on every keystroke.
 */
import dagre from "@dagrejs/dagre";

import type { Position } from "./positions";
import type { RelationEdge } from "./graph";

export interface LayoutGroup {
  id: string;
  memberIds: string[];
}

export interface LayoutInput {
  ids: string[];
  edges: RelationEdge[];
  sizeOf: (id: string) => { width: number; height: number };
  /** Boxes that belong inside one frame, so dagre keeps them together
   *  instead of ranking them by relationship alone - a group laid out
   *  without this ends up wrapped around half the diagram. */
  groups?: LayoutGroup[];
}

/**
 * Positions for every id, with the whole graph as context - the caller
 * then keeps only the ones it actually needed, so an existing node's
 * position is never overwritten but still influences where new ones land.
 *
 * A group id gets the corner of the cluster its members were laid out in,
 * which is what a frame that has never been placed starts from.
 */
export function layoutGraph({
  ids,
  edges,
  sizeOf,
  groups = [],
}: LayoutInput): Map<string, Position> {
  // Clusters cost dagre a different code path, so they are only asked for
  // when the model actually has groups.
  const graph = new dagre.graphlib.Graph({ compound: groups.length > 0 });
  graph.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 96, marginx: 32, marginy: 32 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const id of ids) graph.setNode(id, sizeOf(id));
  for (const group of groups) {
    const members = group.memberIds.filter((id) => graph.hasNode(id));
    // An empty cluster has no dimensions for dagre to report, and asking for
    // one would only add a node nothing is measured against.
    if (members.length === 0) continue;
    graph.setNode(group.id, {});
    for (const id of members) graph.setParent(id, group.id);
  }
  for (const edge of edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.setEdge(edge.source, edge.target);
    }
  }
  dagre.layout(graph);

  const positions = new Map<string, Position>();
  for (const id of [...ids, ...groups.map((group) => group.id)]) {
    const node = graph.node(id);
    if (!node) continue;
    // dagre centers a node on its position; React Flow measures from the
    // top-left corner.
    positions.set(id, { x: node.x - node.width / 2, y: node.y - node.height / 2 });
  }
  return positions;
}
