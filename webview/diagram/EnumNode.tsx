/**
 * One enum in the diagram: header plus its values.
 *
 * Painted like a table box - `style.ts` resolves the same box properties for
 * both (`resolveEnumStyle`), and `.table-node` is reused wholesale rather
 * than duplicated under a new class name. No handles: nothing yet draws an
 * edge from a field to the enum it is typed as.
 */
import type { NodeProps } from "@xyflow/react";
import type { JSX } from "react";

import { useDiagramChrome, useReveal } from "./context";
import { enumFacts, sourceLabel } from "./details";
import type { EnumNodeData } from "./graph";
import { nodeStyleVariables } from "./style";
import { HEADER_HEIGHT, NODE_WIDTH, ROW_HEIGHT } from "./TableNode";

export function enumNodeHeight(data: EnumNodeData): number {
  return HEADER_HEIGHT + data.entries.length * ROW_HEIGHT + 8;
}

export function EnumNode({ data, selected }: NodeProps): JSX.Element {
  const { enum: en, entries, style } = data as unknown as EnumNodeData;
  const { DetailCard } = useDiagramChrome();
  const { revealEnum } = useReveal();

  return (
    <div
      className={`table-node${selected ? " is-selected" : ""}`}
      style={{ width: NODE_WIDTH, ...nodeStyleVariables(style) }}
    >
      <DetailCard
        title={en.name}
        subtitle={en.namespace}
        facts={enumFacts(en)}
        source={sourceLabel(en.location ?? undefined)}
      >
        <header className="table-node__header" onDoubleClick={() => revealEnum(en)}>
          <span className="table-node__name">{en.name}</span>
          {en.namespace ? <span className="table-node__namespace">{en.namespace}</span> : null}
        </header>
      </DetailCard>

      <ul className="table-node__columns">
        {entries.map((entry) => (
          <li key={entry.name} className="table-node__row">
            <span className="table-node__field">{entry.label ?? entry.name}</span>
            {entry.value !== undefined ? (
              <span className="table-node__type">{entry.value}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
