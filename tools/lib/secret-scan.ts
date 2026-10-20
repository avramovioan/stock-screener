import { SERVER_SECRET_NAMES as FORBIDDEN_NAMES } from "./secret-names.ts";

export interface SecretFinding {
  rule: string;
  detail: string;
}

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}\.(eyJ[A-Za-z0-9_-]{4,})\.[A-Za-z0-9_-]{4,}/g;
const SECRET_KEY_PATTERN = /sb_secret_[A-Za-z0-9_-]{8,}/;

function roleOf(payloadSegment: string): string | null {
  try {
    const payload: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    if (typeof payload === "object" && payload !== null && "role" in payload) {
      const role = (payload as { role: unknown }).role;
      return typeof role === "string" ? role : null;
    }
  } catch {
    // not a JWT payload
  }
  return null;
}

export function scanText(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const name of FORBIDDEN_NAMES) {
    // report the whole identifier (FLEX_ENC matches FLEX_ENC_KEY_V1) so the finding names the variable
    const hit = new RegExp(`[A-Za-z0-9_]*${name}[A-Za-z0-9_]*`).exec(text);
    if (hit) findings.push({ rule: "forbidden-name", detail: hit[0] });
  }
  for (const match of text.matchAll(JWT_PATTERN)) {
    if (roleOf(match[1] ?? "") === "service_role") {
      findings.push({ rule: "service-role-jwt", detail: `${match[0].slice(0, 12)}...` });
    }
  }
  if (SECRET_KEY_PATTERN.test(text)) {
    findings.push({ rule: "secret-api-key", detail: "sb_secret_..." });
  }
  return findings;
}
