import { rename, writeFile } from "node:fs/promises";

import { spawnSupervisedProcess } from "../../src/tools/process-supervisor.js";

const readyFile = process.env.COPE_HARNESS_READY_FILE;
const commandPidFile = process.env.COPE_HARNESS_COMMAND_PID_FILE;
const childPidFile = process.env.COPE_HARNESS_CHILD_PID_FILE;
const grandchildPidFile = process.env.COPE_HARNESS_GRANDCHILD_PID_FILE;
const phase = process.env.COPE_HARNESS_PHASE ?? "active";
if (readyFile === undefined || commandPidFile === undefined || childPidFile === undefined || grandchildPidFile === undefined) {
  process.exit(64);
}

const grandchildScript = [
  'const fs = require("node:fs")',
  'fs.writeFileSync(process.env.COPE_GRANDCHILD_PID_FILE, String(process.pid))',
  'process.on("SIGTERM", () => {})',
  'setInterval(() => {}, 1000)',
].join(";");
const childScript = [
  'const fs = require("node:fs")',
  'const { spawn } = require("node:child_process")',
  'fs.writeFileSync(process.env.COPE_CHILD_PID_FILE, String(process.pid))',
  `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { env: process.env, shell: false, stdio: "ignore" })`,
  'process.on("SIGTERM", () => {})',
  'setInterval(() => {}, 1000)',
].join(";");
const commandScript = [
  'const fs = require("node:fs")',
  'const { spawn } = require("node:child_process")',
  'fs.writeFileSync(process.env.COPE_COMMAND_PID_FILE, String(process.pid))',
  `spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { env: process.env, shell: false, stdio: "ignore" })`,
  'process.on("SIGTERM", () => {})',
  'setInterval(() => {}, 1000)',
].join(";");

let supervisorPid: number | undefined;
let readyWritten = false;
const writeReady = async (): Promise<void> => {
  if (readyWritten || supervisorPid === undefined) return;
  readyWritten = true;
  const temporary = `${readyFile}.${String(process.pid)}.tmp`;
  await writeFile(temporary, JSON.stringify({ supervisorPid }));
  await rename(temporary, readyFile);
};
const supervisorPromise = spawnSupervisedProcess({
  executable: process.execPath,
  arguments: ["-e", commandScript],
  cwd: process.cwd(),
  environment: {
    PATH: process.env.PATH ?? "",
    COPE_COMMAND_PID_FILE: commandPidFile,
    COPE_CHILD_PID_FILE: childPidFile,
    COPE_GRANDCHILD_PID_FILE: grandchildPidFile,
  },
  handshakeTimeoutMs: 10_000,
  testHooks: {
    ...(phase === "before-armed" ? { delayBeforeArmedMs: 2_000 } : {}),
    ...(phase === "armed" ? { delayBeforePayloadMs: 2_000 } : {}),
    ...(phase === "before-spawn" ? { delayBeforeSpawnMs: 2_000 } : {}),
    ...(phase === "before-started" ? { delayAfterSpawnMs: 2_000 } : {}),
    onSupervisorSpawned: (child) => {
      supervisorPid = child.pid;
      if (phase === "before-armed") void writeReady();
    },
    onArmed: () => { if (phase === "armed") void writeReady(); },
    onPayloadSent: () => { if (phase === "before-spawn") void writeReady(); },
  },
});
if (phase === "before-started") {
  void waitForPidFiles([commandPidFile, childPidFile, grandchildPidFile]).then(writeReady);
}
const supervisor = await supervisorPromise;
supervisorPid = supervisor.pid;
if (phase === "active" || phase === "during-cancel") {
  await waitForPidFiles([commandPidFile, childPidFile, grandchildPidFile]);
  await writeReady();
}
setInterval(() => undefined, 1_000);

async function waitForPidFiles(filenames: readonly string[]): Promise<void> {
  for (const filename of filenames) {
    for (;;) {
      try {
        const value = await import("node:fs/promises").then(({ readFile }) => readFile(filename, "utf8"));
        if (/^\d+$/u.test(value)) break;
      } catch { /* descendant has not spawned yet */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
