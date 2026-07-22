import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { sha256, stableJson } from "../shared/crypto.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import type { Clock } from "../shared/time.js";
import { systemClock } from "../shared/time.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";
import type { SessionState } from "./types.js";

export const CONTEXT_LEDGER_VERSION = "cope-context-ledger/1" as const;
export const CONTINUATION_CAPSULE_VERSION = "cope-continuation-capsule/1" as const;
const GENESIS_HASH = "0".repeat(64);
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;

export interface ContextLedgerRecord {
  readonly schemaVersion: typeof CONTEXT_LEDGER_VERSION;
  readonly sequence: number;
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly direction: "outbound" | "inbound";
  readonly kind: "bootstrap" | "tool_result" | "repair" | "decision" | "model_response";
  readonly bytes: number;
  readonly contentSha256: string;
  readonly recordedAt: string;
  readonly previousHash: string;
  readonly recordHash: string;
}

export interface ContextLedgerSummary {
  readonly records: number;
  readonly outboundMessages: number;
  readonly inboundMessages: number;
  readonly outboundBytes: number;
  readonly inboundBytes: number;
  readonly lastTurnId: string | null;
  readonly finalHash: string;
}

export interface ContinuationCapsule {
  readonly schemaVersion: typeof CONTINUATION_CAPSULE_VERSION;
  readonly sessionId: string;
  readonly taskId: string;
  readonly sourceConversationIdHash: string | null;
  readonly createdAt: string;
  readonly state: {
    readonly status: SessionState["status"];
    readonly turnSequence: number;
    readonly mutationSequence: number;
    readonly completedOperationCount: number;
    readonly pendingOperationCount: number;
    readonly lastCheckpointId: string | null;
    readonly lastModelSummaryHash: string | null;
  };
  readonly authority: {
    readonly mode: SessionState["mode"];
    readonly policyHashes: SessionState["policyHashes"];
    readonly budgetLimits: SessionState["budgetLimits"];
    readonly budgetUsage: SessionState["budgetUsage"];
  };
  readonly context: ContextLedgerSummary;
  readonly capsuleHash: string;
}

export class ContextLedger {
  public constructor(
    private readonly filename: string,
    private readonly sessionId: string,
    private readonly taskId: string,
    private readonly clock: Clock = systemClock,
  ) {}

  public async append(input: Pick<ContextLedgerRecord, "turnId" | "direction" | "kind"> & { readonly content: string }): Promise<ContextLedgerRecord> {
    const records = await this.read();
    const contentSha256 = sha256(input.content);
    const existing = records.find((record) => record.turnId === input.turnId && record.direction === input.direction);
    if (existing !== undefined) {
      if (existing.kind === input.kind && existing.contentSha256 === contentSha256 && existing.bytes === Buffer.byteLength(input.content)) {
        return existing;
      }
      throw new AgentError("RECOVERY_REQUIRED", "Context ledger turn/direction identity was reused with different content", {
        turnId: input.turnId, direction: input.direction,
      });
    }
    const base = {
      schemaVersion: CONTEXT_LEDGER_VERSION,
      sequence: records.length + 1,
      sessionId: this.sessionId,
      taskId: this.taskId,
      turnId: input.turnId,
      direction: input.direction,
      kind: input.kind,
      bytes: Buffer.byteLength(input.content),
      contentSha256,
      recordedAt: this.clock.now().toISOString(),
      previousHash: records.at(-1)?.recordHash ?? GENESIS_HASH,
    } as const;
    const record: ContextLedgerRecord = { ...base, recordHash: sha256(stableJson(base)) };
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const handle = await open(this.filename, "a", 0o600);
    try {
      await handle.writeFile(`${stableJson(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return record;
  }

  public async read(): Promise<readonly ContextLedgerRecord[]> {
    let content: string;
    try {
      content = await readFile(this.filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new AgentError("RECOVERY_REQUIRED", `Cannot read context ledger: ${errorMessage(error)}`);
    }
    if (Buffer.byteLength(content) > MAX_LEDGER_BYTES || !content.endsWith("\n") || content.charCodeAt(0) === 0xfeff) {
      throw new AgentError("RECOVERY_REQUIRED", "Context ledger is partial, oversized, or contains an unsupported BOM");
    }
    let prior = GENESIS_HASH;
    return content.slice(0, -1).split("\n").map((line, index) => {
      const record = JSON.parse(line) as ContextLedgerRecord;
      const { recordHash, ...base } = record;
      if (
        record.schemaVersion !== CONTEXT_LEDGER_VERSION || record.sequence !== index + 1 ||
        record.sessionId !== this.sessionId || record.taskId !== this.taskId ||
        record.previousHash !== prior || recordHash !== sha256(stableJson(base)) ||
        !/^turn_[0-9]{4,}$/u.test(record.turnId) || !Number.isFinite(Date.parse(record.recordedAt)) ||
        !/^[a-f0-9]{64}$/u.test(record.contentSha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 ||
        !["outbound", "inbound"].includes(record.direction) ||
        !["bootstrap", "tool_result", "repair", "decision", "model_response"].includes(record.kind)
      ) throw new AgentError("RECOVERY_REQUIRED", "Context ledger integrity check failed", { sequence: index + 1 });
      prior = recordHash;
      return record;
    });
  }

  public async summary(): Promise<ContextLedgerSummary> {
    const records = await this.read();
    return {
      records: records.length,
      outboundMessages: records.filter((item) => item.direction === "outbound").length,
      inboundMessages: records.filter((item) => item.direction === "inbound").length,
      outboundBytes: records.filter((item) => item.direction === "outbound").reduce((sum, item) => sum + item.bytes, 0),
      inboundBytes: records.filter((item) => item.direction === "inbound").reduce((sum, item) => sum + item.bytes, 0),
      lastTurnId: records.at(-1)?.turnId ?? null,
      finalHash: records.at(-1)?.recordHash ?? GENESIS_HASH,
    };
  }
}

export async function createContinuationCapsule(state: SessionState, ledger: ContextLedger, createdAt: string): Promise<ContinuationCapsule> {
  const base = {
    schemaVersion: CONTINUATION_CAPSULE_VERSION,
    sessionId: state.sessionId,
    taskId: state.taskId,
    sourceConversationIdHash: state.transportConversationId === undefined ? null : sha256(state.transportConversationId),
    createdAt,
    state: {
      status: state.status, turnSequence: state.turnSequence, mutationSequence: state.mutationSequence,
      completedOperationCount: state.completedOperationIds.length, pendingOperationCount: state.pendingOperations.length,
      lastCheckpointId: state.lastCheckpointId ?? null, lastModelSummaryHash: state.lastModelSummaryHash ?? null,
    },
    authority: { mode: state.mode, policyHashes: state.policyHashes, budgetLimits: state.budgetLimits, budgetUsage: state.budgetUsage },
    context: await ledger.summary(),
  } as const;
  return { ...base, capsuleHash: sha256(stableJson(base)) };
}

export async function writeContinuationCapsule(filename: string, capsule: ContinuationCapsule): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${stableJson(capsule)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filename);
  if (CURRENT_HOST_PLATFORM.supportsDirectoryFsync) {
    const directory = await open(path.dirname(filename), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
