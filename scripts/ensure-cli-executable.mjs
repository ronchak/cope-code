import { chmod } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  await chmod(path.resolve("dist/src/cli/main.js"), 0o755);
}
