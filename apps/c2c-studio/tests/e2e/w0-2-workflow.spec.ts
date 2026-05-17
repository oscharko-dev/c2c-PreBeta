// W0.2 release-gate browser acceptance (Issue #175).
//
// The existing workflow.spec.ts covers the W0/W0.1 deterministic Studio
// path using BRNCH01 and already asserts the W0.2 workflow contract surface
// (workflow, repairAttempts, finalClassification) on the deterministic
// happy path. This file complements it with the *real* (un-mocked)
// browser-visible proof for the W0.2 negative acceptance fixture
// (FILEIO-UNSUPPORTED): the orchestrator MUST honestly reject unsupported
// source through the W0.2 workflow contract without producing Java
// artifacts. The deterministic CI gate runs without the Model Gateway,
// so the agentic HELLOW02 success path is covered by the manual
// `scripts/w0-2-release-gate.sh --foundry` run rather than by Playwright.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';

const COBOL_EDITOR_LABEL = /COBOL source editor/i;

const NEGATIVE_SOURCE = readFileSync(
  path.resolve(__dirname, '../../../../corpus/synthetic/programs/file-io-unsupported.cbl'),
  'utf8',
);

const BFF_BASE_URL = process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL || 'http://127.0.0.1:18089';

// The W0.2 BFF surfaces a closed enum of failure codes. Either code below
// is an honest non-success classification for unsupported source: the
// parser emits an unsupported-feature diagnostic (orchestrator mapping
// per docs/contracts/orchestrator-w02-workflow.md), and depending on
// whether the diagnostic is reachable at parser-success or at
// parser-422 boundary, the orchestrator surfaces either
// `unsupported_cobol` (parsed-but-unsupported) or `parse_failed`
// (parser rejected). Both are valid; the gate accepts the union so the
// browser test is not coupled to the specific orchestrator mapping.
const NON_SUCCESS_CLASSIFICATIONS = new Set(['blocked', 'failed', 'incomplete']);
const ACCEPTED_UNSUPPORTED_FAILURE_CODES = new Set(['unsupported_cobol', 'parse_failed']);

interface WorkflowView {
  runId: string;
  state: string | null;
  activeStep: string | null;
  activeAgent: string | null;
  agentAttemptCount: number;
  repairBudget: { limit: number; used: number; remaining: number } | null;
  repairAttempts: unknown[];
  finalClassification: 'success' | 'blocked' | 'failed' | 'cancelled' | 'incomplete' | null;
  failureCode: string | null;
  generatedJavaRef: { sha256: string; byteSize: number; kind: string } | null;
  buildTestResultRef: { sha256: string; byteSize: number; kind: string } | null;
  evidencePackRef: { sha256: string; byteSize: number; kind: string } | null;
}

async function fetchJsonFromPage<T>(page: Page, requestPath: string): Promise<T> {
  return page.evaluate(async target => {
    const response = await fetch(target);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${target}`);
    }
    return response.json();
  }, requestPath) as Promise<T>;
}

async function expectReadyWorkbench(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('studio-workbench-shell')).toBeVisible();
  await expect(page.getByLabel('Product readiness')).toContainText('Ready');
}

function topBarStartButton(page: Page) {
  return page.getByLabel('Workbench Top Bar').getByRole('button', { name: 'Start Transformation' });
}

async function enterCobolSource(page: Page, source: string, expectedProgramIdRegex: RegExp) {
  await page.getByRole('button', { name: 'Start Typing' }).click();
  const editor = page.getByRole('textbox', { name: COBOL_EDITOR_LABEL });
  await editor.fill(source);
  await expect(editor).toHaveValue(expectedProgramIdRegex);
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
    if (last.finalClassification && NON_SUCCESS_CLASSIFICATIONS.has(last.finalClassification)) {
      return last;
    }
    if (last.finalClassification === 'success') {
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

test.describe('W0.2 release-gate browser acceptance', () => {
  test('blocks the FILEIO-UNSUPPORTED fixture without producing Java', async ({ page }) => {
    await expectReadyWorkbench(page);
    await enterCobolSource(page, NEGATIVE_SOURCE, /PROGRAM-ID\. FILEIONO\./);

    const transformResponsePromise: Promise<Response> = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/v0/transform') &&
        response.status() === 201,
      { timeout: 120_000 },
    );

    await topBarStartButton(page).click();

    const transformResponse = await transformResponsePromise;
    const transformBody = await transformResponse.json();
    expect(transformBody.runId).toBeTruthy();
    const runId = String(transformBody.runId);

    const workflow = await waitForTerminalNonSuccess(page, runId, 120_000);

    // The orchestrator's W0.2 workflow contract MUST reach a terminal
    // state, MUST carry a non-success classification, MUST attach one of
    // the closed-set unsupported-source failure codes, and MUST NOT
    // surface any generated Java artifact for unsupported source.
    expect(workflow.runId).toBe(runId);
    expect(NON_SUCCESS_CLASSIFICATIONS.has(workflow.finalClassification!)).toBe(true);
    expect(workflow.failureCode).not.toBeNull();
    expect(ACCEPTED_UNSUPPORTED_FAILURE_CODES.has(workflow.failureCode!)).toBe(true);
    expect(workflow.generatedJavaRef).toBeNull();
    expect(workflow.state).toBe('final_classification');

    // The Studio must not present any "Verified" affordance.
    await expect(page.getByText('Verified', { exact: true })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Agent' }).click();
    const agentPanel = page.getByTestId('agent-activity-panel');
    await expect(agentPanel).toBeVisible();
    await expect(agentPanel).toContainText(/Unsupported COBOL|COBOL parsing failed/);
    await expect(agentPanel.getByTestId('agent-activity-artifact-refs')).toContainText('Final Java');
    await expect(agentPanel.getByTestId('agent-activity-artifact-refs')).toContainText('not published');

    await page.getByRole('tab', { name: 'Build & Test' }).click();
    await expect(page.getByText('Pipeline Stages')).toBeVisible();
    await expect(page.getByText('Equivalence Analysis')).toBeVisible();
    await expect(page.getByText('Match (Equivalent)')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Evidence Pack' }).click();
    await expect(page.getByText(/Evidence Pack (Incomplete|Invalid|Mismatch Detected)|Waiting for evidence pack/)).toBeVisible();

    // The Generated view must honestly report unsupported source — never
    // an empty success.
    const generated = await fetchJsonFromPage<{
      runId: string;
      status: string;
      unsupportedFeatures?: string[];
    }>(page, `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/generated`);
    expect(generated.runId).toBe(runId);
    // The generated view's status is `unsupported` when the parser
    // emits a diagnostic, or `incomplete` when the orchestrator could
    // not invoke the parser at all. Both are honest non-success
    // surfaces — they are NOT `generated`.
    expect(generated.status).not.toBe('generated');
  });
});
