"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  ReactNode,
  useMemo,
  useCallback,
} from "react";
import { TransformationRunState, RunPhase } from "../types/run";
import { deriveProductState, StateContext } from "../types/state";
import { apiClient } from "../lib/apiClient";
import { TransformRequest } from "../types/transform-request";
import {
  hydrateRunArtifacts,
  useRunPolling,
  useGlobalObservabilityPolling,
} from "../hooks/useRunPolling";
import {
  ApiResult,
  TransformResponse,
  JavaOriginOverlay,
  GenerateResponse,
  VerifyRequest,
  VerifyResponse,
} from "../types/api";
import { deriveSourceHash } from "../lib/sourceAnalysis";
import {
  editorPersistence,
  getCurrentDraftScope,
} from "../lib/editor/editorPersistence";
import type { DraftPayload } from "../lib/editor/editorPersistence";
import {
  applyMergeSelections,
  defaultRegionId,
  detectConflicts,
  type ConflictRegion,
  type ConflictRegionResolution,
} from "../lib/editor/conflictDetection";
import {
  appendCobolSnapshot,
  appendJavaSnapshot,
  type CobolHistoryEntry,
  type CobolSnapshot,
  type JavaFileHistoryEntry,
  type JavaFileSnapshot,
} from "../lib/editor/diffHistory";

// Studio-IDE-3 (#247): Java buffer state model. One entry per generated
// Java file the user has interacted with. IDE-4 (#245) will wire Monaco
// `onChange` into `setJavaBufferContent`; until then the entry is hydrated
// from the BFF response and the user-edit story is the no-op identity.
export interface JavaBufferEntry {
  content: string;
  bufferHash: string;
  lastRunInputHash: string | null;
  // Displayed artifact's source hash (sourced from traceability when
  // available; falls back to the hash of the BFF-delivered content).
  displayedArtifactSourceHash: string | null;
  generatorBaselineContent: string;
  generatorBaselineHash: string;
  generatorBaselineRunId: string;
  manualEditOverlay: JavaOriginOverlay | null;
  isDirty: boolean;
  lastSavedAt: string | null;
}

export interface JavaConflict {
  filePath: string;
  backendSample: string;
  localDraft: string;
  lastRunInput: string;
}

export interface JavaStatusFlags {
  clean: boolean;
  pendingReRun: boolean;
  staleJava: boolean;
  // V2 scope expansion (#247): true iff the user's Java buffer diverges
  // from the Generator Baseline content. Independent from the other
  // flags — a buffer can be both `manualEditsPresent` and `pendingReRun`
  // (user edited locally and has not yet re-run the transformation).
  manualEditsPresent: boolean;
}

// Studio-IDE-13 (#255): pending 3-Way Merge state. When non-null, the
// GeneratedJavaEditorPane mounts the ThreeWayMergeDialog and the user
// resolves it through ``applyMergeSelectionsAction`` or
// ``cancelMergeReview``. The conflicts list is computed up-front so the
// dialog can render the per-region UI without re-running the diff.
export interface JavaMergeReview {
  filePath: string;
  baselineContent: string;
  manualContent: string;
  newGeneratorContent: string;
  regions: ConflictRegion[];
  // The run that produced ``newGeneratorContent`` — used to update the
  // baseline metadata once the merge is applied.
  newGeneratorRunId: string;
}

