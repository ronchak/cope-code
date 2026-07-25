import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { createHash } from "node:crypto";

interface Identity {
  readonly device: string;
  readonly inode: string;
}

type Request =
  | {
      readonly directory: Identity;
      readonly operation: {
        readonly kind: "write";
        readonly name: string;
        readonly bytes: string;
        readonly mode: number;
      };
    }
  | {
      readonly directory: Identity;
      readonly operation: {
        readonly kind: "capture";
        readonly source: string;
        readonly destination: string;
        readonly expectedSha256: string;
        readonly expectedMode: number;
        readonly testCreateDestinationAfterValidation?: string;
        readonly testWriteAfterCaptureValidation?: string;
      };
    }
  | {
      readonly directory: Identity;
      readonly operation: {
        readonly kind: "install";
        readonly source: string;
        readonly destination: string;
        readonly sourceIdentity: Identity;
        readonly sourceSha256: string;
        readonly sourceMode: number;
        readonly failAfterLink?: boolean;
        readonly testDeleteDestinationAfterLink?: boolean;
      };
    }
  | {
      readonly directory: Identity;
      readonly operation: {
        readonly kind: "probe_link";
        readonly source: string;
        readonly destination: string;
        readonly sourceIdentity: Identity;
        readonly sourceSha256: string;
        readonly sourceMode: number;
        readonly failBeforeLink?: boolean;
      };
    }
  | {
      readonly directory: Identity;
      readonly operation: {
        readonly kind: "read";
        readonly name: string;
        readonly identity?: Identity;
        readonly testAppendAfterStat?: string;
      };
    }
  | {
      readonly directory: Identity;
      readonly operation: {
        readonly kind: "remove";
        readonly name: string;
        readonly identity: Identity | null;
        readonly expectedSha256?: string;
        readonly expectedMode?: number;
        readonly testReplaceAfterValidation?: {
          readonly parked: string;
          readonly bytes: string;
          readonly mode: number;
        };
      };
    }
  | {
      readonly directory: Identity;
      readonly operation: {
        readonly kind: "restore";
        readonly source: string;
        readonly destination: string;
        readonly sourceIdentity: Identity;
        readonly sourceSha256: string;
        readonly sourceMode: number;
      };
    }
  | {
      readonly directory: Identity;
      readonly operation: {
        readonly kind: "verify_absent";
        readonly name: string;
      };
    };

interface FileResult extends Identity {
  readonly sha256: string;
  readonly mode: number;
  readonly modifiedAtMs: number;
  readonly bytes?: string;
}

const READ_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

