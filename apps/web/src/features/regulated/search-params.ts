import { z } from "zod";

const schema = z.object({
  isin: z
    .string()
    .regex(/^[A-Za-z0-9]{1,12}$/)
    .transform((v) => v.toUpperCase())
    .optional()
    .catch(undefined),
  mic: z
    .string()
    .regex(/^[A-Za-z0-9]{4}$/)
    .transform((v) => v.toUpperCase())
    .optional()
    .catch(undefined),
});

export interface RegulatedSearch {
  isin?: string | undefined;
  mic?: string | undefined;
}

/** TanStack Router `validateSearch` for `/regulated`: bad values are dropped, never thrown. */
export function validateRegulatedSearch(raw: Record<string, unknown>): RegulatedSearch {
  return schema.parse(raw);
}
