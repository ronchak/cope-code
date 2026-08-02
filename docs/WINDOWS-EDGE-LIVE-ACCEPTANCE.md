# Windows Edge live acceptance runbook

This is a data-collection procedure. It is not a GO/NO-GO decision, and it is not proof of the service banner wording before the live run. The accountable release owner makes governance decisions from the bounded observations collected here.

Run the procedure in one Windows PowerShell window as the normal logged-in user. Never open PowerShell as Administrator and never elevate this run. Keep the visible, supported Microsoft Edge session available for the two live resumes. Do not edit `docs/LIVE-PILOT-ACCEPTANCE.md`.

## Safety and handling

The procedure intentionally keeps raw material local. Do not open, parse, copy, or share `audit.jsonl`, `session.json`, browser transcripts, raw CLI JSON, raw review packages, or any file under the state home. The bounded PowerShell projections below are the only permitted collection interface; they parse command responses in memory, and parse the newly written review file only to produce its bounded projection. Do not separately inspect or disclose those raw blobs.

Do not paste or share any of the following:

- response bodies, prompts or objectives, conversation content, model summaries or reports, or command output;
- repository paths, source, diffs, file names, browser URLs or profile paths;
- user or tenant identity, executable paths or digests, policy/grant hashes or identifiers;
- credentials, tokens, cookies, or full unfiltered output from `doctor`, `status`, `sessions`, or review commands.

The live `resume` terminal may display response content or developer-command output. None of that is evidence to paste back. Do not copy path-bearing recovery guidance; follow it only locally and exactly as shown.

## Fixed target and refresh order

Start with a fresh, non-elevated PowerShell window. Set these variables once and keep this window open for the entire procedure:

```powershell
$ErrorActionPreference = "Stop"

$Repository = "C:\Users\V0X8\Downloads\cope-code-current"
$StateHome = "C:\Users\V0X8\AppData\Local\CopilotBrowserAgent"
$ProtocolSession = "session_bd177950-5597-450d-9c8c-abd855155fe5"
$TerminalSession = "session_fdd1d48c-a7ef-4e26-a341-a5f1b9a1a9a5"

Set-Location -LiteralPath $Repository
```

The IDs above are fixed acceptance targets; do not substitute another session.

Show the branch and worktree state. Stop on any unexpected local change. Do not stash, reset, clean, or otherwise alter pre-existing work:

```powershell
$GitStatus = @(& git status --short --branch)
$GitStatusExit = $LASTEXITCODE
if ($GitStatusExit -ne 0) {
    throw "git status failed; stop without changing the worktree."
}
$GitStatus | ForEach-Object { Write-Host $_ }
$UnexpectedLocalChanges = @($GitStatus | Where-Object { $_ -notmatch '^\#\# ' })
if ($UnexpectedLocalChanges.Count -gt 0) {
    throw "Unexpected local changes are present. Stop; do not stash, reset, or clean them."
}
```

Refresh and record the exact acceptance revision in this order:

```powershell
& git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) {
    throw "git pull --ff-only origin main failed; stop."
}

$AcceptanceGitSha = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($AcceptanceGitSha)) {
    throw "Could not record the acceptance Git SHA; stop."
}
Write-Host "Acceptance Git SHA: $AcceptanceGitSha"

& git merge-base --is-ancestor d2edbcb HEAD
$MergeBaseExit = $LASTEXITCODE
if ($MergeBaseExit -ne 0) {
    throw "PR #50 base d2edbcb is not present in HEAD; stop."
}
Write-Host "PR #50 base is present."

& npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed; stop."
}

& npm run build
if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed; stop."
}

& npm run install:cope -- -SkipBuild -SkipSetup
if ($LASTEXITCODE -ne 0) {
    throw "Global Cope refresh failed; stop."
}

$PackageVersion = ((Get-Content package.json -Raw | ConvertFrom-Json).version).ToString()
$CliVersion = (& cope --version).Trim()
$CliVersionExit = $LASTEXITCODE
$VersionMatch = $CliVersionExit -eq 0 -and $CliVersion -eq $PackageVersion
Write-Host "Package version: $PackageVersion"
Write-Host "CLI version: $CliVersion"
Write-Host "Package/CLI version match: $VersionMatch"
if (-not $VersionMatch) {
    throw "cope --version does not match package.json; stop."
}
```

The source-backed Windows interface does not support `COPE_STATE_HOME`; Windows resolves its default from `LOCALAPPDATA`. Do not set that environment variable. Use the explicit supported `--state-home $StateHome` option on every applicable `cope` command below. `cope --version` has no state-home input and is the intentional exception.

