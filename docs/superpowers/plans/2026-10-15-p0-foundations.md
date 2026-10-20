# P0 Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the repository scaffold of spec section 3 and the P0 deliverables of section 18 that need no hosted accounts: a Bun workspace with Biome, TypeScript 6.x and Vitest wired up; a pure-TypeScript core module skeleton shared by Deno, Vite and Vitest; a Vite 8 + React 19 PWA shell with design tokens; Cloudflare Workers Static Assets config; a local Supabase project with a `health` Edge Function and a pgTAP smoke test; and the four GitHub Actions workflows. Every guard the spec only implies (core purity, service-worker cache rules, bundle secrets, function config drift, deploy env) gets an executable check.

**Architecture:** One repository, one algorithm source. `supabase/functions/_shared/core` is pure TypeScript with relative `.ts` imports only; the web app reaches it through the `@core/*` alias, Edge Functions through the per-function import-map prefix `@core/`. Vitest runs three projects from a root `vitest.config.ts` (`core` and `tools` in Node, `web` in happy-dom). Deno owns type checking and tests of everything under `supabase/functions` except core tests. Repository-level guards live in `tools/*.ts` with their logic in `tools/lib/*.ts` so Vitest can test them.

**Tech Stack:** Bun 1.3.14 (package manager and script runner), Node 22.13.1 (Vitest, Vite, Playwright run under Node), TypeScript 6.0.3, Biome 2.5.15, Vite 8.3.4, React 19.3.1, TanStack Router 1.170.44 (code-based routes) and Query 5.104.2, Tailwind 4.3.3, shadcn/ui CLI 4.21.5 (Radix base), vite-plugin-pwa 2.0.0 (`injectManifest`, Workbox 7.4.1), Vitest 5.0.4 with happy-dom 21.0.1, Playwright 1.64.1, Supabase CLI 2.121.0, Deno (local 2.9.6, CI 2.1.x), Cloudflare Workers Static Assets (wrangler 4.151.0), GitHub Actions.

**Spec:** docs/superpowers/specs/2026-10-15-stock-screener-design.md

## Global Constraints

- Package manager is Bun 1.3.x (`bun install`, workspaces `["apps/*"]`); `bun.lock` is committed and CI uses `bun install --frozen-lockfile`. `bunfig.toml` sets `exact = true` (for future `bun add`) and `linker = "hoisted"` (Bun 1.3 defaults to isolated installs for workspaces; the root Vitest config and every tool must resolve packages from the root `node_modules`).
- Dev machine is Windows 11, Node 22.13.1 floor (`.node-version`), PowerShell default shell, Git Bash available. Vitest, Vite and Playwright run under Node, never under Bun's runtime. `package.json` scripts contain no bash-only syntax; shell glue is a Bun script under `tools/`.
- TypeScript is pinned to the exact release `6.0.3` (highest 6.x on npm on 2026-10-15; npm `latest` is 7.0.2 and is NOT adopted until Biome, vite-plugin-pwa types and Vitest are verified against it, A-21). TypeScript is used for `tsc --noEmit` only.
- Biome 2.5.15 formats and lints (no ESLint, no typescript-eslint, no Prettier): 2 spaces, line width 100, double quotes, semicolons always, trailing commas `all`, recommended rules, `noExplicitAny` error, `noNonNullAssertion` warn, `useImportType` error, organize imports on. `lint` is `biome ci .`; run `bun run lint:fix` before it (organise-imports is an assist action that `biome format` does not apply).
- `tsconfig.base.json` is exactly spec 3.6: strict, `moduleResolution: "Bundler"`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, no `baseUrl`, `paths` `@core/*` -> `./supabase/functions/_shared/core/*`.
- The `@core/*` alias is for the web app, tests and tools only. Inside `supabase/functions/**` every relative import carries its `.ts` extension (Deno rule). Core files use relative `.ts` imports only (no alias, no bare specifiers) so one file resolves under Deno, Vite and `tsc`.
- Core purity: `supabase/functions/_shared/core/tsconfig.json` has `lib: ["ES2023"]`, `types: []`, and (plan decision) excludes `*.test.ts` so Vitest's Node types cannot leak into the program. No `Date.now()`, `new Date()` without arguments, or `Math.random()` in core: time and randomness are parameters.
- `deno test` is never pointed at `_shared/core` (its tests import `vitest`); `deno check` and `deno test` always pass `--config supabase/functions/deno.json` (`"nodeModulesDir": "none"`).
- Per-function `deno.json` import maps are identical in every function (`@core/`, `@adapters/`, `@supabase/supabase-js` -> `npm:@supabase/supabase-js@2.117.3`). Every function has `[functions.<name>] verify_jwt = false` in `supabase/config.toml`; authentication is done in code (cron secret header, `getClaims()`).
- No secrets in the browser bundle: only `VITE_*` public values exist at build time; `tools/check-bundle-secrets.ts` scans `apps/web/dist` after every build (spec 3.11). `.env*` is git-ignored except `.env.example`; local Supabase keys printed by `supabase start` are never committed.
- Supabase Free limits shape the design: no Storage/Realtime dependence, no CPU-heavy work in functions, a keep-alive workflow protects against the one-week inactivity pause (spec 16.4). Edge Runtime is Deno 2.1.4-compatible; CI Deno is 2.1.x for that reason.
- Cloudflare Workers Static Assets (Free): `assets.directory ./dist`, `not_found_handling: "single-page-application"`, `html_handling: "auto-trailing-slash"`, no Worker script, `_headers` shipped from `public/`; no card data is ever processed.
- PWA: `vite-plugin-pwa` `injectManifest`, `registerType: "prompt"`, `/sw.js` and `/manifest.webmanifest` served from the site root with `Cache-Control: no-cache`; the service worker never caches `*.supabase.co`, `/rest/`, `/auth/`, `/functions/` or requests carrying `Authorization`/`apikey`.
- Never colour alone; WCAG AA 4.5:1 for token text pairs in both themes (spec 14.6); theme is `light|dark|system` in `localStorage` key `theme` inside try/catch; `dark` class on `<html>`; `/theme-init.js` is loaded synchronously (the CSP forbids inline script).
- Script names are fixed: `dev build lint lint:fix format typecheck test test:web test:core test:tools test:db test:e2e functions:check functions:test supabase:start supabase:stop supabase:reset supabase:serve`; alias `@core/*`; function names `health`, `worker-tick`, `scan-control`, `retention-cleanup`.
- Branch is `master` (the spec's `main` in 3.10 means this branch). Every task ends with a conventional-commit commit; never commit `.env`, `supabase/functions/.env`, local keys, `playwright-report`, `test-results`, `.wrangler`.
- No P1+ work: no domain code, no business tables, no Supabase client usage in the SPA yet.

## Review Focus

The five failure modes below follow from the spec but no feature test would exercise them; each is pinned by a check in the owning task.

1. **Core purity leaks silently (Task 2).** `tsc` with `lib: ES2023` rejects `process`, `Deno`, `document`, `fetch`, `setTimeout`, `console`, but accepts `Date.now()`, `new Date()`, `Math.random()`, alias imports and extensionless imports; and a `*.test.ts` that imports `vitest` pulls Node globals into the same program so `process` would compile inside core. Pinned by `tools/check-core-purity.ts` (static scan plus a canary file that must fail `tsc`) with unit tests in `tools/lib/core-purity.test.ts`, wired into `bun run typecheck`.
2. **Service worker serves or caches the wrong thing (Task 4).** Authenticated or Supabase responses cached; `/auth/*` (OAuth callback) or `/functions/*` swallowed by the navigation fallback; a push payload that opens an off-origin URL; a malformed push that shows no notification (iOS revokes the subscription). Pinned by the pure predicates in `apps/web/src/sw-routes.ts` and `sw-routes.test.ts`, which `sw.ts` consumes.
3. **A secret reaches the browser bundle (Task 4).** A `VITE_`-prefixed secret, a service-role JWT or an `sb_secret_` key in `dist`. Pinned by `tools/lib/secret-scan.ts` tests and `bun run check:bundle`, run after every build in CI and in `deploy-web.yml`.
4. **`functions:check` is green while checking nothing, or a function ships without `verify_jwt = false` or with a drifted import map (Task 5).** Windows glob handling, a missing `[functions.x]` block (cron call gets 401 in production), an import map that differs between functions. Pinned by `tools/functions-check-selftest.ts` (deliberately broken files must fail `bun run functions:check`) and `tools/check-functions-config.ts` with unit tests.
5. **The web app is deployed with empty, localhost or secret-bearing `VITE_*` values (Task 6).** `vite build` succeeds with undefined variables and publishes a broken site. Pinned by `tools/lib/web-env.ts` tests and a guard step in `deploy-web.yml`.

---

### Task 1: Workspace root

**Files:**
- Create: `.node-version`, `.editorconfig`, `.gitignore`, `bunfig.toml`, `package.json`, `biome.json`, `tsconfig.base.json`
- Modify: `README.md`
- Generated and committed: `bun.lock`

**Interfaces:**
- Consumes: nothing.
- Produces: the root script surface listed in Global Constraints; `workspaces: ["apps/*"]`; `bun run lint` (`biome ci .`), `bun run lint:fix` (`biome check --write .`), `bun run format`; `tsconfig.base.json` (extended by every other tsconfig); `bunfig.toml` with `linker = "hoisted"`; `trustedDependencies: ["supabase"]` (Bun skips dependency postinstall scripts by default and the Supabase binary would not download).

- [ ] **Step 1: Write `.node-version`, `.editorconfig`, `.gitignore`**

`.node-version`:

```text
22.13.1
```

`.editorconfig`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

`.gitignore`:

```gitignore
# dependencies and build output
node_modules/
dist/
dev-dist/
coverage/
*.tsbuildinfo

# environment files: never commit values, only .env.example
.env*
!.env.example

# Supabase local state
supabase/.temp/
supabase/.branches/

# test output
playwright-report/
test-results/

# Cloudflare / wrangler local state
.wrangler/

# editor and OS
.vscode/
.idea/
.DS_Store
Thumbs.db
.claude/settings.local.json
```

- [ ] **Step 2: Write `bunfig.toml`**

```toml
[install]
# future `bun add` writes exact versions; hand-written package.json files may use caret ranges,
# the committed bun.lock is what pins the tree
exact = true
# Bun 1.3 defaults to the isolated linker for workspaces. The root Vitest config, Biome and the
# tools/ scripts resolve packages from the root node_modules, so use the classic hoisted layout.
linker = "hoisted"
```

- [ ] **Step 3: Write root `package.json`**

Scripts that point at files created by later tasks (`typecheck`, `test:*`, `functions:*`, `check:*`, `lint:workflows`, `gen:icons`) exist now so the script surface is fixed; each is verified in the task that creates its target.

```json
{
  "name": "personal-stock-screener",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*"],
  "engines": { "node": ">=22.13.1" },
  "trustedDependencies": ["supabase"],
  "scripts": {
    "dev": "bun run --filter @screener/web dev",
    "build": "bun run --filter @screener/web build",
    "lint": "biome ci .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "lint:workflows": "bun run tools/validate-workflows.ts",
    "typecheck": "tsc -p apps/web --noEmit && tsc -p supabase/functions/_shared/core --noEmit && tsc -p tsconfig.json --noEmit && bun run tools/check-core-purity.ts",
    "test": "bun run test:core && bun run test:tools && bun run test:web && bun run functions:test",
    "test:core": "vitest run --project core",
    "test:tools": "vitest run --project tools",
    "test:web": "vitest run --project web",
    "test:db": "supabase test db",
    "test:e2e": "bun run build && bun run --filter @screener/web e2e",
    "check:bundle": "bun run tools/check-bundle-secrets.ts",
    "check:functions-config": "bun run tools/check-functions-config.ts",
    "functions:check": "deno check --config supabase/functions/deno.json \"supabase/functions/**/*.ts\" \"!supabase/functions/_shared/core/**/*.test.ts\"",
    "functions:test": "deno test -A --config supabase/functions/deno.json --ignore=supabase/functions/_shared/core supabase/functions",
    "functions:selftest": "bun run tools/functions-check-selftest.ts",
    "supabase:start": "supabase start",
    "supabase:stop": "supabase stop",
    "supabase:reset": "supabase db reset",
    "supabase:serve": "supabase functions serve --no-verify-jwt",
    "gen:icons": "bun run tools/gen-icons.ts"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.15",
    "supabase": "^2.121.0",
    "typescript": "6.0.3"
  }
}
```

The two quoted globs in `functions:check` are expanded by Deno itself (verified on Windows through Bun's script shell on 2026-10-15), so no shell globbing is involved.

- [ ] **Step 4: Write `biome.json`**

Plan decision: the rule `correctness/useImportExtensions` could not be enabled for `supabase/functions/**` only (verified on 2026-10-15 with Biome 2.5.15: neither `overrides` nor a nested `biome.json` with `extends: "//"` applied it, while enabling it globally flagged every extensionless import in the web app too). The spec allows this fallback (3.5): the `.ts` rule is enforced by `deno check` (Task 5 self-test) and by the core purity scan (Task 2).

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "ignoreUnknown": true,
    "includes": [
      "**",
      "!**/dist",
      "!**/dev-dist",
      "!**/node_modules",
      "!**/coverage",
      "!**/playwright-report",
      "!**/test-results",
      "!**/.wrangler",
      "!supabase/.temp",
      "!supabase/.branches",
      "!bun.lock",
      "!apps/web/src/routeTree.gen.ts",
      "!apps/web/src/components/ui"
    ]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
    "lineEnding": "lf"
  },
  "javascript": {
    "formatter": { "quoteStyle": "double", "semicolons": "always", "trailingCommas": "all" }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "preset": "recommended",
      "suspicious": { "noExplicitAny": "error" },
      "style": { "noNonNullAssertion": "warn", "useImportType": "error" }
    }
  },
  "assist": { "enabled": true, "actions": { "source": { "organizeImports": "on" } } }
}
```

`apps/web/src/components/ui` is the shadcn-generated folder (regenerated by the CLI); it is still type-checked by `tsc`. The key `"preset": "recommended"` is the non-deprecated form in Biome 2.5 (the old `"recommended": true` prints a deprecation notice).

- [ ] **Step 5: Write `tsconfig.base.json`** (verbatim spec 3.6)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "paths": { "@core/*": ["./supabase/functions/_shared/core/*"] }
  }
}
```

There is deliberately no `baseUrl`: `paths` resolve relative to this file. A tsconfig that extends this one and defines its own `paths` replaces (does not merge) the map, so `apps/web/tsconfig.json` re-declares `@core/*`.

- [ ] **Step 6: Replace `README.md`**

````markdown
# Personal stock screener

Private stock screener: a daily, resumable scan computes the standard-deviation channel
(Pine `stddevchn.pine`) for a worldwide universe, ranks discounted and premium securities, and
serves the result as a PWA. Specification: `docs/superpowers/specs/2026-10-15-stock-screener-design.md`.
Plans: `docs/superpowers/plans/`. Runbook: `docs/operator-guide.md`.

## Prerequisites (Windows 11 or Linux)

- Bun 1.3.x, Node 22.13.1 (see `.node-version`), Docker Desktop, Deno 2.x (`npm i -g deno`).
- The Supabase CLI is a dev dependency: use `bunx supabase ...` or the `supabase:*` scripts.

## Quick start

```text
bun install
bun run dev                 # Vite dev server on http://localhost:5173
bun run lint                # biome ci .   (bun run lint:fix applies fixes)
bun run typecheck           # tsc for web, core and tools + core purity check
bun run test                # core + tools + web (Vitest) and Deno tests
bun run build               # production build of apps/web
bun run test:e2e            # builds, then Playwright smoke test (bunx playwright install chromium once)
bun run supabase:start      # local Supabase stack (Docker)
bun run test:db             # pgTAP tests against the local stack
bun run supabase:serve      # serve Edge Functions, then: curl http://127.0.0.1:54321/functions/v1/health
bun run functions:check     # deno check of every Edge Function and shared adapter
bun run supabase:stop
```

Environment files: copy `apps/web/.env.example` to `apps/web/.env.local` and
`supabase/functions/.env.example` to `supabase/functions/.env`. Never commit real values.
````

- [ ] **Step 7: Install and verify**

Run: `bun install`
Expected: exits 0, creates `bun.lock` and `node_modules/`, downloads the Supabase binary (postinstall allowed by `trustedDependencies`). If Bun reports that the workspace glob `apps/*` matches nothing, create an empty `apps/.gitkeep` and re-run (Task 3 adds `apps/web`).

Run: `bun run lint:fix` then `bun run lint`
Expected: the first normalises JSON formatting; the second prints `Checked N files ... No fixes applied.` and exits 0.

Run: `bun run tsc --version`
Expected: `Version 6.0.3`.

- [ ] **Step 8: Commit**

```text
git add .node-version .editorconfig .gitignore bunfig.toml package.json bun.lock biome.json tsconfig.base.json README.md
git commit -m "chore: add bun workspace root, biome and base tsconfig"
```


### Task 2: Core module skeleton and its test projects

**Files:**
- Create: `supabase/functions/_shared/core/mod.ts`, `supabase/functions/_shared/core/tsconfig.json`, `supabase/functions/_shared/core/mod.test.ts`
- Create: `vitest.config.ts`, `tsconfig.json`
- Create: `tools/lib/core-purity.ts`, `tools/lib/core-purity.test.ts`, `tools/check-core-purity.ts`
- Modify: `package.json` (devDependencies)

**Interfaces:**
- Consumes: `tsconfig.base.json`, root scripts `test:core`, `test:tools`, `typecheck` from Task 1.
- Produces: `CORE_VERSION` (`"0.0.1"`) exported from `supabase/functions/_shared/core/mod.ts` (imported by `health` in Task 5 and by an alias test in Task 3); Vitest projects named `core` and `tools` (Task 3 rewrites the config to add `web`); `findPurityViolations(source: string): PurityViolation[]` from `tools/lib/core-purity.ts`; root `tsconfig.json` (types `node`, covers `tools/`, `vitest.config.ts`, and from Task 4 `apps/web/playwright.config.ts`).

- [ ] **Step 1: Add test tooling to root `devDependencies`**

`package.json` `devDependencies` becomes (alphabetical):

```json
"devDependencies": {
  "@biomejs/biome": "^2.5.15",
  "@types/node": "^22.20.5",
  "supabase": "^2.121.0",
  "typescript": "6.0.3",
  "vite": "^8.3.4",
  "vitest": "^5.0.4"
}
```

