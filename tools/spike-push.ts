import { spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { generateVapid } from "./lib/vapid.ts";
import { decryptAes128gcm } from "./lib/webpush-decrypt.ts";

// P3-01 (local half): the Deno adapter encrypts and POSTs to a fake push endpoint served by Bun.
// Asserts the RFC 8030/8291/8292 request shape and that the payload decrypts. A real browser
// receive test (Chrome, Firefox, Android, iOS Home Screen) is a manual operator step: see the
// operator guide section 4. Exit code 0 = pass.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const base64Url = (b: Buffer) =>
  b.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const vapid = await generateVapid();
const ua = createECDH("prime256v1");
const uaPublic = ua.generateKeys();
const authSecret = randomBytes(16);

interface Seen {
  headers: Headers;
  body: Buffer;
}
const received: Seen[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    received.push({ headers, body: Buffer.concat(chunks) });
    res.statusCode = 201;
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

const payload = JSON.stringify({
  title: "Spike",
  body: "Hello from the Deno adapter",
  url: "/",
  tag: "digest-discounts",
});
const job = {
  sub: {
    endpoint: `http://127.0.0.1:${port}/push/spike`,
    p256dh: base64Url(uaPublic),
    auth: base64Url(authSecret),
  },
  payload,
  topic: "digest-discounts",
  ttlSeconds: 21600,
};

const output = await new Promise<string>((resolve, reject) => {
  const child = spawn(
    "deno",
    [
      "run",
      "--allow-net",
      "--allow-env",
      "--config",
      "supabase/functions/deno.json",
      "supabase/functions/_shared/adapters/push-cli.ts",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VAPID_PUBLIC_KEY: vapid.publicKey,
        VAPID_PRIVATE_KEY: JSON.stringify(vapid.privateKeyJwk),
        VAPID_SUBJECT: "mailto:spike@example.test",
      },
    },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", reject);
  child.on("close", (code) =>
    code === 0 ? resolve(out) : reject(new Error(`deno exited ${code}: ${err}`)),
  );
  child.stdin.end(JSON.stringify(job));
});
server.close();

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
check(JSON.parse(output.trim()).ok === true, `adapter result was ${output.trim()}`);
const seen = received[0];
check(seen !== undefined, "the fake endpoint received no request");
if (seen) {
  const h = seen.headers;
  const auth = h.get("authorization") ?? "";
  check(
    /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(auth),
    "Authorization is not 'vapid t=<jwt>, k=<key>'",
  );
  check(auth.endsWith(`k=${vapid.publicKey}`), "VAPID k does not equal the application server key");
  check(h.get("content-encoding") === "aes128gcm", "Content-Encoding is not aes128gcm");
  check(h.get("ttl") === "21600", "TTL is not 21600");
  check(h.get("topic") === "digest-discounts", "Topic header missing or wrong");
  check(h.get("urgency") === "normal", "Urgency is not normal");
  check(seen.body.length > 0, "empty body");
  try {
    check(
      decryptAes128gcm(seen.body, ua, authSecret) === payload,
      "decrypted payload differs from the sent payload",
    );
  } catch (error) {
    check(false, `payload did not decrypt: ${(error as Error).message}`);
  }
}
if (failures.length > 0) {
  console.error(`spike:push FAILED\n- ${failures.join("\n- ")}`);
  console.error(
    "If the library fails here, record the failure in the spec open-question table and switch to web-push-neo (spec 10.4).",
  );
  process.exit(1);
}
console.log(
  "spike:push passed: vapid auth, aes128gcm, TTL 21600, Topic, Urgency and payload decryption verified.",
);
