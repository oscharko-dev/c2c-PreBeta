import { describe, expect, it, vi } from "vitest";

import { formatJava } from "./javaFormatClient";

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

describe("formatJava client", () => {
  it("returns the formatted content on success", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, {
        schemaVersion: "v0",
        formattedContent: "public class A {}\n",
      }),
    ) as unknown as FetchFn;
    const result = await formatJava(
      { content: "public class A{}" },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.formattedContent).toBe("public class A {}\n");
    }
  });

  it("forwards filePath in the request body", async () => {
    let captured: unknown = null;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init?.body ? JSON.parse(String(init.body)) : null;
      return makeResponse(200, {
        schemaVersion: "v0",
        formattedContent: "ok",
      });
    }) as unknown as FetchFn;
    await formatJava(
      { content: "class A{}", filePath: "src/A.java" },
      { fetchImpl },
    );
    expect(captured).toEqual({ content: "class A{}", filePath: "src/A.java" });
  });

  it("maps a 422 parse error to format_parse_error with line/column", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(422, {
        schemaVersion: "v0",
        status: "failed",
        code: "format_parse_error",
        error: "missing semicolon",
        line: 7,
        column: 12,
      }),
    ) as unknown as FetchFn;
    const result = await formatJava({ content: "broken" }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("format_parse_error");
      expect(result.line).toBe(7);
      expect(result.column).toBe(12);
      expect(result.status).toBe(422);
      expect(result.message).toBe("missing semicolon");
    }
  });

  it("maps a 503 with format_unavailable to the same code", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(503, {
        schemaVersion: "v0",
        status: "failed",
        code: "format_unavailable",
        error: "service down",
      }),
    ) as unknown as FetchFn;
    const result = await formatJava({ content: "x" }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("format_unavailable");
    }
  });

  it("treats a network throw as format_unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as FetchFn;
    const result = await formatJava({ content: "x" }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("format_unavailable");
      expect(result.message).toContain("ECONNREFUSED");
    }
  });

  it("times out a hung request and returns format_unavailable", async () => {
    let abortedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          abortedSignal = init?.signal as AbortSignal | undefined;
          abortedSignal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    ) as unknown as FetchFn;
    const result = await formatJava(
      { content: "x" },
      { fetchImpl, timeoutMs: 10 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("format_unavailable");
      expect(result.message).toMatch(/exceeded 10 ms/);
    }
  });

  it("handles a malformed upstream JSON body", async () => {
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
    const result = await formatJava({ content: "x" }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("format_upstream_error");
    }
  });

  it("handles a 200 with missing formattedContent", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, { schemaVersion: "v0" }),
    ) as unknown as FetchFn;
    const result = await formatJava({ content: "x" }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("format_upstream_error");
    }
  });

  it("honours an externally-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      // fetch is supposed to throw immediately when the passed signal
      // is already aborted; emulate that here.
      if ((init?.signal as AbortSignal | undefined)?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return makeResponse(200, { formattedContent: "ok" });
    }) as unknown as FetchFn;
    const result = await formatJava(
      { content: "x" },
      { fetchImpl, signal: controller.signal },
    );
    expect(result.ok).toBe(false);
  });
});
