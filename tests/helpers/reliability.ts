import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256, stableJson } from "../../src/shared/crypto.js";

export const RELIABILITY_SEED = parseBoundedInteger(process.env.COPE_RELIABILITY_SEED, 0x434f5045, 1, 0xffff_ffff);
export const RELIABILITY_ITERATIONS = parseBoundedInteger(process.env.COPE_RELIABILITY_ITERATIONS, 24, 1, 500);

export class SeededRandom {
  private state: number;

  public constructor(public readonly seed: number) {
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

export class InjectedFault extends Error {
  public constructor(public readonly checkpoint: string, public readonly occurrence: number) {
    super(`Injected deterministic fault at ${checkpoint}#${occurrence}`);
    this.name = "InjectedFault";
  }
}

export class FaultSchedule {
  private readonly observed: Array<{ readonly checkpoint: string; readonly occurrence: number }> = [];
  private occurrence = 0;

  public constructor(
    public readonly seed: number,
    private readonly failAt?: number,
  ) {}

  public checkpoint(name: string): void {
    this.occurrence += 1;
    this.observed.push({ checkpoint: name, occurrence: this.occurrence });
    if (this.occurrence === this.failAt) throw new InjectedFault(name, this.occurrence);
  }

  public trace(): readonly { readonly checkpoint: string; readonly occurrence: number }[] {
    return [...this.observed];
  }
}

export async function reliabilityScenario(
  name: string,
  seed: number,
  scenario: (random: SeededRandom) => Promise<void>,
): Promise<void> {
  try {
    await scenario(new SeededRandom(seed));
  } catch (error) {
    await writeDiagnostic(name, seed, error);
    throw error;
  }
}

async function writeDiagnostic(name: string, seed: number, error: unknown): Promise<void> {
  const directory = process.env.COPE_RELIABILITY_ARTIFACT_DIR;
  if (directory === undefined || directory === "") return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safeName = name.replaceAll(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 96);
  const body = {
    schemaVersion: 1,
    scenario: name,
    seed,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorFingerprint: sha256(error instanceof Error ? error.message : String(error)),
  };
  await writeFile(path.join(directory, `${safeName}-${seed}.json`), `${stableJson(body)}\n`, {
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
