"use client";

// Studio-IDE-14 (#256): a small command bus that decouples the
// `AppTopBar` Compile Check button from the live Monaco-backed Java
// editor.
//
// The Java editor pane registers an imperative handler via
// `registerCompileCheckHandler(...)`. The button reads the current
// `canCompileCheck` flag plus `compileCheckPending` to know whether
// to render enabled and uses `triggerCompileCheck()` to fire the
// action. F5 inside the Monaco-scoped command path is wired the same
// way so the keyboard and the toolbar share one implementation.
//
// The provider intentionally lives in its own file so the AppTopBar
// can import it without pulling in the TransformationRunProvider's
// large surface, and tests can wrap the editor pane in this provider
// alone.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type CompileCheckTrigger = "toolbar" | "shortcut";

export interface JavaEditorActionsContextValue {
  canCompileCheck: boolean;
  compileCheckPending: boolean;
  triggerCompileCheck: (trigger: CompileCheckTrigger) => void;
  // Registration helpers. Returns an unregister function so the editor
  // pane can release its handler on unmount; the bus drops back to
  // `canCompileCheck === false` while no pane is mounted.
  registerCompileCheckHandler: (
    handler: (trigger: CompileCheckTrigger) => Promise<void> | void,
  ) => () => void;
  setCompileCheckAvailable: (available: boolean) => void;
  setCompileCheckPending: (pending: boolean) => void;
}

const JavaEditorActionsContext =
  createContext<JavaEditorActionsContextValue | null>(null);

export function JavaEditorActionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const handlerRef = useRef<
    ((trigger: CompileCheckTrigger) => Promise<void> | void) | null
  >(null);
  const [handlerRegistered, setHandlerRegistered] = useState(false);
  const [compileCheckAvailable, setCompileCheckAvailable] = useState(false);
  const [compileCheckPending, setCompileCheckPending] = useState(false);
  const canCompileCheck = handlerRegistered && compileCheckAvailable;

  const registerCompileCheckHandler = useCallback(
    (handler: (trigger: CompileCheckTrigger) => Promise<void> | void) => {
      handlerRef.current = handler;
      setHandlerRegistered(true);
      return () => {
        if (handlerRef.current === handler) {
          handlerRef.current = null;
          setHandlerRegistered(false);
          setCompileCheckAvailable(false);
          setCompileCheckPending(false);
        }
      };
    },
    [],
  );

  const triggerCompileCheck = useCallback(
    (trigger: CompileCheckTrigger) => {
      const handler = handlerRef.current;
      if (!canCompileCheck) return;
      if (!handler) return;
      // The handler returns a Promise (or void); we don't await it here
      // because callers are fire-and-forget. The handler itself is
      // responsible for flipping `compileCheckPending` via
      // `setCompileCheckPending`.
      void handler(trigger);
    },
    [canCompileCheck],
  );

  const value = useMemo<JavaEditorActionsContextValue>(
    () => ({
      canCompileCheck,
      compileCheckPending,
      triggerCompileCheck,
      registerCompileCheckHandler,
      setCompileCheckAvailable,
      setCompileCheckPending,
    }),
    [
      canCompileCheck,
      compileCheckPending,
      triggerCompileCheck,
      registerCompileCheckHandler,
      setCompileCheckAvailable,
    ],
  );

  return (
    <JavaEditorActionsContext.Provider value={value}>
      {children}
    </JavaEditorActionsContext.Provider>
  );
}

// Disabled fallback used when no provider is mounted (test fixtures,
// storybook). The Compile Check button renders disabled and any
// `triggerCompileCheck` call is a silent no-op. This matches the
// expected behaviour when there is no Java editor mounted in the
// workbench tree.
const DISABLED_VALUE: JavaEditorActionsContextValue = {
  canCompileCheck: false,
  compileCheckPending: false,
  triggerCompileCheck: () => {},
  registerCompileCheckHandler: () => () => {},
  setCompileCheckAvailable: () => {},
  setCompileCheckPending: () => {},
};

// Returns the live context when a provider is mounted, otherwise the
// disabled fallback above. The disabled fallback exists so widgets like
// the toolbar Compile Check button can render in tests that don't wrap
// the full provider tree — they simply see `canCompileCheck === false`
// and disable the button.
export function useJavaEditorActions(): JavaEditorActionsContextValue {
  const context = useContext(JavaEditorActionsContext);
  return context ?? DISABLED_VALUE;
}

// Convenience hook for editor panes — registers the handler for the
// component lifetime and gates `canCompileCheck` on the active artifact.
export function useRegisterCompileCheckHandler(
  handler: (trigger: CompileCheckTrigger) => Promise<void> | void,
  available = true,
): void {
  const { registerCompileCheckHandler, setCompileCheckAvailable } =
    useJavaEditorActions();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    return registerCompileCheckHandler((trigger) =>
      handlerRef.current(trigger),
    );
  }, [registerCompileCheckHandler]);
  useEffect(() => {
    setCompileCheckAvailable(available);
    return () => setCompileCheckAvailable(false);
  }, [available, setCompileCheckAvailable]);
}
