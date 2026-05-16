import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * W0.2 acceptance-fixture loader. Reads fixtures/acceptance/index.json,
 * validates it against the contract declared in schemas/acceptance-fixture-v0.json,
 * and exposes a registry consumed by the BFF acceptance-fixture endpoints.
 *
 * Issue #174. The loader purposely re-validates content hashes and byte sizes at
 * load time so a divergence between the registry and the on-disk corpus surfaces
 * at boot rather than at run time. Validation rules mirror the schema's
 * conditional constraints (success fixtures must carry an oracle, blocked
 * fixtures must declare at least one unsupportedConstruct and a failureCode).
 */

export type OracleGenerationMode = 'cobol-runtime' | 'static-fixture' | 'user-provided';
export type AcceptanceMode = 'file-backed' | 'paste-mode';
export type FinalClassification = 'success' | 'blocked';
export type TargetLanguage = 'java';

export type AcceptanceFailureCode =
  | 'unsupported_cobol'
  | 'parse_failed'
  | 'semantic_ir_failed'
  | 'java_generation_failed'
  | 'java_compile_failed'
  | 'java_runtime_failed'
  | 'oracle_mismatch'
  | 'evidence_incomplete'
  | 'cancelled';

export type DiagnosticCode =
  | 'unsupported-feature'
  | 'unsupported-data-declaration'
  | 'unsupported-statement'
  | 'unterminated-block'
  | 'unmatched-block-end'
  | 'mismatched-block-end';

export type W02CobolConstruct =
  | 'MOVE'
  | 'DISPLAY'
  | 'PERFORM'
  | 'PERFORM-VARYING'
  | 'PERFORM-UNTIL'
  | 'IF'
  | 'EVALUATE'
  | 'COMPUTE'
  | 'ADD'
  | 'SUBTRACT'
  | 'MULTIPLY'
  | 'DIVIDE'
  | 'CALL'
  | 'STOP-RUN'
  | 'PARAGRAPH'
  | 'WORKING-STORAGE';

export interface ArtifactReference {
  uri: string;
  path: string;
  sha256: string;
  byteSize: number;
  mimeType?: string;
  kind?: string;
}

export interface UnsupportedConstruct {
  code: DiagnosticCode;
  construct: string;
  line?: number;
  message?: string;
}

export interface AcceptanceFixture {
  fixtureId: string;
  title: string;
  description?: string;
  sourceCobolArtifactRef: ArtifactReference;
  expectedOutputArtifactRef?: ArtifactReference;
  oracleGenerationMode?: OracleGenerationMode;
  supportedSubset: W02CobolConstruct[];
  unsupportedConstructs: UnsupportedConstruct[];
  targetLanguage: TargetLanguage;
  expectedFinalClassification: FinalClassification;
  expectedFailureCode?: AcceptanceFailureCode;
  modes: AcceptanceMode[];
  rationale: string;
}

export interface AcceptanceFixtureSummary {
  fixtureId: string;
  title: string;
  description: string | null;
  oracleGenerationMode: OracleGenerationMode | null;
  supportedSubset: W02CobolConstruct[];
  unsupportedConstructsCount: number;
  targetLanguage: TargetLanguage;
  expectedFinalClassification: FinalClassification;
  expectedFailureCode: AcceptanceFailureCode | null;
  modes: AcceptanceMode[];
}

export interface AcceptanceFixtureDetail extends AcceptanceFixtureSummary {
  sourceCobolArtifactRef: ArtifactReference;
  expectedOutputArtifactRef: ArtifactReference | null;
  unsupportedConstructs: UnsupportedConstruct[];
  rationale: string;
  cobolSource: string;
  expectedOutput: string | null;
}

export interface AcceptanceFixtureRegistry {
  list(): AcceptanceFixtureSummary[];
  get(fixtureId: string): AcceptanceFixtureDetail | undefined;
  fixtures(): AcceptanceFixture[];
}

