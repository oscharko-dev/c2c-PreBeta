import * as path from 'node:path';
import * as fs from 'node:fs';

export interface BffConfig {
  serviceName: string;
  port: number;
  repoRoot: string;
  staticRoot: string;
  orchestratorUrl: string;
  evidenceUrl: string;
  upstreamTimeoutMs: number;
  transformSourceMaxBytes: number;
  enableDiagnosticFixtures: boolean;
}

const SERVICE_NAME = 'c2c-bff';
const DEFAULT_PORT = 8090;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 4_000;
const DEFAULT_TRANSFORM_SOURCE_MAX_BYTES = 1_000_000;

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`invalid port ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid timeout ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseBoolFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseSizeBytes(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid size limit ${JSON.stringify(raw)}`);
  }
  return value;
}

function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (let i = 0; i < 10; i += 1) {
    const corpusDir = path.join(current, 'corpus');
    const fixturesDir = path.join(current, 'fixtures', 'golden-master');
    if (fs.existsSync(corpusDir) && fs.existsSync(fixturesDir)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir);
}

function resolveStaticRoot(env: NodeJS.ProcessEnv, repoRoot: string): string {
  const explicit = env.C2C_UI_DIST?.trim();
  if (explicit) return path.resolve(explicit);
  return path.resolve(repoRoot, 'apps', 'c2c-ui', 'dist');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, packageRoot: string = __dirname): BffConfig {
  const repoRoot = env.C2C_REPO_ROOT?.trim()
    ? path.resolve(env.C2C_REPO_ROOT)
    : findRepoRoot(path.resolve(packageRoot, '..', '..'));
  return {
    serviceName: SERVICE_NAME,
    port: parsePort(env.C2C_BFF_PORT, DEFAULT_PORT),
    repoRoot,
    staticRoot: resolveStaticRoot(env, repoRoot),
    orchestratorUrl: env.C2C_ORCHESTRATOR_URL?.trim() ?? '',
    evidenceUrl: env.C2C_EVIDENCE_URL?.trim() ?? '',
    upstreamTimeoutMs: parseTimeoutMs(env.C2C_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS),
    transformSourceMaxBytes: parseSizeBytes(env.C2C_TRANSFORM_SOURCE_MAX_BYTES, DEFAULT_TRANSFORM_SOURCE_MAX_BYTES),
    enableDiagnosticFixtures: parseBoolFlag(env.C2C_ENABLE_DIAGNOSTIC_FIXTURES),
  };
}
