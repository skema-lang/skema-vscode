/**
 * Reading a diagram position out of the model's source.
 *
 * Positions live in the declaration itself, as the language's reserved
 * custom key (`docs/01`, 1.11: "custom keys must start with `x-` and be
 * quoted ... passed through unchanged"):
 *
 *     Table Customer {
 *       Meta { "x-editorPosition" = "120,340"; }
 *     }
 *
 * So a layout travels with the file, survives a different browser, and
 * shows up in a diff like any other decision about the model.
 *
 * **Only the read side is here**, and that split is deliberate rather than
 * tidiness: reading needs nothing but the `Meta` entries, so every host that
 * draws the diagram can do it, while writing needs the file's exact current
 * text and belongs to whoever owns it. See `positionEdits.ts`.
 *
 * One coordinate system per element, decided by group membership: a table
 * or enum listed in a `Group` stores its position **relative to that
 * group's frame**, everything else stores an absolute canvas position.
 */
import type { MetaEntry } from "../../shared/skema";

export const POSITION_KEY = "x-editorPosition";

export interface Position {
  x: number;
  y: number;
}

export function readPosition(meta: { entries: MetaEntry[] } | undefined): Position | undefined {
  const value = meta?.entries.find((entry) => entry.key === POSITION_KEY)?.value;
  if (!value) return undefined;
  const [x, y] = value.split(",").map((part) => Number.parseFloat(part.trim()));
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  return { x, y };
}
