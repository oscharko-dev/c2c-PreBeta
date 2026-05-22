const PROGRAM_ID_PATTERN = /PROGRAM-ID\.\s*([A-Z0-9-]+)/i;

export const MAX_SOURCE_BYTES = 1_000_000;
export const DEFAULT_SOURCE_NAME = "pasted-source.cbl";

export function deriveDetectedProgramId(sourceText: string): string | null {
  const match = PROGRAM_ID_PATTERN.exec(sourceText);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function deriveDisplayedLineEnding(
  sourceText: string,
): "LF" | "CRLF" | "Mixed" {
  if (sourceText.includes("\r\n")) {
    return sourceText.includes("\n") &&
      sourceText.replace(/\r\n/g, "").includes("\n")
      ? "Mixed"
      : "CRLF";
  }

  return sourceText.includes("\n") ? "LF" : "LF";
}

export function getSourceByteSize(sourceText: string): number {
  return new TextEncoder().encode(sourceText).byteLength;
}

export async function deriveSourceHash(sourceText: string): Promise<string> {
  if (!sourceText) {
    return "00000000";
  }

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sourceText),
    );
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  let fallback = 0;
  for (let index = 0; index < sourceText.length; index += 1) {
    fallback = (fallback << 5) - fallback + sourceText.charCodeAt(index);
    fallback |= 0;
  }
  return Math.abs(fallback).toString(16).padStart(8, "0").slice(0, 8);
}

export interface DraftProgramIdInput {
  parserProgramId?: string | null;
  detectedProgramId?: string | null;
  sourceName: string;
  normalizedPath?: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export async function deriveDraftProgramId({
  parserProgramId,
  detectedProgramId,
  sourceName,
  normalizedPath,
}: DraftProgramIdInput): Promise<string | null> {
  const parserId = nonEmpty(parserProgramId);
  if (parserId) return parserId;

  const path = nonEmpty(normalizedPath);
  if (path) {
    return (await deriveLengthPrefixedSha256Hex(sourceName, path)).slice(0, 32);
  }

  const localProgramId = nonEmpty(detectedProgramId);
  if (localProgramId) return localProgramId;

  return null;
}

async function deriveLengthPrefixedSha256Hex(
  sourceName: string,
  normalizedPath: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const sourceBytes = encoder.encode(sourceName);
  const pathBytes = encoder.encode(normalizedPath);
  const buffer = new ArrayBuffer(
    4 + sourceBytes.byteLength + 4 + pathBytes.byteLength,
  );
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);
  let offset = 0;
  view.setUint32(offset, sourceBytes.byteLength, false);
  offset += 4;
  out.set(sourceBytes, offset);
  offset += sourceBytes.byteLength;
  view.setUint32(offset, pathBytes.byteLength, false);
  offset += 4;
  out.set(pathBytes, offset);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "SubtleCrypto is unavailable; draft SourceKey fallback cannot be derived.",
    );
  }
  const digest = await subtle.digest("SHA-256", out);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