The installer invocation above uses `-SkipBuild -SkipSetup`: it refreshes the global CLI without rebuilding or rerunning setup.

## Doctor

Run `cope doctor --json --repo $Repository --state-home $StateHome` against the target repository and state home. The script captures its JSON only in memory and prints the overall `ok` plus each check's `name`, `ok`, `required`, and safe `summary`; it never prints `detail` or `evidence`:

```powershell
function Invoke-CopeJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $Raw = ""
    $ExitCode = 1
    try {
        $Raw = ((& cope @Arguments 2>&1) | Out-String)
        $ExitCode = [int]$LASTEXITCODE
    } catch {
        return [pscustomobject]@{
            exitCode = 1
            json = $null
        }
    }

    $Json = $null
    try {
        $Json = $Raw | ConvertFrom-Json
    } catch {
        $Json = $null
    }
    return [pscustomobject]@{
        exitCode = $ExitCode
        json = $Json
    }
}

function Get-CaptureDiagnosticCode {
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }
    $Match = [regex]::Match(
        [string]$Value,
        '\b(?:PROTOCOL_WIDGET_[A-Z0-9_]+|UNSUPPORTED_CAPTURE_CONTRACT|MODEL_PROTOCOL_[A-Z0-9_]+|RESPONSE_CAPTURE_[A-Z0-9_]+)\b'
    )
    if ($Match.Success) { return $Match.Value }
    return $null
}

function Get-SafeFailureCode {
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) { return $null }
    $Text = ([string]$Value).Trim()
    if ($Text -match '^[A-Z][A-Z0-9_]{1,127}$') { return $Text }
    return $null
}

$DoctorCall = Invoke-CopeJson @(
    "doctor", "--json", "--repo", $Repository, "--state-home", $StateHome
)
$DoctorExit = $DoctorCall.exitCode
$Doctor = $DoctorCall.json
if ($null -eq $Doctor -or $null -eq $Doctor.checks) {
    throw "cope doctor did not return parseable JSON; stop without sharing its raw output."
}
if ($DoctorExit -notin @(0, 1)) {
    throw "cope doctor returned an unexpected exit code; stop."
}

$DoctorChecks = @(
    $Doctor.checks | ForEach-Object {
        $Summary = if ($null -ne $_.summary -and -not [string]::IsNullOrWhiteSpace([string]$_.summary)) {
            [string]$_.summary
        } elseif ([bool]$_.ok) {
            "passed"
        } else {
            "failed; inspect locally"
        }
        [ordered]@{
            name = [string]$_.name
            ok = [bool]$_.ok
            required = [bool]$_.required
            summary = $Summary
        }
    }
)
[ordered]@{
    ok = [bool]$Doctor.ok
    checks = $DoctorChecks
} | ConvertTo-Json -Depth 6

$DeveloperCheck = @($Doctor.checks | Where-Object { $_.name -eq "Developer terminal" } | Select-Object -First 1)
$DeveloperTerminalOk = $false
$DeveloperTerminalRequired = $false
$TerminalSummaryParts = [System.Collections.Generic.List[string]]::new()
if ($DeveloperCheck.Count -eq 1) {
    $DeveloperTerminalOk = [bool]$DeveloperCheck[0].ok
    $DeveloperTerminalRequired = [bool]$DeveloperCheck[0].required
    $Evidence = $DeveloperCheck[0].evidence
    if ($null -ne $Evidence.repository_config) {
        [void]$TerminalSummaryParts.Add("repository_enabled=$([bool]$Evidence.repository_config.developer_terminal_enabled)")
    }
    if ($null -ne $Evidence.repository_policy -and $null -ne $Evidence.repository_policy.decision) {
        [void]$TerminalSummaryParts.Add("repository_decision=$([string]$Evidence.repository_policy.decision)")
    }
    if ($null -ne $Evidence.machine_policy) {
        [void]$TerminalSummaryParts.Add("machine_status=$([string]$Evidence.machine_policy.status)")
        if ($null -ne $Evidence.machine_policy.decision) {
            [void]$TerminalSummaryParts.Add("machine_decision=$([string]$Evidence.machine_policy.decision)")
        }
    }
}
if ($TerminalSummaryParts.Count -eq 0) {
    [void]$TerminalSummaryParts.Add("decision/status unavailable")
}
[ordered]@{
    name = "Developer terminal"
    ok = $DeveloperTerminalOk
    required = $DeveloperTerminalRequired
    summary = ($TerminalSummaryParts -join "; ")
} | ConvertTo-Json -Depth 4

$RequiredDoctorFailures = @(
    $Doctor.checks | Where-Object { [bool]$_.required -and -not [bool]$_.ok }
)
$RequiredDoctorChecksOk = $RequiredDoctorFailures.Count -eq 0
$FailedRequiredDoctorCheckNames = @($RequiredDoctorFailures | ForEach-Object { [string]$_.name })
Write-Host "Doctor exit code: $DoctorExit (exit 0 covers required checks only)."
Write-Host "Required doctor checks OK: $RequiredDoctorChecksOk"
Write-Host "Failed required doctor checks: $(if ($FailedRequiredDoctorCheckNames.Count -eq 0) { 'none' } else { $FailedRequiredDoctorCheckNames -join ', ' })"
Write-Host "Developer terminal doctor check OK: $DeveloperTerminalOk"
if (-not $RequiredDoctorChecksOk) {
    throw "A required doctor check failed; stop the live smoke."
}
```

