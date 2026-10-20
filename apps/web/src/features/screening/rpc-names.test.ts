import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RPC } from "./rpc-names";

describe("RPC names exist in the generated database types", () => {
  const types = readFileSync(resolve(__dirname, "../../lib/database.types.ts"), "utf8");
  for (const [key, name] of Object.entries(RPC)) {
    it(`${key} -> ${name}`, () => {
      expect(types).toMatch(new RegExp(`"${name}":\\s*\\{`));
    });
  }
});
