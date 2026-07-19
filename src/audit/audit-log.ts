import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256, stableJson } from "../shared/crypto.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import { isOperationId } from "../shared/operation-id.js";
import type { Clock } from "../shared/time.js";
import { systemClock } from "../shared/time.js";
import { AUDIT_EVENT_TYPES, AUDIT_SCHEMA_VERSION, type AuditEvent, type AuditEventInput } from "./types.js";

const GENESIS_HASH = "0".repeat(64);

export class AuditLog {
  private sequence = 0;
  private previousHash = GENESIS_HASH;
  private initialized = false;

  public constructor(
    private readonly filename: string,
    private readonly sessionId: string,
    private readonly clock: Clock = systemClock,
  ) {}

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    let content = "";
    try {
      content = await readFile(this.filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (content.length > 0) {
      const verification = verifyAuditText(content, this.sessionId);
      this.sequence = verification.events.length;
      this.previousHash = verification.finalHash;
    }
    this.initialized = true;
  }

  public async append(input: AuditEventInput): Promise<AuditEvent> {
    await this.initialize();
    if (input.operationId !== undefined && !isOperationId(input.operationId)) {
      throw new AgentError("PROTOCOL_INVALID", "Audit operation identifier does not satisfy the cba/1 contract");
    }
    const base = {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      sequence: this.sequence + 1,
      sessionId: this.sessionId,
      timestamp: this.clock.now().toISOString(),
      previousHash: this.previousHash,
      ...input,
    } as const;
    const event: AuditEvent = {
      ...base,
      eventHash: sha256(stableJson(base)),
    };
    const handle = await open(this.filename, "a", 0o600);
    try {
      await handle.writeFile(`${stableJson(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.sequence = event.sequence;
    this.previousHash = event.eventHash;
    return event;
  }

  public static async verify(filename: string, expectedSessionId: string): Promise<readonly AuditEvent[]> {
    try {
      return verifyAuditText(await readFile(filename, "utf8"), expectedSessionId).events;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError("RECOVERY_REQUIRED", `Audit verification failed: ${errorMessage(error)}`, {}, {
        cause: error,
      });
    }
  }
}

function verifyAuditText(
  content: string,
  expectedSessionId: string,
): { readonly events: readonly AuditEvent[]; readonly finalHash: string } {
  const lines = content.split("\n");
  if (lines.at(-1) !== "") {
    throw new AgentError("RECOVERY_REQUIRED", "Audit log ends with a partial record");
  }
  const events: AuditEvent[] = [];
  let previousHash = GENESIS_HASH;
  let expectedSequence = 1;
  for (const line of lines.slice(0, -1)) {
    if (line.trim() === "") {
      throw new AgentError("RECOVERY_REQUIRED", "Audit log contains a blank record");
    }
    const parsed = JSON.parse(line) as AuditEvent;
    if (
      parsed.schemaVersion !== AUDIT_SCHEMA_VERSION ||
      parsed.sessionId !== expectedSessionId ||
      parsed.sequence !== expectedSequence ||
      parsed.previousHash !== previousHash ||
      !(AUDIT_EVENT_TYPES as readonly string[]).includes(parsed.type) ||
      typeof parsed.taskId !== "string" ||
      typeof parsed.timestamp !== "string" ||
      (parsed.operationId !== undefined && !isOperationId(parsed.operationId)) ||
      (parsed.turnId !== undefined && typeof parsed.turnId !== "string") ||
      parsed.data === null ||
      typeof parsed.data !== "object" ||
      Array.isArray(parsed.data)
    ) {
      throw new AgentError("RECOVERY_REQUIRED", "Audit chain metadata is inconsistent", {
        expectedSequence,
        actualSequence: parsed.sequence,
      });
    }
    const { eventHash, ...base } = parsed;
    const expectedHash = sha256(stableJson(base));
    if (eventHash !== expectedHash) {
      throw new AgentError("RECOVERY_REQUIRED", "Audit event integrity check failed", {
        sequence: parsed.sequence,
      });
    }
    events.push(parsed);
    previousHash = parsed.eventHash;
    expectedSequence += 1;
  }
  return { events, finalHash: previousHash };
}
