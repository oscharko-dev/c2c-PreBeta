"use client";

import type * as MonacoNs from "monaco-editor";

import type { Monaco } from "./lazyMonaco";

export const COBOL_LANGUAGE_ID = "cobol";

// Fixed-format column boundaries. Used by both the editor's vertical rulers
// (Monaco's `rulers` option) and the legend in FixedFormatRuler.tsx.
// 1-6 sequence number area, 7 indicator, 8-11 area A, 12-72 area B,
// 73-80 identification area.
export const FIXED_FORMAT_RULER_COLUMNS = [6, 7, 11, 72, 80] as const;

// W0 subset reserved words. The grammar treats these as the primary keyword
// vocabulary, but a broader set of common COBOL constructs is included so
// that out-of-W0 source is still readable (highlighting must not break on
// PROGRAM-ID, STOP RUN, etc. even when the orchestrator declines to run
// the program). The Monarch tokenizer below uses `ignoreCase: true` so all
// keywords are matched regardless of source casing.
const KEYWORDS = [
  "ACCEPT",
  "ADD",
  "AFTER",
  "ALL",
  "ALSO",
  "AND",
  "ARE",
  "AS",
  "AT",
  "AUTHOR",
  "BEFORE",
  "BLANK",
  "BLOCK",
  "BY",
  "CALL",
  "CANCEL",
  "CLOSE",
  "COMPUTE",
  "CONFIGURATION",
  "CONTAINS",
  "CONTINUE",
  "COPY",
  "CORR",
  "CORRESPONDING",
  "DATA",
  "DATE-WRITTEN",
  "DELIMITED",
  "DEPENDING",
  "DISPLAY",
  "DIVIDE",
  "DIVISION",
  "ELSE",
  "END",
  "END-ACCEPT",
  "END-ADD",
  "END-CALL",
  "END-COMPUTE",
  "END-DISPLAY",
  "END-DIVIDE",
  "END-EVALUATE",
  "END-IF",
  "END-MULTIPLY",
  "END-PERFORM",
  "END-READ",
  "END-RETURN",
  "END-SEARCH",
  "END-START",
  "END-STRING",
  "END-SUBTRACT",
  "END-UNSTRING",
  "END-WRITE",
  "ENVIRONMENT",
  "EQUAL",
  "EVALUATE",
  "EXIT",
  "FALSE",
  "FD",
  "FILE",
  "FILE-CONTROL",
  "FILLER",
  "FROM",
  "GIVING",
  "GO",
  "GOBACK",
  "GREATER",
  "HIGH-VALUE",
  "HIGH-VALUES",
  "I-O",
  "I-O-CONTROL",
  "IDENTIFICATION",
  "IF",
  "IN",
  "INITIALIZE",
  "INPUT",
  "INPUT-OUTPUT",
  "INSPECT",
  "INSTALLATION",
  "INTO",
  "INVALID",
  "IS",
  "JUST",
  "JUSTIFIED",
  "KEY",
  "LABEL",
  "LESS",
  "LINKAGE",
  "LOW-VALUE",
  "LOW-VALUES",
  "MERGE",
  "MOVE",
  "MULTIPLY",
  "NOT",
  "OBJECT-COMPUTER",
  "OF",
  "OFF",
  "ON",
  "OPEN",
  "OR",
  "OTHER",
  "OUTPUT",
  "PARAGRAPH",
  "PERFORM",
  "PROCEDURE",
  "PROGRAM-ID",
  "QUOTE",
  "QUOTES",
  "READ",
  "RECORD",
  "REMARKS",
  "REPLACING",
  "RETURNING",
  "REWRITE",
  "RUN",
  "SD",
  "SEARCH",
  "SECTION",
  "SECURITY",
  "SELECT",
  "SENTENCE",
  "SET",
  "SIZE",
  "SORT",
  "SOURCE-COMPUTER",
  "SPACE",
  "SPACES",
  "SPECIAL-NAMES",
  "STANDARD",
  "START",
  "STOP",
  "STRING",
  "SUBTRACT",
  "TALLYING",
  "THAN",
  "THEN",
  "THROUGH",
  "THRU",
  "TIMES",
  "TO",
  "TRUE",
  "UNSTRING",
  "UNTIL",
  "UP",
  "UPON",
  "USAGE",
  "USE",
  "USING",
  "VARYING",
  "WHEN",
  "WITH",
  "WORKING-STORAGE",
  "WRITE",
  "ZERO",
  "ZEROES",
  "ZEROS",
];

