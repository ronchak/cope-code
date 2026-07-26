import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { AgentError } from "../shared/errors.js";
import { MAX_MUTATION_FILE_BYTES } from "../shared/mutation-limits.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

export interface PinnedIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface PinnedFileState extends PinnedIdentity {
  readonly sha256: string;
  readonly mode: number;
  readonly modifiedAtMs: number;
  readonly bytes?: string;
}

export interface PinnedQuarantine {
  readonly name: string;
  readonly identity: PinnedIdentity;
}

export const MAX_PINNED_FILE_BYTES = MAX_MUTATION_FILE_BYTES;
const MAX_PINNED_MESSAGE_BYTES = 32 * 1024 * 1024;
const DECIMAL_IDENTITY = /^(?:0|[1-9]\d*)$/u;

type PinnedOperation =
  | { readonly kind: "write"; readonly name: string; readonly bytes: string; readonly mode: number }
  | {
      readonly kind: "capture";
      readonly source: string;
      readonly destination: string;
      readonly sourceIdentity: PinnedIdentity;
      readonly expectedSha256: string;
      readonly expectedMode: number;
      readonly quarantine: PinnedQuarantine;
      readonly testCreateDestinationAfterValidation?: string;
      readonly testReplaceSourceAfterValidation?: {
        readonly parked: string;
        readonly bytes: string;
        readonly mode: number;
      };
      readonly testReplaceBeforeRemoval?: {
        readonly parked: string;
        readonly bytes: string;
        readonly mode: number;
      };
      readonly testWriteAfterCaptureValidation?: string;
      readonly testFailAfterLink?: boolean;
      readonly testFailAfterQuarantineMove?: boolean;
    }
  | {
      readonly kind: "install";
      readonly source: string;
      readonly destination: string;
      readonly sourceIdentity: PinnedIdentity;
      readonly sourceSha256: string;
      readonly sourceMode: number;
      readonly failAfterLink?: boolean;
      readonly testDeleteDestinationAfterLink?: boolean;
    }
  | {
      readonly kind: "probe_link";
      readonly source: string;
      readonly destination: string;
      readonly sourceIdentity: PinnedIdentity;
      readonly sourceSha256: string;
      readonly sourceMode: number;
      readonly quarantine: PinnedQuarantine;
      readonly failBeforeLink?: boolean;
    }
  | {
      readonly kind: "read";
      readonly name: string;
      readonly identity?: PinnedIdentity;
      /** @internal Deterministic growth injection after descriptor stat. */
      readonly testAppendAfterStat?: string;
    }
  | {
      readonly kind: "remove";
      readonly name: string;
      readonly identity: PinnedIdentity | null;
      readonly expectedSha256?: string;
      readonly expectedMode?: number;
      readonly quarantine: PinnedQuarantine;
      readonly testReplaceAfterValidation?: {
        readonly parked: string;
        readonly bytes: string;
        readonly mode: number;
      };
      readonly testReplaceBeforeRemoval?: {
        readonly parked: string;
        readonly bytes: string;
        readonly mode: number;
      };
      readonly testFailAfterQuarantineMove?: boolean;
    }
  | {
      readonly kind: "create_quarantine";
      readonly name: string;
    }
  | {
      readonly kind: "reconcile_quarantine";
      readonly name: string;
      readonly identity: PinnedIdentity;
      readonly expectedSha256?: string;
      readonly expectedMode?: number;
      readonly quarantine: PinnedQuarantine;
    }
  | {
      readonly kind: "remove_quarantine";
      readonly quarantine: PinnedQuarantine;
    }
  | {
      readonly kind: "verify_quarantine";
      readonly quarantine: PinnedQuarantine;
    }
  | {
      readonly kind: "restore";
      readonly source: string;
      readonly destination: string;
      readonly sourceIdentity: PinnedIdentity;
      readonly sourceSha256: string;
      readonly sourceMode: number;
    }
  | {
      readonly kind: "verify_absent";
      readonly name: string;
    };

// Capture the helper payload once through the same installation trust boundary
// as this already-loaded module. Later pathname replacement cannot change the
// code executed by a mutation worker.
const WORKER_SOURCE = readFileSync(new URL("./pinned-mutation-worker.js", import.meta.url), "utf8");

export function runPinnedMutation(
  directory: string,
  directoryIdentity: PinnedIdentity,
  operation: PinnedOperation,
): PinnedFileState | Readonly<Record<string, unknown>> {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", WORKER_SOURCE],
    {
      cwd: directory,
      input: JSON.stringify({
        directory: directoryIdentity,
        supportsPosixModes: CURRENT_HOST_PLATFORM.supportsPosixModes,
        operation,
      }),
      encoding: "utf8",
      env: workerEnvironment(),
      maxBuffer: MAX_PINNED_MESSAGE_BYTES,
      windowsHide: true,
    },
  );
  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    response = undefined;
  }
  const parsed =
    response !== null && typeof response === "object"
      ? response as { readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown }
      : undefined;
  if (result.error !== undefined || result.status !== 0 || parsed?.ok !== true) {
    throw new AgentError(
      "RECOVERY_REQUIRED",
      "Pinned filesystem mutation failed",
      {
        operation: operation.kind,
        error:
          typeof parsed?.error === "string"
            ? parsed.error
            : result.error?.message ?? result.stderr.trim() ?? "worker failed",
      },
      result.error === undefined ? undefined : { cause: result.error },
    );
  }
  if (parsed.value === null || typeof parsed.value !== "object") {
    throw new AgentError("RECOVERY_REQUIRED", "Pinned filesystem mutation returned invalid evidence", {
      operation: operation.kind,
    });
  }
  return parsed.value as PinnedFileState | Readonly<Record<string, unknown>>;
}

export function pinnedIdentityFromBigInts(device: bigint, inode: bigint): PinnedIdentity {
  if (device < 0n || inode < 0n) {
    throw new AgentError("RECOVERY_REQUIRED", "Filesystem identity is invalid");
  }
  return { device: device.toString(), inode: inode.toString() };
}

export function isPinnedIdentity(value: unknown): value is PinnedIdentity {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PinnedIdentity).device === "string" &&
    DECIMAL_IDENTITY.test((value as PinnedIdentity).device) &&
    typeof (value as PinnedIdentity).inode === "string" &&
    DECIMAL_IDENTITY.test((value as PinnedIdentity).inode)
  );
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}
