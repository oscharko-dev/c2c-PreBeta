import { describe, expect, it, vi } from "vitest";

import {
  __resetCobolHoverProviderForTests,
  buildHoverResult,
  computeHoverFor,
  createCobolHoverProvider,
  registerCobolHoverProvider,
} from "./cobolHoverProvider";

// ---------------------------------------------------------------------------
// Monaco stubs
//
// Monaco's full editor cannot boot under jsdom (see cobolMonarch.test.ts).
// The hover provider's pure surface (`computeHoverFor`) does not need
// any Monaco APIs; the Monaco-bound wrapper only calls
// `model.getLineContent`. The stubs below mirror the diagnosticMarkers
// test pattern: just enough shape to satisfy the contract.
// ---------------------------------------------------------------------------

type Monaco = Parameters<typeof createCobolHoverProvider>[0];

function fakeMonaco(): Monaco {
  return {
    languages: {
      registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
  } as unknown as Monaco;
}

function modelFor(
  lines: string[],
): Parameters<ReturnType<typeof createCobolHoverProvider>["provideHover"]>[0] {
  return {
    getLineContent(lineNumber: number) {
      return lines[lineNumber - 1] ?? "";
    },
    getLineCount() {
      return lines.length;
    },
  } as unknown as Parameters<
    ReturnType<typeof createCobolHoverProvider>["provideHover"]
  >[0];
}

function positionAt(lineNumber: number, column: number) {
  return { lineNumber, column } as Parameters<
    ReturnType<typeof createCobolHoverProvider>["provideHover"]
  >[1];
}

// ---------------------------------------------------------------------------
// Pure compute layer — covers every acceptance criterion
// ---------------------------------------------------------------------------

describe("computeHoverFor — PIC clauses", () => {
  it("AC1: PIC S9(5)V99 returns markdown with scale 5/2 signed BigDecimal", () => {
    const line = "       01 WS-TOTAL          PIC S9(5)V99 VALUE 0.";
    const picStart = line.indexOf("S9(5)V99");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: picStart + 2,
    });
    expect(computed).not.toBeNull();
    expect(computed!.entry.title).toBe("PIC S9(5)V99");
    expect(computed!.entry.explanation).toMatch(/5 integer digits/);
    expect(computed!.entry.explanation).toMatch(/2 decimal digits/);
    expect(computed!.entry.explanation).toMatch(/signed/);
    expect(computed!.entry.javaMapping).toMatch(/BigDecimal/);
  });

  it("returns the PIC hover when the cursor is on `PIC`", () => {
    const line = "       01 WS-TOTAL          PIC 99.";
    const picKeyword = line.indexOf("PIC");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: picKeyword + 2,
    });
    expect(computed!.entry.title).toMatch(/^PIC/);
  });
});

describe("computeHoverFor — USAGE clauses", () => {
  it("AC2: COMP-3 hover explains packed decimal", () => {
    const line = "       01 WS-AMOUNT         USAGE COMP-3.";
    const compStart = line.indexOf("COMP-3");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: compStart + 2,
    });
    expect(computed!.entry.title).toBe("USAGE COMP-3");
    expect(computed!.entry.explanation).toMatch(/[Pp]acked decimal/);
  });

  it("does not steal hover from the DISPLAY *verb*", () => {
    const line = '           DISPLAY "HELLO".';
    const verbStart = line.indexOf("DISPLAY");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: verbStart + 2,
    });
    // No USAGE keyword precedes DISPLAY here, so the matcher must not
    // claim this as a usage clause. Fall-through should give either a
    // paragraph/zone tooltip, not a USAGE DISPLAY hover.
    if (computed) {
      expect(computed.entry.title).not.toMatch(/USAGE DISPLAY/);
    }
  });

  it("matches DISPLAY *after* the USAGE keyword", () => {
    const line = "       01 WS-FIELD          USAGE DISPLAY.";
    const displayStart = line.indexOf("DISPLAY");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: displayStart + 2,
    });
    expect(computed!.entry.title).toBe("USAGE DISPLAY");
  });
});

describe("computeHoverFor — OCCURS clauses", () => {
  it("AC3: OCCURS 10 TIMES returns a fixed-length array hover", () => {
    const line = "          05 WS-CELL        PIC 9(3) OCCURS 10 TIMES.";
    const occursStart = line.indexOf("OCCURS");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: occursStart + 3,
    });
    expect(computed!.entry.title).toBe("OCCURS 10 TIMES");
    expect(computed!.entry.explanation).toMatch(/10 occurrences/);
  });

  it("OCCURS DEPENDING ON returns the variable-length hover", () => {
    const line =
      "          05 WS-CELL        PIC 9(3) OCCURS 1 TO 10 TIMES DEPENDING ON WS-COUNT.";
    const occursStart = line.indexOf("OCCURS");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: occursStart + 3,
    });
    expect(computed!.entry.title).toMatch(/DEPENDING ON WS-COUNT/);
  });
});

