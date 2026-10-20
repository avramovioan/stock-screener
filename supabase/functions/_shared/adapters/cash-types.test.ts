import { assertEquals } from "@std/assert";
import { categorizeCashType } from "./cash-types.ts";

Deno.test("Flex Cash Transactions types map to the six categories (vocabulary is UNVERIFIED, unknown values become other)", () => {
  const table: Array<[string, string]> = [
    ["Dividends", "dividend"],
    ["Payment In Lieu Of Dividends", "dividend"],
    ["Withholding Tax", "withholding_tax"],
    ["withholding tax", "withholding_tax"],
    ["Broker Interest Paid", "interest"],
    ["Broker Interest Received", "interest"],
    ["Bond Interest Received", "interest"],
    ["Deposits/Withdrawals", "deposit_withdrawal"],
    ["Other Fees", "fee"],
    ["Commission Adjustments", "fee"],
    ["Something New", "other"],
    ["", "other"],
  ];
  for (const [raw, category] of table) assertEquals(categorizeCashType(raw), category, raw);
});
