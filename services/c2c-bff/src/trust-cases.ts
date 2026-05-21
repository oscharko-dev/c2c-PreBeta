import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import {
  loadAcceptanceFixtureRegistry,
  type AcceptanceFixtureRegistry,
  type W02CobolConstruct,
} from "./acceptance-fixtures";

export type TrustCaseSourceReferenceMode =
  | "reference-fixture"
  | "native-cobol";
export type TrustCaseEnvironmentProfileId =
  | "generated-java-sandbox-v1"
  | "reference-fixture-v1"
  | "native-cobol-controlled-v1";
export type TrustCaseComparisonStrategy = "deterministic-output";
export type TrustCaseComparisonPolicyVersion = "deterministic-output-v1";

export interface TrustCaseSourceReference {
  fixtureId: string;
  mode: TrustCaseSourceReferenceMode;
}

export interface TrustCaseControlledInput {
  stdin: string | null;
  dataSetIds: string[];
  expectedOutputFixtureId: string;
}

export interface TrustCaseRuntime {
  programArgs: string[];
}

export interface TrustCaseEnvironmentProfile {
  profileId: TrustCaseEnvironmentProfileId;
  description: string;
  variables: Record<string, string>;
}

export interface TrustCaseComparison {
  strategy: TrustCaseComparisonStrategy;
  policyVersion: TrustCaseComparisonPolicyVersion;
}

export interface TrustCaseSupportedProgramShape {
  language: "cobol";
  programId: string;
  supportedSubset: W02CobolConstruct[];
}

export interface TrustCaseEvidenceIdentity {
  kind: "trust-case";
  artifactName: string;
}

export interface TrustCase {
  trustCaseId: string;
  version: string;
  programId: string;
  title: string;
  description: string;
  defaultForProgram: boolean;
  sourceReference: TrustCaseSourceReference;
  controlledInput: TrustCaseControlledInput;
  runtime: TrustCaseRuntime;
  environmentProfile: TrustCaseEnvironmentProfile;
  comparison: TrustCaseComparison;
  supportedProgramShape: TrustCaseSupportedProgramShape;
  evidenceIdentity: TrustCaseEvidenceIdentity;
}

export interface TrustCaseSummary {
  trustCaseId: string;
  version: string;
  catalogVersion: string;
  catalogHash: string;
  configurationDigest: string;
  programId: string;
  title: string;
  description: string;
  defaultForProgram: boolean;
  sourceReferenceFixtureId: string;
  sourceReferenceMode: TrustCaseSourceReferenceMode;
  environmentProfileId: TrustCaseEnvironmentProfileId;
  comparisonStrategy: TrustCaseComparisonStrategy;
  comparisonPolicyVersion: TrustCaseComparisonPolicyVersion;
  supportedSubset: W02CobolConstruct[];
}

export interface TrustCaseCatalog {
  schemaVersion: "v0";
  catalogVersion: string;
  catalogHash: string;
  list(programId?: string): TrustCaseSummary[];
  get(trustCaseId: string): TrustCaseSummary | undefined;
  defaultForProgram(programId: string): TrustCaseSummary | undefined;
}