Doctor exit `0` means only that required checks passed. `Developer terminal` is optional in doctor and must independently have `ok: true` before the terminal smoke. The protocol-capture doctor check is synthetic: it exercises the host normalizer and never proves live Microsoft 365 compatibility.

## Sessions and pre-run status

Run `cope sessions --all --json --state-home $StateHome`, parse in memory, filter to the two exact IDs, and emit only the fields below. The recovery `next` value is deliberately not printed because it can contain paths:

```powershell
$ScenarioIds = @($ProtocolSession, $TerminalSession)
$SessionsCall = Invoke-CopeJson @(
    "sessions", "--all", "--json", "--state-home", $StateHome
)
if ($null -eq $SessionsCall.json -or $null -eq $SessionsCall.json.sessions) {
    throw "cope sessions did not return parseable JSON; stop without sharing its raw output."
}
if ($SessionsCall.exitCode -ne 0) {
    throw "cope sessions returned a failure; stop without sharing its raw output."
}

$SessionById = @{}
foreach ($SessionId in $ScenarioIds) {
    $Found = @(
        $SessionsCall.json.sessions | Where-Object { $_.sessionId -eq $SessionId } | Select-Object -First 1
    )
    if ($Found.Count -eq 0) {
        $SessionById[$SessionId] = [ordered]@{
            sessionId = $SessionId
            listed = $false
            status = "not_listed"
            resumable = $false
            recoveryDisposition = "not_listed"
            recoveryReason = "NOT_IN_BOUNDED_LIST"
        }
    } else {
        $SessionById[$SessionId] = [ordered]@{
            sessionId = [string]$Found[0].sessionId
            listed = $true
            status = [string]$Found[0].status
            resumable = [bool]$Found[0].resumable
            recoveryDisposition = [string]$Found[0].recovery.disposition
            recoveryReason = [string]$Found[0].recovery.reason
        }
    }
}
@($ScenarioIds | ForEach-Object { $SessionById[$_] }) | ConvertTo-Json -Depth 5

$ResumeReadyById = @{}
foreach ($SessionId in $ScenarioIds) {
    $Summary = $SessionById[$SessionId]
    $ResumeReadyById[$SessionId] =
        $Summary.status -ne "not_listed" -and
        [bool]$Summary.resumable -and
        $Summary.recoveryDisposition -eq "resume_candidate"
    if (-not $ResumeReadyById[$SessionId]) {
        Write-Warning "Stop scenario ${SessionId}: it is not in the bounded listing or is non-resumable. Follow only the exact recovery guidance shown locally; do not copy path-bearing text and do not perform ad-hoc recovery."
    }
}
```

For each scenario, an ID absent from the bounded listing or a non-resumable recovery disposition is a stop for that scenario. Despite its name, the current `sessions --all` implementation returns at most 100 records; `NOT_IN_BOUNDED_LIST` therefore does not prove that state is absent. Follow only the exact recovery guidance shown locally; do not copy its path-bearing text and do not invent a recovery step.

Run `cope status <id> --json --state-home $StateHome` for both IDs. This projection contains only session ID, status, mode, turns, mutations, validations, pending operations, budget usage operations, and code-only failure evidence. It extracts only capture-code families from `pauseReason` or `failure.message`, accepts only an uppercase underscore-delimited `failure.code`, and never emits either free-form string. It omits repository, grant, policy, disclosure, completion-report, task-ID, hash, and content-bearing fields:

