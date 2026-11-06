import { toApiError } from "@/features/screening/errors";

export type Verdict = "regulated" | "not-offered" | "no-regulated-segment" | "not-in-esma";

export interface Segment {
  mic: string;
  name: string;
}
export interface RegulatedResult {
  isin: string;
  mic: string;
  exchangeName: string;
  verdict: Verdict;
  /** Which ESMA endpoint answered. */
  source: "solr" | "search";
  matchedSegment: Segment | null;
  instrumentName: string | null;
  regulatedSegments: Segment[];
  checkedSegments: string[];
  checkedAt: string;
}
export interface ManualUrls {
  venues: string;
  instruments: string;
}

/** ESMA is serving a captcha (or is down): the check cannot run here, the user can open the registers themselves. */
export class EsmaUnavailableError extends Error {
  readonly manualUrls: ManualUrls;
  constructor(manualUrls: ManualUrls) {
    super("esma-unavailable");
    this.name = "EsmaUnavailableError";
    this.manualUrls = manualUrls;
  }
}

function endpoint(): string {
  const url = import.meta.env.VITE_SUPABASE_URL || "http://127.0.0.1:54321";
  return `${url}/functions/v1/esma-regulated`;
}
/** The edge function needs the signed-in user's JWT next to the public apikey. */
async function headers(): Promise<HeadersInit> {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
  // Loaded on first use: the route tree imports this file, and the client must not start in every test or page load
  const { supabase } = await import("@/lib/supabase");
  const session = (await supabase.auth.getSession()).data.session;
  return {
    apikey: key,
    Authorization: `Bearer ${session?.access_token ?? ""}`,
    "Content-Type": "application/json",
  };
}

/** ESMA can take ~45s when it falls back to the slow endpoint. */
const TIMEOUT_MS = 50_000;

export async function checkRegulated(isin: string, mic: string): Promise<RegulatedResult> {
  let res: Response;
  try {
    res = await fetch(endpoint(), {
      method: "POST",
      headers: await headers(),
      body: JSON.stringify({ isin, mic }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw toApiError({ status: 0, message: e instanceof Error ? e.message : String(e) });
  }
  if (res.ok) return (await res.json()) as RegulatedResult;
  let body: { error?: string; manualUrls?: ManualUrls } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* body was not JSON */
  }
  if (res.status === 502 && body.error === "esma-unavailable" && body.manualUrls) {
    throw new EsmaUnavailableError(body.manualUrls);
  }
  throw toApiError({ status: res.status, message: body.error ?? res.statusText });
}
