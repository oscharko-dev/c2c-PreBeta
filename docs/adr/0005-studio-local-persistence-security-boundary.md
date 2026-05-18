# ADR 0005: Studio Local Persistence and Editor Security Boundary

**Date:** 2026-05-18
**Status:** Accepted

## Context

Epic [#239](https://github.com/oscharko-dev/c2c-PreBeta/issues/239)
introduces IndexedDB-backed draft persistence for the C2C Studio
editor (Studio-IDE-3, [#247](https://github.com/oscharko-dev/c2c-PreBeta/issues/247))
plus two related editor surfaces — the Editor-Assist channel
(Studio-IDE-10, governed by
[ADR 0004](0004-studio-editor-assist-channel.md))
and Monaco hover content (Studio-IDE-5/9). C2C is positioned for
regulated banking and insurance customers per the
[c2c Fachkonzept](../concept/c2c-fachkonzept.md). COBOL sources can
carry personally identifying data, business rules, account schemas,
and other sensitive material. Persisting that to client-side storage
without an explicit policy is a compliance and security risk; rich
markdown in hovers is a classic DOM-XSS sink; sending region payloads
to a model is a leak vector unless redaction is explicit.

This ADR settles **seven sub-decisions** so Studio-IDE-3 can begin
implementation without remaining policy ambiguity. Implementation
itself remains the responsibility of the named child issues.

Verified current state of `apps/c2c-studio`:

- `apps/c2c-studio/next.config.mjs` has no Content-Security-Policy
  today.
- `apps/c2c-studio/src/stores/sourceWorkspace.tsx` is in-memory React
  context. Drafts are lost on reload. There is no IndexedDB usage.
- The Studio runtime has no `tenantId` or `userId` in scope yet.
  Adding them is a hard prerequisite for the persistence module.

## Decision

### 1. Draft TTL

**14 days** from the **last write or explicit touch on open** of the
draft. Configurable per tenant via runtime config with a **hard
ceiling of 90 days**. Silent purge on next Studio start when the
draft is past its `ttlExpiresAt`. The persistence module emits a
single non-blocking UI toast on session start summarising the
purged-count so users learn their drafts age out without being
interrupted.

TTL is anchored on **write or open**, not on Monaco `onChange`
keystrokes, to avoid an IndexedDB write storm.

### 2. Encryption at Rest

**Option B — AES-GCM via Web Crypto API.** Drafts are encrypted at
rest in IndexedDB. The encryption key is derived in-memory at session
start and never persisted.

Key derivation procedure:

- **Input keying material (IKM)**: a **dedicated draft-key wrapping
  secret** issued by the BFF in the body of `POST /api/v0/session/bootstrap`
  at session start. It is **distinct from the authentication cookie**
  so the cookie remains `HttpOnly` per the security checklist. Studio
  holds the wrapping secret in memory only — it is never written to
  storage, never logged, and never transmitted back to the server. On
  logout or tab close it is dropped; on the next sign-in the BFF issues
  a fresh value, which is why drafts encrypted under the previous value
  become unreadable.
- **Salt**: `SHA-256(u32be(len(tenantId)) || tenantId || u32be(len(userId)) || userId)`,
  where `u32be(n)` is the 32-bit big-endian byte representation of the
  UTF-8 byte length of the following field. Length-prefix domain
  separation prevents the variable-length-concatenation ambiguity
  whereby `(tenantId="ab", userId="c")` and `(tenantId="a", userId="bc")`
  would otherwise hash to the same value.
- **Info**: the constant ASCII string `"c2c-studio-draft-v1"`. Versions
  the derivation so a future v2 procedure does not collide with v1.
- **Algorithm**: HKDF-SHA-256 → 256-bit AES-GCM key.

Encryption record shape:

```ts
type EncryptedDraft = {
  iv: Uint8Array; // 96-bit random per record
  ciphertext: Uint8Array; // includes AES-GCM AEAD tag
  savedAt: string; // ISO-8601
  ttlExpiresAt: string; // ISO-8601
  schemaVersion: 1;
};
```

The IV is **96-bit random per record**. AES-GCM IV reuse with the
same key catastrophically breaks confidentiality, so the module must
never derive an IV from any deterministic input.

**Session expiry mid-edit** is treated as a defined state, not a
bug. On a save attempt with an expired session:

1. The persistence module raises `SessionExpiredDuringEdit`.
2. Studio prompts re-authentication without discarding the in-memory
   buffer.
3. After re-authentication the BFF issues a fresh draft-key wrapping
   secret; HKDF derives a new key; **drafts encrypted under the
   previous key become unreadable** and age out via TTL.

This is the intended behaviour: drafts are local working copies, not
durable artifacts. Durable work belongs in the server-side artifact
store.

### 3. `sourceKey` Composition

```ts
type SourceKey = {
  tenantId: string;
  userId: string;
  programId: string;
  sourceName: string;
};
```

Stored as the IndexedDB record key (plaintext — see Consequences).

**`tenantId` and `userId` are opaque pseudonymous identifiers** —
typically UUIDs or random opaque strings minted by the BFF at the
identity layer. They are **not** raw email addresses, employee IDs,
or any other identifier that itself carries PII. The mapping from
pseudonym to real identity lives server-side only. This requirement
reconciles the necessarily plaintext IndexedDB index keys with the
security checklist rule that no PII is stored unencrypted at rest.
The Studio runtime must reject a bootstrap response in which either
identifier contains an `@` character or whitespace, as a defensive
check against accidental email leakage.

Both identifiers come from the Studio session context that the BFF
must inject at bootstrap (see _Named prerequisite_ below).

**`programId` fallback chain** (first non-empty wins):

1. Stable identifier emitted by the parser/IR for the loaded source.
2. `sha256(u32be(len(sourceName)) || sourceName || u32be(len(normalizedPath)) || normalizedPath)`
   truncated to 16 hex bytes. The length-prefix encoding prevents the
   ambiguity whereby `(sourceName="ab", normalizedPath="c")` and
   `(sourceName="a", normalizedPath="bc")` would otherwise hash to
   the same value.
3. _Never_ fall back to `sourceName` alone — different paths with
   the same filename would collide across drafts.

### 4. AI-Explain Payload Pre-Redaction

**Option B — defense in depth.** Studio runs a redaction pass on the
selected region **before** sending. The Model Gateway runs an
authoritative pass on receive. Both write to the redaction log; the
Editor-Assist response surfaces `redactedFields[]` per
[ADR 0004](0004-studio-editor-assist-channel.md).

**Order of operations** (load-bearing):

1. User selects region.
2. Studio applies the configured redaction patterns to the region
   bytes, producing redacted bytes.
3. Studio computes `byteHash = sha256(redactedBytes)`.
4. Studio submits redacted bytes + `byteHash` to the BFF. The ledger
   entry records exactly what left the client.

**Redaction pattern source**:

- A **hard-coded baseline** compiled into the Studio bundle: SSN, IBAN,
  and BIC patterns plus lines beginning with `* PII:` (COBOL comment
  convention). The baseline is part of the bundle on purpose — a
  remotely mutable redaction list is itself an attack surface.
- **Per-tenant additions** delivered by the BFF at session start and
  cached for the session. Additions **augment** the baseline; they
  cannot remove or weaken it.

**ReDoS hygiene**: redaction regexes must (a) avoid backreferences,
(b) avoid nested quantifiers, (c) use bounded repetition, and (d) be
listed in a single registry file reviewed by hand. Adopting an
`re2`-style engine is a named follow-up.

**Gateway remains authoritative.** Studio redaction is best-effort
early defense. A future maintainer must not read "defense in depth"
and remove the Gateway pass.

### 5. Hover Markdown Sanitization

All Monaco hover content (diagnostic messages, lineage tooltips,
COBOL knowledge hovers) renders as `MarkdownString` with `isTrusted: false`
and passes through a two-stage sanitizer.

**Sanitization pipeline**:

1. Markdown source → renderer with HTML pass-through **disabled**.
2. Rendered HTML → **DOMPurify** with the allow-list below.
3. Result → Monaco.

**Allow-list**:

| Element                                  | Notes                                    |
| ---------------------------------------- | ---------------------------------------- |
| `p`, `br`, `strong`, `em`, `code`, `pre` | Inline markdown emphasis and code blocks |
| `a`                                      | href schema restricted (see below)       |
| `ul`, `ol`, `li`                         | Lists                                    |

**`href` schema allow-list**:

- relative anchors (`#…`),
- relative paths (`./…`, `../…`),
- an explicit configured https prefix (set per deployment, default to
  the repository URL),
- **nothing else**. `javascript:`, `data:`, `vbscript:`, `mailto:`,
  and absolute `http://` are stripped.

DOMPurify hook enforces `target="_blank"` always carries `rel="noopener noreferrer"`.
`isTrusted: false` is necessary but not sufficient: it blocks Monaco
command URIs but does not strip inline `<script>` or `onerror`
handlers — DOMPurify is the load-bearing stage.

**Sanitizer applies to every hover source without exception**,
including any future BFF-proxied LLM output.

**E2E acceptance** (per Epic acceptance criteria): the following
payloads render as text or are stripped, never executed (rendered in
a fenced block so document link-checkers do not try to follow them):

```text
<script>alert(1)</script>
[x](javascript:alert(1))
[x](data:text/html,...)
<img src=x onerror=alert(1)>
[x](vbscript:...)
```

### 6. CSP Compatibility

CSP is set in `apps/c2c-studio/next.config.mjs` via `headers()` so
the policy ships with every response and is reviewable in version
control alongside the rest of the Next.js config.

**Production CSP** (additive over today's empty baseline):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
worker-src 'self' blob:;
connect-src 'self' <bff-origin-from-config>;
img-src 'self' data:;
font-src 'self' data:;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
report-uri /api/v0/csp-report;
```

- **No `unsafe-eval`.** Monaco does not require it post-AMD removal.
- **`style-src 'unsafe-inline'`** is accepted for V1 because Monaco
  injects theming styles. Removing it requires nonce-based CSP — named
  follow-up.
- **`worker-src 'self' blob:`** covers Monaco's worker bootstrap,
  which loads worker chunks as `blob:` URLs through
  `MonacoEnvironment.getWorker` returning `new Worker(new URL(...), { type: 'module' })`.
  If a future bundler swap moves workers to same-origin scripts,
  `blob:` may be dropped — keep CSP and bootstrap in lockstep.
- **`connect-src`**: the BFF origin is a config value, not a literal,
  to support per-environment overrides.
- **`report-uri`**: a BFF endpoint that logs violations server-side.
  CSP without reporting is blind.

**Dev mode**: Next.js dev server requires `'unsafe-eval'` for HMR.
The production CSP is applied only in `process.env.NODE_ENV === 'production'`
builds; dev builds omit `'unsafe-eval'` exclusion via the same
`headers()` branch.

**Future end state** (not committed in this ADR): nonce-based
`script-src` and `style-src`, plus `require-trusted-types-for 'script'`.

### 7. "Clear Local Drafts" UI Action

- **Location**: Studio top-bar overflow menu.
- **Enablement**: enabled only when a user is signed in. When logged
  out, the menu item is disabled with tooltip _"Sign in to manage
  local drafts."_
- **Confirmation modal**: copy must include the live row count and
  the human-readable scope, e.g. _"Clear N drafts for {userEmail} on
  {tenantName}?"_. Tenant **name** is shown, not the opaque
  `tenantId`.
- **Effect**: synchronously removes all drafts (including
  expired-but-not-yet-purged rows) for the current `(tenantId, userId)`
  scope. The shown count must match what is actually purged.
- **Audit**: emits a telemetry event `editor.drafts.cleared` carrying
  `{ tenantId, userId, purgedCount, timestamp }`. No draft contents
  are logged.

## `editorPersistence` Module Pseudo-API

```ts
type SourceKey = {
  tenantId: string;
  userId: string;
  programId: string;
  sourceName: string;
};

type PersistenceError =
  | "SessionExpiredDuringEdit"
  | "CryptoUnavailable"
  | "QuotaExceeded"
  | "CorruptDraft";

interface EditorPersistence {
  isAvailable(): Promise<boolean>;

  saveDraft(
    key: SourceKey,
    content: string,
  ): Promise<{ encryptedSize: number; ttlExpiresAt: string }>;

  loadDraft(
    key: SourceKey,
  ): Promise<{ content: string; isExpired: boolean; savedAt: string } | null>;

  touch(key: SourceKey): Promise<{ ttlExpiresAt: string }>;

  purgeExpired(): Promise<{ purgedCount: number }>;

  clearAll(scope: {
    tenantId: string;
    userId: string;
  }): Promise<{ purgedCount: number }>;
}
```

**Behavioural contract**:

- `isAvailable` returns `false` if Web Crypto is unavailable. The
  UI shows a _"Drafts unavailable: your browser does not support
  secure storage."_ banner and disables save.
- `saveDraft` rejects with `CryptoUnavailable` if called when
  `isAvailable` is false, `SessionExpiredDuringEdit` if the key
  derivation cannot produce a current key, and `QuotaExceeded` on
  `QuotaExceededError` from IndexedDB. Never silently drop a save.
- `loadDraft` performs the silent purge for an expired record and
  returns `null`. Expired records are not surfaced to callers.
- `touch` updates `ttlExpiresAt` to `now + 14d` (or tenant override,
  capped at 90d).
- `clearAll` takes the scope **explicitly** — the module does not
  read session state directly. Zero ambient authority.
- `CorruptDraft` (decryption failure) is treated as missing: log
  with no contents, return `null` from `loadDraft`.

## Security Review Checklist

This PR also lands [docs/governance/security-review-checklist.md](../governance/security-review-checklist.md)
covering CSP delta, hover sanitization, IndexedDB/storage encryption,
PII redaction, secret handling, worker source policy, third-party
script additions, `dangerouslySetInnerHTML` audit, regex review for
ReDoS, and telemetry-PII review. Future Studio PRs check boxes
against it.

## Rationale

**Why TTL anchored on write/open, not onChange.** onChange is a
keystroke firehose. Anchoring TTL on it would couple disk-write
cadence to typing rate and produce an unnecessary IndexedDB write
storm. Write-and-open keeps the touch contract aligned with user
intent.

**Why AES-GCM with HKDF over a draft-key wrapping secret.** This
posture satisfies the regulated-customer compliance need (drafts
unreadable post logout) without requiring a server-side key escrow
service. AES-GCM provides both confidentiality and AEAD integrity in
one step; HKDF-SHA-256 produces a uniformly distributed key from the
wrapping secret without exposing the secret to the cryptographic
primitive directly. Web Crypto availability is now ubiquitous on
modern browsers; the explicit `isAvailable` check covers degraded
environments cleanly.

**Why a dedicated draft-key wrapping secret rather than the auth
token.** The security checklist requires authentication cookies to be
`HttpOnly`, which means Studio JavaScript cannot read the auth
material. Using the auth token as HKDF input would either make the
persistence path unimplementable under the compliant cookie posture
or force the bearer token into JS scope, where any editor XSS could
exfiltrate it. A separate secret delivered in the bootstrap response
body is held in memory only for the lifetime of the page, scoped to
draft encryption, and rotated on every sign-in. It is **not** an
authentication credential; if leaked it grants the attacker no API
access, only the ability to decrypt local drafts on the user's
device — which an attacker with disk access could pursue by other
means anyway.

**Why hard-coded redaction baseline.** A remotely mutable redaction
list is itself an attack surface — compromise the config endpoint,
disable redaction. Bundle-shipped baselines require a Studio release
to change, which is acceptable because (a) the Model Gateway pass is
authoritative, (b) Studio releases are frequent, (c) tenant-specific
additions still cover the per-customer needs.

**Why a two-stage hover sanitizer.** `isTrusted: false` blocks Monaco
command URIs but does not strip inline HTML in markdown source. A
markdown renderer with HTML pass-through disabled prevents inline
script injection at the parse stage; DOMPurify is the second
enforcement point on the rendered HTML for `href` schema and
attribute hygiene. Either stage alone leaves a gap.

**Why `'unsafe-inline'` on `style-src` for V1.** Monaco injects
theming styles at runtime. Nonce-based CSP for App Router middleware
is the right end state but adds material implementation complexity
(per-request nonce propagation through `next/dynamic` boundaries) we
do not want to bundle with the persistence slice. Removing it is a
follow-up.

**Why explicit error taxonomy.** Studio cannot recover from
`SessionExpiredDuringEdit` the same way it handles `QuotaExceeded`.
The UI states must differ — re-auth prompt vs. _"local storage
full"_ dialog. Naming them up front prevents the implementor from
collapsing them into a single generic error.

## Consequences

### Becomes easier

- Studio drafts survive reloads without changing the durable-artifact
  story.
- Editor-Assist redaction is logged on both sides; auditors get a
  single `redactedFields[]` view per call.
- Hover content from any source — diagnostics, lineage, BFF-proxied
  LLM output — is bounded by one sanitizer.
- CSP is reviewable in `next.config.mjs` and reportable via
  `report-uri`.
- A future Studio PR has a checklist to walk through.

### Becomes harder

- Drafts encrypted under a session that has logged out are
  **unrecoverable**. Operators must be prepared for "I lost my work"
  support requests. The product position is that drafts are drafts;
  durable work lives in the server-side artifact store.
- Per-tab key state needs cross-tab coordination if we later want a
  consistent encrypted-state experience across multiple Studio tabs.
  Out of scope for V1 (named follow-up).
- Redaction false-negatives in the Studio baseline become a Studio
  release problem, not a config update. Mitigated by the
  authoritative Gateway pass.
- `style-src 'unsafe-inline'` is a real compromise on the CSP
  posture, tracked as a named follow-up.

### Operational notes

- **Clock skew**: `ttlExpiresAt` is absolute and vulnerable to clock
  rollback. Drafts are not a vault — the threat model accepts this.
- **IndexedDB key plaintext**: the `sourceKey` is indexable and
  plaintext on disk; program identifiers leak to anyone with disk
  access. Buffer **contents** are protected. Full-key encryption
  would require an encrypted index we do not need; program identity
  is also visible in the URL/route. **The PII concern is bounded by
  Decision 3's requirement that `tenantId` and `userId` are opaque
  pseudonymous identifiers**, not emails or employee IDs — so the
  plaintext keys leak program names and pseudonyms, not direct
  customer identifiers.
- **Quota**: large COBOL files plus AES-GCM overhead (16-byte tag +
  12-byte IV per record) can pressure the per-origin quota.
  `QuotaExceeded` is surfaced to the UI; the module never silently
  drops a save.
- **Rename**: renaming `PAYROLL.cbl → PAYROLL_V2.cbl` orphans the
  old draft. Orphans age out via TTL.

### Named prerequisites and follow-ups

**Hard prerequisite for Studio-IDE-3** ([#247](https://github.com/oscharko-dev/c2c-PreBeta/issues/247)):

- The BFF must expose `POST /api/v0/session/bootstrap` returning, in
  the JSON response body, the opaque pseudonymous `tenantId` and
  `userId` plus a fresh `draftKeyWrappingSecret`. The authentication
  cookie remains `HttpOnly` and is not exposed to JS. Studio-IDE-3
  implementation must not start before this lands, or a placeholder
  `tenantId = "default"` and an absent wrapping secret will ship and
  become production load-bearing.

**Named follow-ups**:

1. Nonce-based CSP migration to remove `style-src 'unsafe-inline'`.
2. Cross-tab session/key coordination via `BroadcastChannel`.
3. UI surfacing of `redactedFields[]` from Editor-Assist responses
   in the Studio side panel.
4. Per-program "clear drafts for this program only" action.
5. `re2`-style regex engine adoption for redaction patterns to
   harden against ReDoS by construction.
6. CSP `report-uri` endpoint wiring on the BFF (the URL is declared
   here; the receiver is implemented separately).
7. `require-trusted-types-for 'script'` directive once Monaco
   integration tolerates it.

## References

- Issue: [Studio-ADR-2 Local Persistence & Editor Security Boundary (#240)](https://github.com/oscharko-dev/c2c-PreBeta/issues/240)
- Parent epic: [IDE-Grade Modernization Editing Experience (#239)](https://github.com/oscharko-dev/c2c-PreBeta/issues/239)
- Implementation slice (blocked on this ADR): [Studio-IDE-3 Persistence & Conflict Resolution (#247)](https://github.com/oscharko-dev/c2c-PreBeta/issues/247)
- Related ADR: [ADR 0004 — Studio Editor-Assist-Channel](0004-studio-editor-assist-channel.md)
- [ADR 0003 — W0.3 Deterministic-First Multi-Agent Hardening](0003-w0-3-deterministic-first-multi-agent-hardening.md)
- [Security Review Checklist](../governance/security-review-checklist.md)
- Web Crypto API:
  [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)
- HKDF:
  [RFC 5869 — HMAC-based Extract-and-Expand Key Derivation Function](https://www.rfc-editor.org/rfc/rfc5869)
- AES-GCM:
  [NIST SP 800-38D — Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode (GCM) and GMAC](https://csrc.nist.gov/publications/detail/sp/800-38d/final)
