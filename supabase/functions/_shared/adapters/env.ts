/** Reads a required environment variable and fails loudly when it is missing or blank. */
export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isLocalStack(supabaseUrl: string): boolean {
  try {
    const host = new URL(supabaseUrl).hostname;
    // `kong` is the API gateway name inside the local edge-runtime container (SUPABASE_URL=http://kong:8000)
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "host.docker.internal" ||
      host === "kong"
    );
  } catch {
    return false;
  }
}

/**
 * Operator-configured base URLs (LLM_ALT_BASE_URL) must be https; plain http is accepted
 * only when SUPABASE_URL is a local stack (fixture and mock servers). Spec 15.2 T12.
 */
export function requireHttpsBase(
  name: string,
  value: string,
  supabaseUrl: string = Deno.env.get("SUPABASE_URL") ?? "",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && isLocalStack(supabaseUrl)) return value;
  throw new Error(`${name} must be an https URL`);
}
