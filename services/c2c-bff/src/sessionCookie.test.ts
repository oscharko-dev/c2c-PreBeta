// Issue #272 — unit tests for the session cookie parser + serializer.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  SESSION_COOKIE_NAME,
  parseSessionCookie,
  serializeSessionCookie,
  serializeClearedSessionCookie,
} from "./sessionCookie";

test("parseSessionCookie returns null when the Cookie header is missing", () => {
  assert.equal(parseSessionCookie(undefined), null);
  assert.equal(parseSessionCookie(""), null);
});

test("parseSessionCookie extracts the c2c.sid value", () => {
  assert.equal(
    parseSessionCookie(`${SESSION_COOKIE_NAME}=abcdef0123456789`),
    "abcdef0123456789",
  );
});

test("parseSessionCookie handles surrounding cookies and arbitrary whitespace", () => {
  assert.equal(
    parseSessionCookie(
      `theme=dark; ${SESSION_COOKIE_NAME}=abcdef0123456789; locale=de-DE`,
    ),
    "abcdef0123456789",
  );
  assert.equal(
    parseSessionCookie(
      ` theme=dark ;  ${SESSION_COOKIE_NAME} = abcdef0123456789 ; locale=de-DE `,
    ),
    "abcdef0123456789",
  );
});

test("parseSessionCookie ignores other cookies", () => {
  assert.equal(parseSessionCookie("theme=dark; locale=de-DE"), null);
});

test("parseSessionCookie rejects out-of-vocabulary characters (defends against tampering)", () => {
  assert.equal(
    parseSessionCookie(`${SESSION_COOKIE_NAME}=value with space`),
    null,
  );
  // The ``=`` character would otherwise mark an internal key/value
  // boundary; it's not permitted inside the opaque hex id.
  assert.equal(parseSessionCookie(`${SESSION_COOKIE_NAME}=val=ue`), null);
  assert.equal(parseSessionCookie(`${SESSION_COOKIE_NAME}=val/ue`), null);
  // RFC 6265 treats ``;`` as the segment separator; the value before
  // it ("val") is itself a well-formed opaque token. Cookie injection
  // via stray semicolons therefore degrades to "browser sent something
  // that isn't in the session store" — caught upstream by the bootstrap
  // route's 401, not by this parser.
});

test("parseSessionCookie returns null for an empty value", () => {
  assert.equal(parseSessionCookie(`${SESSION_COOKIE_NAME}=`), null);
  assert.equal(parseSessionCookie(`${SESSION_COOKIE_NAME}= `), null);
});

test("parseSessionCookie handles header-array input from Node http (first value wins)", () => {
  assert.equal(
    parseSessionCookie([
      `${SESSION_COOKIE_NAME}=primary-value`,
      `${SESSION_COOKIE_NAME}=ghost-value`,
    ]),
    "primary-value",
  );
});

test("serializeSessionCookie emits HttpOnly + SameSite=Lax + Path=/ by default", () => {
  const value = serializeSessionCookie("abcdef0123456789");
  assert.match(value, /^c2c\.sid=abcdef0123456789(;|$)/);
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Lax/);
  assert.match(value, /Path=\//);
  assert.doesNotMatch(value, /Secure/);
});

test("serializeSessionCookie adds Secure when explicitly requested", () => {
  const value = serializeSessionCookie("abcdef", { secure: true });
  assert.match(value, /Secure/);
});

test("serializeSessionCookie rejects an empty sessionId", () => {
  assert.throws(() => serializeSessionCookie(""), /non-empty/);
});

test("serializeClearedSessionCookie emits Max-Age=0 and expired Expires", () => {
  const value = serializeClearedSessionCookie();
  assert.match(value, /Max-Age=0/);
  assert.match(value, /Expires=Thu, 01 Jan 1970/);
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Lax/);
});
