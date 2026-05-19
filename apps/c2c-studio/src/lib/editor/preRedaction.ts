// Studio-IDE-10 (#249): Studio-side pre-redaction (defense in depth per
// ADR 0005 §4 Decision 4). The Model Gateway remains authoritative;
// this layer trims obvious sensitive tokens before they leave the
// client so the ledger entry records exactly what was sent to the
// model.
//
// Pattern hygiene (ADR 0005 §4 "ReDoS hygiene"):
//   1. No backreferences.
//   2. No nested quantifiers.
//   3. Bounded repetition only.
//   4. The pattern set is reviewed line-by-line in this file; new
//      additions require a paired test in ``preRedaction.test.ts``.

export const STUDIO_REDACTION_PROFILE_VERSION = "v1.1.0" as const;

interface RedactionPattern {
  readonly id: string;
  readonly regex: RegExp;
}

export interface StudioRedactionPatternAddition {
  readonly id: string;
  readonly literal: string;
}

const TENANT_ADDITION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,96}$/u;
const MAX_TENANT_ADDITION_LITERAL_CHARS = 256;

// IDs are stable strings shared with the BFF + ledger; keep them sorted
// alphabetically within each group so a diff is easy to read.
//
// Pattern application order is load-bearing:
//
//   1. PII comment lines are stripped first (whole-line erasure).
//   2. Field-name fragments are next so identifier tokens (which look
//      structurally like BICs in some cases — e.g. CUSTOMERN inside
//      CUSTOMER-NAME) are removed before BIC and IBAN scan.
//   3. SSN, IBAN, BIC scan last because their patterns are the most
//      specific and least likely to false-positive on already-redacted
//      text.
const RAW_PATTERNS: ReadonlyArray<RedactionPattern> = [
  // COBOL comment convention `* PII: …` (column-6 indicator). We match
  // the indicator plus the rest of the line; the redaction replaces
  // the entire textual content but keeps the newline boundary.
  {
    id: "pii-comment-line",
    regex: /(^|\n)[ \t]{0,80}\*[ \t]*PII:[^\n]{0,4096}/g,
  },
  // Field-name regex class. Each pattern targets a fragment the field
  // name commonly carries — the rule of thumb is that COBOL data names
  // separate tokens with `-` and the user-known abbreviation is the
  // load-bearing identifier (e.g. ACCT-NO appearing as a sub-field of
  // CUSTOMER-RECORD must still match). All patterns use word
  // boundaries plus a closed alternation so they are bounded.
  {
    id: "field-name-class:account-number",
    regex: /\b(?:ACCT-NO|ACCOUNT-NUMBER)\b/gi,
  },
  {
    id: "field-name-class:card-number",
    regex: /\b(?:CARD-NO|CARD-NUMBER)\b/gi,
  },
  {
    id: "field-name-class:customer-name",
    regex: /\b(?:CUSTOMER-NAME|CUST-NM)\b/gi,
  },
  {
    id: "field-name-class:dob",
    regex: /\b(?:DOB|DATE-OF-BIRTH)\b/gi,
  },
  {
    id: "field-name-class:email",
    regex: /\bEMAIL\b/gi,
  },
  {
    id: "field-name-class:national-id",
    regex: /\b(?:NATIONAL-ID|NATIONAL-IDENTIFIER)\b/gi,
  },
  {
    id: "field-name-class:phone",
    regex: /\b(?:PHONE|PHONE-NO|PHONE-NUMBER)\b/gi,
  },
  {
    id: "field-name-class:social-security",
    regex: /\b(?:SOCIAL-SECURITY|SSN)\b/gi,
  },
  {
    id: "field-name-class:tax-id",
    regex: /\b(?:TAX-ID|TAX-IDENTIFIER)\b/gi,
  },
  // US SSN — three / two / four digits, dashes required so we do not
  // false-positive on bare phone numbers or COBOL literals.
  {
    id: "ssn-us",
    regex: /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/g,
  },
  // International Bank Account Number — 2-letter country code, 2 check
  // digits, then 11..30 alphanumerics. The lower bound is the shortest
  // real IBAN BBAN portion (Norway, 11 chars).
  {
    id: "iban-eu",
    regex: /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\b/g,
  },
  // Bank Identifier Code — ISO 9362. To avoid false-positives on COBOL
  // identifiers that look like 8 uppercase letters, BIC requires an
  // explicit ``BIC`` keyword cue in the surrounding context. The cue
  // matches `BIC<sep><code>` where the separator is one of `: = `;
  // the code itself is 8 or 11 alphanumerics with bank+country shape.
  {
    id: "bic",
    regex:
      /\bBIC[ \t]*[:=]?[ \t]*([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/g,
  },
  // v1.1.0 additions (defense-in-depth, ADR 0005 §4):
  // Email addresses — local part up to 64 chars, domain up to 253, TLD 2-24.
  // ReDoS-clean: no backreferences, no nested quantifiers, bounded repetition.
  {
    id: "email-literal",
    regex: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g,
  },
  // E.164 phone numbers — leading + followed by 7 to 15 digits.
  {
    id: "phone-e164",
    regex: /\+\d{7,15}\b/g,
  },
  // Payment card numbers — 15 to 19 consecutive digits. Luhn check is NOT
  // applied; false-positive risk is acceptable for defense-in-depth. The
  // Model Gateway pass is authoritative.
  {
    id: "pan-15-19",
    regex: /\b\d{15,19}\b/g,
  },
  // IPv4 literals — four dot-separated 1-to-3-digit groups.
  {
    id: "ipv4-literal",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },
];

export interface RedactionResult {
  redactedText: string;
  matchedPatternIds: string[];
  profileVersion: typeof STUDIO_REDACTION_PROFILE_VERSION;
}

// Apply all patterns to ``rawText`` and return the redacted text plus the
// set of pattern ids that matched. The order is left-to-right (pattern
// list order, which is alphabetical within the BIC/IBAN/PII/SSN block
// and alphabetical within the field-name block). The pattern list is
// flattened so the iteration order is deterministic across calls.
export function redactRegion(
  rawText: string,
  tenantAdditions: readonly StudioRedactionPatternAddition[] = [],
): RedactionResult {
  let working = rawText;
  const matched = new Set<string>();
  for (const pattern of [
    ...RAW_PATTERNS,
    ...buildTenantAdditionPatterns(tenantAdditions),
  ]) {
    // Reset lastIndex defensively even though each RegExp is its own
    // instance — guards against accidental sharing in future
    // refactors.
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(working)) {
      matched.add(pattern.id);
      pattern.regex.lastIndex = 0;
      working = working.replace(pattern.regex, (match) => {
        // PII comment lines preserve a leading newline so the
        // surrounding source layout stays readable.
        if (pattern.id === "pii-comment-line" && match.startsWith("\n")) {
          return `\n[REDACTED:${pattern.id}]`;
        }
        return `[REDACTED:${pattern.id}]`;
      });
    }
  }
  const matchedPatternIds = Array.from(matched).sort();
  return {
    redactedText: working,
    matchedPatternIds,
    profileVersion: STUDIO_REDACTION_PROFILE_VERSION,
  };
}

function buildTenantAdditionPatterns(
  additions: readonly StudioRedactionPatternAddition[],
): RedactionPattern[] {
  const patterns: RedactionPattern[] = [];
  for (const addition of additions) {
    const id = addition.id.trim();
    const literal = addition.literal.trim();
    if (
      !TENANT_ADDITION_ID_PATTERN.test(id) ||
      literal.length === 0 ||
      literal.length > MAX_TENANT_ADDITION_LITERAL_CHARS
    ) {
      continue;
    }
    patterns.push({
      id,
      regex: new RegExp(escapeRegExp(literal), "g"),
    });
  }
  return patterns;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Encode the UTF-8 bytes of ``value``. Wrapping the platform API in a
// named helper keeps tests independent of jsdom's globals.
export function textEncoderToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

// SHA-256 hex digest of the UTF-8 bytes of ``value``. Implemented via
// Web Crypto so the same primitive works in the editor pane and in the
// jsdom test environment (Node ≥18 ships ``crypto.subtle``).
export async function computeSha256Hex(value: string): Promise<string> {
  const bytes = textEncoderToBytes(value);
  const subtle = resolveSubtleCrypto();
  // ``TextEncoder.encode`` is typed as ``Uint8Array<ArrayBufferLike>`` in
  // TS 5.7+ — the union includes ``SharedArrayBuffer``, which
  // ``SubtleCrypto.digest`` rejects. We cast through ``ArrayBufferView``
  // so the type system accepts the call; the runtime contract is
  // unchanged because ``TextEncoder`` never returns a shared buffer.
  const digest = await subtle.digest(
    "SHA-256",
    bytes as ArrayBufferView<ArrayBuffer>,
  );
  return bytesToHex(new Uint8Array(digest));
}

function resolveSubtleCrypto(): SubtleCrypto {
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.subtle !== "undefined"
  ) {
    return globalThis.crypto.subtle;
  }
  throw new Error(
    "SubtleCrypto is unavailable; SHA-256 cannot be computed in this environment.",
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
