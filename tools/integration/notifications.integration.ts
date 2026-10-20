// biome-ignore-all lint/suspicious/noExplicitAny: PostgREST and function responses are untyped JSON
// Notifications integration suite against the LOCAL stack (P3 Task 7): `bun run test:integration:notifications`.
//
// Needs `supabase start` (it serves the functions) with supabase/functions/.env holding the fixture-mode values of
// supabase/functions/.env.example (VAPID keys from `bun run gen:vapid`, CRON_SHARED_SECRET, PUSH_ENDPOINT_EXTRA_HOSTS=host.docker.internal).
// Everything external is a fake server started here: a push service on port 54781 (the edge runtime reaches it as host.docker.internal).
//
// Each scenario builds its own far-future scan run (2030-01-xx) with synthetic candidates, drives `worker-tick` and `notify-dispatch` over
// HTTP and asserts through the service client. Runs stay out of the pipeline: a queued `fx` job with a far-future not_before blocks stage
// seeding. Everything it creates (users, runs, candidates) is deleted at the end.
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertLocalUrl, resolveStack } from "../lib/local-stack.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENV_FILE = `${ROOT}supabase/functions/.env`;
const PUSH_PORT = 54781;

if (!existsSync(ENV_FILE))
  throw new Error(`${ENV_FILE} is missing: see supabase/functions/.env.example`);
