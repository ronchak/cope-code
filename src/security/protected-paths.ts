import { minimatch } from "minimatch";

import { AgentError } from "../shared/errors.js";
import { normalizeRepositoryPath } from "../repository/boundary.js";
import { createFilesystemIdentity, type FilesystemIdentity } from "../shared/filesystem-identity.js";

export type PathOperation = "read" | "create" | "update" | "delete";

export interface PathProtectionPolicy {
  assertAllowed(path: string, operation: PathOperation): void;
}

export interface ProtectedPathRule {
  readonly pattern: string;
  readonly operations?: readonly PathOperation[];
  readonly reason?: string;
}

export const DEFAULT_PROTECTED_RULES: readonly ProtectedPathRule[] = [
  { pattern: ".git", reason: "Git control data is protected" },
  { pattern: ".git/**", reason: "Git control data is protected" },
  { pattern: ".copilot-agent", reason: "Agent control data is protected" },
  { pattern: ".copilot-agent/**", reason: "Agent control data is protected" },
  { pattern: ".cba", reason: "Agent control data is protected" },
  { pattern: ".cba/**", reason: "Agent control data is protected" },
  { pattern: ".env", reason: "Credential-bearing configuration is protected" },
  { pattern: ".env.*", reason: "Credential-bearing configuration is protected" },
  { pattern: "**/.env", reason: "Credential-bearing configuration is protected" },
  { pattern: "**/.env.*", reason: "Credential-bearing configuration is protected" },
  { pattern: "*.pem", reason: "Key material is protected" },
  { pattern: "*.key", reason: "Key material is protected" },
  { pattern: "*.pfx", reason: "Key material is protected" },
  { pattern: "*.p12", reason: "Key material is protected" },
  { pattern: ".github/workflows/**", reason: "Deployment and automation controls are protected" },
] as const;

export class ProtectedPathPolicy implements PathProtectionPolicy {
  private readonly rules: readonly ProtectedPathRule[];

  public constructor(
    rules: readonly ProtectedPathRule[] = [],
    includeDefaults = true,
    private readonly filesystemIdentity: FilesystemIdentity = createFilesystemIdentity({
      device: 0,
      caseSensitive: false,
      unicodeNormalizationAliases: true,
    }),
  ) {
    this.rules = includeDefaults ? [...DEFAULT_PROTECTED_RULES, ...rules] : [...rules];
  }

  public withFilesystemIdentity(filesystemIdentity: FilesystemIdentity): ProtectedPathPolicy {
    return new ProtectedPathPolicy(this.rules, false, filesystemIdentity);
  }

  public assertAllowed(untrustedPath: string, operation: PathOperation): void {
    const path = this.filesystemIdentity.normalize(normalizeRepositoryPath(untrustedPath));
    for (const rule of this.rules) {
      if (rule.operations !== undefined && !rule.operations.includes(operation)) {
        continue;
      }
      if (
        minimatch(path, this.filesystemIdentity.normalize(rule.pattern), {
          dot: true,
          nocase: !this.filesystemIdentity.caseSensitive,
          matchBase: !rule.pattern.includes("/"),
        })
      ) {
        throw new AgentError("PATH_PROTECTED", rule.reason ?? "Path is protected", {
          path,
          operation,
          rule: rule.pattern,
        });
      }
    }
  }
}
