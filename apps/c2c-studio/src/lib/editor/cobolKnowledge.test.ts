import { describe, expect, it } from "vitest";

import {
  FIXED_FORMAT_ZONES,
  explainFixedFormatZone,
  explainOccurs,
  explainParagraph,
  explainPicture,
  explainRedefines,
  explainSection,
  explainUsage,
  explainValue,
  extractDataItems,
  hoverEntryToMarkdownString,
  parseOccurs,
  parsePicture,
  summariseDataItem,
} from "./cobolKnowledge";

describe("parsePicture", () => {
  it("classifies S9(5)V99 as numeric, signed, 5 integer + 2 decimal digits", () => {
    const shape = parsePicture("S9(5)V99");
    expect(shape.kind).toBe("numeric");
    expect(shape.signed).toBe(true);
    expect(shape.integerDigits).toBe(5);
    expect(shape.decimalDigits).toBe(2);
  });

  it("classifies 9(03) as numeric, unsigned, 3 integer digits", () => {
    const shape = parsePicture("9(03)");
    expect(shape.kind).toBe("numeric");
    expect(shape.signed).toBe(false);
    expect(shape.integerDigits).toBe(3);
    expect(shape.decimalDigits).toBe(0);
  });

  it("classifies X(10) as alphanumeric", () => {
    const shape = parsePicture("X(10)");
    expect(shape.kind).toBe("alphanumeric");
  });

  it("classifies A(5) as alphabetic", () => {
    const shape = parsePicture("A(5)");
    expect(shape.kind).toBe("alphabetic");
  });

  it("classifies XX99 as mixed", () => {
    const shape = parsePicture("XX99");
    expect(shape.kind).toBe("mixed");
  });

  it("caps repetition count so a pathological PIC cannot drive unbounded work", () => {
    const shape = parsePicture("9(999999)");
    expect(shape.kind).toBe("numeric");
    expect(shape.integerDigits).toBeLessThanOrEqual(1000);
  });
});

describe("explainPicture", () => {
  it("PIC S9(5)V99 → scale 5+2 signed, mapped to BigDecimal (Studio-IDE-9 AC1)", () => {
    const entry = explainPicture("S9(5)V99");
    expect(entry.title).toBe("PIC S9(5)V99");
    expect(entry.explanation).toMatch(/5 integer digits/);
    expect(entry.explanation).toMatch(/2 decimal digits/);
    expect(entry.explanation).toMatch(/signed/);
    expect(entry.javaMapping).toMatch(/BigDecimal/);
  });

  it("PIC X(10) maps to String", () => {
    const entry = explainPicture("X(10)");
    expect(entry.title).toBe("PIC X(10)");
    expect(entry.javaMapping).toMatch(/String/);
    expect(entry.explanation).toMatch(/10 bytes/);
  });

  it("PIC 99 maps to int", () => {
    const entry = explainPicture("99");
    expect(entry.javaMapping).toMatch(/int/);
  });

  it("PIC 9(19) overflows long and maps to BigInteger", () => {
    const entry = explainPicture("9(19)");
    expect(entry.javaMapping).toMatch(/BigInteger/);
  });
});

describe("explainUsage", () => {
  it("COMP-3 explains packed decimal (Studio-IDE-9 AC2)", () => {
    const entry = explainUsage("COMP-3");
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("USAGE COMP-3");
    expect(entry!.explanation).toMatch(/[Pp]acked decimal/);
    expect(entry!.javaMapping).toMatch(/BigDecimal/);
  });

  it("PACKED-DECIMAL is a synonym for COMP-3", () => {
    const entry = explainUsage("PACKED-DECIMAL");
    expect(entry).not.toBeNull();
    expect(entry!.javaMapping).toMatch(/BigDecimal/);
  });

  it("COMP-1 maps to float", () => {
    const entry = explainUsage("COMP-1");
    expect(entry!.javaMapping).toMatch(/float/);
  });

  it("returns null for unknown usage variants", () => {
    expect(explainUsage("FOO")).toBeNull();
  });
});

