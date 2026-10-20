import { describe, expect, it } from "vitest";
import {
  classifyFlexCode,
  FLEX_ERRORS,
  flexErrorInfo,
  MAX_POLLS,
  POLL_DELAYS_S,
  SEND_RETRY_LIMIT,
  UNKNOWN_CODE_RETRIES,
} from "./flex-errors.ts";

describe("Flex error table (spec 12.4)", () => {
  it("covers 1001 and 1003 to 1021 and nothing else", () => {
    const codes = Object.keys(FLEX_ERRORS)
      .map(Number)
      .sort((a, b) => a - b);
    expect(codes).toEqual([1001, ...Array.from({ length: 19 }, (_, i) => 1003 + i)]);
  });

  it("retryable codes are exactly 1001, 1004-1009, 1018, 1019, 1021", () => {
    const retry = Object.values(FLEX_ERRORS)
      .filter((e) => e.cls === "retry")
      .map((e) => e.code);
    expect(retry.sort((a, b) => a - b)).toEqual([
      1001, 1004, 1005, 1006, 1007, 1008, 1009, 1018, 1019, 1021,
    ]);
  });

  it("fatal codes are exactly 1003, 1010-1011, 1013-1017, 1020 and 1012 is the expired class", () => {
    const fatal = Object.values(FLEX_ERRORS)
      .filter((e) => e.cls === "fatal")
      .map((e) => e.code);
    expect(fatal.sort((a, b) => a - b)).toEqual([
      1003, 1010, 1011, 1013, 1014, 1015, 1016, 1017, 1020,
    ]);
    expect(FLEX_ERRORS[1012]?.cls).toBe("expired");
    expect(FLEX_ERRORS[1012]?.connection).toBe("expired");
  });

  it("1018 never counts as a poll and waits 60 s; 1009 waits 60 s", () => {
    expect(FLEX_ERRORS[1018]).toMatchObject({ countsAsPoll: false, retryAfterSeconds: 60 });
    expect(FLEX_ERRORS[1009]?.retryAfterSeconds).toBe(60);
    expect(FLEX_ERRORS[1019]).toMatchObject({ countsAsPoll: true });
  });

  it("credential and query problems put the connection in error, 1017 and 1003 do not", () => {
    for (const code of [1010, 1011, 1013, 1014, 1015, 1016])
      expect(FLEX_ERRORS[code]?.connection).toBe("error");
    expect(FLEX_ERRORS[1017]?.connection).toBeNull();
    expect(FLEX_ERRORS[1003]?.connection).toBeNull();
  });

  it("every entry has a message and a troubleshooting hint without the token placeholder", () => {
    for (const info of Object.values(FLEX_ERRORS)) {
      expect(info.message.length).toBeGreaterThan(10);
      expect(info.hint.length).toBeGreaterThan(10);
      expect(`${info.message} ${info.hint}`).not.toMatch(/\{token\}/i);
    }
  });

  it("unknown codes are retried twice and then fatal", () => {
    expect(UNKNOWN_CODE_RETRIES).toBe(2);
    expect(classifyFlexCode(1999, 0)).toBe("retry");
    expect(classifyFlexCode(1999, 1)).toBe("retry");
    expect(classifyFlexCode(1999, 2)).toBe("fatal");
    expect(classifyFlexCode(1019, 50)).toBe("retry");
    expect(classifyFlexCode(1012, 0)).toBe("expired");
  });

  it("internal codes: transport is retryable, the others are fatal", () => {
    expect(flexErrorInfo(0).cls).toBe("retry");
    for (const code of [-1, -2, -3, -4, -5, -6, -7]) expect(flexErrorInfo(code).cls).toBe("fatal");
    expect(flexErrorInfo(-2).message).toMatch(/cannot be decrypted/i);
    expect(flexErrorInfo(-3).message).toMatch(/different account/i);
  });

  it("the poll budget is ten polls and ten minutes", () => {
    expect(MAX_POLLS).toBe(10);
    expect(POLL_DELAYS_S).toHaveLength(10);
    expect(POLL_DELAYS_S.reduce((a, b) => a + b, 0)).toBe(600);
    expect(Math.min(...POLL_DELAYS_S)).toBeGreaterThanOrEqual(15);
    expect(SEND_RETRY_LIMIT).toBe(5);
  });
});