```powershell
function Get-BoundedStatusRecord {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId
    )

    $Call = Invoke-CopeJson @(
        "status", $SessionId, "--json", "--state-home", $StateHome
    )
    $Status = $Call.json
    if ($null -eq $Status -or $null -eq $Status.sessionId -or $null -eq $Status.status) {
        return [pscustomobject]@{
            exitCode = $Call.exitCode
            projection = [ordered]@{
                sessionId = $SessionId
                statusExitCode = $Call.exitCode
                status = "unavailable"
                mode = $null
                turns = $null
                mutations = $null
                validations = $null
                pendingOperations = $null
                budgetUsageOperations = $null
                captureDiagnosticCode = $null
                failureCode = "STATUS_UNAVAILABLE"
            }
        }
    }

    $Failure = $Status.failure
    $CaptureDiagnosticCode = Get-CaptureDiagnosticCode $Status.pauseReason
    if ($null -eq $CaptureDiagnosticCode -and $null -ne $Failure) {
        $CaptureDiagnosticCode = Get-CaptureDiagnosticCode $Failure.message
    }
    return [pscustomobject]@{
        exitCode = $Call.exitCode
        projection = [ordered]@{
            sessionId = [string]$Status.sessionId
            statusExitCode = $Call.exitCode
            status = [string]$Status.status
            mode = [string]$Status.mode
            turns = $Status.turns
            mutations = $Status.mutations
            validations = $Status.validations
            pendingOperations = $Status.pendingOperations
            budgetUsageOperations = $Status.budgets.usage.operations
            captureDiagnosticCode = $CaptureDiagnosticCode
            failureCode = if ($null -eq $Failure) { $null } else { Get-SafeFailureCode $Failure.code }
        }
    }
}

$PreStatusById = @{}
foreach ($SessionId in $ScenarioIds) {
    $PreStatusById[$SessionId] = Get-BoundedStatusRecord $SessionId
}
@($ScenarioIds | ForEach-Object { $PreStatusById[$_].projection }) | ConvertTo-Json -Depth 8
```

Record each `budgetUsageOperations` value as that scenario's `preOperations`. The post-run projection below supplies `postOperations`. If `preOperations` is already greater than zero, preserve that fact: a later unchanged total cannot prove that the current resume accepted a new operation.

## Live smoke order

### 1. Protocol scenario

Run protocol first, only if its pre-run session is resumable. This is the visible Edge resume. Do not add `--json`, capture its output, or paste it:

```powershell
$ProtocolResumeExit = $null
if ($ResumeReadyById[$ProtocolSession]) {
    Write-Host "Protocol resume is live and may display response or command content; do not capture or paste that output."
    cope resume $ProtocolSession --state-home $StateHome
    $ProtocolResumeExit = $LASTEXITCODE
    Write-Host "Protocol resume exit code: $ProtocolResumeExit"
} else {
    Write-Warning "Protocol scenario NOT RUN because its ID was not in the bounded listing or it was non-resumable."
}
```

After the protocol resume returns, collect status, then `cope verify-audit <id> --json --state-home $StateHome`, then `cope export-review <id> --json --output <unique-file> --state-home $StateHome`, in that order. The review file is written to a newly created unique temporary directory outside both the repository and state home:

