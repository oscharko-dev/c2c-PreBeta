"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  ReactNode,
  useMemo,
  useCallback,
  useEffect,
} from "react";
import {
  TransformationRunState,
  RunPhase,
  HistoricalRunSnapshot,
} from "../types/run";
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
  ManualCompileRepairAcceptRequest,
  ManualCompileRepairAcceptResponse,
  ManualCompileRepairApplyRequest,
  ManualCompileRepairApplyResponse,
  ManualCompileRepairCandidateProject,
  ManualCompileRepairDiagnoseRequest,
  ManualCompileRepairDiagnoseResponse,
  ManualCompileRepairDiagnosis,
  ManualCompileRepairPreview,
  ManualCompileRepairPreviewRequest,
  ManualCompileRepairPreviewResponse,
  ManualCompileRepairProposal,
  ManualCompileRepairRejectResponse,
  ParityEvidenceExportRequest,
  ParityEvidenceExportResponse,
  IntentionalDivergenceDecisionRequest,
  IntentionalDivergenceDecisionResponse,
} from "../types/api";
import { deriveSourceHash } from "../lib/sourceAnalysis";
import {
  editorPersistence,
  getCurrentDraftScope,
  subscribeToDraftPersistenceEvents,
} from "../lib/editor/editorPersistence";
import type { DraftPayload } from "../lib/editor/editorPersistence";
import {
  applyMergeSelections,
  defaultRegionId,
  detectConflicts,
  type ConflictRegion,
  type ConflictRegionResolution,
} from "../lib/editor/conflictDetection";
import { computeManualEditOverlay } from "../lib/editor/manualEditOverlay";
import {
  appendJavaSnapshot,
  recordCobolByRun,
  type CobolSnapshot,
  type JavaFileHistoryEntry,
  type JavaFileSnapshot,
} from "../lib/editor/diffHistory";
import {
  bucketGenerateLatency,
  bucketThreeWayMergeRegionCount,
  emit as emitTelemetry,
} from "../lib/editor/editorTelemetry";

