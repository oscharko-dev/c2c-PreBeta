import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentActivityPanel } from "../../../src/components/run/AgentActivityPanel";
import { RunWorkflowView } from "../../../src/types/api";

const baseState = {
  phase: "running" as const,
  runId: "run-1",
  orchestratorRunId: "orch-1",
  programId: "PROG01",
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
};

vi.mock("../../../src/stores/transformationRun", () => ({
  useTransformationRun: vi.fn(() => ({ state: baseState })),
}));

function makeWorkflow(
  overrides: Partial<RunWorkflowView> = {},
): RunWorkflowView {
  return {
    runId: "run-1",
    programId: "PROG01",
    mode: "live",
    productMode: "live",
    source: "live",
    state: "agent_running",
    activeStep: "generate-java",
    activeAgent: "transformation_agent",
    trustCase: null,
    agentAttemptCount: 1,
    repairBudget: { limit: 3, used: 0, remaining: 3 },
    assistBudget: { limit: 1, used: 0, remaining: 1 },
    modelInvocationBudget: { limit: 6, used: 0, remaining: 6 },
    repairAttempts: [],
    assistDecision: null,
    finalClassification: null,
    failureCode: null,
    failureMessage: null,
    generatedJavaRef: null,
    buildTestResultRef: null,
    evidencePackRef: null,
    ...overrides,
  };
}