```powershell
function Get-BoundedAuditRecord {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId
    )

    $Call = Invoke-CopeJson @(
        "verify-audit", $SessionId, "--json", "--state-home", $StateHome
    )
    $Audit = $Call.json
    $Valid =
        $Call.exitCode -eq 0 -and
        $null -ne $Audit -and
        [bool]$Audit.valid -and
        [string]$Audit.sessionId -eq $SessionId -and
        [bool]$Audit.disclosureLedgerValid
    return [pscustomobject]@{
        exitCode = $Call.exitCode
        projection = [ordered]@{
            valid = $Valid
            sessionId = if ($null -ne $Audit.sessionId) { [string]$Audit.sessionId } else { $SessionId }
            eventCount = if ($Valid) { $Audit.eventCount } else { $null }
            disclosureLedgerValid = if ($Valid) { [bool]$Audit.disclosureLedgerValid } else { $false }
        }
    }
}

function Get-BoundedReviewRecord {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [Parameter(Mandatory = $true)]
        [string]$EvidenceDirectory
    )

    $ReviewFile = Join-Path $EvidenceDirectory ("review-" + [guid]::NewGuid().ToString("N") + ".json")
    $Call = Invoke-CopeJson @(
        "export-review", $SessionId, "--json", "--output", $ReviewFile, "--state-home", $StateHome
    )
    $Review = $null
    $Capture = $null
    $CaptureState = $null
    $Exported =
        $Call.exitCode -eq 0 -and
        $null -ne $Call.json -and
        [bool]$Call.json.exported -and
        [string]$Call.json.sessionId -eq $SessionId
    $Parsed = $false
    if ($Exported -and (Test-Path -LiteralPath $ReviewFile -PathType Leaf)) {
        try {
            $Review = Get-Content -LiteralPath $ReviewFile -Raw | ConvertFrom-Json
            $Capture = $Review.body.capture
            $CaptureState = if ($null -ne $Capture) { [string]$Capture.state } else { $null }
            $Parsed =
                $null -ne $Review -and
                [string]$Review.version -eq "cba-review-package/1" -and
                $null -ne $Review.body -and
                $null -ne $Review.body.session -and
                [string]$Review.body.session.sessionId -eq $SessionId -and
                [string]$Review.integrity.algorithm -eq "sha256" -and
                $CaptureState -in @("not_recorded", "recorded") -and
                ($CaptureState -ne "recorded" -or $null -ne $Capture.evidence)
        } catch {
            $Review = $null
            $Parsed = $false
        }
    }

    $RecordedCapture = $Parsed -and $CaptureState -eq "recorded"
    $CaptureEvidence = if ($RecordedCapture) { $Capture.evidence } else { $null }

    return [pscustomobject]@{
        exitCode = $Call.exitCode
        exported = $Exported
        parsed = $Parsed
        projection = [ordered]@{
            exportedAndParsed = $Exported -and $Parsed
            version = if ($Parsed) { [string]$Review.version } else { $null }
            sessionId = if ($Parsed) { [string]$Review.body.session.sessionId } else { $SessionId }
            status = if ($Parsed) { [string]$Review.body.session.status } else { $null }
            captureState = if ($Parsed) { $CaptureState } else { $null }
            captureContractVersion = if ($RecordedCapture) { [string]$CaptureEvidence.contractVersion } else { $null }
            captureStatus = if ($RecordedCapture) { [string]$CaptureEvidence.status } else { $null }
            captureProtocolVersion = if ($RecordedCapture -and $null -ne $CaptureEvidence.protocolVersion) { [string]$CaptureEvidence.protocolVersion } else { $null }
            captureReasonCode = if ($RecordedCapture -and $null -ne $CaptureEvidence.reasonCode) { [string]$CaptureEvidence.reasonCode } else { $null }
            captureProtocolErrorCode = if ($RecordedCapture -and $null -ne $CaptureEvidence.protocolErrorCode) { [string]$CaptureEvidence.protocolErrorCode } else { $null }
            codeBlockCount = if ($RecordedCapture) { $CaptureEvidence.codeBlockCount } else { $null }
            protocolBlockCount = if ($RecordedCapture) { $CaptureEvidence.protocolBlockCount } else { $null }
            editorCount = if ($RecordedCapture) { $CaptureEvidence.editorCount } else { $null }
            bannerCount = if ($RecordedCapture) { $CaptureEvidence.bannerCount } else { $null }
            lineCount = if ($RecordedCapture) { $CaptureEvidence.lineCount } else { $null }
            contentBytes = if ($RecordedCapture) { $CaptureEvidence.contentBytes } else { $null }
            bannerContract = if ($RecordedCapture -and $null -ne $CaptureEvidence.bannerContract) { [string]$CaptureEvidence.bannerContract } else { $null }
            bannerTokenCount = if ($RecordedCapture) { $CaptureEvidence.bannerTokenCount } else { $null }
            bannerMatchesBaseline = if ($RecordedCapture) { $CaptureEvidence.bannerMatchesBaseline } else { $null }
            bannerVariant = if ($RecordedCapture -and $null -ne $CaptureEvidence.bannerVariant) { [string]$CaptureEvidence.bannerVariant } else { $null }
            turns = if ($Parsed) { $Review.body.budgets.usage.turns } else { $null }
            operations = if ($Parsed) { $Review.body.budgets.usage.operations } else { $null }
            completedOperations = if ($Parsed) { $Review.body.counts.completedOperations } else { $null }
            pendingOperations = if ($Parsed) { $Review.body.counts.pendingOperations } else { $null }
            mutations = if ($Parsed) { $Review.body.counts.mutations } else { $null }
            terminalMutations = if ($Parsed) { $Review.body.counts.terminalMutations } else { $null }
            validations = if ($Parsed) { $Review.body.counts.validations } else { $null }
            auditEventCount = if ($Parsed) { $Review.body.audit.eventCount } else { $null }
            integrityAlgorithm = if ($Parsed) { [string]$Review.integrity.algorithm } else { $null }
        }
    }
}

function Collect-BoundedEvidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [Parameter(Mandatory = $true)]
        [string]$EvidenceDirectory
    )

    $Status = Get-BoundedStatusRecord $SessionId
    $Audit = Get-BoundedAuditRecord $SessionId
    $Review = Get-BoundedReviewRecord $SessionId $EvidenceDirectory
    return [pscustomobject]@{
        status = $Status
        audit = $Audit
        review = $Review
    }
}

$EvidenceRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cope-edge-acceptance-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -LiteralPath $EvidenceRoot | Out-Null
$RepositoryFull = [System.IO.Path]::GetFullPath($Repository).TrimEnd('\')
$StateHomeFull = [System.IO.Path]::GetFullPath($StateHome).TrimEnd('\')
$EvidenceFull = [System.IO.Path]::GetFullPath($EvidenceRoot).TrimEnd('\')
if ($EvidenceFull.StartsWith($RepositoryFull + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
    $EvidenceFull.StartsWith($StateHomeFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The temporary evidence directory is not outside the repository and state home; stop."
}

$ProtocolEvidence = $null
if ($ResumeReadyById[$ProtocolSession]) {
    $ProtocolEvidence = Collect-BoundedEvidence $ProtocolSession $EvidenceRoot
    Write-Host "Protocol bounded status:"
    $ProtocolEvidence.status.projection | ConvertTo-Json -Depth 8
    Write-Host "Protocol bounded audit verification:"
    $ProtocolEvidence.audit.projection | ConvertTo-Json -Depth 6
    Write-Host "Protocol bounded review:"
    $ProtocolEvidence.review.projection | ConvertTo-Json -Depth 8
}
```

