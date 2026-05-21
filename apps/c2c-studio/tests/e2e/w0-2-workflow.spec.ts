// W0.2 release-gate browser acceptance (Issue #175).
//
// The existing workflow.spec.ts covers the W0/W0.1 deterministic Studio
// path using BRNCH01 and already asserts the W0.2 workflow contract surface
// (workflow, repairAttempts, finalClassification) on the deterministic
// success path. This file complements it with the *real* (un-mocked)
// browser-visible proof for the W0.2 negative acceptance fixture
// (FILEIO-UNSUPPORTED): the orchestrator MUST honestly reject unsupported
// source through the W0.2 workflow contract without producing Java
// artifacts. The deterministic CI gate runs without the Model Gateway,
// so the agentic HELLOW02 success path is covered by the manual
// `scripts/w0-2-release-gate.sh --foundry` run rather than by Playwright.

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Response } from "@playwright/test";

const NEGATIVE_SOURCE = readFileSync(
  path.resolve(
    __dirname,
    "../../../../corpus/synthetic/programs/file-io-unsupported.cbl",
  ),
  "utf8",
);

const BFF_BASE_URL =
  process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL || "http://127.0.0.1:18089";

const NON_SUCCESS_CLASSIFICATIONS = new Set([
  "blocked",
  "failed",
  "incomplete",
]);

interface WorkflowView {
  runId: string;
  state: string | null;
  activeStep: string | null;
  activeAgent: string | null;
  agentAttemptCount: number;
  repairBudget: { limit: number; used: number; remaining: number } | null;
  repairAttempts: unknown[];
  // Issue #218 (W0.3-7): the assist-decision gate result. ``null`` on
  // FILEIO-UNSUPPORTED because the run terminates before the gate fires.
  assistDecision: unknown | null;
  finalClassification:
    | "success"
    | "blocked"
    | "failed"
    | "cancelled"
    | "incomplete"
    | null;
  failureCode: string | null;
  generatedJavaRef: { sha256: string; byteSize: number; kind: string } | null;
  buildTestResultRef: { sha256: string; byteSize: number; kind: string } | null;
  evidencePackRef: { sha256: string; byteSize: number; kind: string } | null;
}

async function fetchJsonFromPage<T>(
  page: Page,
  requestPath: string,
): Promise<T> {
  return page.evaluate(async (target) => {
    const response = await fetch(target);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${target}`);
    }
    return response.json();
  }, requestPath) as Promise<T>;
}

async function expectReadyWorkbench(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
  await expect(page.getByLabel("Product readiness")).toContainText("Ready");
}

function topBarStartButton(page: Page) {
  // Studio-IDE-13 (#255): the legacy "Start Transformation" topbar
  // button was renamed to "Generate & Verify" — the composed action
  // remains the same, only the label changed.
  return page
    .getByLabel("Workbench Top Bar")
    .getByRole("button", { name: "Generate & Verify" });
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
  const editorSurface = page.getByTestId("code-editor-standalone");
  await expect(editorSurface).toBeVisible();
  const aiAssistToggle = page.getByLabel(
    "Allow AI assist after deterministic baseline",
  );
  if (await aiAssistToggle.isChecked()) {
    await aiAssistToggle.click();
  }
  await expect(aiAssistToggle).not.toBeChecked();
  await expect(topBarStartButton(page)).toBeEnabled();
}

async function waitForTerminalNonSuccess(
  page: Page,
  runId: string,
  timeoutMs = 180_000,
): Promise<WorkflowView> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowView | null = null;
  while (Date.now() < deadline) {
    last = await fetchJsonFromPage<WorkflowView>(
      page,
      `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/workflow`,
    );
    if (
      last.finalClassification &&
      NON_SUCCESS_CLASSIFICATIONS.has(last.finalClassification)
    ) {
      return last;
    }
    if (last.finalClassification === "success") {
      throw new Error(
        `expected a non-success terminal for the FILEIO-UNSUPPORTED fixture, observed success; ` +
          `workflow=${JSON.stringify(last)}`,
      );
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    `timed out waiting for a non-success terminal classification; last=${JSON.stringify(last)}`,
  );
}

test.describe("W0.2 release-gate browser acceptance", () => {
  test("blocks the FILEIO-UNSUPPORTED fixture without producing Java", async ({
    page,
  }) => {
    await expectReadyWorkbench(page);
    await enterCobolSource(page, NEGATIVE_SOURCE);

    const transformResponsePromise: Promise<Response> = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v0/transform") &&
        response.status() === 201,
      { timeout: 120_000 },
    );

    await topBarStartButton(page).click();

    const transformResponse = await transformResponsePromise;
    expect(transformResponse.request().postDataJSON()).toEqual(
      expect.objectContaining({
        sourceText: NEGATIVE_SOURCE,
      }),
    );
    const transformBody = await transformResponse.json();
    expect(transformBody.runId).toBeTruthy();
    const runId = String(transformBody.runId);

    const workflow = await waitForTerminalNonSuccess(page, runId, 120_000);

    // The orchestrator's W0.2 workflow contract MUST reach a terminal
    // blocked state, MUST attach the closed-set unsupported-source
    // failure code, and MUST NOT surface any generated Java artifact for
    // unsupported source.
    expect(workflow.runId).toBe(runId);
    expect(workflow.finalClassification).toBe("blocked");
    expect(workflow.failureCode).toBe("unsupported_cobol");
    expect(workflow.generatedJavaRef).toBeNull();
    expect(workflow.state).toBe("final_classification");
    // Issue #218 (W0.3-7): unsupported source terminates the run before
    // the assist-decision gate fires. The contract MUST surface a null
    // assistDecision so the UI can honestly render the pending state
    // rather than fabricating an outcome.
    expect(workflow.assistDecision).toBeNull();

    // The Studio must not present any "Verified" affordance.
    await expect(page.getByText("Verified", { exact: true })).toHaveCount(0);

    await page.getByRole("tab", { name: "Agent" }).click();
    const agentPanel = page.getByTestId("agent-activity-panel");
    await expect(agentPanel).toBeVisible();
    await expect(agentPanel).toContainText(/Unsupported COBOL/);
    await expect(
      agentPanel.getByTestId("agent-activity-artifact-refs"),
    ).toContainText("Final Java");
    await expect(
      agentPanel.getByTestId("agent-activity-artifact-refs"),
    ).toContainText("not published");

    await page.getByRole("tab", { name: "Build & Test" }).click();
    await expect(page.getByText("Pipeline Stages")).toBeVisible();
    await expect(page.getByText("Build & Test Parity")).toBeVisible();
    await expect(page.getByText("Match (Equivalent)")).toHaveCount(0);

    await page.getByRole("tab", { name: "Evidence Pack" }).click();
    await expect(
      page.getByText(
        /Evidence Pack (Incomplete|Invalid|Mismatch Detected)|Waiting for evidence pack/,
      ),
    ).toBeVisible();

    // The Generated view must honestly report unsupported source — never
    // an empty success.
    const generated = await fetchJsonFromPage<{
      runId: string;
      status: string;
      unsupportedFeatures?: string[];
    }>(
      page,
      `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/generated`,
    );
    expect(generated.runId).toBe(runId);
    // The generated view's status is `unsupported` when the parser
    // emits a diagnostic, or `incomplete` when the orchestrator could
    // not invoke the parser at all. Both are honest non-success
    // surfaces — they are NOT `generated`.
    expect(generated.status).not.toBe("generated");
  });
});