const TRUST_CASE_ID_PATTERN = /^[A-Z][A-Z0-9-]{1,63}$/u;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const SAFE_PROFILE_VARIABLE_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_PROFILE_VARIABLE_VALUE = /^[A-Za-z0-9._:/=+\-]{0,256}$/u;
const SAFE_RUNTIME_VALUE = /^[A-Za-z0-9._:=@/+,-]{0,80}$/u;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,96}$/u;
const SAFE_DATASET_ID = /^[A-Z][A-Z0-9_-]{1,63}$/u;
const ENVIRONMENT_PROFILE_IDS = new Set<TrustCaseEnvironmentProfileId>([
  "generated-java-sandbox-v1",
  "reference-fixture-v1",
  "native-cobol-controlled-v1",
]);
const SOURCE_REFERENCE_MODES = new Set<TrustCaseSourceReferenceMode>([
  "reference-fixture",
  "native-cobol",
]);
const W02_CONSTRUCTS = new Set<W02CobolConstruct>([
  "MOVE",
  "DISPLAY",
  "PERFORM",
  "PERFORM-VARYING",
  "PERFORM-UNTIL",
  "IF",
  "EVALUATE",
  "COMPUTE",
  "ADD",
  "SUBTRACT",
  "MULTIPLY",
  "DIVIDE",
  "CALL",
  "STOP-RUN",
  "PARAGRAPH",
  "WORKING-STORAGE",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoExtraKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  scope: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${scope}: unexpected field ${JSON.stringify(key)}`);
    }
  }
}

function requireString(
  value: unknown,
  field: string,
  trustCaseId: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`trust case ${trustCaseId}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringMatching(
  value: unknown,
  field: string,
  trustCaseId: string,
  pattern: RegExp,
): string {
  const result = requireString(value, field, trustCaseId);
  if (!pattern.test(result)) {
    throw new Error(`trust case ${trustCaseId}: ${field} has an unsafe value`);
  }
  return result;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeValueLooksUnsafe(value: string): boolean {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.includes("..")) return true;
  return /[\s;&|`$<>]/u.test(value);
}

function parseSourceReference(
  raw: unknown,
  trustCaseId: string,
): TrustCaseSourceReference {
  if (!isPlainObject(raw)) {
    throw new Error(`trust case ${trustCaseId}: sourceReference must be an object`);
  }
  assertNoExtraKeys(raw, ["fixtureId", "mode"], `trust case ${trustCaseId}.sourceReference`);
  const fixtureId = requireStringMatching(
    raw.fixtureId,
    "sourceReference.fixtureId",
    trustCaseId,
    TRUST_CASE_ID_PATTERN,
  );
  const modeRaw = requireString(raw.mode, "sourceReference.mode", trustCaseId);
  if (!SOURCE_REFERENCE_MODES.has(modeRaw as TrustCaseSourceReferenceMode)) {
    throw new Error(
      `trust case ${trustCaseId}: sourceReference.mode must be reference-fixture or native-cobol`,
    );
  }
  return { fixtureId, mode: modeRaw as TrustCaseSourceReferenceMode };
}

function parseControlledInput(
  raw: unknown,
  trustCaseId: string,
): TrustCaseControlledInput {
  if (!isPlainObject(raw)) {
    throw new Error(`trust case ${trustCaseId}: controlledInput must be an object`);
  }
  assertNoExtraKeys(
    raw,
    ["stdin", "dataSetIds", "expectedOutputFixtureId"],
    `trust case ${trustCaseId}.controlledInput`,
  );
  const stdin =
    raw.stdin === null || raw.stdin === undefined
      ? null
      : (() => {
          if (typeof raw.stdin !== "string" || raw.stdin.length > 8192) {
            throw new Error(
              `trust case ${trustCaseId}: controlledInput.stdin must be null or a bounded string`,
            );
          }
          return raw.stdin;
        })();
  const dataSetIdsRaw = raw.dataSetIds;
  if (!Array.isArray(dataSetIdsRaw) || dataSetIdsRaw.length > 16) {
    throw new Error(
      `trust case ${trustCaseId}: controlledInput.dataSetIds must be an array of at most 16 entries`,
    );
  }
  const dataSetIds = dataSetIdsRaw.map((entry, idx) => {
    if (typeof entry !== "string" || !SAFE_DATASET_ID.test(entry)) {
      throw new Error(
        `trust case ${trustCaseId}: controlledInput.dataSetIds[${idx}] has an unsafe value`,
      );
    }
    return entry;
  });
  if (new Set(dataSetIds).size !== dataSetIds.length) {
    throw new Error(`trust case ${trustCaseId}: controlledInput.dataSetIds must not contain duplicates`);
  }
  const expectedOutputFixtureId = requireStringMatching(
    raw.expectedOutputFixtureId,
    "controlledInput.expectedOutputFixtureId",
    trustCaseId,
    TRUST_CASE_ID_PATTERN,
  );
  return { stdin, dataSetIds, expectedOutputFixtureId };
}

function parseRuntime(raw: unknown, trustCaseId: string): TrustCaseRuntime {
  if (!isPlainObject(raw)) {
    throw new Error(`trust case ${trustCaseId}: runtime must be an object`);
  }
  assertNoExtraKeys(raw, ["programArgs"], `trust case ${trustCaseId}.runtime`);
  const programArgsRaw = raw.programArgs;
  if (!Array.isArray(programArgsRaw) || programArgsRaw.length > 8) {
    throw new Error(`trust case ${trustCaseId}: runtime.programArgs must be an array of at most 8 entries`);
  }
  const programArgs = programArgsRaw.map((entry, idx) => {
    if (
      typeof entry !== "string" ||
      !SAFE_RUNTIME_VALUE.test(entry) ||
      runtimeValueLooksUnsafe(entry)
    ) {
      throw new Error(`trust case ${trustCaseId}: runtime.programArgs[${idx}] has an unsafe value`);
    }
    return entry;
  });
  return { programArgs };
}

function parseEnvironmentProfile(
  raw: unknown,
  trustCaseId: string,
): TrustCaseEnvironmentProfile {
  if (!isPlainObject(raw)) {
    throw new Error(`trust case ${trustCaseId}: environmentProfile must be an object`);
  }
  assertNoExtraKeys(
    raw,
    ["profileId", "description", "variables"],
    `trust case ${trustCaseId}.environmentProfile`,
  );
  const profileIdRaw = requireString(raw.profileId, "environmentProfile.profileId", trustCaseId);
  if (!ENVIRONMENT_PROFILE_IDS.has(profileIdRaw as TrustCaseEnvironmentProfileId)) {
    throw new Error(`trust case ${trustCaseId}: environmentProfile.profileId is not supported`);
  }
  const description = requireString(
    raw.description,
    "environmentProfile.description",
    trustCaseId,
  );
  const variablesRaw = raw.variables;
  if (!isPlainObject(variablesRaw)) {
    throw new Error(`trust case ${trustCaseId}: environmentProfile.variables must be an object`);
  }
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(variablesRaw)) {
    if (!SAFE_PROFILE_VARIABLE_KEY.test(key)) {
      throw new Error(`trust case ${trustCaseId}: environmentProfile.variables contains an unsafe key`);
    }
    if (typeof value !== "string" || !SAFE_PROFILE_VARIABLE_VALUE.test(value)) {
      throw new Error(`trust case ${trustCaseId}: environmentProfile.variables.${key} has an unsafe value`);
    }
    variables[key] = value;
  }
  return {
    profileId: profileIdRaw as TrustCaseEnvironmentProfileId,
    description,
    variables,
  };
}

function parseComparison(raw: unknown, trustCaseId: string): TrustCaseComparison {
  if (!isPlainObject(raw)) {
    throw new Error(`trust case ${trustCaseId}: comparison must be an object`);
  }
  assertNoExtraKeys(raw, ["strategy", "policyVersion"], `trust case ${trustCaseId}.comparison`);
  if (raw.strategy !== "deterministic-output") {
    throw new Error(`trust case ${trustCaseId}: comparison.strategy must be deterministic-output`);
  }
  if (raw.policyVersion !== "deterministic-output-v1") {
    throw new Error(`trust case ${trustCaseId}: comparison.policyVersion must be deterministic-output-v1`);
  }
  return {
    strategy: "deterministic-output",
    policyVersion: "deterministic-output-v1",
  };
}

function parseSupportedProgramShape(
  raw: unknown,
  trustCaseId: string,
  programId: string,
): TrustCaseSupportedProgramShape {
  if (!isPlainObject(raw)) {
    throw new Error(`trust case ${trustCaseId}: supportedProgramShape must be an object`);
  }
  assertNoExtraKeys(
    raw,
    ["language", "programId", "supportedSubset"],
    `trust case ${trustCaseId}.supportedProgramShape`,
  );
  if (raw.language !== "cobol") {
    throw new Error(`trust case ${trustCaseId}: supportedProgramShape.language must be cobol`);
  }
  const shapeProgramId = requireString(raw.programId, "supportedProgramShape.programId", trustCaseId);
  if (shapeProgramId !== programId) {
    throw new Error(`trust case ${trustCaseId}: supportedProgramShape.programId must match programId`);
  }
  const supportedSubsetRaw = raw.supportedSubset;
  if (!Array.isArray(supportedSubsetRaw) || supportedSubsetRaw.length === 0) {
    throw new Error(`trust case ${trustCaseId}: supportedProgramShape.supportedSubset must be non-empty`);
  }
  const supportedSubset = supportedSubsetRaw.map((entry) => {
    if (typeof entry !== "string" || !W02_CONSTRUCTS.has(entry as W02CobolConstruct)) {
      throw new Error(`trust case ${trustCaseId}: supportedProgramShape.supportedSubset contains an unknown construct`);
    }
    return entry as W02CobolConstruct;
  });
  if (new Set(supportedSubset).size !== supportedSubset.length) {
    throw new Error(`trust case ${trustCaseId}: supportedProgramShape.supportedSubset must not contain duplicates`);
  }
  return { language: "cobol", programId, supportedSubset };
}

function parseEvidenceIdentity(
  raw: unknown,
  trustCaseId: string,
): TrustCaseEvidenceIdentity {
  if (!isPlainObject(raw)) {
    throw new Error(`trust case ${trustCaseId}: evidenceIdentity must be an object`);
  }
  assertNoExtraKeys(raw, ["kind", "artifactName"], `trust case ${trustCaseId}.evidenceIdentity`);
  if (raw.kind !== "trust-case") {
    throw new Error(`trust case ${trustCaseId}: evidenceIdentity.kind must be trust-case`);
  }
  const artifactName = requireStringMatching(
    raw.artifactName,
    "evidenceIdentity.artifactName",
    trustCaseId,
    SAFE_ARTIFACT_NAME,
  );
  return { kind: "trust-case", artifactName };
}

function parseTrustCase(raw: unknown, idx: number): TrustCase {
  if (!isPlainObject(raw)) {
    throw new Error(`trustCases[${idx}] must be an object`);
  }
  assertNoExtraKeys(
    raw,
    [
      "trustCaseId",
      "version",
      "programId",
      "title",
      "description",
      "defaultForProgram",
      "sourceReference",
      "controlledInput",
      "runtime",
      "environmentProfile",
      "comparison",
      "supportedProgramShape",
      "evidenceIdentity",
    ],
    `trustCases[${idx}]`,
  );
  const trustCaseId = requireStringMatching(
    raw.trustCaseId,
    `trustCases[${idx}].trustCaseId`,
    `#${idx}`,
    TRUST_CASE_ID_PATTERN,
  );
  const version = requireStringMatching(raw.version, "version", trustCaseId, SAFE_VERSION_PATTERN);
  const programId = requireString(raw.programId, "programId", trustCaseId);
  const title = requireString(raw.title, "title", trustCaseId);
  const description = requireString(raw.description, "description", trustCaseId);
  if (typeof raw.defaultForProgram !== "boolean") {
    throw new Error(`trust case ${trustCaseId}: defaultForProgram must be a boolean`);
  }
  const sourceReference = parseSourceReference(raw.sourceReference, trustCaseId);
  const controlledInput = parseControlledInput(raw.controlledInput, trustCaseId);
  const runtime = parseRuntime(raw.runtime, trustCaseId);
  const environmentProfile = parseEnvironmentProfile(raw.environmentProfile, trustCaseId);
  const comparison = parseComparison(raw.comparison, trustCaseId);
  const supportedProgramShape = parseSupportedProgramShape(
    raw.supportedProgramShape,
    trustCaseId,
    programId,
  );
  const evidenceIdentity = parseEvidenceIdentity(raw.evidenceIdentity, trustCaseId);
  return {
    trustCaseId,
    version,
    programId,
    title,
    description,
    defaultForProgram: raw.defaultForProgram,
    sourceReference,
    controlledInput,
    runtime,
    environmentProfile,
    comparison,
    supportedProgramShape,
    evidenceIdentity,
  };
}

function summarize(
  trustCase: TrustCase,
  catalogVersion: string,
  catalogHash: string,
): TrustCaseSummary {
  const identityPayload = {
    trustCaseId: trustCase.trustCaseId,
    version: trustCase.version,
    programId: trustCase.programId,
    catalogVersion,
    catalogHash,
    sourceReferenceFixtureId: trustCase.sourceReference.fixtureId,
    sourceReferenceMode: trustCase.sourceReference.mode,
    sourceReference: {
      fixtureId: trustCase.sourceReference.fixtureId,
      mode: trustCase.sourceReference.mode,
    },
    controlledInput: {
      stdin: trustCase.controlledInput.stdin,
      dataSetIds: trustCase.controlledInput.dataSetIds,
      expectedOutputFixtureId: trustCase.controlledInput.expectedOutputFixtureId,
    },
    runtimeProgramArgs: trustCase.runtime.programArgs,
    runtime: {
      programArgs: trustCase.runtime.programArgs,
    },
    environmentProfileId: trustCase.environmentProfile.profileId,
    environmentProfile: {
      profileId: trustCase.environmentProfile.profileId,
      description: trustCase.environmentProfile.description,
      variables: trustCase.environmentProfile.variables,
    },
    comparisonStrategy: trustCase.comparison.strategy,
    comparisonPolicyVersion: trustCase.comparison.policyVersion,
    supportedProgramShape: trustCase.supportedProgramShape,
    evidenceArtifactName: trustCase.evidenceIdentity.artifactName,
  };
  const configurationDigest = sha256Hex(JSON.stringify(canonicalize(identityPayload)));
  return {
    trustCaseId: trustCase.trustCaseId,
    version: trustCase.version,
    catalogVersion,
    catalogHash,
    configurationDigest,
    programId: trustCase.programId,
    title: trustCase.title,
    description: trustCase.description,
    defaultForProgram: trustCase.defaultForProgram,
    sourceReferenceFixtureId: trustCase.sourceReference.fixtureId,
    sourceReferenceMode: trustCase.sourceReference.mode,
    environmentProfileId: trustCase.environmentProfile.profileId,
    comparisonStrategy: trustCase.comparison.strategy,
    comparisonPolicyVersion: trustCase.comparison.policyVersion,
    supportedSubset: trustCase.supportedProgramShape.supportedSubset,
  };
}

export function loadTrustCaseCatalog(
  repoRoot: string,
  acceptanceFixtures: AcceptanceFixtureRegistry = loadAcceptanceFixtureRegistry(repoRoot),
): TrustCaseCatalog {
  const indexPath = path.join(repoRoot, "fixtures", "trust-cases", "index.json");
  const raw = fs.readFileSync(indexPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(`trust-case catalog at ${indexPath} must be a JSON object`);
  }
  assertNoExtraKeys(
    parsed,
    ["schemaVersion", "catalogVersion", "description", "trustCases"],
    "trust-case catalog",
  );
  if (parsed.schemaVersion !== "v0") {
    throw new Error(`trust-case catalog at ${indexPath} must declare schemaVersion "v0"`);
  }
  const catalogVersion = requireStringMatching(
    parsed.catalogVersion,
    "catalogVersion",
    "catalog",
    SAFE_VERSION_PATTERN,
  );
  const trustCasesRaw = parsed.trustCases;
  if (!Array.isArray(trustCasesRaw) || trustCasesRaw.length === 0) {
    throw new Error(`trust-case catalog at ${indexPath} must declare a non-empty trustCases array`);
  }
  const trustCases = trustCasesRaw.map(parseTrustCase);
  const fixtureSummaries = new Map(
    acceptanceFixtures.list().map((fixture) => [fixture.fixtureId, fixture]),
  );
  const seen = new Set<string>();
  const defaultsByProgram = new Map<string, string[]>();
  for (const trustCase of trustCases) {
    if (seen.has(trustCase.trustCaseId)) {
      throw new Error(`trust-case catalog at ${indexPath} contains duplicate trustCaseId ${trustCase.trustCaseId}`);
    }
    seen.add(trustCase.trustCaseId);
    const sourceFixture = fixtureSummaries.get(trustCase.sourceReference.fixtureId);
    if (!sourceFixture) {
      throw new Error(
        `trust case ${trustCase.trustCaseId}: sourceReference.fixtureId ${trustCase.sourceReference.fixtureId} is not an acceptance fixture`,
      );
    }
    if (trustCase.controlledInput.expectedOutputFixtureId !== trustCase.sourceReference.fixtureId) {
      throw new Error(
        `trust case ${trustCase.trustCaseId}: controlledInput.expectedOutputFixtureId must match sourceReference.fixtureId for W0 parity fixtures`,
      );
    }
    for (const construct of trustCase.supportedProgramShape.supportedSubset) {
      if (!sourceFixture.supportedSubset.includes(construct)) {
        throw new Error(
          `trust case ${trustCase.trustCaseId}: supportedProgramShape contains ${construct}, which is not declared by fixture ${sourceFixture.fixtureId}`,
        );
      }
    }
    if (trustCase.defaultForProgram) {
      const current = defaultsByProgram.get(trustCase.programId) ?? [];
      current.push(trustCase.trustCaseId);
      defaultsByProgram.set(trustCase.programId, current);
    } else if (!defaultsByProgram.has(trustCase.programId)) {
      defaultsByProgram.set(trustCase.programId, []);
    }
  }
  for (const [programId, defaultIds] of defaultsByProgram) {
    if (defaultIds.length !== 1) {
      throw new Error(
        `trust-case catalog at ${indexPath} must declare exactly one default trust case for program ${programId}`,
      );
    }
  }

  const catalogHash = sha256Hex(JSON.stringify(canonicalize(parsed)));
  const summaries = trustCases.map((trustCase) =>
    summarize(trustCase, catalogVersion, catalogHash),
  );
  const byId = new Map(summaries.map((summary) => [summary.trustCaseId, summary]));
  return {
    schemaVersion: "v0",
    catalogVersion,
    catalogHash,
    list(programId?: string): TrustCaseSummary[] {
      return summaries.filter((summary) => !programId || summary.programId === programId);
    },
    get(trustCaseId: string): TrustCaseSummary | undefined {
      return byId.get(trustCaseId);
    },
    defaultForProgram(programId: string): TrustCaseSummary | undefined {
      return summaries.find(
        (summary) => summary.programId === programId && summary.defaultForProgram,
      );
    },
  };
}
