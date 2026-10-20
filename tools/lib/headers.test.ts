import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  headerProblems,
  matchHeaders,
  ORIGIN_TOKEN,
  originOf,
  parseCsp,
  parseHeadersFile,
  renderHeaders,
  WS_ORIGIN_TOKEN,
} from "./headers.ts";

const ORIGIN = "https://abcdefghijklmnopqrst.supabase.co";
const WS_ORIGIN = "wss://abcdefghijklmnopqrst.supabase.co";
const committed = readFileSync(
  fileURLToPath(new URL("../../apps/web/public/_headers", import.meta.url)),
  "utf8",
);

const csp = (connect: string) =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ${connect}; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;

const PERMISSIONS =
  "accelerometer=(), autoplay=(), bluetooth=(), camera=(), clipboard-write=(self), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=()";

function file(over: Record<string, string | null> = {}): string {
  const base: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS,
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": csp(`'self' ${ORIGIN} ${WS_ORIGIN}`),
  };
  const lines = ["/*"];
  for (const [name, value] of Object.entries({ ...base, ...over })) {
    if (value !== null) lines.push(`  ${name}: ${value}`);
  }
  lines.push(
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/sw.js",
    "  Cache-Control: no-cache",
    "/index.html",
    "  Cache-Control: no-cache",
  );
  return lines.join("\n");
}

const rendered = { mode: "rendered", expectedOrigin: ORIGIN } as const;
const problems = (text: string, mode: Parameters<typeof headerProblems>[1] = rendered) =>
  headerProblems(parseHeadersFile(text), mode);

describe("parseHeadersFile and parseCsp", () => {
  it("groups headers per path rule, lower-cases names and joins repeats", () => {
    const rules = parseHeadersFile("# c\n/*\n  A: 1\n  a: 2\n/x\n  B: 3\n");
    expect(rules.get("/*")?.get("a")).toBe("1, 2");
    expect(rules.get("/x")?.get("b")).toBe("3");
  });
  it("splits a policy into directives", () => {
    expect(
      parseCsp("default-src 'self'; connect-src 'self' https://a.b").get("connect-src"),
    ).toEqual(["'self'", "https://a.b"]);
  });
});

