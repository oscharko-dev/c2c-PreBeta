import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDiagnostics, DIAGNOSTIC_SCHEMA_VERSION } from "./diagnostics";

test("normalizeDiagnostics drops non-array inputs without throwing", () => {
  assert.deepEqual(normalizeDiagnostics(null), []);
  assert.deepEqual(normalizeDiagnostics(undefined), []);
  assert.deepEqual(normalizeDiagnostics("error string"), []);
  assert.deepEqual(normalizeDiagnostics({}), []);
});

test("normalizeDiagnostics preserves line, column, endLine, endColumn", () => {
  const result = normalizeDiagnostics([
    {
      severity: "error",
      code: "PARSE-ERR",
      message: "unexpected token",
      line: 7,
      column: 12,
      endLine: 7,
      endColumn: 24,
      filePath: "corpus/BRNCH01.cbl",
      sourceKind: "cobol",
      originStep: "parse-cobol",
    },
  ]);
  assert.equal(result.length, 1);
  const [diagnostic] = result;
  assert.equal(diagnostic.schemaVersion, DIAGNOSTIC_SCHEMA_VERSION);
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.code, "PARSE-ERR");
  assert.equal(diagnostic.message, "unexpected token");
  assert.equal(diagnostic.line, 7);
  assert.equal(diagnostic.column, 12);
  assert.equal(diagnostic.endLine, 7);
  assert.equal(diagnostic.endColumn, 24);
  assert.equal(diagnostic.filePath, "corpus/BRNCH01.cbl");
  assert.equal(diagnostic.sourceKind, "cobol");
  assert.equal(diagnostic.originStep, "parse-cobol");
});

test("normalizeDiagnostics maps level synonyms to canonical severity enum", () => {
  const result = normalizeDiagnostics([
    { level: "WARN", code: "L1", message: "warn-aliased" },
    { level: "Information", code: "L2", message: "info-aliased" },
    { level: "FATAL", code: "L3", message: "fatal-as-error" },
    { level: "note", code: "L4", message: "note-as-hint" },
    { level: "weird-thing", code: "L5", message: "unknown-falls-to-info" },
  ]);
  assert.equal(result.length, 5);
  assert.equal(result[0]?.severity, "warning");
  assert.equal(result[1]?.severity, "info");
  assert.equal(result[2]?.severity, "error");
  assert.equal(result[3]?.severity, "hint");
  assert.equal(result[4]?.severity, "info");
});

test("normalizeDiagnostics accepts severity directly when level is absent", () => {
  const result = normalizeDiagnostics([
    { severity: "error", code: "S", message: "direct severity" },
  ]);
  assert.equal(result[0]?.severity, "error");
});

test("normalizeDiagnostics emits schemaVersion v0 on every record", () => {
  const result = normalizeDiagnostics([
    { severity: "info", code: "A", message: "first" },
    { severity: "warn", code: "B", message: "second" },
  ]);
  assert.equal(result.length, 2);
  for (const diagnostic of result) {
    assert.equal(diagnostic.schemaVersion, "v0");
  }
});

