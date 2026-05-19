import { describe, expect, it } from "vitest";

import { JAVA_LINT_CODES, JAVA_LINT_OWNER, lintJava } from "./javaLint";

const FILE = "src/main/java/App.java";

describe("lintJava", () => {
  it("emits no diagnostics for canonical Java", () => {
    const source = [
      "package com.example;",
      "",
      "public class App {",
      "  public static void main(String[] args) {",
      '    System.out.println("hello");',
      "  }",
      "}",
      "",
    ].join("\n");
    expect(lintJava(source, { filePath: FILE })).toEqual([]);
  });

  it("flags an unmatched opening brace", () => {
    const source = [
      "public class A {",
      "  public void m() {",
      "    if (true) {",
      "  }",
      "}",
    ].join("\n");
    const diagnostics = lintJava(source, { filePath: FILE });
    const brace = diagnostics.find(
      (d) => d.code === JAVA_LINT_CODES.braceImbalance,
    );
    expect(brace).toBeDefined();
    expect(brace?.severity).toBe("warning");
    expect(brace?.filePath).toBe(FILE);
    expect(brace?.sourceKind).toBe("generated_java");
  });

  it("flags an unmatched closing brace", () => {
    const source = "public class A {}}\n";
    const diagnostics = lintJava(source, { filePath: FILE });
    expect(
      diagnostics.some((d) => d.code === JAVA_LINT_CODES.braceImbalance),
    ).toBe(true);
  });

  it("ignores braces inside strings and comments", () => {
    const source = [
      "public class A {",
      "  // Comment with } inside",
      "  /* Block } with stray brace */",
      '  String x = "closing } in string";',
      "}",
    ].join("\n");
    expect(lintJava(source, { filePath: FILE })).toEqual([]);
  });

  it("flags an unclosed string literal on one line", () => {
    const source = [
      "public class A {",
      '  String x = "oops;',
      "  int y = 1;",
      "}",
    ].join("\n");
    const diagnostics = lintJava(source, { filePath: FILE });
    const unclosed = diagnostics.find(
      (d) => d.code === JAVA_LINT_CODES.unclosedString,
    );
    expect(unclosed).toBeDefined();
    expect(unclosed?.line).toBe(2);
  });

  it("flags suspicious `if (x = y)` assignment", () => {
    const source = [
      "public class A {",
      "  void m(int x, int y) {",
      "    if (x = y) {",
      "      return;",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const diagnostics = lintJava(source, { filePath: FILE });
    const assign = diagnostics.find(
      (d) => d.code === JAVA_LINT_CODES.suspiciousAssign,
    );
    expect(assign).toBeDefined();
    expect(assign?.severity).toBe("warning");
    expect(assign?.line).toBe(3);
  });

  it("does not flag `if (x == y)` as suspicious assignment", () => {
    const source = [
      "public class A {",
      "  void m(int x, int y) {",
      "    if (x == y) {",
      "      return;",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const diagnostics = lintJava(source, { filePath: FILE });
    expect(
      diagnostics.some((d) => d.code === JAVA_LINT_CODES.suspiciousAssign),
    ).toBe(false);
  });

  it("does not flag suspicious assignment text inside comments or strings", () => {
    const source = [
      "public class A {",
      "  // if (x = y) is only documentation",
      '  String text = "while (x = y) is not code";',
      "  /* if (z = y) is inside a block comment */",
      "  void m() {}",
      "}",
    ].join("\n");
    const diagnostics = lintJava(source, { filePath: FILE });
    expect(
      diagnostics.some((d) => d.code === JAVA_LINT_CODES.suspiciousAssign),
    ).toBe(false);
  });

  it("flags unclosed string literals at end of file", () => {
    const diagnostics = lintJava('public class A {\n  String s = "oops', {
      filePath: FILE,
    });
    const unclosed = diagnostics.find(
      (d) => d.code === JAVA_LINT_CODES.unclosedString,
    );
    expect(unclosed).toBeDefined();
    expect(unclosed?.line).toBe(2);
    expect(unclosed?.column).toBe(14);
  });

  it("flags mixed-indentation lines", () => {
    const source = "public class A {\n \tint x = 0;\n}\n";
    const diagnostics = lintJava(source, { filePath: FILE });
    const mixed = diagnostics.find(
      (d) => d.code === JAVA_LINT_CODES.mixedIndent,
    );
    expect(mixed).toBeDefined();
    expect(mixed?.severity).toBe("info");
  });

  it("flags trailing whitespace as info only", () => {
    const source = "public class A {  \n}\n";
    const diagnostics = lintJava(source, { filePath: FILE });
    const trailing = diagnostics.find(
      (d) => d.code === JAVA_LINT_CODES.trailingWhitespace,
    );
    expect(trailing).toBeDefined();
    expect(trailing?.severity).toBe("info");
  });

  it("respects the diagnostic budget", () => {
    const noisy = "{".repeat(50) + "\n";
    const diagnostics = lintJava(noisy, { filePath: FILE, limit: 3 });
    expect(diagnostics.length).toBeLessThanOrEqual(3);
  });

  it("sorts diagnostics by (line, column)", () => {
    const source =
      "{\n" + // unmatched brace at line 1 col 1
      "public class A {  \n" + // trailing whitespace line 2
      "  if (x = 1) {}\n" + // suspicious assign line 3
      "}\n";
    const diagnostics = lintJava(source, { filePath: FILE });
    expect(diagnostics.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < diagnostics.length; i += 1) {
      const previous = diagnostics[i - 1];
      const current = diagnostics[i];
      if (!previous || !current) continue;
      const prevLine = previous.line ?? 0;
      const curLine = current.line ?? 0;
      expect(prevLine).toBeLessThanOrEqual(curLine);
    }
  });

  it("emits diagnostics under the canonical lint owner", () => {
    // The owner string is exported so the editor can pass it to the
    // marker layer; consumers must use the canonical value, not a
    // hand-rolled literal.
    expect(JAVA_LINT_OWNER).toBe("c2c-java-lint");
  });
});
