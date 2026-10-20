import { createDecipheriv, type ECDH, hkdfSync } from "node:crypto";

/** Decrypts one aes128gcm Web Push record (RFC 8188 framing, RFC 8291 key derivation). */
export function decryptAes128gcm(body: Buffer, ua: ECDH, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const serverPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const uaPublic = ua.getPublicKey();
  const secret = ua.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (end === 0 || padded[end - 1] !== 2) throw new Error("missing last-record delimiter");
  return padded.subarray(0, end - 1).toString("utf8");
}
