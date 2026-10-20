export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** A package declared in the root and in a workspace must use the same range (version drift risk, ledger D-10). */
export function duplicateDependencyProblems(
  root: PackageJson,
  workspaces: Array<{ name: string; pkg: PackageJson }>,
): string[] {
  const rootDeps = { ...root.dependencies, ...root.devDependencies };
  const problems: string[] = [];
  for (const ws of workspaces) {
    for (const [name, range] of Object.entries({
      ...ws.pkg.dependencies,
      ...ws.pkg.devDependencies,
    })) {
      const rootRange = rootDeps[name];
      if (rootRange !== undefined && rootRange !== range) {
        problems.push(`${name}: root declares ${rootRange} but ${ws.name} declares ${range}`);
      }
    }
  }
  return problems;
}