const env = Object.fromEntries(
  readFileSync(ENV_FILE, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;
if ((env.CRON_SHARED_SECRET ?? "") === "")
  throw new Error("CRON_SHARED_SECRET is missing in supabase/functions/.env");

const stack = resolveStack();
assertLocalUrl(stack.url);
const FUNCTIONS = `${stack.url}/functions/v1`;
const admin: SupabaseClient = createClient(stack.url, stack.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// fake services ---------------------------------------------------------------------------------------------
interface Seen {
  path: string;
  headers: Record<string, string>;
  body: string;
}
const pushSeen: Seen[] = [];
async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
const pushServer = createServer(async (req, res) => {
  pushSeen.push({
    path: req.url ?? "",
    headers: req.headers as Record<string, string>,
    body: await read(req),
  });
  if (req.url?.startsWith("/gone/")) res.writeHead(410).end();
  else if (req.url?.startsWith("/limited/")) res.writeHead(429, { "retry-after": "120" }).end();
  else res.writeHead(201).end();
}).listen(PUSH_PORT);
// helpers -----------------------------------------------------------------------------------------------------
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const created = {
  users: [] as string[],
  runs: [] as string[],
  companies: [] as string[],
  secs: [] as string[],
};

async function callFn(name: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return await fetch(`${FUNCTIONS}/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cron-secret": env.CRON_SHARED_SECRET ?? "",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
async function must<T>(
  q: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await q;
  if (error || data === null) throw new Error(error?.message ?? "no data");
  return data;
}
async function makeUser(label: string, prefs: { push?: boolean } = {}): Promise<string> {
  const email = `${label}-${randomBytes(4).toString("hex")}@integration.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: `Pw-${randomBytes(12).toString("hex")}-A1`,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  created.users.push(data.user.id);
  await must(
    admin
      .from("notification_preferences")
      .insert({
        user_id: data.user.id,
        push_enabled: prefs.push ?? false,
        digest_modes: ["worldwide"],
      })
      .select(),
  );
  return data.user.id;
}
async function addSub(userId: string, kind: "ok" | "gone" | "limited"): Promise<string> {
  const ua = createECDH("prime256v1");
  const endpoint = `http://host.docker.internal:${PUSH_PORT}/${kind}/${randomBytes(4).toString("hex")}`;
  await must(
    admin
      .from("push_subscriptions")
      .insert({
        user_id: userId,
        topic_portfolio: true,
        endpoint,
        p256dh: ua.generateKeys().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      })
      .select(),
  );
  return endpoint;
}

type RowSpec = { category: "green" | "amber" | "pending" | "red"; done: boolean; rank?: number };
let dayCounter = 10;
let secCounter = 0;
async function makeRun(status: "complete" | "running", specs: RowSpec[]) {
  await admin.from("exchanges").upsert(
    {
      code: "NMS",
      name: "NasdaqGS",
      country: "United States",
      timezone: "America/New_York",
      currencies: ["USD"],
    },
    { onConflict: "code", ignoreDuplicates: true },
  );
  const date = `2030-01-${String(dayCounter++).padStart(2, "0")}`;
  const real = (
    await must(
      admin
        .from("scan_runs")
        .select("settings_snapshot")
        .eq("status", "complete")
        .order("scan_date_local")
        .limit(1),
    )
  )[0] as { settings_snapshot: unknown } | undefined;
  const run = (await must(
    admin
      .from("scan_runs")
      .insert({
        scan_date_local: date,
        status,
        trigger: "manual",
        settings_snapshot: real?.settings_snapshot ?? { provider_mode: "fixture" },
      })
      .select("id")
      .single(),
  )) as { id: string };
  created.runs.push(run.id);
  // blocks stage seeding: the run never starts a pipeline of its own
  await must(
    admin
      .from("scan_jobs")
      .insert({
        scan_run_id: run.id,
        stage: "fx",
        key: "scenario-blocker",
        priority: 100,
        not_before: "2100-01-01T00:00:00Z",
        payload: {},
      })
      .select(),
  );
  const episodes: string[] = [];
  for (const [index, spec] of specs.entries()) {
    const n = ++secCounter;
    const company = (await must(
      admin
        .from("companies")
        .insert({ name: `Notify Co ${n}`, name_normalized: `notify co ${n}`, sector: "Technology" })
        .select("id")
        .single(),
    )) as { id: string };
    created.companies.push(company.id);
    const security = (await must(
      admin
        .from("securities")
        .insert({
          company_id: company.id,
          yahoo_symbol: `NTF${n}`,
          exchange_code: "NMS",
          currency: "USD",
          currency_major: "USD",
          quote_type: "EQUITY",
          is_canonical: true,
          role: "canonical",
        })
        .select("id")
        .single(),
    )) as { id: string };
    created.secs.push(security.id);
    const episode = (await must(
      admin
        .from("signal_episodes")
        .insert({
          security_id: security.id,
          company_id: company.id,
          kind: "discount",
          mode: "worldwide",
          threshold_line: "-3",
          opened_scan_run_id: run.id,
          opened_session_date: "2029-12-31",
          opened_close: 10,
          opened_line_value: 12,
          open_reason: "new_entry",
          last_evaluated_session_date: "2029-12-31",
        })
        .select("id")
        .single(),
    )) as { id: string };
    episodes.push(episode.id);
    await must(
      admin
        .from("todays_discounts")
        .insert({
          scan_run_id: run.id,
          mode: "worldwide",
          security_id: security.id,
          company_id: company.id,
          episode_id: episode.id,
          is_new_episode: true,
          rank: spec.rank ?? 10 + index,
          close: 10,
          currency: "USD",
          session_date: "2029-12-31",
          threshold_line: "-3",
          lower_line_end: 12,
          channel: {},
          trend_ok: true,
          eligibility: {},
          operational_category: spec.category,
          category_reason: spec.category === "pending" ? "research_pending" : "meets_checks",
          data_freshness: "fresh",
          display_order: index,
          withheld: spec.category === "pending" || spec.category === "red",
          summary: `candidate ${n}`,
          report_id: spec.done ? crypto.randomUUID() : null,
          research_completed_at: spec.done ? new Date().toISOString() : null,
        })
        .select(),
    );
  }
  return { id: run.id, date, episodes };
}
async function runDigestJob(runId: string, key: "digest" | "digest:cutoff") {
  await must(
    admin
      .from("scan_jobs")
      .upsert(
        {
          scan_run_id: runId,
          stage: "digest",
          key,
          priority: 5,
          status: "queued",
          attempts: 0,
          not_before: new Date().toISOString(),
        },
        { onConflict: "scan_run_id,stage,key" },
      )
      .select(),
  );
  for (let i = 0; i < 30; i++) {
    try {
      await callFn("worker-tick", { wait: true });
    } catch {
      // the edge runtime can answer 502 for a worker that hit a limit; the lease recovers, so tick again
    }
    const job = (await must(
      admin
        .from("scan_jobs")
        .select("status")
        .eq("scan_run_id", runId)
        .eq("stage", "digest")
        .eq("key", key)
        .single(),
    )) as { status: string };
    if (job.status === "done" || job.status === "dead") return job.status;
    await sleep(2000);
  }
  return "timeout";
}
type DigestRow = {
  id: string;
  kind: string;
  status: string;
  cutoff_reason: string;
  content: { items: { episodeId: string }[] };
};
const digestsOf = async (runId: string, userId: string) =>
  (await must(
    admin
      .from("digests")
      .select("id,kind,status,cutoff_reason,content")
      .eq("scan_run_id", runId)
      .eq("user_id", userId),
  )) as DigestRow[];
const itemsOf = async (userId: string) =>
  (
    (await must(admin.from("digest_items").select("ref_id").eq("user_id", userId))) as {
      ref_id: string;
    }[]
  ).map((r) => r.ref_id);
type DeliveryRow = {
  id: string;
  channel: string;
  status: string;
  skip_reason: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  provider_message_id: string | null;
  idempotency_key: string;
};
const deliveriesOf = async (userId: string) =>
  (await must(
    admin
      .from("digest_deliveries")
      .select(
        "id,channel,status,skip_reason,attempts,last_error,next_attempt_at,provider_message_id,idempotency_key",
      )
      .eq("user_id", userId),
  )) as DeliveryRow[];
const dispatch = async () => (await callFn("notify-dispatch", { action: "tick" })).json();
async function scenario(name: string, fn: () => Promise<void>) {
  const before = failures.length;
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: threw ${(error as Error).message}`);
  }
  console.log(`${failures.length === before ? "PASS" : "FAIL"}  ${name}`);
}

async function cleanup() {
  // users first: their digests cascade from auth.users, and digests reference scan_runs without cascade
  for (const id of created.users) await admin.auth.admin.deleteUser(id);
  for (const id of created.runs) {
    await admin.from("todays_discounts").delete().eq("scan_run_id", id);
    await admin.from("scan_jobs").delete().eq("scan_run_id", id);
  }
  for (const id of created.secs) await admin.from("signal_episodes").delete().eq("security_id", id);
  for (const id of created.runs) await admin.from("scan_runs").delete().eq("id", id);
  for (const id of created.secs) await admin.from("securities").delete().eq("id", id);
  for (const id of created.companies) await admin.from("companies").delete().eq("id", id);
}

async function leftovers() {
  // an aborted earlier run: its far-future scan runs and users would collide with this one
  const stale = (await must(
    admin
      .from("scan_runs")
      .select("id")
      .gte("scan_date_local", "2030-01-01")
      .lte("scan_date_local", "2030-01-31"),
  )) as { id: string }[];
  for (const r of stale) {
    await admin.from("todays_discounts").delete().eq("scan_run_id", r.id);
    await admin.from("scan_jobs").delete().eq("scan_run_id", r.id);
    await admin.from("signal_episodes").delete().eq("opened_scan_run_id", r.id);
    await admin.from("digests").delete().eq("scan_run_id", r.id);
    await admin.from("scan_runs").delete().eq("id", r.id);
  }
  const page = await admin.auth.admin.listUsers({ perPage: 200 });
  for (const u of page.data.users)
    if (u.email?.endsWith("@integration.test")) await admin.auth.admin.deleteUser(u.id);
}

try {
  const unauthorized = await fetch(`${FUNCTIONS}/notify-dispatch`, { method: "POST" });
  if (unauthorized.status !== 401)
    throw new Error(
      `notify-dispatch answered ${unauthorized.status} without the secret: is the stack up with supabase/functions/.env?`,
    );
  await leftovers();

  // --- scenarios -------------------------------------------------------------------------------------------
  const FULL: RowSpec[] = [
    { category: "green", done: true, rank: 40 },
    { category: "amber", done: true, rank: 2 },
    { category: "pending", done: false },
    { category: "red", done: true },
  ];
  let normalUser = "";

  await scenario(
    "digest exists once per user and kind; every company new on the list, research-independent, researched first; rerun creates nothing",
    async () => {
      normalUser = await makeUser("normal", { push: true });
      await addSub(normalUser, "ok");
      const run = await makeRun("complete", FULL);
      check((await runDigestJob(run.id, "digest")) === "done", "digest job did not finish");
      const digests = await digestsOf(run.id, normalUser);
      check(
        digests.filter((d) => d.kind === "discounts").length === 1,
        "expected exactly one discounts digest",
      );
      check(
        digests.every((d) => d.kind !== "portfolio"),
        "a user without holdings must not get a portfolio digest",
      );
      const first = digests[0];
      check(first?.cutoff_reason === "complete", "cutoff_reason should be complete");
      check(
        JSON.stringify(first?.content.items.map((i) => i.episodeId)) ===
          JSON.stringify([run.episodes[0], run.episodes[1], run.episodes[3], run.episodes[2]]),
        "all four new companies listed: green, amber, other outcome, then not researched (research state does not exclude)",
      );
      const items = await itemsOf(normalUser);
      check(
        items.includes(run.episodes[2] as string) && items.includes(run.episodes[3] as string),
        "pending/red candidates are in digest_items too: the digest no longer depends on research",
      );
      const deliveries = await deliveriesOf(normalUser);
      check(
        deliveries.length === 1 &&
          deliveries.every((d) => d.channel === "push" && d.status === "pending"),
        "one pending push delivery, and no e-mail delivery",
      );
      const counts = [digests.length, items.length, deliveries.length];
      await must(
        admin.from("scan_runs").update({ digests_created_at: null }).eq("id", run.id).select(),
      );
      check(
        (await runDigestJob(run.id, "digest")) === "done",
        "rerun of the digest job did not finish",
      );
      check(
        JSON.stringify([
          (await digestsOf(run.id, normalUser)).length,
          (await itemsOf(normalUser)).length,
          (await deliveriesOf(normalUser)).length,
        ]) === JSON.stringify(counts),
        "rerunning the digest stage created new rows",
      );
    },
  );

  await scenario("dispatch sends push (Topic, TTL) once and records sent", async () => {
    const result = (await dispatch()) as { processed: number; errors: number };
    check(
      result.errors === 0 && result.processed >= 1,
      `dispatch result ${JSON.stringify(result)}`,
    );
    const deliveries = await deliveriesOf(normalUser);
    check(
      deliveries.every((d) => d.status === "sent"),
      `deliveries: ${deliveries.map((d) => d.status).join(",")}`,
    );
    const push = pushSeen.find((s) => s.path.startsWith("/ok/"));
    check(
      push?.headers.topic === "digest-discounts" &&
        push?.headers.ttl === "21600" &&
        push?.headers["content-encoding"] === "aes128gcm",
      "push request headers",
    );
    const before = pushSeen.length;
    await dispatch();
    check(pushSeen.length === before, "a second dispatch pass must not send again");
  });

  await scenario(
    "a 410 from the push service revokes the subscription and it is never contacted again",
    async () => {
      const user = await makeUser("gone", { push: true });
      const endpoint = await addSub(user, "gone");
      const run = await makeRun("complete", FULL);
      await runDigestJob(run.id, "digest");
      await dispatch();
      const sub = (await must(
        admin
          .from("push_subscriptions")
          .select("revoked_at,revoke_reason")
          .eq("endpoint", endpoint)
          .single(),
      )) as {
        revoked_at: string | null;
        revoke_reason: string | null;
      };
      check(
        sub.revoked_at !== null && sub.revoke_reason === "gone",
        "subscription must be revoked with reason gone",
      );
      const hits = () => pushSeen.filter((s) => s.path === new URL(endpoint).pathname).length;
      check(hits() === 1, "exactly one request to the dead endpoint");
      await must(
        admin
          .from("digest_deliveries")
          .update({ status: "pending", next_attempt_at: new Date().toISOString() })
          .eq("user_id", user)
          .eq("channel", "push")
          .select(),
      );
      await dispatch();
      check(hits() === 1, "the revoked endpoint must not be contacted again");
      const ended = (await deliveriesOf(user)).find((d) => d.channel === "push");
      check(
        ended?.skip_reason === "no_subscription",
        `delivery should end skipped/no_subscription: ${JSON.stringify(ended)}`,
      );
    },
  );

  await scenario(
    "a 429 from the push service keeps the delivery pending with a retry time and spends no second request",
    async () => {
      const user = await makeUser("limited", { push: true });
      const endpoint = await addSub(user, "limited");
      const run = await makeRun("complete", FULL);
      await runDigestJob(run.id, "digest");
      await dispatch();
      const delivery = (await deliveriesOf(user)).find((d) => d.channel === "push");
      check(
        delivery?.status === "pending" && delivery.last_error === "push_rate_limited",
        `delivery was ${JSON.stringify(delivery)}`,
      );
      check(
        Date.parse(delivery?.next_attempt_at ?? "") > Date.now() + 100_000,
        "the retry must honour Retry-After (120 s)",
      );
      const hits = pushSeen.filter((s) => s.path === new URL(endpoint).pathname).length;
      await dispatch();
      check(
        pushSeen.filter((s) => s.path === new URL(endpoint).pathname).length === hits,
        "no second request before the retry time",
      );
    },
  );

  await scenario(
    "the 13:00 Sofia cut-off builds the digest from every new company, researched or not, and no second digest follows",
    async () => {
      const user = await makeUser("cutoff", { push: true });
      await addSub(user, "ok");
      const run = await makeRun("running", [
        { category: "green", done: true, rank: 5 },
        { category: "amber", done: false, rank: 6 },
        { category: "pending", done: false },
        { category: "red", done: true },
      ]);
      const winter13 = new Date(`${run.date}T11:00:00Z`).toISOString(); // 2030-01 is winter time: 13:00 Sofia is 11:00Z
      const seeded = await must(admin.rpc("notify_cutoff_digests", { p_now: winter13 }));
      check(Number(seeded) >= 1, "cut-off must seed the digest:cutoff job");
      // app.cutoff_digests flips a running scan to partial; refresh_scan_status later re-derives the status from digest_cutoff_at
      // (set by app.start_daily_scan, absent on this synthetic run), so the flip is asserted right here
      const flipped = (await must(
        admin.from("scan_runs").select("status").eq("id", run.id).single(),
      )) as { status: string };
      check(
        flipped.status === "partial",
        `the cut-off makes a running scan partial (was ${flipped.status})`,
      );
      const wrongHour = await must(
        admin.rpc("notify_cutoff_digests", { p_now: `${run.date}T10:00:00Z` }),
      );
      check(Number(wrongHour) === 0, "10:00Z is 12:00 Sofia in winter: the guard must return 0");
      check((await runDigestJob(run.id, "digest:cutoff")) === "done", "cut-off job did not finish");
      const digests = await digestsOf(run.id, user);
      check(
        digests.length === 1 && digests[0]?.cutoff_reason === "cutoff",
        "one digest with cutoff_reason cutoff",
      );
      check(
        JSON.stringify(digests[0]?.content.items.map((i) => i.episodeId)) ===
          JSON.stringify([run.episodes[0], run.episodes[3], run.episodes[1], run.episodes[2]]),
        "every new company is listed: green, other outcome, then not researched by rank",
      );
      const state = (await must(
        admin.from("scan_runs").select("digests_created_at").eq("id", run.id).single(),
      )) as {
        digests_created_at: string | null;
      };
      check(
        state.digests_created_at !== null,
        "digests_created_at is set after the cut-off digest",
      );
      await must(
        admin
          .from("todays_discounts")
          .update({
            research_completed_at: new Date().toISOString(),
            report_id: crypto.randomUUID(),
          })
          .eq("scan_run_id", run.id)
          .select(),
      );
      await runDigestJob(run.id, "digest");
      check(
        (await digestsOf(run.id, user)).length === 1,
        "research finishing after the cut-off must not create a second digest",
      );
    },
  );
} catch (error) {
  failures.push(`suite aborted: ${(error as Error).message}`);
} finally {
  await cleanup().catch((e) => console.error(`cleanup failed: ${(e as Error).message}`));
  pushServer.close();
}
if (failures.length > 0) {
  console.error(`\nnotifications integration FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nnotifications integration: all scenarios passed");
process.exit(0);
