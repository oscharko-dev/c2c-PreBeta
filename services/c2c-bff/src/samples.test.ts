import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadSampleRegistry } from './samples';

function mkTempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-bff-samples-'));
  fs.mkdirSync(path.join(root, 'fixtures', 'golden-master'), { recursive: true });
  fs.mkdirSync(path.join(root, 'corpus', 'synthetic', 'programs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'corpus', 'synthetic', 'fixtures'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'corpus', 'synthetic', 'programs', 'reference-prog.cbl'),
    '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. CASE01.\n',
  );
  fs.writeFileSync(
    path.join(root, 'corpus', 'synthetic', 'fixtures', 'reference-prog-output.txt'),
    'HELLO=1\n',
  );
  fs.writeFileSync(
    path.join(root, 'fixtures', 'golden-master', 'index.json'),
    JSON.stringify({
      schemaVersion: 'v0',
      entries: [
        {
          programId: 'CASE01',
          cobolSource: 'corpus/synthetic/programs/reference-prog.cbl',
          expectedOutputPath: 'corpus/synthetic/fixtures/reference-prog-output.txt',
          classification: 'synthetic',
          knownDivergenceAtW0: false,
          rationale: 'reference-run fixture for sample-registry tests',
        },
      ],
    }),
  );
  return root;
}

test('loadSampleRegistry exposes list and detail derived from the golden master index', () => {
  const root = mkTempRepo();
  try {
    const registry = loadSampleRegistry(root);
    const list = registry.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.programId, 'CASE01');
    assert.equal(list[0]?.knownDivergenceAtW0, false);

    const detail = registry.get('CASE01');
    assert.ok(detail, 'expected CASE01 to be present');
    assert.equal(detail?.programId, 'CASE01');
    assert.match(detail?.cobolSource ?? '', /PROGRAM-ID\. CASE01/);
    assert.equal(detail?.expectedOutput, 'HELLO=1\n');
    assert.equal(detail?.cobolSourcePath, 'corpus/synthetic/programs/reference-prog.cbl');

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
