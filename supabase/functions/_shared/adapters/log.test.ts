import { assertEquals } from "@std/assert";
import {
  logError,
  logLine,
  REDACTED,
  redact,
  redactString,
  type ScanEventRow,
  scanEvent,
} from "./log.ts";

Deno.test("redact replaces values of keys matching token|secret|key|email|authorization (case-insensitive, any depth)", () => {
  const input = {
    ok: 1,
    apiKey: "abc",
    Authorization: "Bearer xyz",
    nested: {
      userEmail: "a@b.c",
      cron_secret: "s",
      fine: "value",
      list: [{ accessToken: "t" }, { name: "n" }],
    },
    SUPABASE_SERVICE_ROLE_KEY: "k",
    tokenCount: 3,
  };
  assertEquals(redact(input), {
    ok: 1,
    apiKey: REDACTED,
    Authorization: REDACTED,
    nested: {
      userEmail: REDACTED,
      cron_secret: REDACTED,
      fine: "value",
      list: [{ accessToken: REDACTED }, { name: "n" }],
    },
    SUPABASE_SERVICE_ROLE_KEY: REDACTED,
    tokenCount: REDACTED, // the key pattern is deliberately broad: a false positive is harmless, a leak is not
  });
});

Deno.test("redact does not mutate its input", () => {
  const input = { secretThing: "s", inner: { key: "k" } };
  redact(input);
  assertEquals(input, { secretThing: "s", inner: { key: "k" } });
});

Deno.test("redact masks credentials inside URL-like strings and truncates very long strings", () => {
  assertEquals(
    redactString("https://query1.finance.yahoo.com/v1/finance/screener?crumb=AbC123&lang=en-US"),
    "https://query1.finance.yahoo.com/v1/finance/screener?crumb=[redacted]&lang=en-US",
  );
  assertEquals(redactString("word ".repeat(1000)).length, 2000 + "...[truncated]".length);
});

Deno.test("redact survives cycles and dates", () => {
  const a: Record<string, unknown> = { name: "a" };
  a["self"] = a;
  const out = redact({ a, at: new Date(Date.UTC(2026, 9, 15)) }) as {
    a: { name: string };
    at: string;
  };
  assertEquals(out.a.name, "a");
  assertEquals(out.at, "2026-10-15T00:00:00.000Z");
});

Deno.test("scanEvent records a redacted row with run, job and stage context", async () => {
  const rows: ScanEventRow[] = [];
  await scanEvent(
    {
      recordEvent: (e) => {
        rows.push(e);
        return Promise.resolve();
      },
    },
    { runId: "run-1", jobId: 42, stage: "fetch_bars" },
    "security_failed",
    { symbol: "SAP.DE", reason: "no_bars", apiKey: "SECRET", url: "https://x.test/?token=SECRET" },
    { level: "warn", securityId: "sec-1", message: "failed at https://x.test/?crumb=SECRET" },
  );
  assertEquals(rows.length, 1);
  const row = rows[0]!;
  assertEquals(
    [row.runId, row.jobId, row.stage, row.level, row.event, row.securityId],
    ["run-1", 42, "fetch_bars", "warn", "security_failed", "sec-1"],
  );
  assertEquals(row.data, {
    symbol: "SAP.DE",
    reason: "no_bars",
    apiKey: REDACTED,
    url: "https://x.test/?token=[redacted]",
  });
  assertEquals(row.message, "failed at https://x.test/?crumb=[redacted]");
  assertEquals(JSON.stringify(row).includes("SECRET"), false);
});

Deno.test("scanEvent defaults: level info, null context and null data", async () => {
  const rows: ScanEventRow[] = [];
  await scanEvent(
    {
      recordEvent: (e) => {
        rows.push(e);
        return Promise.resolve();
      },
    },
    { runId: null },
    "scan_started",
  );
  assertEquals(rows[0], {
    runId: null,
    jobId: null,
    stage: null,
    level: "info",
    event: "scan_started",
    securityId: null,
    message: null,
    data: null,
  });
});

Deno.test("redact masks cookie and crumb keys, Bearer tokens and URL userinfo", () => {
  assertEquals(redact({ cookie: "A3=x", Crumb: "abc", fine: 1 }), {
    cookie: REDACTED,
    Crumb: REDACTED,
    fine: 1,
  });
  assertEquals(redactString("auth Bearer abc.def-123 failed"), `auth Bearer ${REDACTED} failed`);
  assertEquals(
    redactString("connect postgres://user:pw@db.example.com:5432/x and https://a@b.test/"),
    `connect postgres://${REDACTED}@db.example.com:5432/x and https://${REDACTED}@b.test/`,
  );
});

Deno.test("redact covers the spec 15.6 key list and masks e-mail and long base64 values", () => {
  const out = redact({
    password: "hunter2",
    pushEndpoint: "https://fcm.googleapis.com/fcm/send/abc",
    subscription: { p256dh: "BNc", auth: "xyz" },
    note: "contact jane.doe@example.com about it",
    blob: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm",
    sha: "a".repeat(64),
    jobId: 12,
    status: "done",
  }) as Record<string, unknown>;
  const { password, pushEndpoint, subscription, note, blob, sha, jobId, status } = out;
  assertEquals(password, REDACTED);
  assertEquals(pushEndpoint, REDACTED);
  assertEquals(subscription, { p256dh: REDACTED, auth: REDACTED });
  assertEquals(note, "contact [redacted-email] about it");
  assertEquals(blob, "[redacted-blob]");
  assertEquals(sha, "a".repeat(64)); // a hex digest is an id, not a secret
  assertEquals([jobId, status], [12, "done"]);
});

Deno.test("logLine and logError redact what they print", () => {
  const out: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    logLine("e", { token: "t-123", user: "jane@example.com", ok: 1 });
    logError("failed", new Error("GET https://x.example/a?crumb=ABC123&b=1 Bearer abc.def"));
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assertEquals(out[0], '{"event":"e","token":"[redacted]","user":"[redacted-email]","ok":1}');
  assertEquals(out[1], "failed GET https://x.example/a?crumb=[redacted]&b=1 Bearer [redacted]");
});
