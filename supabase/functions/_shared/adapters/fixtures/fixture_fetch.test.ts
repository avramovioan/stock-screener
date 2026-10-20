import { assert, assertEquals, assertRejects } from "@std/assert";
import { createFixtureFetch } from "./fixture_fetch.ts";

const post = (url: string, body: unknown) => ({
  url,
  init: { method: "POST", body: JSON.stringify(body) },
});

Deno.test("fixture fetch answers Tavily, EDGAR, Jina and direct pages and nothing else", async () => {
  const f = createFixtureFetch();
  const t = post("https://api.tavily.com/search", {
    query: "Greenfield Corp GRNC annual report 2025 investor relations",
  });
  const tavily = await (await f(t.url, t.init)).json();
  assert(tavily.results.length >= 2);
  const subs = await (await f("https://data.sec.gov/submissions/CIK0000111111.json")).json();
  assertEquals(subs.filings.recent.form.includes("10-K"), true);
  const jina = await (
    await f(
      "https://r.jina.ai/https://www.sec.gov/Archives/edgar/data/111111/000011111126000001/grnc-10k.htm",
    )
  ).text();
  assert(jina.length > 300);
  const page = await f(tavily.results[0].url);
  assertEquals(page.headers.get("content-type")?.startsWith("text/html"), true);
  await assertRejects(() => f("https://example.org/not-a-fixture"), Error, "no fixture");
});

Deno.test("fixture Gemini builds Stage 2 output from the ledger in the prompt and picks the verdict by ticker", async () => {
  const f = createFixtureFetch();
  const call = async (ticker: string) => {
    const user = `**TICKER:** ${ticker}\nEVIDENCE:\n[E1] kind=edgar_filing title="x" date=d retrieved=r\n     facts: - (management_claim) c  | quote: "q"\n[E2] kind=edgar_filing title="y" date=d retrieved=r\n     facts: - (management_claim) c  | quote: "q"`;
    const res = await f(
      "https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent",
      {
        method: "POST",
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: "You are the writing stage of a research pipeline." }],
          },
          contents: [{ role: "user", parts: [{ text: user }] }],
        }),
      },
    );
    return JSON.parse((await res.json()).candidates[0].content.parts[0].text);
  };
  const green = await call("GRNC");
  assertEquals(
    [green.conclusion, green.bankruptcy_risk, green.cited_evidence_ids],
    ["Meets these two fundamental checks.", "Low", [1, 2]],
  );
  const red = await call("RDCO");
  assertEquals(
    [red.conclusion, red.bankruptcy_risk],
    ["Does not meet one or both checks.", "High"],
  );
});
