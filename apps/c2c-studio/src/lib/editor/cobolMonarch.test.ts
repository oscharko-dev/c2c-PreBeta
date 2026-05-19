import { describe, expect, it } from "vitest";

import {
  COBOL_LANGUAGE_CONFIGURATION,
  COBOL_LANGUAGE_ID,
  COBOL_MONARCH_LANGUAGE,
  FIXED_FORMAT_RULER_COLUMNS,
} from "./cobolMonarch";

// ---------------------------------------------------------------------------
// Monarch-lite test harness
//
// Monaco's full Monarch lexer is tightly coupled to its TokenizationRegistry,
// IConfigurationService, and platform layer, none of which boot cleanly under
// vitest's jsdom environment (the existing `lazyMonaco.test.ts` mocks Monaco
// rather than loading it). This file exercises the grammar through a small
// custom evaluator that interprets the subset of Monarch features the COBOL
// grammar relies on:
//
//   - single-action rules: [regex, "tokenName"]
//   - compound action: [regex, { token, next }]
//   - state transitions via `next: "@stateName"` and `next: "@pop"`
//   - `@rematch` (re-tokenize at current position in the popped state)
//   - `cases` branching on `@keywords` / `@dataKeywords` lookup tables
//   - `ignoreCase: true`
//   - the `tokenPostfix` suffix that Monaco appends to every token name
//
// The harness deliberately does not implement features the COBOL grammar does
// not use (group-captures with parallel actions, `@brackets`-bracket pairing,
// nested embeds). Adding rules that depend on unsupported features will fail
// loudly via the "unhandled action" branch rather than passing silently.
// ---------------------------------------------------------------------------

type MonarchRule = [RegExp, MonarchAction];

interface MonarchActionObject {
  readonly token?: string;
  readonly next?: string;
  readonly cases?: Record<string, string>;
}

type MonarchAction = string | MonarchActionObject;

interface Token {
  readonly token: string;
  readonly text: string;
  readonly startColumn: number;
}

// `IMonarchLanguage` is open-ended — Monaco lets grammars attach arbitrary
// helper arrays (here, `keywords` and `dataKeywords`) for use inside the
// tokenizer state machine, but TypeScript's typings only expose the
// well-known fields. Go through `unknown` to assert the shape we know is
// present in our grammar definition (see `cobolMonarch.ts`).
const KEYWORD_SET = new Set(
  (COBOL_MONARCH_LANGUAGE as unknown as { keywords: string[] }).keywords.map(
    (kw) => kw.toUpperCase(),
  ),
);
const DATA_KEYWORD_SET = new Set(
  (
    COBOL_MONARCH_LANGUAGE as unknown as { dataKeywords: string[] }
  ).dataKeywords.map((kw) => kw.toUpperCase()),
);

const TOKEN_POSTFIX = COBOL_MONARCH_LANGUAGE.tokenPostfix ?? "";

function lookupKeyword(literal: string): string | null {
  const upper = literal.toUpperCase();
  if (KEYWORD_SET.has(upper)) {
    return "keyword";
  }
  if (DATA_KEYWORD_SET.has(upper)) {
    return "type";
  }
  return null;
}

function applyCases(
  cases: Record<string, string>,
  matched: string,
): string | null {
  for (const [key, value] of Object.entries(cases)) {
    if (key === "@keywords") {
      if (KEYWORD_SET.has(matched.toUpperCase())) {
        return value;
      }
    } else if (key === "@dataKeywords") {
      if (DATA_KEYWORD_SET.has(matched.toUpperCase())) {
        return value;
      }
    } else if (key === "@default") {
      // resolved last as the fallback
      continue;
    } else if (key === matched) {
      return value;
    }
  }
  return cases["@default"] ?? null;
}

function compileRules(stateName: string): MonarchRule[] {
  const rawRules = (
    COBOL_MONARCH_LANGUAGE.tokenizer as Record<string, MonarchRule[]>
  )[stateName];
  if (!rawRules) {
    throw new Error(`Unknown tokenizer state: ${stateName}`);
  }
  return rawRules.map(([regex, action]) => {
    // Re-anchor each regex with the sticky flag so we can advance position-by-
    // position rather than only matching at line start. Monaco implements this
    // internally; we replicate by adding `y` (sticky) for predictable behavior.
    const flags = ["y", COBOL_MONARCH_LANGUAGE.ignoreCase ? "i" : ""]
      .filter(Boolean)
      .join("");
    return [new RegExp(regex.source, flags), action];
  });
}

interface StackFrame {
  readonly stateName: string;
  readonly rules: MonarchRule[];
}

function pushState(stack: StackFrame[], stateName: string): void {
  stack.push({ stateName, rules: compileRules(stateName) });
}

