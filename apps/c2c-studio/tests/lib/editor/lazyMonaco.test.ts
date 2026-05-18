import { beforeEach, describe, expect, it, vi } from "vitest";

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
  () => ({}),
);
vi.mock(
  "monaco-editor/esm/vs/basic-languages/xml/xml.contribution",
  () => ({}),
);
vi.mock(
  "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution",
  () => ({}),
);
vi.mock("monaco-editor/esm/vs/language/json/monaco.contribution", () => ({}));

describe("lazyMonaco", () => {
  beforeEach(async () => {
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
});
