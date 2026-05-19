import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const contributionLoads = vi.hoisted(() => ({
  java: 0,
  json: 0,
  markdown: 0,
  xml: 0,
}));

vi.mock("monaco-editor/esm/vs/editor/editor.api", () => ({
  editor: {
    create: vi.fn(),
    createModel: vi.fn(),
    getModel: vi.fn(),
    getModels: vi.fn(() => []),
    setModelMarkers: vi.fn(),
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
  },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}));
vi.mock(
  "monaco-editor/esm/vs/basic-languages/java/java.contribution",
  () => {
    contributionLoads.java += 1;
    return {};
  },
);
vi.mock(
  "monaco-editor/esm/vs/basic-languages/xml/xml.contribution",
  () => {
    contributionLoads.xml += 1;
    return {};
  },
);
vi.mock(
  "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution",
  () => {
    contributionLoads.markdown += 1;
    return {};
  },
);
vi.mock("monaco-editor/esm/vs/language/json/monaco.contribution", () => {
  contributionLoads.json += 1;
  return {};
});

describe("lazyMonaco", () => {
  beforeEach(async () => {
    vi.resetModules();
    contributionLoads.java = 0;
    contributionLoads.json = 0;
    contributionLoads.markdown = 0;
    contributionLoads.xml = 0;
    const m = await import("@/lib/editor/lazyMonaco");
    m.__resetMonacoForTests();
  });

  it("getMonaco resolves to the monaco namespace", async () => {
    const { getMonaco } = await import("@/lib/editor/lazyMonaco");
    const monaco = await getMonaco();
    expect(monaco).toBeDefined();
    expect(typeof monaco.editor.defineTheme).toBe("function");
  });

  it("configures MonacoEnvironment with a self-hosted worker factory", async () => {
    const { getMonaco } = await import("@/lib/editor/lazyMonaco");
    await getMonaco();
    const env = (globalThis as { MonacoEnvironment?: { getWorker?: unknown } })
      .MonacoEnvironment;
    expect(env).toBeDefined();
    expect(typeof env?.getWorker).toBe("function");
  });

  it("memoizes subsequent calls (no duplicate work)", async () => {
    const { getMonaco } = await import("@/lib/editor/lazyMonaco");
    const a = await getMonaco();
    const b = await getMonaco();
    expect(a).toBe(b);
  });

  it("useMonacoReady starts empty and updates when the lazy import resolves", async () => {
    const { useMonacoReady } = await import("@/lib/editor/lazyMonaco");
    const { result } = renderHook(() => useMonacoReady());

    expect(result.current).toBeNull();
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(typeof result.current?.editor.defineTheme).toBe("function");
  });

  it("useMonacoReady stays idle while disabled", async () => {
    const { useMonacoReady } = await import("@/lib/editor/lazyMonaco");
    const { result } = renderHook(() => useMonacoReady(false));

    expect(result.current).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBeNull();
    expect(
      (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment,
    ).toBeUndefined();
  });

  it("loads each requested language contribution once", async () => {
    const { getMonaco } = await import("@/lib/editor/lazyMonaco");

    await getMonaco("java");
    await getMonaco("JAVA");

    expect(contributionLoads.java).toBe(1);
  });

  it("normalizes, filters, and de-duplicates multi-language contribution requests", async () => {
    const { getMonaco } = await import("@/lib/editor/lazyMonaco");

    await getMonaco(["xml", "markdown", "xml", "cobol"]);

    expect(contributionLoads).toMatchObject({
      java: 0,
      json: 0,
      markdown: 1,
      xml: 1,
    });
  });

  it("de-duplicates concurrent contribution requests for the same language", async () => {
    const { getMonaco } = await import("@/lib/editor/lazyMonaco");

    await Promise.all([getMonaco("json"), getMonaco("JSON")]);

    expect(contributionLoads.json).toBe(1);
  });
});
