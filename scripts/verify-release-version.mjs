import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACTIVE_RELEASE_SURFACES = new Map([
  ["src/cli/commands.ts", {}],
  ["scripts/install-windows.ps1", {}],
  ["scripts/install-macos.sh", {}],
  ["START-HERE.txt", {}],
  ["docs/WINDOWS-TARGET.md", { "10.0.22631": 1, "24.17.0": 1, "11.13.0": 1, "2.55.0": 1 }],
  ["tests/unit/cli-user-experience.test.ts", {}],
]);

// Do not match one three-part prefix inside a four-part browser version.
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SEMVER_LITERAL = /(?<![0-9.])(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![0-9]|\.[0-9])/gu;

export async function verifyReleaseVersion(root) {
  const errors = [];
  const packageJson = await readJson(root, "package.json", errors);
  const packageLock = await readJson(root, "package-lock.json", errors);
  const packageVersion = packageJson?.version;

  if (typeof packageVersion !== "string" || !SEMVER.test(packageVersion)) {
    errors.push("package.json must contain a complete semantic version");
  }

  if (packageLock?.name !== packageJson?.name) {
    errors.push("package-lock.json name must match package.json");
  }
  if (packageLock?.version !== packageVersion) {
    errors.push("package-lock.json top-level version must match package.json");
  }
  if (packageLock?.packages?.[""]?.name !== packageJson?.name) {
    errors.push('package-lock.json packages[""] name must match package.json');
  }
  if (packageLock?.packages?.[""]?.version !== packageVersion) {
    errors.push('package-lock.json packages[""] version must match package.json');
  }

  for (const [filename, allowedNonReleaseVersions] of ACTIVE_RELEASE_SURFACES) {
    let content;
    try {
      content = await readFile(path.join(root, filename), "utf8");
    } catch (error) {
      errors.push(`${filename} could not be read: ${errorMessage(error)}`);
      continue;
    }
    const remainingAllowances = new Map(Object.entries(allowedNonReleaseVersions));
    const literals = [];
    for (const match of content.matchAll(SEMVER_LITERAL)) {
      const literal = match[0];
      const remaining = remainingAllowances.get(literal) ?? 0;
      if (remaining > 0) {
        remainingAllowances.set(literal, remaining - 1);
      } else {
        literals.push(literal);
      }
    }
    if (literals.length > 0) {
      errors.push(`${filename} contains release-like version literal(s): ${literals.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Release version verification failed:\n- ${errors.join("\n- ")}`);
  }
  return packageVersion;
}

async function readJson(root, filename, errors) {
  try {
    return JSON.parse(await readFile(path.join(root, filename), "utf8"));
  } catch (error) {
    errors.push(`${filename} is not valid readable JSON: ${errorMessage(error)}`);
    return undefined;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const version = await verifyReleaseVersion(process.cwd());
    process.stdout.write(`Release version ${version} is synchronized.\n`);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
