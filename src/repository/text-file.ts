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
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
): Promise<RegularFileSnapshot> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new AgentError("CONFIG_INVALID", "Text read limit must be a positive integer", {
      maxBytes,
    });
  }

  const beforeLinkState = await lstat(absolutePath);
  if (beforeLinkState.isSymbolicLink()) {
    throw new AgentError("UNSUPPORTED_FILE", "Symbolic links and junctions are not supported", {
      path: relativePath,
    });
  }
  const before = await stat(absolutePath);
  if (!before.isFile()) {
    throw new AgentError("UNSUPPORTED_FILE", "Only regular files can be read", {
      path: relativePath,
    });
  }
  if (before.nlink > 1) {
    throw new AgentError("UNSUPPORTED_FILE", "Hard-linked files are not supported", {
      path: relativePath,
      linkCount: before.nlink,
    });
  }
  if (before.size > maxBytes) {
    throw new AgentError("BUDGET_EXCEEDED", "File exceeds the configured read limit", {
      path: relativePath,
      sizeBytes: before.size,
      maxBytes,
    });
  }

  const noFollow = CURRENT_HOST_PLATFORM.supportsPosixModes ? constants.O_NOFOLLOW : 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  let bytes: Buffer;
  try {
    const handleStat = await handle.stat();
    if (!handleStat.isFile() || handleStat.size !== before.size) {
      throw new AgentError("STALE_STATE", "File changed while it was being opened", {
        path: relativePath,
      });
    }
    bytes = Buffer.alloc(handleStat.size);
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
  } finally {
    await handle.close();
  }

  const afterLinkState = await lstat(absolutePath);
  if (afterLinkState.isSymbolicLink() || (await realpath(absolutePath)) !== absolutePath) {
    throw new AgentError("STALE_STATE", "File path changed during the read", {
      path: relativePath,
    });
  }
  const after = await stat(absolutePath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new AgentError("STALE_STATE", "File changed during the read", { path: relativePath });
  }

  return {
    bytes,
    state: {
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
      modifiedAtMs: after.mtimeMs,
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
