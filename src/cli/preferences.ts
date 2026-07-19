import { constants } from "node:fs";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

import type { AutonomyMode } from "../session/types.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

const PREFERENCES_SCHEMA_VERSION = "cope-preferences/1" as const;
const MAX_PREFERENCES_BYTES = 64 * 1024;

export interface CopePreferences {
  readonly schema_version: typeof PREFERENCES_SCHEMA_VERSION;
  readonly mode: AutonomyMode;
  readonly last_repository?: string;
}

export async function loadPreferences(stateHome: string): Promise<CopePreferences> {
  const filename = preferencesPath(stateHome);
  try {
    const metadata = await stat(filename);
    if (!metadata.isFile() || metadata.size > MAX_PREFERENCES_BYTES) return defaults();
    return parsePreferences(JSON.parse(await readFile(filename, "utf8")) as unknown);
  } catch {
    return defaults();
  }
}

export async function updatePreferences(
  stateHome: string,
  update: { readonly mode?: AutonomyMode; readonly lastRepository?: string },
): Promise<CopePreferences> {
  const current = await loadPreferences(stateHome);
  const repository = update.lastRepository ?? current.last_repository;
  const next: CopePreferences = {
    schema_version: PREFERENCES_SCHEMA_VERSION,
    mode: update.mode ?? current.mode,
    ...(repository === undefined ? {} : { last_repository: path.resolve(repository) }),
  };
  await writePreferences(preferencesPath(stateHome), next);
  return next;
}

export function preferencesPath(stateHome: string): string {
  return path.join(path.resolve(stateHome), "preferences.json");
}

function parsePreferences(value: unknown): CopePreferences {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return defaults();
  const record = value as Readonly<Record<string, unknown>>;
  const mode = record.mode;
  const repository = record.last_repository;
  if (
    record.schema_version !== PREFERENCES_SCHEMA_VERSION ||
    (mode !== "inspect" && mode !== "edit" && mode !== "auto") ||
    (repository !== undefined && (typeof repository !== "string" || !path.isAbsolute(repository)))
  ) return defaults();
  return {
    schema_version: PREFERENCES_SCHEMA_VERSION,
    mode,
    ...(repository === undefined ? {} : { last_repository: path.resolve(repository) }),
  };
}

function defaults(): CopePreferences {
  return { schema_version: PREFERENCES_SCHEMA_VERSION, mode: "edit" };
}

async function writePreferences(filename: string, value: CopePreferences): Promise<void> {
  const directoryName = path.dirname(filename);
  await mkdir(directoryName, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  if (CURRENT_HOST_PLATFORM.supportsDirectoryFsync) {
    const directory = await open(directoryName, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
