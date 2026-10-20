import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "./MarkdownBody";

const LEDGER = "https://www.sec.gov/Archives/edgar/data/1/a.htm";
const HOSTILE = [
  "<script>window.__pwned = 1</script>",
  '<img src="x" onerror="window.__pwned = 2">',
  "[click](javascript:window.__pwned=3)",
  "![track](https://tracker.example/p.png)",
  "<https://evil.example/phish>",
  `[ok](${LEDGER})`,
  '<iframe src="https://evil.example"></iframe>',
  "[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
].join("\n\n");

describe("MarkdownBody security", () => {
  it("renders no active content and no link when no URL is listed", () => {
    const { container } = render(<MarkdownBody markdown={HOSTILE} />);
    expect(
      container.querySelector("script, img, iframe, style, form, input, object, embed, svg"),
    ).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(0);
    for (const el of Array.from(container.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) expect(attr.name.startsWith("on")).toBe(false);
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("links only ledger URLs, in a new tab with noopener noreferrer", () => {
    const { container } = render(<MarkdownBody markdown={HOSTILE} allowedUrls={[LEDGER]} />);
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([LEDGER]);
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
  });

  it("keeps a hostile publisher name in a sources line inert", () => {
    const { container } = render(
      <MarkdownBody markdown={"1. [Evil](javascript:alert(1)) <b onclick=x>pub</b>"} />,
    );
    expect(container.querySelectorAll("a, b")).toHaveLength(0);
    expect(container.textContent).toContain("Evil");
  });
});