export interface TransformationRunContextValue {
  state: TransformationRunState;
  productState: StateContext;
  startTransform: (
    request: TransformRequest,
  ) => Promise<ApiResult<TransformResponse>>;
  // Studio-IDE-13 (#255): generator-only run kickoff. Identical semantics
  // to ``startTransform`` from the Studio's perspective; the BFF tags the
  // response with ``runMode: "generate"`` so observers can distinguish the
  // intent.
  startGenerate: (
    request: TransformRequest,
  ) => Promise<ApiResult<GenerateResponse>>;
  // Studio-IDE-13 (#255): explicit Verify on the supplied javaFiles. The
  // optional ``manualEditOverlay`` is forwarded to the BFF which stamps
  // the run-summary manual-edit fields from it per ADR-0007 §4.
  startVerify: (request: VerifyRequest) => Promise<ApiResult<VerifyResponse>>;
  setState: React.Dispatch<React.SetStateAction<TransformationRunState>>;
  // ----- Studio-IDE-3 Java buffer model --------------------------------
  javaBuffers: Record<string, JavaBufferEntry>;
  javaConflict: JavaConflict | null;
  saveNoticeAt: number | null;
  ensureJavaBaseline: (
    filePath: string,
    backendContent: string,
    runId: string,
  ) => Promise<void>;
  setJavaBufferContent: (filePath: string, content: string) => void;
  setJavaManualOverlay: (
    filePath: string,
    overlay: JavaOriginOverlay | null,
  ) => void;
  saveJavaDraft: (filePath: string) => Promise<void>;
  loadJavaDraftFor: (filePath: string, backendContent: string) => Promise<void>;
  resolveJavaConflict: (
    choice: "backendSample" | "localDraft" | "lastRunInput",
  ) => void;
  dismissJavaConflict: () => void;
  javaStatusFlags: (filePath: string) => JavaStatusFlags;
  // ----- Studio-IDE-13 3-Way Merge state -------------------------------
  // Pending merge review (when non-null, the dialog is open).
  javaMergeReview: JavaMergeReview | null;
  // Open the 3-way merge dialog with the provided three texts. The store
  // computes the conflict regions internally so callers do not have to.
  requestJavaMergeReview: (input: {
    filePath: string;
    baselineContent: string;
    manualContent: string;
    newGeneratorContent: string;
    newGeneratorRunId: string;
  }) => void;
  // Apply the user's per-region selections to the buffer, update the
  // generator baseline metadata, and dismiss the dialog. ``selections``
  // is keyed by ``defaultRegionId(region)``.
  applyJavaMergeSelections: (
    selections: Record<string, ConflictRegionResolution>,
  ) => Promise<void>;
  // Dismiss the dialog without changing anything.
  cancelJavaMergeReview: () => void;
  // Latest VerifyResponse — surfaces the manual-edit summary fields to UI
  // consumers without re-fetching.
  latestVerifyResult: VerifyResponse | null;
  // ----- Studio-IDE-7 (#252) synchronized-diff history ------------------
  // In-memory, session-scoped accumulator. Keyed by ``sourceKey`` (the
  // active programId; same convention as the BFF / ADR-0007). Java
  // history is per-(sourceKey, filePath); COBOL history is per-sourceKey.
  // ``hydrateDiffHistory`` from useRunPolling does not reset these — only
  // ``setState`` to a fresh ``idle`` phase from a new programId or a hard
  // reload clears them, consistent with the issue body's session-only
  // persistence model.
  javaDiffHistory: Record<string, Record<string, JavaFileHistoryEntry>>;
  cobolDiffHistory: Record<string, CobolHistoryEntry>;
  recordJavaDiffSnapshot: (
    sourceKey: string,
    filePath: string,
    snapshot: JavaFileSnapshot,
  ) => void;
  recordCobolDiffSnapshot: (sourceKey: string, snapshot: CobolSnapshot) => void;
}

const TransformationRunContext =
  createContext<TransformationRunContextValue | null>(null);

