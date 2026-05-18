import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import {
  OriginOverlayProvider,
  useOriginOverlayApi,
  useOverlay,
} from "./originOverlay";
import type { JavaOriginOverlay } from "../../types/api";

function overlayFor(runId: string, javaFile: string): JavaOriginOverlay {
  return {
    schemaVersion: "v0",
    runId,
    javaFile,
    regions: [
      {
        lineRange: { startLine: 1, endLine: 3 },
        originClass: "deterministic",
      },
    ],
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <OriginOverlayProvider>{children}</OriginOverlayProvider>;
}

describe("OriginOverlayProvider", () => {
  it("returns null by default when no overlay has been set", () => {
    const { result } = renderHook(() => useOverlay("run-1", "App.java"), {
      wrapper,
    });
    expect(result.current).toBeNull();
  });

  it("returns null for null / undefined keys without throwing", () => {
    const { result: nullRun } = renderHook(() => useOverlay(null, "App.java"), {
      wrapper,
    });
    expect(nullRun.current).toBeNull();
    const { result: nullFile } = renderHook(() => useOverlay("run-1", null), {
      wrapper,
    });
    expect(nullFile.current).toBeNull();
    const { result: bothUndefined } = renderHook(
      () => useOverlay(undefined, undefined),
      { wrapper },
    );
    expect(bothUndefined.current).toBeNull();
  });

  it("round-trips an overlay through setOverlay / useOverlay", () => {
    const { result } = renderHook(
      () => ({
        api: useOriginOverlayApi(),
        value: useOverlay("run-1", "App.java"),
      }),
      { wrapper },
    );
    expect(result.current.value).toBeNull();

    const overlay = overlayFor("run-1", "App.java");
    act(() => {
      result.current.api.setOverlay("run-1", "App.java", overlay);
    });
    expect(result.current.value).toEqual(overlay);
  });

  it("isolates overlays per (runId, javaFile) pair", () => {
    const { result: appOnRun1 } = renderHook(
      () => ({
        api: useOriginOverlayApi(),
        value: useOverlay("run-1", "App.java"),
      }),
      { wrapper },
    );
    // Separate render path for a different key — sharing the same provider
    // would require nesting, so we just write through the API and assert via
    // a new mount in the same test.
    const overlay = overlayFor("run-2", "App.java");
    act(() => {
      appOnRun1.current.api.setOverlay("run-2", "App.java", overlay);
    });
    // The (run-1, App.java) hook still sees null because we only wrote to
    // (run-2, App.java).
    expect(appOnRun1.current.value).toBeNull();
  });

  it("clears an overlay when setOverlay is called with null", () => {
    const { result } = renderHook(
      () => ({
        api: useOriginOverlayApi(),
        value: useOverlay("run-1", "App.java"),
      }),
      { wrapper },
    );

    act(() => {
      result.current.api.setOverlay(
        "run-1",
        "App.java",
        overlayFor("run-1", "App.java"),
      );
    });
    expect(result.current.value).not.toBeNull();

    act(() => {
      result.current.api.setOverlay("run-1", "App.java", null);
    });
    expect(result.current.value).toBeNull();
  });

  it("clearOverlaysForRun removes only entries for that run", () => {
    const { result: hooks } = renderHook(
      () => ({
        api: useOriginOverlayApi(),
        run1AppJava: useOverlay("run-1", "App.java"),
        run1OtherJava: useOverlay("run-1", "Other.java"),
        run2AppJava: useOverlay("run-2", "App.java"),
      }),
      { wrapper },
    );

    act(() => {
      hooks.current.api.setOverlay(
        "run-1",
        "App.java",
        overlayFor("run-1", "App.java"),
      );
      hooks.current.api.setOverlay(
        "run-1",
        "Other.java",
        overlayFor("run-1", "Other.java"),
      );
      hooks.current.api.setOverlay(
        "run-2",
        "App.java",
        overlayFor("run-2", "App.java"),
      );
    });
    expect(hooks.current.run1AppJava).not.toBeNull();
    expect(hooks.current.run1OtherJava).not.toBeNull();
    expect(hooks.current.run2AppJava).not.toBeNull();

    act(() => {
      hooks.current.api.clearOverlaysForRun("run-1");
    });
    expect(hooks.current.run1AppJava).toBeNull();
    expect(hooks.current.run1OtherJava).toBeNull();
    expect(hooks.current.run2AppJava).not.toBeNull();
  });

  it("overwrites an existing overlay on a second setOverlay call", () => {
    const { result } = renderHook(
      () => ({
        api: useOriginOverlayApi(),
        value: useOverlay("run-1", "App.java"),
      }),
      { wrapper },
    );

    const first = overlayFor("run-1", "App.java");
    const second: JavaOriginOverlay = {
      ...first,
      regions: [
        {
          lineRange: { startLine: 10, endLine: 20 },
          originClass: "agent_proposed",
        },
      ],
    };

    act(() => {
      result.current.api.setOverlay("run-1", "App.java", first);
    });
    expect(result.current.value).toEqual(first);

    act(() => {
      result.current.api.setOverlay("run-1", "App.java", second);
    });
    expect(result.current.value).toEqual(second);
  });

  it("throws when used outside a provider", () => {
    expect(() => renderHook(() => useOverlay("run-1", "App.java"))).toThrow(
      /OriginOverlayProvider/,
    );
    expect(() => renderHook(() => useOriginOverlayApi())).toThrow(
      /OriginOverlayProvider/,
    );
  });
});
