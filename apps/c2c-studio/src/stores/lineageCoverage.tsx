"use client";

// Studio-IDE-6 (#248): tiny store that publishes the lineage-coverage
// percentage of the currently-displayed Java file. The Java pane writes
// to it whenever the overlay or the buffer length changes; the StatusBar
// reads from it. The store keeps a single (filePath, pct) pair — when no
// file is selected the value is null.
//
// Why a dedicated store instead of extending `transformationRun`:
//   * `transformationRun.tsx` is already 486 lines and has a wide
//     surface area. Adding lineage coverage there would couple the
//     trust-pillar overlay to the run lifecycle.
//   * The data is purely derived from BFF responses; no run mutation
//     ever depends on it. Keeping it in its own store means the
//     coverage signal can swap implementations (overlay → live editor
//     model) later without touching the run plumbing.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface LineageCoverageEntry {
  /** Absolute generated-Java file path the coverage was computed for. */
  filePath: string;
  /** Integer 0..100. */
  pct: number;
}

interface LineageCoverageApi {
  publish: (entry: LineageCoverageEntry | null) => void;
}

interface LineageCoverageContextValue {
  current: LineageCoverageEntry | null;
  api: LineageCoverageApi;
}

const LineageCoverageContext =
  createContext<LineageCoverageContextValue | null>(null);

export function LineageCoverageProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<LineageCoverageEntry | null>(null);

  const publish = useCallback((entry: LineageCoverageEntry | null) => {
    setCurrent(entry);
  }, []);

  const api = useMemo<LineageCoverageApi>(() => ({ publish }), [publish]);
  const value = useMemo<LineageCoverageContextValue>(
    () => ({ current, api }),
    [current, api],
  );

  return (
    <LineageCoverageContext.Provider value={value}>
      {children}
    </LineageCoverageContext.Provider>
  );
}

function useLineageCoverageContext(): LineageCoverageContextValue {
  const ctx = useContext(LineageCoverageContext);
  if (!ctx) {
    throw new Error(
      "Lineage coverage hooks must be used within a LineageCoverageProvider",
    );
  }
  return ctx;
}

export function useLineageCoverage(): LineageCoverageEntry | null {
  return useLineageCoverageContext().current;
}

export function useLineageCoverageApi(): LineageCoverageApi {
  return useLineageCoverageContext().api;
}
