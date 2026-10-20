import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { duplicateDependencyProblems, type PackageJson } from "./dup-deps.ts";

const read = (relative: string): PackageJson =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
  ) as PackageJson;

describe("duplicateDependencyProblems", () => {
  it("allows a package in both files only with the same range", () => {
    const root = { devDependencies: { vite: "^8.3.4", vitest: "^5.0.4" } };
    expect(
      duplicateDependencyProblems(root, [
        { name: "web", pkg: { devDependencies: { vite: "^8.3.4" } } },
      ]),
    ).toEqual([]);
    expect(
      duplicateDependencyProblems(root, [
        { name: "web", pkg: { devDependencies: { vite: "^8.0.0" } } },
      ]),
    ).toEqual(["vite: root declares ^8.3.4 but web declares ^8.0.0"]);
  });
  it("holds for the committed package.json files", () => {
    expect(
      duplicateDependencyProblems(read("../../package.json"), [
        { name: "apps/web", pkg: read("../../apps/web/package.json") },
      ]),
    ).toEqual([]);
  });
});