const FAILURE_CODES: ReadonlySet<AcceptanceFailureCode> = new Set([
  'unsupported_cobol',
  'parse_failed',
  'semantic_ir_failed',
  'java_generation_failed',
  'java_compile_failed',
  'java_runtime_failed',
  'oracle_mismatch',
  'evidence_incomplete',
  'cancelled',
]);

const ORACLE_MODES: ReadonlySet<OracleGenerationMode> = new Set([
  'cobol-runtime',
  'static-fixture',
  'user-provided',
]);

const ACCEPTANCE_MODES: ReadonlySet<AcceptanceMode> = new Set(['file-backed', 'paste-mode']);

const DIAGNOSTIC_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'unsupported-feature',
  'unsupported-data-declaration',
  'unsupported-statement',
  'unterminated-block',
  'unmatched-block-end',
  'mismatched-block-end',
]);

const W02_CONSTRUCTS: ReadonlySet<W02CobolConstruct> = new Set([
  'MOVE',
  'DISPLAY',
  'PERFORM',
  'PERFORM-VARYING',
  'PERFORM-UNTIL',
  'IF',
  'EVALUATE',
  'COMPUTE',
  'ADD',
  'SUBTRACT',
  'MULTIPLY',
  'DIVIDE',
  'CALL',
  'STOP-RUN',
  'PARAGRAPH',
  'WORKING-STORAGE',
]);

const FIXTURE_ID_PATTERN = /^[A-Z][A-Z0-9-]{1,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, fixtureId: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`acceptance fixture ${fixtureId}: ${field} must be a non-empty string`);
  }
  return value;
}

function parseArtifactReference(value: unknown, field: string, fixtureId: string): ArtifactReference {
  if (!isPlainObject(value)) {
    throw new Error(`acceptance fixture ${fixtureId}: ${field} must be an object`);
  }
  const uri = requireString(value.uri, `${field}.uri`, fixtureId);
  const filePath = requireString(value.path, `${field}.path`, fixtureId);
  const sha256 = requireString(value.sha256, `${field}.sha256`, fixtureId);
  if (!/^[0-9a-fA-F]{64}$/.test(sha256)) {
    throw new Error(`acceptance fixture ${fixtureId}: ${field}.sha256 must be a 64-char hex string`);
  }
  const byteSize = value.byteSize;
  if (typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize < 0) {
    throw new Error(`acceptance fixture ${fixtureId}: ${field}.byteSize must be a non-negative integer`);
  }
  const ref: ArtifactReference = { uri, path: filePath, sha256: sha256.toLowerCase(), byteSize };
  if (value.mimeType !== undefined) {
    ref.mimeType = requireString(value.mimeType, `${field}.mimeType`, fixtureId);
  }
  if (value.kind !== undefined) {
    ref.kind = requireString(value.kind, `${field}.kind`, fixtureId);
  }
  return ref;
}

function parseUnsupportedConstruct(value: unknown, idx: number, fixtureId: string): UnsupportedConstruct {
  if (!isPlainObject(value)) {
    throw new Error(`acceptance fixture ${fixtureId}: unsupportedConstructs[${idx}] must be an object`);
  }
  const code = value.code;
  if (typeof code !== 'string' || !DIAGNOSTIC_CODES.has(code as DiagnosticCode)) {
    throw new Error(
      `acceptance fixture ${fixtureId}: unsupportedConstructs[${idx}].code must be one of ${[...DIAGNOSTIC_CODES].join(', ')}`,
    );
  }
  const construct = requireString(value.construct, `unsupportedConstructs[${idx}].construct`, fixtureId);
  const result: UnsupportedConstruct = { code: code as DiagnosticCode, construct };
  if (value.line !== undefined) {
    if (typeof value.line !== 'number' || !Number.isInteger(value.line) || value.line < 1) {
      throw new Error(`acceptance fixture ${fixtureId}: unsupportedConstructs[${idx}].line must be a positive integer`);
    }
    result.line = value.line;
  }
  if (value.message !== undefined) {
    result.message = requireString(value.message, `unsupportedConstructs[${idx}].message`, fixtureId);
  }
  return result;
}