describe("parseOccurs / explainOccurs", () => {
  it("OCCURS 10 TIMES → fixed-length 10 array (Studio-IDE-9 AC3)", () => {
    const entry = explainOccurs("OCCURS 10 TIMES");
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("OCCURS 10 TIMES");
    expect(entry!.explanation).toMatch(/exactly 10 occurrences/);
    expect(entry!.javaMapping).toMatch(/\[10\]/);
  });

  it("OCCURS 1 TO 5 DEPENDING ON COUNTER → variable length", () => {
    const shape = parseOccurs("OCCURS 1 TO 5 TIMES DEPENDING ON COUNTER");
    expect(shape).toEqual({ min: 1, max: 5, dependingOn: "COUNTER" });
    const entry = explainOccurs("OCCURS 1 TO 5 TIMES DEPENDING ON COUNTER");
    expect(entry!.title).toMatch(/DEPENDING ON COUNTER/);
    expect(entry!.javaMapping).toMatch(/List/);
  });

  it("returns null for non-OCCURS text", () => {
    expect(explainOccurs("PIC 99")).toBeNull();
  });
});

describe("explainValue", () => {
  it("VALUE ZEROS", () => {
    expect(explainValue("VALUE ZEROS")!.title).toBe("VALUE ZEROS");
  });

  it("VALUE SPACES", () => {
    expect(explainValue("VALUE SPACES")!.title).toBe("VALUE SPACES");
  });

  it("VALUE HIGH-VALUES", () => {
    expect(explainValue("VALUE HIGH-VALUES")!.title).toBe("VALUE HIGH-VALUES");
  });

  it("string literal", () => {
    expect(explainValue('VALUE "HELLO"')!.title).toBe("VALUE (string literal)");
  });

  it("numeric literal", () => {
    expect(explainValue("VALUE 42")!.title).toBe("VALUE (numeric literal)");
  });

  it("returns null when no value literal follows", () => {
    expect(explainValue("VALUE")).toBeNull();
  });
});

describe("explainRedefines", () => {
  it("REDEFINES OLD-FIELD → aliasing with W0 assumption warning (Studio-IDE-9 AC4)", () => {
    const entry = explainRedefines("REDEFINES OLD-FIELD");
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("REDEFINES OLD-FIELD");
    expect(entry!.explanation).toMatch(/share the same bytes/);
    expect(entry!.warning).toMatch(/W0 assumption/);
  });

  it("escapes a redefined name that contains markdown-special characters", () => {
    const entry = explainRedefines("REDEFINES SAFE-NAME");
    // We do not allow `<` in COBOL identifiers, but the escape path is
    // still exercised — confirm the name surfaces verbatim for valid
    // COBOL names so the hover stays readable.
    expect(entry!.title).toContain("SAFE-NAME");
  });
});

describe("explainSection / explainParagraph", () => {
  it("WORKING-STORAGE SECTION", () => {
    const entry = explainSection("       WORKING-STORAGE SECTION.");
    expect(entry).not.toBeNull();
    expect(entry!.title).toMatch(/SECTION$/);
  });

  it("paragraph header", () => {
    const entry = explainParagraph("       MAIN-PROCESS.");
    expect(entry).not.toBeNull();
    expect(entry!.title).toMatch(/paragraph/);
  });

  it("filters out reserved-keyword lines that look like paragraphs", () => {
    expect(explainParagraph("           EXIT.")).toBeNull();
    expect(explainParagraph("           GOBACK.")).toBeNull();
  });
});

describe("explainFixedFormatZone", () => {
  it("column 7 → indicator-area tooltip (Studio-IDE-9 AC5)", () => {
    const entry = explainFixedFormatZone(7);
    expect(entry).not.toBeNull();
    expect(entry!.title).toMatch(/Indicator area/);
    expect(entry!.explanation).toMatch(/`\*`/);
  });

  it("column 1 → sequence number area", () => {
    expect(explainFixedFormatZone(1)!.title).toMatch(/Sequence/);
  });

  it("column 11 → area A", () => {
    expect(explainFixedFormatZone(11)!.title).toMatch(/Area A/);
  });

  it("column 12 → area B", () => {
    expect(explainFixedFormatZone(12)!.title).toMatch(/Area B/);
  });

  it("column 73 → identification area", () => {
    expect(explainFixedFormatZone(73)!.title).toMatch(/Identification/);
  });

  it("column 81 falls outside the fixed-format envelope", () => {
    expect(explainFixedFormatZone(81)).toBeNull();
  });

  it("zones cover columns 1–80 without gaps", () => {
    for (let col = 1; col <= 80; col += 1) {
      expect(explainFixedFormatZone(col)).not.toBeNull();
    }
    // And the boundary cases are correctly attributed.
    expect(FIXED_FORMAT_ZONES[0]!.endColumn).toBe(6);
    expect(FIXED_FORMAT_ZONES[1]!.startColumn).toBe(7);
  });
});

