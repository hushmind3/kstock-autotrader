import { describe, expect, it } from "vitest";

import {
  isKiwoomAccountId,
  isSameKiwoomAccount,
  normalizeAccountId,
} from "../src/normalization.js";

describe("Kiwoom account identity", () => {
  it("normalizes separators without losing leading zeroes", () => {
    expect(normalizeAccountId("01234567-89")).toBe("0123456789");
    expect(isKiwoomAccountId("01234567-89")).toBe(true);
  });

  it("matches an 8-digit configured root to its full 10-digit account", () => {
    expect(isSameKiwoomAccount("01234567", "01234567-89")).toBe(true);
    expect(isSameKiwoomAccount("01234567-89", "01234567")).toBe(true);
  });

  it("does not merge distinct full accounts that share an 8-digit root", () => {
    expect(isSameKiwoomAccount("01234567-01", "01234567-02")).toBe(false);
    expect(isSameKiwoomAccount("01234567", "11234567-01")).toBe(false);
  });

  it("rejects incomplete and overlong account identifiers", () => {
    expect(isKiwoomAccountId("0123457")).toBe(false);
    expect(isKiwoomAccountId("01234567890")).toBe(false);
    expect(isSameKiwoomAccount("0123457", "01234567-01")).toBe(false);
  });
});
