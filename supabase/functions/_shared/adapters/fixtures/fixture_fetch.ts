import type { FetchLike } from "../llm/types.ts";
import { COMPANY_TICKERS, SUBMISSIONS } from "./edgar/data.ts";
import { changeAnswer, stage1Answer, stage2Answer } from "./gemini/answers.ts";
import { JINA_DOCS } from "./jina/docs.ts";
import { EMPTY_FEED } from "./rss/feed.ts";
import { tavilyResults } from "./tavily/results.ts";

const json = (body: unknown) => Response.json(body);
const slugOf = (s: string) =>
  /111111|grnc|greenfield/i.test(s) ? "grnc" : /222222|rdco|redline/i.test(s) ? "rdco" : "hold";

/**
 * Answers recorded-shape responses for known URLs only (PROVIDER_MODE=fixture, local stack only, spec 7.12).
 * Unknown URLs throw: no silent mock, no real network.
 */
export function createFixtureFetch(): FetchLike {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    try {
      return Promise.resolve(route(url, body));
    } catch (e) {
      return Promise.reject(e);
    }
  };
}

function route(url: string, body: string): Response {
  if (url === "https://api.tavily.com/search")
    return json(tavilyResults(String(JSON.parse(body).query ?? "")));
  if (url.endsWith("company_tickers.json")) return json(COMPANY_TICKERS);
  const cik = /submissions\/CIK(\d{10})\.json/.exec(url)?.[1];
  if (cik && SUBMISSIONS[cik]) return json(SUBMISSIONS[cik]);
  if (url.startsWith("https://r.jina.ai/")) {
    const text = JINA_DOCS[slugOf(url)] ?? "";
    return new Response(text, { headers: { "content-type": "text/plain" } });
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    const parsed = JSON.parse(body) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
    };
    const system = parsed.systemInstruction.parts[0]?.text ?? "";
    const user = parsed.contents[0]?.parts[0]?.text ?? "";
    const answer = system.includes("MATERIAL CHANGE CRITERIA")
      ? changeAnswer()
      : system.includes("You extract facts from ONE document")
        ? stage1Answer(user)
        : stage2Answer(user);
    return json({
      candidates: [
        { content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 300 },
    });
  }
  if (url.endsWith("/feed.xml"))
    return new Response(EMPTY_FEED, { headers: { "content-type": "application/rss+xml" } });
  if (
    /^https:\/\/(investors|news)\.[a-z]+\.(example|example\.com)\//.test(url) ||
    /^https:\/\/www\.sec\.gov\/Archives\//.test(url)
  ) {
    const text = JINA_DOCS[slugOf(url)] ?? "";
    return new Response(`<html><body><p>${text}</p></body></html>`, {
      headers: { "content-type": "text/html" },
    });
  }
  throw new Error(`no fixture for ${url}`);
}
