/**
 * Strings that MUST NOT appear in product-generated Java when a run reports
 * `status: 'generated'`. Used as a defence-in-depth check in the UI when the
 * BFF safeguard cannot be relied upon (e.g. older deployments).
 *
 * Kept in sync with `services/c2c-bff/src/placeholder-markers.ts`. Any change
 * here must be mirrored there.
 */
export const PLACEHOLDER_JAVA_MARKERS = [
  'W0-STUB',
  'Synthetic W0 generated-Java stub',
  '// TODO: implement',
  'PLACEHOLDER',
] as const;

export type PlaceholderJavaMarker = (typeof PLACEHOLDER_JAVA_MARKERS)[number];

export function findPlaceholderMarker(content: string): PlaceholderJavaMarker | null {
  for (const marker of PLACEHOLDER_JAVA_MARKERS) {
    if (content.includes(marker)) return marker;
  }
  return null;
}

export function findPlaceholderInFiles(files: Record<string, string>): { path: string; marker: PlaceholderJavaMarker } | null {
  for (const [path, content] of Object.entries(files)) {
    const marker = findPlaceholderMarker(content);
    if (marker) return { path, marker };
  }
  return null;
}
