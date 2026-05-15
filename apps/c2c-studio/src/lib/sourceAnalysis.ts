const PROGRAM_ID_PATTERN = /PROGRAM-ID\.\s*([A-Z0-9-]+)/i;

export const MAX_SOURCE_BYTES = 1_000_000;
export const DEFAULT_SOURCE_NAME = 'pasted-source.cbl';

export function deriveDetectedProgramId(sourceText: string): string | null {
  const match = PROGRAM_ID_PATTERN.exec(sourceText);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function deriveDisplayedLineEnding(sourceText: string): 'LF' | 'CRLF' | 'Mixed' {
  if (sourceText.includes('\r\n')) {
    return sourceText.includes('\n') && sourceText.replace(/\r\n/g, '').includes('\n') ? 'Mixed' : 'CRLF';
  }

  return sourceText.includes('\n') ? 'LF' : 'LF';
}

export function getSourceByteSize(sourceText: string): number {
  return new TextEncoder().encode(sourceText).byteLength;
}

export async function deriveSourceHash(sourceText: string): Promise<string> {
  if (!sourceText) {
    return '00000000';
  }

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceText));
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  }

  let fallback = 0;
  for (let index = 0; index < sourceText.length; index += 1) {
    fallback = (fallback << 5) - fallback + sourceText.charCodeAt(index);
    fallback |= 0;
  }
  return Math.abs(fallback).toString(16).padStart(8, '0').slice(0, 8);
}
