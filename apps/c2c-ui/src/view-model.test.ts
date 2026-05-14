import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTestSummary,
  containsPlaceholderMarker,
  evidenceSummary,
  formatPostStartMetadata,
  formatSourceMetadata,
  generatedSummary,
  limitationsSummary,
  modeBadgeFromResponse,
  pickEntryFile,
  pipelineLine,
  PLACEHOLDER_JAVA_MARKERS,
  productReadiness,
  runStatusChip,
  runStatusLine,
  sourceMetadata,
  startButtonState,
} from './view-model.js';
import type {
  BuildTestView,
  EvidenceView,
  GeneratedView,
  ModeResponse,
  RunSummary,
  TransformResponse,
} from './types.js';

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run-1',
    programId: 'WB001',
    status: 'starting',
    mode: 'live',
    productMode: 'live',
    message: '',
    policyDecision: '',
    evidenceRefs: [],
    orchestratorRunId: '',
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:01.000Z',
    ...overrides,
  };
}

function makeGenerated(overrides: Partial<GeneratedView> = {}): GeneratedView {
  return {
    runId: 'run-1',
    programId: 'WB001',
    mode: 'live',
    status: 'generated',
    entryClass: 'c2c.Generated',
    entryFilePath: 'src/main/java/c2c/Generated.java',
    files: {
      'src/main/java/c2c/Generated.java': 'class Generated {}',
    },
    unsupportedFeatures: [],
    openAssumptions: [],
    note: '',
    ...overrides,
  };
}