Run: `bun install`
Expected: exits 0; `bun run vitest --version` prints `5.0.4`. Vitest runs under Node because its bin has a `node` shebang. If Bun routes it through its own runtime and a later run fails with `vm`-related errors, change the `test:*` scripts to `node node_modules/vitest/vitest.mjs run --project <name>` and record it in Task 7's results file (spec P0-01).

- [ ] **Step 2: Write the core module and its purity-enforcing tsconfig**

`supabase/functions/_shared/core/mod.ts`:

```ts
// Pure domain core shared by Deno Edge Functions, the Vite app and Vitest.
// Rules: relative ".ts" imports only, no Deno/Node/DOM globals, no Date.now(), no Math.random().
export const CORE_VERSION = "0.0.1";
```

`supabase/functions/_shared/core/tsconfig.json` (spec 3.6 plus `exclude`; the exclusion keeps `vitest`'s Node typings out of the purity program, see Review Focus 1):

```json
{
  "extends": "../../../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": [] },
  "include": ["./**/*.ts"],
  "exclude": ["./**/*.test.ts"]
}
```

- [ ] **Step 3: Write the core test**

`supabase/functions/_shared/core/mod.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "./mod.ts";

describe("core module", () => {
  it("exports the P0 skeleton version", () => {
    expect(CORE_VERSION).toBe("0.0.1");
  });

  it("uses a semantic version string", () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 4: Write `vitest.config.ts` (projects `core` and `tools`)**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          environment: "node",
          include: ["supabase/functions/_shared/core/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "tools",
          environment: "node",
          include: ["tools/**/*.test.ts"],
        },
      },
    ],
  },
});
```

- [ ] **Step 5: Run the core tests**

Run: `bun run test:core`
Expected: `Test Files 1 passed (1)`, `Tests 2 passed (2)`, exit 0.

- [ ] **Step 6: Write root `tsconfig.json` (typechecks tools and root configs)**

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": ["node"] },
  "include": ["tools", "vitest.config.ts"]
}
```

- [ ] **Step 7: Write the failing purity-scan tests (TDD)**

`tools/lib/core-purity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findPurityViolations } from "./core-purity.ts";

const rules = (source: string) => findPurityViolations(source).map((v) => v.rule);

describe("findPurityViolations", () => {
  it("accepts a pure module", () => {
    const source = [
      'import { a } from "./a.ts";',
      'import type { B } from "../b.ts";',
      "export const x = (nowMs: number) => new Date(nowMs).getTime();",
      'export const f = new Intl.DateTimeFormat("en", { timeZone: "Europe/Sofia" });',
    ].join("\n");
    expect(rules(source)).toEqual([]);
  });

  it("flags Date.now()", () => {
    expect(rules("export const t = Date.now();")).toEqual(["no-date-now"]);
  });

  it("flags new Date() without arguments but not with arguments", () => {
    expect(rules("export const t = new Date();")).toEqual(["no-new-date-without-args"]);
    expect(rules("export const t = new Date( );")).toEqual(["no-new-date-without-args"]);
    expect(rules("export const t = new Date(0);")).toEqual([]);
  });

  it("flags Math.random()", () => {
    expect(rules("export const r = Math.random();")).toEqual(["no-math-random"]);
  });

  it("flags bare and alias imports", () => {
    expect(rules('import { z } from "zod";')).toEqual(["no-bare-or-alias-import"]);
    expect(rules('import { x } from "@core/mod.ts";')).toEqual(["no-bare-or-alias-import"]);
    expect(rules('export { y } from "node:fs";')).toEqual(["no-bare-or-alias-import"]);
    expect(rules('const m = await import("npm:left-pad");')).toEqual(["no-bare-or-alias-import"]);
  });

  it("flags relative imports without the .ts extension", () => {
    expect(rules('import { a } from "./a";')).toEqual(["relative-import-needs-ts-extension"]);
    expect(rules('import { a } from "../a.js";')).toEqual(["relative-import-needs-ts-extension"]);
  });

  it("ignores forbidden text inside comments", () => {
    const source = ["// Date.now() is forbidden here", "/* Math.random() */", " * new Date()"].join(
      "\n",
    );
    expect(rules(source)).toEqual([]);
  });

  it("reports 1-based line numbers", () => {
    const violations = findPurityViolations("export const a = 1;\nexport const t = Date.now();");
    expect(violations[0]?.line).toBe(2);
  });
});
```

- [ ] **Step 8: Run to confirm failure**

Run: `bun run test:tools`
Expected: FAIL, `Failed to resolve import "./core-purity.ts"`.

- [ ] **Step 9: Implement `tools/lib/core-purity.ts`**

```ts
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
```

- [ ] **Step 10: Run to confirm pass**

Run: `bun run test:tools`
Expected: `Tests 8 passed (8)`, exit 0.

- [ ] **Step 11: Write `tools/check-core-purity.ts`**

```ts
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPurityViolations } from "./lib/core-purity.ts";

const coreDir = fileURLToPath(new URL("../supabase/functions/_shared/core/", import.meta.url));
const tscBin = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const canaryFile = join(coreDir, "__purity_canary__.ts");

// Globals that must be compile errors inside core (lib ES2023, types []).
const FORBIDDEN_GLOBALS = ["process", "Deno", "document", "fetch", "setTimeout", "console"];

let failed = false;
const fail = (message: string) => {
  failed = true;
  console.error(`core purity: ${message}`);
};

// 1. Static scan of every non-test core source file.
const sources = readdirSync(coreDir, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .filter((file) => !file.includes("__purity_canary__"));
for (const file of sources) {
  const text = readFileSync(join(coreDir, file), "utf8");
  for (const v of findPurityViolations(text)) {
    fail(`${file}:${v.line} ${v.rule}: ${v.text}`);
  }
}

// 2. Canary: the core tsconfig must reject ambient environment globals.
const canary = [
  "export const a = process.env.X;",
  'export const b = Deno.env.get("X");',
  "export const c = document.title;",
  'export const d = fetch("x");',
  "export const e = setTimeout(() => {}, 1);",
  'console.log("x");',
  "",
].join("\n");
try {
  writeFileSync(canaryFile, canary);
  const result = spawnSync(
    "node",
    [tscBin, "-p", join(coreDir, "tsconfig.json"), "--noEmit", "--pretty", "false"],
    { encoding: "utf8" },
  );
  const output = `${result.stdout}${result.stderr}`;
  if (result.status === 0) fail("canary compiled; the core tsconfig no longer forbids globals");
  for (const name of FORBIDDEN_GLOBALS) {
    if (!output.includes(`Cannot find name '${name}'`)) {
      fail(`canary did not flag the global '${name}'`);
    }
  }
} finally {
  rmSync(canaryFile, { force: true });
}

if (failed) process.exit(1);
console.log(
  `core purity: OK (${sources.length} files scanned, ${FORBIDDEN_GLOBALS.length} canary globals rejected)`,
);
```

- [ ] **Step 12: Run the core typecheck and the purity check**

Run: `bun run tsc -p supabase/functions/_shared/core --noEmit`
Expected: no output, exit 0.

Run: `bun run tools/check-core-purity.ts`
Expected: `core purity: OK (1 files scanned, 6 canary globals rejected)`.

- [ ] **Step 13: Prove the check bites, then revert**

Append `export const t = Date.now();` to `supabase/functions/_shared/core/mod.ts`.

Run: `bun run tools/check-core-purity.ts`
Expected: exit 1 with `core purity: mod.ts:4 no-date-now: export const t = Date.now();`.

Remove the appended line and re-run; expected `core purity: OK`.

- [ ] **Step 14: Lint, typecheck the tools project, commit**

Run: `bun run lint:fix` then `bun run lint`
Expected: exit 0.

Run: `bun run tsc -p tsconfig.json --noEmit`
Expected: exit 0 (covers `tools/` and `vitest.config.ts`).

```text
git add package.json bun.lock vitest.config.ts tsconfig.json supabase/functions/_shared/core tools
git commit -m "feat(core): add core module skeleton, vitest projects and purity guard"
```


### Task 3: Web app scaffold

**REQUIRED before Step 9 (tokens) and Step 17 (shell):** the implementer MUST load the `frontend-design:frontend-design` and `ui-ux-pro-max:ui-ux-pro-max` skills (Skill tool) and apply them to the design tokens and the app shell. The code below is a complete, working baseline; the skills may refine token VALUES, spacing, typography and layout. Fixed constraints: keep every CSS variable name, keep `tokens.contrast.test.ts` green (WCAG AA 4.5:1, both themes), no external fonts or CDNs (CSP), no colour-only status, mobile-first with a bottom nav below `md`, tabular figures utility, `prefers-reduced-motion` respected.

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/components.json`, `apps/web/.env.example`
- Create: `apps/web/public/theme-init.js`, `apps/web/public/robots.txt`
- Create: `apps/web/src/main.tsx`, `src/vite-env.d.ts`, `src/providers.tsx`, `src/router.tsx`
- Create: `apps/web/src/styles/index.css`, `src/lib/utils.ts`, `src/lib/query-client.ts`
- Create: `apps/web/src/components/theme-provider.tsx`, `theme-toggle.tsx`, `app-shell.tsx`, `page-placeholder.tsx`, `ui/sonner.tsx` (overwrites the generated one) and the generated `ui/*.tsx`
- Create: `apps/web/src/features/pages.tsx`
- Create tests: `apps/web/src/test/setup.ts`, `src/styles/tokens.contrast.test.ts`, `src/theme-init.test.ts`, `src/components/theme-provider.test.tsx`, `src/components/app-shell.test.tsx`, `src/lib/core-alias.test.ts`
- Modify: `package.json` (root devDependencies), `vitest.config.ts`

**Interfaces:**
- Consumes: `CORE_VERSION` from `@core/mod.ts` (Task 2); root scripts `dev`, `build`, `test:web`, `typecheck`.
- Produces: workspace `@screener/web` with scripts `dev`, `build`, `preview` (port 4173, strict), `e2e`; `createAppRouter(history?: RouterHistory)` and `router` from `src/router.tsx`; `AppProviders` from `src/providers.tsx`; `ThemeProvider`, `useTheme`, `THEME_STORAGE_KEY` (`"theme"`) from `components/theme-provider.tsx`; CSS tokens (names below) used by Task 4's manifest colours; the alias `@` -> `apps/web/src` and `@core` -> `supabase/functions/_shared/core` in Vite and Vitest; Vitest project `web`.

- [ ] **Step 1: Write `apps/web/package.json`**

```json
{
  "name": "@screener/web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --port 4173 --strictPort",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.104.2",
    "@tanstack/react-router": "^1.170.44",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^1.57.0",
    "radix-ui": "^1.8.1",
    "react": "^19.3.1",
    "react-dom": "^19.3.1",
    "sonner": "^2.0.8",
    "tailwind-merge": "^3.7.0",
    "tw-animate-css": "^1.4.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@testing-library/dom": "^10.4.2",
    "@testing-library/react": "^16.3.3",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.2",
    "happy-dom": "^21.0.1",
    "tailwindcss": "^4.3.3",
    "vite": "^8.3.4"
  }
}
```

Plan decision: `@tanstack/router-plugin` (file-based routes, spec 14.1) is NOT installed; the P0 brief fixes code-based routes in `src/router.tsx`. P4 may migrate to file routes. `lightweight-charts`, `@supabase/supabase-js`, `zod`, `date-fns` are installed by the phases that first import them.

- [ ] **Step 2: Add the root test dependencies and install**

Root `package.json` `devDependencies` gains `"@vitejs/plugin-react": "^6.1.2"` and `"happy-dom": "^21.0.1"` (the root `vitest.config.ts` imports them), giving:

```json
"devDependencies": {
  "@biomejs/biome": "^2.5.15",
  "@types/node": "^22.20.5",
  "@vitejs/plugin-react": "^6.1.2",
  "happy-dom": "^21.0.1",
  "supabase": "^2.121.0",
  "typescript": "6.0.3",
  "vite": "^8.3.4",
  "vitest": "^5.0.4"
}
```

Run: `bun install`
Expected: exits 0; `apps/web` is linked as workspace `@screener/web`; `bun.lock` updated. Warnings about optional peers of `@vitejs/plugin-react` (`babel-plugin-react-compiler` etc.) are expected and harmless.

- [ ] **Step 3: Write `apps/web/tsconfig.json` and `src/vite-env.d.ts`**

`apps/web/tsconfig.json` (spec 3.6 plus `node` types because tests read files with `node:fs`; `paths` is re-declared because a child `paths` replaces the base map; `playwright.config.ts` is covered by the root `tsconfig.json` in Task 4):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable", "WebWorker"],
    "jsx": "react-jsx",
    "types": ["vite/client", "node"],
    "paths": {
      "@/*": ["./src/*"],
      "@core/*": ["../../supabase/functions/_shared/core/*"]
    }
  },
  "include": ["src", "e2e", "vite.config.ts", "../../supabase/functions/_shared/core"]
}
```

`apps/web/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_SITE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 4: Write `apps/web/vite.config.ts`**

```ts
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@core": fromHere("../../supabase/functions/_shared/core"),
      "@": fromHere("./src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // the shared core lives outside apps/web, so the dev server must be allowed to serve the repo root
    fs: { allow: [fromHere("../../")] },
  },
  preview: { port: 4173, strictPort: true },
  build: { target: "es2022", sourcemap: false },
});
```

- [ ] **Step 5: Write `index.html`, `.env.example`, `public/theme-init.js`, `public/robots.txt`**

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fafaf9" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0c0a09" />
    <meta
      name="description"
      content="Private stock screener: discounted and premium securities, ranked daily."
    />
    <title>Stock Screener</title>
    <!-- same-origin, synchronous: applies the stored theme before first paint (CSP forbids inline script) -->
    <script src="/theme-init.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/.env.example`:

```text
# Public build-time values only. Everything here is embedded in the browser bundle: no secrets.
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_SITE_URL=
```

`apps/web/public/theme-init.js`:

```js
(() => {
  let theme = "system";
  try {
    const stored = window.localStorage.getItem("theme");
    if (stored === "light" || stored === "dark" || stored === "system") theme = stored;
  } catch {
    // storage can throw in private windows or with blocked site data: fall back to the system theme
  }
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
})();
```

`apps/web/public/robots.txt`:

```text
User-agent: *
Allow: /
```

- [ ] **Step 6: Write the failing tests first (TDD): theme init, theme provider, tokens, alias**

`apps/web/src/test/setup.ts`:

```ts
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});
```

`apps/web/src/lib/core-alias.test.ts` (pins the `@core/*` alias in Vite/Vitest and, through `tsc`, in `paths`):

```ts
import { CORE_VERSION } from "@core/mod.ts";
import { describe, expect, it } from "vitest";

describe("@core alias", () => {
  it("resolves the shared core module outside apps/web", () => {
    expect(CORE_VERSION).toBe("0.0.1");
  });
});
```

`apps/web/src/theme-init.test.ts` (the blocking script and the React provider must agree on the storage key):

```ts
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const script = readFileSync(new URL("../public/theme-init.js", import.meta.url), "utf8");
const run = () => new Function(script)();
const isDark = () => document.documentElement.classList.contains("dark");

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("public/theme-init.js", () => {
  it("applies a stored dark theme", () => {
    window.localStorage.setItem("theme", "dark");
    run();
    expect(isDark()).toBe(true);
  });

  it("applies a stored light theme even when the system prefers dark", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    window.localStorage.setItem("theme", "light");
    run();
    expect(isDark()).toBe(false);
  });

  it("follows the system preference when nothing is stored", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    run();
    expect(isDark()).toBe(true);
  });

  it("does not throw when storage access throws", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("denied");
      },
    });
    expect(run).not.toThrow();
    expect(isDark()).toBe(false);
  });
});
```

`apps/web/src/components/theme-provider.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, THEME_STORAGE_KEY, useTheme } from "./theme-provider";

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <output data-testid="theme">{theme}</output>
      <output data-testid="resolved">{resolvedTheme}</output>
      <button type="button" onClick={() => setTheme("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setTheme("light")}>
        light
      </button>
    </div>
  );
}

const renderProbe = () =>
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("ThemeProvider", () => {
  it("defaults to system and follows prefers-color-scheme", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    renderProbe();
    expect(screen.getByTestId("theme").textContent).toBe("system");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("persists an explicit choice and toggles the dark class", () => {
    renderProbe();
    fireEvent.click(screen.getByText("dark"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    fireEvent.click(screen.getByText("light"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("reads a stored theme on mount", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderProbe();
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });

  it("survives storage that throws (private windows)", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    });
    renderProbe();
    expect(screen.getByTestId("theme").textContent).toBe("system");
    expect(() => fireEvent.click(screen.getByText("dark"))).not.toThrow();
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });
});
```

`apps/web/src/styles/tokens.contrast.test.ts` (spec 14.6: every text/background token pair meets 4.5:1 in both themes):

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

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

const TAGS = ["discounted", "premium", "extra-premium", "unavailable", "caution"];
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
```

`apps/web/src/components/app-shell.test.tsx`:

```tsx
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppProviders } from "@/providers";
import { createAppRouter } from "@/router";

async function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
}

const ROUTES: Array<[string, string]> = [
  ["/", "Overview"],
  ["/quotes", "Quotes"],
  ["/portfolio", "Portfolio"],
  ["/analytics", "Analytics"],
  ["/profile", "Security"],
  ["/profile/security", "Security"],
  ["/profile/broker", "Broker"],
  ["/profile/notifications", "Notifications"],
  ["/about", "About"],
  ["/auth/sign-in", "Authentication"],
  ["/no-such-page", "Page not found"],
];

