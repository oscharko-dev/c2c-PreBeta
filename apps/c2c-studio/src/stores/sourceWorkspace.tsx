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
} from "../lib/sourceAnalysis";
import { ApiResult, TransformResponse, GenerateResponse } from "../types/api";
import { useTransformationRun } from "./transformationRun";
import {
  editorPersistence,
  getCurrentDraftScope,
} from "../lib/editor/editorPersistence";
import type { DraftPayload } from "../lib/editor/editorPersistence";

const HASH_DEBOUNCE_MS = 500;

// Conflict state shape — populated when the local draft disagrees with the
// backend content on file load. The CobolEditorPane consumes this to open
// the ConflictResolverDialog.
export interface CobolConflict {
  backendSample: string;
  localDraft: string;
  lastRunInput: string;
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
  expectedOutput: string;
  oracleInput: string;
  allowAiAssist: boolean;
  transformError: string | null;
  isTransforming: boolean;
  canSubmitTransform: boolean;
  // Studio-IDE-3 (#247): hash-relationship state for status chips and
  // conflict detection.
  bufferHash: string;
  lastRunInputHash: string | null;
  statusFlags: CobolStatusFlags;
  conflict: CobolConflict | null;
  saveNoticeAt: number | null;
  programId: string | null;
  setSourceText: (text: string) => void;
  setSourceFile: (text: string, sourceName: string) => void;
  setExpectedOutput: (text: string) => void;
  setOracleInput: (text: string) => void;
  setAllowAiAssist: (enabled: boolean) => void;
  clearWorkspace: () => void;
  // Composed Generate & Verify (renamed in toolbar but kept as
  // ``submitTransform`` here for backwards compatibility with existing
  // call sites and tests).
  submitTransform: () => Promise<ApiResult<TransformResponse>>;
  // Studio-IDE-13 (#255): explicit Generator-Run-only action.
  // Equivalent inputs to ``submitTransform`` but invokes the
  // ``/api/v0/generate`` BFF endpoint (which the BFF tags with
  // ``runMode: "generate"``).
  submitGenerate: () => Promise<ApiResult<GenerateResponse>>;
  // Studio-IDE-3 actions.
  saveDraftNow: () => Promise<void>;
  resolveConflict: (
    choice: "backendSample" | "localDraft" | "lastRunInput",
  ) => void;
  dismissConflict: () => void;
  loadDraftFor: (programId: string, sourceName: string) => Promise<void>;
}

const SourceWorkspaceContext = createContext<SourceWorkspaceState | null>(null);

