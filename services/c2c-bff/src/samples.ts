import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GoldenMasterEntry {
  programId: string;
  cobolSource: string;
  expectedOutputPath: string;
  classification: string;
  knownDivergenceAtW0: boolean;
  rationale: string;
}

export interface SampleSummary {
  programId: string;
  title: string;
  description: string;
  knownDivergenceAtW0: boolean;
}

export interface SampleDetail extends SampleSummary {
  cobolSource: string;
  cobolSourcePath: string;
  expectedOutput: string;
}

interface SampleIndexEntry extends SampleSummary {
  cobolSourcePath: string;
  expectedOutputPath: string;
}

export interface SampleRegistry {
  list(): SampleSummary[];
  get(programId: string): SampleDetail | undefined;
}

const TITLE_OVERRIDES: Record<string, string> = {
  BRNCH01: 'Branch approval guard',
  CTRLDEC01: 'Control decimal payroll',
  BATCH01: 'Decimal batch aggregator',
};

function deriveTitle(entry: GoldenMasterEntry): string {
  const override = TITLE_OVERRIDES[entry.programId];
  if (override) return override;
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

function isGoldenMasterEntry(value: unknown): value is GoldenMasterEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.programId === 'string' &&
    typeof candidate.cobolSource === 'string' &&
    typeof candidate.expectedOutputPath === 'string' &&
    typeof candidate.classification === 'string' &&
    typeof candidate.knownDivergenceAtW0 === 'boolean' &&
    typeof candidate.rationale === 'string'
  );
}

export function loadSampleRegistry(repoRoot: string): SampleRegistry {
  const indexPath = path.join(repoRoot, 'fixtures', 'golden-master', 'index.json');
  const indexRaw = readUtf8(indexPath);
  const parsed = JSON.parse(indexRaw) as { entries?: unknown };
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`golden-master index at ${indexPath} is missing an "entries" array`);
  }
  const validEntries: GoldenMasterEntry[] = parsed.entries.filter(isGoldenMasterEntry);
  const entries: SampleIndexEntry[] = validEntries.map((entry) => ({
    programId: entry.programId,
    title: deriveTitle(entry),
    description: entry.rationale,
    knownDivergenceAtW0: entry.knownDivergenceAtW0,
    cobolSourcePath: path.resolve(repoRoot, entry.cobolSource),
    expectedOutputPath: path.resolve(repoRoot, entry.expectedOutputPath),
  }));

  const byProgramId = new Map<string, SampleIndexEntry>();
  for (const entry of entries) {
    byProgramId.set(entry.programId, entry);
  }

  return {
    list(): SampleSummary[] {
      return entries.map(({ programId, title, description, knownDivergenceAtW0 }) => ({
        programId,
        title,
        description,
        knownDivergenceAtW0,
      }));
    },
    get(programId: string): SampleDetail | undefined {
      const entry = byProgramId.get(programId);
      if (!entry) return undefined;
      return {
        programId: entry.programId,
        title: entry.title,
        description: entry.description,
        knownDivergenceAtW0: entry.knownDivergenceAtW0,
        cobolSource: readUtf8(entry.cobolSourcePath),
        cobolSourcePath: path.relative(repoRoot, entry.cobolSourcePath),
        expectedOutput: readUtf8(entry.expectedOutputPath),
      };
    },
  };
}