describe("app shell", () => {
  it.each(ROUTES)("route %s renders the heading %s", async (path, heading) => {
    await renderAt(path);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });

  it("renders primary and mobile navigation with the current page marked", async () => {
    await renderAt("/quotes");
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    const mobile = screen.getByRole("navigation", { name: "Mobile" });
    for (const nav of [primary, mobile]) {
      const labels = within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent?.trim());
      expect(labels).toEqual(["Overview", "Quotes", "Portfolio", "Analytics"]);
      expect(within(nav).getByRole("link", { name: "Quotes" }).getAttribute("aria-current")).toBe(
        "page",
      );
    }
  });

  it("exposes landmarks, a skip link, the profile link and the theme toggle", async () => {
    await renderAt("/");
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Theme/ })).toBeTruthy();
  });
});
```

- [ ] **Step 7: Replace `vitest.config.ts` with the three-project version**

```ts
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          environment: "node",
          include: ["supabase/functions/_shared/core/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "tools",
          environment: "node",
          include: ["tools/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: {
            "@core": fromRoot("./supabase/functions/_shared/core"),
            "@": fromRoot("./apps/web/src"),
          },
        },
        test: {
          name: "web",
          environment: "happy-dom",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          setupFiles: ["apps/web/src/test/setup.ts"],
        },
      },
    ],
  },
});
```

- [ ] **Step 8: Run to confirm the expected failures**

Run: `bun run test:web`
Expected: FAIL. `theme-init` tests pass; `core-alias` passes; `theme-provider`, `app-shell` and `tokens.contrast` fail with `Failed to resolve import` / `ENOENT index.css` because those files do not exist yet.

- [ ] **Step 9: Write the design tokens `apps/web/src/styles/index.css`**

(Skills required; see the note at the top of the task.) Domain tokens follow spec 14.6: discounted green, premium yellow, extra premium gold/orange, unavailable neutral grey, amber caution, positive green, negative red; each tag has text, background and a visible border (forced-colours mode).

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.625rem;
  --background: #fafaf9;
  --foreground: #1c1917;
  --card: #ffffff;
  --card-foreground: #1c1917;
  --popover: #ffffff;
  --popover-foreground: #1c1917;
  --primary: #0f766e;
  --primary-foreground: #ffffff;
  --secondary: #f0efed;
  --secondary-foreground: #292524;
  --muted: #f0efed;
  --muted-foreground: #57534e;
  --accent: #e7f3f1;
  --accent-foreground: #134e4a;
  --destructive: #b91c1c;
  --destructive-foreground: #ffffff;
  --border: #e0deda;
  --input: #d6d3d1;
  --ring: #0f766e;
  --positive: #15803d;
  --negative: #b91c1c;
  --tag-discounted-bg: #dcfce7;
  --tag-discounted-fg: #14532d;
  --tag-discounted-border: #16a34a;
  --tag-premium-bg: #fef9c3;
  --tag-premium-fg: #713f12;
  --tag-premium-border: #ca8a04;
  --tag-extra-premium-bg: #ffedd5;
  --tag-extra-premium-fg: #7c2d12;
  --tag-extra-premium-border: #ea580c;
  --tag-unavailable-bg: #f0efed;
  --tag-unavailable-fg: #44403c;
  --tag-unavailable-border: #78716c;
  --tag-caution-bg: #fef3c7;
  --tag-caution-fg: #78350f;
  --tag-caution-border: #d97706;
}

.dark {
  --background: #0c0a09;
  --foreground: #fafaf9;
  --card: #171412;
  --card-foreground: #fafaf9;
  --popover: #171412;
  --popover-foreground: #fafaf9;
  --primary: #2dd4bf;
  --primary-foreground: #042f2e;
  --secondary: #26211e;
  --secondary-foreground: #fafaf9;
  --muted: #26211e;
  --muted-foreground: #a8a29e;
  --accent: #123c38;
  --accent-foreground: #ccfbf1;
  --destructive: #b91c1c;
  --destructive-foreground: #ffffff;
  --border: #2e2926;
  --input: #3a3532;
  --ring: #2dd4bf;
  --positive: #4ade80;
  --negative: #f87171;
  --tag-discounted-bg: #052e16;
  --tag-discounted-fg: #86efac;
  --tag-discounted-border: #22c55e;
  --tag-premium-bg: #422006;
  --tag-premium-fg: #fde047;
  --tag-premium-border: #eab308;
  --tag-extra-premium-bg: #431407;
  --tag-extra-premium-fg: #fdba74;
  --tag-extra-premium-border: #f97316;
  --tag-unavailable-bg: #292524;
  --tag-unavailable-fg: #d6d3d1;
  --tag-unavailable-border: #a8a29e;
  --tag-caution-bg: #451a03;
  --tag-caution-fg: #fcd34d;
  --tag-caution-border: #f59e0b;
}

@theme inline {
  --font-sans:
    ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial,
    sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-positive: var(--positive);
  --color-negative: var(--negative);
  --color-tag-discounted-bg: var(--tag-discounted-bg);
  --color-tag-discounted-fg: var(--tag-discounted-fg);
  --color-tag-discounted-border: var(--tag-discounted-border);
  --color-tag-premium-bg: var(--tag-premium-bg);
  --color-tag-premium-fg: var(--tag-premium-fg);
  --color-tag-premium-border: var(--tag-premium-border);
  --color-tag-extra-premium-bg: var(--tag-extra-premium-bg);
  --color-tag-extra-premium-fg: var(--tag-extra-premium-fg);
  --color-tag-extra-premium-border: var(--tag-extra-premium-border);
  --color-tag-unavailable-bg: var(--tag-unavailable-bg);
  --color-tag-unavailable-fg: var(--tag-unavailable-fg);
  --color-tag-unavailable-border: var(--tag-unavailable-border);
  --color-tag-caution-bg: var(--tag-caution-bg);
  --color-tag-caution-fg: var(--tag-caution-fg);
  --color-tag-caution-border: var(--tag-caution-border);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background font-sans text-foreground antialiased;
  }
}

@layer utilities {
  .tabular {
    font-variant-numeric: tabular-nums;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 10: Run the token contrast test**

Run: `bun run test:web -- tokens.contrast`
Expected: 2 themes x 18 pairs = 36 tests pass.

- [ ] **Step 11: Write `lib/utils.ts`, `lib/query-client.ts`, `components.json`**

`apps/web/src/lib/utils.ts`:

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

`apps/web/src/lib/query-client.ts`:

```ts
import { QueryClient } from "@tanstack/react-query";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false },
    },
  });
}

export const queryClient = createQueryClient();
```

`apps/web/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- [ ] **Step 12: Generate the shadcn/ui primitives**

Run (from the repository root): `bunx shadcn@4.21.5 add button card badge table dialog tabs switch input label tooltip skeleton dropdown-menu sonner --cwd apps/web --yes`
Expected: creates `apps/web/src/components/ui/{button,card,badge,table,dialog,tabs,switch,input,label,tooltip,skeleton,dropdown-menu,sonner}.tsx`. The generated files import `cn` from `@/lib/utils` and `Slot`/primitives from the `radix-ui` package, both already installed. Afterwards:

1. `git diff apps/web/src/styles/index.css` (the file is untracked until the commit, so compare against Step 9): if the CLI appended or rewrote anything, restore the Step 9 content and re-run `bun run test:web -- tokens.contrast`.
2. If the CLI added `next-themes` (or any package) to `apps/web/package.json`, remove it and run `bun install`; the provider below does not use `next-themes`.
3. If `bunx shadcn` fails on Windows with an argument-passing error (spec 3.2 risk), run it through Node instead: `npx shadcn@4.21.5 add ...` with the same arguments, and record the workaround in Task 7's results file.

- [ ] **Step 13: Replace the generated `ui/sonner.tsx` so it uses our theme provider**

`apps/web/src/components/ui/sonner.tsx`:

```tsx
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/components/theme-provider";

export function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as CSSProperties
      }
      {...props}
    />
  );
}
```

- [ ] **Step 14: Write the theme provider and toggle**

`apps/web/src/components/theme-provider.tsx`:

```tsx
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  } catch {
    // storage can throw in private windows or with blocked site data
    return "system";
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // the choice still applies for this page view
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredTheme()),
  );

  useEffect(() => {
    const update = () => {
      const resolved = resolveTheme(theme);
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
    update();
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    writeStoredTheme(next);
    setThemeState(next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}
```

`apps/web/src/components/theme-toggle.tsx`:

```tsx
import { Monitor, Moon, Sun } from "lucide-react";
import { type Theme, useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const isTheme = (value: string): value is Theme =>
  value === "light" || value === "dark" || value === "system";

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const Icon = resolvedTheme === "dark" ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Theme: ${theme}`}>
          <Icon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (isTheme(value)) setTheme(value);
          }}
        >
          <DropdownMenuRadioItem value="light">
            <Sun aria-hidden="true" /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon aria-hidden="true" /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor aria-hidden="true" /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 15: Write the placeholder pages**

`apps/web/src/components/page-placeholder.tsx`:

```tsx
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PagePlaceholderProps {
  title: string;
  description: string;
  phase?: string;
}

export function PagePlaceholder({ title, description, phase }: PagePlaceholderProps) {
  useEffect(() => {
    document.title = `${title} - Stock Screener`;
  }, [title]);

  return (
    <section aria-labelledby="page-title" className="space-y-4">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="max-w-prose text-muted-foreground">{description}</p>
      {phase ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              Not built yet <Badge variant="outline">Planned in {phase}</Badge>
            </CardTitle>
            <CardDescription>This page is a placeholder from the P0 scaffold.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            The route, navigation and theme are wired; content arrives with its phase.
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
```

`apps/web/src/features/pages.tsx` (each page moves into its `features/<area>/` folder in its own phase):

```tsx
import { PagePlaceholder } from "@/components/page-placeholder";

export function OverviewPage() {
  return (
    <PagePlaceholder
      title="Overview"
      description="Today's discounted and premium securities, ranked, with the daily scan status."
      phase="P4"
    />
  );
}

export function QuotesPage() {
  return (
    <PagePlaceholder
      title="Quotes"
      description="Price chart with the standard-deviation channel for one security."
      phase="P4"
    />
  );
}

export function PortfolioPage() {
  return (
    <PagePlaceholder
      title="Portfolio"
      description="Positions, summary row and trade history from the linked broker account."
      phase="P5"
    />
  );
}

export function AnalyticsPage() {
  return (
    <PagePlaceholder
      title="Analytics"
      description="Portfolio analytics reconciled with the broker statements."
      phase="P5"
    />
  );
}

export function ProfileSecurityPage() {
  return (
    <PagePlaceholder
      title="Security"
      description="Password, sign-in methods and active sessions."
      phase="P5"
    />
  );
}

export function ProfileBrokerPage() {
  return (
    <PagePlaceholder
      title="Broker"
      description="Link or unlink the read-only IBKR Flex connection."
      phase="P5"
    />
  );
}

export function ProfileNotificationsPage() {
  return (
    <PagePlaceholder
      title="Notifications"
      description="Push and email digest preferences."
      phase="P3"
    />
  );
}

export function AboutPage() {
  return (
    <PagePlaceholder
      title="About"
      description="Data sources, the delayed-data notice, the AI disclaimer and chart attribution."
      phase="P4"
    />
  );
}

export function AuthPage() {
  return (
    <PagePlaceholder
      title="Authentication"
      description="Sign in, sign up, password reset and the OAuth callback."
      phase="P5"
    />
  );
}

export function NotFoundPage() {
  return (
    <PagePlaceholder
      title="Page not found"
      description="The page you asked for does not exist."
    />
  );
}
```

- [ ] **Step 16: Write the router, providers and entry point**

`apps/web/src/router.tsx`:

```tsx
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import {
  AboutPage,
  AnalyticsPage,
  AuthPage,
  NotFoundPage,
  OverviewPage,
  PortfolioPage,
  ProfileBrokerPage,
  ProfileNotificationsPage,
  ProfileSecurityPage,
  QuotesPage,
} from "@/features/pages";

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage });
const quotesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/quotes", component: QuotesPage });
const portfolioRoute = createRoute({ getParentRoute: () => rootRoute, path: "/portfolio", component: PortfolioPage });
const analyticsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/analytics", component: AnalyticsPage });
const aboutRoute = createRoute({ getParentRoute: () => rootRoute, path: "/about", component: AboutPage });
const authRoute = createRoute({ getParentRoute: () => rootRoute, path: "/auth/$", component: AuthPage });

// spec 14.1: /profile redirects to /profile/security
const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile",
  beforeLoad: () => {
    throw redirect({ to: "/profile/security" });
  },
});
const profileSecurityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/profile/security", component: ProfileSecurityPage });
const profileBrokerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/profile/broker", component: ProfileBrokerPage });
const profileNotificationsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/profile/notifications", component: ProfileNotificationsPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  quotesRoute,
  portfolioRoute,
  analyticsRoute,
  aboutRoute,
  authRoute,
  profileRoute,
  profileSecurityRoute,
  profileBrokerRoute,
  profileNotificationsRoute,
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    ...(history ? { history } : {}),
  });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

`apps/web/src/providers.tsx`:

```tsx
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient as defaultQueryClient } from "@/lib/query-client";

interface AppProvidersProps {
  children: ReactNode;
  queryClient?: QueryClient;
}

export function AppProviders({ children, queryClient = defaultQueryClient }: AppProvidersProps) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {children}
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
```

`apps/web/src/main.tsx`:

```tsx
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/providers";
import { router } from "@/router";
import "@/styles/index.css";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
```

- [ ] **Step 17: Write the app shell (responsive top nav, bottom nav on mobile)**

(Skills required; refine the visual design inside the constraints at the top of the task.)

`apps/web/src/components/app-shell.tsx`:

```tsx
import { Link, Outlet } from "@tanstack/react-router";
import { Briefcase, ChartColumn, ChartLine, LayoutDashboard, type LucideIcon, User } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

interface NavItem {
  to: "/" | "/quotes" | "/portfolio" | "/analytics";
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/quotes", label: "Quotes", icon: ChartLine },
  { to: "/portfolio", label: "Portfolio", icon: Briefcase },
  { to: "/analytics", label: "Analytics", icon: ChartColumn },
];

const focusRing =
  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring";

const topLink = `inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:text-accent-foreground ${focusRing}`;

const bottomLink = `flex min-h-14 flex-col items-center justify-center gap-1 px-2 text-xs font-medium text-muted-foreground data-[status=active]:text-primary ${focusRing}`;

