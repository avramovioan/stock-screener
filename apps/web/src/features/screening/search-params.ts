import { z } from "zod";

/** The one worldwide ranking every feed call reads; US is only a view filter on top of it. */
export const FEED_MODE = "worldwide" as const;

const countrySchema = z.literal("us").optional().catch(undefined);

const overviewSchema = z.object({ country: countrySchema });
const quotesSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9^][A-Za-z0-9.\-=^]*$/)
    .optional()
    .catch(undefined),
  sid: z.uuid().optional().catch(undefined),
});

export interface OverviewSearch {
  /** `?country=us` shows United States companies only; absent means all countries. */
  country?: "us" | undefined;
}
export interface QuotesSearch {
  symbol?: string | undefined;
  sid?: string | undefined;
}

/** TanStack Router `validateSearch` for `/`. Invalid input (and the retired `?mode=`) is dropped, never thrown. */
export function validateOverviewSearch(raw: Record<string, unknown>): OverviewSearch {
  return overviewSchema.parse(raw);
}
/** TanStack Router `validateSearch` for `/quotes`. */
export function validateQuotesSearch(raw: Record<string, unknown>): QuotesSearch {
  return quotesSchema.parse(raw);
}
