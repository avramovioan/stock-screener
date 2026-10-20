import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "./MarkdownBody";

describe("MarkdownBody sanitiser", () => {
  it("renders markdown", () => {
    const { container } = render(<MarkdownBody markdown={"## Title\n\nSome **bold** text"} />);
    expect(container.querySelector("h2")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });
  it("never produces a script element, an inline handler or a javascript: link", () => {
    const md =
      'Hi <script>alert(1)</script> <img src=x onerror="alert(2)">\n\n[click](javascript:alert(3))\n\n<a href="javascript:alert(4)" onclick="x()">raw</a>';
    const { container } = render(<MarkdownBody markdown={md} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror|onclick/i);
    for (const a of container.querySelectorAll("a"))
      expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });
  it("opens http links safely", () => {
    const { container } = render(
      <MarkdownBody
        markdown="[SEC](https://www.sec.gov/x)"
        allowedUrls={["https://www.sec.gov/x"]}
      />,
    );
    const a = container.querySelector("a");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.getAttribute("target")).toBe("_blank");
  });
});
