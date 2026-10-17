/** Where `panel.ts` reads `.skema/layout.json` from and when it writes and saves it, kept `vscode`-free to be testable. */
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

/** VS Code refuses an edit computed from a superseded version, so writes run one at a time and a newer layout replaces one still waiting for its file. */
export function serializeWrites<T>(
  write: (file: string, value: T) => PromiseLike<void>,
  reportFailure: (error: unknown) => void,
): (file: string, value: T) => Promise<void> {
  const waiting = new Map<string, T>();
  let settled: Promise<void> = Promise.resolve();

  const writeLatest = async (file: string): Promise<void> => {
    const value = waiting.get(file) as T;
    waiting.delete(file);
    try {
      await write(file, value);
    } catch (error) {
      reportFailure(error);
    }
  };

  return (file, value) => {
    if (!waiting.has(file)) settled = settled.then(() => writeLatest(file));
    waiting.set(file, value);
    return settled;
  };
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
