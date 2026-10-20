import { describe, expect, it } from "vitest";
import { urlBase64ToUint8Array } from "./vapid-key";

describe("urlBase64ToUint8Array", () => {
  it("decodes url-safe base64 without padding", () => {
    expect([...urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array("-_8")]).toEqual([251, 255]);
  });
  it("round trips a 65 byte application server key", () => {
    const bytes = new Uint8Array([4, ...Array.from({ length: 64 }, (_, i) => i * 3)]);
    const text = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(urlBase64ToUint8Array(text)).toEqual(bytes);
  });
  it("throws on characters outside the alphabet", () => {
    expect(() => urlBase64ToUint8Array("***")).toThrow();
  });
});
