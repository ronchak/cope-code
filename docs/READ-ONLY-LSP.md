# Read-only LSP foundation

Cope exposes one optional `lsp_query` tool for semantic code navigation. It is disabled by the default organization, repository, and session policies. A deployment must explicitly grant the tool and inject a `ReadOnlyLspBackend` into `ToolHost`.

The v1 boundary supports only `hover`, `definition`, `references`, and `document_symbols`. Requests carry a repository-relative file path, zero-based position when applicable, and explicit result, time, and byte bounds. The backend advertises a static operation allowlist; a server response cannot expand it.

This boundary intentionally does not expose LSP edits, rename, formatting, code actions, execute-command, workspace configuration, dynamic registration, file watching, network access, or process launch. A future language-server adapter must separately sandbox and supervise its process. Installing or detecting a language server must never imply enabling the tool or granting repository access.

Results are validated as typed locations/content, canonicalized through the repository boundary, capped without emitting partial JSON, and returned through the ordinary disclosure guard and audit path. Timeouts and caller cancellation abort the backend signal and map to deterministic tool outcomes.
