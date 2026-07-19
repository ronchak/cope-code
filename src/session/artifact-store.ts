import { access, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { newId, sha256, stableJson } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";

export type ArtifactKind = "outbox" | "response" | "decision";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly kind: ArtifactKind;
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Source-bearing recovery artifacts are intentionally separate from session
 * metadata and audit JSONL. Callers should clear them at terminal completion
 * unless a separately approved retention policy requires otherwise.
 */
export class SessionArtifactStore {
  public constructor(private readonly root: string) {}

  public async put(kind: ArtifactKind, id: string, content: string): Promise<void> {
    assertSafeArtifactId(id);
    const contentBytes = Buffer.byteLength(content);
    if (contentBytes > MAX_ARTIFACT_BYTES) {
      throw new AgentError("BUDGET_EXCEEDED", "Source-bearing recovery artifact exceeds its storage bound", {
        kind,
        id,
        maxBytes: MAX_ARTIFACT_BYTES,
      });
    }
    const directory = path.join(this.root, kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manifest: ArtifactManifest = {
      schemaVersion: 1,
      kind,
      id,
      bytes: contentBytes,
      sha256: sha256(content),
    };
    await atomicWrite(this.contentPath(kind, id), content);
    try {
      await atomicWrite(this.manifestPath(kind, id), `${stableJson(manifest)}\n`);
    } catch (error) {
      await unlink(this.contentPath(kind, id)).catch(() => undefined);
      throw error;
    }
  }

  public async get(kind: ArtifactKind, id: string): Promise<string> {
    assertSafeArtifactId(id);
    let manifest: ArtifactManifest;
    let content: string;
    try {
      const [manifestBytes, contentBytes] = await Promise.all([
        readFile(this.manifestPath(kind, id)),
        readFile(this.contentPath(kind, id)),
      ]);
      if (
        manifestBytes.length === 0 ||
        manifestBytes.length > MAX_MANIFEST_BYTES ||
        contentBytes.length > MAX_ARTIFACT_BYTES
      ) {
        throw new Error("artifact is empty or oversized");
      }
      const manifestText = manifestBytes.toString("utf8");
      if (manifestText.charCodeAt(0) === 0xfeff || !manifestText.endsWith("\n")) {
        throw new Error("artifact manifest is partial or contains a BOM");
      }
      manifest = JSON.parse(manifestText) as ArtifactManifest;
      content = contentBytes.toString("utf8");
    } catch (error) {
      throw new AgentError("RECOVERY_REQUIRED", "Source-bearing recovery artifact is unreadable", {
        kind,
        id,
      }, { cause: error });
    }
    if (
      !hasExactKeys(manifest, ["schemaVersion", "kind", "id", "bytes", "sha256"]) ||
      manifest.schemaVersion !== 1 ||
      manifest.kind !== kind ||
      manifest.id !== id ||
      !Number.isSafeInteger(manifest.bytes) ||
      manifest.bytes < 0 ||
      manifest.bytes > MAX_ARTIFACT_BYTES ||
      !/^[a-f0-9]{64}$/u.test(manifest.sha256) ||
      manifest.bytes !== Buffer.byteLength(content) ||
      manifest.sha256 !== sha256(content)
    ) {
      throw new AgentError("RECOVERY_REQUIRED", "Source-bearing recovery artifact failed integrity validation", {
        kind,
        id,
      });
    }
    return content;
  }

  public async getOptional(kind: ArtifactKind, id: string): Promise<string | undefined> {
    assertSafeArtifactId(id);
    const contentPath = this.contentPath(kind, id);
    const manifestPath = this.manifestPath(kind, id);
    const existence = await Promise.allSettled([access(contentPath), access(manifestPath)]);
    const contentExists = existence[0]?.status === "fulfilled";
    const manifestExists = existence[1]?.status === "fulfilled";
    if (!contentExists && !manifestExists) return undefined;
    if (!contentExists || !manifestExists) {
      throw new AgentError("RECOVERY_REQUIRED", "Source-bearing recovery artifact is incomplete", {
        kind,
        id,
      });
    }
    return this.get(kind, id);
  }

  public async remove(kind: ArtifactKind, id: string): Promise<void> {
    assertSafeArtifactId(id);
    await Promise.all([
      unlink(this.contentPath(kind, id)).catch(ignoreMissing),
      unlink(this.manifestPath(kind, id)).catch(ignoreMissing),
    ]);
  }

  public async clear(): Promise<void> {
    if (path.basename(this.root) !== "artifacts") {
      throw new AgentError("INTERNAL_ERROR", "Refusing to clear a non-artifact directory", { root: this.root });
    }
    await rm(this.root, { recursive: true, force: true });
  }

  private contentPath(kind: ArtifactKind, id: string): string {
    return path.join(this.root, kind, `${id}.txt`);
  }

  private manifestPath(kind: ArtifactKind, id: string): string {
    return path.join(this.root, kind, `${id}.manifest.json`);
  }
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  const temporary = `${filename}.${newId("write")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
}

function assertSafeArtifactId(id: string): void {
  if (!/^[A-Za-z0-9._-]{3,160}$/u.test(id)) {
    throw new AgentError("INTERNAL_ERROR", "Unsafe recovery artifact identifier");
  }
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
