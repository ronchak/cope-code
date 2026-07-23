import { createRequire } from "node:module";

interface PackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
}

const require = createRequire(import.meta.url);
const packageMetadata = require("../../../package.json") as PackageMetadata;

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("The installed package metadata does not contain a release version.");
}

/** The package manifest is the single release-version authority. */
export const RELEASE_VERSION = packageMetadata.version;