// Studio-IDE-3 (#247): Java buffer state model. One entry per generated
// Java file the user has interacted with. IDE-4 (#245) will wire Monaco
// `onChange` into `setJavaBufferContent`; until then the entry is hydrated
// from the BFF response and the user-edit story is the no-op identity.
export interface JavaBufferEntry {
  content: string;
  bufferHash: string;
  lastRunInputHash: string | null;
  lastRunInputContent: string | null;
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
  lastRunInputHash: string | null;
  resolvedBackendHash: string;
  draftProgramId: string;
  draftSourceName: string;
  generatorBaselineHash: string;
  generatorBaselineRunId: string;
  manualEditOverlay: JavaOriginOverlay | null;
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

export interface ManualDriftSummary {
  hasManualEdits: boolean;
  fileCount: number;
  regionCount: number;
  baselineRunIds: string[];
}

export interface ManualCompileRepairSession {
  status:
    | "idle"
    | "previewing"
    | "preview_ready"
    | "loading"
    | "ready"
    | "applying"
    | "sandbox_ready"
    | "accepting"
    | "rejecting"
    | "error";
  runId: string | null;
  preview: ManualCompileRepairPreview | null;
  entryFilePath: string | null;
  entryClass: string | null;
  diagnosis: ManualCompileRepairDiagnosis | null;
  proposal: ManualCompileRepairProposal | null;
  candidateProject: ManualCompileRepairCandidateProject | null;
  buildTest: ManualCompileRepairApplyResponse["buildTest"] | null;
  error: string | null;
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

export type GenerateTelemetryTrigger =
  | "generate"
  | "regenerate"
  | "generate_and_verify";

export interface GenerateTelemetryOptions {
  trigger: GenerateTelemetryTrigger;
  hadManualEdits: boolean;
}

interface PendingGenerateTelemetry {
  runId: string;
  startedAt: number;
}

export interface TransformationRunContextValue {
  state: TransformationRunState;
  productState: StateContext;
  startTransform: (
    request: TransformRequest,
    telemetry?: GenerateTelemetryOptions,
  ) => Promise<ApiResult<TransformResponse>>;
  // Studio-IDE-13 (#255): generator-only run kickoff. Identical semantics
  // to ``startTransform`` from the Studio's perspective; the BFF tags the
  // response with ``runMode: "generate"`` so observers can distinguish the
  // intent.
  startGenerate: (
    request: TransformRequest,
    telemetry?: GenerateTelemetryOptions,
  ) => Promise<ApiResult<GenerateResponse>>;
  // Studio-IDE-13 (#255): explicit Verify on the supplied javaFiles. The
  // optional ``manualEditOverlay`` is forwarded to the BFF which stamps
  // the run-summary manual-edit fields from it per ADR-0007 §4.
  startVerify: (request: VerifyRequest) => Promise<ApiResult<VerifyResponse>>;
  exportParityEvidenceScaffold: (
    request?: ParityEvidenceExportRequest,
  ) => Promise<ApiResult<ParityEvidenceExportResponse>>;
  intentionalDivergenceDecision:
    | IntentionalDivergenceDecisionResponse
    | null;
  intentionalDivergenceDecisionStatus:
    | "idle"
    | "saving"
    | "error";
  intentionalDivergenceDecisionError: string | null;
  submitIntentionalDivergenceDecision: (
    request: IntentionalDivergenceDecisionRequest,
  ) => Promise<ApiResult<IntentionalDivergenceDecisionResponse>>;
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
  saveJavaDraft: (
    filePath: string,
    options?: {
      content?: string;
      manualEditOverlay?: JavaOriginOverlay | null;
    },
  ) => Promise<void>;
  loadJavaDraftFor: (filePath: string, backendContent: string) => Promise<void>;
  resolveJavaConflict: (
    choice: "backendSample" | "localDraft" | "lastRunInput",
  ) => void;
  dismissJavaConflict: () => void;
  javaStatusFlags: (filePath: string) => JavaStatusFlags;
  manualDriftSummary: () => ManualDriftSummary;
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
  // Manual compile repair session state for the generated Java pane.
  manualCompileRepair: ManualCompileRepairSession | null;
  startManualCompileRepairPreview: (
    request: ManualCompileRepairPreviewRequest,
  ) => Promise<ApiResult<ManualCompileRepairPreviewResponse>>;
  startManualCompileRepairDiagnose: (
    request: ManualCompileRepairDiagnoseRequest,
  ) => Promise<ApiResult<ManualCompileRepairDiagnoseResponse>>;
  applyManualCompileRepair: () => Promise<ApiResult<ManualCompileRepairApplyResponse>>;
  acceptManualCompileRepair: () => Promise<ApiResult<ManualCompileRepairAcceptResponse>>;
  rejectManualCompileRepair: () => Promise<ApiResult<ManualCompileRepairRejectResponse>>;
  clearManualCompileRepair: () => void;
  // ----- Studio-IDE-7 (#252) synchronized-diff history ------------------
  // In-memory, session-scoped accumulator. Keyed by ``sourceKey`` (the
  // active programId; same convention as the BFF / ADR-0007). Java
  // history is a (previous, current) slot pair per (sourceKey, filePath);
  // COBOL snapshots are keyed by runId — DiffWorkspace looks up the
  // entries whose runIds match the Java history's previous and current
  // so the panes never desynchronize when failed runs sit between
  // successes (Copilot review #282).
  // Session-only persistence: a fresh ``idle`` phase from a new programId
  // or a hard reload clears these, consistent with the issue body.
  javaDiffHistory: Record<string, Record<string, JavaFileHistoryEntry>>;
  cobolDiffHistory: Record<string, Record<string, CobolSnapshot>>;
  recordJavaDiffSnapshot: (
    sourceKey: string,
    filePath: string,
    snapshot: JavaFileSnapshot,
  ) => void;
  recordCobolDiffSnapshot: (sourceKey: string, snapshot: CobolSnapshot) => void;
}

const TransformationRunContext =
  createContext<TransformationRunContextValue | null>(null);

function snapshotHistoricalRun(
  state: TransformationRunState,
): HistoricalRunSnapshot | null {
  if (
    !state.runId ||
    (!state.generated &&
      !state.generatedFiles &&
      !state.buildTest &&
      !state.evidence &&
      !state.summary)
  ) {
    return state.previousRun;
  }
  return {
    runId: state.runId,
    orchestratorRunId: state.orchestratorRunId,
    programId: state.programId,
    phase: state.phase,
    summary: state.summary,
    generated: state.generated,
    generatedFiles: state.generatedFiles,
    buildTest: state.buildTest,
    evidence: state.evidence,
    events: state.events,
    progress: state.progress,
    artifacts: state.artifacts,
    experience: state.experience,
    workflow: state.workflow,
  };
}

export function TransformationRunProvider({
  children,
}: {
  children: ReactNode;
}) {
  const isMountedRef = useRef(true);
  const activeTransformRequestRef = useRef(0);
  const activeManualCompileRepairRequestRef = useRef(0);
  const currentRunIdRef = useRef<string | null>(null);
  const pendingGenerateTelemetryRef =
    useRef<PendingGenerateTelemetry | null>(null);
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
    previousRun: null,
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
  const [manualCompileRepair, setManualCompileRepair] =
    useState<ManualCompileRepairSession | null>(null);
  const [intentionalDivergenceDecision, setIntentionalDivergenceDecision] =
    useState<IntentionalDivergenceDecisionResponse | null>(null);
  const [
    intentionalDivergenceDecisionStatus,
    setIntentionalDivergenceDecisionStatus,
  ] = useState<"idle" | "saving" | "error">("idle");
  const [
    intentionalDivergenceDecisionError,
    setIntentionalDivergenceDecisionError,
  ] = useState<string | null>(null);
  // Studio-IDE-7 (#252): per-program / per-file diff history. Held as
  // React state (not refs) so consumers re-render when a new snapshot
  // shifts the previous entry — the Compare Runs button needs to flip
  // from disabled to enabled the moment a second run lands.
  const [javaDiffHistory, setJavaDiffHistory] = useState<
    Record<string, Record<string, JavaFileHistoryEntry>>
  >({});
  const [cobolDiffHistory, setCobolDiffHistory] = useState<
    Record<string, Record<string, CobolSnapshot>>
  >({});

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    currentRunIdRef.current = state.runId;
  }, [state.runId]);

