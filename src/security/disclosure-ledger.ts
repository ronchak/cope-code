import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { newId, sha256, stableJson } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";
import type { Clock } from "../shared/time.js";
import { systemClock } from "../shared/time.js";
import type { SecretFinding } from "./secrets.js";
import { safeFinding } from "./secrets.js";

export const DISCLOSURE_LEDGER_VERSION = "disclosure-ledger.v1" as const;

export interface DisclosureRecordInput {
  readonly operationId: string;
  readonly source: "repository-file" | "repository-search" | "command-output" | "tool-result";
  readonly content: string;
  readonly originalByteCount: number;
  readonly path?: string;
  readonly findings?: readonly SecretFinding[];
  readonly disclosed?: boolean;
  readonly classification?: string;
}

export interface DisclosureRecord {
  readonly version: typeof DISCLOSURE_LEDGER_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly timestamp: string;
  readonly source: DisclosureRecordInput["source"];
  readonly path?: string;
  readonly classification: string;
  readonly disclosed: boolean;
  readonly originalByteCount: number;
  readonly disclosedByteCount: number;
  readonly disclosedSha256: string;
  readonly redactions: readonly ReturnType<typeof safeFinding>[];
  readonly previousRecordHash: string | null;
  readonly recordHash: string;
}

export interface DisclosureLedgerOptions {
  readonly outputFile?: string;
  readonly clock?: Clock;
}

export class DisclosureLedger {
  private readonly entries: DisclosureRecord[] = [];
  private readonly outputFile: string | undefined;
  private readonly clock: Clock;
  private writeChain: Promise<void>;

  public constructor(
    public readonly sessionId: string,
    options: DisclosureLedgerOptions = {},
  ) {
    this.outputFile = options.outputFile;
    this.clock = options.clock ?? systemClock;
    this.writeChain = this.hydrateExisting();
  }

  public async record(input: DisclosureRecordInput): Promise<DisclosureRecord> {
    let created: DisclosureRecord | undefined;
    const operation = this.writeChain.then(async () => {
      const redactions = Object.freeze((input.findings ?? []).map(safeFinding));
      const body = {
        version: DISCLOSURE_LEDGER_VERSION,
        id: newId("disclosure"),
        sessionId: this.sessionId,
        operationId: input.operationId,
        timestamp: this.clock.now().toISOString(),
        source: input.source,
        ...(input.path === undefined ? {} : { path: input.path }),
        classification: input.classification ?? "unclassified",
        disclosed: input.disclosed ?? true,
        originalByteCount: input.originalByteCount,
        disclosedByteCount: Buffer.byteLength(input.content),
        disclosedSha256: sha256(input.content),
        redactions,
        previousRecordHash: this.entries.at(-1)?.recordHash ?? null,
      };
      const record: DisclosureRecord = Object.freeze({
        ...body,
        recordHash: sha256(stableJson(body)),
      });
      if (this.outputFile !== undefined) {
        await mkdir(path.dirname(this.outputFile), { recursive: true, mode: 0o700 });
        await appendFile(this.outputFile, `${stableJson(record)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flush: true,
        });
      }
      this.entries.push(record);
      created = record;
    });
    // Keep failures sticky: a new genesis record must never be appended after
    // an unreadable or corrupt prior chain.
    this.writeChain = operation;
    await operation;
    if (created === undefined) {
      throw new Error("Disclosure record was not created");
    }
    return created;
  }

  public records(): readonly DisclosureRecord[] {
    return this.entries.map((entry) => ({ ...entry, redactions: [...entry.redactions] }));
  }

  public verifyIntegrity(): boolean {
    return verifyRecords(this.entries);
  }

  public static async verifyFile(outputFile: string): Promise<boolean> {
    const raw = await readFile(outputFile, "utf8");
    const records: DisclosureRecord[] = [];
    for (const line of raw.split(/\r?\n/u)) {
      if (line === "") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return false;
      }
      if (!isDisclosureRecord(parsed)) {
        return false;
      }
      records.push(parsed);
    }
    return verifyRecords(records);
  }

  public async initialize(): Promise<void> {
    await this.writeChain;
  }

  private async hydrateExisting(): Promise<void> {
    if (this.outputFile === undefined) return;
    let raw: string;
    try {
      raw = await readFile(this.outputFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (raw.length === 0) return;
    if (!raw.endsWith("\n")) throw new AgentError("RECOVERY_REQUIRED", "Disclosure ledger ends with a partial record");
    const records: DisclosureRecord[] = [];
    for (const line of raw.slice(0, -1).split(/\r?\n/u)) {
      if (line.length === 0) throw new AgentError("RECOVERY_REQUIRED", "Disclosure ledger contains a blank record");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        throw new AgentError("RECOVERY_REQUIRED", "Disclosure ledger contains invalid JSON", {}, { cause: error });
      }
      if (!isDisclosureRecord(parsed) || parsed.sessionId !== this.sessionId) {
        throw new AgentError("RECOVERY_REQUIRED", "Disclosure ledger identity or schema is invalid");
      }
      records.push(parsed);
    }
    if (!verifyRecords(records)) throw new AgentError("RECOVERY_REQUIRED", "Disclosure ledger integrity check failed");
    this.entries.push(...records);
  }
}

function verifyRecords(records: readonly DisclosureRecord[]): boolean {
  let previous: string | null = null;
  for (const record of records) {
    const { recordHash, ...body } = record;
    if (record.previousRecordHash !== previous || sha256(stableJson(body)) !== recordHash) {
      return false;
    }
    previous = recordHash;
  }
  return true;
}

function isDisclosureRecord(value: unknown): value is DisclosureRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DisclosureRecord>;
  return (
    candidate.version === DISCLOSURE_LEDGER_VERSION &&
    typeof candidate.id === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.operationId === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.classification === "string" &&
    typeof candidate.disclosed === "boolean" &&
    typeof candidate.originalByteCount === "number" &&
    typeof candidate.disclosedByteCount === "number" &&
    typeof candidate.disclosedSha256 === "string" &&
    Array.isArray(candidate.redactions) &&
    (candidate.previousRecordHash === null || typeof candidate.previousRecordHash === "string") &&
    typeof candidate.recordHash === "string"
  );
}