export function TransformationRunProvider({
  children,
}: {
  children: ReactNode;
}) {
  const activeTransformRequestRef = useRef(0);
  const [state, setState] = useState<TransformationRunState>({
    phase: "idle",
    runId: null,
    orchestratorRunId: null,
    programId: null,
    error: null,
    artifactsError: null,
    summary: null,
    generated: null,
    generatedFiles: null,
    buildTest: null,
    evidence: null,
    events: null,
    progress: null,
    artifacts: null,
    experience: null,
    modelGatewayHealth: null,
    harnessReady: null,
    workflow: null,
  });
  const [javaBuffers, setJavaBuffers] = useState<
    Record<string, JavaBufferEntry>
  >({});
  const [javaConflict, setJavaConflict] = useState<JavaConflict | null>(null);
  const [saveNoticeAt, setSaveNoticeAt] = useState<number | null>(null);
  // Studio-IDE-13 (#255): pending 3-Way Merge state and latest verify
  // outcome. ``javaMergeReview`` is null when no dialog is open.
  const [javaMergeReview, setJavaMergeReview] =
    useState<JavaMergeReview | null>(null);
  const [latestVerifyResult, setLatestVerifyResult] =
    useState<VerifyResponse | null>(null);
  // Studio-IDE-7 (#252): per-program / per-file diff history. Held as
  // React state (not refs) so consumers re-render when a new snapshot
  // shifts the previous entry — the Compare Runs button needs to flip
  // from disabled to enabled the moment a second run lands.
  const [javaDiffHistory, setJavaDiffHistory] = useState<
    Record<string, Record<string, JavaFileHistoryEntry>>
  >({});
  const [cobolDiffHistory, setCobolDiffHistory] = useState<
    Record<string, CobolHistoryEntry>
  >({});

  const recordJavaDiffSnapshot = useCallback(
    (sourceKey: string, filePath: string, snapshot: JavaFileSnapshot) => {
      setJavaDiffHistory((prev) => {
        const perSource = prev[sourceKey] ?? {};
        const next = appendJavaSnapshot(perSource[filePath], snapshot);
        if (next === perSource[filePath]) {
          // Idempotent re-poll for the same runId; preserve referential
          // identity so memoized DiffWorkspace consumers do not re-render.
          return prev;
        }
        return {
          ...prev,
          [sourceKey]: { ...perSource, [filePath]: next },
        };
      });
    },
    [],
  );

  const recordCobolDiffSnapshot = useCallback(
    (sourceKey: string, snapshot: CobolSnapshot) => {
      setCobolDiffHistory((prev) => {
        const next = appendCobolSnapshot(prev[sourceKey], snapshot);
        if (next === prev[sourceKey]) {
          return prev;
        }
        return { ...prev, [sourceKey]: next };
      });
    },
    [],
  );

  const productState = useMemo(() => deriveProductState(state), [state]);

  useRunPolling(state, setState);
  useGlobalObservabilityPolling(setState);

  const startTransform = async (
    request: TransformRequest,
  ): Promise<ApiResult<TransformResponse>> => {
    const requestId = ++activeTransformRequestRef.current;

    setState({
      phase: "starting",
      runId: null,
      orchestratorRunId: null,
      programId: request.programId || null,
      error: null,
      artifactsError: null,
      summary: null,
      generated: null,
      generatedFiles: null,
      buildTest: null,
      evidence: null,
      events: null,
      progress: null,
      artifacts: null,
      experience: null,
      modelGatewayHealth: state.modelGatewayHealth,
      harnessReady: state.harnessReady,
      workflow: null,
    });

    const result = await apiClient.transform(request);

    if (requestId !== activeTransformRequestRef.current) {
      return result;
    }

    if (!result.ok) {
      setState((prev) => ({
        ...prev,
        phase: "failed",
        error:
          result.status === 503
            ? "Backend unavailable. Try again shortly."
            : result.message,
      }));
      return result;
    }

    setState((prev) => ({
      ...prev,
      phase:
        result.data.status === "completed" || result.data.status === "failed"
          ? (result.data.status as RunPhase)
          : "running",
      runId: result.data.runId,
      orchestratorRunId: result.data.orchestratorRunId,
      programId: result.data.programId,
      error: null,
      summary: result.data,
    }));

    // Studio-IDE-7 (#252): snapshot the COBOL input this run consumed so
    // the synchronized diff workflow has a previous→current pair to
    // diff against on the next run. Recording at submit-time (rather
    // than at completion) means a failed run still anchors history, so
    // the next successful run can be diffed against the failed attempt.
    const cobolRunId = result.data.runId;
    const cobolProgramId = result.data.programId;
    if (cobolProgramId) {
      void deriveSourceHash(request.sourceText).then((hash) => {
        recordCobolDiffSnapshot(cobolProgramId, {
          content: request.sourceText,
          sourceHash: hash,
          runId: cobolRunId,
        });
      });
    }

    if (result.data.status === "completed" || result.data.status === "failed") {
      void hydrateRunArtifacts(result.data.runId, setState, result.data.status);
    }

    return result;
  };

  // ----- Studio-IDE-13 generator-run actions ---------------------------

  // ``startGenerate`` mirrors ``startTransform`` exactly so the existing
  // run-polling, run-summary, and hydration code paths keep working
  // unchanged. The only difference on the wire is the ``runMode:
  // "generate"`` marker the BFF stamps on the response so the Studio
  // can later distinguish a generator-only run from the composed
  // Generate & Verify case. We funnel through the same request-id
  // counter so a Generate kicked off mid-Transform cancels the older
  // one safely.
  const startGenerate = async (
    request: TransformRequest,
  ): Promise<ApiResult<GenerateResponse>> => {
    const requestId = ++activeTransformRequestRef.current;

    setState({
      phase: "starting",
      runId: null,
      orchestratorRunId: null,
      programId: request.programId || null,
      error: null,
      artifactsError: null,
      summary: null,
      generated: null,
      generatedFiles: null,
      buildTest: null,
      evidence: null,
      events: null,
      progress: null,
      artifacts: null,
      experience: null,
      modelGatewayHealth: state.modelGatewayHealth,
      harnessReady: state.harnessReady,
      workflow: null,
    });

    const result = await apiClient.generate(request);

    if (requestId !== activeTransformRequestRef.current) {
      return result;
    }

    if (!result.ok) {
      setState((prev) => ({
        ...prev,
        phase: "failed",
        error:
          result.status === 503
            ? "Backend unavailable. Try again shortly."
            : result.message,
      }));
      return result;
    }

    setState((prev) => ({
      ...prev,
      phase:
        result.data.status === "completed" || result.data.status === "failed"
          ? (result.data.status as RunPhase)
          : "running",
      runId: result.data.runId,
      orchestratorRunId: result.data.orchestratorRunId,
      programId: result.data.programId,
      error: null,
      summary: result.data,
    }));

    // Studio-IDE-7 (#252): mirror the COBOL snapshot recorded by
    // ``startTransform`` so a Generator-only run also feeds the
    // synchronized-diff history.
    const cobolRunId = result.data.runId;
    const cobolProgramId = result.data.programId;
    if (cobolProgramId) {
      void deriveSourceHash(request.sourceText).then((hash) => {
        recordCobolDiffSnapshot(cobolProgramId, {
          content: request.sourceText,
          sourceHash: hash,
          runId: cobolRunId,
        });
      });
    }

    if (result.data.status === "completed" || result.data.status === "failed") {
      void hydrateRunArtifacts(result.data.runId, setState, result.data.status);
    }

    return result;
  };

  // ``startVerify`` is a stateless side-channel: it does not advance the
  // run phase or replace ``summary``. The result is surfaced through
  // ``latestVerifyResult`` so the UI can render the manual-edit summary
  // and the build/test classification without trampling the live run
  // state. Per ADR-0007 §1 verification is mandatory for ``success``;
  // this endpoint runs the full build/test/oracle pipeline on the
  // supplied javaFiles and returns the same shape regardless of how the
  // buffer was authored.
  const startVerify = async (
    request: VerifyRequest,
  ): Promise<ApiResult<VerifyResponse>> => {
    const result = await apiClient.verify(request);
    if (result.ok) {
      setLatestVerifyResult(result.data);
    }
    return result;
  };

  // ----- Studio-IDE-13 3-Way Merge -------------------------------------

  // The merge dialog is opened when the user invokes Generate/Regenerate
  // on a Java buffer that has manual edits OR when a new run lands while
  // the buffer is dirty. The store computes the conflict regions up
  // front so the dialog is a pure presentation component.
  const requestJavaMergeReview = useCallback(
    (input: {
      filePath: string;
      baselineContent: string;
      manualContent: string;
      newGeneratorContent: string;
      newGeneratorRunId: string;
    }) => {
      const regions = detectConflicts({
        baseline: input.baselineContent,
        manual: input.manualContent,
        newGenerator: input.newGeneratorContent,
      });
      setJavaMergeReview({
        filePath: input.filePath,
        baselineContent: input.baselineContent,
        manualContent: input.manualContent,
        newGeneratorContent: input.newGeneratorContent,
        newGeneratorRunId: input.newGeneratorRunId,
        regions,
      });
    },
    [],
  );

  const cancelJavaMergeReview = useCallback(() => {
    setJavaMergeReview(null);
  }, []);

  // Apply the user's per-region selections by composing a merged buffer
  // (``applyMergeSelections``) and writing it back through the same
  // ``setJavaBufferContent`` path the editor uses. The generator
  // baseline is advanced to the run that produced ``newGeneratorContent``
  // so the manual-edit overlay recomputation now diffs against the new
  // baseline. ``isDirty`` is recomputed naturally inside
  // ``setJavaBufferContent`` against the new baseline so a fully-merged
  // buffer that matches the new generator output reads as clean.
  const applyJavaMergeSelections = useCallback(
    async (
      selections: Record<string, ConflictRegionResolution>,
    ): Promise<void> => {
      const review = javaMergeReview;
      if (!review) return;

      const selectionMap = new Map<string, ConflictRegionResolution>(
        Object.entries(selections),
      );
      // ``applyMergeSelections`` throws ``UnresolvedMergeConflictError``
      // when a conflict region has no selection AND no suggested
      // resolution. The ThreeWayMergeDialog blocks Apply in that case,
      // so reaching this catch path is a programmer error — surface it
      // by leaving the merge review open and logging to console so the
      // user does not see a silently-corrupted buffer.
      let merged: string;
      try {
        merged = applyMergeSelections({
          baseline: review.baselineContent,
          regions: review.regions,
          selections: selectionMap,
          regionId: defaultRegionId,
        });
      } catch (err) {
        // Keep the dialog open; consumers can fix the selection and
        // re-Apply.
        if (typeof console !== "undefined" && console.error) {
          console.error("applyJavaMergeSelections refused merge: ", err);
        }
        return;
      }

      // Update generator baseline metadata first so subsequent overlay
      // recomputations diff against the new baseline rather than the
      // pre-merge one.
      const newBaselineHash = await deriveSourceHash(
        review.newGeneratorContent,
      );
      const newBufferHash = await deriveSourceHash(merged);
      setJavaBuffers((prev) => {
        const existing = prev[review.filePath];
        if (!existing) return prev;
        return {
          ...prev,
          [review.filePath]: {
            ...existing,
            content: merged,
            bufferHash: newBufferHash,
            generatorBaselineContent: review.newGeneratorContent,
            generatorBaselineHash: newBaselineHash,
            generatorBaselineRunId: review.newGeneratorRunId,
            isDirty: merged !== review.newGeneratorContent,
          },
        };
      });

      setJavaMergeReview(null);
    },
    [javaMergeReview],
  );

  // ----- Java buffer helpers ------------------------------------------

  const ensureJavaBaseline = useCallback(
    async (filePath: string, backendContent: string, runId: string) => {
      const hash = await deriveSourceHash(backendContent);
      setJavaBuffers((prev) => {
        const existing = prev[filePath];
        // If the user already has a dirty buffer, do not overwrite content;
        // only refresh the generator baseline metadata if the run changed.
        if (existing && existing.isDirty) {
          if (existing.generatorBaselineRunId === runId) {
            return prev;
          }
          return {
            ...prev,
            [filePath]: {
              ...existing,
              generatorBaselineContent: backendContent,
              generatorBaselineHash: hash,
              generatorBaselineRunId: runId,
              displayedArtifactSourceHash: hash,
            },
          };
        }
        return {
          ...prev,
          [filePath]: {
            content: backendContent,
            bufferHash: hash,
            lastRunInputHash: existing?.lastRunInputHash ?? hash,
            displayedArtifactSourceHash: hash,
            generatorBaselineContent: backendContent,
            generatorBaselineHash: hash,
            generatorBaselineRunId: runId,
            manualEditOverlay: existing?.manualEditOverlay ?? null,
            isDirty: false,
            lastSavedAt: existing?.lastSavedAt ?? null,
          },
        };
      });
    },
    [],
  );

  const setJavaBufferContent = useCallback(
    (filePath: string, content: string) => {
      setJavaBuffers((prev) => {
        const existing = prev[filePath];
        if (!existing) {
          return prev;
        }
        return {
          ...prev,
          [filePath]: {
            ...existing,
            content,
            isDirty: content !== existing.generatorBaselineContent,
          },
        };
      });
      // Recompute the buffer hash asynchronously so the chip can react.
      void deriveSourceHash(content).then((hash) => {
        setJavaBuffers((prev) => {
          const existing = prev[filePath];
          if (!existing || existing.content !== content) {
            return prev;
          }
          return {
            ...prev,
            [filePath]: { ...existing, bufferHash: hash },
          };
        });
      });
    },
    [],
  );

  const setJavaManualOverlay = useCallback(
    (filePath: string, overlay: JavaOriginOverlay | null) => {
      setJavaBuffers((prev) => {
        const existing = prev[filePath];
        if (!existing) {
          return prev;
        }
        return {
          ...prev,
          [filePath]: { ...existing, manualEditOverlay: overlay },
        };
      });
    },
    [],
  );

  const saveJavaDraft = useCallback(
    async (filePath: string) => {
      const entry = javaBuffers[filePath];
      if (!entry) {
        return;
      }
      const programId = state.programId;
      if (!programId) {
        return;
      }
      const scope = getCurrentDraftScope();
      const payload: DraftPayload = {
        schemaVersion: "v0",
        kind: "java",
        content: entry.content,
        bufferHash: entry.bufferHash,
        lastRunInputHash: entry.lastRunInputHash ?? undefined,
        generatorBaselineHash: entry.generatorBaselineHash,
        generatorBaselineRunId: entry.generatorBaselineRunId,
        manualEditOverlay: entry.manualEditOverlay ?? undefined,
        savedAt: new Date().toISOString(),
      };
      const sourceName = filePath.split("/").pop() ?? filePath;
      await editorPersistence.saveDraft(
        scope,
        {
          kind: "java",
          programId,
          sourceName,
          javaFilePath: filePath,
        },
        payload,
      );
      setJavaBuffers((prev) => {
        const existing = prev[filePath];
        if (!existing) {
          return prev;
        }
        return {
          ...prev,
          [filePath]: { ...existing, lastSavedAt: payload.savedAt },
        };
      });
      setSaveNoticeAt(Date.now());
    },
    [javaBuffers, state.programId],
  );

  const loadJavaDraftFor = useCallback(
    async (filePath: string, backendContent: string) => {
      const programId = state.programId;
      if (!programId) {
        return;
      }
      const scope = getCurrentDraftScope();
      const sourceName = filePath.split("/").pop() ?? filePath;
      const loaded = await editorPersistence.loadDraft(scope, {
        kind: "java",
        programId,
        sourceName,
        javaFilePath: filePath,
      });
      if (!loaded || loaded.isExpired) {
        return;
      }
      if (loaded.payload.content !== backendContent) {
        setJavaConflict({
          filePath,
          backendSample: backendContent,
          localDraft: loaded.payload.content,
          lastRunInput: loaded.payload.lastRunInputHash ? backendContent : "",
        });
        return;
      }
      // Same content; restore overlay if present.
      if (loaded.payload.manualEditOverlay) {
        setJavaManualOverlay(filePath, loaded.payload.manualEditOverlay);
      }
    },
    [state.programId, setJavaManualOverlay],
  );

  const resolveJavaConflict = useCallback(
    (choice: "backendSample" | "localDraft" | "lastRunInput") => {
      setJavaConflict((current) => {
        if (!current) {
          return null;
        }
        const chosen = current[choice];
        setJavaBuffers((prev) => {
          const existing = prev[current.filePath];
          if (!existing) {
            return prev;
          }
          return {
            ...prev,
            [current.filePath]: {
              ...existing,
              content: chosen,
              isDirty: chosen !== existing.generatorBaselineContent,
            },
          };
        });
        void deriveSourceHash(chosen).then((hash) => {
          setJavaBuffers((prev) => {
            const existing = prev[current.filePath];
            if (!existing) {
              return prev;
            }
            return {
              ...prev,
              [current.filePath]: { ...existing, bufferHash: hash },
            };
          });
        });
        return null;
      });
    },
    [],
  );

  const dismissJavaConflict = useCallback(() => {
    setJavaConflict(null);
  }, []);

  const javaStatusFlags = useCallback(
    (filePath: string): JavaStatusFlags => {
      const entry = javaBuffers[filePath];
      if (!entry) {
        return {
          clean: false,
          pendingReRun: false,
          staleJava: false,
          manualEditsPresent: false,
        };
      }
      const buffer = entry.bufferHash;
      const lastInput = entry.lastRunInputHash;
      const displayed = entry.displayedArtifactSourceHash;
      const baseline = entry.generatorBaselineHash;
      const clean =
        lastInput !== null &&
        displayed !== null &&
        buffer === lastInput &&
        buffer === displayed;
      const pendingReRun = lastInput !== null && buffer !== lastInput;
      const staleJava =
        lastInput !== null && displayed !== null && displayed !== lastInput;
      // The Generator Baseline is always populated for an entry that
      // exists (ensureJavaBaseline seeds it on first content delivery).
      // The chip fires when the live buffer hash differs from the
      // baseline hash — this is the V2 #247 "manual edits present"
      // surface. It is *not* the same as `isDirty`: a user who edits and
      // then reverts to the exact baseline content gets the chip cleared.
      const manualEditsPresent = baseline.length > 0 && buffer !== baseline;
      return { clean, pendingReRun, staleJava, manualEditsPresent };
    },
    [javaBuffers],
  );

  return (
    <TransformationRunContext.Provider
      value={{
        state,
        productState,
        startTransform,
        startGenerate,
        startVerify,
        setState,
        javaBuffers,
        javaConflict,
        saveNoticeAt,
        ensureJavaBaseline,
        setJavaBufferContent,
        setJavaManualOverlay,
        saveJavaDraft,
        loadJavaDraftFor,
        resolveJavaConflict,
        dismissJavaConflict,
        javaStatusFlags,
        javaMergeReview,
        requestJavaMergeReview,
        applyJavaMergeSelections,
        cancelJavaMergeReview,
        javaDiffHistory,
        cobolDiffHistory,
        recordJavaDiffSnapshot,
        recordCobolDiffSnapshot,
        latestVerifyResult,
      }}
    >
      {children}
    </TransformationRunContext.Provider>
  );
}

export function useTransformationRun() {
  const context = useContext(TransformationRunContext);
  if (!context) {
    throw new Error(
      "useTransformationRun must be used within a TransformationRunProvider",
    );
  }
  return context;
}
