import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AcceptanceFixtureRegistry } from "./acceptance-fixtures";
import { loadTrustCaseCatalog } from "./trust-cases";

const acceptanceFixtures: AcceptanceFixtureRegistry = {
  list() {
    return [
      {
        fixtureId: "HELLOW02",
        title: "HELLOW02",
        description: "HELLOW02 fixture",
        oracleGenerationMode: "static-fixture",
        supportedSubset: ["DISPLAY", "STOP-RUN"],
        unsupportedConstructsCount: 0,
        targetLanguage: "java",
        expectedFinalClassification: "success",
        expectedFailureCode: null,
        modes: ["file-backed", "paste-mode"],
      },
    ];
  },
  get() {
    return undefined;
  },
  fixtures() {
    return [];
  },
};

function baseCatalog(): Record<string, unknown> {
  return {
    schemaVersion: "v0",
    catalogVersion: "2026-05-21",
    trustCases: [
      {
        trustCaseId: "HELLOW02-DEFAULT",
        version: "2026-05-21",
        programId: "HELLOW02",
        title: "HELLOW02 default",
        description: "Default immutable parity trust case.",
        defaultForProgram: true,
        sourceReference: {
          fixtureId: "HELLOW02",
          mode: "reference-fixture",
        },
        controlledInput: {
          stdin: null,
          dataSetIds: [],
          expectedOutputFixtureId: "HELLOW02",
        },
        runtime: {
          programArgs: [],
        },
        environmentProfile: {
          profileId: "generated-java-sandbox-v1",
          description: "Controlled generated Java sandbox.",
          variables: {},
        },
        comparison: {
          strategy: "deterministic-output",
          policyVersion: "deterministic-output-v1",
        },
        supportedProgramShape: {
          language: "cobol",
          programId: "HELLOW02",
          supportedSubset: ["DISPLAY", "STOP-RUN"],
        },
        evidenceIdentity: {
          kind: "trust-case",
          artifactName: "executed-trust-case.json",
        },
      },
    ],
  };
}

function withTempCatalog(payload: Record<string, unknown>): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-trust-cases-"));
  const catalogDir = path.join(repoRoot, "fixtures", "trust-cases");
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.writeFileSync(
    path.join(catalogDir, "index.json"),
    JSON.stringify(payload, null, 2),
    "utf-8",
  );
  return repoRoot;
}

test("trust-case catalog validates and exposes default identity metadata", () => {
  const repoRoot = withTempCatalog(baseCatalog());
  const catalog = loadTrustCaseCatalog(repoRoot, acceptanceFixtures);
  const defaultCase = catalog.defaultForProgram("HELLOW02");

  assert.equal(catalog.schemaVersion, "v0");
  assert.equal(defaultCase?.trustCaseId, "HELLOW02-DEFAULT");
  assert.equal(defaultCase?.version, "2026-05-21");
  assert.equal(defaultCase?.catalogVersion, "2026-05-21");
  assert.match(defaultCase?.catalogHash ?? "", /^[0-9a-f]{64}$/);
  assert.match(defaultCase?.configurationDigest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(defaultCase?.sourceReferenceFixtureId, "HELLOW02");
  assert.equal(defaultCase?.environmentProfileId, "generated-java-sandbox-v1");
  assert.equal(defaultCase?.comparisonPolicyVersion, "deterministic-output-v1");
});

test("trust-case catalog rejects unsafe runtime values", () => {
  const payload = baseCatalog();
  const trustCase = (payload.trustCases as Array<Record<string, unknown>>)[0]!;
  trustCase.runtime = { programArgs: ["../../private"] };
  const repoRoot = withTempCatalog(payload);

  assert.throws(
    () => loadTrustCaseCatalog(repoRoot, acceptanceFixtures),
    /runtime\.programArgs\[0\] has an unsafe value/,
  );
});

test("trust-case catalog requires exactly one default per program", () => {
  const payload = baseCatalog();
  const trustCase = {
    ...((payload.trustCases as Array<Record<string, unknown>>)[0]!),
    trustCaseId: "HELLOW02-ALT",
  };
  (payload.trustCases as Array<Record<string, unknown>>).push(trustCase);
  const repoRoot = withTempCatalog(payload);

  assert.throws(
    () => loadTrustCaseCatalog(repoRoot, acceptanceFixtures),
    /exactly one default trust case/,
  );
});

test("trust-case catalog rejects fixture mismatches", () => {
  const payload = baseCatalog();
  const trustCase = (payload.trustCases as Array<Record<string, unknown>>)[0]!;
  trustCase.sourceReference = {
    fixtureId: "UNKNOWN-FIXTURE",
    mode: "reference-fixture",
  };
  const repoRoot = withTempCatalog(payload);

  assert.throws(
    () => loadTrustCaseCatalog(repoRoot, acceptanceFixtures),
    /is not an acceptance fixture/,
  );
});