export function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-4 px-4">
          <Link to="/" className={`rounded-md text-base font-semibold tracking-tight ${focusRing}`}>
            Stock Screener
          </Link>
          <nav aria-label="Primary" className="hidden flex-1 items-center gap-1 md:flex">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} className={topLink} activeOptions={{ exact: to === "/" }}>
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Link to="/profile" className={topLink}>
              <User className="size-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Profile</span>
            </Link>
          </div>
        </div>
      </header>

      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 outline-none"
      >
        <Outlet />
      </main>

      <footer className="border-t py-4 pb-[calc(5rem+env(safe-area-inset-bottom))] text-xs text-muted-foreground md:pb-4">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4">
          <span>Data may be delayed. Not investment advice.</span>
          <Link to="/about" className={`rounded-sm underline underline-offset-4 ${focusRing}`}>
            About
          </Link>
        </div>
      </footer>

      <nav
        aria-label="Mobile"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <div className="grid grid-cols-4">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} className={bottomLink} activeOptions={{ exact: to === "/" }}>
              <Icon className="size-5" aria-hidden="true" />
              {label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
```

- [ ] **Step 18: Format and run the full web test project**

Run: `bun run lint:fix`
Expected: reformats the long `createRoute` lines and sorts imports; exit 0 (generated `ui/` files are ignored by Biome).

Run: `bun run test:web`
Expected: all web tests pass (theme-init 4, theme-provider 4, tokens 36, core-alias 1, app-shell 11 + 2 = 13); exit 0. If a test fails because `matchMedia` is missing in happy-dom, the stubs in the tests already cover it; do not add a global polyfill.

- [ ] **Step 19: Typecheck, lint, build**

Run: `bun run typecheck`
Expected: exit 0 (web, core, root/tools projects and the purity check). If `tsc` reports errors inside `src/components/ui/*` (generated code under `exactOptionalPropertyTypes` or `noUncheckedIndexedAccess`), fix them with the smallest local edit in that file and do NOT weaken the base flags. If it reports DOM/WebWorker lib conflicts, note them: Task 4 handles `sw.ts` (the only WebWorker consumer) and Task 4 Step 12 gives the fallback tsconfig.

Run: `bun run lint`
Expected: exit 0.

Run: `bun run build`
Expected: Bun runs `bun run --filter @screener/web build`; Vite 8 prints `dist/index.html`, `dist/assets/index-*.js`, `dist/assets/index-*.css`, `dist/theme-init.js`, `dist/robots.txt`; exit 0. A Vite notice that `/theme-init.js` "can't be bundled without type=module" is expected and harmless. This also proves `bun run --filter` works on Windows (spec P0-01); if it does not, record the failure and fall back to `bun --cwd apps/web run build` in the root scripts.

- [ ] **Step 20: Verify the dev server**

Start `bun run dev` in a background terminal; wait for `Local:   http://localhost:5173/`.

Run: `curl.exe -s -o NUL -w "%{http_code}" http://localhost:5173/quotes`
Expected: `200` (Vite serves `index.html` for SPA routes).

Open `http://localhost:5173/` in a browser: the shell, nav and theme toggle render; switching the theme persists after reload with no flash. Stop the dev server.

- [ ] **Step 21: Commit**

```text
git add apps/web package.json bun.lock vitest.config.ts
git commit -m "feat(web): scaffold Vite 8 React 19 app with router, tokens, shadcn/ui and app shell"
```


### Task 4: PWA, Cloudflare config, bundle secret scan and end-to-end smoke

**Files:**
- Create: `apps/web/src/sw-routes.ts`, `apps/web/src/sw-routes.test.ts`, `apps/web/src/sw.ts`, `apps/web/src/register-sw.ts`, `apps/web/src/pwa-assets.test.ts`
- Create: `apps/web/public/manifest.webmanifest`, `public/icon.svg`, `public/icon-maskable.svg`, `public/_headers`, generated `public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`
- Create: `apps/web/wrangler.jsonc`, `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`
- Create: `tools/gen-icons.ts`, `tools/lib/secret-scan.ts`, `tools/lib/secret-scan.test.ts`, `tools/check-bundle-secrets.ts`
- Modify: `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/tsconfig.json`, `apps/web/package.json`, `package.json` (root devDependencies), `tsconfig.json` (root include)

**Interfaces:**
- Consumes: Task 3 shell, tokens (`#0f766e` primary, `#fafaf9` light background, `#0c0a09` dark background), `createAppRouter`, `AppProviders`; `Toaster`/`toast` from `sonner`; Task 2 tools Vitest project.
- Produces: `NAVIGATION_DENYLIST`, `isNeverCached(url, headers, selfOrigin)`, `parsePushPayload(raw)`, `resolveNotificationUrl(raw, origin)` from `apps/web/src/sw-routes.ts` (the only place the cache rules live); `registerServiceWorker()`; build output `dist/sw.js`, `dist/manifest.webmanifest`, `dist/_headers`; `scanText(text): SecretFinding[]` from `tools/lib/secret-scan.ts`; root script `check:bundle`; `bun run test:e2e`; `apps/web/wrangler.jsonc` consumed by `deploy-web.yml` (Task 6).

- [ ] **Step 1: Add dependencies and install**

`apps/web/package.json` `devDependencies` becomes:

```json
"devDependencies": {
  "@playwright/test": "^1.64.1",
  "@tailwindcss/vite": "^4.3.3",
  "@testing-library/dom": "^10.4.2",
  "@testing-library/react": "^16.3.3",
  "@types/react": "^19.3.0",
  "@types/react-dom": "^19.3.0",
  "@vitejs/plugin-react": "^6.1.2",
  "happy-dom": "^21.0.1",
  "tailwindcss": "^4.3.3",
  "vite": "^8.3.4",
  "vite-plugin-pwa": "^2.0.0",
  "workbox-build": "^7.4.1",
  "workbox-core": "^7.4.1",
  "workbox-precaching": "^7.4.1",
  "workbox-routing": "^7.4.1",
  "workbox-strategies": "^7.4.1",
  "workbox-window": "^7.4.1"
}
```

Root `package.json` `devDependencies` gains `"@resvg/resvg-js": "^2.6.2"` (icon generation; it ships prebuilt binaries for win32-x64 and linux as optional dependencies, no postinstall script).

Run: `bun install`
Expected: exits 0. `vite-plugin-pwa` 2.0.0 requires `workbox-build` and `workbox-window` ^7.4.1 as peers, hence the explicit entries.

- [ ] **Step 2: Write the failing service-worker rule tests (TDD)**

`apps/web/src/sw-routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isNavigationFallbackAllowed,
  isNeverCached,
  parsePushPayload,
  resolveNotificationUrl,
} from "./sw-routes";

const ORIGIN = "https://screener.example.com";
const never = (url: string, headers: Record<string, string> = {}) =>
  isNeverCached(new URL(url), new Headers(headers), ORIGIN);

describe("isNeverCached", () => {
  it("never caches Supabase hosts", () => {
    expect(never("https://abcd1234.supabase.co/rest/v1/profiles")).toBe(true);
    expect(never("https://abcd1234.supabase.co/auth/v1/token?grant_type=password")).toBe(true);
    expect(never("https://abcd1234.supabase.co/functions/v1/health")).toBe(true);
    expect(never("https://supabase.co/")).toBe(true);
  });

  it("does not treat look-alike hosts as Supabase", () => {
    expect(never("https://evilsupabase.co/x.js")).toBe(false);
    expect(never("https://supabase.co.evil.example/x.js")).toBe(false);
  });

  it("never caches same-origin /rest, /auth and /functions paths", () => {
    expect(never(`${ORIGIN}/rest/v1/x`)).toBe(true);
    expect(never(`${ORIGIN}/auth/callback?code=abc`)).toBe(true);
    expect(never(`${ORIGIN}/functions/v1/quotes`)).toBe(true);
    expect(never(`${ORIGIN}/auth`)).toBe(true);
  });

  it("never caches requests carrying credentials headers", () => {
    expect(never("https://api.example.com/x", { Authorization: "Bearer t" })).toBe(true);
    expect(never("https://api.example.com/x", { apikey: "k" })).toBe(true);
  });

  it("leaves static assets to the precache", () => {
    expect(never(`${ORIGIN}/assets/index-abc.js`)).toBe(false);
    expect(never(`${ORIGIN}/authors`)).toBe(false);
    expect(never(`${ORIGIN}/quotes`)).toBe(false);
  });

  it("does not apply the path rule to other origins", () => {
    expect(never("https://cdn.example.com/auth/logo.png")).toBe(false);
  });
});

describe("isNavigationFallbackAllowed", () => {
  it("serves the SPA shell for application routes", () => {
    for (const path of ["/", "/quotes", "/portfolio", "/profile/security", "/about"]) {
      expect(isNavigationFallbackAllowed(new URL(path, ORIGIN))).toBe(true);
    }
  });

  it("does not swallow auth callbacks or function and REST paths", () => {
    for (const path of ["/auth/callback", "/auth/reset", "/functions/v1/x", "/rest/v1/x"]) {
      expect(isNavigationFallbackAllowed(new URL(path, ORIGIN))).toBe(false);
    }
  });
});

describe("parsePushPayload", () => {
  it("reads title, body and url from JSON", () => {
    expect(parsePushPayload('{"title":"Alert","body":"AAPL discounted","url":"/quotes?symbol=AAPL"}')).toEqual({
      title: "Alert",
      body: "AAPL discounted",
      url: "/quotes?symbol=AAPL",
    });
  });

  it("always yields something to show (iOS requires a notification per push)", () => {
    const fallback = { title: "Stock Screener", body: "There is something new.", url: "/" };
    expect(parsePushPayload("")).toEqual(fallback);
    expect(parsePushPayload("   ")).toEqual(fallback);
    expect(parsePushPayload("{}")).toEqual(fallback);
    expect(parsePushPayload('{"title":42,"body":null}')).toEqual(fallback);
  });

  it("treats non-JSON text as the body", () => {
    expect(parsePushPayload("plain text")).toEqual({
      title: "Stock Screener",
      body: "plain text",
      url: "/",
    });
  });

  it("clips oversized fields", () => {
    const payload = parsePushPayload(JSON.stringify({ title: "t".repeat(500), body: "b".repeat(900) }));
    expect(payload.title.length).toBe(100);
    expect(payload.body.length).toBe(300);
  });
});

describe("resolveNotificationUrl", () => {
  it("keeps same-origin paths, queries and hashes", () => {
    expect(resolveNotificationUrl("/quotes?symbol=AAPL#chart", ORIGIN)).toBe("/quotes?symbol=AAPL#chart");
    expect(resolveNotificationUrl(`${ORIGIN}/portfolio`, ORIGIN)).toBe("/portfolio");
    expect(resolveNotificationUrl("portfolio", ORIGIN)).toBe("/portfolio");
  });

  it("refuses off-origin and non-http targets", () => {
    expect(resolveNotificationUrl("https://evil.example/x", ORIGIN)).toBe("/");
    expect(resolveNotificationUrl("//evil.example/x", ORIGIN)).toBe("/");
    expect(resolveNotificationUrl("javascript:alert(1)", ORIGIN)).toBe("/");
  });

  it("falls back to the home page for missing or invalid input", () => {
    expect(resolveNotificationUrl(undefined, ORIGIN)).toBe("/");
    expect(resolveNotificationUrl(42, ORIGIN)).toBe("/");
    expect(resolveNotificationUrl("", ORIGIN)).toBe("/");
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `bun run test:web -- sw-routes`
Expected: FAIL, `Failed to resolve import "./sw-routes"`.

- [ ] **Step 4: Implement `apps/web/src/sw-routes.ts`**

```ts
/**
 * Pure rules shared by the service worker (sw.ts) and its tests. Keeping them free of service
 * worker globals is what makes the cache and notification policy testable (spec 14.8).
 */

// Same-origin paths that must never be answered from a cache or by the SPA navigation fallback:
// the OAuth callback (/auth/*), Edge Function and PostgREST proxies.
export const BYPASS_PATH = /^\/(auth|rest|functions)(\/|$)/;
export const NAVIGATION_DENYLIST: RegExp[] = [BYPASS_PATH];

function isSupabaseHost(hostname: string): boolean {
  return hostname === "supabase.co" || hostname.endsWith(".supabase.co");
}

/** True for requests that must go to the network and never be stored. */
export function isNeverCached(url: URL, headers: Headers, selfOrigin: string): boolean {
  if (isSupabaseHost(url.hostname)) return true;
  if (url.origin === selfOrigin && BYPASS_PATH.test(url.pathname)) return true;
  return headers.has("authorization") || headers.has("apikey");
}

export function isNavigationFallbackAllowed(url: URL): boolean {
  return !NAVIGATION_DENYLIST.some((pattern) => pattern.test(url.pathname));
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

const DEFAULT_TITLE = "Stock Screener";
const DEFAULT_BODY = "There is something new.";

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : clip(trimmed, max);
}

/** Never throws and always returns something displayable: iOS punishes silent pushes. */
export function parsePushPayload(raw: string): PushPayload {
  const fallback: PushPayload = { title: DEFAULT_TITLE, body: DEFAULT_BODY, url: "/" };
  const text = raw.trim();
  if (text === "") return fallback;
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      return {
        title: cleanString(record.title, 100) ?? fallback.title,
        body: cleanString(record.body, 300) ?? fallback.body,
        url: cleanString(record.url, 500) ?? fallback.url,
      };
    }
  } catch {
    // not JSON: show the text itself
  }
  return { ...fallback, body: clip(text, 300) };
}

/** Same-origin path (+ query + hash) or "/" : a push payload must not open another site. */
export function resolveNotificationUrl(raw: unknown, origin: string): string {
  if (typeof raw !== "string" || raw.trim() === "") return "/";
  try {
    const target = new URL(raw, origin);
    if (target.origin !== origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}
```

- [ ] **Step 5: Run to confirm pass**

Run: `bun run test:web -- sw-routes`
Expected: all `sw-routes` tests pass (about 15), exit 0.

- [ ] **Step 6: Write the service worker, its registration and the Vite config**

`apps/web/src/sw.ts`:

```ts
/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";
import {
  isNeverCached,
  NAVIGATION_DENYLIST,
  parsePushPayload,
  resolveNotificationUrl,
} from "./sw-routes";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

// 1. Precache only the static build output.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

// 2. Never cache API, auth or function responses (see sw-routes.ts for the rules and tests).
registerRoute(
  ({ url, request }) => isNeverCached(url, request.headers, self.location.origin),
  new NetworkOnly(),
);

// 3. SPA navigation fallback, except for auth callbacks and function/REST paths.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: NAVIGATION_DENYLIST }),
);

// 4. "Update available" toast posts SKIP_WAITING (registerType: "prompt").
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

// 5. Push: ALWAYS show a notification (iOS revokes subscriptions that stay silent).
self.addEventListener("push", (event) => {
  let text = "";
  try {
    text = event.data?.text() ?? "";
  } catch {
    // unreadable payload: parsePushPayload falls back to the default notification
  }
  const payload = parsePushPayload(text);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url },
    }),
  );
});

// 6. Click: focus an open window and navigate it, otherwise open one (same-origin targets only).
async function focusOrOpen(target: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows[0];
  if (existing) {
    await existing.focus();
    await existing.navigate(target);
    return;
  }
  await self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  event.waitUntil(focusOrOpen(resolveNotificationUrl(data?.url, self.location.origin)));
});
```

`apps/web/src/register-sw.ts`:

```ts
import { toast } from "sonner";
import { registerSW } from "virtual:pwa-register";

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      toast("Update available", {
        description: "A new version is ready.",
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "Reload",
          onClick: () => {
            void updateSW(true);
          },
        },
      });
    },
  });
}
```

`apps/web/src/main.tsx` (adds the registration call):

```tsx
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "@/register-sw";
import { AppProviders } from "@/providers";
import { router } from "@/router";
import "@/styles/index.css";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);

registerServiceWorker();
```

`apps/web/vite.config.ts` (full file; adds `VitePWA`):

```ts
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false,
      // the manifest is a static file in public/ (tested in pwa-assets.test.ts)
      manifest: false,
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      "@core": fromHere("../../supabase/functions/_shared/core"),
      "@": fromHere("./src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [fromHere("../../")] },
  },
  preview: { port: 4173, strictPort: true },
  build: { target: "es2022", sourcemap: false },
});
```

`apps/web/tsconfig.json` (adds the PWA client types):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable", "WebWorker"],
    "jsx": "react-jsx",
    "types": ["vite/client", "node", "vite-plugin-pwa/client"],
    "paths": {
      "@/*": ["./src/*"],
      "@core/*": ["../../supabase/functions/_shared/core/*"]
    }
  },
  "include": ["src", "e2e", "vite.config.ts", "../../supabase/functions/_shared/core"]
}
```

Root `tsconfig.json` (adds the Playwright config, which uses `process`):

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": ["node"] },
  "include": ["tools", "vitest.config.ts", "apps/web/playwright.config.ts"]
}
```

- [ ] **Step 7: Write the icon sources, manifest, headers, wrangler config, `index.html`**

`apps/web/public/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Stock Screener">
  <rect width="512" height="512" rx="112" fill="#0f766e" />
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M96 404 L416 180" stroke="#99f6e4" stroke-width="12" opacity="0.7" />
    <path d="M96 316 L416 92" stroke="#99f6e4" stroke-width="12" opacity="0.7" />
    <path d="M96 360 L416 136" stroke="#99f6e4" stroke-width="8" stroke-dasharray="6 22" opacity="0.7" />
    <polyline points="96,372 168,334 232,364 304,258 360,282 416,148" stroke="#ffffff" stroke-width="22" />
  </g>
  <circle cx="416" cy="148" r="26" fill="#ffffff" />
</svg>
```

`apps/web/public/icon-maskable.svg` (full bleed, content inside the 80% safe zone):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Stock Screener">
  <rect width="512" height="512" fill="#0f766e" />
  <g transform="translate(76.8 76.8) scale(0.7)">
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M96 404 L416 180" stroke="#99f6e4" stroke-width="12" opacity="0.7" />
      <path d="M96 316 L416 92" stroke="#99f6e4" stroke-width="12" opacity="0.7" />
      <path d="M96 360 L416 136" stroke="#99f6e4" stroke-width="8" stroke-dasharray="6 22" opacity="0.7" />
      <polyline points="96,372 168,334 232,364 304,258 360,282 416,148" stroke="#ffffff" stroke-width="22" />
    </g>
    <circle cx="416" cy="148" r="26" fill="#ffffff" />
  </g>
</svg>
```

`apps/web/public/manifest.webmanifest`:

```json
{
  "id": "/",
  "name": "Stock Screener",
  "short_name": "Screener",
  "description": "Private stock screener: discounted and premium securities, ranked daily.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "theme_color": "#0f766e",
  "background_color": "#fafaf9",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`apps/web/public/_headers`:

```text
# Cloudflare Workers Static Assets headers. They apply to static assets only (there is no Worker script).
# The CSP is report-only until P4 completes the real Supabase project URL and the chart assets.
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: DENY
  Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.supabase.co; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/sw.js
  Cache-Control: no-cache
  Service-Worker-Allowed: /
/manifest.webmanifest
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/theme-init.js
  Cache-Control: no-cache
```

`apps/web/wrangler.jsonc`:

```jsonc
{
  "name": "stock-screener",
  "compatibility_date": "2026-10-15",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application",
    "html_handling": "auto-trailing-slash"
  }
}
```

`apps/web/index.html` (adds manifest and icons):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fafaf9" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0c0a09" />
    <meta
      name="description"
      content="Private stock screener: discounted and premium securities, ranked daily."
    />
    <title>Stock Screener</title>
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <!-- same-origin, synchronous: applies the stored theme before first paint (CSP forbids inline script) -->
    <script src="/theme-init.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Write and run the icon generator (works on Windows through prebuilt resvg binaries)**

`tools/gen-icons.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const publicFile = (name: string) =>
  fileURLToPath(new URL(`../apps/web/public/${name}`, import.meta.url));

const TARGETS = [
  { source: "icon.svg", output: "icon-192.png", size: 192 },
  { source: "icon.svg", output: "icon-512.png", size: 512 },
  { source: "icon-maskable.svg", output: "icon-maskable-512.png", size: 512 },
  // iOS applies its own rounding: use the opaque full-bleed artwork
  { source: "icon-maskable.svg", output: "apple-touch-icon.png", size: 180 },
];

