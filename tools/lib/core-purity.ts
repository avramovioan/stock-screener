export interface PurityViolation {
  line: number;
  rule: string;
  text: string;
}

interface LineRule {
  rule: string;
  pattern: RegExp;
}

const LINE_RULES: readonly LineRule[] = [
  { rule: "no-date-now", pattern: /\bDate\.now\s*\(/ },
  { rule: "no-new-date-without-args", pattern: /\bnew\s+Date\s*\(\s*\)/ },
  { rule: "no-math-random", pattern: /\bMath\.random\s*\(/ },
];

// from "x" | import "x" | import("x") | export ... from "x"
const SPECIFIER_PATTERN = /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

/**
 * Static checks that `tsc` cannot make: determinism (no ambient clock or randomness) and the
 * "relative .ts imports only" rule that lets one core file resolve under Deno, Vite and tsc.
 */
export function findPurityViolations(source: string): PurityViolation[] {
  const violations: PurityViolation[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (isCommentLine(trimmed)) return;
    const line = index + 1;
    for (const { rule, pattern } of LINE_RULES) {
      if (pattern.test(text)) violations.push({ line, rule, text: trimmed });
    }
    for (const match of text.matchAll(SPECIFIER_PATTERN)) {
      const specifier = match[1] ?? "";
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative) {
        violations.push({ line, rule: "no-bare-or-alias-import", text: trimmed });
      } else if (!specifier.endsWith(".ts")) {
        violations.push({ line, rule: "relative-import-needs-ts-extension", text: trimmed });
      }
    }
  });
  return violations;
}
