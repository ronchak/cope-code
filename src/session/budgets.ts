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

export type PostHocBudgetCounter =
  | "changedFiles"
  | "changedLines"
  | "commandOutputBytes";

export interface PostHocBudgetCharge {
  readonly changedFiles?: number;
  readonly changedLines?: number;
  readonly commandOutputBytes?: number;
}

export interface PostHocBudgetExceeded {
  readonly counter: PostHocBudgetCounter;
  readonly previous: number;
  readonly charged: number;
  readonly actual: number;
  readonly persistedLimit: number;
  readonly effectiveLimit: number;
}

export interface PostHocBudgetResult {
  readonly usage: Pick<BudgetUsage, PostHocBudgetCounter>;
  readonly exceeded: readonly PostHocBudgetExceeded[];
}

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
        counter: "elapsedMs",
        current: elapsed,
        requested: 1,
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

  /**
   * Records facts discovered only after a terminal operation. Budget overruns
   * are returned after all actual usage is applied; they never throw before
   * truth can be persisted.
   */
  public applyPostHoc(
    charge: PostHocBudgetCharge,
    oneTimeLimits: Partial<Record<PostHocBudgetCounter, number>> = {},
  ): PostHocBudgetResult {
    const counters: readonly PostHocBudgetCounter[] = [
      "changedFiles",
      "changedLines",
      "commandOutputBytes",
    ];
    const next = { ...this.state.budgetUsage };
    const exceeded: PostHocBudgetExceeded[] = [];
    for (const counter of counters) {
      const amount = charge[counter] ?? 0;
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new AgentError(
          "INTERNAL_ERROR",
          `Invalid post-hoc budget amount for ${counter}`,
          { amount },
        );
      }
      const limitKey = counterToLimit[counter];
      const persistedLimit = this.state.budgetLimits[limitKey];
      const oneTimeLimit = oneTimeLimits[counter];
      if (
        oneTimeLimit !== undefined &&
        (!Number.isSafeInteger(oneTimeLimit) || oneTimeLimit < persistedLimit)
      ) {
        throw new AgentError(
          "INTERNAL_ERROR",
          `Invalid one-time post-hoc budget limit for ${counter}`,
          { oneTimeLimit, persistedLimit },
        );
      }
      const previous = next[counter];
      const actual = saturatingAdd(previous, amount);
      next[counter] = actual;
      const effectiveLimit = oneTimeLimit ?? persistedLimit;
      if (actual > effectiveLimit) {
        exceeded.push({
          counter,
          previous,
          charged: amount,
          actual,
          persistedLimit,
          effectiveLimit,
        });
      }
    }
    this.state.budgetUsage = next;
    return {
      usage: {
        changedFiles: next.changedFiles,
        changedLines: next.changedLines,
        commandOutputBytes: next.commandOutputBytes,
      },
      exceeded,
    };
  }

  public remaining(counter: BudgetCounter): number {
    const limitKey = counterToLimit[counter];
    return this.state.budgetLimits[limitKey] - this.state.budgetUsage[counter];
  }
}

function saturatingAdd(left: number, right: number): number {
  const total = left + right;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}