The audit projection deliberately omits `finalEventHash`. The review projection includes only the listed version, session, status, count, budget, mutation, validation, audit-count, integrity-algorithm, and sanitized capture fields; it omits `bodySha256` and all other hashes. Do not print the review file or the raw command responses.

### 2. Developer-terminal scenario

Run terminal second only when the separately printed `Developer terminal` doctor check had `ok: true` and the terminal session was resumable. If the check is false, terminal is **NOT RUN** and readiness is blocked at the locally reported layer; the protocol scenario may still run when required doctor checks passed.

```powershell
$TerminalResumeExit = $null
$TerminalEvidence = $null
if (-not $DeveloperTerminalOk) {
    Write-Warning "Terminal scenario NOT RUN: Developer terminal doctor check is false; readiness is blocked at the locally reported layer."
} elseif (-not $ResumeReadyById[$TerminalSession]) {
    Write-Warning "Terminal scenario NOT RUN: its ID was not in the bounded listing or it was non-resumable."
} else {
    Write-Host "Terminal resume is live and may display response or developer-command content; do not capture or paste that output."
    cope resume $TerminalSession --state-home $StateHome
    $TerminalResumeExit = $LASTEXITCODE
    Write-Host "Terminal resume exit code: $TerminalResumeExit"

    $TerminalEvidence = Collect-BoundedEvidence $TerminalSession $EvidenceRoot
    Write-Host "Terminal bounded status:"
    $TerminalEvidence.status.projection | ConvertTo-Json -Depth 8
    Write-Host "Terminal bounded audit verification:"
    $TerminalEvidence.audit.projection | ConvertTo-Json -Depth 6
    Write-Host "Terminal bounded review:"
    $TerminalEvidence.review.projection | ConvertTo-Json -Depth 8
}
```

Exit code `0` alone is not a pass. Exit code `2` means the session is paused. Always retain the separate post-run status fact and the bounded operation count.

## Evidence truth table

These are the fields the currently supported source-free commands can truthfully provide. Raw forms contain more sensitive material and are not evidence to share.

| Command | Safe acceptance observation | What it cannot provide or must not expose |
| --- | --- | --- |
| `cope sessions` | `status`, resumability, recovery disposition, and recovery reason for a session | No banner or capture fields. The raw form also contains the objective and repository root; do not share it. |
| `cope status` | Turns, `budgets.usage.operations`, mutation/validation/pending counts, `pauseReason`, and failure code/message | No structured capture object; none of `bannerContract`, `bannerTokenCount`, `bannerMatchesBaseline`, `bannerVariant`, `protocolErrorCode`, or a classification branch. A `reasonCode` may survive only inside free-form `pauseReason` or the failure message. This runbook emits only the whitelisted capture code extracted from those strings and the structurally safe failure code; it never emits either string. |
| `cope verify-audit` | Validity, session ID, audit event count, final hash, and disclosure-ledger validity | Verifies integrity but emits no events or capture fields. The runbook omits the final hash from share output. |
| `cope export-review` | Source-free counts, budgets, mutation/validation metadata, audit summary, and the newest strictly sanitized capture evidence; `capture.state` explicitly reports `recorded` or `not_recorded` | Exposes no raw audit events or response content. The runbook omits the review body hash and all other hashes from share output. |