for (const { source, output, size } of TARGETS) {
  const svg = readFileSync(publicFile(source), "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(publicFile(output), png);
  console.log(`wrote ${output} (${size}x${size}, ${png.length} bytes)`);
}
```

Run: `bun run gen:icons`
Expected: four `wrote ...` lines; the PNGs exist in `apps/web/public/`. They are committed (the build does not depend on this script). If `@resvg/resvg-js` fails to load its native binary on the dev machine, record it and generate the PNGs with any SVG-to-PNG tool at the same sizes; the test in Step 10 validates the result either way.

- [ ] **Step 9: Write the PWA asset tests**

`apps/web/src/pwa-assets.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicUrl = (name: string) => new URL(`../public/${name}`, import.meta.url);
const readText = (name: string) => readFileSync(publicUrl(name), "utf8");

function pngSize(name: string): { width: number; height: number } {
  const buffer = readFileSync(publicUrl(name));
  expect(buffer.subarray(1, 4).toString("ascii"), `${name} is not a PNG`).toBe("PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

const manifest = JSON.parse(readText("manifest.webmanifest")) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
};

describe("web app manifest", () => {
  it("meets the installability checklist (spec 14.8)", () => {
    expect(manifest.name).toBe("Stock Screener");
    expect(manifest.short_name).toBe("Screener");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone"); // required for iOS Web Push
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("declares 192 and 512 icons plus a maskable icon whose files have the declared size", () => {
    const purposes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
    expect(purposes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
    for (const icon of manifest.icons) {
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(pngSize(icon.src.replace(/^\//, ""))).toEqual({ width, height });
    }
  });

  it("ships a 180x180 apple-touch-icon referenced from index.html", () => {
    expect(pngSize("apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="theme-color"');
  });
});

function parseHeaders(text: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }
    const colon = line.indexOf(":");
    if (current && colon > 0) {
      current.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  return rules;
}

describe("_headers", () => {
  const rules = parseHeaders(readText("_headers"));

  it("serves the service worker and manifest uncached from the site root", () => {
    expect(rules.get("/sw.js")?.get("cache-control")).toBe("no-cache");
    expect(rules.get("/sw.js")?.get("service-worker-allowed")).toBe("/");
    expect(rules.get("/manifest.webmanifest")?.get("cache-control")).toBe("no-cache");
    expect(rules.get("/index.html")?.get("cache-control")).toBe("no-cache");
  });

  it("sets basic security headers and a report-only CSP", () => {
    const all = rules.get("/*");
    expect(all?.get("x-content-type-options")).toBe("nosniff");
    expect(all?.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(all?.get("permissions-policy")).toContain("camera=()");
    expect(all?.has("content-security-policy-report-only")).toBe(true);
    expect(all?.has("content-security-policy")).toBe(false);
  });
});

describe("wrangler.jsonc", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
    name: string;
    compatibility_date: string;
    assets: { directory: string; not_found_handling: string; html_handling: string };
  };

  it("serves ./dist as a single-page application without a Worker script", () => {
    expect(config.assets).toEqual({
      directory: "./dist",
      not_found_handling: "single-page-application",
      html_handling: "auto-trailing-slash",
    });
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(existsSync(new URL("../wrangler.jsonc", import.meta.url))).toBe(true);
    expect("main" in config).toBe(false);
  });
});
```

- [ ] **Step 10: Run the web tests, typecheck and build**

Run: `bun run lint:fix` then `bun run test:web`
Expected: all web tests pass including `pwa-assets` (6) and `sw-routes` (15).

Run: `bun run typecheck`
Expected: exit 0. If `tsc` reports conflicts between the DOM and WebWorker libs in `src/sw.ts` (spec 3.6 lists both libs; the conflicts normally stay inside `.d.ts` files that `skipLibCheck` ignores), apply the fallback: remove `"WebWorker"` from `apps/web/tsconfig.json` `lib`, add `"exclude": ["src/sw.ts"]`, create `apps/web/tsconfig.sw.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "WebWorker"], "types": [] },
  "include": ["src/sw.ts", "src/sw-routes.ts"]
}
```

and append `&& tsc -p apps/web/tsconfig.sw.json --noEmit` to the root `typecheck` script. Record which variant was needed in Task 7's results file.

Run: `bun run build`
Expected: exit 0; Vite prints the client build and then vite-plugin-pwa prints `injectManifest` output with `precache N entries`. Then confirm the artefacts (PowerShell):

```text
Get-ChildItem apps/web/dist | Select-Object Name
```

Expected names include `sw.js`, `manifest.webmanifest`, `_headers`, `index.html`, `theme-init.js`, `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `assets`.

- [ ] **Step 11: Write the failing secret-scan tests (TDD)**

`tools/lib/secret-scan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scanText } from "./secret-scan.ts";

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2lnbmF0dXJl`;

describe("scanText", () => {
  it("passes clean bundle text", () => {
    expect(scanText('const a = "hello"; fetch("/x");')).toEqual([]);
  });

  it("allows the public anon key (a JWT with role anon)", () => {
    const anon = jwt({ iss: "supabase", role: "anon", exp: 4102444800 });
    expect(scanText(`createClient("https://x.supabase.co","${anon}")`)).toEqual([]);
  });

  it("flags a service-role JWT", () => {
    const leaked = jwt({ iss: "supabase", role: "service_role", exp: 4102444800 });
    const findings = scanText(`const key="${leaked}"`);
    expect(findings.map((f) => f.rule)).toEqual(["service-role-jwt"]);
  });

  it("flags new-style secret API keys", () => {
    expect(scanText('k="sb_secret_abcdEFGH12345678"').map((f) => f.rule)).toEqual(["secret-api-key"]);
    expect(scanText('k="sb_publishable_abcdEFGH12345678"')).toEqual([]);
  });

  it("flags server-only variable names that must never be bundled", () => {
    for (const name of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "CRON_SHARED_SECRET",
      "FLEX_ENC_KEY_V1",
      "VAPID_PRIVATE_KEY",
      "RESEND_API_KEY",
    ]) {
      expect(scanText(`x = import.meta.env.${name}`).map((f) => f.detail)).toContain(name);
    }
  });

  it("does not flag the public VAPID key variable", () => {
    expect(scanText("import.meta.env.VITE_VAPID_PUBLIC_KEY")).toEqual([]);
  });
});
```

- [ ] **Step 12: Run to confirm failure, implement, run to confirm pass**

Run: `bun run test:tools`
Expected: FAIL, `Failed to resolve import "./secret-scan.ts"`.

`tools/lib/secret-scan.ts`:

```ts
export interface SecretFinding {
  rule: string;
  detail: string;
}

// Server-only configuration names (spec 3.11). None of them may appear in a browser bundle.
const FORBIDDEN_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SHARED_SECRET",
  "FLEX_ENC",
  "VAPID_PRIVATE",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "UNSUBSCRIBE_SIGNING_KEY",
  "GEMINI_API_KEY",
  "TAVILY_API_KEY",
  "JINA_API_KEY",
  "LLM_ALT_API_KEY",
];

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}\.(eyJ[A-Za-z0-9_-]{4,})\.[A-Za-z0-9_-]{4,}/g;
const SECRET_KEY_PATTERN = /sb_secret_[A-Za-z0-9_-]{8,}/;

function roleOf(payloadSegment: string): string | null {
  try {
    const payload: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    if (typeof payload === "object" && payload !== null && "role" in payload) {
      const role = (payload as { role: unknown }).role;
      return typeof role === "string" ? role : null;
    }
  } catch {
    // not a JWT payload
  }
  return null;
}

export function scanText(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const name of FORBIDDEN_NAMES) {
    if (text.includes(name)) findings.push({ rule: "forbidden-name", detail: name });
  }
  for (const match of text.matchAll(JWT_PATTERN)) {
    if (roleOf(match[1] ?? "") === "service_role") {
      findings.push({ rule: "service-role-jwt", detail: `${match[0].slice(0, 12)}...` });
    }
  }
  if (SECRET_KEY_PATTERN.test(text)) {
    findings.push({ rule: "secret-api-key", detail: "sb_secret_..." });
  }
  return findings;
}
```

Run: `bun run test:tools`
Expected: all `secret-scan` tests pass, together with the 8 purity tests; exit 0.

- [ ] **Step 13: Write `tools/check-bundle-secrets.ts` and prove it bites**

```ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "./lib/secret-scan.ts";

const distDir = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".html",
  ".map",
  ".json",
  ".webmanifest",
  ".txt",
  ".svg",
]);

if (!existsSync(distDir)) {
  console.error("bundle secret scan: apps/web/dist not found; run `bun run build` first");
  process.exit(1);
}

let scanned = 0;
let failed = false;
for (const file of readdirSync(distDir, { recursive: true, encoding: "utf8" })) {
  const full = join(distDir, file);
  if (!TEXT_EXTENSIONS.has(extname(file)) || !statSync(full).isFile()) continue;
  scanned += 1;
  for (const finding of scanText(readFileSync(full, "utf8"))) {
    failed = true;
    console.error(`bundle secret scan: ${file}: ${finding.rule} (${finding.detail})`);
  }
}

if (failed) process.exit(1);
console.log(`bundle secret scan: OK (${scanned} files)`);
```

Run: `bun run check:bundle`
Expected: `bundle secret scan: OK (N files)`.

Prove it bites: create `apps/web/dist/__leak__.js` containing `SUPABASE_SERVICE_ROLE_KEY`, run `bun run check:bundle` (expected exit 1 with `forbidden-name (SUPABASE_SERVICE_ROLE_KEY)`), delete the file, re-run (expected OK).

- [ ] **Step 14: Write the Playwright config and the smoke test**

`apps/web/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // serves the production build (root script test:e2e builds first)
  webServer: {
    command: "bun run preview",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
```

`apps/web/e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("home page renders the shell and the primary navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Stock Screener/);
  const nav = page.getByRole("navigation", { name: "Primary" });
  for (const label of ["Overview", "Quotes", "Portfolio", "Analytics"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
});

test("a deep link falls back to the SPA shell", async ({ page }) => {
  await page.goto("/quotes");
  await expect(page.getByRole("heading", { level: 1, name: "Quotes" })).toBeVisible();
});

test("manifest and service worker are served from the site root", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).name).toBe("Stock Screener");
  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(sw.headers()["content-type"]).toContain("javascript");
});

test("the service worker registers with scope /", async ({ page }) => {
  await page.goto("/");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe("/");
});

test("the theme choice persists after a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Theme/ }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});
```

- [ ] **Step 15: Install the Playwright browser and run the end-to-end test**

Run: `bunx playwright install chromium`
Expected: downloads Chromium. If `bunx` mishandles arguments on Windows (spec 3.2 risk), run `node node_modules/@playwright/test/cli.js install chromium` instead and record the workaround.

Run: `bun run test:e2e`
Expected: Bun runs `bun run build`, then `bun run --filter @screener/web e2e`; Playwright starts `bun run preview` on port 4173 and reports `5 passed`. The Playwright process exits and the preview server stops.

- [ ] **Step 16: Optional configuration dry run for Cloudflare, then lint and commit**

From `apps/web`: `bunx wrangler@4.151.0 deploy --dry-run`
Expected: wrangler parses `wrangler.jsonc`, reports the asset upload (`Total Upload` / `--dry-run: exiting now.`) and exits 0. If it asks for a login or account, skip this step (the config is also asserted by `pwa-assets.test.ts`); the real deploy runs in Task 6's workflow.

Run: `bun run lint:fix` then `bun run lint`, `bun run typecheck`, `bun run test:tools`, `bun run test:web`
Expected: all exit 0.

```text
git add apps/web tools package.json bun.lock tsconfig.json
git commit -m "feat(web): add PWA service worker, manifest, Cloudflare config, bundle secret scan and e2e smoke"
```


### Task 5: Supabase local project, shared adapters, `health` function and function guards

**Files:**
- Create: `supabase/functions/deno.json`, `supabase/functions/.env.example`
- Create: `supabase/functions/_shared/adapters/env.ts`, `env.test.ts`, `http.ts`, `http.test.ts`
- Create: `supabase/functions/health/handler.ts`, `handler.test.ts`, `index.ts`, `deno.json`
- Create (placeholders via scaffolder): `supabase/functions/{worker-tick,scan-control,retention-cleanup}/index.ts` and `deno.json`
- Create: `supabase/config.toml` (from `supabase init`, then edited), `supabase/migrations/20261015000100_extensions.sql`, `supabase/seed.sql`, `supabase/tests/0001_smoke.test.sql`
- Create: `tools/lib/functions-config.ts`, `tools/lib/functions-config.test.ts`, `tools/check-functions-config.ts`, `tools/new-function.ts`, `tools/functions-check-selftest.ts`

**Interfaces:**
- Consumes: `CORE_VERSION` from `supabase/functions/_shared/core/mod.ts` (Task 2); root scripts `functions:check`, `functions:test`, `functions:selftest`, `check:functions-config`, `supabase:*`, `test:db`; Docker Desktop.
- Produces: `json(data, init?)`, `corsHeaders(origin, allowedOrigins?)`, `allowedOriginsFromEnv()`, `timingSafeEqualStrings(a, b)`, `requireCronSecret(req, secret): Promise<Response | null>`, `readJson(req, maxBytes?)` from `@adapters/http.ts`; `requireEnv(name)` from `@adapters/env.ts`; `handleHealth(req)`; the canonical import map `FUNCTION_IMPORTS` and `functionDenoJson()` from `tools/lib/functions-config.ts` (used by Task 6 `deploy-supabase.yml` via `check:functions-config`); local function endpoint `http://127.0.0.1:54321/functions/v1/health`; schema `app` and extensions `pg_cron`, `pg_net`, `pgcrypto`, `pgtap` for all later migrations.

- [ ] **Step 1: Write `supabase/functions/deno.json`**

The root config is used by `deno check`/`deno test` (always with `--config supabase/functions/deno.json`) and, for files inside a function folder, mirrors that function's own `deno.json`. Prefixes are relative to this file; the per-function copies use `../`.

```json
{
  "imports": {
    "@core/": "./_shared/core/",
    "@adapters/": "./_shared/adapters/",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.117.3",
    "@std/assert": "jsr:@std/assert@1.0.19"
  },
  "nodeModulesDir": "none",
  "lock": false
}
```

- [ ] **Step 2: Write the failing adapter tests (TDD)**

`supabase/functions/_shared/adapters/env.test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { requireEnv } from "./env.ts";

Deno.test("requireEnv returns a set variable", () => {
  Deno.env.set("P0_TEST_ENV", "value");
  try {
    assertEquals(requireEnv("P0_TEST_ENV"), "value");
  } finally {
    Deno.env.delete("P0_TEST_ENV");
  }
});

Deno.test("requireEnv throws for missing and blank variables", () => {
  Deno.env.delete("P0_TEST_MISSING");
  assertThrows(() => requireEnv("P0_TEST_MISSING"), Error, "P0_TEST_MISSING");
  Deno.env.set("P0_TEST_BLANK", "   ");
  try {
    assertThrows(() => requireEnv("P0_TEST_BLANK"), Error, "P0_TEST_BLANK");
  } finally {
    Deno.env.delete("P0_TEST_BLANK");
  }
});
```

`supabase/functions/_shared/adapters/http.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { corsHeaders, json, readJson, requireCronSecret } from "./http.ts";

Deno.test("json sets content type, no-store and status", async () => {
  const response = json({ ok: true }, { status: 201 });
  assertEquals(response.status, 201);
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(await response.json(), { ok: true });
});

Deno.test("json keeps caller supplied headers", () => {
  const response = json({}, { headers: { "cache-control": "max-age=60", "x-extra": "1" } });
  assertEquals(response.headers.get("cache-control"), "max-age=60");
  assertEquals(response.headers.get("x-extra"), "1");
});

Deno.test("corsHeaders allows only listed origins", () => {
  const allowed = ["https://screener.example.com"];
  assertEquals(
    corsHeaders("https://screener.example.com", allowed)["access-control-allow-origin"],
    "https://screener.example.com",
  );
  assertEquals(corsHeaders("https://evil.example", allowed)["access-control-allow-origin"], undefined);
  assertEquals(corsHeaders(null, allowed)["access-control-allow-origin"], undefined);
  assertEquals(corsHeaders("https://evil.example", allowed).vary, "Origin");
});

const cronRequest = (secret?: string) =>
  new Request("http://localhost/fn", {
    headers: secret === undefined ? {} : { "x-cron-secret": secret },
  });

Deno.test("requireCronSecret accepts the configured secret", async () => {
  assertEquals(await requireCronSecret(cronRequest("s3cret"), "s3cret"), null);
});

Deno.test("requireCronSecret rejects missing, wrong and different-length secrets", async () => {
  for (const provided of [undefined, "wrong", "s3cret-but-longer", ""]) {
    const response = await requireCronSecret(cronRequest(provided), "s3cret");
    assertEquals(response?.status, 401);
    await response?.body?.cancel();
  }
});

Deno.test("requireCronSecret fails closed when no secret is configured", async () => {
  const response = await requireCronSecret(cronRequest(""), "");
  assertEquals(response?.status, 500);
  await response?.body?.cancel();
});

const post = (body: string) => new Request("http://localhost/fn", { method: "POST", body });

Deno.test("readJson parses valid JSON", async () => {
  const result = await readJson(post('{"a":1}'));
  assertEquals(result.ok && result.value, { a: 1 });
});

Deno.test("readJson answers 400 for invalid JSON and 413 for oversized bodies", async () => {
  const invalid = await readJson(post("{nope"));
  assertEquals(!invalid.ok && invalid.response.status, 400);
  await (!invalid.ok && invalid.response.body?.cancel());
  const oversized = await readJson(post('{"a":"xxxxxxxxxxxxxxxx"}'), 10);
  assertEquals(!oversized.ok && oversized.response.status, 413);
  await (!oversized.ok && oversized.response.body?.cancel());
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `bun run functions:test`
Expected: FAIL, `Module not found ... env.ts` / `http.ts` (the first run also downloads `jsr:@std/assert@1.0.19`).

- [ ] **Step 4: Implement the adapters**

`supabase/functions/_shared/adapters/env.ts`:

```ts
/** Reads a required environment variable and fails loudly when it is missing or blank. */
export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
```

`supabase/functions/_shared/adapters/http.ts`:

```ts
const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "authorization, apikey, content-type, x-client-info, x-cron-secret";

/** JSON response with a UTF-8 content type and `no-store` unless the caller overrides them. */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** Browser origins allowed to call the functions: the public site (`SITE_URL`). */
export function allowedOriginsFromEnv(): string[] {
  const site = Deno.env.get("SITE_URL");
  if (!site) return [];
  try {
    return [new URL(site).origin];
  } catch {
    return [];
  }
}

/** CORS headers; `access-control-allow-origin` is only set for an allowed origin. */
export function corsHeaders(
  origin: string | null,
  allowedOrigins: readonly string[] = allowedOriginsFromEnv(),
): Record<string, string> {
  const headers: Record<string, string> = {
    vary: "Origin",
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": "86400",
  };
  if (origin !== null && allowedOrigins.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/** Constant-time string comparison: compares fixed-length SHA-256 digests, so length does not leak. */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256(a), sha256(b)]);
  let difference = 0;
  for (let i = 0; i < digestA.length; i++) {
    difference |= (digestA[i] ?? 0) ^ (digestB[i] ?? 0);
  }
  return difference === 0;
}

/**
 * Cron/worker authentication (spec 7.3): the `x-cron-secret` header must equal the configured
 * secret. Returns `null` when authorised, otherwise the error response to return. Fails closed
 * (500) when the secret is not configured.
 */
export async function requireCronSecret(req: Request, secret: string): Promise<Response | null> {
  if (secret.length === 0) return json({ error: "server_misconfigured" }, { status: 500 });
  const provided = req.headers.get("x-cron-secret") ?? "";
  return (await timingSafeEqualStrings(provided, secret))
    ? null
    : json({ error: "unauthorized" }, { status: 401 });
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

/** Reads and parses a JSON request body (default limit 1 MB). */
export async function readJson(req: Request, maxBytes = 1_000_000): Promise<JsonBody> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, response: json({ error: "payload_too_large" }, { status: 413 }) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: json({ error: "invalid_json" }, { status: 400 }) };
  }
}
```

- [ ] **Step 5: Run to confirm pass**

Run: `bun run functions:test`
Expected: `ok | 10 passed | 0 failed` (2 env + 8 http), exit 0. The `--ignore` flag keeps Deno away from `_shared/core` (its tests import `vitest`).

- [ ] **Step 6: Write the failing function-config tests (TDD)**

`tools/lib/functions-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  checkFunctionsConfig,
  FUNCTION_IMPORTS,
  functionDenoJson,
  parseToml,
} from "./functions-config.ts";

const goodToml = `
[edge_runtime]
enabled = true
policy = "per_worker"   # keeps waitUntil alive locally

[functions.health]
verify_jwt = false

[functions.worker-tick]
verify_jwt = false
`;

const goodDeno = { imports: FUNCTION_IMPORTS, nodeModulesDir: "none" };

const base = {
  functionDirs: ["health", "worker-tick"],
  toml: goodToml,
  denoJson: { health: goodDeno, "worker-tick": goodDeno },
  hasIndex: { health: true, "worker-tick": true },
};

describe("parseToml", () => {
  it("reads sections, strips comments and keeps raw values", () => {
    const toml = parseToml(goodToml);
    expect(toml.get("edge_runtime")?.get("policy")).toBe('"per_worker"');
    expect(toml.get("functions.health")?.get("verify_jwt")).toBe("false");
  });
});

