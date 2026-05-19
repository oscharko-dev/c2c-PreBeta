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
  const telemetryOptions = { telemetryTrigger: "toolbar" } as const;

  it("parses diagnostics from `{ diagnostics: [...] }`", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return makeResponse(200, {
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
      });
    }) as unknown as FetchFn;
    const result = await compileCheck(
      { content: "x" },
      { fetchImpl, ...telemetryOptions },
    );
    expect(result.ok).toBe(true);
    expect(capturedInit).toMatchObject({ credentials: "include" });
    expect(capturedBody).toEqual({
      javaFiles: [{ path: "Main.java", content: "x" }],
      entryFilePath: "Main.java",
    });
    if (result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.message).toBe("missing semicolon");
      expect(result.diagnostics[0]?.sourceKind).toBe("build");
    }
  });

  it("wraps the current file path and run id in the BFF compile-check shape", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return makeResponse(200, { diagnostics: [] });
    }) as unknown as FetchFn;

    await compileCheck(
      { content: "class Foo {}", filePath: "src/Foo.java", runId: "run-1" },
      { fetchImpl, ...telemetryOptions },
    );

    expect(capturedBody).toEqual({
      runId: "run-1",
      javaFiles: [{ path: "src/Foo.java", content: "class Foo {}" }],
      entryFilePath: "src/Foo.java",
    });
  });

  it("accepts a bare array body and defaults sourceKind to build", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, [
        { severity: "warning", code: "lint", message: "unused" },
      ]),
    ) as unknown as FetchFn;
    const result = await compileCheck(
      { content: "x" },
      { fetchImpl, ...telemetryOptions },
    );
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
    const result = await compileCheck(
      { content: "x" },
      { fetchImpl, ...telemetryOptions },
    );
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
    const result = await compileCheck(
      { content: "x" },
      { fetchImpl, ...telemetryOptions },
    );
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
    const result = await compileCheck(
      { content: "x" },
      { fetchImpl, ...telemetryOptions },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("compile_check_unavailable");
    }
  });

  it("keeps the timeout active while reading the response body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return {
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      } as unknown as Response;
    }) as unknown as FetchFn;

    const result = await compileCheck(
      { content: "class A{}" },
      { fetchImpl, timeoutMs: 10, ...telemetryOptions },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("compile_check_unavailable");
      expect(result.message).toMatch(/exceeded 10 ms/);
    }
  });

  it("returns compile_check_upstream_error on malformed JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          async text() {
            return "not-json";
          },
        }) as unknown as Response,
    ) as unknown as FetchFn;

    const result = await compileCheck(
      { content: "x" },
      { fetchImpl, ...telemetryOptions },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("compile_check_upstream_error");
      expect(result.status).toBe(200);
    }
  });

  it("emits an empty success when the body has no diagnostics field", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, { schemaVersion: "v0" }),
    ) as unknown as FetchFn;
    const result = await compileCheck(
      { content: "x" },
      { fetchImpl, ...telemetryOptions },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics).toEqual([]);
    }
  });
});
