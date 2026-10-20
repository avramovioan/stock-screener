import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));

it("the core parity fixture equals the discovery copy value for value (formatting may differ)", () => {
  expect(read("./fixtures/stddevchn-synthetic.json")).toEqual(
    read("../../../../docs/discovery/fixtures/stddevchn-synthetic.json"),
  );
});
