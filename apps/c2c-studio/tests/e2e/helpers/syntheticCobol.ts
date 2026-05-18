// Studio-IDE-12 (#250) perf-harness helper: produce a deterministic
// synthetic COBOL program at a requested line count.
//
// Used by the perf + memory harnesses to load 5k / 10k line buffers
// without committing megabyte-scale fixtures to the repo. The program
// stays inside the W0 supported COBOL subset (PIC, MOVE, DISPLAY,
// PERFORM) so the Studio's tokenizer, IR parser, and verifier all
// recognise it as a valid input.
//
// Layout:
//   * IDENTIFICATION DIVISION (5 lines).
//   * DATA DIVISION with a single WORKING-STORAGE record (5 lines).
//   * PROCEDURE DIVISION with `targetLines - 10` body lines, each one
//     emitting a MOVE / DISPLAY / PERFORM pair scaled so the line
//     count lands within ±1 of the request.

export interface SyntheticCobolOptions {
  /** Number of source lines the returned program should contain. */
  targetLines: number;
  /** PROGRAM-ID — defaults to PERF01. Must be 1-8 alphanumeric chars. */
  programId?: string;
}

const HEADER_LINES = (programId: string): string[] => [
  "       IDENTIFICATION DIVISION.",
  `       PROGRAM-ID. ${programId}.`,
  "       DATA DIVISION.",
  "       WORKING-STORAGE SECTION.",
  "       01  WS-COUNTER       PIC 9(4) VALUE 0.",
];

const PROCEDURE_HEADER: string[] = [
  "       PROCEDURE DIVISION.",
  "       MAIN-PARAGRAPH.",
];

const FOOTER_LINES: string[] = ["           STOP RUN.", "       END PROGRAM."];

export function buildSyntheticCobol(options: SyntheticCobolOptions): string {
  const { targetLines } = options;
  const programId = (options.programId ?? "PERF01").toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(programId)) {
    throw new Error(
      "programId must be 1-8 alphanumeric characters starting with a letter",
    );
  }
  if (!Number.isInteger(targetLines) || targetLines < 100) {
    throw new Error("targetLines must be an integer >= 100");
  }
  const header = HEADER_LINES(programId);
  const overhead =
    header.length + PROCEDURE_HEADER.length + FOOTER_LINES.length;
  const bodyLines: string[] = [];
  const desiredBody = Math.max(0, targetLines - overhead);
  for (let i = 0; i < desiredBody; i += 1) {
    // Cycle through three deterministic statements so the source
    // exercises MOVE, ADD, and DISPLAY token paths.
    const variant = i % 3;
    if (variant === 0) {
      bodyLines.push(`           MOVE ${(i % 9999) + 1} TO WS-COUNTER.`);
    } else if (variant === 1) {
      bodyLines.push("           ADD 1 TO WS-COUNTER.");
    } else {
      bodyLines.push("           DISPLAY WS-COUNTER.");
    }
  }
  return [...header, ...PROCEDURE_HEADER, ...bodyLines, ...FOOTER_LINES].join(
    "\n",
  );
}

export function countLines(source: string): number {
  if (source.length === 0) return 0;
  return source.split("\n").length;
}
