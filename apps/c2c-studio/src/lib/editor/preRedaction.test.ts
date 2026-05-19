import { describe, expect, it } from "vitest";

import {
  STUDIO_REDACTION_PROFILE_VERSION,
  computeSha256Hex,
  redactRegion,
  textEncoderToBytes,
} from "./preRedaction";

describe("STUDIO_REDACTION_PROFILE_VERSION", () => {
  it("is v1.1.0 after the L1 pattern additions per ADR 0005 Decision 4", () => {
    expect(STUDIO_REDACTION_PROFILE_VERSION).toBe("v1.1.0");
  });
});

describe("redactRegion — return contract", () => {
  it("returns the original text and an empty matched set when no patterns hit", () => {
    const result = redactRegion("       MOVE 1 TO COUNTER.");
    expect(result.redactedText).toBe("       MOVE 1 TO COUNTER.");
    expect(result.matchedPatternIds).toEqual([]);
    expect(result.profileVersion).toBe(STUDIO_REDACTION_PROFILE_VERSION);
  });

  it("never mutates the input string", () => {
    const original = "       MOVE '123-45-6789' TO SSN.";
    redactRegion(original);
    expect(original).toBe("       MOVE '123-45-6789' TO SSN.");
  });

  it("returns matchedPatternIds in a deterministic, de-duplicated order", () => {
    const text = "ACCT-NO X(10).\nACCOUNT-NUMBER PIC X(20).\nEMAIL PIC X(50).";
    const result = redactRegion(text);
    expect(new Set(result.matchedPatternIds)).toEqual(
      new Set(["field-name-class:account-number", "field-name-class:email"]),
    );
    // Sorted alphabetically for stable rendering in the side panel.
    const sorted = [...result.matchedPatternIds].sort();
    expect(result.matchedPatternIds).toEqual(sorted);
  });
});

describe("redactRegion — SSN (US)", () => {
  it("redacts a bare SSN", () => {
    const result = redactRegion("MOVE '123-45-6789' TO WS-OUT.");
    expect(result.redactedText).not.toContain("123-45-6789");
    expect(result.redactedText).toContain("[REDACTED:ssn-us]");
    expect(result.matchedPatternIds).toContain("ssn-us");
  });

  it("does not redact bare 9-digit numbers without dashes", () => {
    const result = redactRegion("MOVE 123456789 TO WS-OUT.");
    expect(result.redactedText).toContain("123456789");
    expect(result.matchedPatternIds).not.toContain("ssn-us");
  });

  it("does not redact dash-separated numbers with the wrong shape", () => {
    const result = redactRegion("ACCT 12-34-56 OR 1234-56-7890.");
    expect(result.matchedPatternIds).not.toContain("ssn-us");
  });
});

describe("redactRegion — IBAN (EU)", () => {
  it("redacts a German IBAN", () => {
    const text = "ACCOUNT: DE89370400440532013000";
    const result = redactRegion(text);
    expect(result.redactedText).not.toContain("DE89370400440532013000");
    expect(result.matchedPatternIds).toContain("iban-eu");
  });

  it("redacts a French IBAN containing letters in the BBAN", () => {
    const text = "IBAN FR1420041010050500013M02606 NEXT";
    const result = redactRegion(text);
    expect(result.redactedText).not.toContain("FR1420041010050500013M02606");
    expect(result.matchedPatternIds).toContain("iban-eu");
  });

  it("does not match arbitrary alphanumeric tokens", () => {
    const result = redactRegion("MOVE PIC9 TO X.");
    expect(result.matchedPatternIds).not.toContain("iban-eu");
  });
});

describe("redactRegion — BIC", () => {
  it("redacts an 8-character BIC", () => {
    const result = redactRegion("ROUTE BIC: DEUTDEFF, NEXT");
    expect(result.redactedText).not.toContain("DEUTDEFF");
    expect(result.matchedPatternIds).toContain("bic");
  });

  it("redacts an 11-character BIC", () => {
    const result = redactRegion("BIC=DEUTDEFF500.");
    expect(result.redactedText).not.toContain("DEUTDEFF500");
    expect(result.matchedPatternIds).toContain("bic");
  });

  it("does not match a 9-character all-uppercase token", () => {
    const result = redactRegion("CONSTANT THISISNINE NEXT");
    expect(result.matchedPatternIds).not.toContain("bic");
  });
});

