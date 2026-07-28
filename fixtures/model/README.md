# Scripted model fixtures

CLI fixtures exercise the real orchestrator, protocol, policy, tool, state, audit, and completion paths without Edge or network access. They do not emulate model reasoning; they supply a deterministic sequence of model responses.

The file contract is `cba-scripted-fixture/1`:

```json
{
  "schema_version": "cba-scripted-fixture/1",
  "turns": [
    {
      "expected_content_contains": "optional exact substring",
      "conversation_id": "optional stable conversation identity",
      "submission_status": "submitted",
      "submission_diagnostic_code": "optional safe code",
      "response": {
        "status": "completed",
        "response_id": "optional identifier",
        "content": "one model response"
      }
    }
  ]
}
```

Top-level and turn fields are strict. `submission_status` may be `submitted`, `not-submitted`, or `indeterminate`. Response variants are:

- `completed`: `content` plus optional `response_id`;
- `blocked`: approved transport `reason`, optional `retryable` and `diagnostic_code`;
- `timed-out`: optional `incomplete`; or
- `indeterminate`: optional `diagnostic_code`.

Strings may contain `{{TASK_ID}}`, `{{TURN_ID}}`, and `{{SUBMISSION_ID}}` for
transport-level fixture assertions. A completed response may use
`{{OPERATION_REF}}` when the submitted harness message contains exactly one
successful tool result; the fixture transport substitutes that result's
harness-generated reference and fails closed for zero or multiple successful
results. Model responses should use `cba-agent/1` and omit task, turn, message,
and operation IDs; the harness derives those values. Historical `cba/1`
responses remain accepted as migration fixtures.

`example-discovery-session.json` is a two-turn, read-only completion example. Use it only with a synthetic repository whose completion policy has no required command IDs:

```powershell
node dist\src\cli\main.js run "Inspect the repository inventory" `
  --repo C:\work\synthetic-repo `
  --mode inspect `
  --transport fixture `
  --fixture .\fixtures\model\example-discovery-session.json `
  --accept "Repository inventory was inspected" `
  --approve-grant
```

The transport derives task, turn, and submission correlation locally. It fails on unexpected submitted content, reused IDs with different bytes, correlation mismatches, or fixture exhaustion. That strictness is intentional: a fixture should detect orchestration drift, not conceal it.

Do not put real source, prompts, responses, identities, tenant URLs, or secrets in committed fixtures. Use sanitized synthetic content and review fixtures as test code.
