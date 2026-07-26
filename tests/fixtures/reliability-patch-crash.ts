import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { CheckpointStore } from "../../src/repository/checkpoint.js";
import { PatchEngine } from "../../src/repository/patch-engine.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";
import { sha256 } from "../../src/shared/crypto.js";
import { crashNow } from "../helpers/runtime-reliability.js";

type Boundary = "checkpoint-created" | "worktree-committed" | "checkpoint-sealed";

const root = path.resolve(process.argv[2] ?? "");
const boundaryName = process.argv[3] as Boundary | undefined;
if (root === "" || boundaryName === undefined) throw new Error("root and boundary are required");

const repository = path.join(root, "repository");
await mkdir(repository, { recursive: true });
const target = path.join(repository, "sample.txt");
await writeFile(target, "before\n", { flag: "wx", mode: 0o600, flush: true });
const boundary = await RepositoryBoundary.create(repository);
const checkpoints = await CheckpointStore.create(boundary, path.join(root, "checkpoints"));
const createCheckpoint = checkpoints.createCheckpoint.bind(checkpoints);
checkpoints.createCheckpoint = async (...arguments_) => {
  const result = await createCheckpoint(...arguments_);
  if (boundaryName === "checkpoint-created") crashNow();
  return result;
};
const seal = checkpoints.seal.bind(checkpoints);
checkpoints.seal = async (...arguments_) => {
  if (boundaryName === "worktree-committed") crashNow();
  const result = await seal(...arguments_);
  if (boundaryName === "checkpoint-sealed") crashNow();
  return result;
};
const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy(), {
  allowCreate: true,
});
await engine.applyPatch({
  operationId: "op_patch_crash",
  changes: [{
    kind: "update",
    path: "sample.txt",
    base_sha256: sha256(await readFile(target)),
    content: "after\n",
  }],
});
throw new Error(`patch did not crash at ${boundaryName}`);
