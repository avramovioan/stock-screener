import { assertEquals } from "@std/assert";
import { type AccessStore, handle, type Lookup } from "./handler.ts";

const SITE = "https://site.example";

class FakeStore implements AccessStore {
  invited = new Map<string, boolean>(); // e-mail -> reset_password
  users = new Map<string, string>(); // e-mail -> user id
  passwords = new Map<string, string>();
  created: string[] = [];
  cleared: string[] = [];
  createRaces = false;
  lookup(email: string): Promise<Lookup> {
    return Promise.resolve({
      invited: this.invited.has(email),
      resetPassword: this.invited.get(email) ?? false,
      userId: this.users.get(email) ?? null,
    });
  }
  createUser(email: string, password: string) {
    if (this.createRaces) return Promise.resolve("exists" as const);
    this.created.push(email);
    this.users.set(email, `id-${email}`);
    this.passwords.set(email, password);
    return Promise.resolve("ok" as const);
  }
  setPassword(userId: string, password: string) {
    this.passwords.set(userId, password);
    return Promise.resolve();
  }
  clearReset(email: string) {
    this.cleared.push(email);
    this.invited.set(email, false);
    return Promise.resolve();
  }
}

function setup(
  limit: { allowed: boolean; retryAfterSeconds: number } | "down" = {
    allowed: true,
    retryAfterSeconds: 0,
  },
) {
  const store = new FakeStore();
  const handler = (req: Request) =>
    handle(req, {
      store,
      limit: () => (limit === "down" ? Promise.reject(new Error("down")) : Promise.resolve(limit)),
      allowedOrigins: [SITE],
    });
  return { store, handler };
}