  useEffect(() => {
    return subscribeToDraftPersistenceEvents(() => {
      setJavaConflict(null);
      setSaveNoticeAt(null);
    });
  }, []);

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
        const perSource = prev[sourceKey];
        const next = recordCobolByRun(perSource, snapshot);
        if (next === perSource) {
          // Idempotent: same runId, same content. Preserve referential
          // identity so memoized DiffWorkspace consumers do not re-render.
          return prev;
        }
        return { ...prev, [sourceKey]: next };
      });
    },
    [],
  );

  const upsertJavaBuffersFromCandidateProject = useCallback(
    async (
      candidateProject: ManualCompileRepairCandidateProject,
      runId: string,
    ) => {
      const hashedFiles = await Promise.all(
        Object.entries(candidateProject.files).map(async ([filePath, content]) => {
          const hash = await deriveSourceHash(content);
          return { filePath, content, hash };
        }),
      );
      if (!isMountedRef.current) {
        return;
      }
      setJavaBuffers((prev) => {
        let next = prev;
        for (const { filePath, content, hash } of hashedFiles) {
          const existing = next[filePath];
          const updated = existing
            ? {
                ...existing,
                content,
                bufferHash: hash,
                isDirty: true,
              }
            : {
                content,
                bufferHash: hash,
                lastRunInputHash: null,
                lastRunInputContent: null,
                displayedArtifactSourceHash: hash,
                generatorBaselineContent: content,
                generatorBaselineHash: hash,
                generatorBaselineRunId: runId,
                manualEditOverlay: null,
                isDirty: true,
                lastSavedAt: null,
              };
          if (next === prev) {
            next = { ...prev };
          }
          next[filePath] = updated;
        }
        return next;
      });
    },
    [],
  );

  const productState = useMemo(() => deriveProductState(state), [state]);

  const emitGenerateResult = useCallback(
    (
      outcome: "success" | "merge_required" | "failed" | "cancelled",
      startedAt: number,
    ) => {
      emitTelemetry({
        eventType: "generate.result",
        payload: {
          outcome,
          latencyBucket: bucketGenerateLatency(Date.now() - startedAt),
        },
      });
    },
    [],
  );

  const recordGenerateResultWhenTerminal = useCallback(
    (runId: string, status: TransformResponse["status"], startedAt: number) => {
      if (status === "completed" || status === "failed") {
        emitGenerateResult(
          status === "completed" ? "success" : "failed",
          startedAt,
        );
        pendingGenerateTelemetryRef.current = null;
        return;
      }
      pendingGenerateTelemetryRef.current = { runId, startedAt };
    },
    [emitGenerateResult],
  );

  useEffect(() => {
    const pending = pendingGenerateTelemetryRef.current;
    const summary = state.summary;
    if (!pending || !summary || summary.runId !== pending.runId) {
      return;
    }
    if (summary.status !== "completed" && summary.status !== "failed") {
      return;
    }
    emitGenerateResult(
      summary.status === "completed" ? "success" : "failed",
      pending.startedAt,
    );
    pendingGenerateTelemetryRef.current = null;
  }, [emitGenerateResult, state.summary]);

  useRunPolling(state, setState);
  useGlobalObservabilityPolling(setState);

  const startTransform = async (
    request: TransformRequest,
    telemetry: GenerateTelemetryOptions = {
      trigger: "generate_and_verify",
      hadManualEdits: false,
    },
  ): Promise<ApiResult<TransformResponse>> => {
    const requestId = ++activeTransformRequestRef.current;
    emitTelemetry({
      eventType: "generate.invoked",
      payload: telemetry,
    });
    const startedAt = Date.now();
    currentRunIdRef.current = null;

    setState((prev) => ({
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
      modelGatewayHealth: prev.modelGatewayHealth,
      harnessReady: prev.harnessReady,
      workflow: null,
      previousRun: snapshotHistoricalRun(prev),
    }));
    setIntentionalDivergenceDecision(null);
    setIntentionalDivergenceDecisionStatus("idle");
    setIntentionalDivergenceDecisionError(null);

    const result = await apiClient.transform(request);

    if (requestId !== activeTransformRequestRef.current) {
      emitGenerateResult("cancelled", startedAt);
      return result;
    }

    if (!result.ok) {
      emitGenerateResult("failed", startedAt);
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
    recordGenerateResultWhenTerminal(
      result.data.runId,
      result.data.status,
      startedAt,
    );
    currentRunIdRef.current = result.data.runId;

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
    // the synchronized diff workflow has a per-runId snapshot the
    // workspace can pair against the Java history. Because COBOL is
    // keyed by runId (not a sliding previous/current slot), an
    // out-of-order hash resolution from an earlier submit is safe by
    // construction — the late write lands at its own ``[oldRunId]``
    // entry and cannot clobber the latest run's snapshot.
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
    telemetry: GenerateTelemetryOptions = {
      trigger: "generate",
      hadManualEdits: false,
    },
  ): Promise<ApiResult<GenerateResponse>> => {
    const requestId = ++activeTransformRequestRef.current;
    emitTelemetry({
      eventType: "generate.invoked",
      payload: telemetry,
    });
    const startedAt = Date.now();
    currentRunIdRef.current = null;

    setState((prev) => ({
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
      modelGatewayHealth: prev.modelGatewayHealth,
      harnessReady: prev.harnessReady,
      workflow: null,
      previousRun: snapshotHistoricalRun(prev),
    }));
    setIntentionalDivergenceDecision(null);
    setIntentionalDivergenceDecisionStatus("idle");
    setIntentionalDivergenceDecisionError(null);

    const result = await apiClient.generate(request);

    if (requestId !== activeTransformRequestRef.current) {
      emitGenerateResult("cancelled", startedAt);
      return result;
    }

    if (!result.ok) {
      emitGenerateResult("failed", startedAt);
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
    recordGenerateResultWhenTerminal(
      result.data.runId,
      result.data.status,
      startedAt,
    );
    currentRunIdRef.current = result.data.runId;

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
    // synchronized-diff history. Out-of-order hash resolution is safe
    // here too — see the corresponding note in ``startTransform``.
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
    // Studio-IDE-11 (#251): verify.invoked + verify.result with the
    // closed-enum outcome derived from the response classification.
    emitTelemetry({
      eventType: "verify.invoked",
      payload: {
        trigger: "toolbar",
        hadManualEdits: Boolean(
          request.manualEditOverlay || request.manualEditOverlays?.length,
        ),
      },
    });
    const result = await apiClient.verify(request);
    if (!result.ok) {
      emitTelemetry({
        eventType: "verify.result",
        payload: { outcome: "gateway_unavailable" },
      });
      return result;
    }
    const classification = result.data.classification;
    let outcome:
      | "success"
      | "compile_failed"
      | "run_failed"
      | "output_divergence"
      | "blocked"
      | "cancelled"
      | "gateway_unavailable" = "success";
    if (classification === "compile-error") outcome = "compile_failed";
    else if (classification === "run-error") outcome = "run_failed";
    else if (
      classification === "divergence-known-w0-coverage-gap" ||
      classification === "divergence-unknown" ||
      classification === "true-golden-master-mismatch" ||
      classification === "true-golden-master-reproduction-error"
    )
      outcome = "output_divergence";
    else if (classification === "skipped-no-execution") outcome = "blocked";
    emitTelemetry({
      eventType: "verify.result",
      payload: { outcome },
    });
    setLatestVerifyResult(result.data);
    return result;
  };

  const exportParityEvidenceScaffold = useCallback(
    async (
      request: ParityEvidenceExportRequest = {},
    ): Promise<ApiResult<ParityEvidenceExportResponse>> => {
      const runId = currentRunIdRef.current;
      if (!runId) {
        return {
          ok: false,
          message: "No completed run is available for export.",
        };
      }
      const result = await apiClient.exportParityEvidenceScaffold(runId, request);
      if (currentRunIdRef.current !== runId) {
        return {
          ok: false,
          message: "The active run changed before the export completed.",
        };
      }
      if (!result.ok) {
        return result;
      }
      setState((prev) => ({
        ...prev,
        evidence: prev.evidence
          ? {
              ...prev.evidence,
              exportRef: result.data.export.scaffoldRef,
            }
          : prev.evidence,
      }));
      return result;
    },
    [],
  );

  const submitIntentionalDivergenceDecision = useCallback(
    async (
      request: IntentionalDivergenceDecisionRequest,
    ): Promise<ApiResult<IntentionalDivergenceDecisionResponse>> => {
      const runId = currentRunIdRef.current;
      if (!runId) {
        return {
          ok: false,
          message: "No completed run is available for a divergence decision.",
        };
      }

      setIntentionalDivergenceDecisionStatus("saving");
      setIntentionalDivergenceDecisionError(null);

      const result = await apiClient.upsertIntentionalDivergenceDecision(
        runId,
        request,
      );
      if (currentRunIdRef.current !== runId) {
        setIntentionalDivergenceDecisionStatus("error");
        setIntentionalDivergenceDecisionError(
          "The active run changed before the divergence decision completed.",
        );
        return {
          ok: false,
          message: "The active run changed before the divergence decision completed.",
        };
      }

      if (!result.ok) {
        setIntentionalDivergenceDecisionStatus("error");
        setIntentionalDivergenceDecisionError(result.message);
        return result;
      }

      setIntentionalDivergenceDecision(result.data);
      setIntentionalDivergenceDecisionStatus("idle");
      setIntentionalDivergenceDecisionError(null);
      setState((prev) => {
        if (prev.runId !== runId) {
          return prev;
        }

        const trustSummary = result.data.trustSummary ?? prev.summary?.trustSummary ?? null;
        return {
          ...prev,
          summary: prev.summary
            ? {
                ...prev.summary,
                trustSummary,
              }
            : prev.summary,
          workflow: prev.workflow
            ? {
                ...prev.workflow,
                trustSummary,
              }
            : prev.workflow,
        };
      });

      return result;
    },
    [],
  );

  const clearManualCompileRepair = useCallback(() => {
    setManualCompileRepair(null);
  }, []);

  const startManualCompileRepairPreview = useCallback(
    async (
      request: ManualCompileRepairPreviewRequest,
    ): Promise<ApiResult<ManualCompileRepairPreviewResponse>> => {
      const requestId = ++activeManualCompileRepairRequestRef.current;
      setManualCompileRepair({
        status: "previewing",
        runId: request.runId,
        preview: null,
        entryFilePath: request.entryFilePath,
        entryClass: request.entryClass ?? null,
        diagnosis: null,
        proposal: null,
        candidateProject: null,
        buildTest: null,
        error: null,
      });
      const result = await apiClient.manualCompileRepairPreview(request);
      if (requestId !== activeManualCompileRepairRequestRef.current) {
        return result;
      }
      if (!result.ok) {
        setManualCompileRepair((prev) =>
          prev
            ? {
                ...prev,
                status: "error",
                error: result.message,
              }
            : prev,
        );
        return result;
      }
      setManualCompileRepair({
        status: "preview_ready",
        runId: result.data.runId,
        preview: result.data.preview,
        entryFilePath: request.entryFilePath,
        entryClass: request.entryClass ?? null,
        diagnosis: null,
        proposal: null,
        candidateProject: null,
        buildTest: null,
        error: null,
      });
      return result;
    },
    [],
  );

  const startManualCompileRepairDiagnose = useCallback(
    async (
      request: ManualCompileRepairDiagnoseRequest,
    ): Promise<ApiResult<ManualCompileRepairDiagnoseResponse>> => {
      const requestId = ++activeManualCompileRepairRequestRef.current;
      setManualCompileRepair((prev) =>
        prev
          ? {
              ...prev,
              status: "loading",
              error: null,
            }
          : {
              status: "loading",
              runId: request.runId,
              preview: null,
              entryFilePath: null,
              entryClass: null,
              diagnosis: null,
              proposal: null,
              candidateProject: null,
              buildTest: null,
              error: null,
            },
      );
      const result = await apiClient.manualCompileRepairDiagnose(request);
      if (requestId !== activeManualCompileRepairRequestRef.current) {
        return result;
      }
      if (!result.ok) {
        setManualCompileRepair((prev) =>
          prev
            ? {
                ...prev,
                status: "error",
                error: result.message,
              }
            : prev,
        );
        return result;
      }
      setManualCompileRepair((prev) => ({
        status: "ready",
        runId: result.data.runId,
        preview: prev?.preview ?? null,
        entryFilePath:
          prev?.entryFilePath ?? result.data.candidateProject.entryFilePath,
        entryClass: prev?.entryClass ?? result.data.candidateProject.entryClass,
        diagnosis: result.data.diagnosis,
        proposal: result.data.proposal,
        candidateProject: result.data.candidateProject,
        buildTest: result.data.buildTest,
        error: null,
      }));
      return result;
    },
    [],
  );

  const applyManualCompileRepair = useCallback(async (): Promise<
    ApiResult<ManualCompileRepairApplyResponse>
  > => {
    const session = manualCompileRepair;
    if (
      !session ||
      session.status !== "ready" ||
      !session.proposal ||
      !session.runId ||
      !session.preview
    ) {
      return { ok: false, message: "Manual compile repair is not ready." };
    }
    setManualCompileRepair((prev) =>
      prev
        ? {
            ...prev,
            status: "applying",
            error: null,
          }
        : prev,
    );
    const request: ManualCompileRepairApplyRequest = {
      runId: session.runId,
      previewId: session.preview.previewId,
      proposalId: session.proposal.proposalId,
      patchSha256: session.proposal.patchSha256 ?? "",
    };
    const result = await apiClient.manualCompileRepairApply(request);
    if (!result.ok) {
      setManualCompileRepair((prev) =>
        prev
          ? {
              ...prev,
              status: "error",
              error: result.message,
            }
          : prev,
      );
      return result;
    }
    setManualCompileRepair((prev) =>
      prev
        ? {
            ...prev,
            status: "sandbox_ready",
            proposal: result.data.proposal,
            candidateProject: result.data.candidateProject,
            buildTest: result.data.buildTest,
            error: null,
          }
        : prev,
    );
    return result;
  }, [manualCompileRepair]);

  const acceptManualCompileRepair = useCallback(async (): Promise<
    ApiResult<ManualCompileRepairAcceptResponse>
  > => {
    const session = manualCompileRepair;
    if (
      !session ||
      session.status !== "sandbox_ready" ||
      !session.proposal ||
      !session.candidateProject ||
      !session.runId
    ) {
      return { ok: false, message: "Sandboxed repair is not ready for acceptance." };
    }
    setManualCompileRepair((prev) =>
      prev
        ? {
            ...prev,
            status: "accepting",
            error: null,
          }
        : prev,
    );
    const request: ManualCompileRepairAcceptRequest = {
      runId: session.runId,
      proposalId: session.proposal.proposalId,
      patchSha256: session.proposal.patchSha256 ?? "",
    };
    const result = await apiClient.manualCompileRepairAccept(request);
    if (!result.ok) {
      setManualCompileRepair((prev) =>
        prev
          ? {
              ...prev,
              status: "error",
              error: result.message,
            }
          : prev,
      );
      return result;
    }
    void upsertJavaBuffersFromCandidateProject(
      result.data.candidateProject,
      result.data.runId,
    );
    setLatestVerifyResult(null);
    setManualCompileRepair(null);
    return result;
  }, [manualCompileRepair, upsertJavaBuffersFromCandidateProject]);

  const rejectManualCompileRepair = useCallback(async (): Promise<
    ApiResult<ManualCompileRepairRejectResponse>
  > => {
    const session = manualCompileRepair;
    if (!session || !session.proposal || !session.runId) {
      return { ok: false, message: "Manual compile repair is not ready." };
    }
    setManualCompileRepair((prev) =>
      prev
        ? {
            ...prev,
            status: "rejecting",
            error: null,
          }
        : prev,
    );
    const result = await apiClient.manualCompileRepairReject({
      runId: session.runId,
      proposalId: session.proposal.proposalId,
    });
    if (!result.ok) {
      setManualCompileRepair((prev) =>
        prev
          ? {
              ...prev,
              status: "error",
              error: result.message,
            }
          : prev,
      );
      return result;
    }
    setManualCompileRepair(null);
    return result;
  }, [manualCompileRepair]);

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
      const pending = pendingGenerateTelemetryRef.current;
      if (pending?.runId === input.newGeneratorRunId) {
        emitGenerateResult("merge_required", pending.startedAt);
        pendingGenerateTelemetryRef.current = null;
      }
      emitTelemetry({
        eventType: "three_way_merge.opened",
        payload: {
          regionCountBucket: bucketThreeWayMergeRegionCount(regions.length),
        },
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
    [emitGenerateResult],
  );

  const cancelJavaMergeReview = useCallback(() => {
    if (javaMergeReview) {
      emitTelemetry({
        eventType: "three_way_merge.resolved",
        payload: {
          regionsPickedPerSource: {
            manual: 0,
            new_generator: 0,
            baseline: 0,
          },
          cancelled: true,
        },
      });
    }
    setJavaMergeReview(null);
  }, [javaMergeReview]);

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
      const regionsPickedPerSource = {
        manual: 0,
        new_generator: 0,
        baseline: 0,
      };
      for (const region of review.regions) {
        const resolution =
          selectionMap.get(defaultRegionId(region)) ??
          region.suggestedResolution;
        if (resolution === "manual") {
          regionsPickedPerSource.manual += 1;
        } else if (resolution === "newGenerator") {
          regionsPickedPerSource.new_generator += 1;
        } else if (resolution === "baseline") {
          regionsPickedPerSource.baseline += 1;
        }
      }
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
            lastRunInputHash: newBaselineHash,
            lastRunInputContent: review.newGeneratorContent,
            displayedArtifactSourceHash: newBaselineHash,
            isDirty: merged !== review.newGeneratorContent,
          },
        };
      });

      setJavaMergeReview(null);
      emitTelemetry({
        eventType: "three_way_merge.resolved",
        payload: {
          regionsPickedPerSource,
          cancelled: false,
        },
      });
    },
    [javaMergeReview],
  );

  // ----- Java buffer helpers ------------------------------------------

  const ensureJavaBaseline = useCallback(
    async (filePath: string, backendContent: string, runId: string) => {
      const hash = await deriveSourceHash(backendContent);
      setJavaBuffers((prev) => {
        const existing = prev[filePath];
        // If the user already has a dirty buffer, do not overwrite content or
        // advance the baseline merely because a new run landed. The 3-Way
        // Merge review owns that transition. The only safe exception is when
        // the fresh generator output already equals the user's buffer; then
        // there is no merge decision to make and the buffer can become clean.
        if (existing && existing.isDirty) {
          if (existing.generatorBaselineRunId === runId) {
            return prev;
          }
          if (backendContent !== existing.content) {
            return prev;
          }
          return {
            ...prev,
            [filePath]: {
              ...existing,
              lastRunInputHash: hash,
              lastRunInputContent: backendContent,
              bufferHash: hash,
              generatorBaselineContent: backendContent,
              generatorBaselineHash: hash,
              generatorBaselineRunId: runId,
              displayedArtifactSourceHash: hash,
              isDirty: false,
            },
          };
        }
        return {
          ...prev,
          [filePath]: {
            content: backendContent,
            bufferHash: hash,
            lastRunInputHash: hash,
            lastRunInputContent: backendContent,
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
        if (!isMountedRef.current) {
          return;
        }
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
      for (const region of overlay?.regions ?? []) {
        if (
          region.originClass !== "manual_modified" &&
          region.originClass !== "manual_edit"
        ) {
          continue;
        }
        emitTelemetry({
          eventType: "manual_edit.region_classified",
          payload: {
            originClass: region.originClass,
            ...(region.mappingClass
              ? { mappingClass: region.mappingClass }
              : {}),
          },
        });
      }
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
    async (
      filePath: string,
      options?: {
        content?: string;
        manualEditOverlay?: JavaOriginOverlay | null;
      },
    ) => {
      const entry = javaBuffers[filePath];
      if (!entry) {
        return;
      }
      const programId = state.programId;
      if (!programId) {
        return;
      }
      const content = options?.content ?? entry.content;
      const bufferHash =
        options?.content === undefined
          ? entry.bufferHash
          : await deriveSourceHash(content);
      const manualEditOverlay =
        options?.manualEditOverlay !== undefined
          ? options.manualEditOverlay
          : options?.content !== undefined
            ? computeManualEditOverlay({
                baselineContent: entry.generatorBaselineContent,
                currentContent: content,
                runId: state.runId ?? entry.generatorBaselineRunId,
                javaFile: filePath,
                generatorBaselineRunId: entry.generatorBaselineRunId,
              })
            : entry.manualEditOverlay;
      const scope = await getCurrentDraftScope();
      const payload: DraftPayload = {
        schemaVersion: "v0",
        kind: "java",
        content,
        bufferHash,
        lastRunInputHash: entry.lastRunInputHash ?? undefined,
        lastRunInputContent: entry.lastRunInputContent ?? undefined,
        generatorBaselineHash: entry.generatorBaselineHash,
        generatorBaselineRunId: entry.generatorBaselineRunId,
        manualEditOverlay: manualEditOverlay ?? undefined,
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
          [filePath]: {
            ...existing,
            ...(options?.content !== undefined
              ? {
                  content,
                  bufferHash,
                  isDirty: content !== existing.generatorBaselineContent,
                }
              : {}),
            manualEditOverlay: manualEditOverlay ?? null,
            lastSavedAt: payload.savedAt,
          },
        };
      });
      setSaveNoticeAt(Date.now());
    },
    [javaBuffers, state.programId, state.runId],
  );

  const loadJavaDraftFor = useCallback(
    async (filePath: string, backendContent: string) => {
      const programId = state.programId;
      if (!programId) {
        return;
      }
      const scope = await getCurrentDraftScope();
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
      const backendHash = await deriveSourceHash(backendContent);
      if (
        loaded.payload.content !== backendContent &&
        loaded.payload.resolvedBackendHash !== backendHash
      ) {
        setJavaConflict({
          filePath,
          backendSample: backendContent,
          localDraft: loaded.payload.content,
          lastRunInput: loaded.payload.lastRunInputContent ?? "",
          lastRunInputHash: loaded.payload.lastRunInputHash ?? null,
          resolvedBackendHash: backendHash,
          draftProgramId: programId,
          draftSourceName: sourceName,
          generatorBaselineHash:
            loaded.payload.generatorBaselineHash ?? backendHash,
          generatorBaselineRunId:
            loaded.payload.generatorBaselineRunId ??
            state.runId ??
            "unknown",
          manualEditOverlay: loaded.payload.manualEditOverlay ?? null,
        });
        return;
      }
      setJavaBuffers((prev) => {
        const existing = prev[filePath];
        if (!existing) {
          return prev;
        }
        return {
          ...prev,
          [filePath]: {
            ...existing,
            content: loaded.payload.content,
            bufferHash: loaded.payload.bufferHash,
            lastRunInputHash:
              loaded.payload.lastRunInputHash ?? existing.lastRunInputHash,
            lastRunInputContent:
              loaded.payload.lastRunInputContent ?? existing.lastRunInputContent,
            manualEditOverlay: loaded.payload.manualEditOverlay ?? null,
            isDirty: loaded.payload.content !== existing.generatorBaselineContent,
            lastSavedAt: loaded.savedAt,
          },
        };
      });
    },
    [state.programId, state.runId],
  );

  const resolveJavaConflict = useCallback(
    (choice: "backendSample" | "localDraft" | "lastRunInput") => {
      setJavaConflict((current) => {
        if (!current) {
          return null;
        }
        const pick =
          choice === "backendSample"
            ? "backend_sample"
            : choice === "localDraft"
              ? "local_draft"
              : "last_run_input";
        emitTelemetry({
          eventType: "conflict.resolved",
          payload: { kind: "java", pick },
        });
        const chosen = current[choice];
        const manualEditOverlay =
          choice === "localDraft" ? current.manualEditOverlay : null;
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
              manualEditOverlay,
              isDirty: chosen !== existing.generatorBaselineContent,
            },
          };
        });
        void deriveSourceHash(chosen).then((hash) => {
          if (!isMountedRef.current) {
            return;
          }
          setJavaBuffers((prev) => {
            const existing = prev[current.filePath];
            if (!existing) {
              return prev;
            }
            return {
              ...prev,
              [current.filePath]: {
                ...existing,
                bufferHash: hash,
                lastRunInputContent: current.lastRunInput || null,
              },
            };
          });
          void getCurrentDraftScope()
            .then((scope) =>
              editorPersistence.saveDraft(
                scope,
                {
                  kind: "java",
                  programId: current.draftProgramId,
                  sourceName: current.draftSourceName,
                  javaFilePath: current.filePath,
                },
                {
                  schemaVersion: "v0",
                  kind: "java",
                  content: chosen,
                  bufferHash: hash,
                  lastRunInputHash: current.lastRunInputHash ?? undefined,
                  lastRunInputContent: current.lastRunInput || undefined,
                  generatorBaselineHash: current.generatorBaselineHash,
                  generatorBaselineRunId: current.generatorBaselineRunId,
                  manualEditOverlay: manualEditOverlay ?? undefined,
                  resolvedBackendHash: current.resolvedBackendHash,
                  savedAt: new Date().toISOString(),
                },
              ),
            )
            .catch(() => {
              // Keep the resolved buffer in memory. A later explicit save
              // will persist it if storage/session availability recovers.
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

  const manualDriftSummary = useCallback((): ManualDriftSummary => {
    const driftEntries = Object.values(javaBuffers).filter(
      (entry) =>
        entry.generatorBaselineHash.length > 0 &&
        entry.bufferHash !== entry.generatorBaselineHash,
    );
    const baselineRunIds = Array.from(
      new Set(driftEntries.map((entry) => entry.generatorBaselineRunId)),
    ).sort();
    const regionCount = driftEntries.reduce((count, entry) => {
      const manualRegions =
        entry.manualEditOverlay?.regions.filter(
          (region) =>
            region.originClass === "manual_modified" ||
            region.originClass === "manual_edit",
        ).length ?? 0;
      return count + manualRegions;
    }, 0);
    return {
      hasManualEdits: driftEntries.length > 0,
      fileCount: driftEntries.length,
      regionCount,
      baselineRunIds,
    };
  }, [javaBuffers]);

  return (
    <TransformationRunContext.Provider
      value={{
        state,
        productState,
        startTransform,
        startGenerate,
        startVerify,
        exportParityEvidenceScaffold,
        intentionalDivergenceDecision,
        intentionalDivergenceDecisionStatus,
        intentionalDivergenceDecisionError,
        submitIntentionalDivergenceDecision,
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
        manualDriftSummary,
        javaMergeReview,
        requestJavaMergeReview,
        applyJavaMergeSelections,
        cancelJavaMergeReview,
        javaDiffHistory,
        cobolDiffHistory,
        recordJavaDiffSnapshot,
        recordCobolDiffSnapshot,
        latestVerifyResult,
        manualCompileRepair,
        startManualCompileRepairPreview,
        startManualCompileRepairDiagnose,
        applyManualCompileRepair,
        acceptManualCompileRepair,
        rejectManualCompileRepair,
        clearManualCompileRepair,
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
