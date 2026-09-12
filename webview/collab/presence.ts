/**
 * Everyone else's in-flight drag, as the extension's collaboration session
 * last reported it (`src/collab/session.ts`).
 *
 * The webview never touches Yjs/awareness itself - that lives in the
 * extension host, behind the CSP boundary (`diagram/panel.ts`'s `html()`
 * has no `connect-src`). This is only the two ends of the `postMessage`
 * bridge: `applyPresence` receives what the host pushes in, `publishDrag`
 * (re-exported from `host.ts`) sends this window's own drag out.
 */
import { create } from "zustand";

import type { RemoteDrag } from "../../shared/protocol";

export { publishDrag } from "../host";

interface PresenceState {
  remoteDrags: RemoteDrag[];
  applyPresence: (remoteDrags: RemoteDrag[]) => void;
}

const NONE: RemoteDrag[] = [];

export const usePresence = create<PresenceState>((set) => ({
  remoteDrags: NONE,
  applyPresence: (remoteDrags) => set({ remoteDrags: remoteDrags.length === 0 ? NONE : remoteDrags }),
}));

/** What everyone else is dragging right now. */
export function useRemoteDrags(): RemoteDrag[] {
  return usePresence((s) => s.remoteDrags);
}