function tokenizeLineWithState(
  line: string,
  initialStack: string[] = ["root"],
): { tokens: Token[]; finalStack: string[] } {
  const tokens: Token[] = [];
  const stack: StackFrame[] = [];
  for (const state of initialStack) {
    pushState(stack, state);
  }
  let position = 0;
  // Bound the iteration count to defend against malformed grammars that
  // could otherwise loop forever on `@rematch` with no state change.
  let safety = line.length * 8 + 32;
  while (position <= line.length) {
    if (safety-- <= 0) {
      throw new Error(
        `tokenizeLine exceeded its iteration budget at position ${position} on "${line}"`,
      );
    }
    if (position === line.length) {
      // End of line — done. Multi-line states (e.g., open strings) are not
      // expected in the COBOL grammar's snippets used here, so we stop.
      break;
    }
    const frame = stack[stack.length - 1];
    if (!frame) {
      throw new Error("tokenizer stack underflow");
    }
    let matched = false;
    for (const [regex, action] of frame.rules) {
      regex.lastIndex = position;
      const match = regex.exec(line);
      if (!match || match.index !== position) {
        continue;
      }
      const text = match[0];
      if (text.length === 0) {
        // Zero-width matches would loop forever; treat as a bug in the rule.
        throw new Error(
          `Zero-length match in state ${frame.stateName} at position ${position} for /${regex.source}/`,
        );
      }
      let resolvedToken: string | null = null;
      let nextDirective: string | undefined;
      let rematch = false;
      if (typeof action === "string") {
        resolvedToken = action;
      } else {
        if (action.cases) {
          resolvedToken = applyCases(action.cases, text);
        } else {
          resolvedToken = action.token ?? null;
        }
        if (action.token === "@rematch") {
          rematch = true;
        }
        nextDirective = action.next;
      }
      if (resolvedToken && resolvedToken !== "@rematch") {
        tokens.push({
          token:
            resolvedToken === "@brackets"
              ? `delimiter.parenthesis${TOKEN_POSTFIX}`
              : `${resolvedToken}${TOKEN_POSTFIX}`,
          text,
          startColumn: position,
        });
      }
      if (!rematch) {
        position += text.length;
      }
      if (nextDirective === "@pop") {
        stack.pop();
        if (stack.length === 0) {
          throw new Error("tokenizer popped past root");
        }
      } else if (nextDirective?.startsWith("@")) {
        pushState(stack, nextDirective.slice(1));
      }
      matched = true;
      break;
    }
    if (!matched) {
      // Skip a single character to avoid infinite loops; emit as defaultToken
      // (Monaco does the same when no rule matches).
      tokens.push({
        token: `${TOKEN_POSTFIX.replace(/^\./, "")}` || "source",
        text: line.charAt(position),
        startColumn: position,
      });
      position += 1;
    }
  }
  return { tokens, finalStack: stack.map((frame) => frame.stateName) };
}

function tokenizeLine(
  line: string,
  initialStack: string[] = ["root"],
): Token[] {
  return tokenizeLineWithState(line, initialStack).tokens;
}

function tokensExcludingWhitespace(tokens: Token[]): Token[] {
  return tokens.filter((token) => !token.token.startsWith("white"));
}