describe("computeHoverFor — REDEFINES", () => {
  it("AC4: REDEFINES OLD-FIELD explains aliasing with the W0 warning", () => {
    const line = "       01 WS-ALIAS REDEFINES OLD-FIELD.";
    const redefStart = line.indexOf("REDEFINES");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: redefStart + 3,
    });
    expect(computed!.entry.title).toBe("REDEFINES OLD-FIELD");
    expect(computed!.entry.explanation).toMatch(/share the same bytes/);
    expect(computed!.entry.warning).toMatch(/W0 assumption/);
  });
});

describe("computeHoverFor — VALUE", () => {
  it("VALUE ZEROS returns the figurative-constant hover", () => {
    const line = "       01 WS-COUNTER        PIC 99 VALUE ZEROS.";
    const valueStart = line.indexOf("VALUE");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: valueStart + 3,
    });
    expect(computed!.entry.title).toBe("VALUE ZEROS");
  });
});

describe("computeHoverFor — SECTION / paragraph", () => {
  it("SECTION header returns a procedural structure hover", () => {
    const line = "       WORKING-STORAGE SECTION.";
    const sectionStart = line.indexOf("SECTION");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: sectionStart + 3,
    });
    expect(computed!.entry.title).toBe("WORKING-STORAGE SECTION");
  });

  it("paragraph header on its own line returns the paragraph hover", () => {
    const line = "       MAIN-PROCESS.";
    const computed = computeHoverFor(line, { lineNumber: 1, column: 10 });
    expect(computed!.entry.title).toMatch(/paragraph/);
  });
});

describe("computeHoverFor — fixed-format zones", () => {
  it("AC5: hovering in column 7 of a fixed-format line shows the indicator-area tooltip", () => {
    // A line whose column 7 is blank — typical fixed-format COBOL — so
    // no construct match wins and the zone tooltip is returned.
    const line = "       MOVE 1 TO WS-COUNTER.";
    const computed = computeHoverFor(line, { lineNumber: 1, column: 7 });
    expect(computed).not.toBeNull();
    expect(computed!.entry.title).toMatch(/Indicator area/);
  });

  it("hovering in column 1 returns the sequence-number tooltip", () => {
    const line = "       MOVE 1 TO WS-COUNTER.";
    const computed = computeHoverFor(line, { lineNumber: 1, column: 1 });
    expect(computed!.entry.title).toMatch(/Sequence/);
  });

  it("zone tooltip yields to a construct match when both overlap", () => {
    // Cursor is inside the PIC clause (Area B), so we want the PIC
    // hover, not the Area B tooltip.
    const line = "       01 WS-VALUE          PIC S9(5)V99.";
    const picStart = line.indexOf("S9(5)V99");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: picStart + 2,
    });
    expect(computed!.entry.title).toMatch(/^PIC/);
  });

  it("does not surface a construct hover for a plain data-name token (fall-through to zone)", () => {
    // Hovering on `WS-TOTAL` itself — no PIC/USAGE/OCCURS match
    // overlaps the name span, so the column-based zone tooltip is what
    // surfaces. Cursor in Area A.
    const line = "       01 WS-TOTAL          PIC S9(5)V99.";
    const nameStart = line.indexOf("WS-TOTAL");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: nameStart + 2,
    });
    // The zone tooltip wins because the regex matchers do not capture
    // bare data names. We assert the title is NOT a construct hover.
    if (computed) {
      expect(computed.entry.title).not.toMatch(/^PIC /);
      expect(computed.entry.title).not.toMatch(/^USAGE /);
      expect(computed.entry.title).not.toMatch(/^OCCURS /);
    }
  });

  it("does not return a hover for the column immediately past the matched span", () => {
    // Boundary regression: `end` is exclusive (Monaco range
    // convention). Hovering exactly at `end` must miss the match.
    const line = "       01 WS-AMT            PIC 99 .";
    const picStart = line.indexOf("PIC 99") + 1; // 1-based start of "PIC"
    const picEnd = picStart + "PIC 99".length; // exclusive end column
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: picEnd,
    });
    // We may still get a zone tooltip (Area B), but never the PIC hover.
    if (computed) {
      expect(computed.entry.title).not.toMatch(/^PIC /);
    }
  });
});

