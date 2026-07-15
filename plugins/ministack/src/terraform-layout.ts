import { isAbsolute, relative, resolve, sep } from "node:path";

interface TerraformRootPath {
  configured: string;
  absolute: string;
}

/**
 * Assign project-relative variable files to their most specific configured
 * Terraform root and return paths relative to that root.
 */
export function routeTerraformVariableFiles(
  projectRoot: string,
  roots: readonly string[],
  variableFiles: readonly string[],
): Map<string, string[]> {
  const absoluteProjectRoot = resolve(projectRoot);
  const seenRoots = new Map<string, string>();
  const rootPaths: TerraformRootPath[] = roots.map((configured) => {
    const absolute = resolve(absoluteProjectRoot, configured);
    assertInside(absoluteProjectRoot, absolute, `Terraform root must remain inside the project: ${configured}`);
    const duplicate = seenRoots.get(absolute);
    if (duplicate !== undefined) {
      throw new Error(`Terraform roots ${duplicate} and ${configured} resolve to the same directory`);
    }
    seenRoots.set(absolute, configured);
    return { configured, absolute };
  });
  const routed = new Map(roots.map((root) => [root, [] as string[]]));
  const seenVariableFiles = new Map<string, string>();

  for (const variableFile of variableFiles) {
    const absoluteVariableFile = resolve(absoluteProjectRoot, variableFile);
    assertInside(
      absoluteProjectRoot,
      absoluteVariableFile,
      `Terraform variable file must remain inside the project: ${variableFile}`,
    );
    const duplicate = seenVariableFiles.get(absoluteVariableFile);
    if (duplicate !== undefined) {
      throw new Error(`Terraform variable files ${duplicate} and ${variableFile} resolve to the same file`);
    }
    seenVariableFiles.set(absoluteVariableFile, variableFile);
    const owners = rootPaths.filter((root) => isInside(root.absolute, absoluteVariableFile));
    if (owners.length === 0) {
      throw new Error(
        `Terraform variable file is not inside any configured Terraform root: ${variableFile}; paths are project-relative`,
      );
    }
    const owner = owners.sort((left, right) =>
      pathDepth(right.absolute) - pathDepth(left.absolute)
      || left.configured.localeCompare(right.configured)
    )[0];
    if (owner === undefined) continue;
    const relativeVariableFile = relative(owner.absolute, absoluteVariableFile).split(sep).join("/");
    routed.get(owner.configured)?.push(relativeVariableFile);
  }

  return routed;
}

function assertInside(parent: string, candidate: string, message: string): void {
  if (!isInside(parent, candidate)) throw new Error(message);
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function pathDepth(path: string): number {
  return resolve(path).split(sep).filter((part) => part.length > 0).length;
}
