[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$SkipSetup
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "OK $Message" -ForegroundColor Green
}

function Fail([string]$Message, [string]$Next = "") {
  Write-Host ""
  Write-Host "X $Message" -ForegroundColor Red
  if ($Next) { Write-Host "  $Next" -ForegroundColor DarkGray }
  exit 1
}

function Read-MajorVersion([string]$Value) {
  $match = [regex]::Match($Value, '(\d+)')
  if (-not $match.Success) { return 0 }
  return [int]$match.Groups[1].Value
}

function Read-PackageVersion([string]$PackageFile) {
  if (-not (Test-Path -LiteralPath $PackageFile -PathType Leaf)) {
    Fail "Release metadata is missing: $PackageFile"
  }
  try {
    $metadata = Get-Content -LiteralPath $PackageFile -Raw | ConvertFrom-Json
  } catch {
    Fail "Release metadata is not valid JSON: $PackageFile"
  }
  $versionProperty = $metadata.PSObject.Properties["version"]
  if ($null -eq $versionProperty -or $versionProperty.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($versionProperty.Value)) {
    Fail "Release metadata does not contain a version: $PackageFile"
  }
  return [string]$versionProperty.Value
}

function Ensure-UserPath([string]$Directory) {
  $normalized = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @()
  if ($userPath) { $entries = $userPath.Split(';', [StringSplitOptions]::RemoveEmptyEntries) }
  $present = $false
  foreach ($entry in $entries) {
    try {
      if ([IO.Path]::GetFullPath($entry).TrimEnd('\').Equals($normalized, [StringComparison]::OrdinalIgnoreCase)) {
        $present = $true
        break
      }
    } catch { }
  }
  if (-not $present) {
    $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $normalized } else { "$userPath;$normalized" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  }
  if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $normalized })) {
    $env:Path = "$env:Path;$normalized"
  }
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$ExpectedVersion = Read-PackageVersion (Join-Path $ProjectRoot "package.json")

Write-Host ""
Write-Host "COPE $ExpectedVersion installer" -ForegroundColor Magenta
Write-Host "Installs the global 'cope' command for this Windows account." -ForegroundColor DarkGray

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Fail "Node.js is not installed or is not on PATH." "Install Node.js 24 LTS, reopen PowerShell, then run install.cmd again."
}
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  Fail "npm is not installed or is not on PATH." "Repair your Node.js installation, reopen PowerShell, then run install.cmd again."
}

$nodeVersion = (& node.exe --version).Trim()
$npmVersion = (& npm.cmd --version).Trim()
if ((Read-MajorVersion $nodeVersion) -lt 24) {
  Fail "Cope requires Node.js 24 or newer. Found $nodeVersion." "Install Node.js 24 LTS, reopen PowerShell, then run install.cmd again."
}
if ((Read-MajorVersion $npmVersion) -lt 11) {
  Write-Host "! npm 11 or newer is recommended. Found $npmVersion." -ForegroundColor Yellow
  Write-Host "  The installer will continue because this package does not depend on npm 11-only behavior." -ForegroundColor DarkGray
}
Write-Ok "Node $nodeVersion and npm $npmVersion detected"

if (-not $SkipBuild) {
  Write-Step "Installing locked dependencies"
  & npm.cmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail "npm ci failed." "Review the error above and rerun install.cmd." }

  Write-Step "Building Cope"
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { Fail "The TypeScript build failed." "Review the error above and rerun install.cmd." }
}

$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("cope-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempDirectory | Out-Null
try {
  Write-Step "Creating a durable release package"
  $packOutput = ((& npm.cmd pack --json --ignore-scripts --pack-destination $tempDirectory) -join [Environment]::NewLine)
  if ($LASTEXITCODE -ne 0) { Fail "npm pack failed." }
  $packResult = $packOutput | ConvertFrom-Json
  if ($packResult -is [Array]) { $packedRelease = $packResult[0] } else { $packedRelease = $packResult }
  $packageName = $packedRelease.filename
  if ([string]::IsNullOrWhiteSpace($packageName)) { Fail "npm pack did not return a package filename." }
  if ($packedRelease.version -ne $ExpectedVersion) {
    Fail "The packed release version did not match package.json. Expected $ExpectedVersion, found $($packedRelease.version)."
  }
  $packageFile = Join-Path $tempDirectory $packageName
  if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) { Fail "The packed release could not be found at $packageFile." }

  Write-Step "Installing the global cope command"
  & npm.cmd install --global --force --ignore-scripts --no-audit --no-fund $packageFile
  if ($LASTEXITCODE -ne 0) { Fail "The global Cope installation failed." "Try reopening PowerShell as your normal user and run install.cmd again." }

  $globalPrefix = (& npm.cmd prefix --global).Trim()
  if ([string]::IsNullOrWhiteSpace($globalPrefix)) { Fail "npm did not report its global command directory." }
  Ensure-UserPath $globalPrefix

  $copeCommand = Join-Path $globalPrefix "cope.cmd"
  if (-not (Test-Path -LiteralPath $copeCommand -PathType Leaf)) {
    $resolved = Get-Command cope.cmd -ErrorAction SilentlyContinue
    if ($resolved) { $copeCommand = $resolved.Source }
  }
  if (-not (Test-Path -LiteralPath $copeCommand -PathType Leaf)) {
    Fail "Cope installed, but cope.cmd could not be found." "Run 'npm prefix --global' and make sure that directory is on PATH."
  }

  $installedVersion = (& $copeCommand --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $installedVersion -ne $ExpectedVersion) {
    Fail "Cope did not pass its launch check. Reported version: $installedVersion"
  }
  [Environment]::SetEnvironmentVariable("COPE_SOURCE_DIR", $ProjectRoot, "User")
  $env:COPE_SOURCE_DIR = $ProjectRoot
  Write-Ok "cope $installedVersion installed"
  Write-Ok "Local update source saved: $ProjectRoot"
  Write-Host ""
  Write-Host "You can now run:" -ForegroundColor White
  Write-Host "  cope" -ForegroundColor Cyan
  Write-Host "  cope C:\path\to\project" -ForegroundColor Cyan
  Write-Host "  cope C:\path\to\standalone-file.html" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "A new PowerShell window will pick up the saved PATH automatically." -ForegroundColor DarkGray

  if (-not $SkipSetup) {
    $answer = Read-Host "Run the one-time Copilot and Edge setup now? [Y/n]"
    if ([string]::IsNullOrWhiteSpace($answer) -or $answer.Trim().ToLowerInvariant() -in @("y", "yes")) {
      & $copeCommand setup
      if ($LASTEXITCODE -ne 0) {
        Write-Host "! Setup was not completed. Run 'cope setup' whenever you are ready." -ForegroundColor Yellow
      }
    }
  }
} finally {
  Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
