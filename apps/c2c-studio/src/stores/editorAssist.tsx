"use client";

// Studio-IDE-10 (#249): shared state for the Editor-Assist channel.
//
// Both `CobolEditorPane` and `GeneratedJavaEditorPane` register a
// Monaco action that fires Explain-on-region. They both need to write
// into the same side-panel slot at the WorkbenchShell level so that
// switching between panes does not clobber the in-flight result. This
// provider is the natural seam.
//
// Responsibilities:
//   1. Hold the current `(request, result)` pair plus the `open` flag.
//   2. Expose `runExplain(request)` so the pane actions can fire the
//      BFF call without knowing about the panel.
//   3. Track the most recent budget snapshot so callers (toolbar
//      buttons, the pane actions) can ask "is the budget exhausted?".
//   4. Expose `retry()` which re-runs the last request.
//
// We deliberately keep this provider thin — no business logic about
// hashing or redaction lives here; the editor pane owns the
// pre-redaction pipeline because it has the Monaco selection.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { requestExplanation } from "@/lib/editor/editorAssistClient";
import type {
  EditorAssistBudgetSnapshot,
  EditorAssistRequest,
  EditorAssistResult,
} from "@/types/editor-assist";

export interface EditorAssistContextValue {
  panelOpen: boolean;
  request: EditorAssistRequest | null;
  result: EditorAssistResult | null;
  budgetSnapshot: EditorAssistBudgetSnapshot | null;
  // Fire-and-forget — opens the panel immediately with the in-flight
  // state, then resolves the result asynchronously.
  runExplain: (request: EditorAssistRequest) => Promise<void>;
  retry: () => Promise<void>;
  closePanel: () => void;
}

const DEFAULT_VALUE: EditorAssistContextValue = {
  panelOpen: false,
  request: null,
  result: null,
  budgetSnapshot: null,
  runExplain: async () => {},
  retry: async () => {},
  closePanel: () => {},
};

const EditorAssistContext = createContext<EditorAssistContextValue | null>(
  null,
);

export function EditorAssistProvider({ children }: { children: ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [request, setRequest] = useState<EditorAssistRequest | null>(null);
  const [result, setResult] = useState<EditorAssistResult | null>(null);
  const [budgetSnapshot, setBudgetSnapshot] =
    useState<EditorAssistBudgetSnapshot | null>(null);
  // Track the latest in-flight call so a stale response cannot
  // overwrite a newer request. Sequence numbers are simpler and
  // cheaper than an AbortController per call.
  const callSeqRef = useRef(0);

  const runExplain = useCallback(async (req: EditorAssistRequest) => {
    callSeqRef.current += 1;
    const seq = callSeqRef.current;
    setRequest(req);
    setResult(null);
    setPanelOpen(true);
    const response = await requestExplanation(req);
    // Stale-response guard: a newer call has started; drop this one.
    if (seq !== callSeqRef.current) return;
    setResult(response);
    const snapshot = response.ok
      ? response.data.budgetSnapshot
      : response.budgetSnapshot;
    if (snapshot !== null) {
      setBudgetSnapshot(snapshot);
    }
  }, []);

  const retry = useCallback(async () => {
    if (request === null) return;
    await runExplain(request);
  }, [request, runExplain]);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
  }, []);

  const value = useMemo<EditorAssistContextValue>(
    () => ({
      panelOpen,
      request,
      result,
      budgetSnapshot,
      runExplain,
      retry,
      closePanel,
    }),
    [panelOpen, request, result, budgetSnapshot, runExplain, retry, closePanel],
  );

  return (
    <EditorAssistContext.Provider value={value}>
      {children}
    </EditorAssistContext.Provider>
  );
}

// Returns the live context when a provider is mounted, or a no-op
// fallback. The fallback exists so individual panes can render in
// isolated tests without wrapping the full workbench tree.
export function useEditorAssist(): EditorAssistContextValue {
  const context = useContext(EditorAssistContext);
  return context ?? DEFAULT_VALUE;
}
