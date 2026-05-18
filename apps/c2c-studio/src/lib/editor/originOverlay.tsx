"use client";

// Studio-IDE-4 (#245): OriginOverlayProvider — the empty / pass-through
// overlay context for the Java editor. This slice ships the *contract*; the
// data that drives the regions is populated by downstream slices:
//
//   - IDE-6  (#248) sets overlays with `deterministic`, `agent_proposed`,
//             and `repair_attempted` regions, which drive trust-pillar
//             decorations in the Java pane.
//   - IDE-13 (#255) updates overlays with `manual_modified` and
//             `manual_edit` regions when the developer edits a Java buffer
//             and the manual-edit governance flow runs.
//
// The provider keeps a `Map<"<runId>::<javaFile>", JavaOriginOverlay>` so
// that two overlays for different (runId, javaFile) pairs never collide and
// can be tracked independently. The hook `useOverlay(runId, javaFile)`
// returns `null` until the matching `setOverlay` call lands.
//
// Wiring contract for IDE-6 / IDE-13 implementors:
//   1. Wrap the Studio shell in <OriginOverlayProvider> exactly once
//      (already done in WorkbenchShell.tsx).
//   2. Call `useOriginOverlayApi().setOverlay(runId, javaFile, overlay)` to
//      publish a new overlay. Pass `null` to clear it.
//   3. Call `useOverlay(runId, javaFile)` from the Java editor decoration
//      provider to read the current overlay reactively.
//   4. Treat the `JavaOriginOverlay` envelope as opaque pass-through when
//      serializing to IndexedDB (Studio-IDE-3 already does so).

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { JavaOriginOverlay } from "../../types/api";

interface OriginOverlayApi {
  setOverlay: (
    runId: string,
    javaFile: string,
    overlay: JavaOriginOverlay | null,
  ) => void;
  clearOverlaysForRun: (runId: string) => void;
}

interface OriginOverlayContextValue {
  // Read-only map keyed by `<runId>::<javaFile>`. Consumers should use the
  // `useOverlay` hook rather than reading directly so unrelated overlay
  // updates do not trigger unnecessary re-renders elsewhere — but the map
  // is exposed for tests and rare bulk-inspection use cases.
  overlays: ReadonlyMap<string, JavaOriginOverlay>;
  api: OriginOverlayApi;
}

const OriginOverlayContext = createContext<OriginOverlayContextValue | null>(
  null,
);

function overlayKey(runId: string, javaFile: string): string {
  return `${runId}::${javaFile}`;
}

export function OriginOverlayProvider({ children }: { children: ReactNode }) {
  const [overlays, setOverlays] = useState<Map<string, JavaOriginOverlay>>(
    () => new Map(),
  );

  const setOverlay = useCallback(
    (runId: string, javaFile: string, overlay: JavaOriginOverlay | null) => {
      setOverlays((prev) => {
        const key = overlayKey(runId, javaFile);
        const next = new Map(prev);
        if (overlay === null) {
          if (!next.delete(key)) {
            return prev;
          }
          return next;
        }
        next.set(key, overlay);
        return next;
      });
    },
    [],
  );

  const clearOverlaysForRun = useCallback((runId: string) => {
    const prefix = `${runId}::`;
    setOverlays((prev) => {
      let mutated = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (key.startsWith(prefix)) {
          next.delete(key);
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });
  }, []);

  const api = useMemo<OriginOverlayApi>(
    () => ({ setOverlay, clearOverlaysForRun }),
    [setOverlay, clearOverlaysForRun],
  );

  const value = useMemo<OriginOverlayContextValue>(
    () => ({ overlays, api }),
    [overlays, api],
  );

  return (
    <OriginOverlayContext.Provider value={value}>
      {children}
    </OriginOverlayContext.Provider>
  );
}

function useOriginOverlayContext(): OriginOverlayContextValue {
  const ctx = useContext(OriginOverlayContext);
  if (!ctx) {
    throw new Error(
      "OriginOverlay hooks must be used within an OriginOverlayProvider",
    );
  }
  return ctx;
}

export function useOverlay(
  runId: string | null | undefined,
  javaFile: string | null | undefined,
): JavaOriginOverlay | null {
  const { overlays } = useOriginOverlayContext();
  if (!runId || !javaFile) {
    return null;
  }
  return overlays.get(overlayKey(runId, javaFile)) ?? null;
}

export function useOriginOverlayApi(): OriginOverlayApi {
  return useOriginOverlayContext().api;
}
