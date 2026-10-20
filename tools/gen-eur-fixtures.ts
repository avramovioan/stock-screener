// Writes supabase/functions/_shared/adapters/fixtures/integration/eur-fixtures.json for the fixture-mode integration scan.
// Usage: bun run tools/gen-eur-fixtures.ts      (needs fixtures/integration/world.json from tools/gen-integration-fixtures.ts)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEurFixtures, type WorldSlice } from "./lib/eur-fixtures.ts";

const dir = join(
  import.meta.dirname,
  "..",
  "supabase",
  "functions",
  "_shared",
  "adapters",
  "fixtures",
);
const read = <T>(file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;

const world = read<WorldSlice>("integration/world.json");
const ibis = read<{ products: unknown[] }>("ibkr-catalogue-ibis-page1.json");
const aeb = read<{ products: unknown[] }>("ibkr-catalogue-aeb-page1.json");
const out = buildEurFixtures({ world, ibisProducts: ibis.products, aebProducts: aeb.products });
writeFileSync(join(dir, "integration", "eur-fixtures.json"), `${JSON.stringify(out, null, 2)}\n`);

const price = (out.quotes["MSF.DE"] as { regularMarketPrice: number }).regularMarketPrice;
console.log(
  `wrote eur-fixtures.json: MSF.DE ${price} EUR, ${Object.keys(out.isins).length} ISINs, pages IBIS ${out.catalogue["IBIS"]?.[0]?.length} / AEB ${out.catalogue["AEB"]?.[0]?.length}`,
);
