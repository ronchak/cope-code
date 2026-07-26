import { AgentError } from "../shared/errors.js";
import type { BudgetCounter, BudgetLimits, BudgetUsage, SessionState } from "./types.js";

const counterToLimit: Readonly<Record<BudgetCounter, keyof BudgetLimits>> = {
  turns: "maxTurns",
  operations: "maxOperations",
  readFiles: "maxReadFiles",
  disclosedBytes: "maxDisclosedBytes",
  changedFiles: "maxChangedFiles",
  changedLines: "maxChangedLines",
  commands: "maxCommands",
  commandOutputBytes: "maxCommandOutputBytes",
  protocolRepairs: "maxProtocolRepairs",
};

export class BudgetMeter {
  public constructor(private readonly state: SessionState) {}

  public assertTime(nowMs = Date.now()): void {
    const elapsed = nowMs - Date.parse(this.state.startedAt);
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      throw new AgentError("RECOVERY_REQUIRED", "Session start time is invalid", {
        startedAt: this.state.startedAt,
      });
    }
    if (elapsed > this.state.budgetLimits.maxElapsedMs) {
      throw new AgentError("BUDGET_EXCEEDED", "Elapsed-time budget exhausted", {
        elapsed,
        limit: this.state.budgetLimits.maxElapsedMs,
      });
    }
  }

  public assertCanConsume(
    counter: BudgetCounter,
    amount = 1,
    oneTimeLimit?: number,
  ): void {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new AgentError("INTERNAL_ERROR", `Invalid budget amount for ${counter}`, { amount });
    }
    const limitKey = counterToLimit[counter];
    const current = this.state.budgetUsage[counter];
    const persistedLimit = this.state.budgetLimits[limitKey];
    if (
      oneTimeLimit !== undefined &&
      (!Number.isSafeInteger(oneTimeLimit) || oneTimeLimit < persistedLimit)
    ) {
      throw new AgentError("INTERNAL_ERROR", `Invalid one-time budget limit for ${counter}`, {
        oneTimeLimit,
        persistedLimit,
      });
    }
    const limit = oneTimeLimit ?? persistedLimit;
    if (current + amount > limit) {
      throw new AgentError("BUDGET_EXCEEDED", `Budget exhausted for ${counter}`, {
        counter,
        current,
        requested: amount,
        limit,
      });
    }
  }

  public consume(counter: BudgetCounter, amount = 1, oneTimeLimit?: number): void {
    this.assertCanConsume(counter, amount, oneTimeLimit);
    this.state.budgetUsage = {
      ...this.state.budgetUsage,
      [counter]: this.state.budgetUsage[counter] + amount,
    } satisfies BudgetUsage;
  }

  public refund(counter: BudgetCounter, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || this.state.budgetUsage[counter] < amount) {
      throw new AgentError("INTERNAL_ERROR", `Invalid budget refund for ${counter}`, {
        amount,
        current: this.state.budgetUsage[counter],
      });
    }
    this.state.budgetUsage = {
      ...this.state.budgetUsage,
      [counter]: this.state.budgetUsage[counter] - amount,
    } satisfies BudgetUsage;
  }

  public remaining(counter: BudgetCounter): number {
    const limitKey = counterToLimit[counter];
    return this.state.budgetLimits[limitKey] - this.state.budgetUsage[counter];
  }
}
