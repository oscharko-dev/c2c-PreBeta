import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { HarnessTimeline } from "../src/components/observability/HarnessTimeline";
import { ExperienceLearningPanel } from "../src/components/observability/ExperienceLearningPanel";
import { ModelGatewayPanel } from "../src/components/observability/ModelGatewayPanel";
import * as transformationRun from "../src/stores/transformationRun";
import { TransformationRunState } from "../src/types/run";
import { deriveProductState } from "../src/types/state";
import { TransformationRunContextValue } from "../src/stores/transformationRun";

// Mock the hook
vi.mock("../src/stores/transformationRun", () => ({
  useTransformationRun: vi.fn(),
}));

function makeMinimalState(
  overrides: Partial<TransformationRunState>,
): TransformationRunState {
  return {
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
    ...overrides,
  };
}

function makeContextValue(
  stateOverrides: Partial<TransformationRunState>,
): TransformationRunContextValue {
  const state = makeMinimalState(stateOverrides);
  return {
    state,
    productState: deriveProductState(state),
    startTransform: vi.fn(),
    setState: vi.fn(),
    // Studio-IDE-3 (#247) additions — the Observability tests do not
    // exercise the Java buffer surface, but the context value type
    // requires the full surface, so we wire no-op stubs.
    javaBuffers: {},
    javaConflict: null,
    saveNoticeAt: null,
    ensureJavaBaseline: vi.fn(),
    setJavaBufferContent: vi.fn(),
    setJavaManualOverlay: vi.fn(),
    saveJavaDraft: vi.fn(),
    loadJavaDraftFor: vi.fn(),
    resolveJavaConflict: vi.fn(),
    dismissJavaConflict: vi.fn(),
    javaStatusFlags: vi.fn().mockReturnValue({
      clean: false,
      pendingReRun: false,
      staleJava: false,
    }),
  };
}

describe("Observability Surfaces", () => {
  it("renders events timeline from RunEventsView", () => {
    vi.mocked(transformationRun.useTransformationRun).mockReturnValue(
      makeContextValue({
        harnessReady: { status: "unavailable" },
        events: {
          runId: "r1",
          programId: "p1",
          mode: "live",
          productMode: "live",
          events: [
            {
              type: "test-event",
              status: "ok",
              message: "all good",
              createdAt: "2026-05-15T00:00:00Z",
            },
          ],
        },
      }),
    );

    render(<HarnessTimeline />);
    expect(screen.getByText("test-event")).toBeDefined();
    expect(screen.getByText("all good")).toBeDefined();
  });

  it("renders Experience Learning unavailable state", () => {
    vi.mocked(transformationRun.useTransformationRun).mockReturnValue(
      makeContextValue({
        phase: "completed",
        runId: "r1",
        experience: {
          runId: "r1",
          programId: "p1",
          mode: "live",
          productMode: "unavailable",
        },
      }),
    );

    render(<ExperienceLearningPanel />);
    expect(
      screen.getByText(/Experience Learning unavailable for this run/i),
    ).toBeDefined();
  });

  it("renders Experience Learning available state", () => {
    vi.mocked(transformationRun.useTransformationRun).mockReturnValue(
      makeContextValue({
        phase: "completed",
        runId: "r1",
        experience: {
          runId: "r1",
          programId: "p1",
          mode: "live",
          productMode: "live",
          summary: "Learned something new",
          observationPolicy: "strict",
          learningSignals: [
            {
              key: "model_invocation_outcome",
              label: "Model invocation outcome",
              status: "observed",
              summary: "1 model-gateway outcome observed.",
              count: 1,
              evidenceRefs: ["evt-model"],
            },
          ],
          detectedPatterns: ["pattern A"],
          artifactRefs: ["urn:test"],
        },
      }),
    );

    render(<ExperienceLearningPanel />);
    expect(screen.getByText("Learned something new")).toBeDefined();
    expect(screen.getByText("strict")).toBeDefined();
    expect(screen.getByText("Model invocation outcome")).toBeDefined();
    expect(screen.getByText("1 model-gateway outcome observed.")).toBeDefined();
    expect(screen.getByText("pattern A")).toBeDefined();
    expect(screen.getByText("urn:test")).toBeDefined();
  });

  it("renders Model Gateway governance summary and confirms no Foundry participation in deterministic W0", () => {
    vi.mocked(transformationRun.useTransformationRun).mockReturnValue(
      makeContextValue({
        modelGatewayHealth: {
          status: "unavailable",
          error: "Model Gateway unavailable in deterministic W0 mode",
        },
      }),
    );

    render(<ModelGatewayPanel />);
    expect(
      screen.getByText(/Model Gateway governance summary unavailable/i),
    ).toBeDefined();
    expect(
      screen.getByText(
        /No Foundry or LLM participation was required or performed for this run/i,
      ),
    ).toBeDefined();
  });

  it("renders Model Gateway governance summary when the BFF returns normalized health data", () => {
    vi.mocked(transformationRun.useTransformationRun).mockReturnValue(
      makeContextValue({
        modelGatewayHealth: {
          status: "ok",
          providerMode: "foundry-dev",
          activeModelCount: 3,
          dataPolicy: "model-gateway",
          ledgerEnabled: true,
          eventEmission: true,
        },
      }),
    );

    render(<ModelGatewayPanel />);
    expect(screen.getByText("foundry-dev")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("model-gateway")).toBeDefined();
    expect(screen.getAllByText("Enabled")).toHaveLength(2);
    expect(screen.queryByText(/No Foundry or LLM participation/i)).toBeNull();
  });
});