describe("redactRegion — PII comment line", () => {
  it("redacts a COBOL comment line beginning with `* PII:`", () => {
    const text = "       MOVE 1 TO X.\n      * PII: customer email here\n";
    const result = redactRegion(text);
    expect(result.redactedText).toContain("[REDACTED:pii-comment-line]");
    expect(result.redactedText).not.toContain("customer email here");
    expect(result.matchedPatternIds).toContain("pii-comment-line");
  });

  it("does not redact a comment line that does not start with PII", () => {
    const text = "      * NOTE: not pii here";
    const result = redactRegion(text);
    expect(result.matchedPatternIds).not.toContain("pii-comment-line");
  });
});

describe("redactRegion — field-name class", () => {
  it.each([
    ["ACCT-NO PIC X(10).", "field-name-class:account-number"],
    ["ACCOUNT-NUMBER PIC X(20).", "field-name-class:account-number"],
    ["CARD-NO PIC X(16).", "field-name-class:card-number"],
    ["SOCIAL-SECURITY PIC X(11).", "field-name-class:social-security"],
    ["NATIONAL-ID PIC X(11).", "field-name-class:national-id"],
    ["CUSTOMER-NAME PIC X(40).", "field-name-class:customer-name"],
    ["CUST-NM PIC X(40).", "field-name-class:customer-name"],
    ["EMAIL PIC X(80).", "field-name-class:email"],
    ["PHONE PIC X(20).", "field-name-class:phone"],
    ["TAX-ID PIC X(15).", "field-name-class:tax-id"],
    ["DOB PIC X(10).", "field-name-class:dob"],
    ["DATE-OF-BIRTH PIC X(10).", "field-name-class:dob"],
  ])("redacts %s as %s", (input, expectedId) => {
    const result = redactRegion(input);
    expect(result.matchedPatternIds).toContain(expectedId);
  });

  it("does not match unrelated identifiers", () => {
    const result = redactRegion("COUNTER PIC 9(4).\nTOTAL-AMOUNT PIC 9(8).");
    const fieldClassHits = result.matchedPatternIds.filter((id) =>
      id.startsWith("field-name-class:"),
    );
    expect(fieldClassHits).toEqual([]);
  });

  it("matches the field-name token case-insensitively but only on word boundary", () => {
    const lower = redactRegion("account-number pic x(20).");
    expect(lower.matchedPatternIds).toContain(
      "field-name-class:account-number",
    );
  });
});

describe("redactRegion — email-literal (v1.1.0)", () => {
  it("redacts an email address and records the pattern id", () => {
    const result = redactRegion("CONTACT: user.name+tag@example.co.uk END");
    expect(result.redactedText).not.toContain("user.name+tag@example.co.uk");
    expect(result.redactedText).toContain("[REDACTED:email-literal]");
    expect(result.matchedPatternIds).toContain("email-literal");
  });

  it("does not redact a bare word without an @ sign", () => {
    const result = redactRegion("MOVE ACCT TO WS-A.");
    expect(result.matchedPatternIds).not.toContain("email-literal");
  });
});

describe("redactRegion — phone-e164 (v1.1.0)", () => {
  it("redacts an E.164 phone number and records the pattern id", () => {
    const result = redactRegion("PHONE +12025551234 NEXT");
    expect(result.redactedText).not.toContain("+12025551234");
    expect(result.redactedText).toContain("[REDACTED:phone-e164]");
    expect(result.matchedPatternIds).toContain("phone-e164");
  });

  it("does not redact a leading + followed by fewer than 7 digits", () => {
    const result = redactRegion("CODE +12345 END");
    expect(result.matchedPatternIds).not.toContain("phone-e164");
  });
});

describe("redactRegion — pan-15-19 (v1.1.0)", () => {
  it("redacts a 16-digit payment card number and records the pattern id", () => {
    const result = redactRegion("CARD 4111111111111111 AMOUNT");
    expect(result.redactedText).not.toContain("4111111111111111");
    expect(result.redactedText).toContain("[REDACTED:pan-15-19]");
    expect(result.matchedPatternIds).toContain("pan-15-19");
  });

  it("does not redact a 14-digit run (below 15)", () => {
    const result = redactRegion("CODE 12345678901234 END");
    expect(result.matchedPatternIds).not.toContain("pan-15-19");
  });
});

