import * as fs from 'node:fs';
import * as path from 'node:path';

export type OracleMode = 'cobol-runtime' | 'synthetic-fixture';

export interface GoldenMasterEntry {
  programId: string;
  cobolSource: string;
  expectedOutputPath: string;
  classification: string;
  knownDivergenceAtW0: boolean;
  rationale: string;
  title?: string;
  supportedInProductMode?: boolean;
  w0Subset?: string[];
  oracleMode?: OracleMode;
  knownLimitations?: string[];
}

export interface SampleSummary {
  programId: string;
  title: string;
  description: string;
  knownDivergenceAtW0: boolean;
  supportedInProductMode: boolean;
  w0Subset: string[];
  oracleMode: OracleMode | null;
  knownLimitations: string[];
}

export interface SampleDetail extends SampleSummary {
  cobolSource: string;
  cobolSourcePath: string;
  expectedOutput: string;
  expectedOutputPath: string;
}

interface SampleIndexEntry extends SampleSummary {
  cobolSourcePath: string;
  expectedOutputPath: string;
  expectedOutputAbsPath: string;
}

export interface SampleRegistry {
  list(): SampleSummary[];
  get(programId: string): SampleDetail | undefined;
}

const ORACLE_MODES: ReadonlySet<OracleMode> = new Set(['cobol-runtime', 'synthetic-fixture']);

function deriveTitle(entry: GoldenMasterEntry): string {
  if (typeof entry.title === 'string' && entry.title.trim().length > 0) {
    return entry.title.trim();
  }
  const base = path.basename(entry.cobolSource, path.extname(entry.cobolSource));
  return base
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isGoldenMasterEntry(value: unknown): value is GoldenMasterEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.programId !== 'string' ||
    typeof candidate.cobolSource !== 'string' ||
    typeof candidate.expectedOutputPath !== 'string' ||
    typeof candidate.classification !== 'string' ||
    typeof candidate.knownDivergenceAtW0 !== 'boolean' ||
    typeof candidate.rationale !== 'string'
  ) {
    return false;
  }
  if (candidate.title !== undefined && typeof candidate.title !== 'string') return false;
  if (candidate.supportedInProductMode !== undefined && typeof candidate.supportedInProductMode !== 'boolean') return false;
  if (candidate.w0Subset !== undefined && !isStringArray(candidate.w0Subset)) return false;
  if (candidate.oracleMode !== undefined && (typeof candidate.oracleMode !== 'string' || !ORACLE_MODES.has(candidate.oracleMode as OracleMode))) {
    return false;
  }
  if (candidate.knownLimitations !== undefined && !isStringArray(candidate.knownLimitations)) return false;
  return true;
}

function summarize(entry: GoldenMasterEntry): SampleSummary {
  const supportedInProductMode = entry.supportedInProductMode === true;
  const w0Subset = entry.w0Subset ?? [];
  const oracleMode = entry.oracleMode ?? null;
  const knownLimitations = entry.knownLimitations ?? [];
  return {
    programId: entry.programId,
    title: deriveTitle(entry),
    description: entry.rationale,
    knownDivergenceAtW0: entry.knownDivergenceAtW0,
    supportedInProductMode,
    w0Subset,
    oracleMode,
    knownLimitations,
  };
}

function validateRunnableContract(entry: GoldenMasterEntry, indexPath: string): void {
  if (entry.supportedInProductMode !== true) return;
  const w0 = entry.w0Subset ?? [];
  if (w0.length === 0) {
    throw new Error(
      `reference program ${entry.programId} in ${indexPath} is supportedInProductMode but has no w0Subset entries`,
    );
  }
  if (!entry.oracleMode) {
    throw new Error(
      `reference program ${entry.programId} in ${indexPath} is supportedInProductMode but has no oracleMode`,
    );
  }
}

export function loadSampleRegistry(repoRoot: string): SampleRegistry {
  const indexPath = path.join(repoRoot, 'fixtures', 'golden-master', 'index.json');
  const indexRaw = readUtf8(indexPath);
  const parsed = JSON.parse(indexRaw) as { entries?: unknown };
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`golden-master index at ${indexPath} is missing an "entries" array`);
  }
  const validEntries: GoldenMasterEntry[] = parsed.entries.filter(isGoldenMasterEntry);
  for (const entry of validEntries) {
    validateRunnableContract(entry, indexPath);
  }
  const entries: SampleIndexEntry[] = validEntries.map((entry) => ({
    ...summarize(entry),
    cobolSourcePath: entry.cobolSource,
    expectedOutputPath: entry.expectedOutputPath,
    expectedOutputAbsPath: path.resolve(repoRoot, entry.expectedOutputPath),
  }));

  const byProgramId = new Map<string, SampleIndexEntry>();
  for (const entry of entries) {
    byProgramId.set(entry.programId, entry);
  }

  return {
    list(): SampleSummary[] {
      return entries.map(({ cobolSourcePath: _csp, expectedOutputPath: _eop, expectedOutputAbsPath: _eoa, ...summary }) => summary);
    },
    get(programId: string): SampleDetail | undefined {
      const entry = byProgramId.get(programId);
      if (!entry) return undefined;
      const sourceAbs = path.resolve(repoRoot, entry.cobolSourcePath);
      return {
        programId: entry.programId,
        title: entry.title,
        description: entry.description,
        knownDivergenceAtW0: entry.knownDivergenceAtW0,
        supportedInProductMode: entry.supportedInProductMode,
        w0Subset: entry.w0Subset,
        oracleMode: entry.oracleMode,
        knownLimitations: entry.knownLimitations,
        cobolSource: readUtf8(sourceAbs),
        cobolSourcePath: entry.cobolSourcePath,
        expectedOutput: readUtf8(entry.expectedOutputAbsPath),
        expectedOutputPath: entry.expectedOutputPath,
      };
    },
  };
}
