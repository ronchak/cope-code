import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";

import { AgentError } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";
import type { FileState } from "./types.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

export interface TextFileSnapshot {
  readonly content: string;
  readonly bytes: Buffer;
  readonly state: FileState;
}

export interface RegularFileSnapshot {
  readonly bytes: Buffer;
  readonly state: FileState;
  readonly mode: number;
  readonly identity: {
    readonly device: string;
    readonly inode: string;
  };
}

export interface RegularFileExpectation {
  readonly sizeBytes?: number;
  readonly sha256?: string;
  /** @internal Deterministic pathname replacement after the preliminary stat. */
  readonly testAfterStat?: () => Promise<void>;
}

export async function readTextFile(
  absolutePath: string,
  relativePath: string,
  maxBytes: number,
): Promise<TextFileSnapshot> {
  const snapshot = await readRegularFile(absolutePath, relativePath, maxBytes);
  const { bytes } = snapshot;
  if (looksBinary(bytes)) {
    throw new AgentError("UNSUPPORTED_FILE", "Binary content is not supported", {
      path: relativePath,
    });
  }

  let content: string;
  try {
    // `ignoreBOM: true` keeps U+FEFF in the decoded string. Re-encoding an
    // exact edit therefore preserves the original EF BB BF bytes instead of
    // silently treating them as transport metadata.
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new AgentError(
      "UNSUPPORTED_FILE",
      "File is not valid UTF-8 text",
      { path: relativePath },
      { cause: error },
    );
  }

  return { content, ...snapshot };
}

/** Reads exact regular-file bytes with descriptor and path-race checks. */
export async function readRegularFile(
  absolutePath: string,
  relativePath: string,
  maxBytes: number,
  expectation: RegularFileExpectation = {},
): Promise<RegularFileSnapshot> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new AgentError("CONFIG_INVALID", "Text read limit must be a positive integer", {
      maxBytes,
    });
  }

  const beforeLinkState = await lstat(absolutePath, { bigint: true });
  if (beforeLinkState.isSymbolicLink()) {
    throw new AgentError("UNSUPPORTED_FILE", "Symbolic links and junctions are not supported", {
      path: relativePath,
    });
  }
  const before = await stat(absolutePath, { bigint: true });
  if (!before.isFile()) {
    throw new AgentError("UNSUPPORTED_FILE", "Only regular files can be read", {
      path: relativePath,
    });
  }
  if (before.nlink > 1n) {
    throw new AgentError("UNSUPPORTED_FILE", "Hard-linked files are not supported", {
      path: relativePath,
      linkCount: Number(before.nlink),
    });
  }
  if (before.size > BigInt(maxBytes)) {
    throw new AgentError("BUDGET_EXCEEDED", "File exceeds the configured read limit", {
      path: relativePath,
      sizeBytes: before.size.toString(),
      maxBytes,
    });
  }
  if (
    expectation.sizeBytes !== undefined &&
    before.size !== BigInt(expectation.sizeBytes)
  ) {
    throw new AgentError("STALE_STATE", "File size changed before it could be read", {
      path: relativePath,
      expectedSizeBytes: expectation.sizeBytes,
      actualSizeBytes: before.size.toString(),
    });
  }

  await expectation.testAfterStat?.();
  const noFollow = CURRENT_HOST_PLATFORM.supportsPosixModes ? constants.O_NOFOLLOW : 0;
  const nonBlocking = constants.O_NONBLOCK ?? 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow | nonBlocking);
  let bytes: Buffer;
  try {
    const handleStat = await handle.stat({ bigint: true });
    if (
      !handleStat.isFile() ||
      handleStat.dev !== before.dev ||
      handleStat.ino !== before.ino ||
      handleStat.size !== before.size ||
      handleStat.size > BigInt(maxBytes)
    ) {
      throw new AgentError("STALE_STATE", "File changed while it was being opened", {
        path: relativePath,
      });
    }
    bytes = Buffer.alloc(Number(handleStat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset !== bytes.length) {
      throw new AgentError("STALE_STATE", "File changed while it was being read", {
        path: relativePath,
      });
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytesRead } = await handle.read(
      extra,
      0,
      1,
      bytes.length,
    );
    const handleAfter = await handle.stat({ bigint: true });
    if (
      extraBytesRead !== 0 ||
      handleAfter.dev !== handleStat.dev ||
      handleAfter.ino !== handleStat.ino ||
      handleAfter.size !== handleStat.size ||
      handleAfter.mode !== handleStat.mode ||
      handleAfter.nlink !== handleStat.nlink ||
      handleAfter.mtimeNs !== handleStat.mtimeNs ||
      handleAfter.ctimeNs !== handleStat.ctimeNs
    ) {
      throw new AgentError("STALE_STATE", "File changed while it was being read", {
        path: relativePath,
      });
    }
  } finally {
    await handle.close();
  }

  const afterLinkState = await lstat(absolutePath, { bigint: true });
  if (afterLinkState.isSymbolicLink() || (await realpath(absolutePath)) !== absolutePath) {
    throw new AgentError("STALE_STATE", "File path changed during the read", {
      path: relativePath,
    });
  }
  const after = await stat(absolutePath, { bigint: true });
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mode !== before.mode ||
    after.nlink !== before.nlink ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  ) {
    throw new AgentError("STALE_STATE", "File changed during the read", { path: relativePath });
  }
  const digest = sha256(bytes);
  if (expectation.sha256 !== undefined && digest !== expectation.sha256) {
    throw new AgentError("STALE_STATE", "File content changed before it could be used", {
      path: relativePath,
    });
  }

  return {
    bytes,
    state: {
      sha256: digest,
      sizeBytes: bytes.length,
      modifiedAtMs: Number(after.mtimeNs) / 1_000_000,
    },
    mode: Number(after.mode & 0o777n),
    identity: {
      device: after.dev.toString(),
      inode: after.ino.toString(),
    },
  };
}

export function looksBinary(bytes: Uint8Array): boolean {
  const inspectedLength = Math.min(bytes.length, 8 * 1024);
  if (inspectedLength === 0) {
    return false;
  }
  let suspicious = 0;
  for (let index = 0; index < inspectedLength; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) {
      continue;
    }
    if (byte === 0) {
      return true;
    }
    if ((byte < 7 || (byte > 13 && byte < 32)) && byte !== 27) {
      suspicious += 1;
    }
  }
  return suspicious / inspectedLength > 0.1;
}