function parseFixture(value: unknown, idx: number): AcceptanceFixture {
  if (!isPlainObject(value)) {
    throw new Error(`fixtures[${idx}] must be an object`);
  }
  const fixtureIdRaw = value.fixtureId;
  if (typeof fixtureIdRaw !== 'string' || !FIXTURE_ID_PATTERN.test(fixtureIdRaw)) {
    throw new Error(`fixtures[${idx}].fixtureId must match /^[A-Z][A-Z0-9-]{1,63}$/`);
  }
  const fixtureId = fixtureIdRaw;
  const title = requireString(value.title, 'title', fixtureId);
  const description = value.description === undefined ? undefined : requireString(value.description, 'description', fixtureId);
  const sourceCobolArtifactRef = parseArtifactReference(value.sourceCobolArtifactRef, 'sourceCobolArtifactRef', fixtureId);
  const expectedOutputArtifactRef = value.expectedOutputArtifactRef === undefined
    ? undefined
    : parseArtifactReference(value.expectedOutputArtifactRef, 'expectedOutputArtifactRef', fixtureId);
  const oracleGenerationMode = value.oracleGenerationMode === undefined
    ? undefined
    : (() => {
        const mode = value.oracleGenerationMode;
        if (typeof mode !== 'string' || !ORACLE_MODES.has(mode as OracleGenerationMode)) {
          throw new Error(`acceptance fixture ${fixtureId}: oracleGenerationMode must be one of ${[...ORACLE_MODES].join(', ')}`);
        }
        return mode as OracleGenerationMode;
      })();
  const supportedSubsetRaw = value.supportedSubset;
  if (!Array.isArray(supportedSubsetRaw)) {
    throw new Error(`acceptance fixture ${fixtureId}: supportedSubset must be an array`);
  }
  const supportedSubset: W02CobolConstruct[] = supportedSubsetRaw.map((entry) => {
    if (typeof entry !== 'string' || !W02_CONSTRUCTS.has(entry as W02CobolConstruct)) {
      throw new Error(`acceptance fixture ${fixtureId}: supportedSubset contains unknown construct ${JSON.stringify(entry)}`);
    }
    return entry as W02CobolConstruct;
  });
  if (new Set(supportedSubset).size !== supportedSubset.length) {
    throw new Error(`acceptance fixture ${fixtureId}: supportedSubset must not contain duplicates`);
  }
  const unsupportedConstructsRaw = value.unsupportedConstructs;
  if (!Array.isArray(unsupportedConstructsRaw)) {
    throw new Error(`acceptance fixture ${fixtureId}: unsupportedConstructs must be an array`);
  }
  const unsupportedConstructs = unsupportedConstructsRaw.map((entry, i) => parseUnsupportedConstruct(entry, i, fixtureId));
  const targetLanguageRaw = value.targetLanguage;
  if (targetLanguageRaw !== 'java') {
    throw new Error(`acceptance fixture ${fixtureId}: targetLanguage must equal "java"`);
  }
  const expectedFinalClassificationRaw = value.expectedFinalClassification;
  if (expectedFinalClassificationRaw !== 'success' && expectedFinalClassificationRaw !== 'blocked') {
    throw new Error(`acceptance fixture ${fixtureId}: expectedFinalClassification must be "success" or "blocked"`);
  }
  const expectedFinalClassification: FinalClassification = expectedFinalClassificationRaw;
  const expectedFailureCode = value.expectedFailureCode === undefined
    ? undefined
    : (() => {
        const code = value.expectedFailureCode;
        if (typeof code !== 'string' || !FAILURE_CODES.has(code as AcceptanceFailureCode)) {
          throw new Error(`acceptance fixture ${fixtureId}: expectedFailureCode must be one of ${[...FAILURE_CODES].join(', ')}`);
        }
        return code as AcceptanceFailureCode;
      })();
  const modesRaw = value.modes;
  if (!Array.isArray(modesRaw) || modesRaw.length === 0) {
    throw new Error(`acceptance fixture ${fixtureId}: modes is required and must be a non-empty array`);
  }
  const modes: AcceptanceMode[] = modesRaw.map((m) => {
    if (typeof m !== 'string' || !ACCEPTANCE_MODES.has(m as AcceptanceMode)) {
      throw new Error(`acceptance fixture ${fixtureId}: modes contains unknown value ${JSON.stringify(m)}`);
    }
    return m as AcceptanceMode;
  });
  if (new Set(modes).size !== modes.length) {
    throw new Error(`acceptance fixture ${fixtureId}: modes must not contain duplicates`);
  }
  // Shipping fixtures must work through both submission surfaces so the
  // BFF paste-mode and the test harness file-backed loaders stay in sync.
  if (!modes.includes('file-backed') || !modes.includes('paste-mode')) {
    throw new Error(
      `acceptance fixture ${fixtureId}: shipping fixtures must declare both "file-backed" and "paste-mode" so the test surface and the UI surface stay aligned`,
    );
  }
  const rationale = requireString(value.rationale, 'rationale', fixtureId);

  // Cross-field rules mirror the schema's allOf branches.
  if (expectedFinalClassification === 'success') {
    if (!oracleGenerationMode) {
      throw new Error(`acceptance fixture ${fixtureId}: success fixtures require oracleGenerationMode`);
    }
    if (expectedFailureCode !== undefined) {
      throw new Error(`acceptance fixture ${fixtureId}: success fixtures must not declare expectedFailureCode`);
    }
  } else {
    if (!expectedFailureCode) {
      throw new Error(`acceptance fixture ${fixtureId}: blocked fixtures require expectedFailureCode`);
    }
    if (unsupportedConstructs.length === 0) {
      throw new Error(`acceptance fixture ${fixtureId}: blocked fixtures must declare at least one unsupportedConstruct`);
    }
  }
  if (oracleGenerationMode === 'static-fixture' && !expectedOutputArtifactRef) {
    throw new Error(`acceptance fixture ${fixtureId}: oracleGenerationMode "static-fixture" requires expectedOutputArtifactRef`);
  }

  return {
    fixtureId,
    title,
    description,
    sourceCobolArtifactRef,
    expectedOutputArtifactRef,
    oracleGenerationMode,
    supportedSubset,
    unsupportedConstructs,
    targetLanguage: 'java',
    expectedFinalClassification,
    expectedFailureCode,
    modes,
    rationale,
  };
}

