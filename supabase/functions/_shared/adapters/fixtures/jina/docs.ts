const para = (name: string, tone: string) =>
  `${name} annual report. ${tone} Liquidity and capital resources: the company held cash and equivalents and an undrawn revolving facility at year end. ` +
  `Debt maturities are described in the notes to the financial statements. Management believes liquidity is adequate for the next twelve months. `.repeat(
    3,
  );

/** Document text per fixture company slug (synthetic). */
export const JINA_DOCS: Record<string, string> = {
  grnc: para(
    "Greenfield Corp",
    "Revenue declined four percent because of a one-time customer loss; the balance sheet is strong.",
  ),
  rdco: para(
    "Redline Holdings",
    "The company disclosed substantial doubt about its ability to continue as a going concern after a covenant breach.",
  ),
  hold: para("The company", "Operations were stable in the period."),
};