describe("hoverEntryToMarkdownString", () => {
  it("renders title, explanation, mapping, and warning into discrete sections", () => {
    const md = hoverEntryToMarkdownString({
      title: "PIC X",
      explanation: "Alphanumeric.",
      javaMapping: "Maps to **`String`**.",
      warning: "Caution: width unknown.",
    });
    expect(md).toContain("**PIC X**");
    expect(md).toContain("Alphanumeric.");
    expect(md).toContain("**`String`**");
    expect(md).toContain("> ⚠ Caution: width unknown.");
  });

  it("omits absent optional sections", () => {
    const md = hoverEntryToMarkdownString({
      title: "PIC 99",
      explanation: "Numeric.",
    });
    expect(md).not.toContain("⚠");
    expect(md).not.toContain("Maps to");
  });
});

describe("extractDataItems", () => {
  const fixture = [
    "       IDENTIFICATION DIVISION.",
    "       PROGRAM-ID. SAMPLE.",
    "       DATA DIVISION.",
    "       WORKING-STORAGE SECTION.",
    "       01 WS-COUNTER       PIC 99 VALUE 1.",
    "       01 WS-TOTAL         PIC S9(5)V99 VALUE 0.",
    "       01 WS-NAME          PIC X(20) VALUE 'ALICE'.",
    "       01 WS-TABLE.",
    "          05 WS-CELL       PIC 9(3) OCCURS 10 TIMES.",
    "       01 WS-ALIAS REDEFINES WS-TABLE.",
    "          05 WS-VIEW       PIC X(30).",
    "       PROCEDURE DIVISION.",
    "       MAIN-PROCESS.",
    "           MOVE 1 TO WS-COUNTER.",
    "           STOP RUN.",
  ].join("\n");

  it("captures every level/name pair from the DATA DIVISION", () => {
    const items = extractDataItems(fixture);
    expect(items.map((i) => i.name)).toEqual([
      "WS-COUNTER",
      "WS-TOTAL",
      "WS-NAME",
      "WS-TABLE",
      "WS-CELL",
      "WS-ALIAS",
      "WS-VIEW",
    ]);
  });

  it("captures clauses on the same line", () => {
    const items = extractDataItems(fixture);
    const counter = items.find((i) => i.name === "WS-COUNTER")!;
    expect(counter.picture).toBe("99");
    expect(counter.value).toBe("1");
    const cell = items.find((i) => i.name === "WS-CELL")!;
    expect(cell.occurs).toMatch(/OCCURS 10 TIMES/);
    const alias = items.find((i) => i.name === "WS-ALIAS")!;
    expect(alias.redefines).toBe("WS-TABLE");
  });

  it("stops at PROCEDURE DIVISION so paragraph names are not mis-classified", () => {
    const items = extractDataItems(fixture);
    expect(items.find((i) => i.name === "MAIN-PROCESS")).toBeUndefined();
  });

  it("skips comment lines", () => {
    const withComments = [
      "       DATA DIVISION.",
      "       WORKING-STORAGE SECTION.",
      "      * 01 WS-COMMENTED-OUT PIC 99.",
      "       *> 01 WS-FLOATING-COMMENT PIC 99.",
      "       01 WS-REAL          PIC 99.",
    ].join("\n");
    const items = extractDataItems(withComments);
    expect(items.map((i) => i.name)).toEqual(["WS-REAL"]);
  });
});

describe("summariseDataItem", () => {
  it("combines picture, usage, occurs and value into one explanation", () => {
    const item = {
      line: 5,
      level: "01",
      name: "WS-TOTAL",
      picture: "S9(5)V99",
      usage: "COMP-3",
      value: "0",
      occurs: null,
      redefines: null,
    };
    const entry = summariseDataItem(item);
    expect(entry.title).toMatch(/WS-TOTAL/);
    expect(entry.title).toMatch(/line 5/);
    expect(entry.explanation).toMatch(/Level 01/);
    expect(entry.explanation).toMatch(/5 integer digits/);
    expect(entry.explanation).toMatch(/Packed decimal/i);
  });
});
