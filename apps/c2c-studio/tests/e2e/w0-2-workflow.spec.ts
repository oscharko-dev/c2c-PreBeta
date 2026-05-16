// W0.2 release-gate browser acceptance (Issue #175).
//
// The existing workflow.spec.ts covers the W0/W0.1 deterministic Studio
// path using BRNCH01. This file exercises the W0.2 *acceptance fixture*
// (HELLOW02 + FILEIO-UNSUPPORTED) so the release gate has a stable
// browser-visible proof that the agentic workflow contract is wired
// end-to-end: source on the left, agentic loop in the middle, generated
// Java + W0.2 Evidence Pack + workflow contract on the right.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';

const COBOL_EDITOR_LABEL = /COBOL source editor/i;
const GENERATED_JAVA_LABEL = /Generated Java source for/i;

const POSITIVE_SOURCE = readFileSync(
  path.resolve(__dirname, '../../../../corpus/synthetic/programs/hello-w02.cbl'),
  'utf8',
);
const NEGATIVE_SOURCE = readFileSync(
  path.resolve(__dirname, '../../../../corpus/synthetic/programs/file-io-unsupported.cbl'),
  'utf8',
);

const BFF_BASE_URL = process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL || 'http://127.0.0.1:18089';
const MODEL_GATEWAY_FLAG = process.env.C2C_LOCAL_MODEL_GATEWAY_ENABLED?.trim().toLowerCase();
const EXPECT_MODEL_POLICY_SKIPPED = MODEL_GATEWAY_FLAG === 'false' || MODEL_GATEWAY_FLAG === '0';

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
  await expect(page.getByRole('application', { name: 'c2c Studio Workbench' })).toBeVisible();
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

async function waitForFinalClassification(
  page: Page,
  runId: string,
  expected: WorkflowView['finalClassification'],
  timeoutMs = 180_000,
): Promise<WorkflowView> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowView | null = null;
  while (Date.now() < deadline) {
    last = await fetchJsonFromPage<WorkflowView>(
      page,
      `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/workflow`,
    );
    if (last.finalClassification === expected) {
      return last;
    }
    // If the run already finished with a different classification, fail fast
    // rather than letting the deadline run out.
    if (last.finalClassification !== null && last.finalClassification !== expected) {
      throw new Error(
        `expected finalClassification=${expected}, observed ${last.finalClassification}; ` +
          `workflow=${JSON.stringify(last)}`,
      );
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    `timed out waiting for finalClassification=${expected}; last=${JSON.stringify(last)}`,
  );
}

test.describe('W0.2 release-gate browser acceptance', () => {
  test('completes the HELLOW02 agentic path and surfaces the W0.2 contract', async ({ page }) => {
    await expectReadyWorkbench(page);
    await enterCobolSource(page, POSITIVE_SOURCE, /PROGRAM-ID\. HELLOW02\./);

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

    const workflow = await waitForFinalClassification(page, runId, 'success');

    expect(workflow.runId).toBe(runId);
    expect(workflow.failureCode).toBeNull();
    expect(workflow.state).toBe('final_classification');
    expect(workflow.activeAgent).toBeNull();
    expect(workflow.repairBudget).not.toBeNull();
    expect(workflow.repairBudget?.limit).toBeGreaterThanOrEqual(1);
    expect(workflow.repairBudget?.used + workflow.repairBudget!.remaining).toBe(workflow.repairBudget!.limit);
    expect(workflow.generatedJavaRef?.sha256).toMatch(/^[0-9a-f]{64}$/i);
    expect(workflow.buildTestResultRef?.sha256).toMatch(/^[0-9a-f]{64}$/i);
    expect(workflow.evidencePackRef?.sha256).toMatch(/^[0-9a-f]{64}$/i);
    expect(Array.isArray(workflow.repairAttempts)).toBe(true);

    // The Studio must render the generated Java pane for this run.
    await expect(page.getByLabel(GENERATED_JAVA_LABEL)).toBeVisible();
    await expect(page.getByText('Verified', { exact: true })).toBeVisible();

    // Build/Test pipeline view must reflect the W0.2 steps.
    await page.getByRole('tab', { name: 'Build & Test' }).click();
    await expect(page.getByText('Parse COBOL')).toBeVisible();
    await expect(page.getByText('Generate Java')).toBeVisible();
    if (EXPECT_MODEL_POLICY_SKIPPED) {
      await expect(page.getByText('Model Policy Skipped')).toBeVisible();
    }
    await expect(page.getByText('Equivalence Analysis')).toBeVisible();

    // Agent activity panel must surface without a final-failure verdict.
    await page.getByRole('tab', { name: 'Agent' }).click();
    const agentPanel = page.getByTestId('agent-activity-panel');
    await expect(agentPanel).toBeVisible();
    await expect(agentPanel.getByTestId('agent-activity-final-failure')).toHaveCount(0);

    // Evidence Pack tab must show completeness for the W0.2 run.
    await page.getByRole('tab', { name: 'Evidence Pack' }).click();
    await expect(page.getByRole('heading', { name: /Evidence Pack Complete/i })).toBeVisible();

    // The BFF /evidence view must align its generatedArtifactRef.sha256 with
    // the workflow contract. This guarantees the artifact shown in the UI
    // is the same artifact the gate's manifest validator inspects.
    const evidenceBody = await fetchJsonFromPage<{
      runId: string;
      status: string;
      generatedArtifactRef: { sha256: string } | null;
      manifestUri: string;
    }>(page, `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/evidence`);
    expect(evidenceBody.runId).toBe(runId);
    expect(evidenceBody.status).toBe('complete');
    expect(evidenceBody.generatedArtifactRef?.sha256).toBe(workflow.generatedJavaRef?.sha256);
    expect(evidenceBody.manifestUri).toMatch(/^(file:\/\/|\/|[a-z]+:\/\/).+/i);

    // Progress timeline must include the W0.2 step names the workflow contract
    // promises. We re-fetch via the page so the assertion is observable in the
    // browser context, not just from a Node fetch.
    const progress = await fetchJsonFromPage<{ steps: Array<{ name: string }> }>(
      page,
      `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/progress`,
    );
    const stepNames = progress.steps.map(step => step.name);
    expect(stepNames).toEqual(expect.arrayContaining([
      'accepted',
      'parse-cobol',
      'generate-ir',
      'generate-java',
      'compile-test-java',
      'write-evidence',
      'completed',
    ]));
    if (EXPECT_MODEL_POLICY_SKIPPED) {
      expect(stepNames).toContain('model-policy-skipped');
    }
  });

  test('blocks the FILEIO-UNSUPPORTED fixture with unsupported_cobol', async ({ page }) => {
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
    const runId = String(transformBody.runId);

    const workflow = await waitForFinalClassification(page, runId, 'blocked', 120_000);
    expect(workflow.failureCode).toBe('unsupported_cobol');
    expect(workflow.generatedJavaRef).toBeNull();
    expect(workflow.evidencePackRef !== null || workflow.buildTestResultRef !== null).toBeTruthy();

    // The Studio must surface the blocked state explicitly — no "Verified".
    await expect(page.getByText('Verified', { exact: true })).toHaveCount(0);

    // The Generated view must honestly report unsupported source — never an
    // empty success.
    const generated = await fetchJsonFromPage<{
      runId: string;
      status: string;
      unsupportedFeatures: string[];
    }>(page, `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/generated`);
    expect(generated.runId).toBe(runId);
    expect(generated.status).toBe('unsupported');
    expect(Array.isArray(generated.unsupportedFeatures)).toBe(true);
    expect(generated.unsupportedFeatures.length).toBeGreaterThan(0);
  });
});
