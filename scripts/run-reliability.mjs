import { spawnSync } from "node:child_process";

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2 || arguments_[0] !== "--iterations" || !/^[0-9]+$/u.test(arguments_[1] ?? "")) {
  process.stderr.write("Usage: node scripts/run-reliability.mjs --iterations <1..500>\n");
  process.exitCode = 2;
} else {
  const iterations = Number(arguments_[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 500) {
    process.stderr.write("Reliability iterations must be from 1 through 500.\n");
    process.exitCode = 2;
  } else {
    const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(npmExecutable, ["run", "test:reliability"], {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, COPE_RELIABILITY_ITERATIONS: String(iterations) },
    });
    if (result.error !== undefined) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