describe("functionDenoJson", () => {
  it("renders the canonical per-function deno.json", () => {
    const parsed = JSON.parse(functionDenoJson());
    expect(parsed.imports).toEqual(FUNCTION_IMPORTS);
    expect(parsed.nodeModulesDir).toBe("none");
    expect(functionDenoJson().endsWith("\n")).toBe(true);
  });
});

describe("checkFunctionsConfig", () => {
  it("accepts a consistent configuration", () => {
    expect(checkFunctionsConfig(base)).toEqual([]);
  });

  it("flags a function without a [functions.x] block", () => {
    const problems = checkFunctionsConfig({ ...base, toml: "[edge_runtime]\npolicy = \"per_worker\"\n" });
    expect(problems).toContain("health: missing [functions.health] block in supabase/config.toml");
  });

  it("flags verify_jwt other than false", () => {
    const toml = goodToml.replace("[functions.health]\nverify_jwt = false", "[functions.health]\nverify_jwt = true");
    expect(checkFunctionsConfig({ ...base, toml })).toContain(
      "health: verify_jwt must be false (authentication is done in code)",
    );
  });

  it("flags a config block whose directory does not exist", () => {
    const problems = checkFunctionsConfig({ ...base, toml: `${goodToml}\n[functions.ghost]\nverify_jwt = false\n` });
    expect(problems).toContain("ghost: [functions.ghost] has no directory under supabase/functions");
  });

  it("flags a missing or drifted deno.json", () => {
    const drifted = { imports: { ...FUNCTION_IMPORTS, "@core/": "../elsewhere/" }, nodeModulesDir: "none" };
    expect(checkFunctionsConfig({ ...base, denoJson: { health: drifted, "worker-tick": goodDeno } })).toContain(
      "health: deno.json imports differ from the canonical import map",
    );
    expect(checkFunctionsConfig({ ...base, denoJson: { health: undefined, "worker-tick": goodDeno } })).toContain(
      "health: deno.json is missing or not valid JSON",
    );
  });

  it("flags a function without index.ts", () => {
    expect(checkFunctionsConfig({ ...base, hasIndex: { health: false, "worker-tick": true } })).toContain(
      "health: index.ts is missing",
    );
  });

  it("flags an edge runtime policy other than per_worker", () => {
    const toml = goodToml.replace('policy = "per_worker"', 'policy = "oneshot"');
    expect(checkFunctionsConfig({ ...base, toml })).toContain(
      '[edge_runtime] policy must be "per_worker" (EdgeRuntime.waitUntil needs it locally)',
    );
  });
});
```

- [ ] **Step 7: Run to confirm failure, then implement**

Run: `bun run test:tools`
Expected: FAIL, `Failed to resolve import "./functions-config.ts"`.

`tools/lib/functions-config.ts`:

```ts
/** The import map every function's deno.json must carry (spec 3.6). */
export const FUNCTION_IMPORTS = {
  "@core/": "../_shared/core/",
  "@adapters/": "../_shared/adapters/",
  "@supabase/supabase-js": "npm:@supabase/supabase-js@2.117.3",
} as const;

/** Text of the canonical per-function deno.json. */
export function functionDenoJson(): string {
  return `${JSON.stringify({ imports: FUNCTION_IMPORTS, nodeModulesDir: "none" }, null, 2)}\n`;
}

/** Minimal TOML reader: section name -> (key -> raw value). Enough for supabase/config.toml checks. */
export function parseToml(toml: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = new Map<string, string>();
  sections.set("", current);
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header?.[1] !== undefined) {
      current = sections.get(header[1]) ?? new Map<string, string>();
      sections.set(header[1], current);
      continue;
    }
    const equals = line.indexOf("=");
    if (equals > 0) {
      const key = line.slice(0, equals).trim();
      const value = line
        .slice(equals + 1)
        .replace(/\s+#.*$/, "")
        .trim();
      current.set(key, value);
    }
  }
  return sections;
}

export interface FunctionsConfigInput {
  /** directory names under supabase/functions, without the `_shared` folder */
  functionDirs: string[];
  /** contents of supabase/config.toml */
  toml: string;
  /** parsed deno.json per function directory; undefined when missing or invalid */
  denoJson: Record<string, unknown>;
  hasIndex: Record<string, boolean>;
}

function sameImports(actual: unknown): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  const entries = (value: object) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return entries(actual) === entries(FUNCTION_IMPORTS);
}

/** Returns a list of human-readable problems; an empty list means the configuration is consistent. */
export function checkFunctionsConfig(input: FunctionsConfigInput): string[] {
  const problems: string[] = [];
  const toml = parseToml(input.toml);

  if (toml.get("edge_runtime")?.get("policy") !== '"per_worker"') {
    problems.push('[edge_runtime] policy must be "per_worker" (EdgeRuntime.waitUntil needs it locally)');
  }

  for (const name of input.functionDirs) {
    if (input.hasIndex[name] !== true) problems.push(`${name}: index.ts is missing`);

    const deno = input.denoJson[name];
    if (typeof deno !== "object" || deno === null) {
      problems.push(`${name}: deno.json is missing or not valid JSON`);
    } else {
      const record = deno as { imports?: unknown; nodeModulesDir?: unknown };
      if (!sameImports(record.imports)) {
        problems.push(`${name}: deno.json imports differ from the canonical import map`);
      }
      if (record.nodeModulesDir !== "none") {
        problems.push(`${name}: deno.json must set "nodeModulesDir": "none"`);
      }
    }

    const block = toml.get(`functions.${name}`);
    if (block === undefined) {
      problems.push(`${name}: missing [functions.${name}] block in supabase/config.toml`);
    } else if (block.get("verify_jwt") !== "false") {
      problems.push(`${name}: verify_jwt must be false (authentication is done in code)`);
    }
  }

  for (const section of toml.keys()) {
    if (!section.startsWith("functions.")) continue;
    const name = section.slice("functions.".length);
    if (!input.functionDirs.includes(name)) {
      problems.push(`${name}: [functions.${name}] has no directory under supabase/functions`);
    }
  }
  return problems;
}
```

Run: `bun run test:tools`
Expected: all tools tests pass (8 purity + 6 secret-scan + 9 functions-config = 23), exit 0.

- [ ] **Step 8: Write the checker and the scaffolder**

`tools/check-functions-config.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFunctionsConfig } from "./lib/functions-config.ts";

const functionsDir = fileURLToPath(new URL("../supabase/functions/", import.meta.url));
const configPath = fileURLToPath(new URL("../supabase/config.toml", import.meta.url));

const functionDirs = readdirSync(functionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
  .map((entry) => entry.name);

const denoJson: Record<string, unknown> = {};
const hasIndex: Record<string, boolean> = {};
for (const name of functionDirs) {
  hasIndex[name] = existsSync(join(functionsDir, name, "index.ts"));
  try {
    denoJson[name] = JSON.parse(readFileSync(join(functionsDir, name, "deno.json"), "utf8"));
  } catch {
    denoJson[name] = undefined;
  }
}

const problems = checkFunctionsConfig({
  functionDirs,
  toml: readFileSync(configPath, "utf8"),
  denoJson,
  hasIndex,
});
if (problems.length > 0) {
  for (const problem of problems) console.error(`functions config: ${problem}`);
  process.exit(1);
}
console.log(`functions config: OK (${functionDirs.join(", ")})`);
```

`tools/new-function.ts` (creates the canonical `deno.json` and, if absent, a 501 placeholder; later phases use it for every new function):

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { functionDenoJson } from "./lib/functions-config.ts";

const name = process.argv[2];
if (name === undefined || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("usage: bun run tools/new-function.ts <function-name>");
  process.exit(1);
}

const dir = fileURLToPath(new URL(`../supabase/functions/${name}/`, import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "deno.json"), functionDenoJson());

const indexPath = join(dir, "index.ts");
if (!existsSync(indexPath)) {
  writeFileSync(
    indexPath,
    [
      'import { json } from "@adapters/http.ts";',
      "",
      "// P0 placeholder so config and deploy checks cover the final function set.",
      "// The real implementation arrives in a later phase; replace this file then.",
      `Deno.serve(() => json({ error: "not_implemented", function: "${name}" }, { status: 501 }));`,
      "",
    ].join("\n"),
  );
}
console.log(`function ${name}: ready`);
```

- [ ] **Step 9: Write the `health` function**

`supabase/functions/health/handler.ts`:

```ts
import { corsHeaders, json } from "@adapters/http.ts";
import { CORE_VERSION } from "@core/mod.ts";

export function handleHealth(req: Request): Response {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") {
    return json(
      { error: "method_not_allowed" },
      { status: 405, headers: { ...cors, allow: "GET, OPTIONS" } },
    );
  }
  return json({ ok: true, version: CORE_VERSION, time: new Date().toISOString() }, { headers: cors });
}
```

`supabase/functions/health/index.ts` (later phases extend `handleHealth` with scan freshness):

```ts
import { handleHealth } from "./handler.ts";

Deno.serve(handleHealth);
```

`supabase/functions/health/handler.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { CORE_VERSION } from "@core/mod.ts";
import { handleHealth } from "./handler.ts";

Deno.test("GET returns ok, the core version and an ISO time", async () => {
  const response = handleHealth(new Request("http://localhost/health"));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.version, CORE_VERSION);
  assert(!Number.isNaN(Date.parse(body.time)));
});

Deno.test("OPTIONS answers the CORS preflight with 204", async () => {
  const response = handleHealth(new Request("http://localhost/health", { method: "OPTIONS" }));
  assertEquals(response.status, 204);
  await response.body?.cancel();
});

Deno.test("other methods are rejected with 405", async () => {
  const response = handleHealth(new Request("http://localhost/health", { method: "POST" }));
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET, OPTIONS");
  await response.body?.cancel();
});
```

Note the test imports through the `@core/` prefix, which pins the import-map prefix that points outside the function folder (spec A-21, P0-02) for `deno test`; Step 17 pins it for the Supabase CLI bundler.

- [ ] **Step 10: Scaffold `deno.json` for all four functions and the three placeholders**

Run (one command per function):

```text
bun run tools/new-function.ts health
bun run tools/new-function.ts worker-tick
bun run tools/new-function.ts scan-control
bun run tools/new-function.ts retention-cleanup
```

Expected: `health/index.ts` is kept (it exists); the other three get a 501 placeholder `index.ts`; all four get the identical `deno.json`. Verify the canonical file:

`supabase/functions/health/deno.json`:

```json
{
  "imports": {
    "@core/": "../_shared/core/",
    "@adapters/": "../_shared/adapters/",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.117.3"
  },
  "nodeModulesDir": "none"
}
```

`supabase/functions/.env.example`:

```text
# Local Edge Function secrets. Copy to supabase/functions/.env (git-ignored); never commit values.
CRON_SHARED_SECRET=
SEC_USER_AGENT=
SITE_URL=http://localhost:5173
```

- [ ] **Step 11: Run the Deno checks and tests**

Run: `bun run functions:check`
Expected: `Check` lines for the adapters, `health/*`, the three placeholders and `_shared/core/mod.ts`, exit 0. (Core test files are excluded by the negated glob; adapter tests are checked.)

Run: `bun run functions:test`
Expected: `ok | 13 passed | 0 failed` (2 env + 8 http + 3 health), exit 0.

- [ ] **Step 12: Prove `functions:check` is not green by accident (Review Focus 4)**

`tools/functions-check-selftest.ts`:

```ts
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const functionsDir = fileURLToPath(new URL("../supabase/functions/", import.meta.url));

// Each probe is an extensionless relative import, which Deno rejects; one per glob that
// `functions:check` must cover (adapters, core, a function entrypoint).
const BAD_SOURCE = 'import { missing } from "./does-not-exist";\nexport const value = missing;\n';
const PROBES = [
  "_shared/adapters/__selftest_bad__.ts",
  "_shared/core/__selftest_bad__.ts",
  "__selftest_fn__/index.ts",
];

function runCheck() {
  const result = spawnSync(process.execPath, ["run", "functions:check"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

let failed = false;
const fail = (message: string) => {
  failed = true;
  console.error(`functions:check self-test: ${message}`);
};

const baseline = runCheck();
if (baseline.status !== 0) fail(`baseline run is not green:\n${baseline.output}`);

try {
  for (const probe of PROBES) {
    const path = `${functionsDir}${probe}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, BAD_SOURCE);
  }
  const broken = runCheck();
  if (broken.status === 0) fail("a broken import did not fail `functions:check` (globs match nothing?)");
  for (const probe of PROBES) {
    const name = probe.includes("__selftest_fn__") ? "__selftest_fn__" : "__selftest_bad__";
    if (!broken.output.includes(name)) fail(`the probe ${probe} was not type-checked`);
  }
} finally {
  rmSync(`${functionsDir}_shared/adapters/__selftest_bad__.ts`, { force: true });
  rmSync(`${functionsDir}_shared/core/__selftest_bad__.ts`, { force: true });
  rmSync(`${functionsDir}__selftest_fn__`, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("functions:check self-test: OK (broken adapter, core and function files are all rejected)");
```

Run: `bun run functions:selftest`
Expected: `functions:check self-test: OK (...)`; `git status` shows no leftover `__selftest_*` files.

- [ ] **Step 13: Initialise the Supabase project and edit `config.toml`**

Run: `bunx supabase init --yes`
Expected: `Finished supabase init.`; creates `supabase/config.toml` (about 400 lines of commented defaults) and `supabase/.temp/` (git-ignored). The generated defaults already contain `[edge_runtime] policy = "per_worker"`, `[auth.email] enable_confirmations = false`, and `[db.pooler] enabled = false` (the pooler stays at its defaults). Make exactly these edits.

1. Project id: replace `project_id = "personal-stock-sreener"` with:

```toml
project_id = "stock-screener"
```

2. Auth URLs: replace `site_url = "http://127.0.0.1:3000"` with `site_url = "http://localhost:5173"` and replace `additional_redirect_urls = ["https://127.0.0.1:3000"]` with:

```toml
additional_redirect_urls = ["http://localhost:5173/auth/callback", "http://localhost:5173/auth/reset"]
```

3. Analytics (its Logflare/Vector containers need the Docker daemon socket exposed on Windows and are not needed locally): replace the two lines `[analytics]` / `enabled = true` with:

```toml
[analytics]
enabled = false
```

4. Append the function blocks at the end of the file:

```toml

# --- Edge Functions -----------------------------------------------------------
# Every function authenticates inside its own code (shared-secret header or getClaims()),
# so the platform JWT check is off. tools/check-functions-config.ts enforces one block per function.
[functions.health]
verify_jwt = false

[functions.worker-tick]
verify_jwt = false

[functions.scan-control]
verify_jwt = false

[functions.retention-cleanup]
verify_jwt = false
```

Run: `bun run check:functions-config`
Expected: `functions config: OK (health, retention-cleanup, scan-control, worker-tick)`.

- [ ] **Step 14: Write the migration, seed and pgTAP smoke test**

`supabase/migrations/20261015000100_extensions.sql`:

```sql
-- P0 foundations: extensions and the private application schema.
-- pgtap is created here so `supabase test db` works on any database built from these migrations.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgtap with schema extensions;

-- Internal objects (SQL functions, job helpers) live in schema app; clients never reach it directly.
create schema if not exists app;
revoke all on schema app from public;
revoke all on schema app from anon, authenticated;
```

`supabase/seed.sql`:

```sql
-- Seed data (exchanges, app_settings defaults, mapping tables) arrives with the phase that creates
-- those tables (P1). Intentionally empty in P0.
```

`supabase/tests/0001_smoke.test.sql`:

```sql
begin;
select plan(8);

select has_extension('pg_cron', 'pg_cron is installed');
select has_extension('pg_net', 'pg_net is installed');
select has_extension('pgcrypto', 'pgcrypto is installed');
select has_extension('pgtap', 'pgtap is installed');

select has_schema('app', 'schema app exists');
select is(has_schema_privilege('public', 'app', 'usage'), false, 'PUBLIC cannot use schema app');
select is(has_schema_privilege('anon', 'app', 'usage'), false, 'anon cannot use schema app');
select is(has_schema_privilege('authenticated', 'app', 'usage'), false, 'authenticated cannot use schema app');

select * from finish();
rollback;
```

- [ ] **Step 15: Start the local stack and run the database tests**

Run: `bun run supabase:start`
Expected: the first run pulls the Supabase images (several minutes) and ends with `Started supabase local development setup.` and a table with `Project URL http://127.0.0.1:54321`, `Database URL postgresql://postgres:postgres@127.0.0.1:54322/postgres`, publishable and secret keys. Keep these values in the terminal only; they are local defaults, are never copied into any committed file, and `git status --short` must show nothing under `supabase/.temp`. (If analytics or vector errors appear, re-check edit 3 of Step 13.)

Run: `bun run test:db`
Expected: `supabase/tests/0001_smoke.test.sql .. ok`, `All tests successful.`, `Files=1, Tests=8`, `Result: PASS`. If the CLI reports that it found no test files, move the file to `supabase/tests/database/0001_smoke.test.sql` (the documented layout), re-run, and record the final path in Task 7's results file and in the `supabase/tests` row of spec 3.1.

- [ ] **Step 16: Serve the functions and call `health`**

Copy the example env file (PowerShell): `Copy-Item supabase/functions/.env.example supabase/functions/.env` (the real file is git-ignored; the values may stay empty for `health`).

Start `bun run supabase:serve` in a background terminal; wait for `Serving functions on http://127.0.0.1:54321/functions/v1/<function-name>`.

Run: `curl.exe -sS http://127.0.0.1:54321/functions/v1/health`
Expected: `{"ok":true,"version":"0.0.1","time":"2026-..."}` (first call may take a few seconds while the runtime boots).

Run: `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:54321/functions/v1/worker-tick`
Expected: `501` (the placeholder, reachable without a JWT because of `verify_jwt = false`).

The `health` call proves that the CLI bundler follows the `@core/` and `@adapters/` import-map prefixes that point OUTSIDE the function folder (spec A-21, P0-02). If it instead fails with a module-not-found error for `@core/mod.ts`, apply the fallback and record it: change the two imports in `health/handler.ts` to `../_shared/adapters/http.ts` and `../_shared/core/mod.ts`, re-run this step, and note in Task 7's results file that prefix maps are not bundled by CLI 2.121.0 (functions then import by relative path; `tools/lib/functions-config.ts` `FUNCTION_IMPORTS` stays as is for Deno).

Stop the serve process.

- [ ] **Step 17: Stop the stack, lint, commit**

Run: `bun run supabase:stop`
Expected: `Stopped supabase local development setup.` (data volumes are kept).

Run: `bun run lint:fix` then `bun run lint`, `bun run typecheck`, `bun run test:tools`
Expected: all exit 0. `git status --short` must not list `supabase/functions/.env` or anything under `supabase/.temp`.

```text
git add supabase tools bun.lock package.json
git commit -m "feat(supabase): add local project, shared adapters, health function and function guards"
```


### Task 6: CI and deployment workflows, workflow and deploy-environment guards, operator guide

**Files:**
- Create: `.github/workflows/ci.yml`, `deploy-web.yml`, `deploy-supabase.yml`, `keepalive.yml`
- Create: `tools/lib/workflow-lint.ts`, `tools/lib/workflow-lint.test.ts`, `tools/validate-workflows.ts`
- Create: `tools/lib/web-env.ts`, `tools/lib/web-env.test.ts`, `tools/check-web-env.ts`
- Create: `docs/operator-guide.md`
- Modify: `package.json` (root devDependencies: `yaml`)

**Interfaces:**
- Consumes: root scripts `lint`, `lint:workflows`, `typecheck`, `test:core`, `test:tools`, `test:web`, `build`, `check:bundle`, `check:functions-config`, `functions:check`, `functions:test`, `functions:selftest`, `test:e2e` (Tasks 1 to 5); `apps/web/wrangler.jsonc` (Task 4); `scanText` from `tools/lib/secret-scan.ts` (Task 4).
- Produces: workflows `ci.yml`, `deploy-web.yml`, `deploy-supabase.yml`, `keepalive.yml`; `lintWorkflow(doc, file)` and `webEnvProblems(env, options?)`; the GitHub secrets and variables documented in `docs/operator-guide.md` (secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `KEEPALIVE_EMAIL`, `KEEPALIVE_PASSWORD`; variables `SUPABASE_PROJECT_REF`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SITE_URL`, `KEEPALIVE_SUPABASE_URL`, `KEEPALIVE_ANON_KEY`, `KEEPALIVE_ENABLED`; environment `production`).

- [ ] **Step 1: Add the YAML parser and install**

Root `package.json` `devDependencies` gains `"yaml": "^2.9.1"` (alphabetical, last entry).

Run: `bun install`
Expected: exits 0; `bun.lock` updated.

- [ ] **Step 2: Write the failing workflow-lint tests (TDD)**

`tools/lib/workflow-lint.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lintWorkflow } from "./workflow-lint.ts";

const good = () => ({
  name: "CI",
  on: { push: { branches: ["master"] }, pull_request: null },
  permissions: { contents: "read" },
  jobs: {
    web: {
      "runs-on": "ubuntu-latest",
      steps: [{ uses: "actions/checkout@v4" }, { run: "bun run lint" }],
    },
  },
});

describe("lintWorkflow", () => {
  it("accepts a well-formed workflow", () => {
    expect(lintWorkflow(good(), "ci.yml")).toEqual([]);
  });

  it("accepts actions pinned to a major tag, a full tag or a commit SHA, and local actions", () => {
    const workflow = good();
    workflow.jobs.web.steps = [
      { uses: "oven-sh/setup-bun@v2" },
      { uses: "owner/repo@v1.2.3" },
      { uses: `owner/repo@${"a".repeat(40)}` },
      { uses: "./.github/actions/local" },
    ];
    expect(lintWorkflow(workflow, "ci.yml")).toEqual([]);
  });

  it("flags unpinned actions", () => {
    const workflow = good();
    workflow.jobs.web.steps = [{ uses: "actions/checkout@main" }, { uses: "actions/setup-node" }];
    expect(lintWorkflow(workflow, "ci.yml")).toHaveLength(2);
  });

  it("flags a missing name, trigger or jobs", () => {
    expect(lintWorkflow({ jobs: {} }, "x.yml")).toEqual([
      "x.yml: missing name",
      "x.yml: missing on:",
      "x.yml: no jobs",
    ]);
  });

  it("flags jobs without runs-on or steps", () => {
    const workflow = { ...good(), jobs: { a: { steps: [{ run: "x" }] }, b: { "runs-on": "ubuntu-latest" } } };
    const problems = lintWorkflow(workflow, "ci.yml");
    expect(problems).toContain("ci.yml: job a: missing runs-on");
    expect(problems).toContain("ci.yml: job b: no steps");
  });

  it("flags steps that neither use nor run anything", () => {
    const workflow = good();
    workflow.jobs.web.steps = [{ name: "oops" } as never];
    expect(lintWorkflow(workflow, "ci.yml")).toContain("ci.yml: job web step 1: needs uses or run");
  });

  it("requires least-privilege permissions at workflow or job level", () => {
    const { permissions: _removed, ...withoutPermissions } = good();
    expect(lintWorkflow(withoutPermissions, "ci.yml")).toContain(
      "ci.yml: job web: no permissions (declare least privilege at workflow or job level)",
    );
    const jobLevel = {
      ...withoutPermissions,
      jobs: { web: { ...good().jobs.web, permissions: { contents: "read" } } },
    };
    expect(lintWorkflow(jobLevel, "ci.yml")).toEqual([]);
  });

  it("forbids pull_request_target", () => {
    const workflow = { ...good(), on: { pull_request_target: null } };
    expect(lintWorkflow(workflow, "ci.yml")).toContain(
      "ci.yml: pull_request_target is not allowed (it runs untrusted code with secrets)",
    );
  });
});
```

- [ ] **Step 3: Run to confirm failure, implement, run to confirm pass**

Run: `bun run test:tools`
Expected: FAIL, `Failed to resolve import "./workflow-lint.ts"`.

`tools/lib/workflow-lint.ts`:

```ts
// owner/repo[/path]@vN | vN.N | vN.N.N | 40-hex commit SHA
const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@(v\d+(\.\d+){0,2}|[0-9a-f]{40})$/;

type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural lint of one parsed workflow; returns problems (empty = fine). */
export function lintWorkflow(doc: unknown, file: string): string[] {
  const problems: string[] = [];
  const add = (message: string) => problems.push(`${file}: ${message}`);
  if (!isMapping(doc)) {
    add("not a YAML mapping");
    return problems;
  }

  if (typeof doc.name !== "string" || doc.name === "") add("missing name");

  const triggers = doc.on;
  if (triggers === undefined || triggers === null) {
    add("missing on:");
  } else if (
    triggers === "pull_request_target" ||
    (isMapping(triggers) && "pull_request_target" in triggers)
  ) {
    add("pull_request_target is not allowed (it runs untrusted code with secrets)");
  }

  const jobs = doc.jobs;
  if (!isMapping(jobs) || Object.keys(jobs).length === 0) {
    add("no jobs");
    return problems;
  }

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isMapping(job)) {
      add(`job ${jobId}: not a mapping`);
      continue;
    }
    if (!("runs-on" in job)) add(`job ${jobId}: missing runs-on`);
    if (doc.permissions === undefined && job.permissions === undefined) {
      add(`job ${jobId}: no permissions (declare least privilege at workflow or job level)`);
    }
    const steps = job.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      add(`job ${jobId}: no steps`);
      continue;
    }
    steps.forEach((step, index) => {
      const label = `job ${jobId} step ${index + 1}`;
      if (!isMapping(step) || (typeof step.uses !== "string" && typeof step.run !== "string")) {
        add(`${label}: needs uses or run`);
        return;
      }
      const uses = step.uses;
      if (typeof uses === "string" && !uses.startsWith("./") && !PINNED_ACTION.test(uses)) {
        add(`${label}: action ${uses} must be pinned to a version tag or commit SHA`);
      }
    });
  }
  return problems;
}
```

Run: `bun run test:tools`
Expected: the 8 `workflow-lint` tests pass (31 tools tests in total so far), exit 0.

- [ ] **Step 4: Write `tools/validate-workflows.ts`**

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { lintWorkflow } from "./lib/workflow-lint.ts";

const dir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const REQUIRED = ["ci.yml", "deploy-web.yml", "deploy-supabase.yml", "keepalive.yml"];

const problems: string[] = [];
for (const file of REQUIRED) {
  if (!existsSync(join(dir, file))) problems.push(`${file}: workflow is missing`);
}

const files = readdirSync(dir).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
for (const file of files) {
  try {
    problems.push(...lintWorkflow(parse(readFileSync(join(dir, file), "utf8")), file));
  } catch (error) {
    problems.push(`${file}: invalid YAML (${error instanceof Error ? error.message : String(error)})`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`workflows: ${problem}`);
  process.exit(1);
}
console.log(`workflows: OK (${files.join(", ")})`);
```