// ---------------------------------------------------------------------------
// Security — Studio-IDE-9 acceptance gate
// ---------------------------------------------------------------------------

describe("hover content security", () => {
  it("AC7: injected <script> in a knowledge-base name is escaped, not executed", () => {
    // Force the explainRedefines path with a payload that contains
    // angle brackets. The COBOL grammar doesn't permit `<` in names,
    // so this is a synthetic stress test for the sanitizer.
    const line = "       01 WS-EVIL REDEFINES <script>alert(1)</script>";
    const redefStart = line.indexOf("REDEFINES");
    const computed = computeHoverFor(line, {
      lineNumber: 1,
      column: redefStart + 3,
    });
    if (computed) {
      const md = computed.entry.title + " " + computed.entry.explanation;
      // The sanitizer escapes angle brackets so any payload that *did*
      // sneak through the regex appears as `&lt;` / `&gt;` and never as
      // executable HTML.
      expect(md).not.toContain("<script>");
    }
  });

  it("buildHoverResult marks every result as untrusted markdown", () => {
    const monaco = fakeMonaco();
    const result = buildHoverResult(
      monaco,
      {
        entry: { title: "x", explanation: "y" },
        startColumn: 1,
        endColumn: 2,
        constructKind: "pic",
      },
      1,
    );
    const content = (
      result.contents as unknown as Array<{
        isTrusted: boolean;
        supportHtml: boolean;
      }>
    )[0]!;
    expect(content.isTrusted).toBe(false);
    expect(content.supportHtml).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Monaco binding — registration + provideHover wrapper
// ---------------------------------------------------------------------------

describe("createCobolHoverProvider", () => {
  it("returns null when the line has nothing to hover on outside the fixed-format envelope", () => {
    const monaco = fakeMonaco();
    const provider = createCobolHoverProvider(monaco);
    const result = provider.provideHover(
      modelFor(["       "]),
      positionAt(1, 200),
      // The Monaco `CancellationToken` is unused; cast to satisfy the
      // signature without pulling in the full Monaco runtime.
      undefined as unknown as Parameters<typeof provider.provideHover>[2],
    );
    expect(result).toBeNull();
  });

  it("hovering a PIC clause yields a markdown result with the picture title", () => {
    const monaco = fakeMonaco();
    const provider = createCobolHoverProvider(monaco);
    const line = "       01 WS-AMT            PIC S9(5)V99.";
    const picColumn = line.indexOf("S9(5)V99") + 2;
    const result = provider.provideHover(
      modelFor([line]),
      positionAt(1, picColumn),
      undefined as unknown as Parameters<typeof provider.provideHover>[2],
    );
    expect(result).not.toBeNull();
    // Monaco types `provideHover` as `Hover | Thenable<Hover>`. Our
    // implementation returns the `Hover` shape synchronously, so a
    // direct cast through `unknown` keeps the assertion typed without
    // pulling in a real Monaco runtime.
    const md = result as unknown as { contents: Array<{ value: string }> };
    const content = md.contents[0]!;
    expect(content.value).toMatch(/PIC S9\(5\)V99/);
  });
});

describe("registerCobolHoverProvider", () => {
  it("is idempotent — registering twice only attaches one provider to Monaco", () => {
    __resetCobolHoverProviderForTests();
    const monaco = fakeMonaco();
    registerCobolHoverProvider(monaco);
    registerCobolHoverProvider(monaco);
    expect(monaco.languages.registerHoverProvider).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// No network during the hover lookup
// ---------------------------------------------------------------------------

describe("provider has zero network footprint", () => {
  it("does not call fetch / XHR / WebSocket during provideHover", () => {
    const monaco = fakeMonaco();
    const provider = createCobolHoverProvider(monaco);
    const fetchSpy = vi.fn();
    const xhrSpy = vi.fn();
    const wsSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    const originalXhr = globalThis.XMLHttpRequest;
    const originalWs = globalThis.WebSocket;
    // Replace each network primitive with a recording spy so any call
    // is observable. The provider must not touch any of them.
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = xhrSpy;
    (globalThis as { WebSocket?: unknown }).WebSocket = wsSpy;
    try {
      const line = "       01 WS-AMT            PIC S9(5)V99.";
      provider.provideHover(
        modelFor([line]),
        positionAt(1, line.indexOf("S9(5)V99") + 2),
        undefined as unknown as Parameters<typeof provider.provideHover>[2],
      );
    } finally {
      (globalThis as { fetch?: unknown }).fetch = originalFetch;
      (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXhr;
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWs;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    expect(wsSpy).not.toHaveBeenCalled();
  });
});
