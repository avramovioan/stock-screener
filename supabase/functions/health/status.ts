import type { SupabaseClient } from "@supabase/supabase-js";

export const DB_SIZE_WARN_BYTES = 400 * 1024 * 1024; // alarm at 400 MB of the 500 MB Free limit (16.5)

export interface HealthDetail {
  ok: boolean;
  scan: unknown;
  db: { size_bytes: number | null; size_mb: number | null; warn: boolean };
  /** Set only when a read failed for a known, operator-actionable reason. */
  error?: "app_schema_not_exposed";
}

/** PostgREST answers PGRST106 when `app` is not in the hosted project's exposed schemas. */
function schemaNotExposed(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "PGRST106";
}

/** Pure shaping of the two RPC results; `ok` is false when either could not be read. */
export function shapeHealth(
  status: { data: unknown; error: unknown },
  size: { data: unknown; error: unknown },
): HealthDetail {
  const bytes = typeof size.data === "number" ? size.data : null;
  return {
    ...(schemaNotExposed(size.error) || schemaNotExposed(status.error)
      ? { error: "app_schema_not_exposed" as const }
      : {}),
    ok: status.error === null && size.error === null,
    scan: status.data ?? null,
    db: {
      size_bytes: bytes,
      size_mb: bytes === null ? null : Math.round(bytes / 1024 / 1024),
      warn: bytes !== null && bytes > DB_SIZE_WARN_BYTES,
    },
  };
}

/** public.scan_status() (what the site already shows) plus the database size; never a secret. */
export async function healthDetail(sb: SupabaseClient): Promise<HealthDetail> {
  const [status, size] = await Promise.all([
    sb.rpc("scan_status"),
    sb.schema("app").rpc("database_size"),
  ]);
  return shapeHealth(status, size);
}
