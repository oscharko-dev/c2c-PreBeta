// Issue #271 / ADR-0005 §6: unit tests for the CSP-report parser and
// PII gate. The route-handler integration test lives in
// ``server.test.ts``; this suite is the contract pin for the
// boundary that strips PII before reports reach the log sink.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  CSP_REPORT_MAX_BATCH,
  isAcceptedCspReportContentType,
  parseCspReportPayload,
  type SanitizedCspReport,
} from "./cspReport";

function firstReport(reports: SanitizedCspReport[]): SanitizedCspReport {
  const first = reports[0];
  if (!first) throw new Error("expected at least one sanitized report");
  return first;
}

test("isAcceptedCspReportContentType accepts the three documented MIME types", () => {
  assert.equal(isAcceptedCspReportContentType("application/csp-report"), true);
  assert.equal(
    isAcceptedCspReportContentType("application/reports+json"),
    true,
  );
  assert.equal(isAcceptedCspReportContentType("application/json"), true);
  assert.equal(
    isAcceptedCspReportContentType("application/csp-report; charset=utf-8"),
    true,
  );
  assert.equal(isAcceptedCspReportContentType("APPLICATION/CSP-REPORT"), true);
});

test("isAcceptedCspReportContentType rejects unrelated MIME types", () => {
  assert.equal(isAcceptedCspReportContentType("text/plain"), false);
  assert.equal(isAcceptedCspReportContentType("application/xml"), false);
  assert.equal(isAcceptedCspReportContentType(undefined), false);
  assert.equal(isAcceptedCspReportContentType(""), false);
});

