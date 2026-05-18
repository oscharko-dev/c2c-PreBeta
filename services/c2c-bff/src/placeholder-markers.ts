/**
 * Strings that MUST NOT appear in product-generated Java when a run reports
 * `status: 'generated'`. If any of these substrings appear in the BFF-served
 * generated-Java view, the BFF downgrades the response to `incomplete` so the
 * UI cannot present a placeholder as a successful run.
 */
export const PLACEHOLDER_JAVA_MARKERS = [
  "W0-STUB",
  "Synthetic W0 generated-Java stub",
  "// TODO: implement",
  "PLACEHOLDER",
] as const;

export type PlaceholderJavaMarker = (typeof PLACEHOLDER_JAVA_MARKERS)[number];

export function findPlaceholderMarker(
  content: string,
): PlaceholderJavaMarker | null {
  for (const marker of PLACEHOLDER_JAVA_MARKERS) {
    if (content.includes(marker)) return marker;
  }
  return null;
}

export function findPlaceholderInFiles(
  files: Record<string, string>,
): { path: string; marker: PlaceholderJavaMarker } | null {
  for (const [path, content] of Object.entries(files)) {
    const marker = findPlaceholderMarker(content);
    if (marker) return { path, marker };
  }
  return null;
}
