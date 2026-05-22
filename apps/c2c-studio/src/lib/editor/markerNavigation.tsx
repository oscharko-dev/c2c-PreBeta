"use client";

// Studio-IDE-5 (#244): cross-component marker navigation.
//
// The Problems panel dispatches a `requestNavigation` with a target
// (filePath, line, column). Each editor pane registers itself with the
// context and, when its filePath matches the target, revealLine +
// setPosition on its Monaco editor — focusing the source line.
//
// F8 / Shift+F8 cycle through markers on the currently focused editor.
// The context keeps a "current editor" ref so the global key handler
// installed at the WorkbenchShell level can dispatch the right command.

import type * as MonacoNs from "monaco-editor";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from "react";

import type { Diagnostic } from "@/types/api";
import { sourceKindToOwner } from "@/lib/editor/diagnosticMarkers";

// Path-segment matching for marker routing. The diagnostic's
// `filePath` and an editor registration's `filePath` may be expressed
// at different roots (e.g. "src/main/java/c2c/Foo.java" vs
// "Foo.java"), but they must align on a contiguous suffix of full
// path segments. Plain `endsWith` would attach a diagnostic for
// "Foo.java" to an editor opened on "BarFoo.java" — wrong.
function pathMatches(a: string, b: string): boolean {
  const aParts = a.split(/[\\/]+/).filter(Boolean);
  const bParts = b.split(/[\\/]+/).filter(Boolean);
  if (aParts.length === 0 || bParts.length === 0) return false;
  const short = aParts.length < bParts.length ? aParts : bParts;
  const long = aParts.length < bParts.length ? bParts : aParts;
  for (let i = 0; i < short.length; i += 1) {
    if (short[short.length - 1 - i] !== long[long.length - 1 - i]) {
      return false;
    }
  }
  return true;
}

export interface NavigationTarget {
  filePath: string;
  line: number;
  column?: number;
  // Monotonically-increasing token; identical target back-to-back is
  // valid because the user may want to jump twice.
  token: number;
}

interface EditorRegistration {
  filePath: string | null;
  editor: MonacoNs.editor.IStandaloneCodeEditor;
}

interface MarkerNavigationContextValue {
  // Editor panes register their Monaco instance and the currently-open
  // filePath. The registration is identified by an opaque id; calling
  // unregister with the same id removes only that registration.
  registerEditor: (id: string, registration: EditorRegistration) => void;
  unregisterEditor: (id: string) => void;
  // Problems panel calls this with a typed Diagnostic to route the
  // editor focus. Unknown filePath → no-op.
  navigateToDiagnostic: (diagnostic: Diagnostic) => void;
  // Imperative API for F8/Shift+F8 — exposed for the WorkbenchShell.
  cycleMarker: (direction: "next" | "previous") => void;
  // The pane that the user last interacted with — used by F8 to pick
  // an editor target. Each editor calls `setActiveEditorId` on focus.
  setActiveEditorId: (id: string) => void;
  // The latest navigation target (consumed by editor panes).
  target: NavigationTarget | null;
}

const MarkerNavigationContext =
  createContext<MarkerNavigationContextValue | null>(null);

