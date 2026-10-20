import { expect, test } from "@playwright/test";
import { ANON, api } from "./support/stack";

async function completeReportId(): Promise<string | null> {
  const ctx = await api(ANON);
  const res = await ctx.get("/rest/v1/research_reports?select=id&status=eq.complete&limit=1");
  const rows = res.ok() ? ((await res.json()) as Array<{ id: string }>) : [];
  await ctx.dispose();
  return rows[0]?.id ?? null;
}

test("a signed-out visitor reads a fixture research report: disclaimer, two separate outputs, sources with safe links", async ({
  page,
}) => {
  const id = await completeReportId();
  expect(
    id,
    "the fixture scan produced a public complete report (bun run e2e:setup)",
  ).not.toBeNull();
  await page.goto(`/research/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("not financial advice");
  await expect(page.getByRole("heading", { name: "Research conclusion" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bankruptcy risk" })).toBeVisible();
  const sources = page.getByTestId("source-item");
  expect(await sources.count()).toBeGreaterThan(0);
  for (const link of await sources.getByRole("link").all()) {
    await expect(link).toHaveAttribute("rel", /noopener/);
  }
});
