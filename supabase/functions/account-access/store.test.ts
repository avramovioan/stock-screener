import { assertEquals, assertRejects } from "@std/assert";
import { createAccessStore } from "./store.ts";

type Call = { fn: string; args: unknown };

function fakeDb(opts: { createError?: { status?: number; code?: string; message: string } } = {}) {
  const calls: Call[] = [];
  const db = {
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      if (fn === "account_access_lookup") {
        return Promise.resolve({
          data: [{ invited: true, reset_password: true, user_id: "u1" }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    auth: {
      admin: {
        createUser(a: unknown) {
          calls.push({ fn: "createUser", args: a });
          return Promise.resolve({
            data: {},
            error: opts.createError ?? null,
          });
        },
        updateUserById(id: string, a: unknown) {
          calls.push({ fn: "updateUserById", args: { id, a } });
          return Promise.resolve({ data: {}, error: null });
        },
      },
    },
  };
  return { db, calls };
}

Deno.test("lookup maps the RPC row", async () => {
  const { db, calls } = fakeDb();
  const r = await createAccessStore(db as never).lookup("a@b.com");
  assertEquals(r, { invited: true, resetPassword: true, userId: "u1" });
  assertEquals(calls[0], { fn: "account_access_lookup", args: { p_email: "a@b.com" } });
});

Deno.test("createUser confirms the e-mail; a duplicate is exists", async () => {
  const ok = fakeDb();
  assertEquals(await createAccessStore(ok.db as never).createUser("a@b.com", "pw"), "ok");
  assertEquals(ok.calls[0]?.args, { email: "a@b.com", password: "pw", email_confirm: true });
  const dup = fakeDb({ createError: { status: 422, code: "email_exists", message: "x" } });
  assertEquals(await createAccessStore(dup.db as never).createUser("a@b.com", "pw"), "exists");
  const bad = fakeDb({ createError: { status: 500, message: "boom" } });
  await assertRejects(() => createAccessStore(bad.db as never).createUser("a@b.com", "pw"));
});

Deno.test("setPassword and clearReset call the admin API and the RPC", async () => {
  const { db, calls } = fakeDb();
  const s = createAccessStore(db as never);
  await s.setPassword("u1", "pw");
  await s.clearReset("a@b.com");
  assertEquals(calls[0], { fn: "updateUserById", args: { id: "u1", a: { password: "pw" } } });
  assertEquals(calls[1], { fn: "account_access_clear_reset", args: { p_email: "a@b.com" } });
});
