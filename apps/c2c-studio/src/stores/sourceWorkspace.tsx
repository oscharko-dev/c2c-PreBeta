"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  ReactNode,
} from "react";
import {
  DEFAULT_SOURCE_NAME,
  MAX_SOURCE_BYTES,
  getSourceByteSize,
  deriveSourceHash,
  deriveDetectedProgramId,
  deriveDraftProgramId,
} from "../lib/sourceAnalysis";
import {
  ApiResult,
  TransformResponse,
  GenerateResponse,
  TrustCasePreferenceResponse,
  TrustCaseSummary,
} from "../types/api";
import {
  useTransformationRun,
  type GenerateTelemetryOptions,
} from "./transformationRun";
import { apiClient } from "../lib/apiClient";
import {
  editorPersistence,
  getCurrentDraftScope,
  subscribeToDraftPersistenceEvents,
} from "../lib/editor/editorPersistence";
import type { DraftPayload } from "../lib/editor/editorPersistence";
import { emit as emitTelemetry } from "../lib/editor/editorTelemetry";

const HASH_DEBOUNCE_MS = 500;

// Conflict state shape — populated when the local draft disagrees with the
// backend content on file load. The CobolEditorPane consumes this to open
// the ConflictResolverDialog.
export interface CobolConflict {
  backendSample: string;
  localDraft: string;
  lastRunInput: string;
  draftProgramId: string;
  draftSourceName: string;
  lastRunInputHash: string | null;
  resolvedBackendHash: string;
}

// Status chip relationships. The editor renders these as small badges in
// the header: `clean` (all three hashes match), `pending re-run` (buffer
// differs from last-run input). `stale` is Java-only.
export interface CobolStatusFlags {
  clean: boolean;
  pendingReRun: boolean;
}

export interface SourceWorkspaceState {
  sourceText: string;
  isDirty: boolean;
  sourceName: string | null;
  sourceIdentityPath: string | null;
  expectedOutput: string;
  oracleInput: string;
  allowAiAssist: boolean;
  transformError: string | null;
  isTransforming: boolean;
  canSubmitTransform: boolean;
  canSubmitGenerate: boolean;
  trustCases: TrustCaseSummary[];
  selectedTrustCaseId: string | null;
  selectedTrustCase: TrustCaseSummary | null;
  trustCaseStatus: "idle" | "loading" | "ready" | "error";
  trustCaseError: string | null;
  trustCasePreferenceSavedAt: number | null;
  setSelectedTrustCaseId: (trustCaseId: string) => void;
  saveSelectedTrustCasePreference: () => Promise<
    ApiResult<TrustCasePreferenceResponse>
  >;
  // Studio-IDE-3 (#247): hash-relationship state for status chips and
  // conflict detection.
  bufferHash: string;
  lastRunInputHash: string | null;
  lastRunInputContent: string | null;
  statusFlags: CobolStatusFlags;
  conflict: CobolConflict | null;
  saveNoticeAt: number | null;
  programId: string | null;
  setSourceText: (text: string) => void;
  setSourceFile: (
    text: string,
    sourceName: string,
    sourceIdentityPath?: string | null,
    options?: SetSourceFileOptions,
  ) => void;
  setExpectedOutput: (text: string) => void;
  setOracleInput: (text: string) => void;
  setAllowAiAssist: (enabled: boolean) => void;
  clearWorkspace: () => void;
  // Composed Generate & Verify (renamed in toolbar but kept as
  // ``submitTransform`` here for backwards compatibility with existing
  // call sites and tests).
  submitTransform: (
    telemetry?: GenerateTelemetryOptions,
  ) => Promise<ApiResult<TransformResponse>>;
  // Studio-IDE-13 (#255): explicit Generator-Run-only action.
  // Equivalent inputs to ``submitTransform`` but invokes the
  // ``/api/v0/generate`` BFF endpoint (which the BFF tags with
  // ``runMode: "generate"``).
  submitGenerate: (
    telemetry?: GenerateTelemetryOptions,
  ) => Promise<ApiResult<GenerateResponse>>;
  // Studio-IDE-3 actions.
  saveDraftNow: () => Promise<void>;
  resolveConflict: (
    choice: "backendSample" | "localDraft" | "lastRunInput",
  ) => void;
  dismissConflict: () => void;
  loadDraftFor: (
    programId: string,
    sourceName: string,
    sourceIdentityPath?: string | null,
  ) => Promise<void>;
}

