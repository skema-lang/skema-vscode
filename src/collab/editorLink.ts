/**
 * Turns a bare invite token into a link `skema-editor` can open directly:
 * `<skema.collab.editorUrl>#collab=<token>`. Pure so it stays unit-testable
 * without a `vscode` runtime, like `session.ts`.
 */
import { FRAGMENT_KEY } from "@skema/collab-protocol";

export function editorInviteUrl(editorUrl: string, token: string): string {
  const url = new URL(editorUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `skema.collab.editorUrl must be an http(s) URL to hand out as an invite, got "${editorUrl}".`,
    );
  }
  url.hash = `${FRAGMENT_KEY}=${token}`;
  return url.toString();
}
