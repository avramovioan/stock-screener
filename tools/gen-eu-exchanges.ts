// Generates supabase/functions/_shared/core/eu-exchanges.ts from the ISO 10383 MIC list.
// Run: bun run gen:eu-exchanges   (optional first argument: path to a local copy of the CSV)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSV_URL = "https://www.iso20022.org/sites/default/files/ISO10383_MIC/ISO10383_MIC.csv";
const OUT = fileURLToPath(
  new URL("../supabase/functions/_shared/core/eu-exchanges.ts", import.meta.url),
);

const COUNTRIES = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH GB".split(
    " ",
  ),
);

const NAME_OVERRIDES: Record<string, string> = {
  XETR: "Deutsche Börse Xetra",
  XFRA: "Börse Frankfurt",
  XSTU: "Börse Stuttgart",
  XMUN: "Börse München",
  XDUS: "Börse Düsseldorf",
  XHAM: "Börse Hamburg",
  XHAN: "Börse Hannover",
  XBER: "Börse Berlin",
  TGAT: "Tradegate Exchange",
  XAMS: "Euronext Amsterdam",
  XPAR: "Euronext Paris",
  XBRU: "Euronext Brussels",
  XLIS: "Euronext Lisbon",
  XDUB: "Euronext Dublin",
  XOSL: "Euronext Oslo",
  XMIL: "Borsa Italiana (Euronext Milan)",
  BMEX: "BME Bolsa de Madrid",
  XWBO: "Wiener Börse",
  XSWX: "SIX Swiss Exchange",
  XLON: "London Stock Exchange",
  XCSE: "Nasdaq Copenhagen",
  XSTO: "Nasdaq Stockholm",
  XHEL: "Nasdaq Helsinki",
  XWAR: "Warsaw Stock Exchange",
  XPRA: "Prague Stock Exchange",
  XBUD: "Budapest Stock Exchange",
  XLUX: "Luxembourg Stock Exchange",
  ASEX: "Athens Stock Exchange",
};

