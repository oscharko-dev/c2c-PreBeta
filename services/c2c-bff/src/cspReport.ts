// Issue #271 / ADR-0005 §6: receiver for browser CSP violation
// reports. Studio's middleware emits ``report-uri /api/v0/csp-report``
// in the production CSP; this module owns the parser, the PII gate,
// and the canonical log shape.
//
// Two wire formats land on this endpoint:
//
//   * **Reporting v1** (`Content-Type: application/csp-report`) —
//     the legacy ``report-uri`` payload, a single envelope of the
//     shape ``{ "csp-report": { … } }``. Still the only directive
//     supported across all evergreen browsers today.
//
//   * **Reporting API v2** (`Content-Type: application/reports+json`) —
//     a batched array of ``{ type, age, url, body }`` reports, each
//     ``body`` carrying the same fields as v1. Newer Chromium /
//     Firefox emit this when the page also opts in via
//     ``Reporting-Endpoints``. We accept it so a future ADR can flip
//     to ``report-to`` without re-coding the receiver.
//
// PII gate:
//
//   The browser is willing to leak the *full* offending URL in the
//   ``document-uri``, ``referrer``, ``blocked-uri``, and
//   ``source-file`` fields — including query strings and fragments
//   that may carry session tokens or user identifiers. The security
//   review checklist forbids logging PII server-side. We normalise
//   every URL-shaped field down to ``origin + pathname`` before
//   logging, and we drop any other free-text field that is not part
//   of the documented CSP report schema.
//
// Response contract:
//
//   * 204 No Content on accepted reports — the browser does not
//     interpret the body, so there is nothing to return.
//   * 400 Bad Request on a malformed envelope.
//   * 413 Payload Too Large when the body exceeds the cap (default
//     64 KiB — well above a real CSP report).
//   * 415 Unsupported Media Type on an unrecognised ``Content-Type``.

// Strict allow-list of fields we are willing to forward to the log
// sink. Anything else the browser ships is dropped at the boundary.
const ALLOWED_REPORT_FIELDS = [
  "document-uri",
  "referrer",
  "violated-directive",
  "effective-directive",
  "original-policy",
  "disposition",
  "blocked-uri",
  "line-number",
  "column-number",
  "source-file",
  "status-code",
  "script-sample",
] as const;
type AllowedReportField = (typeof ALLOWED_REPORT_FIELDS)[number];

// URL-shaped fields are normalised before logging so query/fragment
// segments — which may carry session tokens or PII — never reach the
// log sink. ``script-sample`` is included because the browser will
// quote up to 40 chars of the offending source, which can incidentally
// hold a URL the page tried to fetch.
const URL_SHAPED_FIELDS: ReadonlySet<AllowedReportField> = new Set([
  "document-uri",
  "referrer",
  "blocked-uri",
  "source-file",
]);

// Numeric fields are coerced to number before logging so a string
// ``"42"`` and a number ``42`` log identically.
const NUMERIC_FIELDS: ReadonlySet<AllowedReportField> = new Set([
  "line-number",
  "column-number",
  "status-code",
]);

// Max number of reports we accept in a single ``application/reports+json``
// batch. The Reporting API specification gives the browser latitude
// to coalesce, but a single batch above this size is almost certainly
// a misbehaving client and would bloat the log sink.
export const CSP_REPORT_MAX_BATCH = 32;

// Body cap: 64 KiB is well above a real report (single-digit KiB at
// most) but below any pathological payload a hostile client could
// stream to amplify log volume.
export const CSP_REPORT_MAX_BODY_BYTES = 64 * 1024;

// Public schema marker for the log shape. Bump on a breaking change
// to the canonical record so downstream log consumers can pivot.
export const CSP_REPORT_LOG_SCHEMA_VERSION = "v1";

export type SanitizedCspReport = Partial<
  Record<AllowedReportField, string | number>
>;

export type CspReportParseResult =
  | { ok: true; reports: SanitizedCspReport[] }
  | { ok: false; status: 400 | 415; error: string };

function sanitizeUrlField(value: string): string {
  // Relative ``blocked-uri`` markers (``inline``, ``eval``,
  // ``self``) are preserved verbatim — they are not URLs. Anything
  // else gets origin + pathname only.
  if (value === "" || /^[a-z]+$/i.test(value)) return value;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Browsers occasionally emit relative paths (especially for
    // ``blocked-uri`` of inline violations). Strip any ``?`` /
    // ``#`` segment defensively before passing through.
    const queryIndex = value.indexOf("?");
    const fragmentIndex = value.indexOf("#");
    const cuts = [queryIndex, fragmentIndex].filter((i) => i >= 0);
    if (cuts.length === 0) return value;
    return value.slice(0, Math.min(...cuts));
  }
}

function coerceNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sanitizeReportBody(raw: unknown): SanitizedCspReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: SanitizedCspReport = {};
  for (const field of ALLOWED_REPORT_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (NUMERIC_FIELDS.has(field)) {
      const numeric = coerceNumeric(value);
      if (numeric !== undefined) out[field] = numeric;
      continue;
    }
    if (typeof value !== "string") continue;
    if (URL_SHAPED_FIELDS.has(field)) {
      out[field] = sanitizeUrlField(value);
    } else {
      // Cap free-text fields at a safe length so a hostile client
      // cannot flood the log sink via ``script-sample`` /
      // ``original-policy``. 1 KiB is well above the practical max.
      out[field] = value.length > 1024 ? value.slice(0, 1024) : value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeContentType(raw: string | undefined): string {
  if (!raw) return "";
  const semi = raw.indexOf(";");
  return (semi >= 0 ? raw.slice(0, semi) : raw).trim().toLowerCase();
}

export function isAcceptedCspReportContentType(
  raw: string | undefined,
): boolean {
  const ct = normalizeContentType(raw);
  return (
    ct === "application/csp-report" ||
    ct === "application/reports+json" ||
    ct === "application/json"
  );
}

export function parseCspReportPayload(
  contentType: string | undefined,
  body: unknown,
): CspReportParseResult {
  const ct = normalizeContentType(contentType);
  if (!isAcceptedCspReportContentType(ct)) {
    return {
      ok: false,
      status: 415,
      error: `unsupported content-type: ${ct || "<missing>"}`,
    };
  }

  if (ct === "application/reports+json") {
    if (!Array.isArray(body)) {
      return {
        ok: false,
        status: 400,
        error: "reports+json body must be an array",
      };
    }
    if (body.length === 0) {
      return { ok: false, status: 400, error: "reports+json body is empty" };
    }
    if (body.length > CSP_REPORT_MAX_BATCH) {
      return {
        ok: false,
        status: 400,
        error: `reports+json batch exceeds the per-request cap (${CSP_REPORT_MAX_BATCH})`,
      };
    }
    const reports: SanitizedCspReport[] = [];
    for (const entry of body) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const envelope = entry as Record<string, unknown>;
      if (envelope.type !== "csp-violation") continue;
      const sanitized = sanitizeReportBody(envelope.body);
      if (sanitized) reports.push(sanitized);
    }
    if (reports.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "no csp-violation reports in reports+json batch",
      };
    }
    return { ok: true, reports };
  }

  // ``application/csp-report`` and ``application/json`` both carry the
  // legacy envelope ``{ "csp-report": { … } }``.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      error: "csp-report body must be an object",
    };
  }
  const envelope = (body as Record<string, unknown>)["csp-report"];
  const sanitized = sanitizeReportBody(envelope ?? body);
  if (!sanitized) {
    return { ok: false, status: 400, error: "csp-report envelope is empty" };
  }
  return { ok: true, reports: [sanitized] };
}
