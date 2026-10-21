/**
 * Server-only configuration names (spec 3.11 and 15.4). One list for the bundle scan and for `check:secrets`.
 * A prefix entry (FLEX_ENC, VAPID_PRIVATE) covers versioned names such as FLEX_ENC_KEY_V2.
 */
export const SERVER_SECRET_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_ACCESS_TOKEN",
  "CRON_SHARED_SECRET",
  "WORKER_TICK_SECRET",
  "FLEX_ENC",
  "VAPID_PRIVATE",
  "RATE_LIMIT_SALT",
  "GEMINI_API_KEY",
  "TAVILY_API_KEY",
  "JINA_API_KEY",
  "LLM_ALT_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "KEEPALIVE_PASSWORD",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
] as const;

/** Names the platform injects or that are public by design: never reported as secrets. */
export const PUBLIC_OR_PLATFORM_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_DB_URL",
  "SITE_URL",
  "EXTRA_ALLOWED_ORIGINS",
  "VAPID_PUBLIC_KEY",
  "VAPID_SUBJECT",
] as const;

/** Read only by tests, tools and the local stack. Never set in production. */
export const LOCAL_ONLY_NAMES = [
  "ALLOW_FIXTURE_PROVIDERS",
  "FLEX_FIXTURE_MODE",
  "PUSH_ENDPOINT_EXTRA_HOSTS",
  "DB_INTEGRATION",
  "YF_LIVE",
] as const;

export const isServerSecret = (name: string): boolean =>
  SERVER_SECRET_NAMES.some((entry) => name === entry || name.startsWith(entry));
