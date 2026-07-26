import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256, stableJson } from "../../src/shared/crypto.js";

export const RELIABILITY_SEED = parseBoundedInteger(
  process.env.COPE_RELIABILITY_SEED,
  0x434f5045,
  1,
  0xffff_ffff,
);
export const RELIABILITY_ITERATIONS = parseBoundedInteger(
  process.env.COPE_RELIABILITY_ITERATIONS,
  24,
  1,
  500,
);

export class SeededRandom {
  private state: number;

  public constructor(public readonly seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffff_ffff) {
      throw new Error("seed must be a nonzero unsigned 32-bit integer");
    }
    this.state = seed >>> 0;
  }

  public nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  public integer(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) throw new Error("invalid random bound");
    return this.nextUint32() % maxExclusive;
  }

  public text(maxLength = 256): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-\n";
    const length = this.integer(maxLength + 1);
    let result = "";
    for (let index = 0; index < length; index += 1) result += alphabet[this.integer(alphabet.length)];
    return result;
  }
}

export function deriveScenarioSeed(baseSeed: number, scenario: string): number {
  const derived = Number.parseInt(sha256(stableJson({ baseSeed, scenario })).slice(0, 8), 16) >>> 0;
  return derived === 0 ? 1 : derived;
}

export async function reliabilityScenario(
  name: string,
  baseSeed: number,
  scenario: (random: SeededRandom, scenarioSeed: number) => Promise<void>,
): Promise<void> {
  const scenarioSeed = deriveScenarioSeed(baseSeed, name);
  try {
    await scenario(new SeededRandom(scenarioSeed), scenarioSeed);
  } catch (error) {
    await writeDiagnostic(name, baseSeed, scenarioSeed, error);
    throw error;
  }
}

async function writeDiagnostic(
  name: string,
  baseSeed: number,
  scenarioSeed: number,
  error: unknown,
): Promise<void> {
  const directory = process.env.COPE_RELIABILITY_ARTIFACT_DIR;
  if (directory === undefined || directory === "") return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safeName = name.replaceAll(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 96);
  const body = {
    schemaVersion: 2,
    scenario: name,
    baseSeed,
    scenarioSeed,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorFingerprint: sha256(error instanceof Error ? error.message : String(error)),
  };
  await writeFile(path.join(directory, `${safeName}-${baseSeed}.json`), `${stableJson(body)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function parseBoundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Reliability setting must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}
