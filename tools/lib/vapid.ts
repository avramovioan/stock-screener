import type { webcrypto } from "node:crypto";

export interface VapidKeys {
  publicKey: string;
  privateKeyJwk: webcrypto.JsonWebKey;
  envLines(subject: string): string;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function generateVapid(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return {
    publicKey,
    privateKeyJwk,
    envLines: (subject) =>
      [
        `VAPID_PUBLIC_KEY=${publicKey}`,
        `VAPID_PRIVATE_KEY=${JSON.stringify(privateKeyJwk)}`,
        `VAPID_SUBJECT=${subject}`,
        `VITE_VAPID_PUBLIC_KEY=${publicKey}`,
      ].join("\n"),
  };
}

/** `gen-vapid` arguments: the subject is the first positional argument (the value after `--out` is not positional). */
export function parseGenVapidArgs(args: string[]): {
  subject: string;
  outPath: string | undefined;
} {
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const subject =
    args.find((a, i) => !a.startsWith("--") && (outIndex < 0 || i !== outIndex + 1)) ?? "";
  return { subject, outPath };
}