test("normalizeDiagnostics drops entries without a message", () => {
  const result = normalizeDiagnostics([
    { severity: "error", code: "X", message: "kept" },
    { severity: "error", code: "X" },
    { severity: "error", code: "X", message: "" },
    { severity: "error", code: "X", message: null },
    "not-an-object",
    null,
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.message, "kept");
});

test("normalizeDiagnostics rejects non-positive line/column values", () => {
  const result = normalizeDiagnostics([
    {
      severity: "error",
      code: "X",
      message: "negative line",
      line: -1,
      column: 0,
    },
    {
      severity: "error",
      code: "X",
      message: "non-integer line",
      line: 1.5,
    },
    {
      severity: "error",
      code: "X",
      message: "string line",
      line: "12",
    },
  ]);
  assert.equal(result.length, 3);
  for (const diagnostic of result) {
    assert.equal(diagnostic.line, undefined);
    assert.equal(diagnostic.column, undefined);
  }
});

test("normalizeDiagnostics drops endLine when it precedes line", () => {
  const result = normalizeDiagnostics([
    {
      severity: "error",
      code: "X",
      message: "contradictory range",
      line: 10,
      endLine: 3,
      endColumn: 2,
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.line, 10);
  assert.equal(result[0]?.endLine, undefined);
  assert.equal(result[0]?.endColumn, undefined);
});

test("normalizeDiagnostics drops endColumn when on same line but before column", () => {
  const result = normalizeDiagnostics([
    {
      severity: "error",
      code: "X",
      message: "inverted column",
      line: 10,
      column: 30,
      endLine: 10,
      endColumn: 5,
    },
  ]);
  assert.equal(result[0]?.endColumn, undefined);
  assert.equal(result[0]?.endLine, 10);
});

test("normalizeDiagnostics falls back to legacy 'source' field for filePath", () => {
  const result = normalizeDiagnostics([
    {
      severity: "warning",
      code: "javac-deprecation",
      message: "uses a deprecated API",
      source: "src/main/java/c2c/CASE01.java",
    },
  ]);
  assert.equal(result[0]?.filePath, "src/main/java/c2c/CASE01.java");
});

test("normalizeDiagnostics prefers filePath when both filePath and source are set", () => {
  const result = normalizeDiagnostics([
    {
      severity: "warning",
      code: "X",
      message: "both fields",
      filePath: "preferred.cbl",
      source: "legacy.cbl",
    },
  ]);
  assert.equal(result[0]?.filePath, "preferred.cbl");
});

test("normalizeDiagnostics accepts known sourceKind values and tolerates dashed variants", () => {
  const result = normalizeDiagnostics([
    { severity: "info", code: "A", message: "a", sourceKind: "cobol" },
    {
      severity: "info",
      code: "B",
      message: "b",
      sourceKind: "generated-java",
    },
    {
      severity: "info",
      code: "C",
      message: "c",
      sourceKind: "unknown-thing",
    },
  ]);
  assert.equal(result[0]?.sourceKind, "cobol");
  assert.equal(result[1]?.sourceKind, "generated_java");
  assert.equal(result[2]?.sourceKind, undefined);
});

test("normalizeDiagnostics normalizes artifactRef when sha256 is present", () => {
  const result = normalizeDiagnostics([
    {
      severity: "info",
      code: "A",
      message: "with artifact ref",
      artifactRef: {
        sha256: "a".repeat(64),
        byteSize: 128,
        kind: "semantic-ir-node",
        path: "ir/node/42.json",
      },
    },
    {
      severity: "info",
      code: "B",
      message: "missing sha",
      artifactRef: { byteSize: 256 },
    },
    {
      severity: "info",
      code: "C",
      message: "no ref",
    },
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0]?.artifactRef?.sha256, "a".repeat(64));
  assert.equal(result[0]?.artifactRef?.byteSize, 128);
  assert.equal(result[0]?.artifactRef?.kind, "semantic-ir-node");
  assert.equal(result[0]?.artifactRef?.path, "ir/node/42.json");
  assert.equal(result[1]?.artifactRef, undefined);
  assert.equal(result[2]?.artifactRef, undefined);
});

test("normalizeDiagnostics covers each upstream source: parser/IR/generator/build/test", () => {
  // Parser-style diagnostic — severity, line, code, message.
  const parser = normalizeDiagnostics([
    {
      severity: "error",
      code: "COBOL-PARSE",
      message: "syntax error",
      line: 12,
      filePath: "corpus/BRNCH01.cbl",
      sourceKind: "cobol",
      originStep: "parse-cobol",
    },
  ])[0];
  assert.equal(parser?.line, 12);
  assert.equal(parser?.severity, "error");

  // IR-style diagnostic — uses sourceLine via the line field.
  const ir = normalizeDiagnostics([
    {
      severity: "warning",
      code: "IR-UNSUPPORTED",
      message: "unsupported construct",
      line: 18,
      sourceKind: "ir",
      originStep: "generate-ir",
    },
  ])[0];
  assert.equal(ir?.sourceKind, "ir");
  assert.equal(ir?.line, 18);

  // Generator-style diagnostic — line + column in generated Java.
  const generator = normalizeDiagnostics([
    {
      severity: "info",
      code: "GEN-NOTE",
      message: "generated case clause",
      line: 24,
      column: 4,
      filePath: "src/main/java/c2c/BRNCH01.java",
      sourceKind: "generated_java",
      originStep: "generate-java",
    },
  ])[0];
  assert.equal(generator?.column, 4);
  assert.equal(generator?.filePath, "src/main/java/c2c/BRNCH01.java");

  // Build-style diagnostic — javac line + column on a generated file.
  const build = normalizeDiagnostics([
    {
      severity: "warning",
      code: "javac-deprecation",
      message: "deprecated API",
      line: 12,
      column: 7,
      source: "src/main/java/c2c/CASE01.java",
      sourceKind: "build",
      originStep: "compile-test-java",
    },
  ])[0];
  assert.equal(build?.sourceKind, "build");
  assert.equal(build?.line, 12);
  assert.equal(build?.column, 7);

  // Test-style diagnostic — surfaces at run time without a file path.
  const tst = normalizeDiagnostics([
    {
      severity: "error",
      code: "RUN-FAIL",
      message: "execution diverged",
      sourceKind: "test",
      originStep: "run-tests",
    },
  ])[0];
  assert.equal(tst?.sourceKind, "test");
  assert.equal(tst?.filePath, undefined);
});

test("normalizeDiagnostics passes large batches without modification", () => {
  const batch = Array.from({ length: 5000 }, (_value, index) => ({
    severity: "warning",
    code: "BULK",
    message: `entry ${index}`,
    line: index + 1,
  }));
  const result = normalizeDiagnostics(batch);
  assert.equal(result.length, batch.length);
  assert.equal(result[0]?.line, 1);
  assert.equal(result[4999]?.line, 5000);
});
