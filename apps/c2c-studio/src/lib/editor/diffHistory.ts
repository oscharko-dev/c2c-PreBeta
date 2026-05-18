// Studio-IDE-7 (#252): per-file Java and per-program COBOL diff history.
//
// Pure module. Holds no state of its own; callers (transformationRun.tsx)
// pass the previous history entry and a new snapshot and receive the
// next entry. The accumulator is deliberately ignorant of how snapshots
// are persisted — in V1 the store keeps history in React state which
// resets on reload. IndexedDB persistence is a W1 candidate per the
// issue body.
//
// Shape per the issue spec:
//   { previous: { content, sourceHash, runId },
//     current:  { content, sourceHash, runId } }
//
// Semantics:
//   - The first snapshot for a (sourceKey, filePath) becomes ``current``;
//     ``previous`` is null. The "no previous run" empty state in
//     DiffWorkspace renders against this.
//   - A later snapshot with a *different* runId shifts the existing
//     ``current`` into ``previous`` and installs the new snapshot as
//     ``current``.
//   - A snapshot with the *same* runId as the existing ``current`` is a
//     no-op — re-polling the same run for the same file must never
//     destroy the "previous" entry. (Without this guard, opening the
//     workspace twice in one run would silently break the diff.)

export interface JavaFileSnapshot {
  content: string;
  sourceHash: string;
  runId: string;
}

export interface JavaFileHistoryEntry {
  previous: JavaFileSnapshot | null;
  current: JavaFileSnapshot;
}

export interface CobolSnapshot {
  content: string;
  sourceHash: string;
  runId: string;
}

export interface CobolHistoryEntry {
  previous: CobolSnapshot | null;
  current: CobolSnapshot;
}

export function appendJavaSnapshot(
  prev: JavaFileHistoryEntry | undefined,
  next: JavaFileSnapshot,
): JavaFileHistoryEntry {
  if (!prev) {
    return { previous: null, current: next };
  }
  if (prev.current.runId === next.runId) {
    return prev;
  }
  return { previous: prev.current, current: next };
}

export function appendCobolSnapshot(
  prev: CobolHistoryEntry | undefined,
  next: CobolSnapshot,
): CobolHistoryEntry {
  if (!prev) {
    return { previous: null, current: next };
  }
  if (prev.current.runId === next.runId) {
    return prev;
  }
  return { previous: prev.current, current: next };
}

// Convenience: does this entry have content for both sides of a diff?
export function hasPreviousJava(
  entry: JavaFileHistoryEntry | undefined,
): entry is JavaFileHistoryEntry & { previous: JavaFileSnapshot } {
  return entry !== undefined && entry.previous !== null;
}

export function hasPreviousCobol(
  entry: CobolHistoryEntry | undefined,
): entry is CobolHistoryEntry & { previous: CobolSnapshot } {
  return entry !== undefined && entry.previous !== null;
}
