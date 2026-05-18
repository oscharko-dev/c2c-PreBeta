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
import { ApiResult, TransformResponse, JavaOriginOverlay } from "../types/api";
import { deriveSourceHash } from "../lib/sourceAnalysis";
import {
  editorPersistence,
  getCurrentDraftScope,
} from "../lib/editor/editorPersistence";
import type { DraftPayload } from "../lib/editor/editorPersistence";

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
}

export interface TransformationRunContextValue {
  state: TransformationRunState;
  productState: StateContext;
  startTransform: (
    request: TransformRequest,
  ) => Promise<ApiResult<TransformResponse>>;
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

    if (result.data.status === "completed" || result.data.status === "failed") {
      void hydrateRunArtifacts(result.data.runId, setState, result.data.status);
    }

    return result;
  };

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
        return { clean: false, pendingReRun: false, staleJava: false };
      }
      const buffer = entry.bufferHash;
      const lastInput = entry.lastRunInputHash;
      const displayed = entry.displayedArtifactSourceHash;
      const clean =
        lastInput !== null &&
        displayed !== null &&
        buffer === lastInput &&
        buffer === displayed;
      const pendingReRun = lastInput !== null && buffer !== lastInput;
      const staleJava =
        lastInput !== null && displayed !== null && displayed !== lastInput;
      return { clean, pendingReRun, staleJava };
    },
    [javaBuffers],
  );

  return (
    <TransformationRunContext.Provider
      value={{
        state,
        productState,
        startTransform,
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
