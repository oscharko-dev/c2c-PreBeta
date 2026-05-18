// Studio-IDE-14 (#256): lightweight static lint for the c2c-studio Java
// editor. The lint runs entirely in the browser on a debounced effect and
// emits Studio-shaped `Diagnostic` records that the existing
// diagnosticMarkers infrastructure converts to Monaco markers (under the
// dedicated owner `c2c-java-lint`).
//
// The rules are intentionally narrow: every check is a regex / stack pass
// that returns no false positives on canonical Java input. Anything that
// requires a real parser (type checks, scope resolution, ...) is deferred
// to `Compile Check` which calls `POST /api/v0/compile-check`.
//
// Rules:
//   * jl-brace-imbalance   — unbalanced `{` / `}` (line-by-line stack).
//   * jl-paren-imbalance   — unbalanced `(` / `)` (same pass).
//   * jl-bracket-imbalance — unbalanced `[` / `]` (same pass).
//   * jl-mixed-indent      — a single line mixes leading tabs and spaces.
//   * jl-suspicious-assign — `if (x = y)` / `while (x = y)` pattern; the
//                            developer most likely meant `==`.
//   * jl-unclosed-string   — a double-quoted literal opens on a line and
//                            does not close before the end of that line.
//   * jl-trailing-ws       — trailing whitespace (info-only nudge).

import type { Diagnostic } from "@/types/api";

export const JAVA_LINT_OWNER = "c2c-java-lint" as const;

const SCHEMA_VERSION = "v0" as const;
// Issue #256 lint codes — see header. Centralised so tests can reference
// them by symbolic name.
export const JAVA_LINT_CODES = {
  braceImbalance: "jl-brace-imbalance",
  parenImbalance: "jl-paren-imbalance",
  bracketImbalance: "jl-bracket-imbalance",
  mixedIndent: "jl-mixed-indent",
  suspiciousAssign: "jl-suspicious-assign",
  unclosedString: "jl-unclosed-string",
  trailingWhitespace: "jl-trailing-ws",
} as const;

export interface JavaLintOptions {
  // The diagnostics emitted under this filePath. Required so they route
  // to the active editor (matching the `c2c-java-build` convention).
  filePath: string;
  // Maximum number of diagnostics to emit. The marker layer enforces a
  // cap as well, but we stop early to avoid quadratic work on a pasted
  // 100k-line buffer.
  limit?: number;
}

const DEFAULT_LIMIT = 500;

function makeDiagnostic(args: {
  severity: Diagnostic["severity"];
  code: string;
  message: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  filePath: string;
}): Diagnostic {
  const diagnostic: Diagnostic = {
    schemaVersion: SCHEMA_VERSION,
    severity: args.severity,
    code: args.code,
    message: args.message,
    line: args.line,
    filePath: args.filePath,
    sourceKind: "generated_java",
  };
  if (args.column !== undefined) diagnostic.column = args.column;
  if (args.endLine !== undefined) diagnostic.endLine = args.endLine;
  if (args.endColumn !== undefined) diagnostic.endColumn = args.endColumn;
  return diagnostic;
}

// Walk the source character-by-character so the lint stays bracket-aware
// across multi-line constructs while honouring single-line and block
// comments AND string literals (so a `"}"` inside a string does not flip
// the brace balance). The function emits one diagnostic per unmatched
// pair so the editor surfaces them all in one pass.
interface BracketState {
  symbol: "{" | "(" | "[";
  line: number;
  column: number;
}