function main(): void {
  const request = parseRequest(readStdin());
  const directory = statSync(".", { bigint: true });
  if (
    !directory.isDirectory() ||
    directory.dev.toString() !== request.directory.device ||
    directory.ino.toString() !== request.directory.inode
  ) {
    throw new Error("Pinned mutation directory identity mismatch");
  }
  const operation = request.operation;
  switch (operation.kind) {
    case "write":
      assertLeaf(operation.name);
      writeExclusive(operation.name, Buffer.from(operation.bytes, "base64"), operation.mode);
      respond(fileResult(operation.name));
      return;
    case "capture":
      assertLeaf(operation.source);
      assertLeaf(operation.destination);
      assertAbsent(operation.destination);
      assertFile(operation.source, undefined, operation.expectedSha256, operation.expectedMode);
      {
      const sourceIdentity = identityOf(operation.source);
      if (operation.testCreateDestinationAfterValidation !== undefined) {
        writeExclusive(
          operation.destination,
          Buffer.from(operation.testCreateDestinationAfterValidation, "base64"),
          0o600,
        );
      }
      assertAbsent(operation.destination);
      renameSync(operation.source, operation.destination);
      try {
        assertFile(
          operation.destination,
          sourceIdentity,
          operation.expectedSha256,
          operation.expectedMode,
        );
        if (operation.testWriteAfterCaptureValidation !== undefined) {
          writeFileSync(
            operation.destination,
            Buffer.from(operation.testWriteAfterCaptureValidation, "base64"),
          );
        }
        const result = fileResult(operation.destination);
        if (
          result.device !== sourceIdentity.device ||
          result.inode !== sourceIdentity.inode ||
          result.sha256 !== operation.expectedSha256 ||
          result.mode !== operation.expectedMode
        ) {
          throw new Error("Pinned capture result changed after validation");
        }
        respond(result);
        return;
      } catch (error) {
        // The object moved after the last pathname check was not the
        // authenticated source. Put it back only through a no-overwrite hard
        // link; if another actor recreated the target, preserve both objects
        // for explicit recovery.
        try {
          linkSync(operation.destination, operation.source);
        } catch {
          // Preserve the parked object and the primary evidence.
        }
        throw error;
      }
      }
    case "install": {
      assertLeaf(operation.source);
      assertLeaf(operation.destination);
      assertAbsent(operation.destination);
      assertFile(
        operation.source,
        operation.sourceIdentity,
        operation.sourceSha256,
        operation.sourceMode,
      );
      linkSync(operation.source, operation.destination);
      if (operation.testDeleteDestinationAfterLink === true) {
        unlinkSync(operation.destination);
        throw new Error("Injected deletion after final link");
      }
      if (operation.failAfterLink === true) {
        throw new Error("Injected failure after final link");
      }
      respond(fileResult(operation.destination));
      return;
    }
    case "probe_link": {
      assertLeaf(operation.source);
      assertLeaf(operation.destination);
      assertAbsent(operation.destination);
      assertFile(
        operation.source,
        operation.sourceIdentity,
        operation.sourceSha256,
        operation.sourceMode,
      );
      if (operation.failBeforeLink === true) {
        throw new Error("Injected unsupported hard-link capability");
      }
      linkSync(operation.source, operation.destination);
      try {
        assertFile(
          operation.destination,
          operation.sourceIdentity,
          operation.sourceSha256,
          operation.sourceMode,
        );
        unlinkSync(operation.destination);
        assertAbsent(operation.destination);
      } catch (error) {
        try {
          removeExact(
            operation.destination,
            operation.sourceIdentity,
            operation.sourceSha256,
            operation.sourceMode,
          );
        } catch {
          // The exact probe remains authenticated by the parent checkpoint.
        }
        throw error;
      }
      respond({ supported: true });
      return;
    }
    case "read":
      assertLeaf(operation.name);
      assertFile(operation.name, operation.identity);
      respond(fileResult(operation.name, true, operation.testAppendAfterStat));
      return;
    case "remove":
      assertLeaf(operation.name);
      if (operation.identity === null) {
        assertAbsent(operation.name);
        respond({ absent: true });
        return;
      }
      if (!exists(operation.name)) {
        respond({ absent: true });
        return;
      }
      removeExact(
        operation.name,
        operation.identity,
        operation.expectedSha256,
        operation.expectedMode,
        operation.testReplaceAfterValidation,
      );
      respond({ removed: true });
      return;
    case "restore": {
      assertLeaf(operation.source);
      assertLeaf(operation.destination);
      assertAbsent(operation.destination);
      assertFile(
        operation.source,
        operation.sourceIdentity,
        operation.sourceSha256,
        operation.sourceMode,
      );
      linkSync(operation.source, operation.destination);
      respond(fileResult(operation.destination));
      return;
    }
    case "verify_absent":
      assertLeaf(operation.name);
      assertAbsent(operation.name);
      respond({ absent: true });
      return;
  }
}

function readStdin(): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  for (;;) {
    const count = readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > 32 * 1024 * 1024) throw new Error("Pinned mutation request is oversized");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequest(raw: string): Request {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object") throw new Error("Pinned mutation request is invalid");
  const request = value as Request;
  if (!isIdentity(request.directory) || request.operation === null ||
      typeof request.operation !== "object") {
    throw new Error("Pinned mutation request identity is invalid");
  }
  const operation = request.operation;
  if (
    ((operation.kind === "install" ||
      operation.kind === "restore" ||
      operation.kind === "probe_link") &&
      !isIdentity(operation.sourceIdentity)) ||
    (operation.kind === "read" &&
      operation.identity !== undefined &&
      !isIdentity(operation.identity)) ||
    (operation.kind === "remove" &&
      operation.identity !== null &&
      !isIdentity(operation.identity))
  ) {
    throw new Error("Pinned mutation operation identity is invalid");
  }
  return request;
}

