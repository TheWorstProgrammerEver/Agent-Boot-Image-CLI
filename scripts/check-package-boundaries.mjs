import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(scriptDirectory, "..");

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const collectTypeScriptFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectTypeScriptFiles(path);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );

  return files.flat();
};

const collectModuleSpecifiers = (source) => {
  const specifiers = [];

  const visit = (node) => {
    const staticSpecifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier;
    const dynamicSpecifier =
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0];
    const importTypeSpecifier =
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      node.argument.literal;

    if (staticSpecifier && ts.isStringLiteral(staticSpecifier)) {
      specifiers.push(staticSpecifier.text);
    }

    if (dynamicSpecifier && ts.isStringLiteral(dynamicSpecifier)) {
      specifiers.push(dynamicSpecifier.text);
    }

    if (importTypeSpecifier && ts.isStringLiteral(importTypeSpecifier)) {
      specifiers.push(importTypeSpecifier.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return specifiers;
};

const workspaceNameFromSpecifier = (specifier, prefix) => {
  if (!specifier.startsWith(prefix)) {
    return undefined;
  }

  return `${prefix}${specifier.slice(prefix.length).split("/")[0]}`;
};

export const checkPackageBoundaries = async ({ root = defaultRoot } = {}) => {
  const boundaryConfig = await readJson(join(root, "config/package-boundaries.json"));
  const packageEntries = Object.entries(boundaryConfig.packages);
  const manifests = new Map();

  for (const [directory] of packageEntries) {
    manifests.set(directory, await readJson(join(root, "packages", directory, "package.json")));
  }

  const workspaceNames = new Set([...manifests.values()].map(({ name }) => name));
  const errors = [];

  for (const [directory, allowedDirectories] of packageEntries) {
    const manifest = manifests.get(directory);
    const allowedNames = new Set(
      allowedDirectories.map((allowedDirectory) => manifests.get(allowedDirectory).name),
    );
    const declaredDependencies = Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }).filter((name) => workspaceNames.has(name));

    for (const dependency of declaredDependencies) {
      if (!allowedNames.has(dependency)) {
        errors.push(`${manifest.name} declares disallowed dependency ${dependency}`);
      }
    }

    const missingDependencies = [...allowedNames].filter(
      (dependency) => !declaredDependencies.includes(dependency),
    );
    for (const dependency of missingDependencies) {
      errors.push(`${manifest.name} is missing boundary dependency ${dependency}`);
    }

    const sourceDirectory = join(root, "packages", directory, "src");
    for (const path of await collectTypeScriptFiles(sourceDirectory)) {
      const source = ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );

      for (const specifier of collectModuleSpecifiers(source)) {
        const dependency = workspaceNameFromSpecifier(specifier, boundaryConfig.packagePrefix);
        if (dependency && workspaceNames.has(dependency) && !allowedNames.has(dependency)) {
          errors.push(
            `${relative(root, path)} imports disallowed workspace package ${dependency}`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Package boundary violations:\n${errors.join("\n")}`);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkPackageBoundaries();
  process.stdout.write("Package boundaries are valid.\n");
}
