import { describe, expect, it } from "vitest";
import { envNamesInSource, inventoryProblems } from "./secret-inventory.ts";

describe("envNamesInSource", () => {
  it("finds Deno.env.get, requireEnv and get() style reads", () => {
    const text = `Deno.env.get("A_ONE"); requireEnv("B_TWO"); const v = get("C_THREE"); headers.get("x-y");`;
    expect(envNamesInSource(text)).toEqual(["A_ONE", "B_TWO", "C_THREE"]);
  });
});

describe("inventoryProblems", () => {
  const ok = {
    codeNames: ["CRON_SHARED_SECRET", "SITE_URL", "FLEX_ENC_KEY_V1"],
    guideText: "`CRON_SHARED_SECRET` `FLEX_ENC_KEY_V1` `SITE_URL`",
    exampleFiles: [
      {
        path: "supabase/functions/.env.example",
        text: "CRON_SHARED_SECRET=local-dev-cron-secret\nFLEX_ENC_KEY_V1=\n",
      },
    ],
  };
  it("accepts a documented, listed configuration", () => {
    expect(inventoryProblems(ok)).toEqual([]);
  });
  it("flags a secret-looking name that the bundle scan would miss", () => {
    const p = inventoryProblems({
      ...ok,
      codeNames: [...ok.codeNames, "NEW_SERVICE_API_KEY"],
      guideText: `${ok.guideText} \`NEW_SERVICE_API_KEY\``,
    });
    expect(p.join("\n")).toMatch(/NEW_SERVICE_API_KEY.*SERVER_SECRET_NAMES/);
  });
  it("flags a name the operator guide does not mention", () => {
    expect(
      inventoryProblems({ ...ok, codeNames: [...ok.codeNames, "MYSTERY_SETTING"] }).join("\n"),
    ).toMatch(/MYSTERY_SETTING.*operator guide/);
  });
  it("flags a real-looking value in an example file and a secret in a VITE_ name", () => {
    const p = inventoryProblems({
      ...ok,
      exampleFiles: [
        {
          path: "x/.env.example",
          text: "GEMINI_API_KEY=re_abcdef123456\nVITE_SERVICE_ROLE_KEY=\n",
        },
      ],
    });
    expect(p.join("\n")).toMatch(/GEMINI_API_KEY/);
    expect(p.join("\n")).toMatch(/VITE_SERVICE_ROLE_KEY/);
  });
});
