/** Two results per query (an investor-relations page and a news page), keyed on the company named in the query. Synthetic. */
export function tavilyResults(query: string) {
  const slug = /greenfield|grnc/i.test(query)
    ? "grnc"
    : /redline|rdco/i.test(query)
      ? "rdco"
      : "hold";
  const n = Math.abs([...query].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 1000;
  return {
    results: [
      {
        title: `${slug.toUpperCase()} investor presentation ${n}`,
        url: `https://investors.${slug}.example/ir-${n}`,
        content: "Investor relations presentation.",
        published_date: "2026-09-01",
      },
      {
        title: `${slug.toUpperCase()} shares move ${n}`,
        url: `https://news.example.com/${slug}-${n}`,
        content: "Shares moved after the update.",
      },
    ],
  };
}
