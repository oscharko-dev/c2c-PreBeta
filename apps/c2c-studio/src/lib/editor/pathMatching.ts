export function pathSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean);
}

export function pathBasename(value: string): string {
  const segments = pathSegments(value);
  return (segments.at(-1) ?? value).toLowerCase();
}

export function pathSuffixMatches(left: string, right: string): boolean {
  const a = pathSegments(left);
  const b = pathSegments(right);
  if (a.length === 0 || b.length === 0) return false;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i += 1) {
    if (a[a.length - 1 - i] !== b[b.length - 1 - i]) return false;
  }
  return true;
}
