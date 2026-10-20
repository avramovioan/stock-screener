import { describe, expect, it } from "vitest";
import { deliveryWindow } from "./delivery-window";

const at = (iso: string, timeZone: string) =>
  deliveryWindow(new Date(iso), { timeZone, locale: "en-US" });

describe("deliveryWindow", () => {
  it("is 10:00 to 11:00 for a viewer in Sofia, in winter and in summer", () => {
    expect(at("2026-01-15T12:00:00Z", "Europe/Sofia")).toEqual({
      start: "10:00 AM",
      end: "11:00 AM",
    });
    expect(at("2026-07-15T12:00:00Z", "Europe/Sofia")).toEqual({
      start: "10:00 AM",
      end: "11:00 AM",
    });
  });

  it("converts to UTC", () => {
    expect(at("2026-01-15T12:00:00Z", "UTC")).toEqual({ start: "8:00 AM", end: "9:00 AM" });
    expect(at("2026-07-15T12:00:00Z", "UTC")).toEqual({ start: "7:00 AM", end: "8:00 AM" });
  });

  it("converts to New York with its own daylight saving time", () => {
    expect(at("2026-07-15T12:00:00Z", "America/New_York")).toEqual({
      start: "3:00 AM",
      end: "4:00 AM",
    });
    expect(at("2026-01-15T12:00:00Z", "America/New_York")).toEqual({
      start: "3:00 AM",
      end: "4:00 AM",
    });
  });

  it("converts to Tokyo", () => {
    expect(at("2026-07-15T12:00:00Z", "Asia/Tokyo")).toEqual({ start: "4:00 PM", end: "5:00 PM" });
  });

  it("uses the offsets of the day itself on Sofia's change day (29 March 2026)", () => {
    // 23:30Z on the 28th is already 29 March in Sofia, where summer time has just begun.
    expect(at("2026-03-28T23:30:00Z", "UTC")).toEqual({ start: "7:00 AM", end: "8:00 AM" });
  });

  it("uses the offsets of the day itself on New York's change day (8 March 2026)", () => {
    expect(at("2026-03-08T12:00:00Z", "America/New_York")).toEqual({
      start: "4:00 AM",
      end: "5:00 AM",
    });
  });

  it("reads the Sofia calendar day of now, not the viewer's", () => {
    // 22:30Z on 14 July is 01:30 on the 15th in Sofia: the 15th's window, 07:00Z.
    expect(at("2026-07-14T22:30:00Z", "UTC")).toEqual({ start: "7:00 AM", end: "8:00 AM" });
  });
});
