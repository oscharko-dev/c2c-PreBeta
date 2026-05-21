// W0.3-7 (#218) browser acceptance for the causal assist-decision UI.
//
// The orchestrator-side assist gate (#214/#215/#216) and evidence
// lineage (#217) already land before this file. This spec exercises the
// browser-visible product surface: the Studio MUST distinguish
// deterministic-only runs from AI-assisted runs, surface the closed
// reason code that justified the decision, and keep the verified-success
// affordance gated on deterministic build/test + evidence completeness
// regardless of whether AI assist was activated.
//
// The deterministic CI gate runs without the Model Gateway, so both
// scenarios are wired through mocked BFF responses (Playwright
// page.route) rather than a live orchestrator. The mocked responses are
// shaped to match the BFF OpenAPI contract published in
// services/c2c-bff/openapi.yaml.

import { expect, test, type Page } from "@playwright/test";

const COBOL_EDITOR_LABEL = /COBOL source editor/i;

const MOCK_CORS_HEADERS = {
  "access-control-allow-origin": "http://127.0.0.1:3000",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "access-control-allow-credentials": "true",
};

interface RunFixture {
  runId: string;
  programId: string;
  cobolSource: string;
}

interface AssistDecisionFixture {
  outcome: "assist_required" | "assist_not_required";
  reasonCode: string;
  selectedAgentRole: "transformation_agent" | null;
  rationale: string | null;
}

interface ScenarioFixture {
  run: RunFixture;
  finalClassification: "success" | "blocked" | "failed";
  buildTestStatus: "ok" | "skipped";
  evidenceStatus: "complete" | "incomplete";
  assistBudget: { limit: number; used: number; remaining: number };
  modelInvocationBudget: { limit: number; used: number; remaining: number };
  assistDecision: AssistDecisionFixture;
}

function trustCaseSummary(programId: string) {
  return {
    trustCaseId: `trust-${programId.toLowerCase()}`,
    version: "trust-case-v1",
    catalogVersion: "catalog-v1",
    catalogHash: "trust-case-hash-1",
    configurationDigest: `digest-${programId.toLowerCase()}`,
    programId,
    title: "W0.4 deterministic baseline",
    description:
      "Deterministic baseline trust-case used for Studio E2E assertions.",
    defaultForProgram: true,
    sourceReferenceFixtureId: "fixture-w04-baseline",
    sourceReferenceMode: "reference-routine",
    environmentProfileId: "env-dev",
    comparisonStrategy: "deterministic",
    comparisonPolicyVersion: "policy-v1",
    supportedSubset: ["basic-cobol"],
  };
}

function trustCaseIdentity(programId: string) {
  const trustCase = trustCaseSummary(programId);

  return {
    trustCaseId: trustCase.trustCaseId,
    trustCaseVersion: trustCase.version,
    trustCaseCatalogVersion: trustCase.catalogVersion,
    trustCaseCatalogHash: trustCase.catalogHash,
    trustCaseConfigurationDigest: trustCase.configurationDigest,
    trustCaseEnvironmentProfileId: trustCase.environmentProfileId,
    trustCaseComparisonPolicyVersion: trustCase.comparisonPolicyVersion,
    sourceReferenceFixtureId: trustCase.sourceReferenceFixtureId,
    sourceReferenceMode: trustCase.sourceReferenceMode,
  };
}

function expectReadyWorkbench(page: Page) {
  return (async () => {
    await page.goto("/");
    await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
    await expect(page.getByLabel("Product readiness")).toContainText("Ready");
  })();
}

function topBarStartButton(page: Page) {
  return page
    .getByLabel("Workbench Top Bar")
    .getByRole("button", { name: "Generate & Verify" });
}

function cobolEditorSurface(page: Page) {
  return page
    .getByTestId("code-editor-standalone")
    .filter({ has: page.getByLabel(COBOL_EDITOR_LABEL) })
    .locator(".monaco-editor")
    .first();
}

async function enterCobolSource(page: Page, source: string) {
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __c2cEditorHarnessReady?: boolean })
          .__c2cEditorHarnessReady,
      ),
    null,
    { timeout: 15_000 },
  );
  await page.evaluate((sourceText) => {
    window.dispatchEvent(
      new CustomEvent("c2c-e2e:load-cobol", {
        detail: { sourceText, sourceName: "pasted-source.cbl" },
      }),
    );
  }, source);
  const editorSurface = cobolEditorSurface(page);
  await expect(editorSurface).toBeVisible();
}

