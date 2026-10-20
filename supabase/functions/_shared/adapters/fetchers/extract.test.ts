import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { canonicalUrl, capText, estimateTokens, htmlToText } from "./extract.ts";

Deno.test("htmlToText strips scripts, styles and tags, decodes entities, collapses whitespace", () => {
  const html = `<html><head><title>T</title><style>p{color:red}</style></head><body>
    <script>alert('x')</script><h1>Annual   Report</h1><p>Revenue &amp; profit rose&nbsp;5&#37;.</p>
    <!-- hidden --><ul><li>One</li><li>Two</li></ul><noscript>nojs</noscript></body></html>`;
  const text = htmlToText(html);
  assertFalse(text.includes("alert"));
  assertFalse(text.includes("color:red"));
  assertFalse(text.includes("hidden"));
  assertFalse(text.includes("nojs"));
  assert(text.includes("Annual Report"));
  assert(text.includes("Revenue & profit rose 5%."));
  assert(!/ {2,}/.test(text), "no double spaces");
  assert(!/\n{3,}/.test(text), "no triple newlines");
});

Deno.test("capText caps at the limit and never ends on half a surrogate pair", () => {
  assertEquals(capText("abc", 10), "abc");
  assertEquals(capText("abcdef", 3), "abc");
  const emoji = "a\u{1F600}b";
  assertEquals(capText(emoji, 2), "a");
  assertEquals(capText("x".repeat(60000)).length, 48000);
});

Deno.test("estimateTokens is chars / 4 rounded up", () => {
  assertEquals(estimateTokens(""), 0);
  assertEquals(estimateTokens("abcd"), 1);
  assertEquals(estimateTokens("abcde"), 2);
});

Deno.test("canonicalUrl lower-cases the host, strips fragment and tracking, sorts the rest", () => {
  assertEquals(
    canonicalUrl(
      "HTTPS://Investors.Example.COM/Reports/Q3?utm_source=x&b=2&a=1&fbclid=z&gclid=y#section",
    ),
    "https://investors.example.com/Reports/Q3?a=1&b=2",
  );
  assertEquals(canonicalUrl("https://example.com"), "https://example.com/");
  assertEquals(canonicalUrl(" https://example.com/x?UTM_Medium=m "), "https://example.com/x");
  assertEquals(canonicalUrl("not a url"), "not a url");
  assertEquals(
    canonicalUrl("https://a.com/x?utm_campaign=1"),
    canonicalUrl("https://A.com/x#frag"),
  );
});
