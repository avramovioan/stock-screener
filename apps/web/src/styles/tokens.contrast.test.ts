import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// happy-dom replaces the global URL and mis-resolves file: URLs on Windows, so resolve paths with node:path
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "index.css"), "utf8");

function readBlock(selector: RegExp): Record<string, string> {
  const block = css.match(selector)?.[1];
  if (block === undefined) throw new Error(`CSS block not found: ${selector}`);
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) tokens[name] = value.trim();
  }
  return tokens;
}

const light = readBlock(/^:root\s*\{([^}]*)\}/m);
const dark = { ...light, ...readBlock(/^\.dark\s*\{([^}]*)\}/m) };

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const TAGS = ["discounted", "premium", "extra-premium", "unavailable", "caution", "flagged"];
const PAIRS: Array<[string, string]> = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["muted-foreground", "muted"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["destructive-foreground", "destructive-hover"], // Button/Badge destructive: text-destructive-foreground on bg-destructive, hover:bg-destructive-hover
  ["primary", "background"],
  ["primary", "card"],
  ["muted-foreground", "card"],
  ["tag-unavailable-fg", "muted"], // flagged card text on its muted surface
  ["destructive", "background"],
  ["destructive", "card"],
  ["positive", "background"],
  ["positive", "card"],
  ["negative", "background"],
  ["negative", "card"],
  ...TAGS.map((tag): [string, string] => [`tag-${tag}-fg`, `tag-${tag}-bg`]),
];

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("%s theme tokens", (_name, tokens) => {
  it.each(PAIRS)("%s on %s meets WCAG AA (4.5:1)", (fg, bg) => {
    const foreground = tokens[fg];
    const background = tokens[bg];
    expect(foreground, `missing token --${fg}`).toMatch(/^#[0-9a-f]{6}$/i);
    expect(background, `missing token --${bg}`).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(foreground ?? "#000000", background ?? "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});
