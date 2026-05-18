import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";

import {
  MarkerNavigationProvider,
  useMarkerNavigation,
  useEditorMarkerRegistration,
} from "@/lib/editor/markerNavigation";
import type { Diagnostic } from "@/types/api";

function makeEditorStub(): {
  editor: import("monaco-editor").editor.IStandaloneCodeEditor;
  revealCalls: number[];
  setPositionCalls: Array<{ lineNumber: number; column: number }>;
  focusCalls: number;
  actionCalls: string[];
  getActionStub: ReturnType<typeof vi.fn>;
} {
  const revealCalls: number[] = [];
  const setPositionCalls: Array<{ lineNumber: number; column: number }> = [];
  let focusCalls = 0;
  const actionCalls: string[] = [];
  const getActionStub = vi.fn((id: string) => ({
    run: vi.fn(() => {
      actionCalls.push(id);
      return Promise.resolve();
    }),
  }));
  const editor = {
    revealLineInCenterIfOutsideViewport(line: number) {
      revealCalls.push(line);
    },
    setPosition(position: { lineNumber: number; column: number }) {
      setPositionCalls.push(position);
    },
    focus() {
      focusCalls += 1;
    },
    getAction: getActionStub,
    onDidFocusEditorText: vi.fn(),
  } as unknown as import("monaco-editor").editor.IStandaloneCodeEditor;
  return {
    editor,
    revealCalls,
    setPositionCalls,
    focusCalls: 0,
    actionCalls,
    getActionStub,
    get focusCallsCount() {
      return focusCalls;
    },
  } as unknown as {
    editor: import("monaco-editor").editor.IStandaloneCodeEditor;
    revealCalls: number[];
    setPositionCalls: Array<{ lineNumber: number; column: number }>;
    focusCalls: number;
    actionCalls: string[];
    getActionStub: ReturnType<typeof vi.fn>;
  };
}

function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    schemaVersion: "v0",
    severity: "error",
    code: "X",
    message: "boom",
    ...overrides,
  };
}

describe("MarkerNavigationProvider", () => {
  it("routes navigateToDiagnostic to the editor matching filePath", () => {
    const stub = makeEditorStub();
    let captured: ReturnType<typeof useMarkerNavigation> | null = null;

    function HostFile() {
      const { registerOnMount } = useEditorMarkerRegistration({
        id: "host-file",
        filePath: "src/main/java/c2c/Foo.java",
      });
      // Simulate the editor mount synchronously for test ergonomics.
      registerOnMount(stub.editor);
      return null;
    }
    function HostNav() {
      captured = useMarkerNavigation();
      return null;
    }

    render(
      <MarkerNavigationProvider>
        <HostFile />
        <HostNav />
      </MarkerNavigationProvider>,
    );

    expect(captured).not.toBeNull();
    act(() => {
      captured?.navigateToDiagnostic(
        makeDiagnostic({
          filePath: "src/main/java/c2c/Foo.java",
          line: 12,
          column: 4,
        }),
      );
    });
    // Spies captured via the stub closure.
    expect((stub as unknown as { revealCalls: number[] }).revealCalls).toEqual([
      12,
    ]);
    expect((stub as unknown as { setPositionCalls: Array<{ lineNumber: number; column: number }> }).setPositionCalls).toEqual([
      { lineNumber: 12, column: 4 },
    ]);
  });

  it("triggers Monaco's marker.next / marker.prev actions via cycleMarker", () => {
    const stub = makeEditorStub();
    let captured: ReturnType<typeof useMarkerNavigation> | null = null;

    function HostFile() {
      const { registerOnMount } = useEditorMarkerRegistration({
        id: "host-cycle",
        filePath: "src/x.cbl",
      });
      registerOnMount(stub.editor);
      return null;
    }
    function HostNav() {
      captured = useMarkerNavigation();
      return null;
    }

    render(
      <MarkerNavigationProvider>
        <HostFile />
        <HostNav />
      </MarkerNavigationProvider>,
    );

    act(() => {
      captured?.cycleMarker("next");
    });
    act(() => {
      captured?.cycleMarker("previous");
    });
    expect(stub.getActionStub).toHaveBeenCalledWith(
      "editor.action.marker.next",
    );
    expect(stub.getActionStub).toHaveBeenCalledWith(
      "editor.action.marker.prev",
    );
  });

  it("returns a no-op context outside a provider so panes can render in isolation", () => {
    let captured: ReturnType<typeof useMarkerNavigation> | null = null;
    function Host() {
      captured = useMarkerNavigation();
      return null;
    }
    render(<Host />);
    expect(captured).not.toBeNull();
    // No throws.
    expect(() =>
      captured?.navigateToDiagnostic(
        makeDiagnostic({ filePath: "x", line: 1 }),
      ),
    ).not.toThrow();
    expect(() => captured?.cycleMarker("next")).not.toThrow();
  });
});
