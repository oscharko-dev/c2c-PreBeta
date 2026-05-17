import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { loadAcceptanceFixtureRegistry } from './acceptance-fixtures';

interface FixtureFile {
  path: string;
  content: string;
}

interface FixtureInput {
  fixtureId: string;
  title: string;
  description?: string;
  sourceFile: FixtureFile;
  expectedOutputFile?: FixtureFile;
  oracleGenerationMode?: 'cobol-runtime' | 'static-fixture' | 'user-provided';
  supportedSubset: string[];
  unsupportedConstructs?: Array<{ code: string; construct: string; line?: number; message?: string }>;
  targetLanguage?: string;
  expectedFinalClassification: 'success' | 'blocked';
  expectedFailureCode?: string;
  modes?: string[];
  rationale: string;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeRepo(inputs: FixtureInput[], overrides?: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-acceptance-'));
  fs.mkdirSync(path.join(root, 'fixtures', 'acceptance'), { recursive: true });

  const fixtures: Array<Record<string, unknown>> = [];
  for (const input of inputs) {
    fs.mkdirSync(path.join(root, path.dirname(input.sourceFile.path)), { recursive: true });
    fs.writeFileSync(path.join(root, input.sourceFile.path), input.sourceFile.content);
    const sourceRef = {
      uri: `fixture://${input.sourceFile.path}`,
      path: input.sourceFile.path,
      sha256: sha256Hex(input.sourceFile.content),
      byteSize: Buffer.byteLength(input.sourceFile.content),
      mimeType: 'text/x-cobol',
      kind: 'source',
    };
    let expectedRef: Record<string, unknown> | undefined;
    if (input.expectedOutputFile) {
      fs.mkdirSync(path.join(root, path.dirname(input.expectedOutputFile.path)), { recursive: true });
      fs.writeFileSync(path.join(root, input.expectedOutputFile.path), input.expectedOutputFile.content);
      expectedRef = {
        uri: `fixture://${input.expectedOutputFile.path}`,
        path: input.expectedOutputFile.path,
        sha256: sha256Hex(input.expectedOutputFile.content),
        byteSize: Buffer.byteLength(input.expectedOutputFile.content),
        mimeType: 'text/plain',
        kind: 'golden-master',
      };
    }
    const entry: Record<string, unknown> = {
      fixtureId: input.fixtureId,
      title: input.title,
      sourceCobolArtifactRef: sourceRef,
      supportedSubset: input.supportedSubset,
      unsupportedConstructs: input.unsupportedConstructs ?? [],
      targetLanguage: input.targetLanguage ?? 'java',
      expectedFinalClassification: input.expectedFinalClassification,
      rationale: input.rationale,
    };
    // Only emit modes when explicitly provided; this lets tests assert
    // "modes is required" by passing modes: undefined (the loader rule).
    if (Object.prototype.hasOwnProperty.call(input, 'modes')) {
      if (input.modes !== undefined) {
        entry.modes = input.modes;
      }
    } else {
      entry.modes = ['file-backed', 'paste-mode'];
    }
    if (input.description !== undefined) entry.description = input.description;
    if (expectedRef) entry.expectedOutputArtifactRef = expectedRef;
    if (input.oracleGenerationMode) entry.oracleGenerationMode = input.oracleGenerationMode;
    if (input.expectedFailureCode) entry.expectedFailureCode = input.expectedFailureCode;
    fixtures.push(entry);
  }

  const indexPayload: Record<string, unknown> = {
    schemaVersion: 'v0',
    fixtures,
    ...(overrides ?? {}),
  };
  fs.writeFileSync(
    path.join(root, 'fixtures', 'acceptance', 'index.json'),
    JSON.stringify(indexPayload),
  );
  return root;
}

const POSITIVE_FIXTURE: FixtureInput = {
  fixtureId: 'OKFIXTURE',
  title: 'Positive acceptance fixture',
  description: 'Smallest success-path acceptance.',
  sourceFile: {
    path: 'corpus/synthetic/programs/ok.cbl',
    content: '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OK.\n',
  },
  expectedOutputFile: {
    path: 'corpus/synthetic/fixtures/ok-output.txt',
    content: 'OK\n',
  },
  oracleGenerationMode: 'cobol-runtime',
  supportedSubset: ['DISPLAY', 'STOP-RUN'],
  expectedFinalClassification: 'success',
  rationale: 'positive baseline',
};

const NEGATIVE_FIXTURE: FixtureInput = {
  fixtureId: 'BLOCKED',
  title: 'Blocked by unsupported construct',
  sourceFile: {
    path: 'corpus/synthetic/programs/blocked.cbl',
    content: '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. BLOCKED.\n',
  },
  supportedSubset: [],
  unsupportedConstructs: [
    { code: 'unsupported-feature', construct: 'FILE SECTION', line: 4, message: 'no file io in w0.2' },
  ],
  expectedFinalClassification: 'blocked',
  expectedFailureCode: 'unsupported_cobol',
  rationale: 'negative path proof',
};

test('loadAcceptanceFixtureRegistry exposes summaries and details for positive + negative fixtures', () => {
  const root = writeRepo([POSITIVE_FIXTURE, NEGATIVE_FIXTURE]);
  try {
    const registry = loadAcceptanceFixtureRegistry(root);
    const list = registry.list();
    assert.equal(list.length, 2);

    const positive = list.find((entry) => entry.fixtureId === 'OKFIXTURE');
    assert.ok(positive, 'positive summary present');
    assert.equal(positive.expectedFinalClassification, 'success');
    assert.equal(positive.expectedFailureCode, null);
    assert.equal(positive.unsupportedConstructsCount, 0);
    assert.deepEqual(positive.modes, ['file-backed', 'paste-mode']);
    assert.equal(positive.description, 'Smallest success-path acceptance.');

    const blocked = list.find((entry) => entry.fixtureId === 'BLOCKED');
    assert.ok(blocked, 'negative summary present');
    assert.equal(blocked.expectedFinalClassification, 'blocked');
    assert.equal(blocked.expectedFailureCode, 'unsupported_cobol');
    assert.equal(blocked.unsupportedConstructsCount, 1);
    assert.equal(blocked.oracleGenerationMode, null);

    const detail = registry.get('OKFIXTURE');
    assert.ok(detail);
    assert.match(detail.cobolSource, /PROGRAM-ID\. OK\./);
    assert.equal(detail.expectedOutput, 'OK\n');

    const blockedDetail = registry.get('BLOCKED');
    assert.ok(blockedDetail);
    assert.equal(blockedDetail.expectedOutput, null);
    assert.equal(blockedDetail.unsupportedConstructs.length, 1);
    assert.equal(blockedDetail.unsupportedConstructs[0]?.code, 'unsupported-feature');
    // Detail response normalises optional fields to null so the OpenAPI
    // schema contract holds: missing fields are JSON null, not omitted.
    assert.equal(blockedDetail.expectedOutputArtifactRef, null);
    assert.equal(blockedDetail.oracleGenerationMode, null);
    assert.equal(blockedDetail.description, null);

    assert.equal(registry.get('UNKNOWN'), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects success fixture missing oracleGenerationMode', () => {
  const root = writeRepo([{ ...POSITIVE_FIXTURE, oracleGenerationMode: undefined }]);
  try {
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /oracleGenerationMode/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects blocked fixture missing expectedFailureCode', () => {
  const root = writeRepo([{ ...NEGATIVE_FIXTURE, expectedFailureCode: undefined }]);
  try {
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /expectedFailureCode/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects blocked fixture with no unsupportedConstructs', () => {
  const root = writeRepo([{ ...NEGATIVE_FIXTURE, unsupportedConstructs: [] }]);
  try {
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /unsupportedConstruct/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects static-fixture oracleGenerationMode without expectedOutputArtifactRef', () => {
  const fixture: FixtureInput = {
    ...POSITIVE_FIXTURE,
    oracleGenerationMode: 'static-fixture',
    expectedOutputFile: undefined,
  };
  const root = writeRepo([fixture]);
  try {
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /static-fixture/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects index with mismatched on-disk sha256 (same byte length)', () => {
  const root = writeRepo([POSITIVE_FIXTURE]);
  try {
    const sourcePath = path.join(root, POSITIVE_FIXTURE.sourceFile.path);
    const tampered = POSITIVE_FIXTURE.sourceFile.content.replace('OK', 'XK');
    assert.equal(
      Buffer.byteLength(tampered),
      Buffer.byteLength(POSITIVE_FIXTURE.sourceFile.content),
      'tampered content must preserve byte length to isolate the sha256 check',
    );
    fs.writeFileSync(sourcePath, tampered);
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /sha256/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects index with mismatched on-disk byteSize', () => {
  const root = writeRepo([POSITIVE_FIXTURE]);
  try {
    const sourcePath = path.join(root, POSITIVE_FIXTURE.sourceFile.path);
    fs.writeFileSync(sourcePath, POSITIVE_FIXTURE.sourceFile.content + '\nTAMPERED\n');
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /byteSize/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects artifact paths that escape repo root through symlinks', () => {
  const root = writeRepo([POSITIVE_FIXTURE]);
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-acceptance-external-'));
  try {
    const external = path.join(externalDir, 'external-ok.cbl');
    fs.writeFileSync(external, POSITIVE_FIXTURE.sourceFile.content);
    const sourcePath = path.join(root, POSITIVE_FIXTURE.sourceFile.path);
    fs.unlinkSync(sourcePath);
    fs.symlinkSync(external, sourcePath);

    assert.throws(() => loadAcceptanceFixtureRegistry(root), /symlink|outside the repository root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});

test('rejects duplicate fixtureId', () => {
  const root = writeRepo([POSITIVE_FIXTURE, { ...POSITIVE_FIXTURE, title: 'dup' }]);
  try {
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /duplicate fixtureId/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unknown supportedSubset construct', () => {
  const root = writeRepo([{ ...POSITIVE_FIXTURE, supportedSubset: ['NOT-A-VERB'] }]);
  try {
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /supportedSubset/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects fixture missing modes', () => {
  const root = writeRepo([{ ...POSITIVE_FIXTURE, modes: undefined as unknown as string[] }]);
  try {
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /modes is required/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects shipping fixture missing paste-mode', () => {
  const root = writeRepo([{ ...POSITIVE_FIXTURE, modes: ['file-backed'] }]);
  try {
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /both "file-backed" and "paste-mode"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects shipping fixture missing file-backed', () => {
  const root = writeRepo([{ ...POSITIVE_FIXTURE, modes: ['paste-mode'] }]);
  try {
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /both "file-backed" and "paste-mode"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects sourceCobolArtifactRef.path with .. traversal segment', () => {
  const root = writeRepo([POSITIVE_FIXTURE]);
  try {
    const indexPath = path.join(root, 'fixtures', 'acceptance', 'index.json');
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      fixtures: Array<Record<string, unknown>>;
    };
    const firstFixture = parsed.fixtures[0];
    assert.ok(firstFixture, 'expected at least one fixture in the test index');
    const sourceRef = firstFixture.sourceCobolArtifactRef as Record<string, unknown>;
    sourceRef.path = '../escaped.cbl';
    fs.writeFileSync(indexPath, JSON.stringify(parsed));
    // The path may be rejected either by the schema-aligned syntactic
    // check or by the runtime containment check; both protect repo root.
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /repo-relative|outside the repository root|\.\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects sourceCobolArtifactRef.path that is absolute', () => {
  const root = writeRepo([POSITIVE_FIXTURE]);
  try {
    const indexPath = path.join(root, 'fixtures', 'acceptance', 'index.json');
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      fixtures: Array<Record<string, unknown>>;
    };
    const firstFixture = parsed.fixtures[0];
    assert.ok(firstFixture, 'expected at least one fixture in the test index');
    const sourceRef = firstFixture.sourceCobolArtifactRef as Record<string, unknown>;
    sourceRef.path = '/etc/passwd';
    fs.writeFileSync(indexPath, JSON.stringify(parsed));
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /absolute path|repo-relative/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects empty fixtures array', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-acceptance-empty-'));
  try {
    fs.mkdirSync(path.join(root, 'fixtures', 'acceptance'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'fixtures', 'acceptance', 'index.json'),
      JSON.stringify({ schemaVersion: 'v0', fixtures: [] }),
    );
    assert.throws(() => loadAcceptanceFixtureRegistry(root), /non-empty fixtures/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shipped W0.2 acceptance index loads with HELLOW02 and FILEIO-UNSUPPORTED', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const registry = loadAcceptanceFixtureRegistry(repoRoot);
  const list = registry.list();
  const ids = list.map((entry) => entry.fixtureId);
  assert.ok(ids.includes('HELLOW02'), 'HELLOW02 must be registered');
  assert.ok(ids.includes('FILEIO-UNSUPPORTED'), 'FILEIO-UNSUPPORTED must be registered');

  const hello = list.find((entry) => entry.fixtureId === 'HELLOW02');
  assert.ok(hello);
  assert.equal(hello.expectedFinalClassification, 'success');
  assert.equal(hello.oracleGenerationMode, 'cobol-runtime');
  assert.ok(hello.supportedSubset.includes('PERFORM-VARYING'));
  assert.ok(hello.supportedSubset.includes('DISPLAY'));

  const blocked = list.find((entry) => entry.fixtureId === 'FILEIO-UNSUPPORTED');
  assert.ok(blocked);
  assert.equal(blocked.expectedFinalClassification, 'blocked');
  assert.equal(blocked.expectedFailureCode, 'unsupported_cobol');
  assert.ok(blocked.unsupportedConstructsCount >= 1);

  const helloDetail = registry.get('HELLOW02');
  assert.ok(helloDetail);
  assert.match(helloDetail.cobolSource, /PROGRAM-ID\. HELLOW02/);
  assert.ok(helloDetail.expectedOutput && helloDetail.expectedOutput.includes('HELLO-W02 DONE'));

  const blockedDetail = registry.get('FILEIO-UNSUPPORTED');
  assert.ok(blockedDetail);
  assert.match(blockedDetail.cobolSource, /FILE SECTION/);
  assert.equal(blockedDetail.expectedOutput, null);
});
