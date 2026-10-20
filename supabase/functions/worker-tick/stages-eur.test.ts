import { assert, assertEquals } from "@std/assert";
import { withEur } from "./handlers/eur_register.ts";
import { HANDLERS, PIPELINE_ORDER, SEEDERS } from "./stages.ts";

Deno.test("withEur registers both EUR stages in the claim list, handlers and seeders without touching the base", () => {
  const merged = withEur({ stages: PIPELINE_ORDER, handlers: HANDLERS, seeders: SEEDERS });
  for (const stage of ["eur_catalogue", "eur_resolve"] as const) {
    assert(merged.stages.includes(stage), `${stage} is claimable`);
    assert(merged.handlers[stage] !== undefined, `${stage} has a handler`);
    assert(merged.seeders[stage] !== undefined, `${stage} has a seeder`);
  }
  assertEquals(merged.stages.filter((s) => s === "eur_catalogue").length, 1);
  assertEquals(withEur(merged).stages, merged.stages, "merging twice does not duplicate");
  assertEquals(PIPELINE_ORDER.includes("eur_catalogue" as never), false);
});