The capture-evidence surfacing gap is closed for `cope export-review`: it reports the newest eligible `model.response` or `protocol.error` capture evidence after strict shared sanitization, or explicitly reports `capture.state=not_recorded` when no eligible event carries capture evidence. It still exposes no raw audit events or response content. Do not inspect raw audit or review material. A post-run `budgets.usage.operations > 0` proves that this session durably registered at least one normalized operation selected from a model response; it does not prove that the operation succeeded. To attribute that fact to this resume, require `postOperations > preOperations`. A zero or unchanged operation count cannot prove that the current response path executed.

## Verdict rules

Keep response-path execution separate from scenario completion/status.

| Observation | Exact verdict |
| --- | --- |
| `postOperations > preOperations` and `postOperations > 0` | **PASS** for current response-path execution only: a normalized operation was durably registered. Preserve its outcome and the separate scenario completion/status facts. |
| Operation count increased plus `status = completed` | Current response path executed and the scenario completed. |
| Operation count increased plus `status = paused` or `failed` | Current response path executed, but a later or additional failure remains; use the bounded code/status to name it. |
| `postOperations = 0` or `postOperations = preOperations`, plus `captureState = not_recorded` | **INCONCLUSIVE**; no new operation and no recorded capture evidence establish this response path. |
| No operation was added, and recorded capture evidence has a failing classification/reason (`captureStatus` or its bounded reason/error code) | **NEEDS INVESTIGATION**; report the exact bounded `captureStatus`, `captureReasonCode`, and/or `captureProtocolErrorCode`. |
| No operation was added, `captureState = recorded`, `bannerMatchesBaseline = false`, and `bannerVariant` is present | **NEEDS INVESTIGATION — BANNER_BASELINE_CHANGED**; report that exact nameable cause plus the exact 8-hex `bannerVariant`. Do not claim Microsoft wording or any cause beyond baseline mismatch. |
| `captureState = recorded` and `bannerMatchesBaseline = true` | The operator may state that baseline banner drift was not observed for that capture; preserve any other failure classification or reason. |
| `postOperations = 0` plus a capture/protocol diagnostic code | No operation was registered; report the exact bounded code and **NEEDS INVESTIGATION**. |
| `postOperations = 0` without a capture diagnostic code or recorded capture evidence | **INCONCLUSIVE**, not pass. |
| `postOperations > 0` but `postOperations = preOperations` | The session has prior operation evidence, but this resume did not add any; current response-path execution is **INCONCLUSIVE**. |
| Developer terminal doctor check false | Terminal scenario **NOT RUN**; readiness is blocked at the locally reported layer. The protocol scenario may still run if required doctor checks pass. |
| A bounded status command is nonzero, `verify-audit` is invalid, or `export-review` fails or cannot be parsed as the matching package | **EVIDENCE INVALID/INCOMPLETE**, even if the UI appeared successful. |
| Audit/review session ID, status, operation count, or audit-event count disagrees with the bounded status/audit records | **EVIDENCE INVALID/INCOMPLETE**; do not reconcile the values by hand. |
| ID absent from the bounded session listing, or non-resumable session | **NOT RUN**; no ad-hoc recovery. Absence from the 100-record listing is not proof that its state is absent. |

The current service wording is unknown and irrelevant to this pass rule. Do not invent live wording in the verdict.

## Paste-this-back block

Paste only a completed version of this minimal template. Replace placeholders with bounded values from the projections. Use only the code fields emitted by the bounded status projection; never substitute a path-free paraphrase or raw text. The acceptance Git SHA is the one permitted revision identifier here. Do not include audit/review/policy/grant/browser/executable hashes, timestamps, paths, objectives, content, identities, or raw blobs. `resumeExitCode: 0` alone is not a pass; `resumeExitCode: 2` means paused.

