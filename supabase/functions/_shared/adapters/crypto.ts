// AES-GCM-256 for the Flex token (spec 6.7). WebCrypto only; the key lives in function secrets, never in the database.

export type CryptoErrorCode =
  | "key_missing"
  | "bad_key"
  | "version_mismatch"
  | "decrypt_failed"
  | "bad_input";

export class CryptoError extends Error {
  constructor(
    readonly code: CryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CryptoError";
  }
}

export interface Sealed {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  version: number;
}

export interface EnvReader {
  get(name: string): string | undefined;
}

const IV_BYTES = 12;
const KEY_BYTES = 32;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function keyEnvName(version: number): string {
  if (!Number.isInteger(version) || version < 1)
    throw new CryptoError("bad_input", "key version must be a positive integer");
  return `FLEX_ENC_KEY_V${version}`;
}

export function currentKeyVersion(env: EnvReader): number {
  const raw = env.get("FLEX_ENC_KEY_CURRENT");
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new CryptoError("bad_input", "FLEX_ENC_KEY_CURRENT must be a positive integer");
  return n;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(base64Key);
  } catch {
    throw new CryptoError("bad_key", "the encryption key is not valid base64");
  }
  if (raw.length !== KEY_BYTES)
    throw new CryptoError("bad_key", `the encryption key must be ${KEY_BYTES} bytes`);
  return await crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function loadKey(version: number, env: EnvReader): Promise<CryptoKey> {
  const name = keyEnvName(version);
  const value = env.get(name);
  if (value === undefined || value.trim() === "")
    throw new CryptoError("key_missing", `${name} is not set`);
  return await importKey(value);
}

/** AAD = `userId:connectionId:keyVersion`: a ciphertext copied to another row (or re-labelled with another version) fails to open. */
export function aadFor(ctx: { userId: string; connectionId: string }, version: number): string {
  return `${ctx.userId}:${ctx.connectionId}:${version}`;
}

export async function encryptSecret(
  plain: string,
  key: CryptoKey,
  version: number,
  aad: string,
): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plain),
  );
  return { ciphertext: new Uint8Array(ct), iv, version };
}

export async function decryptSecret(
  sealed: Sealed,
  key: CryptoKey,
  keyVersion: number,
  aad: string,
): Promise<string> {
  if (sealed.version !== keyVersion) {
    throw new CryptoError(
      "version_mismatch",
      `ciphertext was sealed with key version ${sealed.version}, not ${keyVersion}`,
    );
  }
  if (sealed.iv.length !== IV_BYTES)
    throw new CryptoError("decrypt_failed", "ciphertext could not be authenticated");
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(sealed.iv), additionalData: enc.encode(aad) },
      key,
      new Uint8Array(sealed.ciphertext),
    );
    return dec.decode(pt);
  } catch {
    throw new CryptoError("decrypt_failed", "ciphertext could not be authenticated");
  }
}

/** Seal with the CURRENT key version (`FLEX_ENC_KEY_CURRENT`, default 1). */
export async function seal(
  plain: string,
  ctx: { userId: string; connectionId: string },
  env: EnvReader,
): Promise<Sealed> {
  const version = currentKeyVersion(env);
  return await encryptSecret(plain, await loadKey(version, env), version, aadFor(ctx, version));
}

/** Open with the key of the STORED version; a retired key is `key_missing`, never a silent fallback. */
export async function open(
  sealed: Sealed,
  ctx: { userId: string; connectionId: string },
  env: EnvReader,
): Promise<string> {
  const key = await loadKey(sealed.version, env);
  return await decryptSecret(sealed, key, sealed.version, aadFor(ctx, sealed.version));
}

/** PostgREST represents bytea as the hex string `\x0102`. */
export function toBytea(bytes: Uint8Array): string {
  return `\\x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function fromBytea(value: string): Uint8Array {
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex))
    throw new CryptoError("bad_input", "invalid bytea value");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
