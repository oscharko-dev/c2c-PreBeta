import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTestSummary,
  evidenceSummary,
  generatedSummary,
  modeBadgeFromResponse,
  pickEntryFile,
  runStatusLine,
} from './view-model.js';
import type {
  BuildTestView,
  EvidenceView,
  GeneratedView,
  RunSummary,
} from './types.js';

test('modeBadgeFromResponse labels live, mock, and mixed states', () => {
  assert.deepEqual(modeBadgeFromResponse('live', 'live'), {
    mode: 'live',
    text: 'live · orchestrator + evidence',
  });
  assert.deepEqual(modeBadgeFromResponse('mock', 'mock'), {
    mode: 'mock',
    text: 'mock · no upstream configured',
  });
  const mixed = modeBadgeFromResponse('live', 'mock');
  assert.equal(mixed.mode, 'mock');
  assert.match(mixed.text, /mixed/);
  assert.match(mixed.text, /orchestrator=live/);
  assert.match(mixed.text, /evidence=mock/);
});

test('runStatusLine treats missing run as idle', () => {
  const line = runStatusLine(undefined);
  assert.equal(line.state, 'idle');
  assert.match(line.primary, /No run yet/);
});

test('runStatusLine formats run summary fields', () => {
  const run: RunSummary = {
    runId: 'run-1',
    programId: 'BRNCH01',
    status: 'completed',
    mode: 'mock',
    productMode: 'mock',
    message: 'mock run completed',
    policyDecision: 'allow',
    evidenceRefs: [],
    orchestratorRunId: '',
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:01.000Z',
  };
  const line = runStatusLine(run);
  assert.equal(line.state, 'completed');
  assert.match(line.primary, /\[mock\] completed/);
  assert.match(line.primary, /run-1/);
  assert.match(line.primary, /program=BRNCH01/);
  assert.match(line.secondary, /policy=allow/);
  assert.match(line.secondary, /updated=2026-05-14T00:00:01\.000Z/);
});

test('pickEntryFile prefers the entry file, then first file', () => {
  const generated: GeneratedView = {
    runId: 'r',
    programId: 'p',
    mode: 'mock',
    status: 'generated',
    entryClass: 'c2c.Generated',
    entryFilePath: 'src/main/java/c2c/Generated.java',
    files: {
      'src/main/java/c2c/Generated.java': 'class Generated {}',
      'src/main/java/c2c/Other.java': 'class Other {}',
    },
    unsupportedFeatures: [],
    openAssumptions: [],
    note: '',
  };
  assert.deepEqual(pickEntryFile(generated), {
    path: 'src/main/java/c2c/Generated.java',
    content: 'class Generated {}',
  });

  const fallback: GeneratedView = { ...generated, entryFilePath: '' };
  const picked = pickEntryFile(fallback);
  assert.ok(picked, 'expected a file pick fallback');
  assert.equal(picked?.path.startsWith('src/main/java/c2c/'), true);

  const empty: GeneratedView = { ...generated, entryFilePath: '', files: {} };
  assert.equal(pickEntryFile(empty), undefined);
});

test('generatedSummary distinguishes generated, unsupported and skipped', () => {
  const base: GeneratedView = {
    runId: 'r',
    programId: 'BRNCH01',
    mode: 'mock',
    status: 'generated',
    entryClass: 'c2c.Generated',
    entryFilePath: 'a.java',
    files: { 'a.java': 'class A {}' },
    unsupportedFeatures: [],
    openAssumptions: [],
    note: 'ok',
  };
  assert.match(generatedSummary(base).headline, /Generated/);
  assert.match(generatedSummary({ ...base, status: 'unsupported' }).headline, /Unsupported/);
  assert.match(generatedSummary({ ...base, status: 'skipped' }).headline, /Skipped/);
  assert.equal(generatedSummary(undefined).headline, 'No run yet.');
});

test('buildTestSummary returns the live status and classification', () => {
  const view: BuildTestView = {
    runId: 'r',
    programId: 'p',
    mode: 'mock',
    status: 'output-divergence',
    classification: 'divergence-known-w0-coverage-gap',
    expectedOutput: 'X',
    actualOutput: 'Y',
    outputRef: 'sha256:1',
    note: 'note',
  };
  const summary = buildTestSummary(view);
  assert.equal(summary.status, 'output-divergence');
  assert.equal(summary.classification, 'divergence-known-w0-coverage-gap');
  assert.match(summary.headline, /\[mock\]/);

  assert.equal(buildTestSummary(undefined).status, 'idle');
});

test('evidenceSummary returns headline, manifest, missing artifacts', () => {
  const view: EvidenceView = {
    runId: 'r',
    programId: 'p',
    mode: 'mock',
    status: 'incomplete',
    packId: 'epk-r-1',
    manifestUri: 'urn:c2c-bff/x',
    missingArtifacts: ['sourceCobol'],
    note: 'mock-only',
  };
  const summary = evidenceSummary(view);
  assert.equal(summary.status, 'incomplete');
  assert.match(summary.headline, /packId=epk-r-1/);
  assert.equal(summary.manifestUri, 'urn:c2c-bff/x');
  assert.deepEqual(summary.missing, ['sourceCobol']);

  assert.equal(evidenceSummary(undefined).status, 'idle');
});