function isIdentity(value: unknown): value is Identity {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Identity).device === "string" &&
    /^(?:0|[1-9]\d*)$/u.test((value as Identity).device) &&
    typeof (value as Identity).inode === "string" &&
    /^(?:0|[1-9]\d*)$/u.test((value as Identity).inode)
  );
}

function assertLeaf(value: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error("Pinned mutation leaf name is invalid");
  }
}

function assertAbsent(name: string): void {
  try {
    lstatSync(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Pinned mutation destination already exists");
}

function exists(name: string): boolean {
  try {
    lstatSync(name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertFile(
  name: string,
  identity?: Identity,
  expectedSha256?: string,
  expectedMode?: number,
): void {
  const descriptor = openSync(name, READ_FLAGS);
  try {
    const { state, bytes } = readBoundedDescriptor(descriptor);
    if (
      !state.isFile() ||
      (identity !== undefined &&
        (state.dev.toString() !== identity.device || state.ino.toString() !== identity.inode)) ||
      (expectedMode !== undefined && Number(state.mode & 0o777n) !== expectedMode)
    ) {
      throw new Error("Pinned mutation file identity mismatch");
    }
    if (expectedSha256 !== undefined && sha256(bytes) !== expectedSha256) {
      throw new Error("Pinned mutation file content mismatch");
    }
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusive(name: string, bytes: Buffer, mode: number): void {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(name, flags, mode);
  try {
    // The inode receives its final mode while it is still reachable only by
    // the reserved staging name. No post-install chmod can follow a raced
    // symlink or alter an unauthenticated replacement.
    fchmodSync(descriptor, mode);
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fileResult(
  name: string,
  includeBytes = false,
  testAppendAfterStat?: string,
): FileResult {
  const descriptor = openSync(name, READ_FLAGS);
  try {
    const { state, bytes } = readBoundedDescriptor(
      descriptor,
      testAppendAfterStat === undefined
        ? undefined
        : () => appendFileSync(name, testAppendAfterStat),
    );
    if (!state.isFile()) throw new Error("Pinned mutation result is not a regular file");
    return {
      device: state.dev.toString(),
      inode: state.ino.toString(),
      sha256: sha256(bytes),
      mode: Number(state.mode & 0o777n),
      modifiedAtMs: Number(state.mtimeNs) / 1_000_000,
      ...(includeBytes ? { bytes: bytes.toString("base64") } : {}),
    };
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedDescriptor(
  descriptor: number,
  afterStat?: () => void,
): { readonly state: BigIntStats; readonly bytes: Buffer } {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile()) throw new Error("Pinned mutation target is not a regular file");
  if (before.size > 16n * 1024n * 1024n) {
    throw new Error("Pinned mutation file exceeds the protocol limit");
  }
  afterStat?.();
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error("Pinned mutation file changed during bounded read");
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (readSync(descriptor, extra, 0, 1, bytes.length) !== 0) {
    throw new Error("Pinned mutation file grew during bounded read");
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mode !== before.mode ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  ) {
    throw new Error("Pinned mutation file changed during bounded read");
  }
  return { state: after, bytes };
}

function identityOf(name: string): Identity {
  const descriptor = openSync(name, READ_FLAGS);
  try {
    const state = fstatSync(descriptor, { bigint: true });
    if (!state.isFile()) throw new Error("Pinned mutation identity target is not a file");
    return { device: state.dev.toString(), inode: state.ino.toString() };
  } finally {
    closeSync(descriptor);
  }
}

function removeExact(
  name: string,
  expected: Identity,
  expectedSha256?: string,
  expectedMode?: number,
  testReplaceAfterValidation?: {
    readonly parked: string;
    readonly bytes: string;
    readonly mode: number;
  },
): void {
  assertFile(name, expected, expectedSha256, expectedMode);
  if (testReplaceAfterValidation !== undefined) {
    assertLeaf(testReplaceAfterValidation.parked);
    renameSync(name, testReplaceAfterValidation.parked);
    writeExclusive(
      name,
      Buffer.from(testReplaceAfterValidation.bytes, "base64"),
      testReplaceAfterValidation.mode,
    );
  }
  assertFile(name, expected, expectedSha256, expectedMode);
  unlinkSync(name);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function respond(value: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, value })}\n`);
}

try {
  main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
