import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_ASSIST_SCHEMA_VERSION,
  type EditorAssistRequest,
} from "@/types/editor-assist";
import {
  getBudget,
  parseEditorAssistError,
  requestExplanation,
} from "./editorAssistClient";

const SUCCESS_BODY = {
  schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
  explanation: "**Adds two numbers** and stores the sum.",
  modelInvocationRef: "mi-abc",
  editorAssistRef: "edit-1",
  ledgerRef: "ledger-9",
  budgetSnapshot: { limit: 3, used: 1, remaining: 2 },
  redactionApplied: ["customer-name"],
};

function makeRequest(): EditorAssistRequest {
  return {
    schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
    sessionId: "studio-session-x",
    tenantId: "default",
    userId: "local",
    runId: null,
    sourceHash: "0".repeat(64),
    region: {
      filePath: "PAYROLL.cbl",
      sourceKind: "cobol",
      startLine: 10,
      endLine: 20,
    },
    redactedBytes: "MOVE 1 TO X.",
    byteHash: "1".repeat(64),
    studioRedactionMetadata: {
      studioRedactionProfileVersion: "v1.0.0",
      matchedPatternIds: [],
    },
  };
}

function stubFetchOnce(response: {
  ok: boolean;
  status?: number;
  body: unknown;
  bodyText?: string;
}) {
  const text = response.bodyText ?? JSON.stringify(response.body);
  const mock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    text: () => Promise.resolve(text),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestExplanation — success path", () => {
  it("returns ok:true with parsed success payload on HTTP 200", async () => {
    stubFetchOnce({ ok: true, body: SUCCESS_BODY });
    const result = await requestExplanation(makeRequest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.explanation).toBe(SUCCESS_BODY.explanation);
      expect(result.data.budgetSnapshot.remaining).toBe(2);
      expect(result.data.editorAssistRef).toBe("edit-1");
    }
  });

  it("posts the request body verbatim as JSON to /api/v0/editor/explain", async () => {
    const mock = stubFetchOnce({ ok: true, body: SUCCESS_BODY });
    const req = makeRequest();
    await requestExplanation(req);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0];
    expect(url).toContain("/api/v0/editor/explain");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
    });
    expect(JSON.parse(init.body)).toEqual(req);
  });
});

describe("requestExplanation — structured error path", () => {
  it("maps budget_exhausted into ok:false with budgetSnapshot", async () => {
    stubFetchOnce({
      ok: false,
      status: 429,
      body: {
        schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
        errorCode: "budget_exhausted",
        message: "No more Explain calls in this session.",
        budgetSnapshot: { limit: 3, used: 3, remaining: 0 },
      },
    });
    const result = await requestExplanation(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("budget_exhausted");
      expect(result.budgetSnapshot).toEqual({
        limit: 3,
        used: 3,
        remaining: 0,
      });
    }
  });

  it.each([
    "policy_denied",
    "gateway_unavailable",
    "timeout",
    "invalid_region",
  ] as const)("maps %s into ok:false", async (code) => {
    stubFetchOnce({
      ok: false,
      status: 400,
      body: {
        schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
        errorCode: code,
        message: `code=${code}`,
        budgetSnapshot: null,
      },
    });
    const result = await requestExplanation(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe(code);
      expect(result.budgetSnapshot).toBeNull();
    }
  });

  it("rejects an unknown errorCode as gateway_unavailable", async () => {
    stubFetchOnce({
      ok: false,
      status: 500,
      body: {
        schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
        errorCode: "alien_code",
        message: "x",
        budgetSnapshot: null,
      },
    });
    const result = await requestExplanation(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("gateway_unavailable");
    }
  });

  it("synthesises gateway_unavailable for malformed JSON", async () => {
    stubFetchOnce({
      ok: false,
      status: 502,
      body: null,
      bodyText: "<html>500</html>",
    });
    const result = await requestExplanation(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("gateway_unavailable");
    }
  });

  it("synthesises gateway_unavailable on network rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );
    const result = await requestExplanation(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("gateway_unavailable");
    }
  });

  it("rejects an HTTP 200 success payload missing required fields", async () => {
    stubFetchOnce({
      ok: true,
      body: { schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION, explanation: "x" },
    });
    const result = await requestExplanation(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("gateway_unavailable");
    }
  });

  it("rejects an HTTP 200 success payload with wrong schemaVersion", async () => {
    stubFetchOnce({
      ok: true,
      body: { ...SUCCESS_BODY, schemaVersion: "v1" },
    });
    const result = await requestExplanation(makeRequest());
    expect(result.ok).toBe(false);
  });
});

describe("parseEditorAssistError helper", () => {
  it("returns a normalised error for an unparseable payload", () => {
    const result = parseEditorAssistError("not json", 502);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("gateway_unavailable");
      expect(result.budgetSnapshot).toBeNull();
    }
  });

  it("returns the structured error when the payload is valid", () => {
    const result = parseEditorAssistError(
      {
        schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
        errorCode: "timeout",
        message: "deadline exceeded",
        budgetSnapshot: { limit: 3, used: 0, remaining: 3 },
      },
      504,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("timeout");
      expect(result.message).toBe("deadline exceeded");
    }
  });
});

describe("getBudget", () => {
  it("returns budget for a valid response", async () => {
    stubFetchOnce({
      ok: true,
      body: {
        schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
        budget: { limit: 3, used: 2, remaining: 1 },
      },
    });
    const result = await getBudget({
      sessionId: "studio-x",
      tenantId: "default",
      userId: "local",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.budget.remaining).toBe(1);
    }
  });

  it("encodes sessionId / tenantId / userId in the query string", async () => {
    const mock = stubFetchOnce({
      ok: true,
      body: {
        schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
        budget: { limit: 3, used: 0, remaining: 3 },
      },
    });
    await getBudget({
      sessionId: "s/x",
      tenantId: "t&t",
      userId: "u+u",
    });
    const [url] = mock.mock.calls[0];
    expect(url).toContain("sessionId=s%2Fx");
    expect(url).toContain("tenantId=t%26t");
    expect(url).toContain("userId=u%2Bu");
  });

  it("returns ok:false on a malformed response", async () => {
    stubFetchOnce({ ok: true, body: { schemaVersion: "v0" } });
    const result = await getBudget({ sessionId: "s" });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false on HTTP error", async () => {
    stubFetchOnce({
      ok: false,
      status: 500,
      body: { error: "boom" },
    });
    const result = await getBudget({ sessionId: "s" });
    expect(result.ok).toBe(false);
  });
});
