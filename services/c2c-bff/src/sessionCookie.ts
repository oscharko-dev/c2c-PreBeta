// Issue #272 / ADR 0005 §2 — session cookie parser + serializer for
// the draft-key wrapping flow.
//
// Cookie shape:
//
//   * Name: ``c2c.sid`` (short, unambiguous, no PII).
//   * ``HttpOnly``  — Studio JS cannot read it. ADR 0005 Rationale
//     "Why a dedicated draft-key wrapping secret rather than the auth
//     token": the cookie carries no JS-readable bearer material; the
//     wrapping secret in the bootstrap response body is the only
//     value Studio JS sees.
//   * ``SameSite=Lax`` — accepts top-level navigation auth but blocks
//     third-party POSTs (CSRF posture for the
//     state-changing ``/sign-in`` / ``/logout`` routes).
//   * ``Path=/``    — every BFF route sees the cookie.
//   * ``Secure``    — set when the request arrives over HTTPS or
//     when production-mode is forced via env. Dev mode (plain HTTP on
//     localhost) omits it so a developer can sign in over
//     ``http://localhost`` without the browser dropping the cookie.

import type * as http from "node:http";

export const SESSION_COOKIE_NAME = "c2c.sid";

export interface SessionCookieOptions {
  // Forces ``Secure`` on the serialized cookie. The route handler
  // decides this based on ``req.socket`` TLS state or the
  // ``C2C_FORCE_SECURE_COOKIES`` env flag.
  secure?: boolean;
  // Override the cookie name for tests / future migrations.
  name?: string;
}

export function parseSessionCookie(
  cookieHeader: string | string[] | undefined,
  options: { name?: string } = {},
): string | null {
  const name = options.name ?? SESSION_COOKIE_NAME;
  const raw = pickFirstHeader(cookieHeader);
  if (!raw) return null;
  // RFC 6265 §5.2 parsing: pairs separated by ``;``, name + ``=`` +
  // value. We accept whitespace around the separator and around the
  // ``=`` for forgiveness; we reject empty names and empty values.
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) continue;
    const value = trimmed.slice(eq + 1).trim();
    if (value.length === 0) return null;
    // The cookie value is opaque hex (see ``sessionStore.ts``); any
    // character outside that vocabulary is a sign of tampering or
    // an unrelated cookie. Reject so the route handler treats it as
    // an unauthenticated request.
    if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
    return value;
  }
  return null;
}

export function parseSessionCookieFromRequest(
  req: http.IncomingMessage,
  options: { name?: string } = {},
): string | null {
  return parseSessionCookie(req.headers.cookie, options);
}

export function serializeSessionCookie(
  sessionId: string,
  options: SessionCookieOptions = {},
): string {
  const name = options.name ?? SESSION_COOKIE_NAME;
  if (sessionId.length === 0) {
    throw new Error("sessionId must be non-empty");
  }
  const segments = [
    `${name}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) segments.push("Secure");
  return segments.join("; ");
}

export function serializeClearedSessionCookie(
  options: SessionCookieOptions = {},
): string {
  const name = options.name ?? SESSION_COOKIE_NAME;
  const segments = [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (options.secure) segments.push("Secure");
  return segments.join("; ");
}

export function isRequestSecure(req: http.IncomingMessage): boolean {
  // Direct TLS connection.
  const sock = req.socket as unknown as { encrypted?: boolean };
  if (sock && sock.encrypted === true) return true;
  // Trusted reverse-proxy forwarded protocol. Operators are expected
  // to terminate TLS at the proxy and set ``X-Forwarded-Proto=https``
  // on requests that reached the BFF over HTTPS. Multiple values
  // (chained proxies) are comma-separated; the leftmost is the
  // origin client.
  const forwarded = pickFirstHeader(req.headers["x-forwarded-proto"]);
  if (!forwarded) return false;
  return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
}

function pickFirstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string")
    return value[0];
  return null;
}
