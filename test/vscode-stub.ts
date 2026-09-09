/**
 * Just enough of the `vscode` module for `resolveServer` to run outside an
 * editor.
 *
 * Deliberately tiny. Faking the whole API to test more of the extension host
 * would be testing the fake; the parts worth checking without an editor are
 * the ones that are plain logic, and this is one of them - which binary gets
 * run, and whether an explicitly configured path that is missing fails
 * loudly instead of silently falling back.
 */
export const settings = new Map<string, unknown>();

export const workspace = {
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const value = settings.get(`${section}.${key}`);
        return (value as T) ?? fallback;
      },
    };
  },
};

export interface ExtensionContext {
  asAbsolutePath(relative: string): string;
}
