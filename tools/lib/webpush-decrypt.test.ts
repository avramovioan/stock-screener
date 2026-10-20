import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptAes128gcm } from "./webpush-decrypt.ts";

// RFC 8291 encryption for one record, written independently of the decrypt helper.
function encrypt(plain: string, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const server = createECDH("prime256v1");
  const serverPublic = server.generateKeys();
  const secret = server.computeSecret(uaPublic);
  const salt = randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plain), Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21 + 65);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = 65;
  serverPublic.copy(header, 21);
  return Buffer.concat([header, body]);
}

describe("decryptAes128gcm", () => {
  it("decrypts what an independent RFC 8291 encryptor produced", () => {
    const ua = createECDH("prime256v1");
    const uaPublic = ua.generateKeys();
    const auth = randomBytes(16);
    const body = encrypt('{"title":"héllo"}', uaPublic, auth);
    expect(decryptAes128gcm(body, ua, auth)).toBe('{"title":"héllo"}');
  });

  it("fails on a flipped ciphertext bit", () => {
    const ua = createECDH("prime256v1");
    const uaPublic = ua.generateKeys();
    const auth = randomBytes(16);
    const body = encrypt("secret", uaPublic, auth);
    body[body.length - 20] = (body[body.length - 20] ?? 0) ^ 1;
    expect(() => decryptAes128gcm(body, ua, auth)).toThrow();
  });
});
