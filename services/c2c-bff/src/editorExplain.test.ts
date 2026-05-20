// Studio-IDE-10 (#249): unit coverage for the editor-assist channel
// module. Tests target the pure functions (validation, budget store,
// gateway response normalisation, ledger entry builder) so the
// server-level integration tests can focus on route wiring.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  DEFAULT_EDITOR_ASSIST_BUDGET,
  EDITOR_ASSIST_BUDGET_MAX,
  EDITOR_ASSIST_BUDGET_MIN,
  EDITOR_ASSIST_DEFAULT_TENANT_DAILY_CAP,
  EDITOR_ASSIST_REDACTED_BYTES_MAX,
  EDITOR_ASSIST_SCHEMA_VERSION,
  UNLIMITED_AI_BUDGET,
  buildEditorAssistRef,
  buildLedgerEntry,
  buildLocalLedgerRef,
  clampEditorAssistBudget,
  createEditorAssistBudgetStore,
  extractLedgerRef,
  isEditorAssistErrorCode,
  mapGatewayResponse,
  normaliseGatewayRedactedFields,
  statusForErrorCode,
  validateExplainRequest,
  type EditorAssistBudgetStore,
  type EditorExplainErrorCode,
} from "./editorExplain";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function validRequest(overrides: Record<string, unknown> = {}): unknown {
  const bytes = "MOVE WS-A TO WS-B.";
  return {
    schemaVersion: "v0",
    sessionId: "studio-session-1",
    tenantId: "tenant-a",
    userId: "user-a",
    runId: null,
    sourceHash: "a".repeat(64),
    region: {
      filePath: "src/cobol/HELLO.cbl",
      sourceKind: "cobol",
      startLine: 12,
      endLine: 18,
    },
    redactedBytes: bytes,
    byteHash: sha256Hex(bytes),
    studioRedactionMetadata: {
      studioRedactionProfileVersion: "v1.0.0",
      matchedPatternIds: ["ssn-us"],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

test("module exposes the enterprise default editor-assist budget posture", () => {
  assert.equal(EDITOR_ASSIST_BUDGET_MIN, 1);
  assert.equal(EDITOR_ASSIST_BUDGET_MAX, UNLIMITED_AI_BUDGET);
  assert.equal(DEFAULT_EDITOR_ASSIST_BUDGET, UNLIMITED_AI_BUDGET);
  assert.equal(EDITOR_ASSIST_DEFAULT_TENANT_DAILY_CAP, UNLIMITED_AI_BUDGET);
  assert.equal(EDITOR_ASSIST_SCHEMA_VERSION, "v0");
});

test("clampEditorAssistBudget preserves the unlimited default while rejecting non-positive values", () => {
  assert.equal(clampEditorAssistBudget(0), EDITOR_ASSIST_BUDGET_MIN);
  assert.equal(clampEditorAssistBudget(-7), EDITOR_ASSIST_BUDGET_MIN);
  assert.equal(clampEditorAssistBudget(1), 1);
  assert.equal(clampEditorAssistBudget(3), 3);
  assert.equal(clampEditorAssistBudget(10), 10);
  assert.equal(clampEditorAssistBudget(99), 99);
  assert.equal(
    clampEditorAssistBudget(UNLIMITED_AI_BUDGET + 99),
    EDITOR_ASSIST_BUDGET_MAX,
  );
});

test("statusForErrorCode maps each closed-set code to its HTTP status", () => {
  assert.equal(statusForErrorCode("budget_exhausted"), 429);
  assert.equal(statusForErrorCode("policy_denied"), 403);
  assert.equal(statusForErrorCode("gateway_unavailable"), 503);
  assert.equal(statusForErrorCode("timeout"), 504);
  assert.equal(statusForErrorCode("invalid_region"), 400);
});

test("isEditorAssistErrorCode accepts only the closed enum", () => {
  for (const code of [
    "budget_exhausted",
    "policy_denied",
    "gateway_unavailable",
    "timeout",
    "invalid_region",
  ] as EditorExplainErrorCode[]) {
    assert.equal(isEditorAssistErrorCode(code), true);
  }
  assert.equal(isEditorAssistErrorCode("something_else"), false);
  assert.equal(isEditorAssistErrorCode(""), false);
  assert.equal(isEditorAssistErrorCode(undefined as unknown as string), false);
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test("validateExplainRequest accepts a well-formed payload", () => {
  const result = validateExplainRequest(validRequest());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.sessionId, "studio-session-1");
  assert.equal(result.value.tenantId, "tenant-a");
  assert.equal(result.value.userId, "user-a");
  assert.equal(result.value.region.sourceKind, "cobol");
  assert.equal(
    result.value.studioRedactionMetadata.matchedPatternIds[0],
    "ssn-us",
  );
});

test("validateExplainRequest defaults tenantId and userId when omitted", () => {
  const payload = validRequest();
  delete (payload as Record<string, unknown>).tenantId;
  delete (payload as Record<string, unknown>).userId;
  const result = validateExplainRequest(payload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.tenantId, "default");
  assert.equal(result.value.userId, "local");
});

test("validateExplainRequest rejects blank or null identity echoes when provided", () => {
  for (const override of [
    { tenantId: "" },
    { tenantId: null },
    { userId: "" },
    { userId: null },
  ]) {
    const result = validateExplainRequest(validRequest(override));
    assert.equal(result.ok, false, `expected ${JSON.stringify(override)}`);
    if (!result.ok) {
      assert.equal(result.errorCode, "invalid_region");
      assert.match(result.message, /tenantId|userId/);
    }
  }
});

test("validateExplainRequest rejects unsupported fields in closed objects", () => {
  const topLevel = validateExplainRequest(
    validRequest({ extraTopLevel: true }),
  );
  assert.equal(topLevel.ok, false);
  if (!topLevel.ok) {
    assert.match(topLevel.message, /unsupported field extraTopLevel/);
  }

  const nestedRegion = validRequest();
  (nestedRegion as { region: Record<string, unknown> }).region.extra = true;
  const regionResult = validateExplainRequest(nestedRegion);
  assert.equal(regionResult.ok, false);
  if (!regionResult.ok) {
    assert.match(regionResult.message, /region.*unsupported field extra/);
  }

  const nestedMeta = validRequest();
  (
    nestedMeta as { studioRedactionMetadata: Record<string, unknown> }
  ).studioRedactionMetadata.extra = true;
  const metaResult = validateExplainRequest(nestedMeta);
  assert.equal(metaResult.ok, false);
  if (!metaResult.ok) {
    assert.match(
      metaResult.message,
      /studioRedactionMetadata.*unsupported field extra/,
    );
  }
});

test("validateExplainRequest rejects non-object body", () => {
  const result = validateExplainRequest("not an object");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, "invalid_region");
});

test("validateExplainRequest rejects empty sessionId", () => {
  const result = validateExplainRequest(validRequest({ sessionId: "" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, "invalid_region");
  assert.match(result.message, /sessionId/);
});

test("validateExplainRequest rejects missing region", () => {
  const payload = validRequest();
  delete (payload as Record<string, unknown>).region;
  const result = validateExplainRequest(payload);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, "invalid_region");
});

test("validateExplainRequest rejects region.sourceKind outside cobol|java", () => {
  const payload = validRequest();
  (payload as { region: Record<string, unknown> }).region.sourceKind = "python";
  const result = validateExplainRequest(payload);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, "invalid_region");
});

test("validateExplainRequest rejects absolute or parent-traversing filePath", () => {
  for (const filePath of [
    "/Users/alice/payroll/SECRET.cbl",
    "C:/Users/alice/payroll/SECRET.cbl",
    "../outside.cbl",
    "src/../outside.cbl",
  ]) {
    const payload = validRequest({
      region: {
        filePath,
        sourceKind: "cobol",
        startLine: 1,
        endLine: 1,
      },
    });
    const result = validateExplainRequest(payload);
    assert.equal(result.ok, false, `expected ${filePath} to be rejected`);
    if (!result.ok) {
      assert.equal(result.errorCode, "invalid_region");
      assert.match(result.message, /workspace-relative/);
    }
  }
});

test("validateExplainRequest accepts filePath dots inside a safe segment", () => {
  const result = validateExplainRequest(
    validRequest({
      region: {
        filePath: "src/copybooks/v1..2/HELLO.cbl",
        sourceKind: "cobol",
        startLine: 1,
        endLine: 1,
      },
    }),
  );
  assert.equal(result.ok, true);
});

test("validateExplainRequest rejects startLine < 1 or endLine < startLine", () => {
  const tooLow = validRequest();
  (tooLow as { region: Record<string, unknown> }).region.startLine = 0;
  let result = validateExplainRequest(tooLow);
  assert.equal(result.ok, false);

  const inverted = validRequest();
  (inverted as { region: Record<string, unknown> }).region.startLine = 50;
  (inverted as { region: Record<string, unknown> }).region.endLine = 10;
  result = validateExplainRequest(inverted);
  assert.equal(result.ok, false);
});

test("validateExplainRequest rejects empty redactedBytes", () => {
  const result = validateExplainRequest(
    validRequest({ redactedBytes: "", byteHash: sha256Hex("") }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, "invalid_region");
});

test("validateExplainRequest rejects redactedBytes larger than the cap", () => {
  const big = "A".repeat(EDITOR_ASSIST_REDACTED_BYTES_MAX + 1);
  const result = validateExplainRequest(
    validRequest({ redactedBytes: big, byteHash: sha256Hex(big) }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, "invalid_region");
  assert.match(result.message, /too large|exceeds|cap/i);
});

test("validateExplainRequest rejects mismatched byteHash with invalid_region", () => {
  const result = validateExplainRequest(
    validRequest({ byteHash: "f".repeat(64) }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, "invalid_region");
  assert.match(result.message, /byteHash mismatch/);
});

test("validateExplainRequest rejects non-hex byteHash", () => {
  const result = validateExplainRequest(validRequest({ byteHash: "not-hex" }));
  assert.equal(result.ok, false);
});

test("validateExplainRequest rejects missing or malformed studioRedactionMetadata", () => {
  const noMeta = validRequest();
  delete (noMeta as Record<string, unknown>).studioRedactionMetadata;
  assert.equal(validateExplainRequest(noMeta).ok, false);

  const badPatterns = validRequest({
    studioRedactionMetadata: {
      studioRedactionProfileVersion: "v1.0.0",
      matchedPatternIds: [1, 2, 3],
    },
  });
  assert.equal(validateExplainRequest(badPatterns).ok, false);

  const rawPatternValue = validRequest({
    studioRedactionMetadata: {
      studioRedactionProfileVersion: "v1.0.0",
      matchedPatternIds: ["field-name-class:email", "alice@example.invalid"],
    },
  });
  assert.equal(validateExplainRequest(rawPatternValue).ok, false);
});

// ---------------------------------------------------------------------------
// Budget store
// ---------------------------------------------------------------------------

interface MutableClock {
  now: number;
  iso: () => string;
}

function makeClock(initialIso: string): MutableClock {
  const t = Date.parse(initialIso);
  const m: MutableClock = {
    now: t,
    iso: () => new Date(m.now).toISOString(),
  };
  return m;
}

test("budget store returns the default snapshot for an unseen session", () => {
  const store = createEditorAssistBudgetStore();
  const snap = store.snapshot({
    tenantId: "t",
    userId: "u",
    sessionId: "s",
  });
  assert.deepEqual(snap, {
    limit: DEFAULT_EDITOR_ASSIST_BUDGET,
    used: 0,
    remaining: DEFAULT_EDITOR_ASSIST_BUDGET,
  });
});

test("budget store consume decrements remaining and returns the new snapshot", async () => {
  const store = createEditorAssistBudgetStore();
  const scope = { tenantId: "t", userId: "u", sessionId: "s" };
  const first = await store.consume(scope);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.snapshot, {
    limit: DEFAULT_EDITOR_ASSIST_BUDGET,
    used: 1,
    remaining: DEFAULT_EDITOR_ASSIST_BUDGET - 1,
  });

  const second = await store.consume(scope);
  if (!second.ok) return;
  assert.deepEqual(second.snapshot, {
    limit: DEFAULT_EDITOR_ASSIST_BUDGET,
    used: 2,
    remaining: DEFAULT_EDITOR_ASSIST_BUDGET - 2,
  });
});

test("budget store reports budget_exhausted with snapshot when session is empty", async () => {
  const store = createEditorAssistBudgetStore({ defaultLimit: 1 });
  const scope = { tenantId: "t", userId: "u", sessionId: "s" };
  const first = await store.consume(scope);
  assert.equal(first.ok, true);
  const second = await store.consume(scope);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.errorCode, "budget_exhausted");
  assert.deepEqual(second.snapshot, { limit: 1, used: 1, remaining: 0 });
});

test("budget store serialises concurrent consumes per session (atomic decrement)", async () => {
  const store = createEditorAssistBudgetStore({ defaultLimit: 1 });
  const scope = { tenantId: "t", userId: "u", sessionId: "s" };
  const [a, b] = await Promise.all([
    store.consume(scope),
    store.consume(scope),
  ]);
  const okCount = [a, b].filter((r) => r.ok).length;
  const exhaustedCount = [a, b].filter(
    (r) => !r.ok && r.errorCode === "budget_exhausted",
  ).length;
  assert.equal(okCount, 1);
  assert.equal(exhaustedCount, 1);
});

test("budget store enforces per-(tenant, day) ceiling across sessions", async () => {
  const clock = makeClock("2026-05-18T00:00:00Z");
  const store = createEditorAssistBudgetStore({
    defaultLimit: 10,
    tenantDailyCap: 2,
    now: () => new Date(clock.now),
  });
  const r1 = await store.consume({
    tenantId: "t",
    userId: "u1",
    sessionId: "s1",
  });
  const r2 = await store.consume({
    tenantId: "t",
    userId: "u2",
    sessionId: "s2",
  });
  // Fresh session, fresh user, same tenant — still capped.
  const r3 = await store.consume({
    tenantId: "t",
    userId: "u3",
    sessionId: "s3",
  });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, false);
  if (r3.ok) return;
  assert.equal(r3.errorCode, "budget_exhausted");
});

test("budget store serialises concurrent per-tenant daily cap across sessions", async () => {
  const store = createEditorAssistBudgetStore({
    defaultLimit: 10,
    tenantDailyCap: 2,
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.consume({
        tenantId: "t",
        userId: `u-${index}`,
        sessionId: `s-${index}`,
      }),
    ),
  );
  assert.equal(
    results.filter((result) => result.ok).length,
    2,
    "tenant daily cap must allow exactly two successful consumes",
  );
  assert.equal(
    results.filter(
      (result) => !result.ok && result.errorCode === "budget_exhausted",
    ).length,
    6,
    "all requests after the cap must be rejected",
  );
});

test("budget store resets the per-tenant-per-day counter on UTC day rollover", async () => {
  const clock = makeClock("2026-05-18T23:59:00Z");
  const store = createEditorAssistBudgetStore({
    defaultLimit: 10,
    tenantDailyCap: 1,
    now: () => new Date(clock.now),
  });
  const today = await store.consume({
    tenantId: "t",
    userId: "u",
    sessionId: "s",
  });
  assert.equal(today.ok, true);
  // Roll to the next UTC day.
  clock.now += 60 * 60 * 1000; // +1h crosses midnight UTC
  const tomorrow = await store.consume({
    tenantId: "t",
    userId: "u",
    sessionId: "s2",
  });
  assert.equal(tomorrow.ok, true);
});

test("budget store isolates by (tenantId, userId, sessionId) tuple", async () => {
  const store = createEditorAssistBudgetStore({ defaultLimit: 1 });
  const a = await store.consume({
    tenantId: "t",
    userId: "u",
    sessionId: "sA",
  });
  const b = await store.consume({
    tenantId: "t",
    userId: "u",
    sessionId: "sB",
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test("budget store snapshot does not consume", () => {
  const store = createEditorAssistBudgetStore();
  const scope = { tenantId: "t", userId: "u", sessionId: "s" };
  store.snapshot(scope);
  store.snapshot(scope);
  const sentinel = store.snapshot(scope);
  assert.equal(sentinel.used, 0);
});

// ---------------------------------------------------------------------------
// Reference builders
// ---------------------------------------------------------------------------

test("buildEditorAssistRef has the eai- prefix and includes the seq", () => {
  const ref = buildEditorAssistRef({
    tenantId: "tenant-1",
    sessionId: "session-1",
    seq: 4,
  });
  assert.equal(ref, "eai-tenant-1-session-1-4");
});

test("buildLocalLedgerRef returns the documented durable URN shape", () => {
  const ref = buildLocalLedgerRef({
    tenantId: "tenant-1",
    sessionId: "session-1",
    seq: 7,
  });
  assert.equal(ref, "urn:c2c/editor-assist/tenant-1/session-1/7");
});

test("extractLedgerRef returns the gateway value when present and non-empty", () => {
  assert.equal(
    extractLedgerRef({ ledgerRef: "urn:ledger/explain/abc" }),
    "urn:ledger/explain/abc",
  );
  assert.equal(extractLedgerRef({ ledgerRef: "" }), null);
  assert.equal(
    extractLedgerRef({ ledgerRef: "https://internal.example/run?token=x" }),
    null,
  );
  assert.equal(
    extractLedgerRef({
      ledgerRef: { uri: "urn:model-gateway/editor-assist/abc-123" },
    }),
    "urn:model-gateway/editor-assist/abc-123",
  );
  assert.equal(
    extractLedgerRef({
      ledgerRef: { uri: "urn:model-gateway/editor-assist/alice@example.com" },
    }),
    null,
  );
  assert.equal(
    extractLedgerRef({ ledgerRef: "urn:https://internal.example/run" }),
    null,
  );
  assert.equal(extractLedgerRef({}), null);
  assert.equal(extractLedgerRef(null), null);
  assert.equal(extractLedgerRef("not an object"), null);
});

// ---------------------------------------------------------------------------
// Gateway redacted-fields normalisation
// ---------------------------------------------------------------------------

test("normaliseGatewayRedactedFields takes the union of studio + gateway", () => {
  const result = normaliseGatewayRedactedFields({
    studioMatchedPatternIds: ["ssn-us", "iban-eu"],
    gatewayRedactedFields: ["customerName", "iban-eu"],
  });
  assert.deepEqual(result.sort(), ["customerName", "iban-eu", "ssn-us"].sort());
});

test("normaliseGatewayRedactedFields tolerates missing gateway field", () => {
  assert.deepEqual(
    normaliseGatewayRedactedFields({
      studioMatchedPatternIds: ["ssn-us"],
      gatewayRedactedFields: undefined,
    }),
    ["ssn-us"],
  );
});

test("normaliseGatewayRedactedFields drops non-string gateway entries", () => {
  const result = normaliseGatewayRedactedFields({
    studioMatchedPatternIds: ["ssn-us"],
    gatewayRedactedFields: [
      1,
      "iban-eu",
      null,
      "ssn-us",
    ] as unknown as string[],
  });
  assert.deepEqual(result.sort(), ["iban-eu", "ssn-us"].sort());
});

test("normaliseGatewayRedactedFields drops unsafe gateway entries", () => {
  const result = normaliseGatewayRedactedFields({
    studioMatchedPatternIds: ["field-name-class:email", "ssn-us"],
    gatewayRedactedFields: [
      "customerName",
      "internal.example",
      "alice@example.invalid",
      "https://internal.example/redaction/1",
    ],
  });
  assert.deepEqual(
    result.sort(),
    ["customerName", "field-name-class:email", "ssn-us"].sort(),
  );
});

// ---------------------------------------------------------------------------
// Gateway response mapping
// ---------------------------------------------------------------------------

test("mapGatewayResponse(undefined) maps to gateway_unavailable", () => {
  const result = mapGatewayResponse(undefined);
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.errorCode, "gateway_unavailable");
});

test("mapGatewayResponse maps 2xx with explanation to ok", () => {
  const result = mapGatewayResponse({
    status: 200,
    body: {
      explanation: "MOVE moves bytes from A to B",
      invocationId: "mi-1",
      ledgerRef: "urn:ledger/x",
      redactedFields: ["customerName"],
    },
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.explanation, "MOVE moves bytes from A to B");
  assert.equal(result.gatewayLedgerRef, "urn:ledger/x");
  assert.deepEqual(result.gatewayRedactedFields, ["customerName"]);
});

test("mapGatewayResponse drops unsafe gateway metadata", () => {
  const result = mapGatewayResponse({
    status: 200,
    body: {
      explanation: "MOVE moves bytes from A to B",
      invocationId: "https://internal.example/inv/123",
      ledgerRef: "urn:https://internal.example/run?token=opaque",
      redactedFields: [
        "field-name-class:email",
        "internal.example",
        "alice@example.invalid",
      ],
    },
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.invocationId, null);
  assert.equal(result.gatewayLedgerRef, null);
  assert.deepEqual(result.gatewayRedactedFields, ["field-name-class:email"]);
});

test("mapGatewayResponse maps 2xx without explanation to gateway_unavailable", () => {
  const result = mapGatewayResponse({ status: 200, body: { ok: true } });
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.errorCode, "gateway_unavailable");
});

test("mapGatewayResponse maps 403 to policy_denied", () => {
  const result = mapGatewayResponse({
    status: 403,
    body: { error: "policy denied", failureCode: "policy_denied" },
  });
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.errorCode, "policy_denied");
});

test("mapGatewayResponse maps 5xx (including 503) to gateway_unavailable", () => {
  for (const status of [500, 502, 503]) {
    const result = mapGatewayResponse({
      status,
      body: { error: "bad upstream" },
    });
    assert.equal(result.kind, "error");
    if (result.kind !== "error") continue;
    assert.equal(result.errorCode, "gateway_unavailable");
  }
});

test("mapGatewayResponse maps 504 to timeout", () => {
  const result = mapGatewayResponse({ status: 504, body: { error: "slow" } });
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.errorCode, "timeout");
});

test("mapGatewayResponse never echoes upstream text into the user message", () => {
  const upstreamLeak =
    "Traceback (most recent call last):\n  File 'foo.py', line 1\nAPI key sk-deadbeefdeadbeefdeadbeef";
  const result = mapGatewayResponse({
    status: 500,
    body: { error: upstreamLeak },
  });
  if (result.kind !== "error") return;
  assert.doesNotMatch(result.message, /Traceback/);
  assert.doesNotMatch(result.message, /sk-deadbeefdeadbeefdeadbeef/);
});

// ---------------------------------------------------------------------------
// Ledger entry builder
// ---------------------------------------------------------------------------

test("buildLedgerEntry produces the ADR-0004 shape on success", () => {
  const entry = buildLedgerEntry({
    schemaVersion: "v0",
    tenantId: "t",
    userId: "u",
    sessionId: "s",
    region: {
      filePath: "src/cobol/HELLO.cbl",
      sourceKind: "cobol",
      startLine: 12,
      endLine: 18,
    },
    byteHash: "a".repeat(64),
    redactionApplied: ["ssn-us", "customerName"],
    editorAssistRef: "eai-t-s-1",
    ledgerRef: "urn:ledger/explain/x",
    invocationId: "mi-1",
    budgetSnapshot: { limit: 3, used: 1, remaining: 2 },
    startedAt: "2026-05-18T00:00:00.000Z",
    endedAt: "2026-05-18T00:00:01.000Z",
    status: "success",
    failureCode: null,
    runIdRef: null,
  });
  assert.equal(entry.kind, "editor_assist");
  assert.equal(entry.requestSource, "editor");
  assert.equal(entry.schemaVersion, "v0");
  assert.equal(entry.status, "success");
  assert.equal(entry.failureCode, null);
  assert.equal(entry.ledgerEntryId, "eai-t-s-1");
  assert.equal(entry.tenantId, "t");
  assert.equal(entry.requestRegion.sourceKind, "cobol");
  assert.equal(entry.requestRegion.byteHash, `sha256:${"a".repeat(64)}`);
  assert.deepEqual(entry.redactedFields, ["ssn-us", "customerName"]);
});

test("buildLedgerEntry carries the failureCode on failure", () => {
  const entry = buildLedgerEntry({
    schemaVersion: "v0",
    tenantId: "t",
    userId: "u",
    sessionId: "s",
    region: {
      filePath: "X.cbl",
      sourceKind: "cobol",
      startLine: 1,
      endLine: 1,
    },
    byteHash: "f".repeat(64),
    redactionApplied: [],
    editorAssistRef: "eai-t-s-2",
    ledgerRef: "urn:c2c/editor-assist/t/s/2",
    invocationId: null,
    budgetSnapshot: { limit: 3, used: 1, remaining: 2 },
    startedAt: "2026-05-18T00:00:00.000Z",
    endedAt: "2026-05-18T00:00:01.000Z",
    status: "failed",
    failureCode: "gateway_unavailable",
    runIdRef: null,
  });
  assert.equal(entry.status, "failed");
  assert.equal(entry.failureCode, "gateway_unavailable");
  assert.equal(entry.invocationId, null);
});

// ---------------------------------------------------------------------------
// Module integration: the store + helpers compose without leaking types
// ---------------------------------------------------------------------------

test("EditorAssistBudgetStore exposes the documented method set", () => {
  const store: EditorAssistBudgetStore = createEditorAssistBudgetStore();
  assert.equal(typeof store.snapshot, "function");
  assert.equal(typeof store.consume, "function");
  assert.equal(typeof store.refund, "function");
});

test("budget store refund returns budget when called after a consume", async () => {
  const store = createEditorAssistBudgetStore({ defaultLimit: 1 });
  const scope = { tenantId: "t", userId: "u", sessionId: "s" };
  const consumed = await store.consume(scope);
  assert.equal(consumed.ok, true);
  store.refund(scope);
  // Refund should restore the unit so a follow-up consume succeeds again.
  const second = await store.consume(scope);
  assert.equal(second.ok, true);
});