export interface SetSourceFileOptions {
  restoreDraft?: boolean;
}

const SourceWorkspaceContext = createContext<SourceWorkspaceState | null>(null);

export function SourceWorkspaceProvider({ children }: { children: ReactNode }) {
  const [sourceText, setSourceTextInternal] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [sourceIdentityPath, setSourceIdentityPath] = useState<string | null>(
    null,
  );
  const [expectedOutput, setExpectedOutputInternal] = useState("");
  const [oracleInput, setOracleInputInternal] = useState("");
  const [allowAiAssist, setAllowAiAssistInternal] = useState(true);
  const [transformError, setTransformError] = useState<string | null>(null);
  const [bufferHash, setBufferHash] = useState("00000000");
  const [lastRunInputHash, setLastRunInputHash] = useState<string | null>(null);
  const [lastRunInputContent, setLastRunInputContent] = useState<string | null>(
    null,
  );
  const [conflict, setConflict] = useState<CobolConflict | null>(null);
  const [saveNoticeAt, setSaveNoticeAt] = useState<number | null>(null);
  const [trustCases, setTrustCases] = useState<TrustCaseSummary[]>([]);
  const [selectedTrustCaseId, setSelectedTrustCaseIdInternal] = useState<
    string | null
  >(null);
  const [trustCaseStatus, setTrustCaseStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [trustCaseError, setTrustCaseError] = useState<string | null>(null);
  const [trustCasePreferenceSavedAt, setTrustCasePreferenceSavedAt] = useState<
    number | null
  >(null);
  const draftRestoreTokenRef = useRef(0);

  useEffect(() => {
    return subscribeToDraftPersistenceEvents(() => {
      setConflict(null);
      setSaveNoticeAt(null);
    });
  }, []);

  const {
    state: runState,
    startTransform,
    startGenerate,
  } = useTransformationRun();
  const isTransforming =
    runState.phase === "starting" || runState.phase === "running";
  const modelGatewayUnavailable =
    allowAiAssist && runState.modelGatewayHealth?.status === "unavailable";

  // The active parser/BFF programId for draft scoping. Before the first
  // successful transform, persistence falls back to a detected PROGRAM-ID
  // or a path-derived hash; unsourced pastes without either are skipped so
  // two files with the same display name cannot collide.
  const programId = runState.programId;
  const activeTrustCaseProgramId =
    programId ?? deriveDetectedProgramId(sourceText);
  const selectedTrustCase =
    trustCases.find((entry) => entry.trustCaseId === selectedTrustCaseId) ??
    null;

  useEffect(() => {
    if (!activeTrustCaseProgramId) {
      setTrustCases([]);
      setSelectedTrustCaseIdInternal(null);
      setTrustCaseStatus("idle");
      setTrustCaseError(null);
      setTrustCasePreferenceSavedAt(null);
      return;
    }
    let cancelled = false;
    setTrustCaseStatus("loading");
    setTrustCaseError(null);
    void apiClient.getTrustCases(activeTrustCaseProgramId).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setTrustCases([]);
        setSelectedTrustCaseIdInternal(null);
        setTrustCaseStatus("error");
        setTrustCaseError(result.message);
        return;
      }
      const available = result.data.trustCases;
      const saved = available.find(
        (entry) => entry.trustCaseId === result.data.savedTrustCaseId,
      );
      const fallback =
        available.find(
          (entry) => entry.trustCaseId === result.data.defaultTrustCaseId,
        ) ??
        available.find((entry) => entry.defaultForProgram) ??
        available[0] ??
        null;
      setTrustCases(available);
      setSelectedTrustCaseIdInternal((previous) => {
        const existing = available.find(
          (entry) => entry.trustCaseId === previous,
        );
        return (saved ?? existing ?? fallback)?.trustCaseId ?? null;
      });
      setTrustCaseStatus("ready");
      setTrustCaseError(
        available.length === 0
          ? `No trust cases are available for ${activeTrustCaseProgramId}.`
          : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [activeTrustCaseProgramId]);

  // Recompute buffer hash on every text change, debounced to 500 ms per
  // the ADR-2 §2 budget. The hash is purely a UI signal (status chips +
  // conflict detection); the editor is responsive regardless.
  useEffect(() => {
    const handle = setTimeout(() => {
      void deriveSourceHash(sourceText).then(setBufferHash);
    }, HASH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [sourceText]);

  // Capture the last-run-input hash whenever a transform completes. This
  // is what the `pending re-run` chip compares against.
  const lastSeenRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      runState.runId &&
      runState.phase === "completed" &&
      runState.runId !== lastSeenRunIdRef.current
    ) {
      lastSeenRunIdRef.current = runState.runId;
      const completedSourceText = sourceText;
      void deriveSourceHash(completedSourceText).then((hash) => {
        setLastRunInputHash(hash);
        setLastRunInputContent(completedSourceText);
      });
    }
  }, [runState.runId, runState.phase, sourceText]);

  const statusFlags: CobolStatusFlags = {
    clean: lastRunInputHash !== null && bufferHash === lastRunInputHash,
    pendingReRun: lastRunInputHash !== null && bufferHash !== lastRunInputHash,
  };

  const setSourceText = (text: string) => {
    draftRestoreTokenRef.current += 1;
    setSourceTextInternal(text);
    setIsDirty(true);
    setTransformError(null);
    setConflict(null);
    if (!sourceName) {
      setSourceName(DEFAULT_SOURCE_NAME);
      setSourceIdentityPath(null);
    }
  };

  const setSourceFile = (
    text: string,
    newSourceName: string,
    newSourceIdentityPath: string | null = null,
    options: SetSourceFileOptions = {},
  ) => {
    const effectiveSourceName = newSourceName || DEFAULT_SOURCE_NAME;
    const restoreToken = draftRestoreTokenRef.current + 1;
    draftRestoreTokenRef.current = restoreToken;
    setSourceTextInternal(text);
    setSourceName(effectiveSourceName);
    setSourceIdentityPath(newSourceIdentityPath);
    setExpectedOutputInternal("");
    setOracleInputInternal("");
    setIsDirty(false);
    setTransformError(null);
    setLastRunInputHash(null);
    setLastRunInputContent(null);
    setConflict(null);
    lastSeenRunIdRef.current = null;
    if (options.restoreDraft !== false) {
      void loadDraftForSource({
        backendSample: text,
        nextProgramId: null,
        nextSourceName: effectiveSourceName,
        nextSourceIdentityPath: newSourceIdentityPath,
        nextLastRunInputHash: null,
        restoreToken,
      }).catch(() => {
        // Draft restore is best-effort. File open should not fail just
        // because the session bootstrap or browser storage is unavailable.
      });
    }
  };

  const setExpectedOutput = (text: string) => {
    setExpectedOutputInternal(text);
    setTransformError(null);
  };

  const setOracleInput = (text: string) => {
    setOracleInputInternal(text);
    setTransformError(null);
  };

  const setAllowAiAssist = (enabled: boolean) => {
    setAllowAiAssistInternal(enabled);
    setTransformError(null);
  };

  const clearWorkspace = () => {
    draftRestoreTokenRef.current += 1;
    setSourceTextInternal("");
    setSourceName(null);
    setSourceIdentityPath(null);
    setExpectedOutputInternal("");
    setOracleInputInternal("");
    setAllowAiAssistInternal(true);
    setIsDirty(false);
    setTransformError(null);
    setLastRunInputHash(null);
    setLastRunInputContent(null);
    setBufferHash("00000000");
    setConflict(null);
    setSaveNoticeAt(null);
    setTrustCases([]);
    setSelectedTrustCaseIdInternal(null);
    setTrustCaseStatus("idle");
    setTrustCaseError(null);
    setTrustCasePreferenceSavedAt(null);
    lastSeenRunIdRef.current = null;
  };

  const setSelectedTrustCaseId = (trustCaseId: string) => {
    const selected = trustCases.find(
      (entry) => entry.trustCaseId === trustCaseId,
    );
    if (!selected) return;
    setSelectedTrustCaseIdInternal(selected.trustCaseId);
    setTrustCaseError(null);
    setTrustCasePreferenceSavedAt(null);
  };

  const saveSelectedTrustCasePreference = async (): Promise<
    ApiResult<TrustCasePreferenceResponse>
  > => {
    if (!activeTrustCaseProgramId || !selectedTrustCaseId) {
      const result = {
        ok: false,
        message: "Select a trust case before saving the preference.",
      } as const;
      setTrustCaseError(result.message);
      return result;
    }
    const result = await apiClient.saveTrustCasePreference(
      activeTrustCaseProgramId,
      selectedTrustCaseId,
    );
    if (result.ok) {
      setTrustCasePreferenceSavedAt(Date.now());
      setTrustCaseError(null);
    } else {
      setTrustCaseError(result.message);
    }
    return result;
  };

  const canSubmitTransform =
    sourceText.trim().length > 0 &&
    !isTransforming &&
    !modelGatewayUnavailable &&
    trustCaseStatus !== "loading" &&
    trustCaseStatus !== "error" &&
    (trustCases.length === 0 || selectedTrustCaseId !== null);
  const canSubmitGenerate =
    sourceText.trim().length > 0 && !isTransforming && !modelGatewayUnavailable;

  const submitTransform = async (
    telemetry: GenerateTelemetryOptions = {
      trigger: "generate_and_verify",
      hadManualEdits: false,
    },
  ): Promise<ApiResult<TransformResponse>> => {
    const trimmed = sourceText.trim();
    if (trimmed.length === 0) {
      const result = {
        ok: false,
        message: "Source text is required.",
      } as const;
      setTransformError(result.message);
      return result;
    }

    if (getSourceByteSize(sourceText) > MAX_SOURCE_BYTES) {
      const result = {
        ok: false,
        message: "Source text exceeds the 1 MB product-mode limit.",
      } as const;
      setTransformError(result.message);
      return result;
    }

    if (modelGatewayUnavailable) {
      const result = {
        ok: false,
        message:
          "AI Assist is enabled, but the Model Gateway is unavailable. Disable AI Assist to run deterministic-only.",
      } as const;
      setTransformError(result.message);
      return result;
    }

    if (trustCaseStatus === "loading") {
      const result = {
        ok: false,
        message: "Trust cases are still loading. Try again shortly.",
      } as const;
      setTransformError(result.message);
      return result;
    }

    if (trustCaseStatus === "error") {
      const result = {
        ok: false,
        message: trustCaseError ?? "Trust-case catalog is unavailable.",
      } as const;
      setTransformError(result.message);
      return result;
    }

    if (trustCases.length > 0 && !selectedTrustCaseId) {
      const result = {
        ok: false,
        message:
          "Select an immutable trust case before starting a parity-aware transformation.",
      } as const;
      setTransformError(result.message);
      return result;
    }

    setTransformError(null);

    const request = {
      sourceText,
      programId: undefined,
      sourceName: sourceName || DEFAULT_SOURCE_NAME,
      targetLanguage: "java",
      ...(selectedTrustCaseId
        ? { trustCaseId: selectedTrustCaseId }
        : {
            expectedOutput: expectedOutput.length > 0 ? expectedOutput : undefined,
            oracleInput: oracleInput.length > 0 ? oracleInput : undefined,
          }),
    } as const;

    const result = await startTransform(
      {
        ...request,
        useTransformationAgent: allowAiAssist,
      },
      telemetry,
    );

    if (!result.ok) {
      setTransformError(
        result.status === 503
          ? "Backend unavailable. Try again shortly."
          : result.message,
      );
    } else {
      // Snapshot the hash of the input we just sent so the status chip
      // can later detect divergence.
      const submittedSourceText = request.sourceText;
      void deriveSourceHash(submittedSourceText).then((hash) => {
        setLastRunInputHash(hash);
        setLastRunInputContent(submittedSourceText);
      });
    }

    return result;
  };

  // Studio-IDE-13 (#255): Generator-only submission. Mirrors
  // ``submitTransform`` validation but delegates to ``startGenerate`` so
  // the BFF tags the run with ``runMode: "generate"``. The Studio's
  // existing run-polling, generated-files hydration, and Java-buffer
  // baselining all keep working unchanged because the orchestrator
  // returns the same TransformResponse shape.
  const submitGenerate = async (
    telemetry: GenerateTelemetryOptions = {
      trigger: "generate",
      hadManualEdits: false,
    },
  ): Promise<ApiResult<GenerateResponse>> => {
    const trimmed = sourceText.trim();
    if (trimmed.length === 0) {
      const result = {
        ok: false,
        message: "Source text is required.",
      } as const;
      setTransformError(result.message);
      return result;
    }
    if (getSourceByteSize(sourceText) > MAX_SOURCE_BYTES) {
      const result = {
        ok: false,
        message: "Source text exceeds the 1 MB product-mode limit.",
      } as const;
      setTransformError(result.message);
      return result;
    }
    if (modelGatewayUnavailable) {
      const result = {
        ok: false,
        message:
          "AI Assist is enabled, but the Model Gateway is unavailable. Disable AI Assist to run deterministic-only.",
      } as const;
      setTransformError(result.message);
      return result;
    }
    setTransformError(null);
    const request = {
      sourceText,
      programId: undefined,
      sourceName: sourceName || DEFAULT_SOURCE_NAME,
      targetLanguage: "java",
      expectedOutput: expectedOutput.length > 0 ? expectedOutput : undefined,
      oracleInput: oracleInput.length > 0 ? oracleInput : undefined,
    } as const;
    const result = await startGenerate(
      {
        ...request,
        useTransformationAgent: allowAiAssist,
      },
      telemetry,
    );
    if (!result.ok) {
      setTransformError(
        result.status === 503
          ? "Backend unavailable. Try again shortly."
          : result.message,
      );
    } else {
      const submittedSourceText = request.sourceText;
      void deriveSourceHash(submittedSourceText).then((hash) => {
        setLastRunInputHash(hash);
        setLastRunInputContent(submittedSourceText);
      });
    }
    return result;
  };

  // ----- Persistence integration ---------------------------------------

  async function makeCobolKeyFor({
    currentProgramId,
    text,
    currentSourceName,
    currentSourceIdentityPath,
  }: {
    currentProgramId: string | null;
    text: string;
    currentSourceName: string;
    currentSourceIdentityPath: string | null;
  }) {
    const effectiveProgramId = await deriveDraftProgramId({
      parserProgramId: currentProgramId,
      detectedProgramId: deriveDetectedProgramId(text),
      sourceName: currentSourceName,
      normalizedPath: currentSourceIdentityPath,
    });
    if (!effectiveProgramId) {
      return null;
    }
    return {
      kind: "cobol" as const,
      programId: effectiveProgramId,
      sourceName: currentSourceName,
    };
  }

  const saveDraftNow = async (): Promise<void> => {
    if (sourceText.length === 0 && !isDirty) {
      return;
    }
    const scope = await getCurrentDraftScope();
    const key = await makeCobolKeyFor({
      currentProgramId: programId,
      text: sourceText,
      currentSourceName: sourceName ?? DEFAULT_SOURCE_NAME,
      currentSourceIdentityPath: sourceIdentityPath,
    });
    if (!key) {
      return;
    }
    const hash = await deriveSourceHash(sourceText);
    const payload: DraftPayload = {
      schemaVersion: "v0",
      kind: "cobol",
      content: sourceText,
      bufferHash: hash,
      lastRunInputHash: lastRunInputHash ?? undefined,
      lastRunInputContent: lastRunInputContent ?? undefined,
      savedAt: new Date().toISOString(),
    };
    await editorPersistence.saveDraft(scope, key, payload);
    setSaveNoticeAt(Date.now());
  };

  // Load a draft for the given identifying tuple. Used when the editor
  // mounts or when the user opens a sample. The caller passes the backend
  // content alongside (when relevant) — if the draft disagrees with the
  // backend content, we open the conflict resolver instead of silently
  // applying the draft.
  const loadDraftForSource = async ({
    backendSample,
    nextProgramId,
    nextSourceName,
    nextSourceIdentityPath,
    nextLastRunInputHash,
    restoreToken,
  }: {
    backendSample: string;
    nextProgramId: string | null;
    nextSourceName: string;
    nextSourceIdentityPath: string | null;
    nextLastRunInputHash: string | null;
    restoreToken?: number;
  }): Promise<void> => {
    const scope = await getCurrentDraftScope();
    const key = await makeCobolKeyFor({
      currentProgramId: nextProgramId,
      text: backendSample,
      currentSourceName: nextSourceName,
      currentSourceIdentityPath: nextSourceIdentityPath,
    });
    if (!key) return;
    const loaded = await editorPersistence.loadDraft(scope, key);
    if (
      restoreToken !== undefined &&
      restoreToken !== draftRestoreTokenRef.current
    ) {
      return;
    }
    if (!loaded || loaded.isExpired) {
      return;
    }
    const backendHash = backendSample
      ? await deriveSourceHash(backendSample)
      : "00000000";
    if (
      backendSample &&
      backendSample !== loaded.payload.content &&
      loaded.payload.resolvedBackendHash !== backendHash
    ) {
      setConflict({
        backendSample,
        localDraft: loaded.payload.content,
        lastRunInput: loaded.payload.lastRunInputContent ?? "",
        draftProgramId: key.programId,
        draftSourceName: key.sourceName,
        lastRunInputHash:
          loaded.payload.lastRunInputHash ?? nextLastRunInputHash,
        resolvedBackendHash: backendHash,
      });
      return;
    }
    setSourceTextInternal(loaded.payload.content);
    setSourceName(nextSourceName);
    setSourceIdentityPath(nextSourceIdentityPath);
    setIsDirty(false);
    if (loaded.payload.lastRunInputHash) {
      setLastRunInputHash(loaded.payload.lastRunInputHash);
    }
    if (loaded.payload.lastRunInputContent) {
      setLastRunInputContent(loaded.payload.lastRunInputContent);
    }
  };

  const loadDraftFor = async (
    nextProgramId: string,
    nextSourceName: string,
    nextSourceIdentityPath: string | null = sourceIdentityPath,
  ): Promise<void> => {
    await loadDraftForSource({
      backendSample: sourceText,
      nextProgramId,
      nextSourceName,
      nextSourceIdentityPath,
      nextLastRunInputHash: lastRunInputHash,
    });
  };

  const resolveConflict = (
    choice: "backendSample" | "localDraft" | "lastRunInput",
  ) => {
    if (!conflict) {
      return;
    }
    const pick =
      choice === "backendSample"
        ? "backend_sample"
        : choice === "localDraft"
          ? "local_draft"
          : "last_run_input";
    emitTelemetry({
      eventType: "conflict.resolved",
      payload: { kind: "cobol", pick },
    });
    const chosen = conflict[choice];
    setSourceTextInternal(chosen);
    setIsDirty(false);
    if (conflict.lastRunInputHash) {
      setLastRunInputHash(conflict.lastRunInputHash);
    }
    if (conflict.lastRunInput) {
      setLastRunInputContent(conflict.lastRunInput);
    }
    // Recompute hashes off the new content.
    void deriveSourceHash(chosen).then((hash) => {
      setBufferHash(hash);
      void getCurrentDraftScope()
        .then((scope) =>
          editorPersistence.saveDraft(
            scope,
            {
              kind: "cobol",
              programId: conflict.draftProgramId,
              sourceName: conflict.draftSourceName,
            },
            {
              schemaVersion: "v0",
              kind: "cobol",
              content: chosen,
              bufferHash: hash,
              lastRunInputHash: conflict.lastRunInputHash ?? undefined,
              lastRunInputContent: conflict.lastRunInput || undefined,
              resolvedBackendHash: conflict.resolvedBackendHash,
              savedAt: new Date().toISOString(),
            },
          ),
        )
        .catch(() => {
          // The in-memory resolution is authoritative for the current
          // session. If persistence is temporarily unavailable, the next
          // explicit save will write the resolved buffer.
        });
    });
    setConflict(null);
  };

  const dismissConflict = () => {
    setConflict(null);
  };

  return (
    <SourceWorkspaceContext.Provider
      value={{
        sourceText,
        isDirty,
        sourceName,
        sourceIdentityPath,
        expectedOutput,
        oracleInput,
        allowAiAssist,
      transformError,
      isTransforming,
      canSubmitTransform,
      canSubmitGenerate,
      trustCases,
        selectedTrustCaseId,
        selectedTrustCase,
        trustCaseStatus,
        trustCaseError,
        trustCasePreferenceSavedAt,
        bufferHash,
        lastRunInputHash,
        lastRunInputContent,
        statusFlags,
        conflict,
        saveNoticeAt,
        programId,
        setSourceText,
        setSourceFile,
        setExpectedOutput,
        setOracleInput,
        setAllowAiAssist,
        setSelectedTrustCaseId,
        saveSelectedTrustCasePreference,
        clearWorkspace,
        submitTransform,
        submitGenerate,
        saveDraftNow,
        resolveConflict,
        dismissConflict,
        loadDraftFor,
      }}
    >
      {children}
    </SourceWorkspaceContext.Provider>
  );
}

export function useSourceWorkspace() {
  const context = useContext(SourceWorkspaceContext);
  if (!context) {
    throw new Error(
      "useSourceWorkspace must be used within a SourceWorkspaceProvider",
    );
  }
  return context;
}
