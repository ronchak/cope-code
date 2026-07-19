import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

interface StartMessage {
  readonly type: "START";
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

type SupervisorMessage =
  | { readonly type: "ARMED"; readonly supervisorPid: number }
  | { readonly type: "STARTED"; readonly commandPid: number }
  | { readonly type: "FAILED"; readonly message: string };

const MONITOR_INTERVAL_MS = 25;

if (process.env.COPE_PROCESS_SUPERVISOR === "1") runSupervisor();

function runSupervisor(): void {
  const expectedParent = parseExpectedParent(process.env.COPE_EXPECTED_PARENT_PID);
  if (expectedParent === undefined || process.ppid !== expectedParent || process.send === undefined) {
    process.exitCode = 70;
    return;
  }
  let command: ChildProcess | undefined;
  let started = false;
  let terminating = false;
  const terminateGroup = (): void => {
    if (terminating) return;
    terminating = true;
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      try { command?.kill("SIGKILL"); } catch { /* already gone */ }
      process.exit(70);
    }
  };
  const monitor = setInterval(() => {
    if (process.ppid !== expectedParent) terminateGroup();
  }, MONITOR_INTERVAL_MS);
  let cancellationEscalation: ReturnType<typeof setTimeout> | undefined;
  const onTerminationRequest = (): void => {
    if (cancellationEscalation !== undefined) return;
    // Stay alive as the group guardian while the harness observes the grace
    // period. If the harness dies mid-cancel, the parent monitor escalates.
    cancellationEscalation = setTimeout(terminateGroup, 1_000);
  };
  process.on("SIGTERM", onTerminationRequest);
  process.on("SIGINT", onTerminationRequest);
  process.once("disconnect", terminateGroup);
  process.on("message", (value: unknown) => {
    if (started) return;
    let launch: StartMessage;
    try {
      launch = validateStartMessage(value);
    } catch (error) {
      send({ type: "FAILED", message: safeMessage(error) });
      clearInterval(monitor);
      process.exitCode = 70;
      return;
    }
    if (process.ppid !== expectedParent) {
      terminateGroup();
      return;
    }
    started = true;
    const launchCommand = (): void => {
      if (process.ppid !== expectedParent) {
        terminateGroup();
        return;
      }
      try {
        command = spawn(launch.executable, [...launch.arguments], {
          cwd: launch.cwd,
          env: { ...launch.environment },
          shell: false,
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        send({ type: "FAILED", message: safeMessage(error) });
        clearInterval(monitor);
        process.exitCode = 70;
        return;
      }
      command.stdout?.pipe(process.stdout);
      command.stderr?.pipe(process.stderr);
      command.once("error", (error) => send({ type: "FAILED", message: safeMessage(error) }));
      command.once("spawn", () => {
        const announceStarted = (): void => {
          if (process.ppid !== expectedParent) {
            terminateGroup();
            return;
          }
          send({ type: "STARTED", commandPid: command?.pid ?? -1 });
        };
        setTimeout(announceStarted, testDelay(process.env.COPE_SUPERVISOR_TEST_DELAY_AFTER_SPAWN_MS));
      });
      command.once("close", (exitCode, signal) => {
        clearInterval(monitor);
        if (cancellationEscalation !== undefined) clearTimeout(cancellationEscalation);
        process.removeListener("SIGTERM", onTerminationRequest);
        process.removeListener("SIGINT", onTerminationRequest);
        process.removeListener("disconnect", terminateGroup);
        process.exitCode = exitCode ?? (signal === null ? 70 : 1);
        if (process.connected) process.disconnect();
      });
    };
    setTimeout(launchCommand, testDelay(process.env.COPE_SUPERVISOR_TEST_DELAY_BEFORE_SPAWN_MS));
  });
  setTimeout(
    () => send({ type: "ARMED", supervisorPid: process.pid }),
    testDelay(process.env.COPE_SUPERVISOR_TEST_DELAY_BEFORE_ARMED_MS),
  );
}

export interface ProcessSupervisorTestHooks {
  readonly delayBeforeArmedMs?: number;
  readonly delayBeforePayloadMs?: number;
  readonly delayBeforeSpawnMs?: number;
  readonly delayAfterSpawnMs?: number;
  readonly onSupervisorSpawned?: (supervisor: ChildProcess) => void;
  readonly onArmed?: (supervisor: ChildProcess) => void;
  readonly onPayloadSent?: (supervisor: ChildProcess) => void;
}

export async function spawnSupervisedProcess(options: {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly handshakeTimeoutMs?: number;
  readonly testHooks?: ProcessSupervisorTestHooks;
}): Promise<ChildProcess> {
  const environment = Object.fromEntries(
    Object.entries(options.environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const supervisor = spawn(process.execPath, [fileURLToPath(new URL("./process-supervisor.js", import.meta.url))], {
    cwd: options.cwd,
    env: {
      ...environment,
      COPE_PROCESS_SUPERVISOR: "1",
      COPE_EXPECTED_PARENT_PID: String(process.pid),
      ...(options.testHooks?.delayBeforeArmedMs === undefined ? {} : {
        COPE_SUPERVISOR_TEST_DELAY_BEFORE_ARMED_MS: String(options.testHooks.delayBeforeArmedMs),
      }),
      ...(options.testHooks?.delayBeforeSpawnMs === undefined ? {} : {
        COPE_SUPERVISOR_TEST_DELAY_BEFORE_SPAWN_MS: String(options.testHooks.delayBeforeSpawnMs),
      }),
      ...(options.testHooks?.delayAfterSpawnMs === undefined ? {} : {
        COPE_SUPERVISOR_TEST_DELAY_AFTER_SPAWN_MS: String(options.testHooks.delayAfterSpawnMs),
      }),
    },
    shell: false,
    windowsHide: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  options.testHooks?.onSupervisorSpawned?.(supervisor);
  return await new Promise<ChildProcess>((resolve, reject) => {
    let armed = false;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      supervisor.removeListener("error", onError);
      supervisor.removeListener("close", onClose);
      supervisor.removeListener("message", onMessage);
      if (error === undefined) resolve(supervisor);
      else reject(error);
    };
    const terminate = (): void => {
      const pid = supervisor.pid;
      if (pid !== undefined) {
        try { process.kill(-pid, "SIGKILL"); return; } catch { /* fall through */ }
      }
      try { supervisor.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const onAbort = (): void => {
      terminate();
      finish(new Error("Supervised process launch was cancelled"));
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (code: number | null): void => {
      finish(new Error(`Process supervisor exited before STARTED (code ${String(code)})`));
    };
    const onMessage = (value: unknown): void => {
      const message = value as Partial<SupervisorMessage>;
      if (message.type === "ARMED" && !armed) {
        armed = true;
        options.testHooks?.onArmed?.(supervisor);
        const sendPayload = (): void => {
          supervisor.send({
            type: "START",
            executable: options.executable,
            arguments: [...options.arguments],
            cwd: options.cwd,
            environment,
          } satisfies StartMessage, (error) => {
            if (error !== null) finish(error);
            else options.testHooks?.onPayloadSent?.(supervisor);
          });
        };
        setTimeout(sendPayload, options.testHooks?.delayBeforePayloadMs ?? 0);
        return;
      }
      if (message.type === "STARTED" && armed) {
        finish();
        return;
      }
      if (message.type === "FAILED") finish(new Error(message.message ?? "Process supervisor failed"));
    };
    const timeout = setTimeout(() => {
      terminate();
      finish(new Error("Process supervisor handshake timed out"));
    }, options.handshakeTimeoutMs ?? 5_000);
    timeout.unref();
    supervisor.once("error", onError);
    supervisor.once("close", onClose);
    supervisor.on("message", onMessage);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();
  });
}

function validateStartMessage(value: unknown): StartMessage {
  if (value === null || typeof value !== "object") throw new TypeError("Supervisor payload must be an object");
  const candidate = value as Partial<StartMessage>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(",") !== "arguments,cwd,environment,executable,type" || candidate.type !== "START") {
    throw new TypeError("Supervisor payload has an invalid shape");
  }
  if (typeof candidate.executable !== "string" || candidate.executable.length === 0 || typeof candidate.cwd !== "string") {
    throw new TypeError("Supervisor executable or working directory is invalid");
  }
  if (!Array.isArray(candidate.arguments) || candidate.arguments.some((entry) => typeof entry !== "string")) {
    throw new TypeError("Supervisor arguments are invalid");
  }
  if (candidate.environment === null || typeof candidate.environment !== "object" || Array.isArray(candidate.environment)) {
    throw new TypeError("Supervisor environment is invalid");
  }
  for (const [key, entry] of Object.entries(candidate.environment)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0") || typeof entry !== "string" || entry.includes("\0")) {
      throw new TypeError("Supervisor environment entry is invalid");
    }
  }
  return candidate as StartMessage;
}

function send(message: SupervisorMessage): void {
  process.send?.(message, () => undefined);
}

function parseExpectedParent(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : undefined;
}

function testDelay(value: string | undefined): number {
  if (value === undefined || !/^\d{1,5}$/u.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : 0;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}
