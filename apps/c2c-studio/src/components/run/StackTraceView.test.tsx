import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { StackTraceView } from "./StackTraceView";
import { clearTraceCache } from "@/lib/editor/traceParser";
import type { TraceabilityEnvelope } from "@/types/api";

type FetchFn = typeof fetch;

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  } as unknown as Response;
}

function envelope(): TraceabilityEnvelope {
  return {
    schemaVersion: "v0",
    runId: "run-1",
    programId: "PROG1",
    trace: null,
    irSymbolMap: {
      "s-move-a": { cobolFile: "PROG1.cbl", cobolLine: 10 },
      "s-move-b": { cobolFile: "PROG1.cbl", cobolLine: 30 },
    },
    javaRegionClassification: {
      "src/main/java/com/example/Foo.java": [
        {
          schemaVersion: "v0",
          lineRange: { startLine: 1, endLine: 14 },
          originClass: "deterministic",
          verificationOutcome: "oracle_passed",
          mappingClass: "direct",
        },
      ],
      "src/main/java/com/example/Manual.java": [
        {
          schemaVersion: "v0",
          lineRange: { startLine: 1, endLine: 10 },
          originClass: "manual_edit",
          verificationOutcome: "no_oracle",
          mappingClass: "synthesized",
        },
      ],
    },
  };
}

const SAMPLE_JAVA = [
  "package com.example;",
  "public class Foo {",
  "  // move [s-move-a line 10]",
  "  int a = 1;",
  "  // paragraph PARA-MAIN [s-paragraph-main line 22]",
  "  public void bar() {",
  "    // move [s-move-b line 30]",
  "    int b = 2;",
  "  }",
  "}",
].join("\n");

function fetcherFor(env: TraceabilityEnvelope): FetchFn {
  return vi.fn(async () => makeResponse(200, env)) as unknown as FetchFn;
}

const TRACE_WITH_RESOLVABLE_AND_NOT = [
  "java.lang.NullPointerException: boom",
  "  at com.example.Foo.bar(Foo.java:8)",
  "  at com.example.Manual.x(Manual.java:3)",
  "  at sun.reflect.NativeMethodAccessorImpl.invoke0(Native Method)",
  "  at com.example.Missing.y(Missing.java:1)",
].join("\n");

