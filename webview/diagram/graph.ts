/**
 * The analysed model as a graph: one node per table, one edge per
 * relationship.
 *
 * Two things about back-references (`orders <Order.customer;`) drive most
 * of this file. They are real fields in the model with a real relation,
 * but they create no column (`docs/07`), and the relationship they name is
 * already described by the `>` side. So they are filtered **twice**, in
 * two different places:
 *
 * - out of a node's column list, or the diagram shows a column the
 *   database will not have;
 * - out of the edge list, or every relationship declared from both sides
 *   is drawn twice.
 *
 * Neither filter implies the other, which is exactly why they are spelled
 * out separately below.
 */
import type {
  ExportedEnum,
  ExportedEnumEntry,
  ExportedField,
  ExportedGroup,
  ExportedModel,
  ExportedTable,
  Location,
} from "../../shared/skema";
import type { ResolvedStyle } from "./style";

export interface TableNodeData {
  table: ExportedTable;
  /** Fields that become columns - back-references excluded. */
  columns: ExportedField[];
  /** Back-references, shown as "has many" hints rather than columns. */
  backReferences: ExportedField[];
  style: ResolvedStyle;
  [key: string]: unknown;
}

export interface EnumNodeData {
  enum: ExportedEnum;
  entries: ExportedEnumEntry[];
  style: ResolvedStyle;
  [key: string]: unknown;
}

export interface GroupNodeData {
  group: ExportedGroup;
  style: ResolvedStyle;
  /** Recomputed from the members' bounding box on every render, never
   *  stored: only the frame's anchor is a decision worth persisting. */
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface RelationEdge {
  id: string;
  source: string;
  target: string;
  /** The exact field rows the line connects, so it meets the column it is
   *  about rather than the table as a whole. `undefined` falls back to the
   *  node-level handles, which is what happens when the referenced field
   *  is not itself drawn as a row. The *side* is not decided here: it
   *  depends on where the two tables end up (see `edgeSides`). */
  sourceField: string | undefined;
  targetField: string | undefined;
  label: string;
  /** `1:n` vs `1:1` - drawn differently, and useful as a tooltip. */
  oneToOne: boolean;
  onDelete: string | undefined;
  /** Where the relationship is written, for jumping there from the edge. */
  location: Location | undefined;
  /** The declaring table's file - which `Document`'s `Style @relation`
   *  applies to this line. */
  file: string;
}

/** Which edge of a node a line attaches to. */
export type Side = "left" | "right";

/**
 * A field row's connection points. Every row has all four (a source and a
 * target on each side) so a line can always leave and arrive on the side
 * facing the other table - a line that leaves rightwards towards a table
 * sitting on the left has to loop around the node, which is exactly the
 * "badly drawn" case.
 */
export function sourceHandleId(fieldName: string, side: Side): string {
  return `src:${side}:${fieldName}`;
}

export function targetHandleId(fieldName: string, side: Side): string {
  return `tgt:${side}:${fieldName}`;
}

/** Namespace plus name: what identifies a table project-wide (`docs/02`). */
export function tableId(namespace: string, name: string): string {
  return namespace ? `${namespace}.${name}` : name;
}

/** Same rule as `tableId`, for the other declaration kind that gets a node. */
export function enumId(namespace: string, name: string): string {
  return namespace ? `${namespace}.${name}` : name;
}

export function isBackReference(field: ExportedField): boolean {
  return field.relation?.kind === "ManyToOne";
}

export function nodeData(table: ExportedTable, style: ResolvedStyle): TableNodeData {
  return {
    table,
    columns: table.fields.filter((f) => !isBackReference(f)),
    backReferences: table.fields.filter(isBackReference),
    style,
  };
}

export function enumNodeData(en: ExportedEnum, style: ResolvedStyle): EnumNodeData {
  return { enum: en, entries: en.entries, style };
}

export function relationEdges(model: ExportedModel): RelationEdge[] {
  /** Which field rows each table actually draws - a handle only exists for
   *  those, so an edge may only point at one of them. */
  const rowsByTable = new Map<string, Set<string>>(
    model.tables.map((table) => [
      tableId(table.namespace, table.name),
      new Set(table.fields.filter((f) => !isBackReference(f)).map((f) => f.name)),
    ]),
  );
  const edges: RelationEdge[] = [];

  for (const table of model.tables) {
    const source = tableId(table.namespace, table.name);
    for (const field of table.fields) {
      const relation = field.relation;
      // The `<` side is skipped rather than merged: the `>`/`-` side is the
      // one that owns the column and the flags, so it is the authoritative
      // description of the same edge.
      if (!relation || relation.kind === "ManyToOne") continue;

      const target = tableId(relation.targetNamespace, relation.targetTable);
      const targetRows = rowsByTable.get(target);
      // A target that is not in the model failed to resolve; the diagnostic
      // for it is already in the editor, and a dangling edge would only add
      // noise to the diagram.
      if (!targetRows) continue;

      edges.push({
        id: `${source}.${field.name}->${target}.${relation.targetField}`,
        source,
        target,
        sourceField: rowsByTable.get(source)?.has(field.name) ? field.name : undefined,
        targetField: targetRows.has(relation.targetField) ? relation.targetField : undefined,
        label: field.name,
        oneToOne: relation.kind === "OneToOne",
        onDelete: relation.onDelete ?? undefined,
        location: relation.location ?? field.location ?? undefined,
        // The line belongs to the table that declares it, so that is the
        // `Document` whose `Style @relation` styles it.
        file: table.file,
      });
    }
  }
  return edges;
}

/**
 * Which sides of the two nodes a line should use, from where they sit: it
 * leaves towards the other table and arrives from the side facing back.
 * Overlapping or stacked tables fall back to left-to-right.
 */
export function edgeSides(
  sourcePosition: { x: number } | undefined,
  targetPosition: { x: number } | undefined,
  nodeWidth: number,
): { source: Side; target: Side } {
  if (!sourcePosition || !targetPosition) return { source: "right", target: "left" };
  const targetIsLeft = targetPosition.x + nodeWidth < sourcePosition.x;
  return targetIsLeft ? { source: "left", target: "right" } : { source: "right", target: "left" };
}
