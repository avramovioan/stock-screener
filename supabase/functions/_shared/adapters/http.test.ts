import { assertEquals } from "@std/assert";
import { allowedOriginsFromEnv, corsHeaders, json, readJson, requireCronSecret } from "./http.ts";

Deno.test("json sets content type, no-store and status", async () => {
  const response = json({ ok: true }, { status: 201 });
  assertEquals(response.status, 201);
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(await response.json(), { ok: true });
});

Deno.test("json keeps caller supplied headers", () => {
  const response = json(
    {},
    {
      headers: { "cache-control": "max-age=60", "x-extra": "1" },
    },
  );
  assertEquals(response.headers.get("cache-control"), "max-age=60");
  assertEquals(response.headers.get("x-extra"), "1");
});

Deno.test("corsHeaders allows only listed origins", () => {
  const allowed = ["https://screener.example.com"];
  assertEquals(
    corsHeaders("https://screener.example.com", allowed)["access-control-allow-origin"],
    "https://screener.example.com",
  );
  assertEquals(
    corsHeaders("https://evil.example", allowed)["access-control-allow-origin"],
    undefined,
  );
  assertEquals(corsHeaders(null, allowed)["access-control-allow-origin"], undefined);
  assertEquals(corsHeaders("https://evil.example", allowed).vary, "Origin");
});

const cronRequest = (secret?: string) =>
  new Request("http://localhost/fn", {
    headers: secret === undefined ? {} : { "x-cron-secret": secret },
  });

Deno.test("requireCronSecret accepts the configured secret", async () => {
  assertEquals(await requireCronSecret(cronRequest("s3cret"), "s3cret"), null);
});

Deno.test("requireCronSecret rejects missing, wrong and different-length secrets", async () => {
  for (const provided of [undefined, "wrong", "s3cret-but-longer", ""]) {
    const response = await requireCronSecret(cronRequest(provided), "s3cret");
    assertEquals(response?.status, 401);
    await response?.body?.cancel();
  }
});

Deno.test("requireCronSecret fails closed when no secret is configured", async () => {
  const response = await requireCronSecret(cronRequest(""), "");
  assertEquals(response?.status, 500);
  await response?.body?.cancel();
});

const post = (body: string) => new Request("http://localhost/fn", { method: "POST", body });

Deno.test("readJson parses valid JSON", async () => {
  const result = await readJson(post('{"a":1}'));
  assertEquals(result.ok && result.value, { a: 1 });
});

Deno.test("readJson answers 400 for invalid JSON and 413 for oversized bodies", async () => {
  const invalid = await readJson(post("{nope"));
  assertEquals(!invalid.ok && invalid.response.status, 400);
  await (!invalid.ok && invalid.response.body?.cancel());
  const oversized = await readJson(post('{"a":"xxxxxxxxxxxxxxxx"}'), 10);
  assertEquals(!oversized.ok && oversized.response.status, 413);
  await (!oversized.ok && oversized.response.body?.cancel());
});

Deno.test("requireCronSecret trims the header and the configured secret", async () => {
  const padded = new Request("https://f.example/", {
    headers: { "x-cron-secret": "  s3cret \n" },
  });
  assertEquals(await requireCronSecret(padded, "s3cret\n"), null);
  const missing = await requireCronSecret(new Request("https://f.example/"), "s3cret");
  assertEquals(missing?.status, 401);
  await missing?.body?.cancel();
  const blank = await requireCronSecret(padded, "   ");
  assertEquals(blank?.status, 500);
  await blank?.body?.cancel();
});

Deno.test("readJson refuses an oversized body from content-length and caps a streamed body", async () => {
  const declared = new Request("https://f.example/", {
    method: "POST",
    headers: { "content-length": "2000000" },
    body: "{}",
  });
  const refused = await readJson(declared);
  assertEquals(refused.ok, false);
  await (!refused.ok && refused.response.body?.cancel());
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(600));
      controller.enqueue(new Uint8Array(600));
      controller.close();
    },
  });
  const streamed = new Request("https://f.example/", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  const result = await readJson(streamed, 1000);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 413);
    await result.response.body?.cancel();
  }
});

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const names = Object.keys(values);
  const saved = names.map((name) => Deno.env.get(name));
  try {
    for (const name of names) {
      const value = values[name];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    run();
  } finally {
    names.forEach((name, index) => {
      const value = saved[index];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    });
  }
}

Deno.test("allowedOriginsFromEnv returns the SITE_URL origin alone without extras", () => {
  withEnv(
    {
      SITE_URL: "https://screener.example.com/app",
      EXTRA_ALLOWED_ORIGINS: undefined,
    },
    () => {
      assertEquals(allowedOriginsFromEnv(), ["https://screener.example.com"]);
    },
  );
});

Deno.test("allowedOriginsFromEnv appends trimmed extras, skips invalid and duplicates", () => {
  withEnv(
    {
      SITE_URL: "https://screener.example.com",
      EXTRA_ALLOWED_ORIGINS:
        " http://localhost:5173/some/path , ,not a url,https://screener.example.com/x,http://localhost:5173",
    },
    () => {
      assertEquals(allowedOriginsFromEnv(), [
        "https://screener.example.com",
        "http://localhost:5173",
      ]);
    },
  );
});

Deno.test("allowedOriginsFromEnv keeps extras when SITE_URL is missing or invalid", () => {
  withEnv(
    {
      SITE_URL: undefined,
      EXTRA_ALLOWED_ORIGINS: "http://localhost:5173",
    },
    () => {
      assertEquals(allowedOriginsFromEnv(), ["http://localhost:5173"]);
    },
  );
  withEnv({ SITE_URL: "nope", EXTRA_ALLOWED_ORIGINS: undefined }, () => {
    assertEquals(allowedOriginsFromEnv(), []);
  });
});