describe("AgentActivityPanel", () => {
  let useTransformationRunMock: any;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import("../../../src/stores/transformationRun");
    useTransformationRunMock = mod.useTransformationRun;
  });

  it("renders the idle empty state when no run is active", () => {
    useTransformationRunMock.mockReturnValue({
      state: { ...baseState, phase: "idle" },
    });
    render(
      <AgentActivityPanel
        emptyState={{
          title: "No agent activity yet",
          message: "Run a transformation.",
        }}
      />,
    );
    expect(screen.getByTestId("agent-activity-idle")).toBeDefined();
    expect(screen.getByText("No agent activity yet")).toBeDefined();
  });

  it("shows a pending notice when workflow contract has not yet arrived", () => {
    useTransformationRunMock.mockReturnValue({
      state: { ...baseState, phase: "running", workflow: null },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    expect(screen.getByTestId("agent-activity-pending")).toBeDefined();
  });

  it("renders active agent label, description, attempt count, and active step", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "running",
        workflow: makeWorkflow({
          agentAttemptCount: 2,
          generatedJavaRef: {
            sha256: "a".repeat(64),
            byteSize: 128,
            kind: "generated-java",
          },
        }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    const status = screen.getByTestId("agent-activity-workflow-status");
    expect(within(status).getByText("agent_running")).toBeDefined();
    expect(within(status).getByText(/no invocation record yet/)).toBeDefined();
    const artifactRefs = screen.getByTestId("agent-activity-artifact-refs");
    expect(within(artifactRefs).getByText(/generated-java/)).toBeDefined();
    const activeAgent = screen.getByTestId("agent-activity-active-agent");
    expect(within(activeAgent).getByText("Transformation Agent")).toBeDefined();
    expect(within(activeAgent).getByText(/generate-java/)).toBeDefined();
    expect(
      screen.getByTestId("agent-activity-attempt-count").textContent,
    ).toContain("2 agent attempts so far");
  });

  it("renders the repair budget bar and exhausted state", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "running",
        workflow: makeWorkflow({
          repairBudget: { limit: 3, used: 3, remaining: 0 },
        }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    const budget = screen.getByTestId("agent-activity-repair-budget");
    expect(within(budget).getByText(/3 \/ 3 attempts used/)).toBeDefined();
    expect(within(budget).getByText(/0 remaining/)).toBeDefined();
  });

  // Issue #216 (W0.3-5): the assist + Model Gateway budgets render
  // alongside the repair budget. Both must show used/limit, remaining
  // count, and use the exhausted styling when ``remaining === 0``.
  it("renders the assist and model invocation budget bars", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "running",
        workflow: makeWorkflow({
          assistBudget: { limit: 1, used: 1, remaining: 0 },
          modelInvocationBudget: { limit: 6, used: 4, remaining: 2 },
        }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    const assist = screen.getByTestId("agent-activity-assist-budget");
    expect(within(assist).getByText(/1 \/ 1 used/)).toBeDefined();
    expect(within(assist).getByText(/0 remaining/)).toBeDefined();
    const model = screen.getByTestId("agent-activity-model-invocation-budget");
    expect(within(model).getByText(/4 \/ 6 used/)).toBeDefined();
    expect(within(model).getByText(/2 remaining/)).toBeDefined();
  });

  it("falls back to a not-yet-allocated message when assist + model budgets are null", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "running",
        workflow: makeWorkflow({
          assistBudget: null,
          modelInvocationBudget: null,
        }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    expect(
      screen.getByTestId("agent-activity-assist-budget").textContent,
    ).toContain("Assist budget not yet allocated.");
    expect(
      screen.getByTestId("agent-activity-model-invocation-budget").textContent,
    ).toContain("Model invocation budget not yet allocated.");
  });

  it("lists repair attempts with decision, breadcrumbs, and rationale", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "running",
        workflow: makeWorkflow({
          activeAgent: "verification_repair_agent",
          repairAttempts: [
            {
              attemptNumber: 1,
              repairDecision: "propose_candidate",
              failureCategory: "oracle_mismatch",
              hasModelInvocation: true,
              hasRepairInput: true,
              hasJavaCandidate: true,
              rationale: "Retrying with adjusted accumulator logic.",
            },
            {
              attemptNumber: 2,
              repairDecision: "escalate",
              failureCategory: null,
              hasModelInvocation: false,
              hasRepairInput: false,
              hasJavaCandidate: false,
            },
          ],
        }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    const list = screen.getByTestId("agent-activity-repair-attempts");
    expect(
      screen.getByTestId("agent-activity-workflow-status").textContent,
    ).toContain("1 invocation record observed");
    expect(within(list).getByText("Repair attempts (2)")).toBeDefined();
    expect(within(list).getByText("Attempt #1")).toBeDefined();
    expect(within(list).getByText("Proposed candidate")).toBeDefined();
    expect(within(list).getByText("oracle_mismatch")).toBeDefined();
    expect(
      within(list).getByText(/Retrying with adjusted accumulator logic/),
    ).toBeDefined();
    expect(within(list).getByText("Attempt #2")).toBeDefined();
    expect(within(list).getByText("Escalated")).toBeDefined();
  });

  it("renders the BFF failure verdict with closed-set label and description", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "failed",
        workflow: makeWorkflow({
          activeAgent: null,
          finalClassification: "blocked",
          failureCode: "model_gateway_unavailable",
          failureMessage: "gateway returned 502",
        }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    const failure = screen.getByTestId("agent-activity-final-failure");
    expect(
      within(failure).getByText("Model Gateway unavailable"),
    ).toBeDefined();
    expect(
      within(failure).getByText(/Model Gateway is not reachable/),
    ).toBeDefined();
    expect(within(failure).getByText("gateway returned 502")).toBeDefined();
  });

  it("renders a success verdict when finalClassification is success", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "completed",
        workflow: makeWorkflow({
          activeAgent: null,
          finalClassification: "success",
        }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    expect(screen.getByTestId("agent-activity-final-success")).toBeDefined();
  });

  // Issue #218 (W0.3-7): the assist-decision row is the causal hinge of
  // the Agent panel. The Studio must distinguish the three observable
  // states (pending, deterministic-only, AI-assisted) and never invent
  // an outcome the BFF did not publish.
  it("renders the assist-decision pending row when the gate has not fired", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "running",
        workflow: makeWorkflow({ assistDecision: null }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    const row = screen.getByTestId("agent-activity-assist-decision");
    expect(row.getAttribute("data-assist-mode")).toBe("pending");
    expect(row.textContent).toContain(
      "has not yet evaluated the assist-decision gate",
    );
    expect(screen.queryByTestId("agent-activity-assist-mode-badge")).toBeNull();
  });

  it("renders the deterministic-only badge when assist is not required", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "completed",
        workflow: makeWorkflow({
          finalClassification: "success",
          assistDecision: {
            outcome: "assist_not_required",
            reasonCode: "caller_did_not_opt_in",
            decidedAt: "2026-05-17T12:00:00Z",
            selectedAgentRole: null,
            affectedArtifactRefs: [],
            repairBudgetSnapshot: { limit: 3, used: 0, remaining: 3 },
            assistBudgetSnapshot: { limit: 1, used: 0, remaining: 1 },
            modelInvocationBudgetSnapshot: {
              limit: 6,
              used: 0,
              remaining: 6,
            },
            rationale: null,
          },
        }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    const row = screen.getByTestId("agent-activity-assist-decision");
    expect(row.getAttribute("data-assist-mode")).toBe("deterministic-only");
    expect(
      screen.getByTestId("agent-activity-assist-mode-badge").textContent,
    ).toContain("Deterministic-only run");
    expect(screen.getByTestId("agent-activity-assist-reason").textContent).toBe(
      "AI assist disabled",
    );
    expect(
      screen.getByTestId("agent-activity-assist-decided-at").textContent,
    ).toBe("2026-05-17T12:00:00Z");
    // No agent-role chip when assist was not required.
    expect(screen.queryByTestId("agent-activity-assist-agent-role")).toBeNull();
    // The deterministic-only badge must never imply success on its own —
    // the success row only appears when finalClassification is success.
    expect(screen.getByTestId("agent-activity-final-success")).toBeDefined();
  });

  it("renders the AI-assisted badge with reason, agent role, and rationale", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "running",
        workflow: makeWorkflow({
          activeAgent: "transformation_agent",
          assistBudget: { limit: 1, used: 1, remaining: 0 },
          modelInvocationBudget: { limit: 6, used: 1, remaining: 5 },
          assistDecision: {
            outcome: "assist_required",
            reasonCode: "semantic_ir_bounded_ambiguity",
            decidedAt: "2026-05-17T12:34:56Z",
            selectedAgentRole: "transformation_agent",
            affectedArtifactRefs: [
              {
                sha256: "a".repeat(64),
                byteSize: 64,
                kind: "semantic-ir",
              },
            ],
            repairBudgetSnapshot: { limit: 3, used: 0, remaining: 3 },
            assistBudgetSnapshot: { limit: 1, used: 1, remaining: 0 },
            modelInvocationBudgetSnapshot: {
              limit: 6,
              used: 1,
              remaining: 5,
            },
            rationale: "Bounded ambiguity in OCCURS-resolution.",
          },
        }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    const row = screen.getByTestId("agent-activity-assist-decision");
    expect(row.getAttribute("data-assist-mode")).toBe("ai-assisted");
    expect(
      screen.getByTestId("agent-activity-assist-mode-badge").textContent,
    ).toContain("AI-assisted run");
    expect(
      screen.getByTestId("agent-activity-assist-agent-role").textContent,
    ).toContain("Transformation Agent");
    expect(screen.getByTestId("agent-activity-assist-reason").textContent).toBe(
      "Semantic IR bounded ambiguity",
    );
    expect(
      screen.getByTestId("agent-activity-assist-rationale").textContent,
    ).toContain("Bounded ambiguity in OCCURS-resolution.");
    // Even on an AI-assisted run the verified-success affordance must
    // remain absent until the deterministic gates publish success.
    expect(screen.queryByTestId("agent-activity-final-success")).toBeNull();
  });

  it("renders the assist-budget-exhausted reason as AI assist did not activate", () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: "completed",
        workflow: makeWorkflow({
          assistDecision: {
            outcome: "assist_not_required",
            reasonCode: "assist_budget_exhausted",
            decidedAt: "2026-05-17T13:00:00Z",
            selectedAgentRole: null,
            affectedArtifactRefs: [],
            repairBudgetSnapshot: { limit: 3, used: 0, remaining: 3 },
            assistBudgetSnapshot: { limit: 1, used: 1, remaining: 0 },
            modelInvocationBudgetSnapshot: {
              limit: 6,
              used: 0,
              remaining: 6,
            },
            rationale: null,
          },
        }),
      },
    });
    render(
      <AgentActivityPanel emptyState={{ title: "Empty", message: "Empty" }} />,
    );
    const row = screen.getByTestId("agent-activity-assist-decision");
    expect(row.getAttribute("data-assist-mode")).toBe("deterministic-only");
    expect(screen.getByTestId("agent-activity-assist-reason").textContent).toBe(
      "Assist budget exhausted",
    );
  });
});
