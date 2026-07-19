[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
Write-Host "Removing Cope..." -ForegroundColor Cyan
& npm.cmd uninstall --global @local/copilot-browser-agent
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "OK Cope was removed." -ForegroundColor Green
