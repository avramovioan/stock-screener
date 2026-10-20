import { isServerSecret, LOCAL_ONLY_NAMES, PUBLIC_OR_PLATFORM_NAMES } from "./secret-names.ts";

const SECRET_LOOKING = /KEY|SECRET|TOKEN|PASSWORD|SALT/;
const LOCAL_EXAMPLE_VALUES = new Set(["local-dev-cron-secret"]);
const READ =
  /(?:Deno\.env\.get|requireEnv|optionalEnv|\bget)\(\s*"([A-Z][A-Z0-9]*_[A-Z0-9_]+)"\s*\)/g;

/** True when the text spells the name as a whole word (code span, table cell or env-file line). */
function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(text);
}

export function envNamesInSource(text: string): string[] {
  return [...text.matchAll(READ)].map((m) => m[1] as string);
}

export interface InventoryInput {
  codeNames: string[];
  guideText: string;
  exampleFiles: Array<{ path: string; text: string }>;
}

export function inventoryProblems(input: InventoryInput): string[] {
  const problems: string[] = [];
  const known = new Set<string>([...PUBLIC_OR_PLATFORM_NAMES, ...LOCAL_ONLY_NAMES]);
  for (const name of [...new Set(input.codeNames)].sort()) {
    if (
      SECRET_LOOKING.test(name) &&
      !(PUBLIC_OR_PLATFORM_NAMES as readonly string[]).includes(name) &&
      !isServerSecret(name)
    ) {
      problems.push(
        `${name} looks like a secret but is not in SERVER_SECRET_NAMES (the bundle scan would not catch it)`,
      );
    }
    if (!known.has(name) && !mentions(input.guideText, name)) {
      problems.push(`${name} is read by the code but not documented in the operator guide`);
    }
  }
  for (const file of input.exampleFiles) {
    for (const line of file.text.split(/\r?\n/)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match?.[1] === undefined) continue;
      const [name, value = ""] = [match[1], match[2]];
      if (
        name.startsWith("VITE_") &&
        /SECRET|SERVICE_ROLE|PRIVATE|TOKEN|PASSWORD|API_KEY/.test(name)
      ) {
        problems.push(`${file.path}: ${name} would put a secret into the browser bundle`);
      }
      if (
        SECRET_LOOKING.test(name) &&
        value !== "" &&
        !LOCAL_EXAMPLE_VALUES.has(value) &&
        !/^\d+$/.test(value)
      ) {
        problems.push(
          `${file.path}: ${name} has a value; example files hold names only (version numbers excepted)`,
        );
      }
    }
  }
  return problems;
}
