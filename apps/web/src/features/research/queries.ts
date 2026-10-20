import type { SupabaseClient } from "@supabase/supabase-js";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { ClaimGroup, ReportData } from "./types";

// The research tables are not in the generated types yet: use an untyped handle.
const db = supabase as unknown as SupabaseClient;

interface ReportRow {
  id: string;
  report_md: string | null;
  claims: ClaimGroup[] | null;
  missing_documents: string[] | null;
  limitations: string[] | null;
  conclusion: string | null;
  bankruptcy_risk: string | null;
  material_damage_established: boolean | null;
  sufficient_evidence: boolean | null;
  research_cutoff_date: string | null;
  completed_at: string | null;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  schema_version: string | null;
  companies: { name: string } | null;
  securities: { yahoo_symbol: string } | null;
  research_sources:
    | {
        evidence_id: number;
        url: string;
        title: string | null;
        publisher: string | null;
        filing_date: string | null;
        published_at: string | null;
      }[]
    | null;
}

export function useReport(id: string) {
  return useQuery({
    queryKey: ["report", id],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<ReportData | null> => {
      const { data, error } = await db
        .from("research_reports")
        .select(
          "id, report_md, claims, missing_documents, limitations, conclusion, bankruptcy_risk, material_damage_established, sufficient_evidence, research_cutoff_date, completed_at, provider, model, prompt_version, schema_version, companies(name), securities(yahoo_symbol), research_sources(evidence_id, url, title, publisher, filing_date, published_at)",
        )
        .eq("id", id)
        .eq("status", "complete")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const r = data as unknown as ReportRow;
      return {
        id: r.id,
        companyName: r.companies?.name ?? "",
        ticker: r.securities?.yahoo_symbol ?? "",
        researchDate: String(r.completed_at ?? "").slice(0, 10),
        cutoffDate: r.research_cutoff_date ?? null,
        provider: r.provider,
        model: r.model,
        promptVersion: r.prompt_version,
        schemaVersion: r.schema_version,
        conclusion: r.conclusion,
        bankruptcyRisk: r.bankruptcy_risk,
        materialDamageEstablished: r.material_damage_established,
        sufficientEvidence: r.sufficient_evidence,
        reportMd: r.report_md ?? "",
        claims: r.claims ?? [],
        missingDocuments: r.missing_documents ?? [],
        limitations: r.limitations ?? [],
        sourceUrls: (r.research_sources ?? []).map((s) => s.url),
        sources: [...(r.research_sources ?? [])]
          .sort((a, b) => a.evidence_id - b.evidence_id)
          .map((s) => ({
            evidenceId: s.evidence_id,
            title: s.title,
            publisher: s.publisher,
            date: (s.filing_date ?? s.published_at)?.slice(0, 10) ?? null,
            url: s.url,
          })),
      };
    },
  });
}
