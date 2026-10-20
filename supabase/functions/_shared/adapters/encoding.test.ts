import { assertEquals, assertThrows } from "@std/assert";
import { base64Decode, base64Encode, base64UrlDecode, base64UrlEncode } from "./encoding.ts";

Deno.test("base64 and base64url round trip, url form has no padding or +/", () => {
  const bytes = new Uint8Array([251, 255, 254, 0, 1, 2, 3]);
  assertEquals(base64Decode(base64Encode(bytes)), bytes);
  const url = base64UrlEncode(bytes);
  assertEquals(/[+/=]/.test(url), false);
  assertEquals(base64UrlDecode(url), bytes);
});

Deno.test("base64UrlDecode accepts padded and unpadded input and rejects garbage", () => {
  assertEquals(base64UrlDecode("AQID"), new Uint8Array([1, 2, 3]));
  assertEquals(base64UrlDecode("AQI="), new Uint8Array([1, 2]));
  assertThrows(() => base64UrlDecode("***"));
});