async function setAiAssist(page: Page, enabled: boolean) {
  const toggle = page.getByRole("checkbox", {
    name: /allow ai assist after deterministic baseline/i,
  });
  await expect(toggle).toBeVisible();
  await toggle.setChecked(enabled);
  await expect(toggle).toBeChecked({ checked: enabled });
}

function runLinks(runId: string) {
  return {
    self: `/api/v0/runs/${runId}`,
    generated: `/api/v0/runs/${runId}/generated`,
    generatedFiles: `/api/v0/runs/${runId}/generated/files`,
    buildTest: `/api/v0/runs/${runId}/build-test`,
    evidence: `/api/v0/runs/${runId}/evidence`,
    events: `/api/v0/runs/${runId}/events`,
    artifacts: `/api/v0/runs/${runId}/artifacts`,
    progress: `/api/v0/runs/${runId}/progress`,
    workflow: `/api/v0/runs/${runId}/workflow`,
    learning: `/api/v0/runs/${runId}/learning`,
  };
}

async function mockBffScenario(page: Page, fixture: ScenarioFixture) {
  const { run, finalClassification, buildTestStatus, evidenceStatus } =
    fixture;
  const { runId, programId } = run;
  const links = runLinks(runId);
  const isSuccess = finalClassification === "success";
  const trustCase = trustCaseSummary(programId);
  const generatedSha = "deadbeef".repeat(8);
  const javaSource = [
    "public final class W03Demo {",
    "  public static void main(String[] args) {",
    '    System.out.println("w0.3");',
    "  }",
    "}",
  ].join("\n");
  const entryFilePath = "src/main/java/W03Demo.java";
  const modelGatewayAvailable =
    fixture.assistDecision.outcome === "assist_required";

  await page.route("**/api/v0/trust-cases*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({
        schemaVersion: "v0",
        catalogVersion: trustCase.catalogVersion,
        catalogHash: trustCase.catalogHash,
        programId,
        defaultTrustCaseId: trustCase.trustCaseId,
        savedTrustCaseId: trustCase.trustCaseId,
        trustCases: [trustCase],
      }),
    });
  });

  await page.route("**/api/v0/model-gateway/health*", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: MOCK_CORS_HEADERS });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify(
        modelGatewayAvailable
          ? {
              status: "ok",
              providerMode: "w0.3-test",
              activeModelCount: 1,
              dataPolicy: "model-gateway",
              ledgerEnabled: true,
              eventEmission: true,
              policyId: "w0.3-test-policy",
              roleAvailability: [
                {
                  role: "transformation",
                  status: "ok",
                  policyId: "w0.3-test-policy",
                  availableModels: ["w0.3-test-model"],
                  configuredModels: ["w0.3-test-model"],
                  reason: "",
                },
              ],
            }
          : {
              status: "unavailable",
              error: "Model Gateway unavailable in deterministic W0 mode",
            },
      ),
    });
  });

  await page.route("**/api/v0/model-gateway/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify(
        modelGatewayAvailable
          ? {
              models: [
                {
                  id: "w0.3-test-model",
                  name: "W0.3 Test Model",
                  provider: "test",
                },
              ],
            }
          : { models: [] },
      ),
    });
  });

  await page.route(
    /\/api\/v0\/transform(?:\?.*)?$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: MOCK_CORS_HEADERS });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          orchestratorRunId: runId,
          programId,
          ...trustCaseIdentity(programId),
          status: "starting",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-17T00:00:00Z",
          updatedAt: "2026-05-17T00:00:00Z",
          links,
        }),
      });
    },
  );

  await page.route("**/api/v0/session/bootstrap*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({
        tenantId: "issue-362-fixture-tenant",
        userId: "issue-362-fixture-user",
        draftKeyWrappingSecret:
          "e2e-tenant:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        telemetrySalt: "issue-362-telemetry-salt",
        studioRedactionPatternAdditions: [],
      }),
    });
  });

  await page.route("**/api/v0/editor/telemetry*", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: MOCK_CORS_HEADERS });
      return;
    }
    await route.fulfill({
      status: 204,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: "",
    });
  });

  await page.route(`**/api/v0/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({
        runId,
        orchestratorRunId: runId,
        programId,
        ...trustCaseIdentity(programId),
        status: isSuccess ? "completed" : "failed",
        mode: "live",
        productMode: "live",
        createdAt: "2026-05-17T00:00:00Z",
        updatedAt: "2026-05-17T00:00:02Z",
        finalClassification,
        failureCode: isSuccess ? null : "java_runtime_failed",
        failureMessage: isSuccess ? null : "demo failure for fixture",
        links,
      }),
    });
  });

  await page.route(`**/api/v0/runs/${runId}/generated`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify(
        isSuccess
          ? {
              runId,
              programId,
              mode: "live",
              productMode: "live",
              status: "generated",
              entryClass: "W03Demo",
              entryFilePath,
              fileCount: 1,
              files: {},
              fileRefs: [
                {
                  path: entryFilePath,
                  sha256: generatedSha,
                  byteSize: javaSource.length,
                },
              ],
              artifactRef: {
                sha256: generatedSha,
                byteSize: javaSource.length,
              },
            }
          : {
              runId,
              programId,
              mode: "live",
              productMode: "live",
              status: "incomplete",
              missingArtifacts: ["generatedJava"],
              artifactRef: null,
              note: "Generation blocked.",
            },
      ),
    });
  });

  await page.route(
    `**/api/v0/runs/${runId}/generated/files`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify(
          isSuccess
            ? {
                runId,
                programId,
                mode: "live",
                productMode: "live",
                status: "complete",
                files: [
                  {
                    path: entryFilePath,
                    sha256: generatedSha,
                    byteSize: javaSource.length,
                    mimeType: "text/x-java-source",
                  },
                ],
                fileCount: 1,
                entryFilePath,
                artifactRef: {
                  sha256: generatedSha,
                  byteSize: javaSource.length,
                },
              }
            : {
                runId,
                programId,
                mode: "live",
                productMode: "live",
                status: "incomplete",
                files: [],
                fileCount: 0,
                artifactRef: null,
                missingArtifacts: ["generatedJava"],
              },
        ),
      });
    },
  );

  await page.route(
    `**/api/v0/runs/${runId}/generated/files/${entryFilePath}`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId,
          mode: "live",
          productMode: "live",
          path: entryFilePath,
          content: javaSource,
          sha256: generatedSha,
          byteSize: javaSource.length,
          mimeType: "text/x-java-source",
        }),
      });
    },
  );

  await page.route(`**/api/v0/runs/${runId}/build-test`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({
        runId,
        programId,
        mode: "live",
        productMode: "live",
        status: buildTestStatus,
        classification:
          buildTestStatus === "ok" ? "match" : "skipped-no-execution",
        generatedArtifactRef: isSuccess ? { sha256: generatedSha } : null,
        note:
          buildTestStatus === "skipped"
            ? "Build skipped because generation was blocked."
            : undefined,
      }),
    });
  });

  await page.route(`**/api/v0/runs/${runId}/evidence`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({
        runId,
        programId,
        mode: "live",
        productMode: "live",
        status: evidenceStatus,
        packId: `pack-${runId}`,
        manifestHash: "manifest-sha",
        generatedArtifactRef: isSuccess ? { sha256: generatedSha } : null,
        missingArtifacts:
          evidenceStatus === "incomplete" ? ["generatedJava"] : undefined,
      }),
    });
  });

  await page.route(`**/api/v0/runs/${runId}/events`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({
        runId,
        programId,
        mode: "live",
        productMode: "live",
        events: [],
      }),
    });
  });

  await page.route(`**/api/v0/runs/${runId}/progress`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({
        runId,
        programId,
        mode: "live",
        productMode: "live",
        status: "complete",
        runStatus: isSuccess ? "completed" : "failed",
        currentStep: null,
        failedStep: isSuccess ? null : "generate-java",
        completedSteps: isSuccess ? ["accepted", "completed"] : ["accepted"],
        stepCount: 2,
        steps: [
          {
            stepId: 1,
            name: "accepted",
            capabilityId: "orchestrator",
            service: "orchestrator",
            actor: "orchestrator",
            status: "ok",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/v0/runs/${runId}/experience`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({
        runId,
        programId,
        mode: "live",
        productMode: "live",
        summary: "W0.3 fixture.",
      }),
    });
  });

  await page.route(`**/api/v0/runs/${runId}/artifacts`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({
        runId,
        programId,
        mode: "live",
        productMode: "live",
        artifacts: [],
      }),
    });
  });

  await page.route(`**/api/v0/runs/${runId}/workflow`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({
        runId,
        programId,
        mode: "live",
        productMode: "live",
        source: "live",
        state: "final_classification",
        activeStep: null,
        activeAgent: null,
        agentAttemptCount:
          fixture.assistDecision.outcome === "assist_required" ? 1 : 0,
        repairBudget: { limit: 3, used: 0, remaining: 3 },
        assistBudget: fixture.assistBudget,
        modelInvocationBudget: fixture.modelInvocationBudget,
        repairAttempts: [],
        assistDecision: {
          outcome: fixture.assistDecision.outcome,
          reasonCode: fixture.assistDecision.reasonCode,
          decidedAt: "2026-05-17T00:00:01Z",
          selectedAgentRole: fixture.assistDecision.selectedAgentRole,
          affectedArtifactRefs: [],
          repairBudgetSnapshot: { limit: 3, used: 0, remaining: 3 },
          assistBudgetSnapshot: fixture.assistBudget,
          modelInvocationBudgetSnapshot: fixture.modelInvocationBudget,
          rationale: fixture.assistDecision.rationale,
        },
        finalClassification,
        failureCode: isSuccess ? null : "java_runtime_failed",
        failureMessage: isSuccess ? null : "demo failure for fixture",
        generatedJavaRef: isSuccess
          ? {
              sha256: generatedSha,
              byteSize: javaSource.length,
              kind: "generated-java",
            }
          : null,
        buildTestResultRef: isSuccess
          ? { sha256: generatedSha, byteSize: 16, kind: "build-test-result" }
          : null,
        evidencePackRef:
          isSuccess && evidenceStatus === "complete"
            ? {
                sha256: generatedSha,
                byteSize: 32,
                kind: "evidence-pack",
              }
            : null,
      }),
    });
  });
}

