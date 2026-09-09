/**
 * One table in the diagram: header, columns, and the relationships that
 * point away from it.
 *
 * Column rows deliberately show what the *database* will have - the
 * back-references a model may declare (`orders <Order.customer;`) create
 * no column and are listed underneath, dimmed, as "has many" hints.
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { JSX } from "react";

import type { ExportedField } from "../../shared/skema";
import { useDiagramChrome, useReveal } from "./context";
import { sourceLabel, tableFacts } from "./details";
import type { TableNodeData } from "./graph";
import { nodeStyleVariables } from "./style";
import { TableNodeRow } from "./TableNodeRow";

/** Kept in sync with the CSS so layout can size a node before it renders. */
export const NODE_WIDTH = 260;
export const ROW_HEIGHT = 22;
export const HEADER_HEIGHT = 34;

export function nodeHeight(data: TableNodeData): number {
  const rows = data.columns.length + data.backReferences.length;
  return HEADER_HEIGHT + rows * ROW_HEIGHT + 8;
}

export function TableNode({ data, selected }: NodeProps): JSX.Element {
  const { table, columns, backReferences, style } = data as unknown as TableNodeData;
  const { DetailCard } = useDiagramChrome();
  const { revealTable, revealField } = useReveal();
  const openField = (field: ExportedField): void => revealField(field);

  return (
    <div
      className={`table-node${selected ? " is-selected" : ""}`}
      style={{ width: NODE_WIDTH, ...nodeStyleVariables(style) }}
    >
      {/* Node-level fallbacks, used by an edge whose exact row is not drawn. */}
      <Handle type="target" position={Position.Left} className="table-node__handle" />
      <Handle type="source" position={Position.Right} className="table-node__handle" />

      <DetailCard
        title={table.name}
        subtitle={table.namespace}
        facts={tableFacts(table)}
        source={sourceLabel(table.location ?? undefined)}
      >
        <header className="table-node__header" onDoubleClick={() => revealTable(table)}>
          <span className="table-node__name">{table.name}</span>
          {table.namespace ? (
            <span className="table-node__namespace">{table.namespace}</span>
          ) : null}
        </header>
      </DetailCard>

      <ul className="table-node__columns">
        {columns.map((field) => (
          <TableNodeRow
            key={field.name}
            field={field}
            tableFile={table.file}
            onOpen={openField}
          />
        ))}
        {backReferences.map((field) => (
          <TableNodeRow
            key={field.name}
            field={field}
            tableFile={table.file}
            onOpen={openField}
          />
        ))}
      </ul>
    </div>
  );
}
