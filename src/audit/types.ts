export const AUDIT_SCHEMA_VERSION = 1 as const;

export const AUDIT_EVENT_TYPES = [
  "session.created",
  "session.transition",
  "grant.established",
  "transport.state",
  "model.submission",
  "model.response",
  "protocol.error",
  "tool.requested",
  "policy.decision",
  "tool.completed",
  "mutation.completed",
  "command.completed",
  "checkpoint.created",
  "checkpoint.rolled_back",
  "disclosure.recorded",
  "capability.requested",
  "capability.decided",
  "user.requested",
  "user.decided",
  "user.decision_replayed",
  "completion.claimed",
  "completion.verified",
  "session.recovered",
  "session.ended",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEventInput {
  readonly type: AuditEventType;
  readonly taskId: string;
  readonly operationId?: string;
  readonly turnId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface AuditEvent extends AuditEventInput {
  readonly schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  readonly sequence: number;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly previousHash: string;
  readonly eventHash: string;
}