test("parseCspReportPayload accepts a legacy csp-report envelope", () => {
  const result = parseCspReportPayload("application/csp-report", {
    "csp-report": {
      "document-uri": "https://studio.example.com/path",
      "violated-directive": "script-src",
      "blocked-uri": "inline",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reports.length, 1);
  assert.deepEqual(firstReport(result.reports), {
    "document-uri": "https://studio.example.com/path",
    "violated-directive": "script-src",
    "blocked-uri": "inline",
  });
});

test("parseCspReportPayload accepts a bare object (no csp-report envelope)", () => {
  // Some browsers POST the body without the outer envelope. The
  // parser falls back to treating the whole object as the report.
  const result = parseCspReportPayload("application/json", {
    "document-uri": "https://studio.example.com/path",
    "violated-directive": "script-src",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reports.length, 1);
  assert.equal(firstReport(result.reports)["violated-directive"], "script-src");
});

test("parseCspReportPayload strips query strings and fragments from URL fields (PII gate)", () => {
  const result = parseCspReportPayload("application/csp-report", {
    "csp-report": {
      "document-uri":
        "https://studio.example.com/page?token=secret-session&user=alice@example.com#fragment",
      referrer: "https://studio.example.com/from?session=abc",
      "blocked-uri": "https://cdn.example.com/asset.js?cb=1",
      "source-file": "https://studio.example.com/app.js?v=1",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = firstReport(result.reports);
  assert.equal(report["document-uri"], "https://studio.example.com/page");
  assert.equal(report.referrer, "https://studio.example.com/from");
  assert.equal(report["blocked-uri"], "https://cdn.example.com/asset.js");
  assert.equal(report["source-file"], "https://studio.example.com/app.js");
  // Sanity: the PII tokens never appear anywhere in the serialised
  // report, including in fields we didn't explicitly check above.
  const serialised = JSON.stringify(report);
  assert.equal(serialised.includes("secret-session"), false);
  assert.equal(serialised.includes("alice@example.com"), false);
  assert.equal(serialised.includes("abc"), false);
});

test("parseCspReportPayload preserves the relative ``inline`` / ``eval`` blocked-uri markers", () => {
  const result = parseCspReportPayload("application/csp-report", {
    "csp-report": {
      "violated-directive": "script-src",
      "blocked-uri": "inline",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(firstReport(result.reports)["blocked-uri"], "inline");
});

test("parseCspReportPayload coerces numeric fields", () => {
  const result = parseCspReportPayload("application/csp-report", {
    "csp-report": {
      "violated-directive": "script-src",
      "line-number": "42",
      "column-number": 17,
      "status-code": "200",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = firstReport(result.reports);
  assert.equal(report["line-number"], 42);
  assert.equal(report["column-number"], 17);
  assert.equal(report["status-code"], 200);
});

test("parseCspReportPayload drops fields outside the documented allow-list", () => {
  const result = parseCspReportPayload("application/csp-report", {
    "csp-report": {
      "violated-directive": "script-src",
      "user-agent": "Mozilla/5.0 … sensitive UA token",
      cookie: "session=secret",
      "extra-vendor-field": "should-not-survive",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = firstReport(result.reports);
  assert.equal(report["violated-directive"], "script-src");
  // Anything outside ALLOWED_REPORT_FIELDS is gone.
  assert.equal(Object.keys(report).includes("user-agent"), false);
  assert.equal(Object.keys(report).includes("cookie"), false);
  assert.equal(Object.keys(report).includes("extra-vendor-field"), false);
});

test("parseCspReportPayload accepts a Reports API v2 batch", () => {
  const result = parseCspReportPayload("application/reports+json", [
    {
      type: "csp-violation",
      age: 10,
      url: "https://studio.example.com/path",
      body: {
        "document-uri": "https://studio.example.com/path",
        "violated-directive": "script-src",
        "blocked-uri": "inline",
      },
    },
    {
      type: "csp-violation",
      age: 11,
      url: "https://studio.example.com/path",
      body: {
        "violated-directive": "style-src",
        "blocked-uri": "inline",
      },
    },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reports.length, 2);
  const [first, second] = result.reports;
  if (!first || !second) throw new Error("expected two reports");
  assert.equal(first["violated-directive"], "script-src");
  assert.equal(second["violated-directive"], "style-src");
});

test("parseCspReportPayload skips non-csp-violation entries in a reports+json batch", () => {
  const result = parseCspReportPayload("application/reports+json", [
    {
      type: "deprecation",
      body: { id: "deprecated-api" },
    },
    {
      type: "csp-violation",
      body: {
        "violated-directive": "script-src",
        "blocked-uri": "inline",
      },
    },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reports.length, 1);
  assert.equal(firstReport(result.reports)["violated-directive"], "script-src");
});

test("parseCspReportPayload rejects a reports+json batch with no csp-violation entries", () => {
  const result = parseCspReportPayload("application/reports+json", [
    { type: "deprecation", body: { id: "x" } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
});

test("parseCspReportPayload rejects a reports+json batch above the per-request cap", () => {
  const overflow = Array.from({ length: CSP_REPORT_MAX_BATCH + 1 }, () => ({
    type: "csp-violation",
    body: { "violated-directive": "script-src", "blocked-uri": "inline" },
  }));
  const result = parseCspReportPayload("application/reports+json", overflow);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
});

test("parseCspReportPayload rejects a non-array reports+json body", () => {
  const result = parseCspReportPayload("application/reports+json", {
    type: "csp-violation",
    body: { "violated-directive": "script-src" },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
});

test("parseCspReportPayload rejects an empty csp-report envelope", () => {
  const result = parseCspReportPayload("application/csp-report", {
    "csp-report": {},
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
});

test("parseCspReportPayload rejects an unsupported content-type with 415", () => {
  const result = parseCspReportPayload("text/plain", {
    "csp-report": { "violated-directive": "script-src" },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 415);
});

test("parseCspReportPayload drops script-sample entirely (PII gate)", () => {
  // ``script-sample`` is a verbatim slice of the offending source.
  // For inline-script violations on a page that renders user data,
  // that slice can carry email / account / token bytes — so the
  // allow-list deliberately excludes it. The information loss is
  // bounded: ``source-file`` + ``line-number`` + ``column-number``
  // still locate the violation exactly.
  const result = parseCspReportPayload("application/csp-report", {
    "csp-report": {
      "violated-directive": "script-src",
      "script-sample":
        "document.write('user email: alice@example.com, token=abc')",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = firstReport(result.reports);
  assert.equal(Object.keys(report).includes("script-sample"), false);
  // Sanity: no PII bytes leaked through any other field.
  const serialised = JSON.stringify(report);
  assert.equal(serialised.includes("alice@example.com"), false);
  assert.equal(serialised.includes("token=abc"), false);
});

test("parseCspReportPayload caps free-text fields at 1 KiB", () => {
  // ``original-policy`` is a free-text field on the allow-list. A
  // misbehaving client could send a multi-megabyte string to bloat
  // the log sink; the parser caps every free-text field at 1 KiB.
  const huge = "x".repeat(8 * 1024);
  const result = parseCspReportPayload("application/csp-report", {
    "csp-report": {
      "violated-directive": "script-src",
      "original-policy": huge,
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const value = firstReport(result.reports)["original-policy"];
  assert.equal(typeof value, "string");
  assert.equal((value as string).length, 1024);
});

test("parseCspReportPayload reduces non-loggable schemes (data:/blob:/file:/javascript:) to the scheme marker", () => {
  const result = parseCspReportPayload("application/csp-report", {
    "csp-report": {
      "violated-directive": "img-src",
      "blocked-uri":
        "data:image/png;base64,AAAA-user-email-alice@example.com-AAAA",
      "document-uri": "https://studio.example.com/page",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = firstReport(result.reports);
  // Only the scheme survives — the payload (which could carry PII
  // verbatim) is gone.
  assert.equal(report["blocked-uri"], "data:");
  const serialised = JSON.stringify(report);
  assert.equal(serialised.includes("alice@example.com"), false);
});

test("parseCspReportPayload allows http(s) / ws(s) origin+pathname through", () => {
  for (const value of [
    "http://studio.example.com/path",
    "https://studio.example.com/path",
    "ws://studio.example.com/socket",
    "wss://studio.example.com/socket",
  ]) {
    const result = parseCspReportPayload("application/csp-report", {
      "csp-report": {
        "violated-directive": "connect-src",
        "blocked-uri": value,
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(firstReport(result.reports)["blocked-uri"], value);
  }
});
