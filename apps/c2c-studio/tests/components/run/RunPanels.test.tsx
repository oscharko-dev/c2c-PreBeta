import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BuildTestPanel } from "../../../src/components/run/BuildTestPanel";
import { EvidencePackPanel } from "../../../src/components/run/EvidencePackPanel";
import { ProblemsPanel } from "../../../src/components/run/ProblemsPanel";
import { EquivalencePanel } from "../../../src/components/run/EquivalencePanel";
import { RunArtifactsPanel } from "../../../src/components/run/RunArtifactsPanel";
import * as apiClientModule from "../../../src/lib/apiClient";
import { describeManualDriftSummary } from "../../../src/components/run/runPanelUtils";

vi.mock("../../../src/lib/apiClient", () => ({
  apiClient: {
    getGeneratedFile: vi
      .fn()
      .mockResolvedValue({ ok: false, message: "mocked" }),
    getRunArtifactFile: vi
      .fn()
      .mockResolvedValue({ ok: false, message: "mocked" }),
  },
}));

const mockState = {
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
  previousRun: null,
};

const navigateToDiagnosticMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/stores/transformationRun", () => ({
  useTransformationRun: vi.fn(() => ({ state: mockState })),
}));

vi.mock("../../../src/stores/sourceWorkspace", () => ({
  useSourceWorkspace: vi.fn(() => ({
    statusFlags: {
      clean: true,
      pendingReRun: false,
    },
  })),
}));

vi.mock("@/lib/editor/markerNavigation", () => ({
  useMarkerNavigation: () => ({
    navigateToDiagnostic: navigateToDiagnosticMock,
  }),
}));