export function MarkerNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const registrations = useRef<Map<string, EditorRegistration>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const [target, setTarget] = useState<NavigationTarget | null>(null);
  const tokenRef = useRef(0);

  const registerEditor = useCallback(
    (id: string, registration: EditorRegistration) => {
      registrations.current.set(id, registration);
      // First registration becomes active by default so a fresh workbench
      // mount with one visible editor still receives F8 events.
      if (activeIdRef.current === null) {
        activeIdRef.current = id;
      }
    },
    [],
  );

  const unregisterEditor = useCallback((id: string) => {
    registrations.current.delete(id);
    if (activeIdRef.current === id) {
      const remaining = registrations.current.keys().next();
      activeIdRef.current = remaining.done ? null : remaining.value;
    }
  }, []);

  const setActiveEditorId = useCallback((id: string) => {
    if (registrations.current.has(id)) {
      activeIdRef.current = id;
    }
  }, []);

  const focusEditor = useCallback(
    (
      registration: EditorRegistration | undefined,
      line: number,
      column: number | undefined,
    ) => {
      if (!registration) return;
      const { editor } = registration;
      const targetLine = Math.max(1, line);
      const targetColumn = Math.max(1, column ?? 1);
      editor.revealLineInCenterIfOutsideViewport(targetLine);
      editor.setPosition({ lineNumber: targetLine, column: targetColumn });
      editor.focus();
    },
    [],
  );

  const navigateToDiagnostic = useCallback(
    (diagnostic: Diagnostic) => {
      if (diagnostic.line === undefined) return;
      // Fix #244-review: run-level diagnostics (no filePath) do not
      // jump any editor per ADR 0006 Decision 4. They remain visible
      // in the Problems panel; navigation is a no-op.
      if (diagnostic.filePath === undefined) return;
      tokenRef.current += 1;
      // Path-segment matching avoids cross-file confusion when two
      // editor registrations share a suffix.
      let chosen: EditorRegistration | undefined;
      for (const reg of registrations.current.values()) {
        if (reg.filePath && pathMatches(diagnostic.filePath, reg.filePath)) {
          chosen = reg;
          break;
        }
      }
      focusEditor(chosen, diagnostic.line, diagnostic.column);
      setTarget({
        filePath: diagnostic.filePath,
        line: diagnostic.line,
        column: diagnostic.column,
        token: tokenRef.current,
      });
    },
    [focusEditor],
  );

  const cycleMarker = useCallback((direction: "next" | "previous") => {
    const id = activeIdRef.current;
    if (id === null) return;
    const registration = registrations.current.get(id);
    if (!registration) return;
    const { editor } = registration;
    // Monaco ships built-in commands for marker navigation. The
    // standard action IDs are `editor.action.marker.next` and
    // `editor.action.marker.prev`. Trigger them through the editor
    // command palette so all owners' markers participate.
    const action =
      direction === "next"
        ? "editor.action.marker.next"
        : "editor.action.marker.prev";
    void editor.getAction(action)?.run();
  }, []);

  const value = useMemo<MarkerNavigationContextValue>(
    () => ({
      registerEditor,
      unregisterEditor,
      navigateToDiagnostic,
      cycleMarker,
      setActiveEditorId,
      target,
    }),
    [
      registerEditor,
      unregisterEditor,
      navigateToDiagnostic,
      cycleMarker,
      setActiveEditorId,
      target,
    ],
  );

  return (
    <MarkerNavigationContext.Provider value={value}>
      {children}
    </MarkerNavigationContext.Provider>
  );
}

// Test-friendly no-op fallback for callers outside a provider. Returns
// a value-equal object on every render so React effects do not re-fire.
const NOOP_CONTEXT: MarkerNavigationContextValue = {
  registerEditor: () => {},
  unregisterEditor: () => {},
  navigateToDiagnostic: () => {},
  cycleMarker: () => {},
  setActiveEditorId: () => {},
  target: null,
};

export function useMarkerNavigation(): MarkerNavigationContextValue {
  const ctx = useContext(MarkerNavigationContext);
  // Returning a stable no-op fallback (instead of throwing) lets
  // components render outside the provider — primarily unit tests that
  // mount panes in isolation. Production callers always live below
  // <MarkerNavigationProvider> in `WorkbenchShell`.
  return ctx ?? NOOP_CONTEXT;
}

// Hook for editor panes: wire keyboard focus → activeEditorId and
// register/unregister the (filePath, editor) pair on mount. Returns a
// stable onMount callback ready to feed into <CodeEditor onMount>.
export function useEditorMarkerRegistration(args: {
  id: string;
  filePath: string | null;
}): {
  registerOnMount: (editor: MonacoNs.editor.IStandaloneCodeEditor) => void;
} {
  const { id, filePath } = args;
  const { registerEditor, unregisterEditor, setActiveEditorId } =
    useMarkerNavigation();
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const focusDisposableRef = useRef<MonacoNs.IDisposable | null>(null);

  // Keep the registration's filePath up-to-date as the pane changes
  // files. We re-register with the same id (a no-op for ordering) so
  // unregister-on-every-change does not bump `activeIdRef` to another
  // pane mid-session. The unregister happens only when the pane fully
  // unmounts.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    registerEditor(id, { filePath, editor });
  }, [id, filePath, registerEditor]);

  // Separate unmount-only cleanup so changing filePath does not
  // trigger an unregister cycle (which would let `activeIdRef`
  // drift onto another pane).
  useEffect(() => {
    return () => {
      focusDisposableRef.current?.dispose();
      focusDisposableRef.current = null;
      unregisterEditor(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const registerOnMount = useCallback(
    (editor: MonacoNs.editor.IStandaloneCodeEditor) => {
      focusDisposableRef.current?.dispose();
      focusDisposableRef.current = null;
      editorRef.current = editor;
      registerEditor(id, { filePath, editor });
      // The standalone editor exposes `onDidFocusEditorText`; some
      // test doubles do not, so guard before subscribing.
      if (typeof editor.onDidFocusEditorText === "function") {
        focusDisposableRef.current = editor.onDidFocusEditorText(() => {
          setActiveEditorId(id);
        });
      }
    },
    [id, filePath, registerEditor, setActiveEditorId],
  );

  return { registerOnMount };
}

// Re-export so consumers can read the owner labels without crossing
// modules.
export { sourceKindToOwner };
