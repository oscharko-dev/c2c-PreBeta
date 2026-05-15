import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test('COBOL-to-Java end-to-end workflow', async ({ page, request }) => {
  // 1. Open the printed UI URL.
  await page.goto('/');

  // 3. Assert product mode is ready.
  const productModeStatus = page.locator('#product-mode-status');
  await expect(productModeStatus).toContainText('ready', { timeout: 30000 });
  await expect(productModeStatus).not.toContainText('checking');

  // 4. Paste supported COBOL source into the left pane.
  const cobolSource = fs.readFileSync(
    path.join(__dirname, '../../../corpus/synthetic/programs/branch-account-guard.cbl'),
    'utf8'
  );
  await page.fill('#cobol-editor', cobolSource);

  // 5. Press Start.
  const runPromise = page.waitForResponse(
    response => response.url().includes('/api/v0/transform') && response.request().method() === 'POST' && response.status() === 201
  );
  await page.click('#start-run');

  const runResponse = await runPromise;
  const runData = await runResponse.json();
  const runId = runData.runId;
  expect(runId).toBeTruthy();

  // 6. Wait for run to reach terminal state.
  const runStatusChip = page.locator('#run-status-chip');
  await expect(runStatusChip).toHaveAttribute('data-state', 'completed', { timeout: 120000 });

  // 7. Assert generated Java pane is non-empty.
  const generatedJavaLocator = page.locator('#generated-output');
  await expect(generatedJavaLocator).not.toBeEmpty();
  const generatedJava = await generatedJavaLocator.textContent();
  expect(generatedJava).not.toContain('No run started.');
  expect(generatedJava?.trim().length).toBeGreaterThan(0);

  // 8. Assert generated Java contains expected generated class/package content and does not contain placeholder markers.
  expect(generatedJava).toContain('class ');
  // Check against known placeholder markers defined in placeholder-markers.ts
  const PLACEHOLDER_JAVA_MARKERS = [
    'W0-STUB',
    'Synthetic W0 generated-Java stub',
    '// TODO: implement',
    'PLACEHOLDER',
  ];
  for (const marker of PLACEHOLDER_JAVA_MARKERS) {
    expect(generatedJava).not.toContain(marker);
  }

  // 9. Assert generated Java artifact endpoint returns the same source shown in the UI.
  // We need to fetch the file from the generated API. The UI does this to display it.
  // We can look up the first file path from the index endpoint.
  const filesIndexRes = await request.get(`/api/v0/runs/${encodeURIComponent(runId)}/generated/files`);
  expect(filesIndexRes.ok()).toBeTruthy();
  const filesIndex = await filesIndexRes.json();
  expect(filesIndex.files.length).toBeGreaterThan(0);
  const javaFile = filesIndex.files.find((f: any) => f.path.endsWith('.java'));
  expect(javaFile).toBeTruthy();
  const firstFilePath = javaFile.path;
  
  const fileRes = await request.get(`/api/v0/runs/${encodeURIComponent(runId)}/generated/files/${encodeURIComponent(firstFilePath)}`);
  expect(fileRes.ok()).toBeTruthy();
  const fileJson = await fileRes.json();
  const fileContent = fileJson.content;
  // textContent() removes some whitespace, so we compare stripped versions
  expect(generatedJava?.replace(/\s+/g, '')).toContain(fileContent.replace(/\s+/g, ''));

  // 10. Assert build/test panel shows compile success and execution success.
  const buildTestPanel = page.locator('#build-test');
  await expect(buildTestPanel).toContainText('status=ok');
  await expect(buildTestPanel).toContainText('compile=ok');
  await expect(buildTestPanel).toContainText('execution=ok');

  // 11. Assert equivalence classification is `match` for the supported input.
  await expect(buildTestPanel).toContainText('classification=match');

  // 12. Assert Evidence Pack status is complete or valid with no missing required W0 artifacts.
  const evidencePanel = page.locator('#evidence');
  // It says "status: complete" or "complete" depending on rendering. The dataset['status'] is set to 'complete'.
  await expect(evidencePanel).toHaveAttribute('data-status', 'complete');

  // 13. Assert Experience Learning summary exists for the run.
  const learningPanel = page.locator('#learning-summary');
  // We check that the text shows something indicating success, dataset['status'] is idle/unavailable or other.
  // `dataset['state']` = 'completed' or 'success' etc?
  // Let's check text content.
  await expect(learningPanel).not.toContainText('unavailable for this run');
  await expect(learningPanel).not.toContainText('pending…');
  await expect(learningPanel).not.toContainText('No run started');

  // 14. Assert model governance artifact exists: invocation ledger or model-skipped policy record.
  // This is a local backend check.
  const varDir = path.join(__dirname, '../../../var/c2c-local');
  // runId from c2c-bff differs from orchestrator runId, we can just glob for the artifact
  // or check if it exists in any run folder (since we cleared it, there's only one)
  const ledgers = fs.existsSync(path.join(varDir, 'model-invocation-ledger-v0.jsonl')) ? ['model-invocation-ledger-v0.jsonl'] : [];
  const runsDir = path.join(varDir, 'runs');
  let governanceFound = fs.existsSync(path.join(varDir, 'model-invocation-ledger-v0.jsonl'));
  
  if (!governanceFound && fs.existsSync(runsDir)) {
    const runs = fs.readdirSync(runsDir);
    for (const r of runs) {
      const p = path.join(runsDir, r, 'model-policy-skipped.json');
      if (fs.existsSync(p) && fs.statSync(p).size > 0) {
        governanceFound = true;
        break;
      }
    }
  }
  expect(governanceFound).toBeTruthy();
});