function scanBracketsAndStrings(
  source: string,
  filePath: string,
  budget: { remaining: number },
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const stack: BracketState[] = [];
  let line = 1;
  let column = 1;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let inChar = false;
  let stringStartLine = 0;
  let stringStartColumn = 0;
  let escapeNext = false;
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? "";
    const next = i + 1 < source.length ? (source[i + 1] ?? "") : "";
    if (ch === "\n") {
      if (inString && budget.remaining > 0) {
        out.push(
          makeDiagnostic({
            severity: "warning",
            code: JAVA_LINT_CODES.unclosedString,
            message: "Unclosed string literal on this line",
            line: stringStartLine,
            column: stringStartColumn,
            filePath,
          }),
        );
        budget.remaining -= 1;
        inString = false;
      }
      inLineComment = false;
      line += 1;
      column = 1;
      i += 1;
      escapeNext = false;
      continue;
    }
    if (inLineComment) {
      column += 1;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        column += 2;
        i += 2;
        continue;
      }
      column += 1;
      i += 1;
      continue;
    }
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      column += 1;
      i += 1;
      continue;
    }
    if (inChar) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === "'") {
        inChar = false;
      }
      column += 1;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      column += 2;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      column += 2;
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStartLine = line;
      stringStartColumn = column;
      column += 1;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inChar = true;
      column += 1;
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      stack.push({ symbol: ch, line, column });
    } else if (ch === "}" || ch === ")" || ch === "]") {
      const expected = ch === "}" ? "{" : ch === ")" ? "(" : "[";
      const top = stack[stack.length - 1];
      if (top && top.symbol === expected) {
        stack.pop();
      } else if (budget.remaining > 0) {
        out.push(
          makeDiagnostic({
            severity: "warning",
            code:
              ch === "}"
                ? JAVA_LINT_CODES.braceImbalance
                : ch === ")"
                  ? JAVA_LINT_CODES.parenImbalance
                  : JAVA_LINT_CODES.bracketImbalance,
            message: `Unmatched closing ${ch}`,
            line,
            column,
            filePath,
          }),
        );
        budget.remaining -= 1;
      }
    }
    column += 1;
    i += 1;
  }
  for (const entry of stack) {
    if (budget.remaining <= 0) break;
    out.push(
      makeDiagnostic({
        severity: "warning",
        code:
          entry.symbol === "{"
            ? JAVA_LINT_CODES.braceImbalance
            : entry.symbol === "("
              ? JAVA_LINT_CODES.parenImbalance
              : JAVA_LINT_CODES.bracketImbalance,
        message: `Unmatched opening ${entry.symbol}`,
        line: entry.line,
        column: entry.column,
        filePath,
      }),
    );
    budget.remaining -= 1;
  }
  // If the buffer ends mid-string, surface that as the same code as the
  // line-level case.
  if (inString && budget.remaining > 0) {
    out.push(
      makeDiagnostic({
        severity: "warning",
        code: JAVA_LINT_CODES.unclosedString,
        message: "Unclosed string literal at end of file",
        line: stringStartLine,
        column: stringStartColumn,
        filePath,
      }),
    );
    budget.remaining -= 1;
  }
  return out;
}

// Per-line checks: mixed indentation, suspicious `=` in conditionals,
// trailing whitespace. Each rule emits at most one diagnostic per
// matching line so the Problems panel stays readable.
function scanLineLevelRules(
  source: string,
  filePath: string,
  budget: { remaining: number },
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = source.split("\n");
  // Suspicious-assignment matcher: detects `if (NAME = EXPR)` / `while
  // (NAME = EXPR)` where the `=` is not part of `==`, `<=`, `>=`, `!=`.
  // The pattern is intentionally narrow — it only fires when the left
  // side is a simple identifier (no calls, no member access), so the
  // common `if (x == 0)` and `if (a[0] = b)` legitimate cases stay
  // silent.
  const suspiciousAssignRe = /\b(if|while)\s*\(\s*[A-Za-z_$][\w$]*\s*=(?!=)/;
  // Mixed-indent matcher: a leading mix of tabs and spaces is almost
  // always a paste-from-editor accident in Java codebases that pick one
  // (tabs or spaces) and stick with it. Trailing tabs after spaces is
  // the canonical accidental pattern.
  const mixedIndentRe = /^( +\t)|(\t+ )/;
  const trailingWsRe = /[ \t]+$/;
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (budget.remaining <= 0) break;
    const text = lines[idx] ?? "";
    const lineNumber = idx + 1;
    if (mixedIndentRe.test(text)) {
      out.push(
        makeDiagnostic({
          severity: "info",
          code: JAVA_LINT_CODES.mixedIndent,
          message: "Mixed tabs and spaces in line indent",
          line: lineNumber,
          filePath,
        }),
      );
      budget.remaining -= 1;
      if (budget.remaining <= 0) break;
    }
    const assignMatch = suspiciousAssignRe.exec(text);
    if (assignMatch && assignMatch.index !== undefined) {
      out.push(
        makeDiagnostic({
          severity: "warning",
          code: JAVA_LINT_CODES.suspiciousAssign,
          message:
            "Assignment inside an if/while condition — did you mean `==`?",
          line: lineNumber,
          column: assignMatch.index + 1,
          filePath,
        }),
      );
      budget.remaining -= 1;
      if (budget.remaining <= 0) break;
    }
    const trailingMatch = trailingWsRe.exec(text);
    if (trailingMatch && trailingMatch.index !== undefined && text.length > 0) {
      out.push(
        makeDiagnostic({
          severity: "info",
          code: JAVA_LINT_CODES.trailingWhitespace,
          message: "Trailing whitespace",
          line: lineNumber,
          column: trailingMatch.index + 1,
          filePath,
        }),
      );
      budget.remaining -= 1;
    }
  }
  return out;
}

// Public entry point. Returns the lint diagnostics in source order so the
// Problems panel renders them naturally.
export function lintJava(
  source: string,
  options: JavaLintOptions,
): Diagnostic[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const budget = { remaining: Math.max(0, limit) };
  const bracketIssues = scanBracketsAndStrings(
    source,
    options.filePath,
    budget,
  );
  const lineIssues = scanLineLevelRules(source, options.filePath, budget);
  return [...bracketIssues, ...lineIssues].sort((a, b) => {
    const lineA = a.line ?? 0;
    const lineB = b.line ?? 0;
    if (lineA !== lineB) return lineA - lineB;
    return (a.column ?? 0) - (b.column ?? 0);
  });
}
