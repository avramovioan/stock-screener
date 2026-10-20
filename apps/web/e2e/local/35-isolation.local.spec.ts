import { expect, test } from "@playwright/test";
import { ANON, accessToken, api, OTHER, OWNER, SERVICE, userId } from "./support/stack";

async function rows(res: { ok(): boolean; json(): Promise<unknown> }): Promise<unknown[]> {
  return res.ok() ? ((await res.json()) as unknown[]) : [];
}

test("the owner reads the fixture statement; another user and anon read nothing", async () => {
  const owner = await api(ANON, await accessToken(OWNER));
  const other = await api(ANON, await accessToken(OTHER));
  const anon = await api(ANON);
  for (const table of ["broker_positions", "broker_trades", "broker_nav", "broker_sync_runs"]) {
    const mine = await rows(await owner.get(`/rest/v1/${table}?select=user_id&limit=5`));
    expect(mine.length, `${table} rows for the owner`).toBeGreaterThan(0);
    expect(
      await rows(await other.get(`/rest/v1/${table}?select=user_id&limit=5`)),
      `${table} for another user`,
    ).toEqual([]);
    expect(
      await rows(await anon.get(`/rest/v1/${table}?select=user_id&limit=5`)),
      `${table} for anon`,
    ).toEqual([]);
  }
});

test("secret columns and admin functions are closed", async () => {
  const owner = await api(ANON, await accessToken(OWNER));
  const anon = await api(ANON);
  expect(
    (await owner.get("/rest/v1/broker_connections?select=*")).ok(),
    "select * on broker_connections",
  ).toBe(false);
  expect((await owner.get("/rest/v1/broker_connections?select=status")).ok()).toBe(true);
  expect(
    (await owner.get("/rest/v1/push_subscriptions?select=endpoint,p256dh,auth")).ok(),
    "push key columns",
  ).toBe(false);
  expect(
    (await anon.post("/rest/v1/rpc/is_admin", { data: {} })).ok(),
    "anon executes is_admin",
  ).toBe(false);
  const ownerAdmin = await owner.post("/rest/v1/rpc/is_admin", { data: {} });
  expect(await ownerAdmin.json()).toBe(false);
  const me = await userId(OWNER.email);
  const promote = await owner.patch(`/rest/v1/profiles?user_id=eq.${me}`, {
    data: { is_admin: true },
  });
  // refused outright, or silently a no-op: either way the flag must not have changed
  const svc = await api(SERVICE);
  const after = (await (
    await svc.get(`/rest/v1/profiles?select=is_admin&user_id=eq.${me}`)
  ).json()) as Array<{ is_admin: boolean }>;
  await svc.dispose();
  expect(after[0]?.is_admin, `self-promotion (HTTP ${promote.status()})`).toBe(false);
});