/** RFC 4180 style parser: quoted fields, doubled quotes, empty unquoted fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const SMALL = new Set(["and", "of", "the", "for", "in", "de", "di", "du", "la", "le", "et"]);
const KEEP_UPPER = new Set([
  "AG",
  "SE",
  "SA",
  "NV",
  "UK",
  "EU",
  "ASA",
  "AB",
  "OY",
  "PLC",
  "MTF",
  "OTC",
  "BME",
  "SIX",
  "LSE",
  "EEX",
  "MTS",
  "ICE",
]);

function titleCase(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w, i) =>
      w
        .split("-")
        .map((p) => {
          const bare = p.replace(/[^A-Za-z]/g, "");
          if (KEEP_UPPER.has(bare)) return p;
          const lower = p.toLowerCase();
          if (i > 0 && SMALL.has(lower)) return lower;
          return lower.replace(
            /(^|[(&/'])([a-zà-ÿ])/g,
            (_m, a: string, b: string) => a + b.toUpperCase(),
          );
        })
        .join("-"),
    )
    .join(" ");
}

interface Row {
  mic: string;
  operating: string;
  kind: string;
  description: string;
  legal: string;
  lei: string;
  category: string;
  country: string;
  status: string;
}

export interface GenExchange {
  mic: string;
  name: string;
  country: string;
  segments: string[];
  leis: string[];
}

export function buildExchanges(csv: string): GenExchange[] {
  const [header, ...body] = parseCsv(csv);
  if (!header) throw new Error("empty CSV");
  const col = (n: string) => {
    const i = header.indexOf(n);
    if (i < 0) throw new Error(`CSV column missing: ${n}`);
    return i;
  };
  const idx = {
    mic: col("MIC"),
    operating: col("OPERATING MIC"),
    kind: col("OPRT/SGMT"),
    description: col("MARKET NAME-INSTITUTION DESCRIPTION"),
    legal: col("LEGAL ENTITY NAME"),
    lei: col("LEI"),
    category: col("MARKET CATEGORY CODE"),
    country: col("ISO COUNTRY CODE (ISO 3166)"),
    status: col("STATUS"),
  };
  const rows: Row[] = body
    .map((r) => ({
      mic: (r[idx.mic] ?? "").trim(),
      operating: (r[idx.operating] ?? "").trim(),
      kind: (r[idx.kind] ?? "").trim(),
      description: (r[idx.description] ?? "").trim(),
      legal: (r[idx.legal] ?? "").trim(),
      lei: (r[idx.lei] ?? "").trim(),
      category: (r[idx.category] ?? "").trim(),
      country: (r[idx.country] ?? "").trim(),
      status: (r[idx.status] ?? "").trim(),
    }))
    .filter((r) => r.status === "ACTIVE" && r.mic !== "");

  const byOperating = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byOperating.get(r.operating) ?? [];
    list.push(r);
    byOperating.set(r.operating, list);
  }

  const out: GenExchange[] = [];
  for (const [opMic, group] of byOperating) {
    const op = group.find((r) => r.mic === opMic && r.kind === "OPRT");
    if (!op || !COUNTRIES.has(op.country)) continue;
    if (!group.some((r) => r.category === "RMKT" || r.category === "MLTF")) continue;
    const others = group
      .filter((r) => r.mic !== opMic)
      .map((r) => r.mic)
      .sort();
    const leis = [...new Set(group.map((r) => r.lei).filter((l) => l !== ""))].sort();
    out.push({
      mic: opMic,
      name: NAME_OVERRIDES[opMic] ?? titleCase(op.description || op.legal),
      country: op.country,
      segments: [opMic, ...others],
      leis,
    });
  }
  out.sort((a, b) => a.country.localeCompare(b.country) || a.mic.localeCompare(b.mic));
  return out;
}

export function render(list: GenExchange[]): string {
  const q = (s: string) => JSON.stringify(s);
  const entries = list
    .map(
      (e) =>
        `  {\n    mic: ${q(e.mic)},\n    name: ${q(e.name)},\n    country: ${q(e.country)},\n    segments: [${e.segments.map(q).join(", ")}],\n    leis: [${e.leis.map(q).join(", ")}],\n  },`,
    )
    .join("\n");
  return `// generated — do not edit; run \`bun run gen:eu-exchanges\`
// Source: ISO 10383 MIC list (EU27 + IS, LI, NO, CH, GB; active venues with a regulated market or MTF segment).

export interface EuExchange {
  /** Operating MIC, e.g. "XETR". */
  mic: string;
  /** Human display name, e.g. "Deutsche Börse Xetra". */
  name: string;
  /** ISO 3166 alpha-2 country code. */
  country: string;
  /** Active segment MICs including the operating MIC itself. */
  segments: readonly string[];
  /** Distinct non-empty LEIs across the operating MIC and its segments. */
  leis: readonly string[];
}

export const EU_EXCHANGES: readonly EuExchange[] = [
${entries}
];

const BY_MIC: ReadonlyMap<string, EuExchange> = new Map(EU_EXCHANGES.map((e) => [e.mic, e]));

/** Case-insensitive lookup by operating MIC; a segment MIC (e.g. XMAD) resolves to its operating exchange. */
export function findEuExchange(mic: string): EuExchange | undefined {
  const key = mic.trim().toUpperCase();
  return BY_MIC.get(key) ?? EU_EXCHANGES.find((e) => e.segments.includes(key));
}
`;
}

if (import.meta.main) {
  const arg = process.argv[2];
  let csv: string;
  if (arg) csv = readFileSync(arg, "utf8");
  else {
    const res = await fetch(CSV_URL);
    if (!res.ok) throw new Error(`ISO 10383 download failed: HTTP ${res.status}`);
    csv = await res.text();
  }
  const list = buildExchanges(csv);
  for (const mic of Object.keys(NAME_OVERRIDES)) {
    if (!list.some((e) => e.mic === mic))
      console.warn(`override ${mic} matches no generated exchange`);
  }
  writeFileSync(OUT, render(list));
  console.log(`wrote ${list.length} exchanges to ${OUT}`);
}
