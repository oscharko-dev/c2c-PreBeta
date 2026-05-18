# Security Review Checklist

Apply this checklist on any PR that touches the Studio frontend, the
BFF, persistence, secret handling, the editor surface, or the
Model Gateway boundary. Each box is **either** checked, marked
**N/A** with a one-line reason, or left blank and addressed before
merge.

Scope of this checklist is the C2C Studio + BFF security posture
established by:

- [ADR 0003 — W0.3 Deterministic-First Multi-Agent Hardening](../adr/0003-w0-3-deterministic-first-multi-agent-hardening.md)
- [ADR 0004 — Studio Editor-Assist-Channel](../adr/0004-studio-editor-assist-channel.md)
- [ADR 0005 — Studio Local Persistence and Editor Security Boundary](../adr/0005-studio-local-persistence-security-boundary.md)

## Content-Security-Policy

- [ ] CSP delta documented in the PR description (current vs proposed).
- [ ] No new `'unsafe-eval'` directive added.
- [ ] No new `'unsafe-inline'` on `script-src`.
- [ ] Any new `connect-src`, `img-src`, `font-src`, `frame-src`, or
      `worker-src` origin is justified in the PR description and uses
      a config value, not a literal, where the origin varies per
      environment.
- [ ] If `worker-src` is touched, the worker bootstrap mechanism
      (Monaco loader, custom Web Worker, etc.) is named so reviewers
      can verify the CSP and the loader stay in lockstep.
- [ ] `report-uri` (or `report-to`) target is reachable in the
      environments this PR touches.
- [ ] Dev-mode CSP differences (HMR `'unsafe-eval'`) are gated on
      `NODE_ENV !== 'production'` and do not leak into production
      builds.

## Hover and Markdown Rendering

- [ ] All Monaco hover content uses `MarkdownString` with
      `isTrusted: false`.
- [ ] Hover markdown passes through the project sanitizer pipeline
      (markdown renderer with HTML pass-through disabled, followed by
      DOMPurify with the allow-list defined in ADR 0005 §5).
- [ ] No `dangerouslySetInnerHTML` on user-influenced or BFF-relayed
      content. If unavoidable, the input is run through the same
      sanitizer.
- [ ] `href` schemes are restricted to the ADR 0005 allow-list
      (relative anchors, relative paths, configured https prefix).
      No `javascript:`, `data:`, `vbscript:`, `mailto:`, or absolute
      `http://`.
- [ ] Any `target="_blank"` link sets `rel="noopener noreferrer"`.
- [ ] An E2E test covers the ADR 0005 §5 XSS payloads (script tag,
      `javascript:`, `data:text/html`, inline `onerror`, `vbscript:`).

## IndexedDB / Local Storage / Cookies

- [ ] No PII or source content is stored unencrypted in IndexedDB,
      `localStorage`, `sessionStorage`, or cookies.
- [ ] If IndexedDB is used for drafts: the `editorPersistence` module
      is used and not a direct `indexedDB.open()`.
- [ ] `localStorage` is reserved for UI preferences only (per ADR
      0005). It must not hold source code, draft buffers, or session
      secrets.
- [ ] Cookies carrying authentication state use `Secure`, `HttpOnly`,
      and `SameSite=Lax` or stricter.
- [ ] On logout, all session-scoped local state is invalidated by
      design (no explicit purge step needed for encrypted drafts —
      the key is gone).
- [ ] `clearAll` and `purgeExpired` paths in the persistence module
      are used; no PR introduces ad-hoc bypass writes.

## PII Redaction

- [ ] Any new code path that sends source content to the Model
      Gateway runs the Studio redaction pass first (ADR 0005 §4).
- [ ] The Model Gateway redaction pass is not removed or weakened.
      Defense in depth requires both passes.
- [ ] Any new redaction regex is added to the single project regex
      registry, has been hand-reviewed for ReDoS (no backreferences,
      no nested quantifiers, bounded repetition), and is unit-tested.
- [ ] Per-tenant additions **augment** the bundle baseline; they do
      not replace or weaken it.
- [ ] `redactedFields[]` is plumbed into the response payload and
      surfaced to the UI where a region was sent to the Model
      Gateway.

## Secret Handling

- [ ] No secret (session token, API key, customer credential) is
      logged.
- [ ] No secret is included in URL paths, query strings, or fragment
      identifiers.
- [ ] No secret is embedded in client-side bundle code at build
      time.
- [ ] No secret is committed to the repository, including `.env`
      files or fixture data. Secret-scanning CI passes.
- [ ] Any new use of a session token uses the opaque secret, not the
      JWT body.

## Web Crypto / Key Derivation

- [ ] Any new key derivation uses HKDF-SHA-256 with a versioned
      `info` string so future versions cannot collide.
- [ ] Any new symmetric encryption uses AES-GCM with a 96-bit random
      IV per record. IVs are never deterministic.
- [ ] No raw cryptographic primitive (`crypto.subtle.encrypt` etc.)
      is called outside the persistence or transport modules; new
      callers go through an audited wrapper.
- [ ] `crypto.subtle` availability is checked before use; missing
      Web Crypto results in a documented degraded state, not a
      silent failure.

## Worker and Third-Party Code

- [ ] No new third-party script is loaded from a remote origin
      (no CDN script tags, no inline `<script src="https://…">`).
- [ ] New npm dependencies have been reviewed for license,
      maintenance status, and known vulnerabilities (CI dependency
      audit is green).
- [ ] Web Workers load from same-origin or `blob:` URLs only.
- [ ] No `eval`, `new Function(...)`, or `setTimeout("string", …)`
      anywhere in Studio or BFF code.

## Authentication and Tenancy

- [ ] Every BFF endpoint that touches user data validates the
      session and resolves `(tenantId, userId)` server-side. The
      client cannot assert tenancy.
- [ ] Multi-tenant boundary checks (the row belongs to the caller's
      `tenantId`) are present on every read and write.
- [ ] No client-supplied `tenantId` or `userId` is trusted by the
      BFF without verification against the session.

## Telemetry and Logging

- [ ] No PII is captured in telemetry events. Field names and IR
      node kinds may be tagged; content and customer data may not.
- [ ] No draft contents, redacted regions, or hover content are
      logged in production telemetry.
- [ ] Audit events for destructive actions (e.g. `editor.drafts.cleared`)
      include `{ tenantId, userId, action, timestamp, count? }` and
      omit content.

## Testing Gates

- [ ] Unit tests cover the security-relevant code paths added by the
      PR (redaction, sanitization, encryption, CSP-related headers).
- [ ] E2E tests cover XSS payloads where the PR touches a renderer.
- [ ] CI Qodana / static-analysis checks pass for the touched
      modules.
- [ ] Secret-scanning CI passes.

## Review Sign-Off

- [ ] Reviewer has read the ADRs referenced at the top of this
      checklist.
- [ ] Any **N/A** boxes carry a one-line reason in the PR description.
- [ ] Any deferred items are filed as follow-up issues with the
      `area: security` label, linked from the PR.