describe("Run Panels", () => {
  let useTransformationRunMock: any;
  let useSourceWorkspaceMock: any;
  let exportParityEvidenceScaffoldMock: any;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(apiClientModule.apiClient.getGeneratedFile).mockResolvedValue({
      ok: false,
      message: "mocked",
    });
    vi.mocked(apiClientModule.apiClient.getRunArtifactFile).mockResolvedValue({
      ok: false,
      message: "mocked",
    });
    exportParityEvidenceScaffoldMock = vi.fn();
    const mod = await import("../../../src/stores/transformationRun");
    useTransformationRunMock = mod.useTransformationRun;
    const sourceMod = await import("../../../src/stores/sourceWorkspace");
    useSourceWorkspaceMock = sourceMod.useSourceWorkspace;
    useSourceWorkspaceMock.mockReturnValue({
      statusFlags: {
        clean: true,
        pendingReRun: false,
      },
      selectedTrustCase: null,
    });
    useTransformationRunMock.mockReturnValue({
      state: mockState,
      exportParityEvidenceScaffold: exportParityEvidenceScaffoldMock,
      intentionalDivergenceDecision: null,
      intentionalDivergenceDecisionStatus: "idle",
      intentionalDivergenceDecisionError: null,
      submitIntentionalDivergenceDecision: vi.fn(),
    });
  });

  describe("BuildTestPanel", () => {
    it("renders build/test status and classification correctly", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          buildTest: {
            status: "ok",
            classification: "match",
            expectedOutput: "FOO",
            actualOutput: "FOO",
          },
        },
      });
      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );
      expect(screen.getByRole("tab", { name: /Transform/ })).toBeDefined();
      expect(
        screen.getByRole("tab", { name: /COBOL Reference Execution/ }),
      ).toBeDefined();
      expect(screen.getByRole("tab", { name: /Java Build/ })).toBeDefined();
      expect(screen.getByRole("tab", { name: /Java Execution/ })).toBeDefined();
      expect(
        screen.getByRole("tab", { name: /Parity Comparison/ }),
      ).toBeDefined();
      expect(screen.getAllByText("Pass").length).toBeGreaterThan(0);
    });

    it("preserves an explicit timeline stage selection as run status updates", () => {
      const completedState = {
        ...mockState,
        phase: "completed",
        buildTest: {
          status: "ok",
          classification: "match",
          expectedOutput: "FOO",
          actualOutput: "FOO",
        },
      };
      useTransformationRunMock.mockReturnValue({ state: completedState });
      const { rerender } = render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      const transformTab = screen.getByRole("tab", { name: /Transform/ });
      fireEvent.click(transformTab);
      expect(transformTab.getAttribute("aria-selected")).toBe("true");

      useTransformationRunMock.mockReturnValue({
        state: {
          ...completedState,
          buildTest: {
            status: "compile-failed",
            classification: "compile-error",
            note: "javac failed with type mismatch",
          },
        },
      });
      rerender(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      expect(
        screen
          .getByRole("tab", { name: /Transform/ })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });

    it("supports keyboard navigation for timeline stage tabs", async () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          buildTest: {
            status: "ok",
            classification: "match",
            expectedOutput: "FOO",
            actualOutput: "FOO",
          },
        },
      });
      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      expect(
        screen
          .getByRole("tablist", { name: /Build and test timeline stages/ })
          .getAttribute("aria-orientation"),
      ).toBe("vertical");
      const transformTab = screen.getByRole("tab", { name: /Transform/ });
      fireEvent.click(transformTab);
      fireEvent.keyDown(transformTab, { key: "ArrowDown" });

      await waitFor(() => {
        expect(
          screen
            .getByRole("tab", { name: /COBOL Reference Execution/ })
            .getAttribute("aria-selected"),
        ).toBe("true");
      });

      fireEvent.keyDown(
        screen.getByRole("tab", { name: /COBOL Reference Execution/ }),
        { key: "End" },
      );
      await waitFor(() => {
        expect(
          screen
            .getByRole("tab", { name: /Evidence Capture/ })
            .getAttribute("aria-selected"),
        ).toBe("true");
      });
    });

    it("associates timeline and inspector tabs with their rendered panels", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          buildTest: {
            status: "ok",
            classification: "match",
            expectedOutput: "FOO",
            actualOutput: "FOO",
          },
        },
      });
      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      const selectedStageTab = screen.getByRole("tab", { name: /Transform/ });
      const stagePanelId = selectedStageTab.getAttribute("aria-controls");
      expect(stagePanelId).toBe("build-test-stage-panel");
      expect(
        document.getElementById(stagePanelId!)?.getAttribute("aria-labelledby"),
      ).toBe(selectedStageTab.id);

      const artifactsTab = screen.getByRole("tab", { name: "Artifacts" });
      fireEvent.click(artifactsTab);
      const inspectorPanelId = artifactsTab.getAttribute("aria-controls");
      expect(inspectorPanelId).toBe("build-test-inspector-panel-artifacts");
      expect(
        document.getElementById(inspectorPanelId!)?.getAttribute("role"),
      ).toBe("tabpanel");
      expect(
        document
          .getElementById(inspectorPanelId!)
          ?.getAttribute("aria-labelledby"),
      ).toBe(artifactsTab.id);
    });

    it("renders build/test missing golden master", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          buildTest: {
            status: "missing-golden-master",
            classification: "skipped-no-execution",
          },
        },
      });
      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );
      expect(
        screen.getByRole("tab", { name: /COBOL Reference Execution/ }),
      ).toBeDefined();
      expect(
        screen.getAllByText("Waiting for backend evidence").length,
      ).toBeGreaterThan(0);
      expect(screen.getAllByText(/Not executed/i).length).toBeGreaterThan(0);
    });

    it("renders live orchestrator progress steps when available", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "running",
          progress: {
            runId: "run-progress",
            programId: "BRNCH01",
            mode: "live",
            productMode: "live",
            status: "complete",
            currentStep: "compile-test-java",
            failedStep: null,
            completedSteps: [
              "accepted",
              "parse-cobol",
              "generate-ir",
              "generate-java",
            ],
            stepCount: 3,
            steps: [
              {
                stepId: 1,
                name: "accepted",
                capabilityId: "orchestrator-service",
                service: "orchestrator-service",
                actor: "orchestrator-service",
                status: "ok",
              },
              {
                stepId: 2,
                name: "generate-java",
                capabilityId: "java-generator-service",
                service: "orchestrator-service",
                actor: "java-generator-service",
                status: "ok",
                latencyMs: 31,
              },
              {
                stepId: 3,
                name: "compile-test-java",
                capabilityId: "build-test-runner",
                service: "orchestrator-service",
                actor: "build-test-runner",
                status: "running",
              },
            ],
          },
        },
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );
      expect(screen.getByRole("tab", { name: /Transform/ })).toBeDefined();
      expect(screen.getByRole("tab", { name: /Java Build/ })).toBeDefined();
      expect(screen.getByText("build-test-runner is running")).toBeDefined();
    });

    it("renders model policy skipped progress without raw diagnostic leakage", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "running",
          progress: {
            runId: "run-progress",
            programId: "BRNCH01",
            mode: "live",
            productMode: "live",
            status: "complete",
            currentStep: null,
            failedStep: null,
            completedSteps: ["accepted", "model-policy-skipped"],
            stepCount: 2,
            steps: [
              {
                stepId: 1,
                name: "accepted",
                capabilityId: "orchestrator-service",
                service: "orchestrator-service",
                actor: "orchestrator-service",
                status: "ok",
              },
              {
                stepId: 2,
                name: "model-policy-skipped",
                capabilityId: "orchestrator-service",
                service: "orchestrator-service",
                actor: "orchestrator-service",
                status: "skipped",
                diagnostic: "Step skipped by workflow policy.",
              },
            ],
          },
        },
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );
      expect(screen.getByRole("tab", { name: /Transform/ })).toBeDefined();
      expect(
        screen.getAllByText("Skipped: Step skipped by workflow policy.").length,
      ).toBeGreaterThan(0);
    });

    it("marks parity results stale when the source workspace has pending re-run state", () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: false,
          pendingReRun: true,
        },
        selectedTrustCase: null,
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          buildTest: {
            status: "ok",
            classification: "match",
            expectedOutput: "OK",
            actualOutput: "OK",
          },
        },
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );
      expect(
        screen.getByText(
          "COBOL source changed after the last completed parity run. These parity results are stale until you rerun.",
        ),
      ).toBeDefined();
    });

    it("renders compile failure stages and failure note", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          buildTest: {
            status: "compile-failed",
            classification: "compile-error",
            note: "javac failed with type mismatch",
          },
        },
      });
      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );
      expect(
        screen.getByRole("tab", { name: /Parity Comparison/ }),
      ).toBeDefined();
      expect(
        screen.getAllByText("Blocked by compilation failure").length,
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText(
          "Java compilation failed before equivalence could run.",
        ).length,
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText("javac failed with type mismatch").length,
      ).toBeGreaterThan(0);
    });

    it("renders the trust summary card with read-only trust, result, and evidence data", () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: true,
          pendingReRun: false,
        },
        selectedTrustCase: {
          trustCaseId: "TC-ALPHA",
          version: "v7",
          catalogVersion: "2026.05",
          catalogHash: "catalog-hash",
          configurationDigest: "config-hash",
          programId: "PROG-1",
          title: "Trust Case Alpha",
          description: "Read-only trust case for verification.",
          defaultForProgram: true,
          sourceReferenceFixtureId: "fixture-alpha",
          sourceReferenceMode: "live",
          environmentProfileId: "env-prod",
          comparisonStrategy: "strict",
          comparisonPolicyVersion: "policy-4",
          supportedSubset: [],
        },
      });

      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          summary: {
            ...mockState.summary,
            runId: "run-123",
            programId: "PROG-1",
            trustCaseId: "TC-ALPHA",
            trustCaseVersion: "v7",
            trustCaseCatalogVersion: "2026.05",
            trustCaseConfigurationDigest: "config-hash",
            trustCaseEnvironmentProfileId: "env-prod",
            trustCaseComparisonPolicyVersion: "policy-4",
          },
          buildTest: {
            runId: "run-123",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            status: "ok",
            classification: "match",
            compileStatus: "ok",
            executionStatus: "ok",
            expectedOutput: "COBOL",
            actualOutput: "JAVA",
            expectedOutputRef: {
              sha256: "e".repeat(64),
              byteSize: 12,
              kind: "cobol-oracle-stdout",
            },
            actualOutputRef: {
              sha256: "a".repeat(64),
              byteSize: 13,
              kind: "java-stdout",
            },
            generatedArtifactRef: {
              sha256: "g".repeat(64),
              byteSize: 21,
              kind: "generated-artifact",
            },
            comparison: {
              status: "complete",
              comparisonPolicyRef: {
                sha256: "p".repeat(64),
                byteSize: 7,
                kind: "comparison-policy",
              },
              comparisonResultRef: {
                sha256: "r".repeat(64),
                byteSize: 8,
                kind: "comparison-result",
              },
              diffRef: {
                sha256: "d".repeat(64),
                byteSize: 9,
                kind: "comparison-diff",
              },
              expectedRef: {
                sha256: "e".repeat(64),
                byteSize: 12,
                kind: "cobol-oracle-stdout",
              },
              actualRef: {
                sha256: "a".repeat(64),
                byteSize: 13,
                kind: "java-stdout",
              },
            },
            note: "Comparison summary is published for audit.",
          },
          evidence: {
            runId: "run-123",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            status: "complete",
            packId: "pack-123",
            manifestHash: "manifest-123",
            artifactRef: {
              sha256: "m".repeat(64),
              byteSize: 17,
              kind: "evidence-manifest",
              createdAt: "2026-05-21T12:34:56.000Z",
            },
            exportRef: {
              sha256: "x".repeat(64),
              byteSize: 19,
              kind: "evidence-export",
            },
            generatedArtifactRef: {
              sha256: "g".repeat(64),
              byteSize: 21,
              kind: "generated-artifact",
            },
            note: "Evidence bundle is signed and archived.",
          },
          workflow: {
            runId: "run-123",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            source: "live",
            state: "verifying",
            activeStep: "verification-repair",
            activeAgent: "verification_repair_agent",
            trustCase: {
              trustCaseId: "TC-ALPHA",
            },
            agentAttemptCount: 1,
            repairBudget: {
              limit: 3,
              used: 1,
              remaining: 2,
            },
            assistBudget: null,
            modelInvocationBudget: null,
            repairAttempts: [
              {
                attemptNumber: 1,
                repairDecision: "propose_candidate",
                failureCategory: null,
                hasModelInvocation: true,
                hasRepairInput: true,
                hasJavaCandidate: true,
                rationale: "Repair candidate accepted for review.",
              },
            ],
            assistDecision: null,
            finalClassification: "failed",
            failureCode: "oracle_mismatch",
            failureMessage: "Repair guardrail escalated to manual review.",
            generatedJavaRef: null,
            buildTestResultRef: null,
            evidencePackRef: null,
          },
        },
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      expect(screen.getByText("Trust Summary")).toBeDefined();
      expect(screen.getByText("Trust Case Alpha")).toBeDefined();
      expect(screen.getByText("TC-ALPHA")).toBeDefined();
      expect(screen.getByText("COBOL result")).toBeDefined();
      expect(screen.getByText("Java result")).toBeDefined();
      expect(screen.getAllByText("Comparison result").length).toBeGreaterThan(
        0,
      );
      expect(screen.getByText("Repair status")).toBeDefined();
      expect(screen.getByText("Evidence timestamp")).toBeDefined();
      expect(
        screen.getAllByText("2026-05-21T12:34:56.000Z").length,
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText("Comparison summary is published for audit.")
          .length,
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText("Evidence bundle is signed and archived.").length,
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText("Repair guardrail escalated to manual review.")
          .length,
      ).toBeGreaterThan(0);
      expect(screen.getByText("pack-123")).toBeDefined();
      expect(
        screen.getByText(
          "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
        ),
      ).toBeDefined();
    });

    it("renders an intentional divergence decision form and validates required capture fields", () => {
      const submitDecisionMock = vi.fn();
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          summary: {
            ...mockState.summary,
            runId: "run-divergent",
            programId: "PROG-1",
            trustSummary: {
              trustState: "intentional_divergence",
              repairStatus: "repair_verified",
              coverageStatus: "full",
              divergenceDisposition: "intentional",
              intentionalDivergenceDecisionRef: {
                sha256: "z".repeat(64),
                byteSize: 9,
                kind: "intentional-divergence-decision",
              },
              warningCodes: [],
              trustCase: {
                trustCaseId: "TC-ALPHA",
                version: "v7",
                catalogVersion: "2026.05",
                catalogHash: "catalog-hash",
                configurationDigest: "config-hash",
              },
              cobolResult: { status: "completed" },
              javaResult: { status: "completed" },
              comparisonResult: {
                status: "mismatched",
                mismatchClassification: "intentional-divergence",
                decisionRecordRef: null,
              },
              repair: { status: "repair_verified" },
              evidence: { status: "current" },
              summaryDerivedAt: "2026-05-21T12:34:56.000Z",
            },
          },
          buildTest: {
            runId: "run-divergent",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            status: "output-divergence",
            classification: "divergence-unknown",
            note: "Intentionally accepted deviation.",
          },
          evidence: {
            runId: "run-divergent",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            status: "complete",
            generatedArtifactRef: { sha256: "z".repeat(64) },
          },
          workflow: {
            runId: "run-divergent",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            source: "live",
            state: "verifying",
            activeStep: null,
            activeAgent: null,
            trustCase: null,
            agentAttemptCount: 0,
            repairBudget: null,
            assistBudget: null,
            modelInvocationBudget: null,
            repairAttempts: [],
            assistDecision: null,
            trustSummary: null,
            finalClassification: "failed",
            failureCode: "oracle_mismatch",
            failureMessage: "Intentionally accepted deviation.",
            generatedJavaRef: null,
            buildTestResultRef: null,
            evidencePackRef: null,
          },
        },
        exportParityEvidenceScaffold: exportParityEvidenceScaffoldMock,
        intentionalDivergenceDecision: null,
        intentionalDivergenceDecisionStatus: "idle",
        intentionalDivergenceDecisionError: null,
        submitIntentionalDivergenceDecision: submitDecisionMock,
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      expect(
        screen.getAllByText("Intentionally diverged").length,
      ).toBeGreaterThan(0);
      expect(
        screen.getByRole("heading", {
          name: "Intentional divergence decision",
        }),
      ).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: /Record decision/i }));

      expect(submitDecisionMock).not.toHaveBeenCalled();
      expect(
        screen.getByText(
          "Rationale summary must be at least 12 characters long.",
        ),
      ).toBeDefined();
      expect(
        screen.getByText(
          "Technical basis must be at least 12 characters long.",
        ),
      ).toBeDefined();
      expect(
        screen.getByText(
          "Business impact must be at least 12 characters long.",
        ),
      ).toBeDefined();
      expect(screen.queryByText("Reviewer is required.")).toBeNull();
      expect(
        screen.getByText("At least one linked evidence ref is required."),
      ).toBeDefined();
      expect(
        screen.getByText("At least one affected output is required."),
      ).toBeDefined();
    });

    it("shows the intentional-divergence rerun banner in historical mode (#368 finding-3)", () => {
      const divergedTrustSummary = {
        trustState: "intentional_divergence",
        repairStatus: "repair_verified",
        coverageStatus: "full",
        divergenceDisposition: "intentional",
        intentionalDivergenceDecisionRef: {
          sha256: "z".repeat(64),
          byteSize: 9,
          kind: "intentional-divergence-decision",
        },
        warningCodes: [],
        trustCase: {
          trustCaseId: "TC-ALPHA",
          version: "v7",
          catalogVersion: "2026.05",
          catalogHash: "catalog-hash",
          configurationDigest: "config-hash",
        },
        cobolResult: { status: "completed" },
        javaResult: { status: "completed" },
        comparisonResult: {
          status: "mismatched",
          mismatchClassification: "intentional-divergence",
          decisionRecordRef: null,
        },
        repair: { status: "repair_verified" },
        evidence: { status: "current" },
        summaryDerivedAt: "2026-05-21T12:34:56.000Z",
      };
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "running",
          runId: "run-rerun",
          programId: "PROG-1",
          buildTest: null,
          previousRun: {
            runId: "run-prev",
            orchestratorRunId: "run-prev-orch",
            programId: "PROG-1",
            phase: "completed",
            summary: {
              ...mockState.summary,
              runId: "run-prev",
              programId: "PROG-1",
              trustSummary: divergedTrustSummary,
            },
            generated: null,
            generatedFiles: null,
            buildTest: {
              runId: "run-prev",
              programId: "PROG-1",
              mode: "live",
              productMode: "live",
              status: "output-divergence",
              classification: "divergence-unknown",
            },
            evidence: null,
            events: null,
            progress: {
              runId: "run-prev",
              programId: "PROG-1",
              mode: "live",
              productMode: "live",
              status: "complete",
              runStatus: "completed",
              currentStep: null,
              failedStep: null,
              completedSteps: ["compile-test-java"],
              stepCount: 1,
              steps: [
                {
                  stepId: 1,
                  name: "compile-test-java",
                  capabilityId: "build-test-runner",
                  service: "build-test-runner",
                  actor: "build-test-runner",
                  status: "ok",
                  latencyMs: 42,
                },
              ],
            },
            artifacts: null,
            experience: null,
            workflow: null,
          },
        },
        exportParityEvidenceScaffold: exportParityEvidenceScaffoldMock,
        intentionalDivergenceDecision: null,
        intentionalDivergenceDecisionStatus: "idle",
        intentionalDivergenceDecisionError: null,
        submitIntentionalDivergenceDecision: vi.fn(),
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      expect(
        screen.getByText(
          "Showing the previous intentionally diverged parity results while the latest rerun is in progress. These results are stale until the rerun completes.",
        ),
      ).toBeDefined();
    });

    it("exports a parity scaffold and surfaces the export status in the trust summary", async () => {
      exportParityEvidenceScaffoldMock.mockResolvedValue({
        ok: true,
        data: {
          runId: "run-123",
          programId: "PROG-1",
          status: "created",
          message: "Scaffold exported for review.",
          export: {
            exportId: "export-123",
            projectRoot: "runs/run-123/exports/java-regression/case01",
            scaffoldTestPath:
              "runs/run-123/exports/java-regression/case01/src/test/java/com/demo/CASE01ParityRegressionTest.java",
            scaffoldRef: {
              sha256: "s".repeat(64),
              path: "runs/run-123/exports/java-regression/case01/src/test/java/com/demo/CASE01ParityRegressionTest.java",
              createdAt: "2026-05-21T13:00:00.000Z",
            },
            projectManifestRef: {
              sha256: "p".repeat(64),
            },
            manifestRef: {
              sha256: "m".repeat(64),
            },
            expectedOutputRef: {
              sha256: "e".repeat(64),
            },
            createdAt: "2026-05-21T13:00:00.000Z",
            qualification: "clean",
          },
        },
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          runId: "run-123",
          programId: "PROG-1",
          buildTest: {
            runId: "run-123",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            status: "ok",
            classification: "match",
            generatedArtifactRef: null,
          },
          evidence: {
            runId: "run-123",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            status: "complete",
            generatedArtifactRef: null,
          },
        },
        exportParityEvidenceScaffold: exportParityEvidenceScaffoldMock,
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: /Export Java regression scaffold/i,
        }),
      );

      await waitFor(() =>
        expect(exportParityEvidenceScaffoldMock).toHaveBeenCalledTimes(1),
      );
      expect(screen.getByText("Scaffold exported for review.")).toBeDefined();
      expect(screen.getByText("Clean export")).toBeDefined();
      expect(
        screen.getAllByText(
          "runs/run-123/exports/java-regression/case01/src/test/java/com/demo/CASE01ParityRegressionTest.java",
        ).length,
      ).toBeGreaterThan(1);
    });

    it("surfaces export errors when parity evidence is not eligible", async () => {
      exportParityEvidenceScaffoldMock.mockResolvedValue({
        ok: false,
        message:
          "export blocked: incomplete evidence cannot produce a regression scaffold",
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          runId: "run-123",
          programId: "PROG-1",
          buildTest: {
            runId: "run-123",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            status: "ok",
            classification: "match",
            generatedArtifactRef: null,
          },
          evidence: {
            runId: "run-123",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            status: "incomplete",
            missingArtifacts: ["generatedJava"],
            generatedArtifactRef: null,
          },
        },
        exportParityEvidenceScaffold: exportParityEvidenceScaffoldMock,
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: /Export Java regression scaffold/i,
        }),
      );

      await waitFor(() =>
        expect(exportParityEvidenceScaffoldMock).toHaveBeenCalledTimes(1),
      );
      expect(
        screen.getByText(
          "Export failed: export blocked: incomplete evidence cannot produce a regression scaffold",
        ),
      ).toBeDefined();
    });

    it("does not loop when evidence artifacts are present (regression: stable-primitive effect deps)", async () => {
      // Regression for the infinite render / refetch loop fixed in BuildTestPanel.
      // Pre-fix: the artifact-fetch useEffect depended on `selectedArtifact` (a new
      // object every render) and `state.runId`.  With artifacts present,
      // `selectedArtifact` was always !== the previous value, so the effect fired on
      // every render, which scheduled another state update, which triggered another
      // render — "Maximum update depth exceeded".
      // Post-fix: the effect depends on stable primitives `artifactFetchKind`,
      // `artifactPath`, and `runId`, so it fires only when those strings change.
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          runId: "run-artifact-loop",
          buildTest: {
            status: "ok",
            classification: "match",
            expectedOutput: "OUT",
            actualOutput: "OUT",
          },
          artifacts: {
            artifacts: [
              {
                path: "runs/run-artifact-loop/generated.json",
                name: "generated.json",
                kind: "generated-artifact",
                byteSize: 42,
                sha256: "a".repeat(64),
                createdBy: "build-test-runner",
                createdAt: "2026-05-22T10:00:00.000Z",
              },
            ],
          },
          generatedFiles: {
            files: [
              {
                path: "src/main/java/Prog.java",
                sha256: "b".repeat(64),
                byteSize: 128,
                mimeType: "text/x-java-source",
              },
            ],
          },
        },
        exportParityEvidenceScaffold: exportParityEvidenceScaffoldMock,
      });

      // If the infinite loop regresses, render() will throw
      // "Maximum update depth exceeded" synchronously or within the waitFor.
      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      // The panel must render the timeline (verifies no crash).
      expect(screen.getByRole("tab", { name: /Transform/ })).toBeDefined();

      // Exactly one artifact-fetch call is fired (not an unbounded storm).
      // The effect triggers once because runId + artifactPath + artifactFetchKind
      // are all stable strings after the first render.
      const mockedApi = vi.mocked(apiClientModule.apiClient);
      await waitFor(() => {
        const totalCalls =
          mockedApi.getRunArtifactFile.mock.calls.length +
          mockedApi.getGeneratedFile.mock.calls.length;
        expect(totalCalls).toBeGreaterThanOrEqual(1);
        expect(totalCalls).toBeLessThanOrEqual(3);
      });
    });

    it("renders the previous run's timeline and diagnostics in historical mode after a failed rerun (#358)", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "failed",
          runId: "run-failed-rerun",
          programId: "PROG-1",
          buildTest: null,
          previousRun: {
            runId: "run-prev",
            orchestratorRunId: "run-prev-orch",
            programId: "PROG-1",
            phase: "completed",
            summary: null,
            generated: null,
            generatedFiles: null,
            buildTest: {
              runId: "run-prev",
              programId: "PROG-1",
              mode: "live",
              productMode: "live",
              status: "ok",
              classification: "match",
              compileStatus: "ok",
              executionStatus: "ok",
              diagnostics: [
                {
                  severity: "warning",
                  code: "PREV-DIAG-1",
                  filePath: "src/main/java/Prog.java",
                  line: 12,
                  message: "Previous run diagnostic carried over.",
                },
              ],
            },
            evidence: null,
            events: null,
            progress: {
              runId: "run-prev",
              programId: "PROG-1",
              mode: "live",
              productMode: "live",
              status: "complete",
              runStatus: "completed",
              currentStep: null,
              failedStep: null,
              completedSteps: ["compile-test-java"],
              stepCount: 1,
              steps: [
                {
                  stepId: 1,
                  name: "compile-test-java",
                  capabilityId: "build-test-runner",
                  service: "build-test-runner",
                  actor: "build-test-runner",
                  status: "ok",
                  latencyMs: 42,
                },
              ],
            },
            artifacts: null,
            experience: null,
            workflow: null,
          },
        },
        exportParityEvidenceScaffold: exportParityEvidenceScaffoldMock,
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      // Stale banner is shown for the failed rerun.
      expect(
        screen.getByText(
          "Latest rerun failed. Showing the previous parity results as stale so the last completed comparison remains accessible.",
        ),
      ).toBeDefined();

      // Timeline reflects the previous run's build/test data, not the
      // failed current run's empty (all-pending) timeline.
      expect(
        screen.getAllByText("The generated Java project compiled successfully.")
          .length,
      ).toBeGreaterThan(0);

      // Diagnostics tab reflects the previous run's diagnostics.
      fireEvent.click(screen.getByRole("tab", { name: /Diagnostics/ }));
      expect(screen.getByText("PREV-DIAG-1")).toBeDefined();
      expect(
        screen.getByText("Previous run diagnostic carried over."),
      ).toBeDefined();
    });

    it("does not render the current run's workflow.failureMessage in historical mode (#405 finding-1)", () => {
      const currentRunFailureMessage =
        "CURRENT_RUN_WORKFLOW_FAILURE: rerun failed with oracle mismatch";
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "failed",
          runId: "run-failed",
          buildTest: null,
          workflow: {
            runId: "run-failed",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            source: "live",
            state: "failed",
            activeStep: null,
            activeAgent: null,
            trustCase: null,
            agentAttemptCount: 0,
            repairBudget: null,
            assistBudget: null,
            modelInvocationBudget: null,
            repairAttempts: [],
            assistDecision: null,
            finalClassification: "failed",
            failureCode: "oracle_mismatch",
            failureMessage: currentRunFailureMessage,
            generatedJavaRef: null,
            buildTestResultRef: null,
            evidencePackRef: null,
          },
          previousRun: {
            runId: "run-prev",
            orchestratorRunId: "run-prev-orch",
            programId: "PROG-1",
            phase: "completed",
            summary: null,
            generated: null,
            generatedFiles: null,
            buildTest: {
              runId: "run-prev",
              programId: "PROG-1",
              mode: "live",
              productMode: "live",
              status: "ok",
              classification: "match",
            },
            evidence: null,
            events: null,
            progress: null,
            artifacts: null,
            experience: null,
            workflow: null,
          },
        },
        exportParityEvidenceScaffold: exportParityEvidenceScaffoldMock,
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      // The current run's failureMessage must NOT appear anywhere in the panel
      // when historical mode is active — it belongs to the in-flight/failed run,
      // not to the previous run whose results are displayed.
      expect(
        screen.queryByText(currentRunFailureMessage),
      ).not.toBeInTheDocument();
    });

    it("disables the parity-evidence export action in historical mode (#405 finding-2)", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "failed",
          runId: "run-failed",
          buildTest: null,
          evidence: null,
          previousRun: {
            runId: "run-prev",
            orchestratorRunId: "run-prev-orch",
            programId: "PROG-1",
            phase: "completed",
            summary: null,
            generated: null,
            generatedFiles: null,
            buildTest: {
              runId: "run-prev",
              programId: "PROG-1",
              mode: "live",
              productMode: "live",
              status: "ok",
              classification: "match",
            },
            evidence: {
              runId: "run-prev",
              programId: "PROG-1",
              mode: "live",
              productMode: "live",
              status: "complete",
              generatedArtifactRef: null,
            },
            events: null,
            progress: null,
            artifacts: null,
            experience: null,
            workflow: null,
          },
        },
        exportParityEvidenceScaffold: exportParityEvidenceScaffoldMock,
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      const exportButton = screen.getByRole("button", {
        name: /Export Java regression scaffold/i,
      });
      // The button must be disabled in historical mode even though the displayed
      // evidence (previous run's) is non-null — export targets the active run.
      expect(exportButton).toBeDisabled();
    });

    it("marks parity results produced by another trust case or catalog version", () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: true,
          pendingReRun: false,
        },
        selectedTrustCase: {
          trustCaseId: "CURRENT-CASE",
          configurationDigest: "current-digest",
        },
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          summary: {
            trustCaseId: "OLD-CASE",
            trustCaseConfigurationDigest: "old-digest",
          },
          buildTest: {
            status: "ok",
            classification: "match",
            expectedOutput: "FOO",
            actualOutput: "FOO",
          },
        },
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      expect(
        screen.getByText(
          /Existing parity results were produced from\s+OLD-CASE or a\s+different catalog version\. Rerun to use\s+CURRENT-CASE\./,
        ),
      ).toBeDefined();
    });

    it("renders neutral cancelled stages with cancellation detail and recovery action (#364)", () => {
      // Arrange: a run whose workflow has finalClassification "cancelled".
      // No build/test data so every timeline stage starts as pending and is
      // then converted to neutral by the cancellation pass in buildTimelineStages.
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          buildTest: null,
          workflow: {
            runId: "run-cancelled",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            source: "live",
            state: "cancelled",
            activeStep: null,
            activeAgent: null,
            trustCase: null,
            agentAttemptCount: 0,
            repairBudget: null,
            assistBudget: null,
            modelInvocationBudget: null,
            repairAttempts: [],
            assistDecision: null,
            trustSummary: null,
            finalClassification: "cancelled",
            failureCode: null,
            failureMessage: null,
            generatedJavaRef: null,
            buildTestResultRef: null,
            evidencePackRef: null,
          },
        },
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      // The cancellation detail text must appear in the rendered timeline.
      // getAllByText tolerates it appearing in both the stage list and the
      // detail panel (matching the pattern used by other multi-occurrence assertions
      // in this file, e.g. the compile-failure test at line ~417).
      expect(
        screen.getAllByText(
          "The run was cancelled before this stage completed.",
        ).length,
      ).toBeGreaterThan(0);

      // The recovery action label must also be visible.
      expect(
        screen.getAllByText("Rerun the parity workflow").length,
      ).toBeGreaterThan(0);
    });

    it("does NOT render the cancellation detail when finalClassification is not cancelled (mutation control, #364)", () => {
      // Control: identical fixture with finalClassification "failed" must not
      // render the cancelled-specific strings. This test catches a mutation of
      // the "cancelled" literal in buildTimelineStages.
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          buildTest: null,
          workflow: {
            runId: "run-failed",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            source: "live",
            state: "failed",
            activeStep: null,
            activeAgent: null,
            trustCase: null,
            agentAttemptCount: 0,
            repairBudget: null,
            assistBudget: null,
            modelInvocationBudget: null,
            repairAttempts: [],
            assistDecision: null,
            trustSummary: null,
            finalClassification: "failed",
            failureCode: "oracle_mismatch",
            failureMessage: null,
            generatedJavaRef: null,
            buildTestResultRef: null,
            evidencePackRef: null,
          },
        },
      });

      render(
        <BuildTestPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      expect(
        screen.queryByText(
          "The run was cancelled before this stage completed.",
        ),
      ).toBeNull();
    });
  });

  describe("EquivalencePanel", () => {
    it("renders expected vs actual output correctly", () => {
      render(
        <EquivalencePanel
          isPending={false}
          buildTest={{
            runId: "123",
            programId: "456",
            mode: "live",
            productMode: "live",
            status: "ok",
            classification: "divergence-unknown",
            expectedOutput: "Line 1\nLine 2",
            actualOutput: "Line A\nLine B",
            expectedOutputRef: {
              sha256: "e".repeat(64),
              byteSize: 13,
              kind: "cobol-oracle-stdout",
            },
            actualOutputRef: {
              sha256: "a".repeat(64),
              byteSize: 14,
              kind: "java-stdout",
            },
            generatedArtifactRef: null,
          }}
        />,
      );
      expect(screen.getByText("Mismatch detected")).toBeDefined();
      expect(screen.getAllByText("Expected output").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Actual output").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Cobol Oracle Stdout/).length).toBeGreaterThan(
        1,
      );
      expect(screen.getAllByText(/Java Stdout/).length).toBeGreaterThan(0);
      expect(screen.getByText("Line 1")).toBeDefined();
      expect(screen.getByText("Line 2")).toBeDefined();
      expect(screen.getByText("Line A")).toBeDefined();
      expect(screen.getByText("Line B")).toBeDefined();
    });

    it("distinguishes known W0 coverage gaps from unknown divergence", () => {
      render(
        <EquivalencePanel
          isPending={false}
          buildTest={{
            runId: "123",
            programId: "456",
            mode: "live",
            productMode: "live",
            status: "output-divergence",
            classification: "divergence-known-w0-coverage-gap",
            expectedOutput: "COBOL",
            actualOutput: "JAVA",
            generatedArtifactRef: null,
          }}
        />,
      );

      expect(screen.getByText("Known divergence")).toBeDefined();
      expect(screen.queryByText("Mismatch detected")).not.toBeInTheDocument();
    });

    it("renders a blocked parity label for compile failures", () => {
      render(
        <EquivalencePanel
          isPending={false}
          buildTest={{
            runId: "123",
            programId: "456",
            mode: "live",
            productMode: "live",
            status: "compile-failed",
            classification: "compile-error",
            generatedArtifactRef: null,
          }}
        />,
      );

      expect(
        screen.getAllByText("Blocked by compilation failure").length,
      ).toBeGreaterThan(0);
      expect(screen.queryByText("Mismatch detected")).not.toBeInTheDocument();
    });
  });

  describe("EvidencePackPanel", () => {
    it("renders evidence complete correctly", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          generated: {
            artifactRef: {
              sha256: "abc123",
            },
          },
          buildTest: {
            generatedArtifactRef: {
              sha256: "abc123",
            },
          },
          evidence: {
            status: "complete",
            packId: "pack-123",
            manifestHash: "manifest-sha-123",
            generatedArtifactRef: {
              sha256: "abc123",
            },
          },
        },
      });
      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );
      expect(screen.getByText("Evidence Pack Complete")).toBeDefined();
      expect(screen.getByText("pack-123")).toBeDefined();
      expect(screen.getByText("manifest-sha-123")).toBeDefined();
      expect(
        screen.getByText("All required artifacts are present."),
      ).toBeDefined();
      expect(
        screen.getByText(
          "Displayed Java, build/test, and evidence all reference the same generated artifact.",
        ),
      ).toBeDefined();
    });

    it("renders evidence incomplete with missing artifacts correctly", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          evidence: {
            status: "incomplete",
            missingArtifacts: ["Missing1", "Missing2"],
          },
        },
      });
      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );
      expect(screen.getByText("Evidence Pack Incomplete")).toBeDefined();
      expect(screen.getByText("Missing1")).toBeDefined();
      expect(screen.getByText("Missing2")).toBeDefined();
    });

    it("marks current evidence stale after a COBOL edit", () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: false,
          pendingReRun: true,
        },
        selectedTrustCase: null,
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          evidence: {
            status: "complete",
            packId: "pack-stale",
            manifestHash: "manifest-stale",
            generatedArtifactRef: {
              sha256: "abc123",
            },
          },
        },
      });

      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );
      expect(
        screen.getByText(
          "COBOL source changed after the last completed parity run. The current evidence pack is stale until you rerun.",
        ),
      ).toBeDefined();
    });

    it("marks current evidence stale when Java buffers diverge from the generator baseline", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          evidence: {
            status: "complete",
            packId: "pack-drift",
            manifestHash: "manifest-drift",
            generatedArtifactRef: {
              sha256: "abc123",
            },
          },
        },
        manualDriftSummary: () => ({
          hasManualEdits: true,
          fileCount: 2,
          regionCount: 3,
          baselineRunIds: ["run-123"],
        }),
      });

      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );
      expect(
        screen.getAllByText(
          "Current Java diverges from run run-123. 2 files and 3 regions carry manual edit provenance, so build/test and evidence are stale until you rerun.",
        ).length,
      ).toBeGreaterThan(0);
    });

    it("marks evidence produced by another trust case or catalog version", () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: true,
          pendingReRun: false,
        },
        selectedTrustCase: {
          trustCaseId: "CURRENT-CASE",
          configurationDigest: "current-digest",
        },
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          summary: {
            trustCaseId: "OLD-CASE",
            trustCaseConfigurationDigest: "old-digest",
          },
          generated: {
            artifactRef: {
              sha256: "abc123",
            },
          },
          buildTest: {
            generatedArtifactRef: {
              sha256: "abc123",
            },
          },
          evidence: {
            status: "complete",
            packId: "pack-trust-case",
            manifestHash: "manifest-trust-case",
            generatedArtifactRef: {
              sha256: "abc123",
            },
          },
        },
      });

      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );
      expect(
        screen.getByText(
          /Existing evidence was produced from\s+OLD-CASE or a different catalog version\. Rerun to use\s+CURRENT-CASE\./,
        ),
      ).toBeDefined();
    });

    it("keeps previous evidence accessible when the latest rerun fails", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "failed",
          evidence: null,
          previousRun: {
            runId: "run-prev",
            orchestratorRunId: "run-prev-orch",
            programId: "P-1",
            phase: "completed",
            summary: null,
            generated: {
              artifactRef: {
                sha256: "abc123",
              },
            },
            generatedFiles: null,
            buildTest: {
              generatedArtifactRef: {
                sha256: "abc123",
              },
            },
            evidence: {
              status: "complete",
              packId: "pack-prev",
              manifestHash: "manifest-prev",
              generatedArtifactRef: {
                sha256: "abc123",
              },
            },
            events: null,
            progress: null,
            artifacts: null,
            experience: null,
            workflow: null,
          },
        },
      });

      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );
      expect(screen.getByText("Previous Evidence Pack Complete")).toBeDefined();
      expect(
        screen.getByText(
          "Latest rerun failed. Showing the previous evidence pack as stale so the last completed evidence remains accessible.",
        ),
      ).toBeDefined();
      expect(screen.getByText("pack-prev")).toBeDefined();
    });

    it("does not render a success headline when artifact references are mismatched", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          generated: {
            artifactRef: {
              sha256: "abc123",
              path: "artifacts/generated.json",
            },
          },
          buildTest: {
            generatedArtifactRef: {
              sha256: "def456",
              path: "artifacts/build-test.json",
            },
          },
          evidence: {
            status: "complete",
            generatedArtifactRef: {
              sha256: "abc123",
              path: "artifacts/evidence.json",
            },
          },
        },
      });

      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );
      expect(screen.getByText("Evidence Pack Mismatch Detected")).toBeDefined();
      expect(
        screen.queryByText("Evidence Pack Complete"),
      ).not.toBeInTheDocument();
    });

    it("does not bleed current-run workflow.trustSummary into historical-evidence mode (#359 finding-1)", () => {
      // F1 — historical mode: previousRun.summary has no trustSummary but
      // state.workflow.trustSummary is intentional-divergence. The intentional-
      // divergence banner must NOT render because the displayed evidence belongs
      // to the previous run, not the current (in-flight) run.
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "running",
          runId: "run-new",
          evidence: null,
          workflow: {
            runId: "run-new",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            source: "live",
            state: "verifying",
            activeStep: null,
            activeAgent: null,
            trustCase: null,
            agentAttemptCount: 0,
            repairBudget: null,
            assistBudget: null,
            modelInvocationBudget: null,
            repairAttempts: [],
            assistDecision: null,
            trustSummary: {
              trustState: "intentional_divergence",
              divergenceDisposition: "intentional",
              warningCodes: [],
            },
            finalClassification: null,
            failureCode: null,
            failureMessage: null,
            generatedJavaRef: null,
            buildTestResultRef: null,
            evidencePackRef: null,
          },
          previousRun: {
            runId: "run-prev",
            orchestratorRunId: "run-prev-orch",
            programId: "PROG-1",
            phase: "completed",
            summary: {
              runId: "run-prev",
              programId: "PROG-1",
              // Deliberately absent: no trustSummary on the previous run's summary
            },
            generated: null,
            generatedFiles: null,
            buildTest: null,
            evidence: {
              runId: "run-prev",
              programId: "PROG-1",
              mode: "live",
              productMode: "live",
              status: "complete",
              packId: "pack-prev",
              manifestHash: "manifest-prev",
              generatedArtifactRef: null,
            },
            events: null,
            progress: null,
            artifacts: null,
            experience: null,
            workflow: null,
          },
        },
      });

      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );

      // The intentional-divergence warning banner must NOT appear — it would
      // describe the current run's workflow state, not the displayed previous evidence.
      expect(
        screen.queryByText(
          /This evidence pack supports an intentional divergence decision/,
        ),
      ).not.toBeInTheDocument();
    });

    it("renders intentional-divergence banner in non-historical mode when trustSummary indicates it (#359 finding-1 non-regression)", () => {
      // Non-historical case: state.summary.trustSummary is intentional divergence
      // → the banner must appear.
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          summary: {
            runId: "run-cur",
            programId: "PROG-1",
            trustSummary: {
              trustState: "intentional_divergence",
              divergenceDisposition: "intentional",
              warningCodes: [],
            },
          },
          evidence: {
            runId: "run-cur",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            status: "complete",
            packId: "pack-cur",
            manifestHash: "manifest-cur",
            generatedArtifactRef: null,
          },
        },
      });

      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );

      expect(
        screen.getByText(
          /This evidence pack supports an intentional divergence decision/,
        ),
      ).toBeDefined();
    });

    it("suppresses inline Artifact-Lineage manual-drift block in historical-evidence mode (#359 finding-2)", () => {
      // F2 — historical mode with a truthy manualDriftSummary: the inline
      // Artifact-Lineage drift block must NOT render because manualDriftMessage
      // describes the CURRENT Java buffer, not the displayed previous evidence.
      const driftSummary = () => ({
        hasManualEdits: true,
        fileCount: 1,
        regionCount: 1,
        baselineRunIds: ["run-prev"],
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "running",
          runId: "run-new",
          evidence: null,
          previousRun: {
            runId: "run-prev",
            orchestratorRunId: "run-prev-orch",
            programId: "PROG-1",
            phase: "completed",
            summary: null,
            generated: null,
            generatedFiles: null,
            buildTest: null,
            evidence: {
              runId: "run-prev",
              programId: "PROG-1",
              mode: "live",
              productMode: "live",
              status: "complete",
              packId: "pack-prev",
              manifestHash: "manifest-prev",
              generatedArtifactRef: null,
            },
            events: null,
            progress: null,
            artifacts: null,
            experience: null,
            workflow: null,
          },
        },
        manualDriftSummary: driftSummary,
      });

      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );

      // The Artifact Lineage section must exist but its inline drift block must
      // not render — the message describes the current (in-flight) Java buffer.
      expect(screen.getByText("Artifact Lineage")).toBeDefined();
      // The drift message string must not appear inside the Artifact Lineage card.
      // In historical mode the top banner shows the historical-evidence message,
      // not the drift message, so the drift message appears nowhere in the panel.
      const lineageCard = screen
        .getByText("Artifact Lineage")
        .closest(".bg-bg-1");
      expect(lineageCard).not.toBeNull();
      const driftMsg =
        "Current Java diverges from run run-prev. 1 file and 1 region carry manual edit provenance, so build/test and evidence are stale until you rerun.";
      // The message should not exist inside the lineage card
      expect(lineageCard?.textContent).not.toContain(driftMsg);
    });

    it("renders inline Artifact-Lineage manual-drift block in non-historical mode (#359 finding-2 non-regression)", () => {
      // Non-historical case: manualDriftSummary is truthy → inline block appears.
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          evidence: {
            runId: "run-cur",
            programId: "PROG-1",
            mode: "live",
            productMode: "live",
            status: "complete",
            packId: "pack-cur",
            manifestHash: "manifest-cur",
            generatedArtifactRef: null,
          },
        },
        manualDriftSummary: () => ({
          hasManualEdits: true,
          fileCount: 2,
          regionCount: 4,
          baselineRunIds: ["run-prev"],
        }),
      });

      render(
        <EvidencePackPanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );

      const driftMsg =
        "Current Java diverges from run run-prev. 2 files and 4 regions carry manual edit provenance, so build/test and evidence are stale until you rerun.";
      // Assert the drift message appears specifically inside the Artifact Lineage
      // card — not merely somewhere on the panel. This catches a regression where
      // the inline block stops rendering even though the top-of-panel banner still
      // contains the message.
      const lineageCard = screen
        .getByText("Artifact Lineage")
        .closest(".bg-bg-1");
      expect(lineageCard).not.toBeNull();
      expect(lineageCard?.textContent).toContain(driftMsg);
    });
  });

  describe("RunArtifactsPanel", () => {
    it("renders artifact list hash/path correctly", () => {
      const artifacts = [
        {
          path: "artifacts/source.cbl",
          name: "art1",
          kind: "source",
          byteSize: 1234,
          sha256: "hash123",
          createdBy: "system",
          createdAt: "2026-05-15T12:00:00Z",
        },
      ];
      render(<RunArtifactsPanel artifacts={artifacts} />);
      expect(
        screen.getByRole("option", { name: /artifacts\/source\.cbl/i }),
      ).toBeDefined();
      expect(screen.getAllByText("source").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/1234 bytes/).length).toBeGreaterThan(0);
      expect(screen.getAllByText("hash123").length).toBeGreaterThan(0);
    });

    it("renders artifact fetch errors separately from the artifact list", () => {
      render(
        <RunArtifactsPanel
          artifacts={[]}
          errorMessage="artifacts endpoint returned 503"
        />,
      );
      expect(screen.getByText("Artifacts fetch failed")).toBeDefined();
      expect(screen.getByText("artifacts endpoint returned 503")).toBeDefined();
    });

    it("renders missing artifact records even when no artifact rows exist", () => {
      render(
        <RunArtifactsPanel
          artifacts={[]}
          missingArtifacts={["generatedJava"]}
        />,
      );
      expect(screen.getByText("Missing artifact records")).toBeDefined();
      expect(screen.getByText("generatedJava")).toBeDefined();
      expect(screen.getByText("No run artifacts available.")).toBeDefined();
    });

    it("moves artifact focus with keyboard navigation", () => {
      const artifacts = [
        {
          path: "artifacts/source.cbl",
          name: "art1",
          kind: "source",
          byteSize: 1234,
          sha256: "hash123",
          createdBy: "system",
          createdAt: "2026-05-15T12:00:00Z",
        },
        {
          path: "artifacts/build.log",
          name: "art2",
          kind: "log",
          byteSize: 42,
          sha256: "hash456",
          createdBy: "runner",
          createdAt: "2026-05-15T12:01:00Z",
        },
      ];

      render(<RunArtifactsPanel artifacts={artifacts} />);
      const firstArtifact = screen.getByRole("option", {
        name: /artifacts\/source\.cbl/i,
      });
      fireEvent.keyDown(firstArtifact, { key: "ArrowDown" });
      expect(
        screen.getByRole("option", {
          name: /artifacts\/build\.log/i,
          selected: true,
        }),
      ).toBeDefined();
      expect(screen.getAllByText("hash456").length).toBeGreaterThan(0);
    });
  });

  describe("ProblemsPanel", () => {
    it("derives issues from features, missing artifacts, failed statuses, and hash mismatches", () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          generated: {
            unsupportedFeatures: ["GOTO", "ALTER"],
            missingArtifacts: ["GenMiss"],
            diagnostics: [
              {
                severity: "warning",
                code: "gen-open-assumption",
                message: "fallback path used",
                line: 4,
                originStep: "generate-java",
              },
            ],
            artifactRef: {
              sha256: "aaa",
              path: "artifacts/generated.json",
            },
          },
          generatedFiles: {
            missingArtifacts: ["FilesMiss"],
          },
          buildTest: {
            status: "compile-failed",
            classification: "compile-error",
            diagnostics: [
              {
                severity: "error",
                code: "javac-syntax",
                message: "missing semicolon",
                line: 12,
                column: 7,
                filePath: "src/main/java/P1.java",
                sourceKind: "generated_java",
              },
            ],
            generatedArtifactRef: {
              sha256: "bbb",
              path: "artifacts/build-test.json",
            },
          },
          evidence: {
            status: "incomplete",
            generatedArtifactRef: {
              sha256: "ccc",
              path: "artifacts/evidence.json",
            },
          },
          artifactsError: "artifact endpoint failed",
        },
      });
      render(
        <ProblemsPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );
      expect(screen.getByText("GOTO")).toBeDefined();
      expect(screen.getByText("ALTER")).toBeDefined();
      expect(screen.getByText("GenMiss")).toBeDefined();
      expect(screen.getByText("FilesMiss")).toBeDefined();
      expect(screen.getByText("compile-failed")).toBeDefined();
      // Studio-IDE-5 (#244): typed diagnostics now render in a table.
      // Severity/file/line/code/message appear in their own cells.
      expect(screen.getByText("gen-open-assumption")).toBeDefined();
      expect(screen.getByText("fallback path used")).toBeDefined();
      expect(screen.getByText("javac-syntax")).toBeDefined();
      expect(screen.getByText("missing semicolon")).toBeDefined();
      expect(screen.getByText("src/main/java/P1.java")).toBeDefined();
      // The line column shows the bare integer.
      expect(screen.getAllByText("12").length).toBeGreaterThan(0);
      expect(screen.getAllByText("4").length).toBeGreaterThan(0);
      expect(
        screen.getByText("The evidence pack is missing required artifacts"),
      ).toBeDefined();
      expect(screen.getByText("artifact endpoint failed")).toBeDefined();
      expect(
        screen.getByText(
          "Generated Java, build/test, and evidence do not reference the same artifact hash",
        ),
      ).toBeDefined();
    });

    it("navigates only diagnostics with a concrete editor target", () => {
      const jumpableDiagnostic = {
        severity: "error",
        code: "JUMP",
        message: "jumpable diagnostic",
        line: 9,
        column: 3,
        filePath: "src/main/java/App.java",
        sourceKind: "generated_java",
      };
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          generated: {
            status: "generated",
            diagnostics: [
              jumpableDiagnostic,
              {
                severity: "warning",
                code: "RUN",
                message: "run-level diagnostic",
                line: 3,
                sourceKind: "build",
              },
            ],
          },
          buildTest: null,
        },
      });

      render(
        <ProblemsPanel emptyState={{ title: "Empty", message: "Message" }} />,
      );

      const jumpableRow = screen.getByLabelText(
        "error JUMP at src/main/java/App.java:9",
      );
      const runLevelRow = screen.getByLabelText("warning RUN at —:3");

      expect(jumpableRow).toHaveAttribute("tabindex", "0");
      expect(runLevelRow).toHaveAttribute("tabindex", "-1");

      fireEvent.click(jumpableRow);
      fireEvent.keyDown(jumpableRow, { key: "Enter" });
      fireEvent.keyDown(jumpableRow, { key: " " });
      expect(navigateToDiagnosticMock).toHaveBeenCalledTimes(3);
      expect(navigateToDiagnosticMock).toHaveBeenCalledWith(jumpableDiagnostic);

      fireEvent.click(runLevelRow);
      fireEvent.keyDown(runLevelRow, { key: "Enter" });
      fireEvent.keyDown(runLevelRow, { key: " " });
      expect(navigateToDiagnosticMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("RunLifecyclePanel", () => {
    it("renders lifecycle events when available", async () => {
      const { RunLifecyclePanel } =
        await import("../../../src/components/run/RunLifecyclePanel");
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: "completed",
          events: {
            events: [
              {
                createdAt: "2026-05-15T12:00:00Z",
                type: "run.completed",
                status: "completed",
                message: "Transformation finished",
              },
            ],
          },
        },
      });
      render(
        <RunLifecyclePanel
          emptyState={{ title: "Empty", message: "Message" }}
        />,
      );
      expect(screen.getByText("run.completed")).toBeDefined();
      expect(screen.getByText("Transformation finished")).toBeDefined();
    });
  });

  describe("runPanelUtils", () => {
    describe("describeManualDriftSummary", () => {
      it("omits region clause when regionCount is 0 (#359 finding-3)", () => {
        // During the async window after a keystroke, manualEditOverlay is not yet
        // populated, so regionCount is 0. The message must not say "0 regions".
        const result = describeManualDriftSummary({
          hasManualEdits: true,
          fileCount: 1,
          regionCount: 0,
          baselineRunIds: ["run-x"],
        });
        expect(result).not.toBeNull();
        expect(result).toContain("1 file");
        expect(result).not.toContain("0 region");
        expect(result).not.toContain("regions");
        // Singular file with no regions → subject-verb agreement requires "carries"
        expect(result).toContain("1 file carries");
      });

      it("uses carry for regionCount:0 and fileCount > 1 (plural files, no regions)", () => {
        const result = describeManualDriftSummary({
          hasManualEdits: true,
          fileCount: 2,
          regionCount: 0,
          baselineRunIds: ["run-x"],
        });
        expect(result).not.toBeNull();
        expect(result).toContain("2 files carry");
        expect(result).not.toContain("carries");
      });

      it("includes region clause when regionCount is non-zero (#359 finding-3 non-regression)", () => {
        const result = describeManualDriftSummary({
          hasManualEdits: true,
          fileCount: 1,
          regionCount: 2,
          baselineRunIds: ["run-x"],
        });
        expect(result).not.toBeNull();
        expect(result).toContain("1 file");
        expect(result).toContain("2 regions");
        // Compound subject (file and regions) → always "carry"
        expect(result).toContain("carry");
        expect(result).not.toContain("carries");
      });
    });
  });
});
