import { describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";

import {
  JavaEditorActionsProvider,
  useJavaEditorActions,
  useRegisterCompileCheckHandler,
} from "@/stores/javaEditorActions";

describe("JavaEditorActionsProvider", () => {
  it("starts disabled before any handler registers", () => {
    const { result } = renderHook(() => useJavaEditorActions(), {
      wrapper: JavaEditorActionsProvider,
    });
    expect(result.current.canCompileCheck).toBe(false);
    expect(result.current.compileCheckPending).toBe(false);
  });

  it("returns a no-op fallback outside a provider", () => {
    const { result } = renderHook(() => useJavaEditorActions());
    expect(result.current.canCompileCheck).toBe(false);
    // triggerCompileCheck must not throw even without a provider.
    expect(() => result.current.triggerCompileCheck()).not.toThrow();
  });

  it("registers and invokes a handler, then unregisters on cleanup", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    function Probe() {
      useRegisterCompileCheckHandler(handler);
      return null;
    }
    function Trigger({ onReady }: { onReady: (cb: () => void) => void }) {
      const actions = useJavaEditorActions();
      onReady(actions.triggerCompileCheck);
      return (
        <span data-testid="state">
          {actions.canCompileCheck ? "ready" : "idle"}
        </span>
      );
    }
    let trigger: (() => void) | undefined;
    const { rerender, unmount } = render(
      <JavaEditorActionsProvider>
        <Probe />
        <Trigger
          onReady={(cb) => {
            trigger = cb;
          }}
        />
      </JavaEditorActionsProvider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("ready");
    act(() => {
      trigger?.();
    });
    expect(handler).toHaveBeenCalledTimes(1);
    // Unmount the probe — handler unregisters and canCompileCheck flips back.
    rerender(
      <JavaEditorActionsProvider>
        <Trigger
          onReady={(cb) => {
            trigger = cb;
          }}
        />
      </JavaEditorActionsProvider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("idle");
    act(() => {
      trigger?.();
    });
    expect(handler).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("setCompileCheckPending toggles the flag", () => {
    const { result } = renderHook(() => useJavaEditorActions(), {
      wrapper: JavaEditorActionsProvider,
    });
    act(() => {
      result.current.setCompileCheckPending(true);
    });
    expect(result.current.compileCheckPending).toBe(true);
    act(() => {
      result.current.setCompileCheckPending(false);
    });
    expect(result.current.compileCheckPending).toBe(false);
  });
});