const post = (body: unknown, origin = SITE) =>
  new Request("https://f.example/account-access", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function call(h: (r: Request) => Promise<Response>, body: unknown) {
  const res = await h(post(body));
  return { status: res.status, body: await res.json(), res };
}

const GOOD = "correct horse battery";

Deno.test("check: not on the list is not_possible", async () => {
  const { handler } = setup();
  const r = await call(handler, { action: "check", email: "x@y.com" });
  assertEquals([r.status, r.body], [200, { status: "not_possible" }]);
});

Deno.test("check: malformed e-mail or body is not_possible", async () => {
  const { handler } = setup();
  assertEquals((await call(handler, { action: "check", email: "nope" })).body, {
    status: "not_possible",
  });
  assertEquals((await call(handler, { action: "check" })).body, { status: "not_possible" });
  assertEquals((await call(handler, { action: "check", email: 5 })).body, {
    status: "not_possible",
  });
});

Deno.test("check: invited without an account creates a password; e-mail is trimmed and lower-cased", async () => {
  const { handler, store } = setup();
  store.invited.set("a@b.com", false);
  const r = await call(handler, { action: "check", email: "  A@B.com " });
  assertEquals(r.body, { status: "create_password" });
});

Deno.test("check: invited with an account signs in; with a reset pending creates a password", async () => {
  const { handler, store } = setup();
  store.invited.set("a@b.com", false);
  store.users.set("a@b.com", "u1");
  assertEquals((await call(handler, { action: "check", email: "a@b.com" })).body, {
    status: "sign_in",
  });
  store.invited.set("a@b.com", true);
  assertEquals((await call(handler, { action: "check", email: "a@b.com" })).body, {
    status: "create_password",
  });
});

Deno.test("set_password: creates the confirmed user for an invited e-mail", async () => {
  const { handler, store } = setup();
  store.invited.set("a@b.com", false);
  const r = await call(handler, { action: "set_password", email: " A@b.com", password: GOOD });
  assertEquals([r.status, r.body], [200, { ok: true }]);
  assertEquals(store.created, ["a@b.com"]);
});

Deno.test("set_password: a pending reset updates the password and clears the flag", async () => {
  const { handler, store } = setup();
  store.invited.set("a@b.com", true);
  store.users.set("a@b.com", "u1");
  const r = await call(handler, { action: "set_password", email: "a@b.com", password: GOOD });
  assertEquals([r.status, r.body], [200, { ok: true }]);
  assertEquals(store.passwords.get("u1"), GOOD);
  assertEquals(store.cleared, ["a@b.com"]);
});

Deno.test("set_password: creating a user also clears a stale reset flag", async () => {
  const { handler, store } = setup();
  store.invited.set("a@b.com", true);
  await call(handler, { action: "set_password", email: "a@b.com", password: GOOD });
  assertEquals(store.cleared, ["a@b.com"]);
});

Deno.test("set_password: not on the list is 403 not_possible", async () => {
  const { handler, store } = setup();
  const r = await call(handler, { action: "set_password", email: "x@y.com", password: GOOD });
  assertEquals([r.status, r.body], [403, { ok: false, reason: "not_possible" }]);
  assertEquals(store.created, []);
});

Deno.test("set_password: an existing user with no reset pending is 403 and keeps the password", async () => {
  const { handler, store } = setup();
  store.invited.set("a@b.com", false);
  store.users.set("a@b.com", "u1");
  const r = await call(handler, { action: "set_password", email: "a@b.com", password: GOOD });
  assertEquals([r.status, r.body], [403, { ok: false, reason: "not_possible" }]);
  assertEquals(store.passwords.has("u1"), false);
});

Deno.test("set_password: losing a create race is 403", async () => {
  const { handler, store } = setup();
  store.invited.set("a@b.com", false);
  store.createRaces = true;
  const r = await call(handler, { action: "set_password", email: "a@b.com", password: GOOD });
  assertEquals([r.status, r.body], [403, { ok: false, reason: "not_possible" }]);
});

Deno.test("set_password: passwords under 12 or over 72 characters are weak", async () => {
  const { handler, store } = setup();
  store.invited.set("a@b.com", false);
  for (const pw of ["short", "x".repeat(11), "x".repeat(73)]) {
    const r = await call(handler, { action: "set_password", email: "a@b.com", password: pw });
    assertEquals([r.status, r.body], [400, { ok: false, reason: "weak_password" }]);
  }
  const edge = await call(handler, {
    action: "set_password",
    email: "a@b.com",
    password: "x".repeat(72),
  });
  assertEquals(edge.status, 200);
});

Deno.test("rate limited: 429 with retry_after_seconds, nothing read", async () => {
  const { handler, store } = setup({ allowed: false, retryAfterSeconds: 42 });
  store.invited.set("a@b.com", false);
  const r = await call(handler, { action: "set_password", email: "a@b.com", password: GOOD });
  assertEquals(
    [r.status, r.body],
    [429, { ok: false, reason: "rate_limited", retry_after_seconds: 42 }],
  );
  assertEquals(r.res.headers.get("retry-after"), "42");
  assertEquals(store.created, []);
});

Deno.test("rate limiter down: the request still runs", async () => {
  const { handler, store } = setup("down");
  store.invited.set("a@b.com", false);
  assertEquals((await call(handler, { action: "check", email: "a@b.com" })).body, {
    status: "create_password",
  });
});

Deno.test("CORS preflight, unknown action and wrong method", async () => {
  const { handler } = setup();
  const pre = await handler(
    new Request("https://f.example/x", { method: "OPTIONS", headers: { origin: SITE } }),
  );
  assertEquals([pre.status, pre.headers.get("access-control-allow-origin")], [204, SITE]);
  const bad = await handler(
    new Request("https://f.example/x", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }),
  );
  assertEquals(bad.status, 403);
  assertEquals((await call(handler, { action: "dance" })).status, 400);
  assertEquals((await handler(new Request("https://f.example/x", { method: "GET" }))).status, 405);
});

Deno.test("a store failure answers 500 without leaking details", async () => {
  const { handler, store } = setup();
  store.lookup = () => Promise.reject(new Error("boom a@b.com"));
  const r = await call(handler, { action: "check", email: "a@b.com" });
  assertEquals([r.status, JSON.stringify(r.body).includes("a@b.com")], [500, false]);
});
