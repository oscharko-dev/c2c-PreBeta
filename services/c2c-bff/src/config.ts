import * as path from "node:path";
import * as fs from "node:fs";

export interface BffConfig {
  serviceName: string;
  port: number;
  repoRoot: string;
  staticRoot: string;
  orchestratorUrl: string;
  orchestratorControlToken: string;
  evidenceUrl: string;
  experienceLearningUrl: string;
  modelGatewayUrl: string;
  harnessUrl: string;
  // Studio-IDE-14 (#256): the build-test-runner-service hosts the
  // deterministic Java formatter at /v0/format-java. The BFF proxies the
  // Studio's format requests to it through this URL.
  buildTestRunnerUrl: string;
  buildTestRunnerControlToken: string;
  // Format requests get their own latency budget because the formatter is
  // a UI affordance and the editor needs the response inside 1.5 s for
  // 1k-line files (Studio-IDE-14 AC). Default 5 s leaves headroom over
  // the 1.5 s target without holding browser sockets indefinitely.
  formatJavaTimeoutMs: number;
  // Studio-IDE-14 (#256): the BFF caps inbound format payloads so a
  // browser cannot pin the BFF or the formatter with an enormous buffer.
  formatJavaSourceMaxBytes: number;
  upstreamTimeoutMs: number;
  transformSourceMaxBytes: number;
  // Issue #172: size limit applied to artifact-content responses
  // (currently the per-file generated Java view). Anything larger is
  // rejected with HTTP 413 + { error: 'artifact_too_large' } so a single
  // run cannot pin the BFF process or the browser tab.
  artifactContentMaxBytes: number;
  enableDiagnosticFixtures: boolean;
}

const SERVICE_NAME = "c2c-bff";
const DEFAULT_PORT = 8090;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 4_000;
const DEFAULT_TRANSFORM_SOURCE_MAX_BYTES = 1_000_000;
const DEFAULT_ARTIFACT_CONTENT_MAX_BYTES = 1_048_576;
// Studio-IDE-14 (#256): 5 s upstream budget for /v0/format-java. The
// editor cancels its own client-side request earlier (1.5 s AC), so this
// only protects the BFF from a hung subprocess on the runner.
const DEFAULT_FORMAT_JAVA_TIMEOUT_MS = 5_000;
// 1 MiB matches the transform-source cap. Studio enforces a smaller per-file
// budget on its side; the BFF cap is the last line of defence.
const DEFAULT_FORMAT_JAVA_SOURCE_MAX_BYTES = 1_048_576;

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`invalid port ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid timeout ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseBoolFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function parseSizeBytes(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid size limit ${JSON.stringify(raw)}`);
  }
  return value;
}

function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (let i = 0; i < 10; i += 1) {
    const corpusDir = path.join(current, "corpus");
    const fixturesDir = path.join(current, "fixtures", "golden-master");
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
  return path.resolve(repoRoot, "apps", "c2c-ui", "dist");
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  packageRoot: string = __dirname,
): BffConfig {
  const repoRoot = env.C2C_REPO_ROOT?.trim()
    ? path.resolve(env.C2C_REPO_ROOT)
    : findRepoRoot(path.resolve(packageRoot, "..", ".."));
  const orchestratorUrl = env.C2C_ORCHESTRATOR_URL?.trim() ?? "";
  const orchestratorControlToken =
    env.C2C_ORCHESTRATOR_CONTROL_TOKEN?.trim() ?? "";
  if (orchestratorUrl && !orchestratorControlToken) {
    throw new Error(
      "C2C_ORCHESTRATOR_CONTROL_TOKEN is required when C2C_ORCHESTRATOR_URL is set",
    );
  }
  return {
    serviceName: SERVICE_NAME,
    port: parsePort(env.C2C_BFF_PORT, DEFAULT_PORT),
    repoRoot,
    staticRoot: resolveStaticRoot(env, repoRoot),
    orchestratorUrl,
    orchestratorControlToken,
    evidenceUrl: env.C2C_EVIDENCE_URL?.trim() ?? "",
    experienceLearningUrl: env.C2C_EXPERIENCE_LEARNING_URL?.trim() ?? "",
    modelGatewayUrl: env.C2C_MODEL_GATEWAY_URL?.trim() ?? "",
    harnessUrl: env.C2C_HARNESS_URL?.trim() ?? "",
    buildTestRunnerUrl: env.C2C_BUILD_TEST_RUNNER_URL?.trim() ?? "",
    buildTestRunnerControlToken:
      env.C2C_BUILD_TEST_RUNNER_CONTROL_TOKEN?.trim() ?? "",
    formatJavaTimeoutMs: parseTimeoutMs(
      env.C2C_FORMAT_JAVA_TIMEOUT_MS,
      DEFAULT_FORMAT_JAVA_TIMEOUT_MS,
    ),
    formatJavaSourceMaxBytes: parseSizeBytes(
      env.C2C_FORMAT_JAVA_SOURCE_MAX_BYTES,
      DEFAULT_FORMAT_JAVA_SOURCE_MAX_BYTES,
    ),
    upstreamTimeoutMs: parseTimeoutMs(
      env.C2C_UPSTREAM_TIMEOUT_MS,
      DEFAULT_UPSTREAM_TIMEOUT_MS,
    ),
    transformSourceMaxBytes: parseSizeBytes(
      env.C2C_TRANSFORM_SOURCE_MAX_BYTES,
      DEFAULT_TRANSFORM_SOURCE_MAX_BYTES,
    ),
    artifactContentMaxBytes: parseSizeBytes(
      env.C2C_ARTIFACT_CONTENT_MAX_BYTES,
      DEFAULT_ARTIFACT_CONTENT_MAX_BYTES,
    ),
    enableDiagnosticFixtures: parseBoolFlag(env.C2C_ENABLE_DIAGNOSTIC_FIXTURES),
  };
}
