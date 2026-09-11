/**
 * One `Group` in the diagram: a bordered area behind its members
 * (`docs/12`).
 *
 * The frame is a backdrop, not a box. Its body lets pointer events through,
 * so a click inside it reaches the table under the pointer or the canvas
 * behind it - a frame that swallowed clicks would make everything it
 * contains unselectable. That leaves the label as the only thing to grab,
 * which is why it is also the node's drag handle.
 */
import type { NodeProps } from "@xyflow/react";
import type { JSX } from "react";

import { useDiagramChrome, useReveal } from "./context";
import { groupFacts, sourceLabel } from "./details";
import type { GroupNodeData } from "./graph";
import { groupStyleVariables } from "./style";

/** The selector React Flow drags this node by - see the module comment. */
export const GROUP_DRAG_HANDLE = ".group-node__label";

export function GroupNode({ data, selected }: NodeProps): JSX.Element {
  const { group, style, width, height } = data as unknown as GroupNodeData;
  const { DetailCard } = useDiagramChrome();
  const { revealGroup } = useReveal();

  return (
    <div
      className={`group-node${selected ? " is-selected" : ""}`}
      style={{ width, height, ...groupStyleVariables(style) }}
    >
      <DetailCard
        title={group.name}
        subtitle="Group"
        facts={groupFacts(group)}
        source={sourceLabel(group.location ?? undefined)}
      >
        <header className="group-node__label" onDoubleClick={() => revealGroup(group)}>
          {group.name}
        </header>
      </DetailCard>
    </div>
  );
}
