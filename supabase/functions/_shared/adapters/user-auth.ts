import { requireEnv } from "./env.ts";
import { json } from "./http.ts";

export interface VerifiedUser {
  userId: string;
}

export interface UserVerifier {
  verify(jwt: string): Promise<VerifiedUser | null>;
}

export type AuthResult = { ok: true; userId: string } | { ok: false; response: Response };

/** `Authorization: Bearer <jwt>`; anything that is not a JWT-shaped token is treated as absent. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function authenticate(
  req: Request,
  verifier: UserVerifier,
  headers?: HeadersInit,
): Promise<AuthResult> {
  const unauthorized = (): AuthResult => ({
    ok: false,
    response: json(
      { error: "unauthorized" },
      { status: 401, ...(headers === undefined ? {} : { headers }) },
    ),
  });
  const token = bearerToken(req);
  if (token === null) return unauthorized();
  const user = await verifier.verify(token).catch(() => null);
  return user === null ? unauthorized() : { ok: true, userId: user.userId };
}

interface ClaimsClient {
  auth: { getClaims(jwt: string): Promise<{ data: { claims: unknown } | null; error: unknown }> };
}

/** Verifies the user JWT with `auth.getClaims()` (the platform JWT check is off for these functions, spec 7.3). */
export function createClaimsVerifier(deps: {
  url: string;
  anonKey: string;
  /** Exact `iss` to require (JWT_ISSUER). Unset: `${url}/auth/v1`. */
  issuer?: string | undefined;
  createClient: (
    url: string,
    key: string,
    options: { auth: { persistSession: false; autoRefreshToken: false } },
  ) => ClaimsClient;
}): UserVerifier {
  const configured = deps.issuer?.trim();
  const issuer =
    configured === undefined || configured === ""
      ? `${deps.url.replace(/[/]+$/, "")}/auth/v1`
      : normalizeIssuer(configured);
  return {
    async verify(jwt) {
      const client = deps.createClient(deps.url, deps.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.auth.getClaims(jwt);
      if (error || data === null) return null;
      const claims = data.claims as { sub?: unknown; role?: unknown; aud?: unknown; iss?: unknown };
      if (typeof claims.sub !== "string" || claims.sub === "" || claims.role !== "authenticated")
        return null;
      if (claims.aud !== "authenticated") return null;
      if (typeof claims.iss !== "string" || normalizeIssuer(claims.iss) !== issuer) return null;
      return { userId: claims.sub };
    },
  };
}

/**
 * Production wiring: the issuer is `${SUPABASE_URL}/auth/v1` unless `JWT_ISSUER` is set (exact match). The local stack needs it:
 * local Auth issues `http://127.0.0.1:54321/auth/v1` while the functions see `SUPABASE_URL=http://kong:8000`.
 */
export function claimsVerifierFromEnv(
  createClient: Parameters<typeof createClaimsVerifier>[0]["createClient"],
): UserVerifier {
  return createClaimsVerifier({
    url: requireEnv("SUPABASE_URL"),
    anonKey: requireEnv("SUPABASE_ANON_KEY"),
    issuer: Deno.env.get("JWT_ISSUER"),
    createClient,
  });
}

const normalizeIssuer = (iss: string): string => iss.replace(/[/]+$/, "");