// Data-declaration / type tokens. Rendered with the `type` token family so the
// theme can distinguish "this declares storage shape" from "this is a verb."
// PIC and PICTURE are intentionally NOT in this list — they are handled by a
// dedicated rule that transitions into the @picture sub-state so their
// arguments stay readable as a single token instead of fragmenting into
// number / paren / number.
const DATA_KEYWORDS = [
  "BINARY",
  "COMP",
  "COMP-1",
  "COMP-2",
  "COMP-3",
  "COMP-4",
  "COMP-5",
  "COMPUTATIONAL",
  "COMPUTATIONAL-1",
  "COMPUTATIONAL-2",
  "COMPUTATIONAL-3",
  "COMPUTATIONAL-4",
  "COMPUTATIONAL-5",
  "DISPLAY-1",
  "INDEX",
  "OCCURS",
  "PACKED-DECIMAL",
  "POINTER",
  "REDEFINES",
  "RENAMES",
  "SIGN",
  "SIGNED",
  "SYNC",
  "SYNCHRONIZED",
  "UNSIGNED",
  "VALUE",
  "VALUES",
];

export const COBOL_LANGUAGE_CONFIGURATION: MonacoNs.languages.LanguageConfiguration =
  {
    // COBOL '85 floating comment uses `*>` and runs to end of line; fixed-format
    // sources also accept `*` in column 7. Monaco's comment-toggle action uses
    // the lineComment token to insert `*> ` so we target free-format for the
    // toggle action and rely on the Monarch grammar to highlight both styles
    // at render time.
    comments: {
      lineComment: "*>",
    },
    brackets: [["(", ")"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "'", close: "'", notIn: ["string"] },
      { open: '"', close: '"', notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "'", close: "'" },
      { open: '"', close: '"' },
    ],
    wordPattern: /[A-Za-z][A-Za-z0-9-]*/,
  };

