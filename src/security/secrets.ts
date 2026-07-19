import { createHmac, randomBytes } from "node:crypto";

import { AgentError } from "../shared/errors.js";

export type SecretKind =
  | "private-key"
  | "aws-access-key"
  | "github-token"
  | "jwt"
  | "bearer-token"
  | "credential-assignment"
  | "connection-string-password";

export type SecretSeverity = "high" | "medium";

export interface SecretFinding {
  readonly kind: SecretKind;
  readonly severity: SecretSeverity;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly fingerprint: string;
}

export interface RedactionResult {
  readonly content: string;
  readonly findings: readonly SecretFinding[];
  readonly redactionCount: number;
}

interface SecretRule {
  readonly kind: SecretKind;
  readonly severity: SecretSeverity;
  readonly source: string;
  readonly flags: string;
}

const RULES: readonly SecretRule[] = [
  {
    kind: "private-key",
    severity: "high",
    source:
      "-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\\s\\S]{16,}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    flags: "g",
  },
  { kind: "aws-access-key", severity: "high", source: "\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b", flags: "g" },
  {
    kind: "github-token",
    severity: "high",
    source: "\\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\\b",
    flags: "g",
  },
  {
    kind: "jwt",
    severity: "high",
    source: "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b",
    flags: "g",
  },
  {
    kind: "bearer-token",
    severity: "high",
    source: "\\bBearer[ \\t]+[A-Za-z0-9._~+/-]{20,}={0,2}",
    flags: "gi",
  },
  {
    kind: "credential-assignment",
    severity: "high",
    source:
      "\\b(?:password|passwd|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)[ \\t]*[:=][ \\t]*[\\\"']?[A-Za-z0-9_./+~-]{12,}[\\\"']?",
    flags: "gi",
  },
  {
    kind: "connection-string-password",
    severity: "high",
    source: "\\b(?:Password|Pwd)=[^;\\r\\n]{8,}",
    flags: "gi",
  },
] as const;

export class SecretScanner {
  public constructor(private readonly fingerprintKey: Uint8Array = randomBytes(32)) {}

  public scan(content: string): readonly SecretFinding[] {
    const candidates: SecretFinding[] = [];
    for (const rule of RULES) {
      const expression = new RegExp(rule.source, rule.flags);
      for (const match of content.matchAll(expression)) {
        const matched = match[0];
        const start = match.index;
        if (matched === undefined || start === undefined) {
          continue;
        }
        const location = lineAndColumn(content, start);
        candidates.push({
          kind: rule.kind,
          severity: rule.severity,
          start,
          end: start + matched.length,
          line: location.line,
          column: location.column,
          fingerprint: createHmac("sha256", this.fingerprintKey).update(matched).digest("hex").slice(0, 16),
        });
      }
    }
    return removeOverlaps(candidates);
  }

  public redact(content: string): RedactionResult {
    const findings = this.scan(content);
    let redacted = content;
    for (const finding of [...findings].sort((left, right) => right.start - left.start)) {
      const marker = `[REDACTED:${finding.kind}:${finding.fingerprint}]`;
      redacted = `${redacted.slice(0, finding.start)}${marker}${redacted.slice(finding.end)}`;
    }
    return { content: redacted, findings, redactionCount: findings.length };
  }

  public assertNoSecrets(content: string, blockedSeverities: readonly SecretSeverity[] = ["high"]): void {
    const findings = this.scan(content).filter((finding) => blockedSeverities.includes(finding.severity));
    if (findings.length > 0) {
      throw new AgentError("POLICY_DENIED", "Sensitive content cannot be disclosed", {
        findingCount: findings.length,
        findings: findings.map(safeFinding),
      });
    }
  }
}

export function safeFinding(finding: SecretFinding): Omit<SecretFinding, "start" | "end"> {
  return {
    kind: finding.kind,
    severity: finding.severity,
    line: finding.line,
    column: finding.column,
    fingerprint: finding.fingerprint,
  };
}

function lineAndColumn(content: string, offset: number): { readonly line: number; readonly column: number } {
  const prefix = content.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function removeOverlaps(candidates: readonly SecretFinding[]): readonly SecretFinding[] {
  const ordered = [...candidates].sort(
    (left, right) => left.start - right.start || right.end - right.start - (left.end - left.start),
  );
  const accepted: SecretFinding[] = [];
  for (const candidate of ordered) {
    if (accepted.some((existing) => candidate.start < existing.end && candidate.end > existing.start)) {
      continue;
    }
    accepted.push(candidate);
  }
  return accepted;
}
