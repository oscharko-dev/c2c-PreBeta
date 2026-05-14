import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadSampleRegistry } from './samples';

interface IndexEntry {
  programId: string;
  cobolSource: string;
  expectedOutputPath: string;
  classification: string;
  knownDivergenceAtW0: boolean;
  rationale: string;
  title?: string;
  supportedInProductMode?: boolean;
  w0Subset?: string[];
  oracleMode?: 'cobol-runtime' | 'synthetic-fixture';
  knownLimitations?: string[];
}

function mkTempRepo(entries: IndexEntry[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-bff-samples-'));
  fs.mkdirSync(path.join(root, 'fixtures', 'golden-master'), { recursive: true });
  fs.mkdirSync(path.join(root, 'corpus', 'synthetic', 'programs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'corpus', 'synthetic', 'fixtures'), { recursive: true });
  for (const entry of entries) {
    fs.mkdirSync(path.join(root, path.dirname(entry.cobolSource)), { recursive: true });
    fs.writeFileSync(
      path.join(root, entry.cobolSource),
      `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. ${entry.programId}.\n`,
    );
    fs.mkdirSync(path.join(root, path.dirname(entry.expectedOutputPath)), { recursive: true });
    fs.writeFileSync(path.join(root, entry.expectedOutputPath), `OUT=${entry.programId}\n`);
  }
  fs.writeFileSync(
    path.join(root, 'fixtures', 'golden-master', 'index.json'),
    JSON.stringify({ schemaVersion: 'v0', entries }),
  );
  return root;
}

const SUPPORTED_ENTRY: IndexEntry = {
  programId: 'CASE01',
  title: 'Case one',
  cobolSource: 'corpus/synthetic/programs/reference-prog.cbl',
  expectedOutputPath: 'corpus/synthetic/fixtures/reference-prog-output.txt',
  classification: 'synthetic',
  knownDivergenceAtW0: false,
  supportedInProductMode: true,
  w0Subset: ['DISPLAY', 'MOVE'],
  oracleMode: 'synthetic-fixture',
  knownLimitations: [],
  rationale: 'reference-run fixture for sample-registry tests',
};

test('loadSampleRegistry exposes list and detail derived from the golden master index', () => {
  const root = mkTempRepo([SUPPORTED_ENTRY]);
  try {
    const registry = loadSampleRegistry(root);
    const list = registry.list();
    assert.equal(list.length, 1);
    const summary = list[0];
    assert.ok(summary, 'expected one summary');
    assert.equal(summary.programId, 'CASE01');
    assert.equal(summary.title, 'Case one');
    assert.equal(summary.knownDivergenceAtW0, false);
    assert.equal(summary.supportedInProductMode, true);
    assert.deepEqual(summary.w0Subset, ['DISPLAY', 'MOVE']);
    assert.equal(summary.oracleMode, 'synthetic-fixture');
    assert.deepEqual(summary.knownLimitations, []);

    const detail = registry.get('CASE01');
    assert.ok(detail, 'expected CASE01 to be present');
    assert.equal(detail.programId, 'CASE01');
    assert.match(detail.cobolSource, /PROGRAM-ID\. CASE01/);
    assert.equal(detail.expectedOutput, 'OUT=CASE01\n');
    assert.equal(detail.cobolSourcePath, 'corpus/synthetic/programs/reference-prog.cbl');
    assert.equal(detail.expectedOutputPath, 'corpus/synthetic/fixtures/reference-prog-output.txt');
    assert.equal(detail.supportedInProductMode, true);
    assert.deepEqual(detail.w0Subset, ['DISPLAY', 'MOVE']);
    assert.equal(detail.oracleMode, 'synthetic-fixture');

    assert.equal(registry.get('UNKNOWN'), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadSampleRegistry rejects an index without entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-bff-bad-index-'));
  try {
    fs.mkdirSync(path.join(root, 'fixtures', 'golden-master'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'fixtures', 'golden-master', 'index.json'),
      JSON.stringify({ schemaVersion: 'v0' }),
    );
    assert.throws(() => loadSampleRegistry(root), /entries/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy entries without supportedInProductMode are exposed as unsupported', () => {
  const legacy: IndexEntry = {
    programId: 'LEGACY01',
    cobolSource: 'corpus/synthetic/programs/legacy.cbl',
    expectedOutputPath: 'corpus/synthetic/fixtures/legacy-output.txt',
    classification: 'synthetic',
    knownDivergenceAtW0: false,
    rationale: 'pre-#94 entry without explicit support metadata',
  };
  const root = mkTempRepo([legacy]);
  try {
    const registry = loadSampleRegistry(root);
    const summary = registry.list()[0];
    assert.ok(summary);
    assert.equal(summary.supportedInProductMode, false);
    assert.deepEqual(summary.w0Subset, []);
    assert.equal(summary.oracleMode, null);
    assert.deepEqual(summary.knownLimitations, []);

    const detail = registry.get('LEGACY01');
    assert.ok(detail);
    assert.equal(detail.supportedInProductMode, false);
    assert.equal(detail.oracleMode, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('supportedInProductMode without w0Subset is rejected', () => {
  const invalid: IndexEntry = {
    programId: 'BAD01',
    cobolSource: 'corpus/synthetic/programs/bad.cbl',
    expectedOutputPath: 'corpus/synthetic/fixtures/bad-output.txt',
    classification: 'synthetic',
    knownDivergenceAtW0: false,
    rationale: 'missing w0Subset',
    supportedInProductMode: true,
    w0Subset: [],
    oracleMode: 'synthetic-fixture',
  };
  const root = mkTempRepo([invalid]);
  try {
    assert.throws(() => loadSampleRegistry(root), /w0Subset/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('supportedInProductMode without oracleMode is rejected', () => {
  const invalid: IndexEntry = {
    programId: 'BAD02',
    cobolSource: 'corpus/synthetic/programs/bad2.cbl',
    expectedOutputPath: 'corpus/synthetic/fixtures/bad2-output.txt',
    classification: 'synthetic',
    knownDivergenceAtW0: false,
    rationale: 'missing oracleMode',
    supportedInProductMode: true,
    w0Subset: ['DISPLAY'],
  };
  const root = mkTempRepo([invalid]);
  try {
    assert.throws(() => loadSampleRegistry(root), /oracleMode/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every shipped reference program is runnable and carries explicit W0 metadata', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const registry = loadSampleRegistry(repoRoot);
  const list = registry.list();
  assert.ok(list.length >= 4, `expected at least 4 shipped reference programs, got ${list.length}`);
  for (const summary of list) {
    assert.equal(
      summary.supportedInProductMode,
      true,
      `shipped reference program ${summary.programId} must be supportedInProductMode`,
    );
    assert.ok(
      summary.w0Subset.length > 0,
      `shipped reference program ${summary.programId} must declare a non-empty w0Subset`,
    );
    assert.ok(
      summary.oracleMode === 'cobol-runtime' || summary.oracleMode === 'synthetic-fixture',
      `shipped reference program ${summary.programId} must declare a known oracleMode`,
    );
    const detail = registry.get(summary.programId);
    assert.ok(detail, `detail must be retrievable for ${summary.programId}`);
    assert.ok(detail.cobolSource.length > 0, `cobolSource must be non-empty for ${summary.programId}`);
    assert.ok(
      detail.oracleMode === 'cobol-runtime' || detail.expectedOutput.length > 0,
      `every runnable reference program needs an expected output fixture or a cobol-runtime oracle (${summary.programId})`,
    );
  }
});
