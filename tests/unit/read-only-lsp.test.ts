import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { AgentError } from "../../src/shared/errors.js";
import {
  ReadOnlyLspService,
  type ReadOnlyLspBackend,
} from "../../src/tools/read-only-lsp.js";

async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-read-only-lsp-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "export const answer = 42;\n");
  return { root, boundary: await RepositoryBoundary.create(root) };
}

test("read-only LSP normalizes repository results and applies deterministic count and byte bounds", async (context) => {
  const { root, boundary } = await fixture(context);
  const backend: ReadOnlyLspBackend = {
    capabilities: ["references"],
    query: async (request) => {
      assert.equal(request.absolutePath, path.join(boundary.root, "src", "main.ts"));
      return Array.from({ length: 5 }, (_, index) => ({
        path: "src/main.ts",
        startLine: index,
        startCharacter: 0,
        endLine: index,
        endCharacter: 6,
        contents: index === 0 ? "x".repeat(8_000) : "answer",
      }));
    },
  };
  const service = new ReadOnlyLspService(boundary, backend);
  const result = await service.query({
    operation: "references",
    path: "src/main.ts",
    line: 0,
    character: 13,
    maxResults: 3,
    maxBytes: 4_096,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.items.length, 0, "an oversized item is omitted rather than emitting partial JSON");
  assert.equal(result.outputBytes <= 4_096, true);
  assert.equal(await readFile(path.join(root, "src", "main.ts"), "utf8"), "export const answer = 42;\n");
});

test("read-only LSP rejects operations outside the static capability grant before invoking the backend", async (context) => {
  const { boundary } = await fixture(context);
  let calls = 0;
  const service = new ReadOnlyLspService(boundary, {
    capabilities: ["hover"],
    query: async () => { calls += 1; return []; },
  });

  await assert.rejects(
    service.query({ operation: "definition", path: "src/main.ts", line: 0, character: 0, maxResults: 10 }),
    (error: unknown) => error instanceof AgentError && error.code === "POLICY_DENIED",
  );
  assert.equal(calls, 0);
});

test("read-only LSP bounds uncooperative backends with deterministic timeout and cancellation", async (context) => {
  const { boundary } = await fixture(context);
  let observedSignal: AbortSignal | undefined;
  const backend: ReadOnlyLspBackend = {
    capabilities: ["document_symbols"],
    query: async (_request, signal) => {
      observedSignal = signal;
      return new Promise<never>(() => undefined);
    },
  };
  const service = new ReadOnlyLspService(boundary, backend, { maximumTimeoutMs: 50 });
  await assert.rejects(
    service.query({ operation: "document_symbols", path: "src/main.ts", maxResults: 10, timeoutMs: 10 }),
    (error: unknown) => error instanceof AgentError && error.code === "COMMAND_TIMEOUT",
  );
  assert.equal(observedSignal?.aborted, true);

  const controller = new AbortController();
  const cancelled = service.query({ operation: "document_symbols", path: "src/main.ts", maxResults: 10, timeoutMs: 50 }, controller.signal);
  controller.abort("operator pause");
  await assert.rejects(cancelled, (error: unknown) => error instanceof AgentError && error.code === "COMMAND_CANCELLED");
});

test("read-only LSP rejects backend paths outside the canonical repository boundary", async (context) => {
  const { boundary } = await fixture(context);
  const service = new ReadOnlyLspService(boundary, {
    capabilities: ["definition"],
    query: async () => [{ path: "../secret.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 }],
  });
  await assert.rejects(
    service.query({ operation: "definition", path: "src/main.ts", line: 0, character: 0, maxResults: 10 }),
    (error: unknown) => error instanceof AgentError && error.code === "PATH_OUTSIDE_REPOSITORY",
  );
});