export function SourceWorkspaceProvider({ children }: { children: ReactNode }) {
  const [sourceText, setSourceTextInternal] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [expectedOutput, setExpectedOutputInternal] = useState("");
  const [oracleInput, setOracleInputInternal] = useState("");
  const [allowAiAssist, setAllowAiAssistInternal] = useState(true);
  const [transformError, setTransformError] = useState<string | null>(null);
  const [bufferHash, setBufferHash] = useState("00000000");
  const [lastRunInputHash, setLastRunInputHash] = useState<string | null>(null);
  const [conflict, setConflict] = useState<CobolConflict | null>(null);
  const [saveNoticeAt, setSaveNoticeAt] = useState<number | null>(null);

  const {
    state: runState,
    startTransform,
    startGenerate,
  } = useTransformationRun();
  const isTransforming =
    runState.phase === "starting" || runState.phase === "running";
  const modelGatewayUnavailable =
    allowAiAssist && runState.modelGatewayHealth?.status === "unavailable";

  // The active programId for draft scoping. When no transformation has
  // run yet (no programId from BFF), drafts attach to the source name as
  // an interim key — this keeps locally-edited pastes survivable across
  // reloads even before the user has submitted them.
  const programId = runState.programId;

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
      void deriveSourceHash(sourceText).then(setLastRunInputHash);
    }
  }, [runState.runId, runState.phase, sourceText]);

  const statusFlags: CobolStatusFlags = {
    clean: lastRunInputHash !== null && bufferHash === lastRunInputHash,
    pendingReRun: lastRunInputHash !== null && bufferHash !== lastRunInputHash,
  };

  const setSourceText = (text: string) => {
    setSourceTextInternal(text);
    setIsDirty(true);
    setTransformError(null);
    if (!sourceName) {
      setSourceName(DEFAULT_SOURCE_NAME);
    }
  };

  const setSourceFile = (text: string, newSourceName: string) => {
    setSourceTextInternal(text);
    setSourceName(newSourceName || DEFAULT_SOURCE_NAME);
    setExpectedOutputInternal("");
    setOracleInputInternal("");
    setIsDirty(false);
    setTransformError(null);
    setLastRunInputHash(null);
    lastSeenRunIdRef.current = null;
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
    setSourceTextInternal("");
    setSourceName(null);
    setExpectedOutputInternal("");
    setOracleInputInternal("");
    setAllowAiAssistInternal(true);
    setIsDirty(false);
    setTransformError(null);
    setLastRunInputHash(null);
    setBufferHash("00000000");
    setConflict(null);
    setSaveNoticeAt(null);
    lastSeenRunIdRef.current = null;
  };

  const canSubmitTransform =
    sourceText.trim().length > 0 && !isTransforming && !modelGatewayUnavailable;

  const submitTransform = async (): Promise<ApiResult<TransformResponse>> => {
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

    const result = await startTransform({
      ...request,
      useTransformationAgent: allowAiAssist,
    });

    if (!result.ok) {
      setTransformError(
        result.status === 503
          ? "Backend unavailable. Try again shortly."
          : result.message,
      );
    } else {
      // Snapshot the hash of the input we just sent so the status chip
      // can later detect divergence.
      void deriveSourceHash(sourceText).then(setLastRunInputHash);
    }

    return result;
  };

  // Studio-IDE-13 (#255): Generator-only submission. Mirrors
  // ``submitTransform`` validation but delegates to ``startGenerate`` so
  // the BFF tags the run with ``runMode: "generate"``. The Studio's
  // existing run-polling, generated-files hydration, and Java-buffer
  // baselining all keep working unchanged because the orchestrator
  // returns the same TransformResponse shape.
  const submitGenerate = async (): Promise<ApiResult<GenerateResponse>> => {
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
    const result = await startGenerate({
      ...request,
      useTransformationAgent: allowAiAssist,
    });
    if (!result.ok) {
      setTransformError(
        result.status === 503
          ? "Backend unavailable. Try again shortly."
          : result.message,
      );
    } else {
      void deriveSourceHash(sourceText).then(setLastRunInputHash);
    }
    return result;
  };

  // ----- Persistence integration ---------------------------------------

  function makeCobolKey(currentProgramId: string | null) {
    const effectiveProgramId =
      currentProgramId ?? sourceName ?? DEFAULT_SOURCE_NAME;
    const effectiveSourceName = sourceName ?? DEFAULT_SOURCE_NAME;
    return {
      kind: "cobol" as const,
      programId: effectiveProgramId,
      sourceName: effectiveSourceName,
    };
  }

  const saveDraftNow = async (): Promise<void> => {
    if (sourceText.length === 0 && !isDirty) {
      return;
    }
    const scope = getCurrentDraftScope();
    const key = makeCobolKey(programId);
    const hash = await deriveSourceHash(sourceText);
    const payload: DraftPayload = {
      schemaVersion: "v0",
      kind: "cobol",
      content: sourceText,
      bufferHash: hash,
      lastRunInputHash: lastRunInputHash ?? undefined,
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
  const loadDraftFor = async (
    nextProgramId: string,
    nextSourceName: string,
  ): Promise<void> => {
    const scope = getCurrentDraftScope();
    const key = {
      kind: "cobol" as const,
      programId: nextProgramId,
      sourceName: nextSourceName,
    };
    const loaded = await editorPersistence.loadDraft(scope, key);
    if (!loaded || loaded.isExpired) {
      return;
    }
    const backendSample = sourceText;
    if (backendSample && backendSample !== loaded.payload.content) {
      setConflict({
        backendSample,
        localDraft: loaded.payload.content,
        lastRunInput: lastRunInputHash ? backendSample : "",
      });
      return;
    }
    setSourceTextInternal(loaded.payload.content);
    setSourceName(nextSourceName);
    setIsDirty(false);
    if (loaded.payload.lastRunInputHash) {
      setLastRunInputHash(loaded.payload.lastRunInputHash);
    }
  };

  const resolveConflict = (
    choice: "backendSample" | "localDraft" | "lastRunInput",
  ) => {
    if (!conflict) {
      return;
    }
    const chosen = conflict[choice];
    setSourceTextInternal(chosen);
    setIsDirty(false);
    // Recompute hashes off the new content.
    void deriveSourceHash(chosen).then(setBufferHash);
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
        expectedOutput,
        oracleInput,
        allowAiAssist,
        transformError,
        isTransforming,
        canSubmitTransform,
        bufferHash,
        lastRunInputHash,
        statusFlags,
        conflict,
        saveNoticeAt,
        programId,
        setSourceText,
        setSourceFile,
        setExpectedOutput,
        setOracleInput,
        setAllowAiAssist,
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