```text
WINDOWS EDGE ACCEPTANCE
acceptanceGitSha: <commit SHA>
packageVersion: <version>
cliVersion: <version>
versionMatch: <true|false>

doctorRequiredChecksOk: <true|false>
failedRequiredDoctorChecks: <none|comma-separated check names>
developerTerminalOk: <true|false>
developerTerminalSummary: <repository_enabled/decision/status values from bounded projection>

protocol:
  sessionId: session_bd177950-5597-450d-9c8c-abd855155fe5
  listed: <true|false>
  resumable: <true|false>
  recoveryDisposition: <value|not-run>
  recoveryReason: <code|unavailable|not-run>
  resumeExitCode: <0|1|2|other|not-run>
  preStatusExitCode: <0|other|not-run>
  postStatusExitCode: <0|other|not-run>
  preStatus: <status|not-run>
  status: <status|not-run>
  preTurns: <number|not-run>
  postTurns: <number|not-run>
  preOperations: <number|not-run>
  postOperations: <number|not-run>
  mutations: <number|not-run>
  validations: <number|not-run>
  pendingOperations: <number|not-run>
  captureDiagnosticCode: <code|unavailable|not-run>
  failureCode: <code|unavailable|not-run>
  verifyAuditValid: <true|false|not-run>
  verifyAuditEventCount: <number|not-run>
  disclosureLedgerValid: <true|false|not-run>
  reviewExportedAndParsed: <true|false|not-run>
  reviewVersion: <version|not-run>
  reviewStatus: <status|not-run>
  reviewOperations: <number|not-run>
  reviewAuditEventCount: <number|not-run>
  captureState: <recorded|not_recorded|unavailable|not-run>
  captureContractVersion: <response-capture/v2|unavailable|not-run>
  captureStatus: <status|unavailable|not-run>
  captureProtocolVersion: <protocol version|unavailable|not-run>
  captureReasonCode: <code|unavailable|not-run>
  captureProtocolErrorCode: <code|unavailable|not-run>
  codeBlockCount: <number|unavailable|not-run>
  protocolBlockCount: <number|unavailable|not-run>
  editorCount: <number|unavailable|not-run>
  bannerCount: <number|unavailable|not-run>
  lineCount: <number|unavailable|not-run>
  contentBytes: <number|unavailable|not-run>
  bannerContract: <supported|unsupported_version|ambiguous_protocol_labels|unavailable|not-run>
  bannerTokenCount: <number|unavailable|not-run>
  bannerMatchesBaseline: <true|false|unavailable|not-run>
  bannerVariant: <8-hex|unavailable|not-run>

terminal:
  sessionId: session_fdd1d48c-a7ef-4e26-a341-a5f1b9a1a9a5
  listed: <true|false>
  resumable: <true|false>
  recoveryDisposition: <value|not-run>
  recoveryReason: <code|unavailable|not-run>
  resumeExitCode: <0|1|2|other|not-run>
  preStatusExitCode: <0|other|not-run>
  postStatusExitCode: <0|other|not-run>
  preStatus: <status|not-run>
  status: <status|not-run>
  preTurns: <number|not-run>
  postTurns: <number|not-run>
  preOperations: <number|not-run>
  postOperations: <number|not-run>
  mutations: <number|not-run>
  validations: <number|not-run>
  pendingOperations: <number|not-run>
  captureDiagnosticCode: <code|unavailable|not-run>
  failureCode: <code|unavailable|not-run>
  verifyAuditValid: <true|false|not-run>
  verifyAuditEventCount: <number|not-run>
  disclosureLedgerValid: <true|false|not-run>
  reviewExportedAndParsed: <true|false|not-run>
  reviewVersion: <version|not-run>
  reviewStatus: <status|not-run>
  reviewOperations: <number|not-run>
  reviewAuditEventCount: <number|not-run>
  captureState: <recorded|not_recorded|unavailable|not-run>
  captureContractVersion: <response-capture/v2|unavailable|not-run>
  captureStatus: <status|unavailable|not-run>
  captureProtocolVersion: <protocol version|unavailable|not-run>
  captureReasonCode: <code|unavailable|not-run>
  captureProtocolErrorCode: <code|unavailable|not-run>
  codeBlockCount: <number|unavailable|not-run>
  protocolBlockCount: <number|unavailable|not-run>
  editorCount: <number|unavailable|not-run>
  bannerCount: <number|unavailable|not-run>
  lineCount: <number|unavailable|not-run>
  contentBytes: <number|unavailable|not-run>
  bannerContract: <supported|unsupported_version|ambiguous_protocol_labels|unavailable|not-run>
  bannerTokenCount: <number|unavailable|not-run>
  bannerMatchesBaseline: <true|false|unavailable|not-run>
  bannerVariant: <8-hex|unavailable|not-run>

verdict:
  protocolResponsePath: <PASS|NEEDS INVESTIGATION|INCONCLUSIVE|NOT RUN>
  protocolScenarioStatus: <completed|paused|failed|not-run|other>
  terminalResponsePath: <PASS|NEEDS INVESTIGATION|INCONCLUSIVE|NOT RUN>
  terminalScenarioStatus: <completed|paused|failed|not-run|other>
  evidence: <VALID|EVIDENCE INVALID/INCOMPLETE>
```

## Limitations and escalation

The PM/author cannot run live Windows/Edge acceptance. The structured capture-evidence surfacing gap is closed: `export-review` now provides the newest strictly sanitized capture evidence or `not_recorded`. No live Windows/Edge service wording has been seen, and this runbook makes no GO/NO-GO decision. Do not claim Microsoft wording or causation from the bounded banner fields.

Retain the unique temporary evidence directory locally until the CTO confirms receipt. Then remove it according to local handling policy. Do not upload it and do not paste entire files.
