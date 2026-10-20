export type CashCategory =
  | "dividend"
  | "withholding_tax"
  | "interest"
  | "fee"
  | "deposit_withdrawal"
  | "other";

export interface CashTypeRule {
  match: RegExp;
  category: CashCategory;
}

/**
 * Flex does not enumerate the Cash Transactions `Type` values (research flex 2.2, UNVERIFIED), so the raw text is always stored in
 * `type_raw` and mapped here. First matching rule wins; withholding comes before dividend. Edit this list once the owner's real
 * statement (P5-01) shows the exact vocabulary.
 */
export const CASH_TYPE_RULES: readonly CashTypeRule[] = [
  { match: /withholding/i, category: "withholding_tax" },
  { match: /dividend/i, category: "dividend" },
  { match: /interest/i, category: "interest" },
  { match: /deposit|withdrawal/i, category: "deposit_withdrawal" },
  { match: /fee|commission/i, category: "fee" },
];

export function categorizeCashType(typeRaw: string): CashCategory {
  for (const rule of CASH_TYPE_RULES) if (rule.match.test(typeRaw)) return rule.category;
  return "other";
}
