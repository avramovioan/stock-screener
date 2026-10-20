import { describe, expect, it } from "vitest";
import { generateVapid, parseGenVapidArgs } from "./vapid.ts";

function fromBase64Url(text: string): Buffer {
  return Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

describe("generateVapid", () => {
  it("returns a 65 byte uncompressed public key and a matching private JWK", async () => {
    const keys = await generateVapid();
    const raw = fromBase64Url(keys.publicKey);
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(4);
    expect(keys.privateKeyJwk.kty).toBe("EC");
    expect(keys.privateKeyJwk.crv).toBe("P-256");
    expect(typeof keys.privateKeyJwk.d).toBe("string");
    expect(fromBase64Url(keys.privateKeyJwk.x ?? "")).toEqual(raw.subarray(1, 33));
    expect(fromBase64Url(keys.privateKeyJwk.y ?? "")).toEqual(raw.subarray(33, 65));
  });

  it("formats env lines for supabase secrets and the SPA, with the private key on one line", async () => {
    const keys = await generateVapid();
    const lines = keys.envLines("mailto:ops@example.test").split("\n");
    expect(lines).toContain(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
    expect(lines).toContain("VAPID_SUBJECT=mailto:ops@example.test");
    expect(lines.some((l) => l.startsWith("VAPID_PRIVATE_KEY={") && l.endsWith("}"))).toBe(true);
    expect(lines).toContain(`VITE_VAPID_PUBLIC_KEY=${keys.publicKey}`);
  });

  it("generates a different pair every time", async () => {
    expect((await generateVapid()).publicKey).not.toBe((await generateVapid()).publicKey);
  });
});

describe("parseGenVapidArgs", () => {
  it("takes the subject with and without --out", () => {
    expect(parseGenVapidArgs(["mailto:a@b.test"])).toEqual({
      subject: "mailto:a@b.test",
      outPath: undefined,
    });
    expect(parseGenVapidArgs(["mailto:a@b.test", "--out", ".env.vapid"])).toEqual({
      subject: "mailto:a@b.test",
      outPath: ".env.vapid",
    });
    expect(parseGenVapidArgs(["--out", ".env.vapid", "mailto:a@b.test"]).subject).toBe(
      "mailto:a@b.test",
    );
    expect(parseGenVapidArgs([]).subject).toBe("");
  });
});