describe("StackTraceView", () => {
  beforeEach(() => {
    clearTraceCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when both raw and runId are empty", () => {
    const { container } = render(<StackTraceView raw="" runId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("falls back to the pre-#253 plain-text rendering when no frames are detected", () => {
    render(
      <StackTraceView
        raw="output mismatch: expected `42` got `7`"
        runId="run-1"
      />,
    );
    const view = screen.getByTestId("stack-trace-view");
    expect(view.textContent).toContain("output mismatch");
    // No frame rows for non-trace text.
    expect(screen.queryAllByTestId("stack-frame-row")).toHaveLength(0);
  });

  it("renders one row per parsed frame and resolves COBOL targets via lineage", async () => {
    const provider = vi.fn(async (path: string) =>
      path === "src/main/java/com/example/Foo.java"
        ? SAMPLE_JAVA
        : path === "src/main/java/com/example/Manual.java"
          ? "// stub"
          : null,
    );
    render(
      <StackTraceView
        raw={TRACE_WITH_RESOLVABLE_AND_NOT}
        runId="run-1"
        sourceProvider={provider}
        fetcher={fetcherFor(envelope())}
      />,
    );
    await waitFor(() => {
      const rows = screen.getAllByTestId("stack-frame-row");
      // 3 frames pass the parser (native is dropped); 1 resolves.
      expect(rows).toHaveLength(3);
    });
    const rows = screen.getAllByTestId("stack-frame-row");
    expect(rows[0].getAttribute("data-resolved")).toBe("true");
    expect(rows[1].getAttribute("data-resolved")).toBe("false");
    expect(rows[2].getAttribute("data-resolved")).toBe("false");
  });

  it("dispatches `c2c:reveal-cobol` when the COBOL-link button is activated", async () => {
    const listener = vi.fn();
    window.addEventListener("c2c:reveal-cobol", listener);
    try {
      const provider = async (path: string) =>
        path === "src/main/java/com/example/Foo.java" ? SAMPLE_JAVA : null;
      render(
        <StackTraceView
          raw="  at com.example.Foo.bar(Foo.java:8)"
          runId="run-1"
          sourceProvider={provider}
          fetcher={fetcherFor(envelope())}
        />,
      );
      const link = await screen.findByRole("button", {
        name: /Reveal COBOL line 30 in PROG1\.cbl/,
      });
      fireEvent.click(link);
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0]?.[0] as CustomEvent<{
        cobolFile: string;
        cobolLine: number;
      }>;
      expect(event.detail).toEqual({ cobolFile: "PROG1.cbl", cobolLine: 30 });
    } finally {
      window.removeEventListener("c2c:reveal-cobol", listener);
    }
  });

  it("dispatches `c2c:reveal-java` when the Open Java target link is activated", async () => {
    const listener = vi.fn();
    window.addEventListener("c2c:reveal-java", listener);
    try {
      const provider = async (path: string) =>
        path === "src/main/java/com/example/Foo.java" ? SAMPLE_JAVA : null;
      render(
        <StackTraceView
          raw="  at com.example.Foo.bar(Foo.java:8)"
          runId="run-1"
          sourceProvider={provider}
          fetcher={fetcherFor(envelope())}
        />,
      );
      const openJava = await screen.findByRole("button", {
        name: /Open Java file src\/main\/java\/com\/example\/Foo\.java at line 8/,
      });
      fireEvent.click(openJava);
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0]?.[0] as CustomEvent<{
        javaFile: string;
        javaLine: number;
      }>;
      expect(event.detail).toEqual({
        javaFile: "src/main/java/com/example/Foo.java",
        javaLine: 8,
      });
    } finally {
      window.removeEventListener("c2c:reveal-java", listener);
    }
  });

  it("renders unresolved frames with accessible no-mapping messaging and no COBOL link", async () => {
    const provider = async () => "// no anchors";
    render(
      <StackTraceView
        raw="  at com.example.Manual.x(Manual.java:3)"
        runId="run-1"
        sourceProvider={provider}
        fetcher={fetcherFor(envelope())}
      />,
    );
    let rows = screen.queryAllByTestId("stack-frame-row");
    await waitFor(() => {
      rows = screen.getAllByTestId("stack-frame-row");
      expect(rows).toHaveLength(1);
      expect(rows[0].getAttribute("data-resolved")).toBe("false");
    });
    expect(screen.getByText(/no source mapping/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reveal COBOL/ }),
    ).not.toBeInTheDocument();
    const chip = screen.getByText(/no source mapping/i);
    expect(chip.getAttribute("title")).toBe(
      "No source mapping available for this frame",
    );
    expect(chip.getAttribute("aria-label")).toBe(
      "No source mapping available for this frame",
    );
    expect(rows[0].getAttribute("aria-label")).toContain(
      "No source mapping available for this frame",
    );
    expect(
      screen.queryByRole("button", { name: /Open Java file/ }),
    ).not.toBeInTheDocument();
  });

  it("toggles the raw trace via the Show/Hide raw button", async () => {
    const provider = async () => SAMPLE_JAVA;
    render(
      <StackTraceView
        raw={TRACE_WITH_RESOLVABLE_AND_NOT}
        runId="run-1"
        sourceProvider={provider}
        fetcher={fetcherFor(envelope())}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("stack-frame-row").length).toBeGreaterThan(
        0,
      );
    });
    const toggle = screen.getByRole("button", { name: /Show raw/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("stack-trace-raw");
    expect(
      screen.queryByText(/NativeMethodAccessorImpl\.invoke0/),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toMatch(/Hide raw/i);
    // The raw block carries the unparsed native-method line so we can
    // assert the full text round-trips.
    const raw = screen.getByText(/NativeMethodAccessorImpl\.invoke0/);
    expect(raw).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByText(/NativeMethodAccessorImpl\.invoke0/),
    ).not.toBeInTheDocument();
  });

  it("frame buttons are focusable via Tab and activatable via Enter", async () => {
    const user = userEvent.setup();
    const listener = vi.fn();
    window.addEventListener("c2c:reveal-cobol", listener);
    try {
      const provider = async () => SAMPLE_JAVA;
      render(
        <StackTraceView
          raw="  at com.example.Foo.bar(Foo.java:8)"
          runId="run-1"
          sourceProvider={provider}
          fetcher={fetcherFor(envelope())}
        />,
      );
      const button = await screen.findByRole("button", {
        name: /Reveal COBOL line 30/,
      });
      await user.tab();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /Show raw/i }),
      );
      await user.tab();
      expect(document.activeElement).toBe(button);
      await user.keyboard("{Enter}");
      expect(listener).toHaveBeenCalledTimes(1);
      await user.keyboard(" ");
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("c2c:reveal-cobol", listener);
    }
  });

  it("renders frame rows even without runId (lineage skipped, no clickable links)", () => {
    render(
      <StackTraceView
        raw="  at com.example.Foo.bar(Foo.java:8)"
        runId={null}
      />,
    );
    const rows = screen.getAllByTestId("stack-frame-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("data-resolved")).toBe("false");
    expect(
      screen.queryByRole("button", { name: /Reveal COBOL/ }),
    ).not.toBeInTheDocument();
  });
});