- [ ] **Step 5: Write the failing deploy-environment tests (TDD, Review Focus 5)**

`tools/lib/web-env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { webEnvProblems } from "./web-env.ts";

const good = {
  VITE_SUPABASE_URL: "https://abcd1234.supabase.co",
  VITE_SUPABASE_ANON_KEY: "public-anon-key",
  VITE_SITE_URL: "https://screener.example.com",
};

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const serviceRoleJwt = `${b64url({ alg: "HS256" })}.${b64url({ role: "service_role" })}.c2lnbmF0dXJl`;

describe("webEnvProblems", () => {
  it("accepts a complete production configuration", () => {
    expect(webEnvProblems(good)).toEqual([]);
  });

  it.each(Object.keys(good))("flags an empty or missing %s", (name) => {
    expect(webEnvProblems({ ...good, [name]: "" })).toContain(`${name} is empty or not set`);
    const { [name]: _removed, ...rest } = good as Record<string, string>;
    expect(webEnvProblems(rest)).toContain(`${name} is empty or not set`);
  });

  it("rejects localhost and plain http URLs unless local builds are allowed", () => {
    const local = { ...good, VITE_SUPABASE_URL: "http://127.0.0.1:54321", VITE_SITE_URL: "http://localhost:5173" };
    expect(webEnvProblems(local)).toEqual([
      "VITE_SUPABASE_URL points at a local address",
      "VITE_SUPABASE_URL must use https",
      "VITE_SITE_URL points at a local address",
      "VITE_SITE_URL must use https",
    ]);
    expect(webEnvProblems(local, { allowLocal: true })).toEqual([]);
  });

  it("rejects values that are not URLs", () => {
    expect(webEnvProblems({ ...good, VITE_SITE_URL: "screener.example.com" })).toContain(
      "VITE_SITE_URL is not a valid URL",
    );
  });

  it("rejects VITE_ variables named like secrets", () => {
    for (const name of ["VITE_SERVICE_ROLE_KEY", "VITE_RESEND_API_KEY", "VITE_VAPID_PRIVATE_KEY", "VITE_ADMIN_TOKEN"]) {
      expect(webEnvProblems({ ...good, [name]: "x" })).toContain(
        `${name} looks like a secret and would be embedded in the browser bundle`,
      );
    }
  });

  it("allows the public VAPID and Turnstile site keys", () => {
    expect(webEnvProblems({ ...good, VITE_VAPID_PUBLIC_KEY: "BPublic", VITE_TURNSTILE_SITE_KEY: "0xAAAA" })).toEqual([]);
  });

  it("rejects a service-role JWT hidden in any VITE_ value", () => {
    expect(webEnvProblems({ ...good, VITE_SUPABASE_ANON_KEY: serviceRoleJwt })).toContain(
      "VITE_SUPABASE_ANON_KEY contains a service-role key",
    );
  });
});
```

- [ ] **Step 6: Run to confirm failure, implement, run to confirm pass**

Run: `bun run test:tools`
Expected: FAIL, `Failed to resolve import "./web-env.ts"`.

`tools/lib/web-env.ts`:

```ts
import { scanText } from "./secret-scan.ts";

const REQUIRED = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_SITE_URL"] as const;
const URL_VARIABLES = ["VITE_SUPABASE_URL", "VITE_SITE_URL"] as const;
const SECRET_NAME = /SERVICE_ROLE|SECRET|PRIVATE|PASSWORD|TOKEN|RESEND|FLEX_ENC/i;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/;

export interface WebEnvOptions {
  /** accept localhost and http URLs (local production-mode builds) */
  allowLocal?: boolean;
}

/**
 * Problems that would make a deployed bundle broken or unsafe. Values are never echoed, only
 * variable names, so the output is safe in CI logs.
 */
export function webEnvProblems(
  env: Record<string, string | undefined>,
  options: WebEnvOptions = {},
): string[] {
  const allowLocal = options.allowLocal ?? false;
  const problems: string[] = [];

  for (const name of REQUIRED) {
    if ((env[name] ?? "").trim() === "") problems.push(`${name} is empty or not set`);
  }

  for (const name of URL_VARIABLES) {
    const value = (env[name] ?? "").trim();
    if (value === "") continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      problems.push(`${name} is not a valid URL`);
      continue;
    }
    if (!allowLocal) {
      if (LOCAL_HOST.test(url.hostname)) problems.push(`${name} points at a local address`);
      if (url.protocol !== "https:") problems.push(`${name} must use https`);
    }
  }

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("VITE_")) continue;
    if (SECRET_NAME.test(name)) {
      problems.push(`${name} looks like a secret and would be embedded in the browser bundle`);
    }
    if (value !== undefined && scanText(value).length > 0) {
      problems.push(`${name} contains a service-role key`);
    }
  }
  return problems;
}
```

Run: `bun run test:tools`
Expected: all tools tests pass (purity 8, secret-scan 6, functions-config 9, workflow-lint 8, web-env 9 = 40), exit 0.

- [ ] **Step 7: Write `tools/check-web-env.ts` and prove it bites**

```ts
import { webEnvProblems } from "./lib/web-env.ts";

const allowLocal = process.argv.includes("--allow-local");
const problems = webEnvProblems(process.env, { allowLocal });
if (problems.length > 0) {
  for (const problem of problems) console.error(`web env: ${problem}`);
  process.exit(1);
}
console.log(`web env: OK${allowLocal ? " (local addresses allowed)" : ""}`);
```

Run (PowerShell), all three in one session:

```text
Remove-Item Env:VITE_SUPABASE_URL, Env:VITE_SUPABASE_ANON_KEY, Env:VITE_SITE_URL -ErrorAction SilentlyContinue
bun run tools/check-web-env.ts
```

Expected: exit 1 with three `web env: VITE_... is empty or not set` lines (names only, no values).

```text
$env:VITE_SUPABASE_URL = "https://abcd1234.supabase.co"; $env:VITE_SUPABASE_ANON_KEY = "x"; $env:VITE_SITE_URL = "https://screener.example.com"
bun run tools/check-web-env.ts
```

Expected: `web env: OK`. Clear the three variables afterwards.

- [ ] **Step 8: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  # Public placeholder values: the CI build only needs the variables to exist (never real keys).
  VITE_SUPABASE_URL: https://ci-placeholder.supabase.co
  VITE_SUPABASE_ANON_KEY: ci-placeholder-anon-key
  VITE_SITE_URL: https://ci-placeholder.example.com

jobs:
  web:
    name: Lint, typecheck, unit tests, build
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run lint:workflows
      - run: bun run typecheck
      - run: bun run test:core
      - run: bun run test:tools
      - run: bun run test:web
      - run: bun run build
      - name: Scan the built bundle for secrets
        run: bun run check:bundle

  deno:
    name: Deno check and tests
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      # 2.1.x approximates the Supabase Edge Runtime (Deno 2.1.4 compatible, spec 3.2)
      - uses: denoland/setup-deno@v2
        with:
          deno-version: 2.1.x
      - run: bun run check:functions-config
      - run: bun run functions:check
      - run: bun run functions:test
      - run: bun run functions:selftest

  db:
    name: pgTAP against the local Supabase stack
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: 2.121.0
      # Excluded containers are not needed for SQL tests (`mailpit` is the current name of inbucket).
      # GoTrue stays: it creates the auth schema that later RLS tests depend on.
      - run: supabase start -x studio,imgproxy,mailpit,logflare,vector,postgres-meta,supavisor,realtime,storage-api,edge-runtime
      - run: supabase test db

  e2e:
    name: Playwright smoke test
    # on every push to master and on pull requests labelled "e2e" (spec 3.10)
    if: ${{ github.event_name == 'push' || contains(github.event.pull_request.labels.*.name, 'e2e') }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - run: bunx playwright install --with-deps chromium
      - run: bun run test:e2e
      - uses: actions/upload-artifact@v4
        if: ${{ failure() }}
        with:
          name: playwright-report
          path: apps/web/playwright-report
          retention-days: 7
```

- [ ] **Step 9: Write `.github/workflows/deploy-web.yml`**

```yaml
name: Deploy web

on:
  workflow_dispatch:
  push:
    branches: [master]
    paths:
      - "apps/web/**"
      - "supabase/functions/_shared/core/**"
      - "bun.lock"
      - ".github/workflows/deploy-web.yml"

permissions:
  contents: read

concurrency:
  group: deploy-web
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      # public build-time values only, stored as repository VARIABLES (not secrets)
      VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}
      VITE_SUPABASE_ANON_KEY: ${{ vars.VITE_SUPABASE_ANON_KEY }}
      VITE_SITE_URL: ${{ vars.VITE_SITE_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - name: Guard production build variables
        run: bun run tools/check-web-env.ts
      - run: bun run build
      - name: Scan the built bundle for secrets
        run: bun run check:bundle
      - name: Deploy to Cloudflare Workers Static Assets
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: apps/web
          wranglerVersion: "4.151.0"
          command: deploy
```

- [ ] **Step 10: Write `.github/workflows/deploy-supabase.yml`**

`supabase db push` in CI is not verified on a Supabase docs page (spec 3.10, P0-03); this workflow is the thing to verify at the first real run. `--skip-vault` keeps Vault secrets under operator control (the CLI otherwise syncs them from `config.toml`).

```yaml
name: Deploy Supabase

on:
  workflow_dispatch:
  push:
    branches: [master]
    paths:
      - "supabase/**"
      - ".github/workflows/deploy-supabase.yml"

permissions:
  contents: read

concurrency:
  group: deploy-supabase
  cancel-in-progress: false

env:
  SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
  SUPABASE_PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF }}

