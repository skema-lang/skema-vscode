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

export interface WriteQueue<T> {
  write(file: string, value: T): Promise<void>;
  /** Resolves once no write for `file` is waiting or running, so a read after it sees the latest value. */
  idle(file: string): Promise<void>;
}

/** VS Code refuses an edit computed from a superseded version, so writes run one at a time and a newer layout replaces one still waiting for its file. */
export function serializeWrites<T>(
  write: (file: string, value: T) => PromiseLike<void>,
  reportFailure: (error: unknown) => void,
): WriteQueue<T> {
  const waiting = new Map<string, T>();
  const lastWrite = new Map<string, Promise<void>>();
  let settled: Promise<void> = Promise.resolve();

  const report = (error: unknown): void => {
    try {
      reportFailure(error);
    } catch {
      // A reporter that throws (a disposed output channel) must not stop the writes after it.
    }
  };

  const writeLatest = async (file: string): Promise<void> => {
    const value = waiting.get(file) as T;
    waiting.delete(file);
    try {
      await write(file, value);
    } catch (error) {
      report(error);
    }
  };

  return {
    write: (file, value) => {
      if (!waiting.has(file)) {
        const written = settled.then(() => writeLatest(file));
        settled = written;
        lastWrite.set(file, written);
        void written.then(() => {
          if (lastWrite.get(file) === written) lastWrite.delete(file);
        });
      }
      waiting.set(file, value);
      return settled;
    },
    idle: async (file) => {
      for (let pending = lastWrite.get(file); pending; pending = lastWrite.get(file)) await pending;
    },
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