describe("redactRegion — ipv4-literal (v1.1.0)", () => {
  it("redacts an IPv4 address and records the pattern id", () => {
    const result = redactRegion("HOST 192.168.1.100 PORT 8080");
    expect(result.redactedText).not.toContain("192.168.1.100");
    expect(result.redactedText).toContain("[REDACTED:ipv4-literal]");
    expect(result.matchedPatternIds).toContain("ipv4-literal");
  });

  it("does not match a string with fewer than four dot-separated groups", () => {
    const result = redactRegion("VERSION 1.2.3 NEXT");
    expect(result.matchedPatternIds).not.toContain("ipv4-literal");
  });
});

describe("redactRegion — tenant additions", () => {
  it("augments the baseline with session-delivered literal additions", () => {
    const result = redactRegion("MOVE CUSTOMER-SECRET-CODE TO OUT.", [
      {
        id: "tenant:customer-secret-code",
        literal: "CUSTOMER-SECRET-CODE",
      },
    ]);

    expect(result.redactedText).not.toContain("CUSTOMER-SECRET-CODE");
    expect(result.redactedText).toContain(
      "[REDACTED:tenant:customer-secret-code]",
    );
    expect(result.matchedPatternIds).toContain(
      "tenant:customer-secret-code",
    );
  });

  it("treats tenant additions as literals, not browser-supplied regexes", () => {
    const result = redactRegion("MOVE CUSTOMER-SECRET-CODE TO OUT.", [
      {
        id: "tenant:literal-only",
        literal: "CUSTOMER-.*-CODE",
      },
    ]);

    expect(result.redactedText).toContain("CUSTOMER-SECRET-CODE");
    expect(result.matchedPatternIds).not.toContain("tenant:literal-only");
  });

  it("does not let tenant additions match generated redaction markers", () => {
    const result = redactRegion("MOVE '123-45-6789' TO WS-OUT.", [
      { id: "tenant:redacted-word", literal: "REDACTED" },
    ]);

    expect(result.redactedText).toBe("MOVE '[REDACTED:ssn-us]' TO WS-OUT.");
    expect(result.matchedPatternIds).toEqual(["ssn-us"]);
  });

  it("does not let baseline patterns rewrite tenant marker ids", () => {
    const result = redactRegion("MOVE CUSTOMER-SECRET-CODE TO OUT.", [
      {
        id: "tenant:email",
        literal: "CUSTOMER-SECRET-CODE",
      },
    ]);

    expect(result.redactedText).toBe("MOVE [REDACTED:tenant:email] TO OUT.");
    expect(result.matchedPatternIds).toEqual(["tenant:email"]);
  });
});

describe("redactRegion — ReDoS hygiene", () => {
  it("returns within a hard time budget on a pathological input", () => {
    // Adversarial input that would explode a naive backtracking engine.
    const adversarial = "A".repeat(10_000) + "!";
    const started = Date.now();
    redactRegion(adversarial);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(200);
  });

  it("handles a long mixed-content payload deterministically", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      lines.push(`MOVE 'X${i}' TO WS-FIELD-${i}.`);
    }
    lines.push("ACCOUNT-NUMBER PIC X(20).");
    const text = lines.join("\n");
    const result = redactRegion(text);
    expect(result.matchedPatternIds).toContain(
      "field-name-class:account-number",
    );
  });
});

describe("computeSha256Hex", () => {
  it("hashes the empty string to the canonical SHA-256 vector", async () => {
    const hex = await computeSha256Hex("");
    expect(hex).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes 'abc' to the canonical SHA-256 vector", async () => {
    const hex = await computeSha256Hex("abc");
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("emits lowercase hex with no separators", async () => {
    const hex = await computeSha256Hex("abc");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("textEncoderToBytes", () => {
  it("encodes UTF-8 correctly for ASCII", () => {
    expect(Array.from(textEncoderToBytes("abc"))).toEqual([97, 98, 99]);
  });
});