describe("headerProblems (rendered)", () => {
  it("accepts the reference configuration", () => {
    expect(problems(file())).toEqual([]);
  });
  it("rejects a report-only policy and a missing enforced policy", () => {
    expect(
      problems(
        file({
          "Content-Security-Policy": null,
          "Content-Security-Policy-Report-Only": csp(`'self' ${ORIGIN} ${WS_ORIGIN}`),
        }),
      ).join("\n"),
    ).toMatch(/Content-Security-Policy is missing|report-only/i);
  });
  it.each([
    ["wildcard connect-src", csp("'self' https://*.supabase.co")],
    ["star connect-src", csp("'self' *")],
    ["scheme-only connect-src", csp("'self' https:")],
    ["extra connect-src origin", csp(`'self' ${ORIGIN} https://evil.example`)],
    ["other project origin", csp(`'self' https://zzzzzzzzzzzzzzzzzzzz.supabase.co ${WS_ORIGIN}`)],
    ["no websocket origin", csp(`'self' ${ORIGIN}`)],
    ["websocket of another host", csp(`'self' ${ORIGIN} wss://zzzzzzzzzzzzzzzzzzzz.supabase.co`)],
    ["plain ws origin", csp(`'self' ${ORIGIN} ws://abcdefghijklmnopqrst.supabase.co`)],
    ["wss with a path", csp(`'self' ${ORIGIN} ${WS_ORIGIN}/realtime`)],
    [
      "unsafe-inline script",
      csp(`'self' ${ORIGIN} ${WS_ORIGIN}`).replace(
        "script-src 'self'",
        "script-src 'self' 'unsafe-inline'",
      ),
    ],
    [
      "unsafe-eval script",
      csp(`'self' ${ORIGIN} ${WS_ORIGIN}`).replace(
        "script-src 'self'",
        "script-src 'self' 'unsafe-eval'",
      ),
    ],
    [
      "framing allowed",
      csp(`'self' ${ORIGIN} ${WS_ORIGIN}`).replace(
        "frame-ancestors 'none'",
        "frame-ancestors 'self'",
      ),
    ],
    ["no object-src", csp(`'self' ${ORIGIN} ${WS_ORIGIN}`).replace("object-src 'none'; ", "")],
    [
      "remote images",
      csp(`'self' ${ORIGIN} ${WS_ORIGIN}`).replace(
        "img-src 'self' data:",
        "img-src 'self' data: https:",
      ),
    ],
  ])("rejects %s", (_name, value) => {
    expect(problems(file({ "Content-Security-Policy": value })).length).toBeGreaterThan(0);
  });
  it("rejects an unrendered template token and accepts it in template mode", () => {
    const template = file({
      "Content-Security-Policy": csp(`'self' ${ORIGIN_TOKEN} ${WS_ORIGIN_TOKEN}`),
    });
    expect(problems(template).join("\n")).toContain(ORIGIN_TOKEN);
    expect(problems(template, { mode: "template" })).toEqual([]);
  });
  it("checks the other headers", () => {
    expect(problems(file({ "X-Frame-Options": "SAMEORIGIN" })).length).toBeGreaterThan(0);
    expect(problems(file({ "X-Content-Type-Options": null })).length).toBeGreaterThan(0);
    expect(problems(file({ "Cross-Origin-Opener-Policy": "unsafe-none" })).length).toBeGreaterThan(
      0,
    );
    expect(problems(file({ "Referrer-Policy": "unsafe-url" })).length).toBeGreaterThan(0);
  });
  it("requires every listed feature denied and nothing else allowed", () => {
    expect(
      problems(file({ "Permissions-Policy": PERMISSIONS.replace("camera=()", "camera=*") })).join(
        "\n",
      ),
    ).toMatch(/camera/);
    expect(
      problems(file({ "Permissions-Policy": PERMISSIONS.replace("camera=(), ", "") })).join("\n"),
    ).toMatch(/camera/);
    expect(
      problems(file({ "Permissions-Policy": `${PERMISSIONS}, fullscreen=(self)` })).join("\n"),
    ).toMatch(/fullscreen/);
  });
  it("accepts Strict-Transport-Security only with a long max-age", () => {
    expect(
      problems(file({ "Strict-Transport-Security": "max-age=31536000; includeSubDomains" })),
    ).toEqual([]);
    expect(problems(file({ "Strict-Transport-Security": "max-age=60" })).length).toBeGreaterThan(0);
  });
  it("requires no-cache for the entry points and immutable assets", () => {
    expect(
      problems(
        file().replace(
          "  Cache-Control: no-cache\n/index.html",
          "  Cache-Control: max-age=60\n/index.html",
        ),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("renderHeaders, originOf and matchHeaders", () => {
  it("reduces a URL to its https origin and refuses other schemes", () => {
    expect(originOf("https://abc.supabase.co/rest/v1/")).toBe("https://abc.supabase.co");
    expect(originOf("http://abc.supabase.co")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });
  it("substitutes every token and flags a placeholder render", () => {
    const out = renderHeaders(`a ${ORIGIN_TOKEN} b ${ORIGIN_TOKEN}`, `${ORIGIN}/`);
    expect(out).toEqual({ text: `a ${ORIGIN} b ${ORIGIN}`, origin: ORIGIN, placeholder: false });
    const ws = renderHeaders(`${ORIGIN_TOKEN} ${WS_ORIGIN_TOKEN}`, `${ORIGIN}/`);
    expect(ws.text).toBe(`${ORIGIN} ${WS_ORIGIN}`);
    expect(renderHeaders(`${ORIGIN_TOKEN} ${WS_ORIGIN_TOKEN}`, undefined).text).toBe(
      "https://unset.invalid wss://unset.invalid",
    );
    const fallback = renderHeaders(ORIGIN_TOKEN, undefined);
    expect(fallback.placeholder).toBe(true);
    expect(fallback.origin).toBe("https://unset.invalid");
    expect(() => renderHeaders("no token", ORIGIN)).toThrow(/token/);
  });
  it("applies every matching rule, in file order", () => {
    const rules = parseHeadersFile(file());
    expect(matchHeaders(rules, "/assets/a.js")["cache-control"]).toContain("immutable");
    expect(matchHeaders(rules, "/assets/a.js")["x-frame-options"]).toBe("DENY");
    expect(matchHeaders(rules, "/sw.js")["cache-control"]).toBe("no-cache");
    expect(matchHeaders(rules, "/about")["cache-control"]).toBeUndefined();
  });
});

describe("the committed apps/web/public/_headers", () => {
  it("passes template mode and renders into a file that passes rendered mode", () => {
    expect(headerProblems(parseHeadersFile(committed), { mode: "template" })).toEqual([]);
    const { text } = renderHeaders(committed, ORIGIN);
    expect(headerProblems(parseHeadersFile(text), rendered)).toEqual([]);
  });
});
