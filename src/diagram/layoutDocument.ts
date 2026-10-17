/** Where `panel.ts` reads `.skema/layout.json` from and when it saves it, kept `vscode`-free to be testable. */
import { emptyLayout, parseLayout, type DiagramLayout } from "@skema/diagram";

/** An open document can hold unsaved text newer than the disk, so it wins. */
export async function loadLayout(
  openDocumentText: string | undefined,
  readDisk: () => PromiseLike<Uint8Array>,
): Promise<DiagramLayout> {
  if (openDocumentText !== undefined) return parseLayout(openDocumentText);
  try {
    return parseLayout(new TextDecoder().decode(await readDisk()));
  } catch {
    return emptyLayout();
  }
}

export async function applyThenSave(
  apply: () => PromiseLike<boolean>,
  save: () => PromiseLike<boolean>,
  reportUnsaved: (reason: string) => void,
): Promise<void> {
  if (!(await apply())) return;
  try {
    if (!(await save())) reportUnsaved("the save did not complete");
  } catch (error) {
    reportUnsaved(String(error));
  }
}