// Monarch grammar for COBOL targeting the W0 subset. Token names follow the
// vs-dark theme conventions Monaco's defineTheme uses (`keyword`, `type`,
// `comment`, `string`, `number`, `identifier`, `delimiter`) so the c2c-studio
// theme defined in monacoTheme.ts colors them without extra rules.
export const COBOL_MONARCH_LANGUAGE: MonacoNs.languages.IMonarchLanguage = {
  defaultToken: "",
  ignoreCase: true,
  tokenPostfix: ".cobol",

  keywords: KEYWORDS,
  dataKeywords: DATA_KEYWORDS,

  tokenizer: {
    root: [
      // Fixed-format comment line: column 7 holds `*` (line comment) or `/`
      // (form-feed; rendered as a comment). The `^` anchor restricts this to
      // line starts; `.{6}` consumes the sequence area; the entire line is
      // then emitted as a comment so subsequent rules never fire for
      // commented content. Must come before any free-format rule so a
      // column-7 `*` is not mistaken for a verb-introducing operator.
      [/^.{6}[*/].*$/, "comment"],

      // Fixed-format debug indicator: column 7 = `D`. Highlight just the
      // indicator marker; the code that follows is tokenized by the
      // remaining root rules so debug lines stay syntactically readable.
      [/^.{6}D /, "type"],

      // Free-format floating comment `*>` may appear anywhere on the line.
      // Matching consumes the rest of the line so subsequent rules don't
      // run for comment contents.
      [/\*>.*$/, "comment"],

      // PIC/PICTURE clause introduces a picture body whose characters
      // (9, X, A, V, S, Z, P, B, $, +, -, *, /, (n), ., ,) should render
      // as a single `type.picture` token. The dedicated @picture state
      // keeps `9(5)V99` from fragmenting across number / paren / number.
      [/\b(PIC|PICTURE)\b/, { token: "type", next: "@picture" }],

      // String literals. COBOL accepts both single- and double-quoted
      // strings; doubled-up quotes are the escape sequence.
      [/'/, { token: "string.quote", next: "@stringSingle" }],
      [/"/, { token: "string.quote", next: "@stringDouble" }],

      // Numeric literals — optional sign, optional fractional part, optional
      // exponent. Level numbers (01, 05, 77, 88) are caught by this rule as
      // well, which is intentional: they read visually as numbers and don't
      // need a separate color.
      [/[+-]?\d+(\.\d+)?([eE][+-]?\d+)?\b/, "number"],

      // Identifiers — branch on the case-insensitive keyword tables. Hyphens
      // are word-internal in COBOL so the wordPattern in languageConfiguration
      // is mirrored here.
      [
        /[A-Za-z][A-Za-z0-9-]*/,
        {
          cases: {
            "@keywords": "keyword",
            "@dataKeywords": "type",
            "@default": "identifier",
          },
        },
      ],

      // Delimiters and punctuation.
      [/[.,;:]/, "delimiter"],
      [/[()]/, "@brackets"],
      [/[+\-*/=<>]/, "operator"],

      // Whitespace.
      [/\s+/, "white"],
    ],

    stringSingle: [
      [/[^'\\]+/, "string"],
      [/''/, "string.escape"],
      [/'/, { token: "string.quote", next: "@pop" }],
    ],

    stringDouble: [
      [/[^"\\]+/, "string"],
      [/""/, "string.escape"],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],

    // Picture clause body. The @picture state is entered after matching the
    // PIC or PICTURE keyword in @root. We skip the optional `IS` preposition,
    // emit picture-character runs as a single `type.picture` token, and pop
    // back to @root on whitespace followed by a non-picture char, on the
    // statement-terminating period, or on end-of-line so subsequent tokens
    // (USAGE, VALUE, period) are tokenized by the normal rules.
    picture: [
      // Optional IS preposition between PIC and the body.
      [/\s*\bIS\b/, "type"],
      // Whitespace between PIC/IS and the picture body — keep in state.
      [/\s+/, "white"],
      // Picture-character run. Includes the full 0-9 digit range so the
      // repetition count inside `9(03)` does not fragment the picture body.
      // Excludes `.` because a trailing `.` is the statement terminator and
      // must pop back to @root for delimiter tokenization. Pictures that
      // contain a literal decimal point (rare in W0 source; COBOL uses V
      // for implied decimal) fall back to number/delimiter tokenization
      // downstream — visually correct, not unified, but never breaks the
      // rest of the line.
      [/[X9AVSPZBN0-9$+\-,/()*]+/, "type.picture"],
      // Anything else pops back to @root and is re-tokenized there.
      [/./, { token: "@rematch", next: "@pop" }],
    ],
  },
};

let registered = false;

export function registerCobolLanguage(monaco: Monaco): void {
  // Idempotent so multiple CobolEditorPane instances mounting/unmounting do
  // not re-register the language (Monaco's register is global per monaco
  // instance and re-registering would emit a "language already registered"
  // warning).
  if (registered) {
    return;
  }
  const existing = monaco.languages
    .getLanguages()
    .some((language) => language.id === COBOL_LANGUAGE_ID);
  if (!existing) {
    monaco.languages.register({
      id: COBOL_LANGUAGE_ID,
      extensions: [".cbl", ".cob", ".cpy"],
      aliases: ["COBOL", "Cobol", "cobol"],
      mimetypes: ["text/x-cobol"],
    });
  }
  monaco.languages.setLanguageConfiguration(
    COBOL_LANGUAGE_ID,
    COBOL_LANGUAGE_CONFIGURATION,
  );
  monaco.languages.setMonarchTokensProvider(
    COBOL_LANGUAGE_ID,
    COBOL_MONARCH_LANGUAGE,
  );
  registered = true;
}

export function __resetCobolRegistrationForTests(): void {
  registered = false;
}
