// Studio-IDE-8 (#253): parse JVM stack traces and resolve each frame's
// generated-Java location to the underlying COBOL line via the Slice 6
// (#248) traceability envelope and inline IR anchors.
//
// The parser is regex-driven and independently testable. Resolution is
// async because it needs (a) the traceability envelope (cached per
// runId) and (b) the Java source text for each referenced file in order
// to find the nearest preceding inline IR anchor. The Java source is
// supplied by an injectable provider so tests stay free of network I/O.

import { fetchTraceability, type ParsedTrace } from "./traceParser";
import { resolveJavaToCobol } from "./lineageNavigation";

// JVM stack-frame regex per Studio-IDE-8 issue body.
//   Group 1: fully-qualified class (supports inner classes via `$` and
//            lambda hosts like `Foo$Bar`)
//   Group 2: method name (supports `<init>`, `<clinit>`, and
//            `lambda$method$0`)
//   Group 3: source file (typically `Foo.java`; the JVM may also emit
//            `Foo.kt`, `Foo$Inner.java`, etc.)
//   Group 4: 1-based line number
const FRAME_REGEX = /^\s*at\s+([\w.$]+)\.([\w$<>]+)\(([\w$.]+):(\d+)\)/;

export interface ParsedStackFrame {
  /** The raw line as it appeared in the trace (whitespace preserved). */
  frameRaw: string;
  /** Fully-qualified class name (`com.example.Foo$Bar`). */
  className: string;
  /** Method name (`bar`, `<init>`, `lambda$baz$0`). */
  methodName: string;
  /** Source file name as the JVM emitted it (e.g. `Foo.java`). */
  javaFile: string;
  /** 1-based line number in the source file. */
  javaLine: number;
}

export interface ResolvedStackFrame extends ParsedStackFrame {
  /**
   * Full path of the Java file inside the run's generated artifacts
   * (e.g. `src/main/java/com/example/Foo.java`). Present whenever the
   * lineage envelope knows about a region for this frame's file; absent
   * if no path-suffix match exists. The view layer uses this to focus
   * the Java editor pane.
   */
  javaFilePath?: string;
  /**
   * COBOL target for this frame. Present only when the lineage envelope
   * resolved the frame to a deterministic / agent_proposed /
   * repair_attempted region with a usable inline IR anchor. Absent for
   * non-resolvable frames (manual_only, stale_manual_edit, no_mapping,
   * envelope missing, or Java source unavailable).
   */
  cobol?: { file: string; line: number };
}

/**
 * Supplier for Java source text keyed by the full path inside the run's
 * generated artifacts. Production callers wire this to
 * `apiClient.getGeneratedFile`; tests pass an in-memory map.
 * Returning `null` means the source is unavailable — the corresponding
 * frame stays non-resolvable.
 */
export type JavaSourceProvider = (
  javaFilePath: string,
) => Promise<string | null>;

/**
 * Parse a raw JVM stack trace into one ParsedStackFrame per matching
 * `at` line. Non-frame lines (header text, native-method frames,
 * `... 12 more`) are silently skipped — the caller still owns the raw
 * trace and may render it via a toggle.
 */
export function parseStackTrace(raw: string): ParsedStackFrame[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }
  const frames: ParsedStackFrame[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const match = FRAME_REGEX.exec(line);
    if (!match) continue;
    const javaLine = Number.parseInt(match[4], 10);
    if (!Number.isFinite(javaLine) || javaLine < 1) continue;
    frames.push({
      frameRaw: line,
      className: match[1],
      methodName: match[2],
      javaFile: match[3],
      javaLine,
    });
  }
  return frames;
}

/**
 * Match a short file name (`Foo.java`) against a full generated path
 * (`src/main/java/com/example/Foo.java`) by aligning a contiguous
 * suffix of full path segments. Mirrors the convention used by
 * `markerNavigation.pathMatches` so cross-pane navigation stays
 * consistent.
 */
function pathSuffixMatches(short: string, full: string): boolean {
  const aParts = short.split(/[\\/]+/).filter(Boolean);
  const bParts = full.split(/[\\/]+/).filter(Boolean);
  if (aParts.length === 0 || bParts.length === 0) return false;
  const minLen = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < minLen; i += 1) {
    if (aParts[aParts.length - 1 - i] !== bParts[bParts.length - 1 - i]) {
      return false;
    }
  }
  return true;
}

function findJavaFilePath(
  parsed: ParsedTrace,
  shortFile: string,
): string | null {
  const keys = [...parsed.javaRegionClassification.keys()];
  if (keys.length === 0) return null;
  if (keys.includes(shortFile)) return shortFile;
  for (const key of keys) {
    if (pathSuffixMatches(shortFile, key)) return key;
  }
  return null;
}

/**
 * Resolve parsed frames against the run's lineage envelope. Returns one
 * ResolvedStackFrame per input frame in the same order. Frames the
 * envelope cannot resolve carry no `cobol` field; the caller renders
 * those as inactive with an explanatory tooltip.
 *
 * If the envelope fetch fails (404, network, etc.), every frame is
 * returned without a `cobol` field — the view degrades gracefully to a
 * frame-row list with no clickable links.
 */
export async function mapStackFrames(
  runId: string,
  frames: readonly ParsedStackFrame[],
  sourceProvider: JavaSourceProvider,
  fetcher?: typeof fetch,
): Promise<ResolvedStackFrame[]> {
  if (frames.length === 0) return [];
  let envelope: ParsedTrace | null;
  try {
    envelope = await fetchTraceability(runId, fetcher);
  } catch {
    envelope = null;
  }
  if (!envelope) {
    return frames.map((frame) => ({ ...frame }));
  }
  const sourceCache = new Map<string, string | null>();
  const pathCache = new Map<string, string | null>();
  const out: ResolvedStackFrame[] = [];
  for (const frame of frames) {
    let javaFilePath = pathCache.get(frame.javaFile);
    if (javaFilePath === undefined) {
      javaFilePath = findJavaFilePath(envelope, frame.javaFile);
      pathCache.set(frame.javaFile, javaFilePath);
    }
    if (!javaFilePath) {
      out.push({ ...frame });
      continue;
    }
    let source = sourceCache.get(javaFilePath);
    if (source === undefined) {
      try {
        source = await sourceProvider(javaFilePath);
      } catch {
        source = null;
      }
      sourceCache.set(javaFilePath, source);
    }
    if (!source) {
      out.push({ ...frame, javaFilePath });
      continue;
    }
    let resolved: Awaited<ReturnType<typeof resolveJavaToCobol>>;
    try {
      resolved = await resolveJavaToCobol(
        runId,
        javaFilePath,
        frame.javaLine,
        source,
        fetcher,
      );
    } catch {
      out.push({ ...frame, javaFilePath });
      continue;
    }
    if (resolved.ok) {
      out.push({
        ...frame,
        javaFilePath,
        cobol: {
          file: resolved.target.cobolFile,
          line: resolved.target.cobolLine,
        },
      });
    } else {
      out.push({ ...frame, javaFilePath });
    }
  }
  return out;
}
