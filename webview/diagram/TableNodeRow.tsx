/**
 * One field row of a table node.
 *
 * Each row carries its own pair of connection points, so a relationship
 * line meets the column it is actually about rather than the table as a
 * whole. Both sides exist on every row because which one an edge uses
 * depends on where the other table happens to sit on the canvas.
 *
 * The row itself shows only what fits: name, type, one flag. Everything
 * else the model knows is in the hover card.
 */
import { Handle, Position } from "@xyflow/react";
import type { JSX } from "react";

import type { ExportedField } from "../../shared/skema";
import { useDiagramChrome } from "./context";
import { hasFlag } from "../model/flags";
import { fieldFacts, flagBadges, sourceLabel, typeLabel } from "./details";
import { sourceHandleId, targetHandleId } from "./graph";

/** `[pk]`/`[unique]` are what a reader scans for; the rest is in the card. */
function shortFlag(field: ExportedField): string {
  if (hasFlag(field, "pk")) return "PK";
  if (field.relation) return "FK";
  if (hasFlag(field, "unique")) return "U";
  return "";
}

export interface TableNodeRowProps {
  field: ExportedField;
  tableFile: string;
  onOpen: (field: ExportedField) => void;
}

export function TableNodeRow({ field, tableFile, onOpen }: TableNodeRowProps): JSX.Element {
  const { DetailCard } = useDiagramChrome();
  const isBackReference = field.relation?.kind === "ManyToOne";

  return (
    <DetailCard
      title={field.name}
      subtitle={typeLabel(field)}
      badges={flagBadges(field)}
      facts={fieldFacts(field, tableFile)}
      note={field.note ?? undefined}
      source={sourceLabel(field.location ?? undefined)}
    >
      <li
        className={`table-node__row${hasFlag(field, "pk") ? " is-key" : ""}${
          isBackReference ? " is-backref" : ""
        }`}
        onDoubleClick={() => onOpen(field)}
      >
        <Handle
          type="target"
          position={Position.Left}
          id={targetHandleId(field.name, "left")}
          className="table-node__handle"
        />
        <Handle
          type="source"
          position={Position.Left}
          id={sourceHandleId(field.name, "left")}
          className="table-node__handle"
        />
        <span className="table-node__field">{field.name}</span>
        <span className="table-node__type">
          {isBackReference ? `has many ${field.relation?.targetTable ?? ""}` : typeLabel(field)}
        </span>
        <span className="table-node__flags">{shortFlag(field)}</span>
        <Handle
          type="target"
          position={Position.Right}
          id={targetHandleId(field.name, "right")}
          className="table-node__handle"
        />
        <Handle
          type="source"
          position={Position.Right}
          id={sourceHandleId(field.name, "right")}
          className="table-node__handle"
        />
      </li>
    </DetailCard>
  );
}
