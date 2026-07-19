import { AgentError } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";
import type {
  ContentProcessingInput,
  ContentProcessingResult,
  ContentProcessor,
} from "../repository/types.js";
import type { DisclosureLedger } from "./disclosure-ledger.js";
import { SecretScanner, safeFinding, type SecretSeverity } from "./secrets.js";

export type SecretHandlingMode = "block-high" | "redact";

export interface ContentSecurityOptions {
  readonly modes?: Partial<Record<ContentProcessingInput["source"], SecretHandlingMode>>;
  readonly blockedSeverities?: readonly SecretSeverity[];
  readonly classification?: string;
}

export class ContentSecurity implements ContentProcessor {
  private readonly modes: Record<ContentProcessingInput["source"], SecretHandlingMode>;
  private readonly blockedSeverities: readonly SecretSeverity[];
  private readonly classification: string;

  public constructor(
    private readonly scanner: SecretScanner,
    private readonly ledger: DisclosureLedger,
    options: ContentSecurityOptions = {},
  ) {
    this.modes = {
      "repository-file": options.modes?.["repository-file"] ?? "block-high",
      "repository-search": options.modes?.["repository-search"] ?? "block-high",
      "command-output": options.modes?.["command-output"] ?? "redact",
      "tool-result": options.modes?.["tool-result"] ?? "block-high",
    };
    this.blockedSeverities = options.blockedSeverities ?? ["high"];
    this.classification = options.classification ?? "unclassified";
    if (this.classification.trim() === "" || this.classification.length > 128) {
      throw new AgentError("CONFIG_INVALID", "Disclosure classification is invalid");
    }
  }

  public async process(input: ContentProcessingInput): Promise<ContentProcessingResult> {
    const redaction = this.scanner.redact(input.content);
    const blockedFindings = redaction.findings.filter((finding) =>
      this.blockedSeverities.includes(finding.severity),
    );
    if (this.modes[input.source] === "block-high" && blockedFindings.length > 0) {
      await this.ledger.record({
        operationId: input.operationId,
        source: input.source,
        content: "",
        originalByteCount: Buffer.byteLength(input.content),
        ...(input.path === undefined ? {} : { path: input.path }),
        findings: blockedFindings,
        disclosed: false,
        classification: this.classification,
      });
      throw new AgentError("POLICY_DENIED", "Sensitive content was blocked before disclosure", {
        findingCount: blockedFindings.length,
        findings: blockedFindings.map(safeFinding),
        ...(input.path === undefined ? {} : { path: input.path }),
      });
    }

    const content = redaction.content;
    await this.ledger.record({
      operationId: input.operationId,
      source: input.source,
      content,
      originalByteCount: Buffer.byteLength(input.content),
      ...(input.path === undefined ? {} : { path: input.path }),
      findings: redaction.findings,
      disclosed: true,
      classification: this.classification,
    });
    return { content, redactionCount: redaction.redactionCount };
  }

  /** Implements the orchestrator DisclosureGuard contract structurally. */
  public async inspectAndSerialize(
    message: string,
    context: { readonly kind: "bootstrap" | "tool_result" | "repair" | "decision" },
  ): Promise<string> {
    const result = await this.process({
      operationId: `serialized:${context.kind}:${sha256(message).slice(0, 16)}`,
      source: "tool-result",
      content: message,
    });
    return result.content;
  }
}
