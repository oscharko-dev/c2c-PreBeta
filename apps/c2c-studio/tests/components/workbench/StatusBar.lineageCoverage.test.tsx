// Studio-IDE-6 (#248) follow-up: shallow render test for the "Lineage: X%"
// indicator in the workbench status bar. Verifier flagged that the
// StatusBar lineage chip had no focused assertion that the pct string is
// rendered with the value published by the LineageCoverage store.

import { render, screen, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import React from "react";

import { StatusBar } from "@/components/workbench/StatusBar";
import { type StudioApiState } from "@/hooks/useC2cApi";
import {
  LineageCoverageProvider,
  useLineageCoverageApi,
} from "@/stores/lineageCoverage";
import {
  TransformationRunProvider,
  useTransformationRun,
} from "@/stores/transformationRun";
import type { TransformationRunState } from "@/types/run";

const loadingApiState: StudioApiState = {
  health: null,
  mode: null,
  error: null,
  errorKind: null,
  loading: true,
};

// Capture the publish() callable so each test can seed the store from the
// outside without re-rendering the entire workbench.
function Harness({
  onReady,
}: {
  onReady: (
    publish: ReturnType<typeof useLineageCoverageApi>["publish"],
  ) => void;
}) {
  const { publish } = useLineageCoverageApi();
  React.useEffect(() => {
    onReady(publish);
  }, [publish, onReady]);
  return null;
}

function RunStateHarness({ state }: { state: Partial<TransformationRunState> }) {
  const { setState } = useTransformationRun();
  React.useEffect(() => {
    setState((previous) => ({ ...previous, ...state }));
  }, [setState, state]);
  return null;
}

const successState: Partial<TransformationRunState> = {
  phase: "completed",
  runId: "run-success",
  programId: "PAYROLL",
  summary: {
    status: "completed",
    finalClassification: "success",
  } as TransformationRunState["summary"],
  generated: {
    status: "ok",
  } as TransformationRunState["generated"],
  buildTest: {
    status: "ok",
  } as TransformationRunState["buildTest"],
  evidence: {
    status: "complete",
  } as TransformationRunState["evidence"],
};

const failureState: Partial<TransformationRunState> = {
  phase: "failed",
  runId: "run-failed",
  programId: "PAYROLL",
  workflow: {
    finalClassification: "failed",
    failureCode: "java_compile_failed",
    failureMessage: "Java compile failed.",
  } as TransformationRunState["workflow"],
};

describe('StatusBar — "Lineage: X%" indicator (Studio-IDE-6 #248)', () => {
  it('renders "Lineage: —" when no file is active', () => {
    render(
      <TransformationRunProvider>
        <LineageCoverageProvider>
          <StatusBar apiState={loadingApiState} />
        </LineageCoverageProvider>
      </TransformationRunProvider>,
    );
    const chip = screen.getByTestId("status-bar-lineage-coverage");
    expect(chip.textContent).toBe("Lineage: —");
  });

  it('renders "Lineage: 42%" when the store publishes a 42% entry', () => {
    let publish: ReturnType<typeof useLineageCoverageApi>["publish"] | null =
      null;
    render(
      <TransformationRunProvider>
        <LineageCoverageProvider>
          <Harness onReady={(p) => (publish = p)} />
          <StatusBar apiState={loadingApiState} />
        </LineageCoverageProvider>
      </TransformationRunProvider>,
    );
    // The Harness publishes via the same context the StatusBar reads from,
    // so a single act() flush is enough to re-render both consumers.
    act(() => {
      publish?.({ filePath: "src/App.java", pct: 42 });
    });
    const chip = screen.getByTestId("status-bar-lineage-coverage");
    expect(chip.textContent).toBe("Lineage: 42%");
  });

  it('renders "Lineage: 0%" when every region is manual (manual counts as non-covered per AC10)', () => {
    let publish: ReturnType<typeof useLineageCoverageApi>["publish"] | null =
      null;
    render(
      <TransformationRunProvider>
        <LineageCoverageProvider>
          <Harness onReady={(p) => (publish = p)} />
          <StatusBar apiState={loadingApiState} />
        </LineageCoverageProvider>
      </TransformationRunProvider>,
    );
    act(() => {
      // The trustPillars helper already enforces the manual-region rule; we
      // just assert the StatusBar honestly displays whatever the store
      // publishes, including the 0% boundary.
      publish?.({ filePath: "src/App.java", pct: 0 });
    });
    const chip = screen.getByTestId("status-bar-lineage-coverage");
    expect(chip.textContent).toBe("Lineage: 0%");
  });

  it("uses AA-safe semantic badge backgrounds for success and failure chips", async () => {
    const { rerender } = render(
      <TransformationRunProvider>
        <LineageCoverageProvider>
          <RunStateHarness state={successState} />
          <StatusBar apiState={loadingApiState} />
        </LineageCoverageProvider>
      </TransformationRunProvider>,
    );
    expect(await screen.findByTestId("status-bar-success-badge")).toHaveClass(
      "bg-success-badge",
    );

    rerender(
      <TransformationRunProvider>
        <LineageCoverageProvider>
          <RunStateHarness state={failureState} />
          <StatusBar apiState={loadingApiState} />
        </LineageCoverageProvider>
      </TransformationRunProvider>,
    );
    expect(await screen.findByTestId("status-bar-failure-code")).toHaveClass(
      "bg-error-badge",
    );
  });
});
