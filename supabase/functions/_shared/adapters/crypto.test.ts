import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  aadFor,
  CryptoError,
  currentKeyVersion,
  decryptSecret,
  encryptSecret,
  fromBytea,
  importKey,
  loadKey,
  open,
  seal,
  toBytea,
} from "./crypto.ts";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const randomKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const env = (vars: Record<string, string>) => ({ get: (name: string) => vars[name] });
const AAD = "row-aad";
const ctx = { userId: "user-1", connectionId: "conn-1" };

Deno.test("roundtrip: decrypt returns the plain token, the IV is 12 random bytes, the ciphertext hides the token", async () => {
  const key = await importKey(randomKey());
  const a = await encryptSecret("1234567890123456789", key, 1, AAD);
  const b = await encryptSecret("1234567890123456789", key, 1, AAD);
  assertEquals(a.iv.length, 12);
  assertNotEquals(Array.from(a.iv), Array.from(b.iv));
  assertNotEquals(Array.from(a.ciphertext), Array.from(b.ciphertext));
  assert(!new TextDecoder().decode(a.ciphertext).includes("1234567890"));
  assertEquals(await decryptSecret(a, key, 1, AAD), "1234567890123456789");
});

Deno.test("a wrong key fails authentication", async () => {
  const sealed = await encryptSecret("secret", await importKey(randomKey()), 1, AAD);
  const other = await importKey(randomKey());
  const err = await assertRejects(() => decryptSecret(sealed, other, 1, AAD), CryptoError);
  assertEquals((err as CryptoError).code, "decrypt_failed");
});

Deno.test("a tampered ciphertext, a truncated ciphertext and a tampered IV are detected", async () => {
  const key = await importKey(randomKey());
  const sealed = await encryptSecret("secret", key, 1, AAD);
  const flipped = { ...sealed, ciphertext: sealed.ciphertext.map((x, i) => (i === 0 ? x ^ 1 : x)) };
  const short = { ...sealed, ciphertext: sealed.ciphertext.slice(0, sealed.ciphertext.length - 1) };
  const iv = { ...sealed, iv: sealed.iv.map((x, i) => (i === 0 ? x ^ 1 : x)) };
  for (const bad of [flipped, short, iv]) {
    const err = await assertRejects(() => decryptSecret(bad, key, 1, AAD), CryptoError);
    assertEquals((err as CryptoError).code, "decrypt_failed");
  }
});

Deno.test("a version mismatch is rejected before the key is used (rotated key)", async () => {
  const key2 = await importKey(randomKey());
  const sealed = await encryptSecret("secret", await importKey(randomKey()), 1, AAD);
  const err = await assertRejects(() => decryptSecret(sealed, key2, 2, AAD), CryptoError);
  assertEquals((err as CryptoError).code, "version_mismatch");
});

Deno.test("additional authenticated data binds the ciphertext to its row", async () => {
  const key = await importKey(randomKey());
  const sealed = await encryptSecret("secret", key, 1, aadFor(ctx, 1));
  assertEquals(await decryptSecret(sealed, key, 1, aadFor(ctx, 1)), "secret");
  const err = await assertRejects(
    () => decryptSecret(sealed, key, 1, aadFor({ ...ctx, connectionId: "conn-2" }, 1)),
    CryptoError,
  );
  assertEquals((err as CryptoError).code, "decrypt_failed");
});

Deno.test("keys must be base64 of exactly 32 bytes", async () => {
  for (const bad of ["", "not base64!!", b64(new Uint8Array(16)), b64(new Uint8Array(33))]) {
    const err = await assertRejects(() => importKey(bad), CryptoError);
    assertEquals((err as CryptoError).code, "bad_key");
  }
});

Deno.test("loadKey reads FLEX_ENC_KEY_V<n> and reports a retired key as key_missing", async () => {
  const e = env({ FLEX_ENC_KEY_V2: randomKey() });
  await loadKey(2, e);
  const err = await assertRejects(() => loadKey(1, e), CryptoError);
  assertEquals((err as CryptoError).code, "key_missing");
  assertEquals((err as CryptoError).message.includes("FLEX_ENC_KEY_V1"), true);
});

Deno.test("currentKeyVersion defaults to 1 and rejects nonsense", () => {
  assertEquals(currentKeyVersion(env({})), 1);
  assertEquals(currentKeyVersion(env({ FLEX_ENC_KEY_CURRENT: "2" })), 2);
  for (const bad of ["0", "-1", "x", "1.5"]) {
    let threw = false;
    try {
      currentKeyVersion(env({ FLEX_ENC_KEY_CURRENT: bad }));
    } catch (e) {
      threw = e instanceof CryptoError;
    }
    assert(threw, bad);
  }
});

Deno.test("seal and open use the current key, the stored version and the row context; rotation re-encrypts", async () => {
  const k1 = randomKey();
  const k2 = randomKey();
  const sealedV1 = await seal("tok", ctx, env({ FLEX_ENC_KEY_V1: k1, FLEX_ENC_KEY_CURRENT: "1" }));
  assertEquals(sealedV1.version, 1);
  // both keys present: the stored version selects the key
  const both = env({ FLEX_ENC_KEY_V1: k1, FLEX_ENC_KEY_V2: k2, FLEX_ENC_KEY_CURRENT: "2" });
  assertEquals(await open(sealedV1, ctx, both), "tok");
  const sealedV2 = await seal(await open(sealedV1, ctx, both), ctx, both);
  assertEquals(sealedV2.version, 2);
  assertEquals(await open(sealedV2, ctx, both), "tok");
  // V1 retired: the old ciphertext can no longer be opened, the new one can
  const retired = env({ FLEX_ENC_KEY_V2: k2, FLEX_ENC_KEY_CURRENT: "2" });
  const err = await assertRejects(() => open(sealedV1, ctx, retired), CryptoError);
  assertEquals((err as CryptoError).code, "key_missing");
  assertEquals(await open(sealedV2, ctx, retired), "tok");
  // the ciphertext cannot be moved to another row
  await assertRejects(() => open(sealedV2, { ...ctx, userId: "user-2" }, retired), CryptoError);
});

Deno.test("bytea helpers roundtrip the PostgREST hex form", () => {
  const bytes = new Uint8Array([0, 1, 254, 255]);
  assertEquals(toBytea(bytes), "\\x0001feff");
  assertEquals(Array.from(fromBytea("\\x0001feff")), [0, 1, 254, 255]);
  assertEquals(Array.from(fromBytea("0001feff")), [0, 1, 254, 255]);
});
