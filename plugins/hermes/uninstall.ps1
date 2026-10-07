<#
.SYNOPSIS
  Hermes Agent 外掛 - Windows 反安裝腳本

.DESCRIPTION
  用法：powershell -ExecutionPolicy Bypass -File plugins\hermes\uninstall.ps1 [-Python PATH] [-Purge]
  只移除本腳本安裝的 providers.webchat 與舊 profile／假金鑰區塊；-Purge 另刪模型快取。
#>
[CmdletBinding()]
param([switch]$Purge, [string]$Python)
$ErrorActionPreference = 'Stop'
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$Node = if ($NodeCommand) { $NodeCommand.Source } else { $null }
if (-not $Node -and (Test-Path "$HOME\.webchatmcp\node\node.exe")) { $Node = "$HOME\.webchatmcp\node\node.exe" }
if (-not $Node) { Write-Host '[hermes-webchat] 錯誤：找不到 Node.js' -ForegroundColor Red; exit 1 }
$args = @((Join-Path $PSScriptRoot 'hermes-plugin.mjs'), 'uninstall')
if ($Purge) { $args += '--purge' }
if ($Python) { $args += @('--python', $Python) }
& $Node @args
exit $LASTEXITCODE
