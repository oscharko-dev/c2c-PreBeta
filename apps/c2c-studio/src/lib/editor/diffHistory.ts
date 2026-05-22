// Studio-IDE-7 (#252): per-file Java and per-(program, runId) COBOL diff history.
//
// Pure module. Holds no state of its own; callers (transformationRun.tsx)
// pass the previous history entry and a new snapshot and receive the
// next entry. The accumulator is deliberately ignorant of how snapshots
// are persisted — in V1 the store keeps history in React state which
// resets on reload. IndexedDB persistence is a W1 candidate per the
// issue body.
//
// Java shape per the issue spec:
//   { previous: { content, sourceHash, runId },
//     current:  { content, sourceHash, runId } }
//
// COBOL is keyed by runId (NOT a previous/current slot pair). DiffWorkspace
// selects ``cobolSnapshotsByRun[javaHistory.previous.runId]`` and
// ``cobolSnapshotsByRun[javaHistory.current.runId]`` so the two panes
// always reference the SAME run pair. Without this, a failed run between
// two successes would shift the COBOL slot but not the Java slot, leaving
// the displayed cause/effect pair mismatched (#282).
//
// Semantics:
//   - The first Java snapshot for a (sourceKey, filePath) becomes
//     ``current``; ``previous`` is null. The "no previous run" empty
//     state in DiffWorkspace renders against this.
//   - A later Java snapshot with a *different* runId shifts the existing
//     ``current`` into ``previous`` and installs the new snapshot as
//     ``current``.
//   - A Java snapshot with the *same* runId as the existing ``current``
//     is a no-op — re-polling the same run for the same file must never
//     destroy the "previous" entry.
//   - A COBOL snapshot is inserted by (sourceKey, runId). Repeat writes
//     for the same runId overwrite (same content for same run, so the
//     operation is idempotent in practice).

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

// Insert a COBOL snapshot into the per-(sourceKey) run-keyed map. The
// pure helper exists so the store action stays trivial and so test code
// can reason about the operation without instantiating React.
export function recordCobolByRun(
  prev: Record<string, CobolSnapshot> | undefined,
  snapshot: CobolSnapshot,
): Record<string, CobolSnapshot> {
  const existing = prev?.[snapshot.runId];
  if (
    existing &&
    existing.sourceHash === snapshot.sourceHash &&
    existing.content === snapshot.content
  ) {
    // Idempotent: same run, same content. Preserve referential identity
    // so memoized consumers do not re-render.
    return prev as Record<string, CobolSnapshot>;
  }
  return { ...(prev ?? {}), [snapshot.runId]: snapshot };
}

// Convenience: does this entry have content for both sides of a diff?
export function hasPreviousJava(
  entry: JavaFileHistoryEntry | undefined,
): entry is JavaFileHistoryEntry & { previous: JavaFileSnapshot } {
  return entry !== undefined && entry.previous !== null;
}