function makeBuildTest(overrides: Partial<BuildTestView> = {}): BuildTestView {
  return {
    runId: 'run-1',
    programId: 'WB001',
    mode: 'live',
    status: 'ok',
    classification: 'match',
    expectedOutput: 'X',
    actualOutput: 'X',
    outputRef: { uri: 'file:///run/build-test-result.json', sha256: '1'.repeat(64) },
    note: '',
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<EvidenceView> = {}): EvidenceView {
  return {
    runId: 'run-1',
    programId: 'WB001',
    mode: 'live',
    status: 'complete',
    packId: 'epk-1',
    manifestUri: 'urn:c2c-bff/run-1',
    missingArtifacts: [],
    note: '',
    ...overrides,
  };
}

test('modeBadgeFromResponse labels live, mock and mixed states', () => {
  assert.equal(modeBadgeFromResponse('live', 'live').mode, 'live');
  assert.equal(modeBadgeFromResponse('mock', 'mock').mode, 'mock');
  const mixed = modeBadgeFromResponse('live', 'mock');
  assert.equal(mixed.mode, 'mock');
  assert.match(mixed.text, /mixed/);
});

test('productReadiness reports unknown until mode is loaded', () => {
  const result = productReadiness(undefined);
  assert.equal(result.ready, false);
  assert.equal(result.tone, 'unknown');
});

test('productReadiness reports ready only when orchestrator is live', () => {
  const live: ModeResponse = { orchestrator: 'live', evidence: 'live' };
  assert.equal(productReadiness(live).ready, true);
  assert.equal(productReadiness(live).tone, 'ready');

  const partial: ModeResponse = { orchestrator: 'live', evidence: 'mock' };
  const partialResult = productReadiness(partial);
  assert.equal(partialResult.ready, true);
  assert.match(partialResult.label, /evidence/);

  const mock: ModeResponse = { orchestrator: 'mock', evidence: 'mock' };
  assert.equal(productReadiness(mock).ready, false);
  assert.equal(productReadiness(mock).tone, 'not-ready');
});

test('productReadiness propagates mode lookup errors', () => {
  const result = productReadiness(undefined, 'mode endpoint 500');
  assert.equal(result.ready, false);
  assert.equal(result.tone, 'error');
  assert.match(result.label, /mode endpoint 500/);
});

test('startButtonState disables Start when product mode is not ready', () => {
  const result = startButtonState({
    sourceText: 'IDENTIFICATION DIVISION.',
    productReady: false,
    productLabel: 'orchestrator not configured',
    busy: false,
  });
  assert.equal(result.enabled, false);
  assert.equal(result.helpTone, 'not-ready');
});

test('startButtonState disables Start when source is blank', () => {
  const result = startButtonState({
    sourceText: '   \n  ',
    productReady: true,
    productLabel: 'ready',
    busy: false,
  });
  assert.equal(result.enabled, false);
  assert.match(result.help, /Paste or load/);
});

test('startButtonState enables Start when source is non-empty and product mode is ready', () => {
  const result = startButtonState({
    sourceText: 'IDENTIFICATION DIVISION.\nPROGRAM-ID. WB001.',
    productReady: true,
    productLabel: 'ready',
    busy: false,
  });
  assert.equal(result.enabled, true);
  assert.equal(result.busy, false);
});

test('startButtonState reports busy while a run is starting', () => {
  const result = startButtonState({
    sourceText: 'IDENTIFICATION DIVISION.',
    productReady: true,
    productLabel: 'ready',
    busy: true,
  });
  assert.equal(result.enabled, false);
  assert.equal(result.busy, true);
  assert.equal(result.label, 'Starting…');
});

test('startButtonState surfaces last error in the help text', () => {
  const result = startButtonState({
    sourceText: 'IDENTIFICATION DIVISION.',
    productReady: true,
    productLabel: 'ready',
    busy: false,
    lastError: 'BFF error (503): orchestrator URL is required',
  });
  assert.equal(result.enabled, true);
  assert.equal(result.helpTone, 'error');
  assert.match(result.help, /orchestrator URL is required/);
});

test('sourceMetadata extracts PROGRAM-ID and counts bytes/lines', () => {
  const text = '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. WB001.\n';
  const meta = sourceMetadata(text);
  assert.equal(meta.programId, 'WB001');
  assert.equal(meta.bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(meta.lines, text.split(/\r\n|\r|\n/).length);
  assert.equal(meta.isEmpty, false);
});

test('sourceMetadata returns isEmpty for empty input', () => {
  const meta = sourceMetadata('');
  assert.equal(meta.isEmpty, true);
  assert.equal(meta.programId, null);
  assert.equal(meta.bytes, 0);
});

test('sourceMetadata returns null PROGRAM-ID when not detected', () => {
  const meta = sourceMetadata('not a real COBOL program');
  assert.equal(meta.programId, null);
});

test('formatSourceMetadata renders a compact one-liner', () => {
  const meta = sourceMetadata('       PROGRAM-ID. WB001.\n');
  const line = formatSourceMetadata(meta);
  assert.match(line, /program-id=WB001/);
  assert.match(line, /bytes=/);
  assert.match(line, /lines=/);
});

test('formatPostStartMetadata renders run id, orchestrator id and truncated source hash', () => {
  const transform: TransformResponse = {
    runId: 'run-42',
    orchestratorRunId: 'orch-42',
    status: 'starting',
    programId: 'WB001',
    productMode: 'live',
    links: { self: '/api/v0/runs/run-42' },
  };
  const line = formatPostStartMetadata(transform, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
  assert.match(line, /run=run-42/);
  assert.match(line, /orchestrator=orch-42/);
  assert.match(line, /sha256=abcdef0123456789…/);
});

test('runStatusLine treats missing run as idle', () => {
  const line = runStatusLine(undefined);
  assert.equal(line.state, 'idle');
  assert.match(line.primary, /No run started/);
});

test('runStatusLine formats run summary fields', () => {
  const run = makeRun({ status: 'completed', message: 'ok', policyDecision: 'allow' });
  const line = runStatusLine(run);
  assert.equal(line.state, 'completed');
  assert.match(line.primary, /\[live\] completed/);
  assert.match(line.primary, /run-1/);
  assert.match(line.secondary, /policy=allow/);
});

test('runStatusChip returns idle when no run exists', () => {
  assert.deepEqual(runStatusChip(undefined), { state: 'idle', label: 'idle' });
});

test('runStatusChip mirrors run status', () => {
  assert.equal(runStatusChip(makeRun({ status: 'updating' })).state, 'updating');
  assert.equal(runStatusChip(makeRun({ status: 'failed' })).label, 'failed');
});

test('pipelineLine surfaces diagnostic text on failure', () => {
  const line = pipelineLine(makeRun({ status: 'failed', message: 'orchestrator rejected source' }));
  assert.equal(line.state, 'failed');
  assert.equal(line.diagnostic, 'orchestrator rejected source');
});

test('pipelineLine returns idle for missing run', () => {
  const line = pipelineLine(undefined);
  assert.equal(line.state, 'idle');
  assert.equal(line.diagnostic, undefined);
});

test('pickEntryFile prefers an explicitly selected file', () => {
  const generated = makeGenerated({
    files: {
      'a.java': 'class A {}',
      'b.java': 'class B {}',
    },
    entryFilePath: 'a.java',
  });
  assert.deepEqual(pickEntryFile(generated, 'b.java'), { path: 'b.java', content: 'class B {}' });
});

test('pickEntryFile falls back to entry path, then first file', () => {
  const generated = makeGenerated({
    files: { 'a.java': 'class A {}', 'b.java': 'class B {}' },
    entryFilePath: 'a.java',
  });
  assert.equal(pickEntryFile(generated)?.path, 'a.java');

  const fallback = makeGenerated({ files: { 'only.java': 'x' }, entryFilePath: '' });
  assert.equal(pickEntryFile(fallback)?.path, 'only.java');

  const empty = makeGenerated({ files: {}, entryFilePath: '' });
  assert.equal(pickEntryFile(empty), undefined);
});

test('generatedSummary shows pending state while run is in flight', () => {
  const summary = generatedSummary(undefined, makeRun({ status: 'starting' }), undefined);
  assert.equal(summary.viewerState, 'pending');
  assert.equal(summary.isProductOutput, false);
});

test('generatedSummary surfaces fetch errors', () => {
  const summary = generatedSummary(undefined, makeRun(), 'network down');
  assert.equal(summary.viewerState, 'error');
  assert.match(summary.headline, /network down/);
});

test('generatedSummary suppresses diagnostic-fixture output and never labels it as product', () => {
  const summary = generatedSummary(makeGenerated({ mode: 'diagnostic-fixture' }), makeRun(), undefined);
  assert.equal(summary.isProductOutput, false);
  assert.equal(summary.viewerState, 'empty');
  assert.match(summary.headline, /Diagnostic fixture/);
  assert.doesNotMatch(summary.headline, /generated Java/i);
  assert.doesNotMatch(summary.paneText, /class Generated/);
});

test('generatedSummary reports real generator output as product output', () => {
  const summary = generatedSummary(makeGenerated(), makeRun({ status: 'completed' }), undefined);
  assert.equal(summary.isProductOutput, true);
  assert.equal(summary.viewerState, 'shown');
  assert.match(summary.headline, /entry class/);
});

test('generatedSummary does not claim success when files are empty', () => {
  const summary = generatedSummary(makeGenerated({ files: {} }), makeRun(), undefined);
  assert.equal(summary.isProductOutput, false);
  assert.equal(summary.viewerState, 'empty');
});

test('generatedSummary distinguishes unsupported and skipped states', () => {
  const unsupported = generatedSummary(makeGenerated({ status: 'unsupported' }), makeRun(), undefined);
  assert.match(unsupported.headline, /Unsupported/);
  assert.equal(unsupported.isProductOutput, false);

  const skipped = generatedSummary(makeGenerated({ status: 'skipped' }), makeRun(), undefined);
  assert.match(skipped.headline, /No generator output/);
  assert.equal(skipped.isProductOutput, false);
});

test('buildTestSummary reports idle while waiting for first result', () => {
  assert.equal(buildTestSummary(undefined, undefined, undefined).status, 'idle');
  assert.equal(buildTestSummary(undefined, makeRun(), undefined).headline.includes('pending'), true);
});

test('buildTestSummary does not label diagnostic-fixture data as a build/test match', () => {
  const summary = buildTestSummary(
    makeBuildTest({ mode: 'diagnostic-fixture', status: 'ok' }),
    makeRun(),
    undefined,
  );
  assert.equal(summary.status, 'diagnostic-fixture');
  assert.equal(summary.classification, 'diagnostic-fixture');
  assert.equal(summary.isProductResult, false);
  assert.match(summary.headline, /Diagnostic fixture/);
  assert.doesNotMatch(summary.headline, /match/i);
});

test('buildTestSummary surfaces real classification', () => {
  const summary = buildTestSummary(makeBuildTest({ status: 'output-divergence', classification: 'divergence-known-w0-coverage-gap' }), makeRun(), undefined);
  assert.equal(summary.status, 'output-divergence');
  assert.equal(summary.classification, 'divergence-known-w0-coverage-gap');
  assert.equal(summary.isProductResult, true);
});

test('evidenceSummary does not label diagnostic-fixture as a complete Evidence Pack', () => {
  const summary = evidenceSummary(
    makeEvidence({ mode: 'diagnostic-fixture', status: 'complete' }),
    makeRun(),
    undefined,
  );
  assert.equal(summary.status, 'diagnostic-fixture');
  assert.equal(summary.isProductResult, false);
  assert.match(summary.headline, /Diagnostic fixture/);
  assert.doesNotMatch(summary.headline, /complete/i);
});

test('evidenceSummary exposes manifest, export and missing artifacts when live', () => {
  const summary = evidenceSummary(makeEvidence({ status: 'incomplete', missingArtifacts: ['sourceCobol'], exportUri: 'urn:export' }), makeRun(), undefined);
  assert.equal(summary.status, 'incomplete');
  assert.equal(summary.exportUri, 'urn:export');
  assert.deepEqual(summary.missing, ['sourceCobol']);
  assert.equal(summary.isProductResult, false);
});

test('containsPlaceholderMarker detects each documented marker and ignores clean code', () => {
  assert.equal(containsPlaceholderMarker({}), null);
  assert.equal(containsPlaceholderMarker({ 'A.java': 'class A {}' }), null);
  for (const marker of PLACEHOLDER_JAVA_MARKERS) {
    assert.equal(
      containsPlaceholderMarker({ 'X.java': `prefix ${marker} suffix` }),
      marker,
      `failed to detect marker ${marker}`,
    );
  }
});

test('buildTestSummary renders all diagnostics without applying an arbitrary cap', () => {
  const diagnostics = Array.from({ length: 25 }, (_, idx) => ({
    level: 'info',
    code: `code-${idx}`,
    message: `message ${idx}`,
  }));
  const view = makeBuildTest({ diagnostics });
  const summary = buildTestSummary(view, makeRun({ status: 'completed' }), undefined);
  assert.equal(summary.diagnostics.length, 25);
  assert.equal(summary.diagnostics[24]?.code, 'code-24');
});

test('generatedSummary refuses to display placeholder Java as a successful product run', () => {
  const placeholderJava = [
    '// Synthetic W0 generated-Java stub for programId=BRNCH01.',
    'package c2c.w0.generated;',
    'public final class ProgramBrnch01 {',
    '    public static void main(String[] args) {',
    '        System.out.println("W0-STUB BRNCH01");',
    '    }',
    '}',
  ].join('\n');
  const generated = makeGenerated({
    files: { 'src/main/java/c2c/w0/generated/ProgramBrnch01.java': placeholderJava },
  });
  const summary = generatedSummary(generated, makeRun({ status: 'completed' }), undefined);
  assert.equal(summary.isProductOutput, false);
  assert.equal(summary.viewerState, 'error');
  assert.match(summary.headline, /placeholder Java/i);
  assert.equal(summary.placeholderMarker, 'W0-STUB');
  assert.doesNotMatch(summary.paneText, /W0-STUB BRNCH01\nclass/);
});

test('generatedSummary surfaces incomplete status for runs missing generator artifacts', () => {
  const summary = generatedSummary(
    makeGenerated({ status: 'incomplete', files: {}, note: 'Orchestrator has not yet persisted generation response.' }),
    makeRun({ status: 'updating' }),
    undefined,
  );
  assert.equal(summary.isProductOutput, false);
  assert.equal(summary.viewerState, 'empty');
  assert.match(summary.headline, /unavailable/i);
});

test('buildTestSummary reports incomplete-as-not-product when artifacts are missing', () => {
  const view = makeBuildTest({
    status: 'incomplete',
    classification: 'skipped-no-execution',
    actualOutput: '',
    compileStatus: 'unknown',
    executionStatus: 'unknown',
    note: 'Orchestrator did not return a build/test result for this run.',
  });
  const summary = buildTestSummary(view, makeRun({ status: 'updating' }), undefined);
  assert.equal(summary.status, 'incomplete');
  assert.equal(summary.isProductResult, false);
  assert.match(summary.headline, /unavailable/i);
  assert.equal(summary.compileStatus, 'unknown');
  assert.equal(summary.executionStatus, 'unknown');
});

test('buildTestSummary forwards compile/execution status and diagnostics in product runs', () => {
  const view = makeBuildTest({
    status: 'ok',
    classification: 'match',
    compileStatus: 'ok',
    executionStatus: 'ok',
    diagnostics: [
      { level: 'info', code: 'compile.ok', message: 'compiled' },
      { level: 'info', code: 'execution.ok', message: 'ran' },
    ],
  });
  const summary = buildTestSummary(view, makeRun({ status: 'completed' }), undefined);
  assert.equal(summary.isProductResult, true);
  assert.equal(summary.compileStatus, 'ok');
  assert.equal(summary.executionStatus, 'ok');
  assert.equal(summary.diagnostics.length, 2);
});

test('evidenceSummary exposes manifestHash, validationStatus and exportRef in live mode', () => {
  const view = makeEvidence({
    status: 'incomplete',
    missingArtifacts: ['semanticIr'],
    manifestHash: 'f'.repeat(64),
    validationStatus: 'incomplete',
    exportRef: { uri: 'file:///run/evidence-pack.tar.gz', sha256: 'e'.repeat(64), byteSize: 1024 },
  });
  const summary = evidenceSummary(view, makeRun(), undefined);
  assert.equal(summary.manifestHash, 'f'.repeat(64));
  assert.equal(summary.validationStatus, 'incomplete');
  assert.equal(summary.exportUri, 'file:///run/evidence-pack.tar.gz');
  assert.equal(summary.exportRef?.sha256, 'e'.repeat(64));
  assert.deepEqual(summary.missing, ['semanticIr']);
  assert.equal(summary.isProductResult, false);
});

test('limitationsSummary lists generator-reported issues only in live mode', () => {
  const fixture = limitationsSummary(makeGenerated({ mode: 'diagnostic-fixture', unsupportedFeatures: ['x'] }), makeRun());
  assert.deepEqual(fixture.unsupportedFeatures, []);
  assert.equal(fixture.state, 'idle');

  const live = limitationsSummary(makeGenerated({ unsupportedFeatures: ['a'], openAssumptions: ['b'] }), makeRun());
  assert.deepEqual(live.unsupportedFeatures, ['a']);
  assert.deepEqual(live.openAssumptions, ['b']);
  assert.equal(live.state, 'has-items');

  const empty = limitationsSummary(makeGenerated(), makeRun());
  assert.equal(empty.state, 'empty');

  const idle = limitationsSummary(undefined, undefined);
  assert.equal(idle.state, 'idle');
});
