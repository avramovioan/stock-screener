import { loadPushEnv, sendPush } from "./push.ts";

// stdin: { "sub": { endpoint, p256dh, auth }, "payload": "<json text>", "topic": "...", "ttlSeconds": 21600 }
// env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. Prints the result; never prints keys.
const job = JSON.parse(await new Response(Deno.stdin.readable).text()) as {
  sub: { endpoint: string; p256dh: string; auth: string };
  payload: string;
  topic: string;
  ttlSeconds: number;
};
const result = await sendPush(
  job.sub,
  job.payload,
  { ttlSeconds: job.ttlSeconds, topic: job.topic, urgency: "normal" },
  { env: loadPushEnv() },
);
console.log(JSON.stringify(result));
