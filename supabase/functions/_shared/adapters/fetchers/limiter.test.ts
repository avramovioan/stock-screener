import { assert, assertEquals } from "jsr:@std/assert@1";
import { TokenBucket } from "./limiter.ts";

Deno.test("TokenBucket(4/s, burst 1) spaces calls at least 250 ms apart", async () => {
  let clock = 0;
  const stamps: number[] = [];
  const bucket = new TokenBucket(
    4,
    1,
    () => clock,
    async (ms) => {
      clock += ms;
    },
  );
  for (let i = 0; i < 5; i++) {
    await bucket.take();
    stamps.push(clock);
  }
  assertEquals(stamps[0], 0);
  for (let i = 1; i < stamps.length; i++) {
    assert((stamps[i] ?? 0) - (stamps[i - 1] ?? 0) >= 250, `gap ${i}`);
  }
  assert((stamps.at(-1) ?? 0) >= 1000);
});