function verifyArtifactOnDisk(
  ref: ArtifactReference,
  repoRoot: string,
  field: string,
  fixtureId: string,
): Buffer {
  // Path traversal containment. The schema's pattern rejects absolute
  // paths and ".." segments syntactically; this is the defence-in-depth
  // runtime check so a future externally-supplied registry cannot escape
  // the repository root via symlinks or other path tricks.
  if (path.isAbsolute(ref.path)) {
    throw new Error(`acceptance fixture ${fixtureId}: ${field}.path must be repo-relative, got absolute path`);
  }
  const repoRootAbs = path.resolve(repoRoot);
  const abs = path.resolve(repoRootAbs, ref.path);
  const relative = path.relative(repoRootAbs, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`acceptance fixture ${fixtureId}: ${field}.path resolves outside the repository root`);
  }
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(abs);
  } catch (err) {
    throw new Error(
      `acceptance fixture ${fixtureId}: ${field}.path ${ref.path} could not be read: ${(err as Error).message}`,
    );
  }
  if (buffer.byteLength !== ref.byteSize) {
    throw new Error(
      `acceptance fixture ${fixtureId}: ${field}.byteSize ${ref.byteSize} does not match on-disk size ${buffer.byteLength}`,
    );
  }
  const actualSha = createHash('sha256').update(buffer).digest('hex');
  if (actualSha !== ref.sha256) {
    throw new Error(
      `acceptance fixture ${fixtureId}: ${field}.sha256 ${ref.sha256} does not match on-disk hash ${actualSha}`,
    );
  }
  return buffer;
}

