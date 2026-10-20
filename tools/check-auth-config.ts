import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkAuthConfig, parseToml } from "./lib/auth-config.ts";

const configPath = fileURLToPath(new URL("../supabase/config.toml", import.meta.url));
const flag = process.argv.find((arg) => arg.startsWith("--production-url="));
const productionSiteUrl = flag ? flag.slice("--production-url=".length) : undefined;

const text = readFileSync(configPath, "utf8");
const problems = checkAuthConfig(text, productionSiteUrl ? { productionSiteUrl } : {});

if (problems.length > 0) {
  console.error("auth config: FAILED");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
const urls = parseToml(text).get("auth")?.get("additional_redirect_urls");
console.log(`auth config: OK (${Array.isArray(urls) ? urls.length : 0} redirect urls)`);