jobs:
  database:
    name: Migrations (manual approval)
    runs-on: ubuntu-latest
    timeout-minutes: 15
    # Configure required reviewers on the "production" environment: that is the approval gate.
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: 2.121.0
      - run: supabase link --project-ref "$SUPABASE_PROJECT_REF" --yes
      - name: Preview pending migrations
        run: supabase db push --dry-run --skip-vault
      - name: Apply migrations
        run: supabase db push --yes --skip-vault

  functions:
    name: Edge Functions
    needs: database
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - name: Every function has verify_jwt = false and the canonical import map
        run: bun run check:functions-config
      - uses: supabase/setup-cli@v1
        with:
          version: 2.121.0
      # Function secrets are set once by the operator (`supabase secrets set`), never by CI.
      # All functions authenticate in code, so the platform JWT check is off for every one
      # (the same value as the [functions.*] blocks that check:functions-config enforces).
      - run: supabase functions deploy --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt
```

- [ ] **Step 11: Write `.github/workflows/keepalive.yml`**

The REST read targets `app_settings`, a P1 table. Until P1 has created it (with a policy that lets `authenticated` users read it) the job would fail every day, so it is gated by the repository variable `KEEPALIVE_ENABLED`; the operator sets it to `true` after the P1 migrations are deployed and the dedicated user exists (P0-07).

```yaml
name: Keep-alive

on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  keepalive:
    # Off until the app_settings table exists (P1): set repository variable KEEPALIVE_ENABLED=true.
    if: ${{ vars.KEEPALIVE_ENABLED == 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    env:
      SUPABASE_URL: ${{ vars.KEEPALIVE_SUPABASE_URL }}
      ANON_KEY: ${{ vars.KEEPALIVE_ANON_KEY }}
      KEEPALIVE_EMAIL: ${{ secrets.KEEPALIVE_EMAIL }}
      KEEPALIVE_PASSWORD: ${{ secrets.KEEPALIVE_PASSWORD }}
    steps:
      - name: Authenticated REST read as the keep-alive user
        shell: bash
        run: |
          set -euo pipefail
          : "${SUPABASE_URL:?KEEPALIVE_SUPABASE_URL is not set}"
          : "${ANON_KEY:?KEEPALIVE_ANON_KEY is not set}"
          : "${KEEPALIVE_EMAIL:?KEEPALIVE_EMAIL is not set}"
          : "${KEEPALIVE_PASSWORD:?KEEPALIVE_PASSWORD is not set}"

          token_body="$(mktemp)"
          status="$(curl -sS -o "$token_body" -w '%{http_code}' -X POST \
            "$SUPABASE_URL/auth/v1/token?grant_type=password" \
            -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
            --data "$(jq -n --arg email "$KEEPALIVE_EMAIL" --arg password "$KEEPALIVE_PASSWORD" \
              '{email: $email, password: $password}')")"
          if [ "$status" != "200" ]; then
            echo "::error::token request failed with HTTP $status"
            exit 1
          fi
          access_token="$(jq -r '.access_token // empty' "$token_body")"
          if [ -z "$access_token" ]; then
            echo "::error::token response contained no access_token"
            exit 1
          fi
          echo "::add-mask::$access_token"

          status="$(curl -sS -o /dev/null -w '%{http_code}' \
            "$SUPABASE_URL/rest/v1/app_settings?select=key&limit=1" \
            -H "apikey: $ANON_KEY" -H "Authorization: Bearer $access_token")"
          if [ "$status" != "200" ]; then
            echo "::error::authenticated REST read failed with HTTP $status"
            exit 1
          fi
          echo "keep-alive OK: authenticated REST read returned HTTP 200"
```

- [ ] **Step 12: Validate the workflows**

Run: `bun run lint:workflows`
Expected: `workflows: OK (ci.yml, deploy-supabase.yml, deploy-web.yml, keepalive.yml)`. (Parsing proves the YAML is valid; the structural lint proves runners, steps, pinned actions, and least-privilege permissions. Real execution happens on GitHub: after the first push, check the Actions tab, see Task 7.)

- [ ] **Step 13: Write the operator guide skeleton `docs/operator-guide.md`**

Sections 1 to 10 are the brief's section 38 list (spec 16.9); only what P0 configures is filled in, the rest says which phase writes it.

```markdown
# Operator guide

Runbook for the personal stock screener. Written incrementally: each phase fills the sections it
configures. Status legend: **filled** (P0) or **pending (phase)**.

## 0. Local development (filled)

- Prerequisites: Bun 1.3.x, Node 22.13.1 (`.node-version`), Docker Desktop, Deno 2.x.
- `bun install`, `bun run dev` (http://localhost:5173), `bun run supabase:start`, `bun run test:db`,
  `bun run supabase:serve`, `curl http://127.0.0.1:54321/functions/v1/health`, `bun run supabase:stop`.
- Local keys and URLs come from `supabase start` output. They are local-only and are never copied
  into a committed file. `supabase/functions/.env` and `apps/web/.env.local` are git-ignored.
- Before pushing: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.

## 1. Configure and validate the data provider (pending P1)

Yahoo checks, FX check, kill switch.

## 2. Configure Supabase, Vault, cron and function secrets (partly filled)

1. Create one Supabase Free project (Dashboard -> New project). Note the project ref (the 20-letter
   id in the URL) and the database password.
2. Create an access token (Dashboard -> Account -> Access Tokens) for CI.
3. `supabase/config.toml` is committed; every function has `[functions.<name>] verify_jwt = false`
   because functions authenticate in code. `bun run check:functions-config` enforces this.
4. Function secrets are set by the operator, once and on rotation (never by CI):
   `bunx supabase secrets set --project-ref <ref> CRON_SHARED_SECRET=... SEC_USER_AGENT=... SITE_URL=...`
   The full list with owners is spec section 3.11; P0 needs none for `health`.
5. Vault secrets and `pg_cron` jobs: pending (P1, migration `0013_cron_jobs`).

## 3. Configure Google sign-in (pending P5)

## 4. Configure Web Push (VAPID) and Resend (pending P3)

## 5. Set up and verify IBKR Flex (pending P5)

## 6. Deploy the web app (filled)

One-time Cloudflare setup:

1. Create or log in to a Cloudflare account (Free plan; the app processes no card data).
2. Create an API token: My Profile -> API Tokens -> "Edit Cloudflare Workers" template, scoped to the
   account. Note the Account ID (Workers & Pages overview).
3. Add the GitHub secrets and variables listed in section 11.
4. Run workflow "Deploy web" manually (Actions -> Deploy web -> Run workflow). The first run creates
   the Worker `stock-screener` (name in `apps/web/wrangler.jsonc`) with static assets and the SPA fallback.
5. Attach a custom domain in the Cloudflare dashboard (Workers & Pages -> stock-screener -> Settings ->
   Domains) and set the repository variable `VITE_SITE_URL` to it.
6. The Content-Security-Policy in `apps/web/public/_headers` is report-only until P4: replace
   `https://*.supabase.co` with the project URL and review the policy before enforcing it.

The workflow refuses to build when a `VITE_*` variable is empty, local, plain-http or secret-looking,
and scans the built bundle for secrets before uploading.

## 7. Run a safe manual scan (pending P1)

`scan:local` and `scan-control start`.

## 8. Inspect coverage and failures (pending P1)

## 9. Review signal history and research reports (pending P2, P4)

## 10. Inspect broker sync status and reconcile analytics (pending P5)

## 11. GitHub secrets and variables (filled)

Settings -> Secrets and variables -> Actions.

| Name | Kind | Used by | Notes |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | secret | deploy-supabase | personal access token |
| `SUPABASE_DB_PASSWORD` | secret | deploy-supabase | project database password |
| `SUPABASE_PROJECT_REF` | variable | deploy-supabase | 20-letter project id |
| `CLOUDFLARE_API_TOKEN` | secret | deploy-web | scoped to Workers edit |
| `CLOUDFLARE_ACCOUNT_ID` | secret | deploy-web | |
| `VITE_SUPABASE_URL` | variable | deploy-web | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | variable | deploy-web | publishable (anon) key, public by design |
| `VITE_SITE_URL` | variable | deploy-web | public site URL, https |
| `KEEPALIVE_SUPABASE_URL` | variable | keepalive | same as `VITE_SUPABASE_URL` |
| `KEEPALIVE_ANON_KEY` | variable | keepalive | same as `VITE_SUPABASE_ANON_KEY` |
| `KEEPALIVE_EMAIL` | secret | keepalive | dedicated low-privilege confirmed user |
| `KEEPALIVE_PASSWORD` | secret | keepalive | |
| `KEEPALIVE_ENABLED` | variable | keepalive | set to `true` once P1 created `app_settings` |

Environment `production` (Settings -> Environments): add yourself as required reviewer. The
"Migrations" job of deploy-supabase waits for that approval before touching the database.
Never put the service-role key, `CRON_SHARED_SECRET` or any `*_API_KEY` into a `VITE_*` variable.

## 12. Keep-alive and pause handling (filled)

A Supabase Free project pauses after a week without enough user database activity (spec 16.4).
`keepalive.yml` runs daily at 06:17 UTC: it signs in as a dedicated user and reads one row of
`app_settings` through REST, failing the job (GitHub emails you) on any non-200 answer.

Create the user: Dashboard -> Authentication -> Users -> Add user (email and password, auto-confirm).
Store the credentials as the two keep-alive secrets. After the P1 migrations exist (a policy lets
`authenticated` read `app_settings`), set `KEEPALIVE_ENABLED=true` and run the workflow once manually.

Residual risks: it is unverified whether this counts as "user activity", so still open the site or
the dashboard at least weekly and watch for Supabase's warning email. GitHub may disable scheduled
workflows in a repository without activity (not verified; check Actions -> Keep-alive; any push
re-enables). A paused project: Dashboard -> project -> Resume (restorable for one year).

## 13. Backups, rotations, incident runbooks (pending P7)
```

(The block above is the exact file content; it is an `.md` file, so it contains no nested fences.)

- [ ] **Step 14: Lint, run the whole local gate, commit**

Run: `bun run lint:fix` then `bun run lint`, `bun run lint:workflows`, `bun run typecheck`, `bun run test:tools`
Expected: all exit 0.

```text
git add .github docs/operator-guide.md tools package.json bun.lock
git commit -m "ci: add CI, deploy and keep-alive workflows, workflow and deploy-env guards, operator guide"
```


### Task 7: Phase exit checklist and verification record

**Files:**
- Create: `docs/discovery/p0-results.md`
- Modify: `docs/superpowers/specs/2026-10-15-stock-screener-design.md` (one pointer line under the table in section 19.2)

**Interfaces:**
- Consumes: everything from Tasks 1 to 6.
- Produces: the written answers to spec P0-01 to P0-04 (spec section 18, "every P0 task answered in writing"); a clean, committed tree; the list of files that must never be committed.

- [ ] **Step 1: Confirm a clean tree and a frozen install**

Run: `git status --short`
Expected: no output (everything from Tasks 1 to 6 is committed; `supabase/functions/.env`, `apps/web/.env.local`, `supabase/.temp`, `apps/web/dist` and `node_modules` are ignored and do not appear).

Run: `bun install --frozen-lockfile`
Expected: exits 0 with `no changes` (proves `bun.lock` is committed and complete, which CI relies on).

- [ ] **Step 2: Run the static and unit gates**

Run each command; every one must exit 0.

```text
bun run lint
bun run lint:workflows
bun run typecheck
bun run test
```

Expected: `lint` reports `No fixes applied`; `lint:workflows` prints `workflows: OK (...)`; `typecheck` ends with `core purity: OK (1 files scanned, 6 canary globals rejected)`; `test` runs, in order, `core` (2 tests), `tools` (40), `web` (79) and the Deno suite (13).

- [ ] **Step 3: Run the build gates**

```text
bun run build
bun run check:bundle
bun run check:functions-config
bun run functions:check
bun run functions:selftest
```

Expected: `build` emits `apps/web/dist` with `sw.js`, `manifest.webmanifest`, `_headers`; `check:bundle` prints `bundle secret scan: OK (N files)`; `check:functions-config` prints `functions config: OK (health, retention-cleanup, scan-control, worker-tick)`; `functions:check` exits 0; `functions:selftest` prints `functions:check self-test: OK (...)`.

- [ ] **Step 4: Run the local-stack gates**

```text
bun run supabase:start
bun run test:db
```

Expected: `Started supabase local development setup.`; `test:db` ends `Result: PASS` (`Files=1, Tests=8`).

Start `bun run supabase:serve` in a background terminal, then:

```text
curl.exe -sS http://127.0.0.1:54321/functions/v1/health
```

Expected: `{"ok":true,"version":"0.0.1","time":"..."}`. Stop the serve process, then run `bun run supabase:stop`.

- [ ] **Step 5: Run the browser gate**

Run: `bun run test:e2e`
Expected: build, then `5 passed` in Chromium (shell and navigation, SPA deep link, manifest and `sw.js`, service worker scope `/`, theme persistence).

- [ ] **Step 6: Verify that nothing secret or local is tracked**

```text
git ls-files | Select-String -Pattern '(^|/)\.env' | Where-Object { $_ -notmatch '\.env\.example$' }
git ls-files supabase/.temp apps/web/dist apps/web/playwright-report apps/web/test-results .wrangler
git grep -n -I -E "sb_secret_|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}" -- apps supabase .github
```

Expected: all three print nothing. Files that must never be committed: `.env`, `.env.local`, any `.env.*` except `.env.example`, `supabase/functions/.env`, the keys and URLs printed by `supabase start`, `supabase/.temp/**`, `supabase/.branches/**`, `apps/web/dist/**`, `playwright-report/`, `test-results/`, `.wrangler/`, `node_modules/`, and any file containing a service-role key, `sb_secret_...`, `CRON_SHARED_SECRET`, `FLEX_ENC_KEY_*`, `VAPID_PRIVATE_KEY`, `RESEND_API_KEY` or a keep-alive password. If any command prints a path, remove it from the index with `git rm --cached <path>`, fix `.gitignore`, and rotate the exposed value.

- [ ] **Step 7: Write the verification record `docs/discovery/p0-results.md`**

The first four rows answer spec P0-01 to P0-04. For each row replace the text after `Observed:` with what actually happened while executing Tasks 1 to 6 (the plan states the expected outcome and the fallback that was prepared); keep the other cells.

```markdown
# P0 verification results

Written at the end of P0 (spec section 18). Environment: Windows 11, Bun 1.3.14, Node 22.13.1,
Deno 2.9.6 locally and 2.1.x in CI, Supabase CLI 2.121.0, TypeScript 6.0.3, Biome 2.5.15.

| ID | Question | Expected / prepared fallback | Evidence and result |
|---|---|---|---|
| P0-01 | Do Bun 1.3 workspaces and `bun run --filter` work on the Windows dev machine, and does Vitest run under Node? | Expected yes. Fallbacks: `bun --cwd apps/web run <script>` in the root scripts; `node node_modules/vitest/vitest.mjs run --project <name>` for the `test:*` scripts. `linker = "hoisted"` is required because Bun 1.3 defaults to isolated installs. | Observed: |
| P0-02 | Do import-map prefixes pointing outside the function directory (`@core/`, `@adapters/`) bundle correctly with the Supabase CLI, and does `deno check` enforce `.ts` extensions? (A-21) | Expected yes (the `health` function imports through both prefixes). Fallback: relative imports `../_shared/...` in function code. `.ts` enforcement: `bun run functions:selftest` proves extensionless imports fail `functions:check`. | Observed: |
| P0-03 | Do `supabase db push` and `supabase functions deploy` work in GitHub Actions? | Unverified until the first manual run of "Deploy Supabase" with real secrets (needs the hosted project, outside this plan). `--skip-vault`, `--yes` and `--dry-run` flags were confirmed with `bunx supabase db push --help` on CLI 2.121.0. | Observed: not run in P0; first run pending operator secrets. |
| P0-04 | Exact TypeScript 6.x version and Biome compatibility; TS 7 deferred. | TypeScript 6.0.3 is the highest 6.x on npm on 2026-10-15 (`npm view typescript versions --json`); npm `latest` is 7.0.2 and is not adopted until Biome, vite-plugin-pwa types and Vitest are verified against it. | Observed: |
| T-01 | `bunx` argument passing on Windows (spec 3.2) | `bunx supabase ...`, `bunx playwright install chromium`, `bunx shadcn@4.21.5 add ...` expected to work; fallbacks: `node node_modules/@playwright/test/cli.js install chromium`, `npx shadcn@4.21.5 add ...`. | Observed: |
| T-02 | Biome `correctness/useImportExtensions` limited to `supabase/functions/**` | Verified during planning with Biome 2.5.15: overrides and a nested `biome.json` (`extends: "//"`) did not apply the rule; only a global setting does. The `.ts` rule is enforced by `deno check` and `tools/check-core-purity.ts` instead (spec 3.5 allows this). | Observed: |
| T-03 | DOM plus WebWorker libs in `apps/web/tsconfig.json` (spec 3.6) | Expected to type-check with `skipLibCheck`. Fallback: `apps/web/tsconfig.sw.json` for `sw.ts` only (Task 4 Step 10). | Observed: |
| T-04 | Location of the pgTAP file for `supabase test db` | Expected `supabase/tests/0001_smoke.test.sql` to be found. Fallback: `supabase/tests/database/`. | Observed: |
| T-05 | Hosted-project items (spec P0-05 to P0-07: pg_cron/pg_net versions, platform env variable names, keep-alive user end to end) | Outside this plan: they need the hosted Supabase project. The keep-alive workflow is gated by `KEEPALIVE_ENABLED` and the dedicated user is created per `docs/operator-guide.md` section 12. | Observed: deferred to the operator. |
```

- [ ] **Step 8: Add the pointer line to the specification**

In `docs/superpowers/specs/2026-10-15-stock-screener-design.md`, section 19.2, directly after the last table row (the one starting `| Q-17 |`) and before the `---` line, insert one blank line and:

```markdown
P0 verification results (P0-01 to P0-04 and tooling findings): `docs/discovery/p0-results.md`.
```

- [ ] **Step 9: Commit the record**

```text
git add docs/discovery/p0-results.md docs/superpowers/specs/2026-10-15-stock-screener-design.md
git commit -m "docs: record P0 verification results"
```

- [ ] **Step 10: Push and confirm CI (requires a GitHub remote)**

If a remote exists: `git push origin master`, then `gh run watch` on the latest `CI` run. Expected: jobs `web`, `deno`, `db` and `e2e` are green (spec P0 exit: "`ci.yml` green"). If `deno` fails only because of the 2.1.x versus 2.9.6 difference, fix the code to satisfy both (preferred) or raise `deno-version` and note it in `docs/discovery/p0-results.md`. If no remote exists yet, the owner pushes later and this step is the first action of that push.

P0 is complete when: Steps 1 to 6 are green locally, CI is green, `docs/discovery/p0-results.md` has an observed result in every row, and the owner has accepted or amended the specification.