function summarise(fixture: AcceptanceFixture): AcceptanceFixtureSummary {
  return {
    fixtureId: fixture.fixtureId,
    title: fixture.title,
    description: fixture.description ?? null,
    oracleGenerationMode: fixture.oracleGenerationMode ?? null,
    supportedSubset: fixture.supportedSubset,
    unsupportedConstructsCount: fixture.unsupportedConstructs.length,
    targetLanguage: fixture.targetLanguage,
    expectedFinalClassification: fixture.expectedFinalClassification,
    expectedFailureCode: fixture.expectedFailureCode ?? null,
    modes: fixture.modes,
  };
}

export function loadAcceptanceFixtureRegistry(repoRoot: string): AcceptanceFixtureRegistry {
  const indexPath = path.join(repoRoot, 'fixtures', 'acceptance', 'index.json');
  const raw = fs.readFileSync(indexPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(`acceptance fixture index at ${indexPath} must be a JSON object`);
  }
  if (parsed.schemaVersion !== 'v0') {
    throw new Error(`acceptance fixture index at ${indexPath} must declare schemaVersion "v0"`);
  }
  const fixturesRaw = parsed.fixtures;
  if (!Array.isArray(fixturesRaw) || fixturesRaw.length === 0) {
    throw new Error(`acceptance fixture index at ${indexPath} must declare a non-empty fixtures array`);
  }
  const fixtures = fixturesRaw.map((entry, idx) => parseFixture(entry, idx));

  // Cross-fixture uniqueness on fixtureId.
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (seen.has(fixture.fixtureId)) {
      throw new Error(`acceptance fixture index at ${indexPath} contains duplicate fixtureId ${fixture.fixtureId}`);
    }
    seen.add(fixture.fixtureId);
  }

  // Verify on-disk content matches declared hashes/sizes — load-time integrity gate.
  const sourceBuffers = new Map<string, Buffer>();
  const expectedBuffers = new Map<string, Buffer>();
  for (const fixture of fixtures) {
    sourceBuffers.set(
      fixture.fixtureId,
      verifyArtifactOnDisk(fixture.sourceCobolArtifactRef, repoRoot, 'sourceCobolArtifactRef', fixture.fixtureId),
    );
    if (fixture.expectedOutputArtifactRef) {
      expectedBuffers.set(
        fixture.fixtureId,
        verifyArtifactOnDisk(
          fixture.expectedOutputArtifactRef,
          repoRoot,
          'expectedOutputArtifactRef',
          fixture.fixtureId,
        ),
      );
    }
  }

  const byId = new Map<string, AcceptanceFixture>();
  for (const fixture of fixtures) {
    byId.set(fixture.fixtureId, fixture);
  }

  return {
    list(): AcceptanceFixtureSummary[] {
      return fixtures.map(summarise);
    },
    get(fixtureId: string): AcceptanceFixtureDetail | undefined {
      const fixture = byId.get(fixtureId);
      if (!fixture) return undefined;
      const cobolSource = sourceBuffers.get(fixtureId)?.toString('utf-8') ?? '';
      const expectedBuffer = expectedBuffers.get(fixtureId);
      const expectedOutput = expectedBuffer ? expectedBuffer.toString('utf-8') : null;
      // Wrap the summary so detail responses validate against the OpenAPI
      // schema: optional/absent fields are normalised to `null`, matching
      // the published nullable contract.
      return {
        ...summarise(fixture),
        sourceCobolArtifactRef: fixture.sourceCobolArtifactRef,
        expectedOutputArtifactRef: fixture.expectedOutputArtifactRef ?? null,
        unsupportedConstructs: fixture.unsupportedConstructs,
        rationale: fixture.rationale,
        cobolSource,
        expectedOutput,
      };
    },
    fixtures(): AcceptanceFixture[] {
      return fixtures.slice();
    },
  };
}
