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

export interface LayoutInput {
  ids: string[];
  edges: RelationEdge[];
  sizeOf: (id: string) => { width: number; height: number };
}

/**
 * Positions for every id, with the whole graph as context - the caller
 * then keeps only the ones it actually needed, so an existing node's
 * position is never overwritten but still influences where new ones land.
 */
export function layoutGraph({ ids, edges, sizeOf }: LayoutInput): Map<string, Position> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 96, marginx: 32, marginy: 32 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const id of ids) graph.setNode(id, sizeOf(id));
  for (const edge of edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.setEdge(edge.source, edge.target);
    }
  }
  dagre.layout(graph);

  const positions = new Map<string, Position>();
  for (const id of ids) {
    const node = graph.node(id);
    if (!node) continue;
    // dagre centers a node on its position; React Flow measures from the
    // top-left corner.
    positions.set(id, { x: node.x - node.width / 2, y: node.y - node.height / 2 });
  }
  return positions;
}
