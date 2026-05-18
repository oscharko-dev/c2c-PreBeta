import { describe, expect, it, vi } from "vitest";

import { compileCheck } from "./compileCheckClient";

type FetchFn = typeof fetch;

function makeResponse(
  status: number,
  body: unknown,
  init: { ok?: boolean } = {},
): Response {
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  } as unknown as Response;
}

describe("compileCheck client", () => {
  it("parses diagnostics from `{ diagnostics: [...] }`", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, {
        diagnostics: [
          {
            severity: "error",
            code: "javac",
            message: "missing semicolon",
            line: 5,
            column: 4,
            filePath: "src/A.java",
            sourceKind: "build",
          },
        ],
      }),
    ) as unknown as FetchFn;
    const result = await compileCheck({ content: "x" }, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.message).toBe("missing semicolon");
      expect(result.diagnostics[0]?.sourceKind).toBe("build");
    }
  });

  it("accepts a bare array body and defaults sourceKind to build", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, [
        { severity: "warning", code: "lint", message: "unused" },
      ]),
    ) as unknown as FetchFn;
    const result = await compileCheck({ content: "x" }, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.sourceKind).toBe("build");
    }
  });

  it("drops malformed diagnostic entries silently", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, {
        diagnostics: [
          { message: "no severity" },
          { severity: "error", code: "c", message: "valid" },
        ],
      }),
    ) as unknown as FetchFn;
    const result = await compileCheck({ content: "x" }, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.message).toBe("valid");
    }
  });

  it("returns compile_check_unavailable on 404", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(404, { error: "not configured" }, { ok: false }),
    ) as unknown as FetchFn;
    const result = await compileCheck({ content: "x" }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("compile_check_unavailable");
      expect(result.message).toBe("not configured");
    }
  });

  it("treats a network throw as compile_check_unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as FetchFn;
    const result = await compileCheck({ content: "x" }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("compile_check_unavailable");
    }
  });

  it("emits an empty success when the body has no diagnostics field", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, { schemaVersion: "v0" }),
    ) as unknown as FetchFn;
    const result = await compileCheck({ content: "x" }, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics).toEqual([]);
    }
  });
});