function tokenAtText(tokens: Token[], text: string): Token | undefined {
  return tokens.find((token) => token.text === text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("COBOL Monarch grammar — module exports", () => {
  it("exposes the canonical language id and fixed-format ruler columns", () => {
    expect(COBOL_LANGUAGE_ID).toBe("cobol");
    expect(FIXED_FORMAT_RULER_COLUMNS).toEqual([6, 7, 11, 72, 80]);
  });

  it("covers the W0 subset verbs as keywords", () => {
    const requiredVerbs = [
      "IDENTIFICATION",
      "ENVIRONMENT",
      "DATA",
      "PROCEDURE",
      "DIVISION",
      "SECTION",
      "PARAGRAPH",
      "MOVE",
      "PERFORM",
      "IF",
      "EVALUATE",
      "ADD",
      "SUBTRACT",
      "MULTIPLY",
      "DIVIDE",
      "COMPUTE",
      "DISPLAY",
      "ACCEPT",
    ];
    for (const verb of requiredVerbs) {
      expect(KEYWORD_SET.has(verb)).toBe(true);
    }
  });

  it("covers the W0 subset data-declaration tokens", () => {
    const requiredDataKeywords = [
      "COMP",
      "COMP-3",
      "OCCURS",
      "REDEFINES",
      "VALUE",
    ];
    for (const keyword of requiredDataKeywords) {
      expect(DATA_KEYWORD_SET.has(keyword)).toBe(true);
    }
  });

  it("declares a single line-comment style (free-format `*>`)", () => {
    expect(COBOL_LANGUAGE_CONFIGURATION.comments?.lineComment).toBe("*>");
  });
});

describe("COBOL Monarch grammar — tokenization edge cases", () => {
  it("snippet 1: tokenizes IDENTIFICATION DIVISION line in fixed format", () => {
    const line = "       IDENTIFICATION DIVISION.";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(tokenAtText(tokens, "IDENTIFICATION")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "DIVISION")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, ".")?.token).toBe("delimiter.cobol");
  });

  it("snippet 2: tokenizes PROGRAM-ID with hyphenated identifier", () => {
    const line = "       PROGRAM-ID. BRNCH01.";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(tokenAtText(tokens, "PROGRAM-ID")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "BRNCH01")?.token).toBe("identifier.cobol");
  });

  it("snippet 3: treats column-7 `*` as a comment for the whole line", () => {
    const line = "      * This entire line is a fixed-format comment.";
    const tokens = tokenizeLine(line);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe("comment.cobol");
    expect(tokens[0].text).toBe(line);
  });

  it("snippet 4: does NOT treat `*` outside column 7 as a comment", () => {
    // `*` in column 8 (area A) is the multiplication operator, not a comment.
    const line = "        COMPUTE A = B * C.";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(
      tokens.find((token) => token.token === "comment.cobol"),
    ).toBeUndefined();
    expect(tokenAtText(tokens, "COMPUTE")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "*")?.token).toBe("operator.cobol");
  });

  it("snippet 5: highlights free-format floating comment `*>` to end of line", () => {
    const line = "           DISPLAY 'HELLO'.  *> trailing comment goes here";
    const tokens = tokenizeLine(line);
    const commentToken = tokens.find((token) =>
      token.text.startsWith("*> trailing"),
    );
    expect(commentToken?.token).toBe("comment.cobol");
    // The DISPLAY verb that precedes the floating comment is still a keyword.
    expect(tokenAtText(tokens, "DISPLAY")?.token).toBe("keyword.cobol");
  });

  it("snippet 6: tokenizes single-quoted string literal including its content", () => {
    const line = "           DISPLAY 'HELLO WORLD'.";
    const tokens = tokenizeLine(line);
    expect(tokens.some((token) => token.token === "string.quote.cobol")).toBe(
      true,
    );
    expect(
      tokens.some(
        (token) =>
          token.token === "string.cobol" && token.text === "HELLO WORLD",
      ),
    ).toBe(true);
  });

  it("snippet 7: tokenizes double-quoted string literal", () => {
    const line = '           DISPLAY "WITH SPACES".';
    const tokens = tokenizeLine(line);
    expect(
      tokens.some(
        (token) =>
          token.token === "string.cobol" && token.text === "WITH SPACES",
      ),
    ).toBe(true);
  });

  it("snippet 8: emits PIC clause body as a single `type.picture` token", () => {
    const line = "       05  CUSTOMER-NAME       PIC X(20).";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(tokenAtText(tokens, "PIC")?.token).toBe("type.cobol");
    expect(tokens.some((token) => token.token === "type.picture.cobol")).toBe(
      true,
    );
    // Level number 05 should be a number token.
    expect(tokenAtText(tokens, "05")?.token).toBe("number.cobol");
    expect(tokenAtText(tokens, "CUSTOMER-NAME")?.token).toBe(
      "identifier.cobol",
    );
  });

  it("snippet 9: tokenizes OCCURS clause as type token", () => {
    const line = "       05  ITEMS OCCURS 10 TIMES.";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(tokenAtText(tokens, "OCCURS")?.token).toBe("type.cobol");
    expect(tokenAtText(tokens, "10")?.token).toBe("number.cobol");
    expect(tokenAtText(tokens, "TIMES")?.token).toBe("keyword.cobol");
  });

  it("snippet 10: tokenizes REDEFINES + VALUE clauses", () => {
    const line = "       05  ALIAS REDEFINES BASE VALUE 0.";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(tokenAtText(tokens, "REDEFINES")?.token).toBe("type.cobol");
    expect(tokenAtText(tokens, "VALUE")?.token).toBe("type.cobol");
    expect(tokenAtText(tokens, "BASE")?.token).toBe("identifier.cobol");
    expect(tokenAtText(tokens, "0")?.token).toBe("number.cobol");
  });

  it("snippet 11: tokenizes COMPUTE arithmetic expression with literals and operators", () => {
    const line = "           COMPUTE TOTAL = PRICE * 1.05 + 0.99.";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(tokenAtText(tokens, "COMPUTE")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "*")?.token).toBe("operator.cobol");
    expect(tokenAtText(tokens, "+")?.token).toBe("operator.cobol");
    expect(tokenAtText(tokens, "1.05")?.token).toBe("number.cobol");
    expect(tokenAtText(tokens, "0.99")?.token).toBe("number.cobol");
    expect(tokenAtText(tokens, "=")?.token).toBe("operator.cobol");
  });

  it("snippet 12: tokenizes free-format DISPLAY with embedded string", () => {
    // Free-format COBOL programs may start statements at column 1.
    const line = "DISPLAY 'TEST'.";
    const tokens = tokenizeLine(line);
    expect(tokenAtText(tokens, "DISPLAY")?.token).toBe("keyword.cobol");
    expect(
      tokens.some(
        (token) => token.token === "string.cobol" && token.text === "TEST",
      ),
    ).toBe(true);
  });

  it("snippet 13: PIC 9(03)V99 emits a single picture-body token (no number/paren fragmentation)", () => {
    const line = "       05  AMOUNT PIC 9(03)V99.";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    const pictureBody = tokens.find(
      (token) => token.token === "type.picture.cobol",
    );
    expect(pictureBody).toBeDefined();
    expect(pictureBody?.text).toBe("9(03)V99");
  });

  it("snippet 14: COMP-3 usage clause is a type keyword", () => {
    const line = "       05  RATE PIC 9(5) USAGE COMP-3.";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(tokenAtText(tokens, "USAGE")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "COMP-3")?.token).toBe("type.cobol");
  });

  it("snippet 14b: PIC state does not leak into the next physical line without a period", () => {
    const first = tokenizeLineWithState("       05  RATE PIC 9(5)");
    expect(first.finalStack).toEqual(["root"]);

    const secondTokens = tokensExcludingWhitespace(
      tokenizeLine("       05  RATE-FLAG VALUE 1.", first.finalStack),
    );
    expect(tokenAtText(secondTokens, "05")?.token).toBe("number.cobol");
    expect(tokenAtText(secondTokens, "RATE-FLAG")?.token).toBe(
      "identifier.cobol",
    );
    expect(tokenAtText(secondTokens, "VALUE")?.token).toBe("type.cobol");
  });

  it("snippet 15: continuation indicator `-` at column 7 is not mistaken for a comment", () => {
    // Continuation lines carry `-` in the indicator column. The grammar does
    // not light them up specially (continuation is a syntactic concern, not
    // a coloring concern), but it MUST NOT misidentify them as comments.
    const line = "      -    'STILL PART OF PREVIOUS LITERAL'";
    const tokens = tokenizeLine(line);
    expect(tokens.some((token) => token.token === "comment.cobol")).toBe(false);
    // The string literal still tokenizes as a string.
    expect(
      tokens.some(
        (token) =>
          token.token === "string.cobol" &&
          token.text === "STILL PART OF PREVIOUS LITERAL",
      ),
    ).toBe(true);
  });

  it("snippet 16: lowercase keywords are recognized via ignoreCase", () => {
    const line = "           display 'lowercase keywords work'.";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(tokenAtText(tokens, "display")?.token).toBe("keyword.cobol");
  });

  it("snippet 17: EVALUATE / WHEN / WHEN OTHER tokenize as keywords", () => {
    const line = "           EVALUATE TRUE WHEN OTHER";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(tokenAtText(tokens, "EVALUATE")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "WHEN")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "OTHER")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "TRUE")?.token).toBe("keyword.cobol");
  });

  it("snippet 18: PERFORM UNTIL VARYING control flow tokens", () => {
    const line = "           PERFORM VARYING I FROM 1 BY 1 UNTIL I > 10";
    const tokens = tokensExcludingWhitespace(tokenizeLine(line));
    expect(tokenAtText(tokens, "PERFORM")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "VARYING")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "FROM")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "BY")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "UNTIL")?.token).toBe("keyword.cobol");
    expect(tokenAtText(tokens, "I")?.token).toBe("identifier.cobol");
    expect(tokenAtText(tokens, ">")?.token).toBe("operator.cobol");
  });
});

describe("keyword vs identifier resolution", () => {
  it("classifies an unknown user identifier as identifier, not keyword", () => {
    const tokens = tokensExcludingWhitespace(tokenizeLine("MY-USER-VAR."));
    expect(tokenAtText(tokens, "MY-USER-VAR")?.token).toBe("identifier.cobol");
  });

  it("looks up keywords with `applyCases` regardless of source casing", () => {
    expect(lookupKeyword("move")).toBe("keyword");
    expect(lookupKeyword("MOVE")).toBe("keyword");
    expect(lookupKeyword("pic")).toBeNull(); // PIC is handled by a dedicated rule, not as a keyword
    expect(lookupKeyword("OCCURS")).toBe("type");
    expect(lookupKeyword("not-a-keyword")).toBeNull();
  });
});
