/**
 * Reading a diagram position out of the model's source.
 *
 * Positions live in the declaration itself, as the language's reserved
 * custom key (`docs/01`, 1.11):
 *
 *     Table Customer {
 *       Meta { "x-editorPosition" = "120,340"; }
 *     }
 *
 * so a layout travels with the file and shows up in a diff like any other
 * decision about the model.
 *
 * **Only the read side is here.** The browser editor's copy of this file
 * also builds the edit that writes a position back; in this extension that
 * is `skema/positionEdit` on the language server (`skema-api::position`),
 * for two reasons. The offsets belong to one exact revision of a file the
 * webview does not have - VSCode's documents live in the extension host -
 * and computing an edit from text the view never saw is how a drag would
 * eventually land in the wrong place. And the rule for where a `Meta` entry
 * goes is language knowledge; it already exists once, in Rust.
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
