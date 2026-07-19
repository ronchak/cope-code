export type AgentErrorCode =
  | "CONFIG_INVALID"
  | "ELEVATED_EXECUTION_REFUSED"
  | "POLICY_DENIED"
  | "POLICY_ASK"
  | "PATH_OUTSIDE_REPOSITORY"
  | "PATH_PROTECTED"
  | "UNSUPPORTED_FILE"
  | "STALE_STATE"
  | "PROTOCOL_INVALID"
  | "DUPLICATE_OPERATION"
  | "BUDGET_EXCEEDED"
  | "COMMAND_FAILED"
  | "COMMAND_TIMEOUT"
  | "COMMAND_CANCELLED"
  | "TRANSPORT_UNAVAILABLE"
  | "TRANSPORT_INDETERMINATE"
  | "IDENTITY_UNVERIFIED"
  | "CHECKPOINT_CORRUPT"
  | "RECOVERY_REQUIRED"
  | "INTERNAL_ERROR";

export class AgentError extends Error {
  public constructor(
    public readonly code: AgentErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
