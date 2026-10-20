import { assertEquals } from "@std/assert";
import { authenticate, bearerToken, createClaimsVerifier } from "./user-auth.ts";

const req = (authorization?: string) =>
  new Request("https://x.test/fn", {
    headers: authorization === undefined ? {} : { authorization },
  });

Deno.test("bearerToken accepts a JWT-shaped bearer value only", () => {
  assertEquals(bearerToken(req("Bearer aaa.bbb.ccc")), "aaa.bbb.ccc");
  assertEquals(bearerToken(req("bearer aaa.bbb.ccc")), "aaa.bbb.ccc");
  assertEquals(bearerToken(req()), null);
  assertEquals(bearerToken(req("Basic abc")), null);
  assertEquals(bearerToken(req("Bearer a b")), null);
  assertEquals(bearerToken(req("Bearer ")), null);
});

Deno.test("authenticate returns 401 without a token or when the verifier rejects or throws", async () => {
  const reject = { verify: () => Promise.resolve(null) };
  const boom = { verify: () => Promise.reject(new Error("network")) };
  for (const [r, v] of [
    [req(), reject],
    [req("Bearer a.b.c"), reject],
    [req("Bearer a.b.c"), boom],
  ] as const) {
    const out = await authenticate(r, v);
    assertEquals(out.ok, false);
    if (!out.ok) {
      assertEquals(out.response.status, 401);
      assertEquals(await out.response.json(), { error: "unauthorized" });
    }
  }
});

Deno.test("authenticate returns the verified user id", async () => {
  const out = await authenticate(req("Bearer a.b.c"), {
    verify: () => Promise.resolve({ userId: "u1" }),
  });
  assertEquals(out, { ok: true, userId: "u1" });
});

Deno.test("the claims verifier uses getClaims and requires an authenticated subject", async () => {
  const calls: string[] = [];
  const make = (claims: unknown, error: unknown = null) =>
    createClaimsVerifier({
      url: "http://localhost/",
      anonKey: "anon",
      createClient: () =>
        ({
          auth: {
            getClaims: (jwt: string) => {
              calls.push(jwt);
              return Promise.resolve({ data: claims === null ? null : { claims }, error });
            },
          },
        }) as never,
    });
  const good = {
    sub: "u1",
    role: "authenticated",
    aud: "authenticated",
    iss: "http://localhost/auth/v1",
  };
  assertEquals(await make(good).verify("jwt-1"), { userId: "u1" });
  assertEquals(calls, ["jwt-1"]);
  assertEquals(await make({ ...good, iss: "http://localhost/auth/v1/" }).verify("jwt"), {
    userId: "u1",
  });
  assertEquals(await make({ ...good, aud: "other" }).verify("jwt"), null);
  assertEquals(await make({ ...good, aud: undefined }).verify("jwt"), null);
  assertEquals(await make({ ...good, iss: "https://evil.test/auth/v1" }).verify("jwt"), null);
  assertEquals(await make({ ...good, iss: undefined }).verify("jwt"), null);
  assertEquals(await make({ ...good, role: "anon" }).verify("jwt"), null);
  assertEquals(await make({ ...good, sub: undefined }).verify("jwt"), null);
  assertEquals(await make(null, { message: "bad" }).verify("jwt"), null);
});

Deno.test("JWT_ISSUER: an explicit issuer is matched exactly and replaces the SUPABASE_URL rule", async () => {
  const verifier = (issuer: string | undefined) =>
    createClaimsVerifier({
      url: "http://kong:8000",
      anonKey: "anon",
      issuer,
      createClient: () =>
        ({
          auth: {
            getClaims: () =>
              Promise.resolve({
                data: {
                  claims: {
                    sub: "u1",
                    role: "authenticated",
                    aud: "authenticated",
                    iss: "http://127.0.0.1:54321/auth/v1",
                  },
                },
                error: null,
              }),
          },
        }) as never,
    });
  assertEquals(await verifier(undefined).verify("jwt"), null);
  assertEquals(await verifier("").verify("jwt"), null);
  assertEquals(await verifier("http://127.0.0.1:54321/auth/v1").verify("jwt"), { userId: "u1" });
  assertEquals(await verifier("http://kong:8000/auth/v1").verify("jwt"), null);
});