test.describe("W0.3-7 causal assist-decision browser acceptance", () => {
  test("renders a deterministic-only run with no AI assist activation", async ({
    page,
  }) => {
    const fixture: ScenarioFixture = {
      run: {
        runId: "run-w03-det-only",
        programId: "DETONLY01",
        cobolSource: `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. DETONLY01.\n       PROCEDURE DIVISION.\n           DISPLAY 'DET'.\n           STOP RUN.`,
      },
      finalClassification: "success",
      buildTestStatus: "ok",
      evidenceStatus: "complete",
      assistBudget: { limit: 1, used: 0, remaining: 1 },
      modelInvocationBudget: { limit: 6, used: 0, remaining: 6 },
      assistDecision: {
        outcome: "assist_not_required",
        reasonCode: "caller_did_not_opt_in",
        selectedAgentRole: null,
        rationale: null,
      },
    };
    await mockBffScenario(page, fixture);

    await expectReadyWorkbench(page);
    await enterCobolSource(page, fixture.run.cobolSource);
    await setAiAssist(page, false);
    await expect(topBarStartButton(page)).toBeEnabled();
    await topBarStartButton(page).click();

    await page.getByRole("tab", { name: "Agent" }).click();
    const agentPanel = page.getByTestId("agent-activity-panel");
    await expect(agentPanel).toBeVisible();

    const assistDecision = agentPanel.getByTestId(
      "agent-activity-assist-decision",
    );
    await expect(assistDecision).toHaveAttribute(
      "data-assist-mode",
      "deterministic-only",
    );
    await expect(
      agentPanel.getByTestId("agent-activity-assist-mode-badge"),
    ).toContainText("Deterministic-only run");
    await expect(
      agentPanel.getByTestId("agent-activity-assist-reason"),
    ).toContainText("AI assist disabled");
    // No agent-role chip when assist was not required.
    await expect(
      agentPanel.getByTestId("agent-activity-assist-agent-role"),
    ).toHaveCount(0);

    // The status bar surfaces the verified-success badge because all
    // deterministic gates passed; the deterministic-only badge above
    // confirms no AI assist participated in producing that success.
    await expect(page.getByTestId("status-bar-success-badge")).toContainText(
      "Verified",
    );
    await expect(page.getByTestId("status-bar-failure-code")).toHaveCount(0);
  });

  test("renders an AI-assisted run with reason, agent role, and rationale", async ({
    page,
  }) => {
    const fixture: ScenarioFixture = {
      run: {
        runId: "run-w03-assist-required",
        programId: "ASSIST01",
        cobolSource: `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. ASSIST01.\n       PROCEDURE DIVISION.\n           DISPLAY 'ASSIST'.\n           STOP RUN.`,
      },
      finalClassification: "success",
      buildTestStatus: "ok",
      evidenceStatus: "complete",
      assistBudget: { limit: 1, used: 1, remaining: 0 },
      modelInvocationBudget: { limit: 6, used: 1, remaining: 5 },
      assistDecision: {
        outcome: "assist_required",
        reasonCode: "semantic_ir_bounded_ambiguity",
        selectedAgentRole: "transformation_agent",
        rationale: "Bounded ambiguity resolved by Transformation Agent.",
      },
    };
    await mockBffScenario(page, fixture);

    await expectReadyWorkbench(page);
    await enterCobolSource(page, fixture.run.cobolSource);
    await expect(topBarStartButton(page)).toBeEnabled();
    await topBarStartButton(page).click();

    await page.getByRole("tab", { name: "Agent" }).click();
    const agentPanel = page.getByTestId("agent-activity-panel");
    await expect(agentPanel).toBeVisible();

    const assistDecision = agentPanel.getByTestId(
      "agent-activity-assist-decision",
    );
    await expect(assistDecision).toHaveAttribute(
      "data-assist-mode",
      "ai-assisted",
    );
    await expect(
      agentPanel.getByTestId("agent-activity-assist-mode-badge"),
    ).toContainText("AI-assisted run");
    await expect(
      agentPanel.getByTestId("agent-activity-assist-agent-role"),
    ).toContainText("Transformation Agent");
    await expect(
      agentPanel.getByTestId("agent-activity-assist-reason"),
    ).toContainText("Semantic IR bounded ambiguity");
    await expect(
      agentPanel.getByTestId("agent-activity-assist-rationale"),
    ).toContainText("Bounded ambiguity resolved by Transformation Agent.");

    // The assist budget and model invocation budget bars must reflect
    // the budget consumption captured at the gate.
    await expect(
      agentPanel.getByTestId("agent-activity-assist-budget"),
    ).toContainText("1 / 1 used");
    await expect(
      agentPanel.getByTestId("agent-activity-model-invocation-budget"),
    ).toContainText("1 / 6 used");

    // Verified-success on an AI-assisted run is allowed only because the
    // deterministic build/test + evidence gates passed — the assist
    // decision itself never grants the badge.
    await expect(page.getByTestId("status-bar-success-badge")).toContainText(
      "Verified",
    );
  });

  test("denies verified-success when an AI-assisted run lacks deterministic evidence", async ({
    page,
  }) => {
    // The assist gate activated and the orchestrator emitted a final
    // classification, but the deterministic evidence pack is incomplete.
    // The Studio MUST refuse the verified-success badge even though the
    // AI assist step ran — the deterministic gates are the only path to
    // verified-success and Issue #218 must not weaken that invariant.
    const fixture: ScenarioFixture = {
      run: {
        runId: "run-w03-assist-evidence-incomplete",
        programId: "ASSIST02",
        cobolSource: `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. ASSIST02.\n       PROCEDURE DIVISION.\n           DISPLAY 'INC'.\n           STOP RUN.`,
      },
      finalClassification: "success",
      buildTestStatus: "ok",
      evidenceStatus: "incomplete",
      assistBudget: { limit: 1, used: 1, remaining: 0 },
      modelInvocationBudget: { limit: 6, used: 1, remaining: 5 },
      assistDecision: {
        outcome: "assist_required",
        reasonCode: "caller_explicit_opt_in",
        selectedAgentRole: "transformation_agent",
        rationale: "Caller opted in.",
      },
    };
    await mockBffScenario(page, fixture);

    await expectReadyWorkbench(page);
    await enterCobolSource(page, fixture.run.cobolSource);
    await expect(topBarStartButton(page)).toBeEnabled();
    await topBarStartButton(page).click();

    await page.getByRole("tab", { name: "Agent" }).click();
    const agentPanel = page.getByTestId("agent-activity-panel");
    await expect(agentPanel).toBeVisible();
    await expect(
      agentPanel.getByTestId("agent-activity-assist-decision"),
    ).toHaveAttribute("data-assist-mode", "ai-assisted");

    // No verified-success badge — evidence is incomplete.
    await expect(page.getByTestId("status-bar-success-badge")).toHaveCount(0);
    await expect(page.getByText("Verified", { exact: true })).toHaveCount(0);
  });
});
