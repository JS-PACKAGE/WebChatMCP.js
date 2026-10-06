<#
.SYNOPSIS
  Hermes Agent 外掛 - Windows 反安裝腳本

.DESCRIPTION
  用法：powershell -ExecutionPolicy Bypass -File plugins\hermes\uninstall.ps1 [-Purge]
  只移除本腳本裝的目錄與 .env 假金鑰區塊。-Purge 另刪模型快取。
#>
[CmdletBinding()]
param([switch]$Purge)
$ErrorActionPreference = 'Stop'
$Node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $Node -and (Test-Path "$HOME\.webchatmcp\node\node.exe")) { $Node = "$HOME\.webchatmcp\node\node.exe" }
if (-not $Node) { Write-Host '[hermes-webchat] 錯誤：找不到 Node.js' -ForegroundColor Red; exit 1 }
$args = @((Join-Path $PSScriptRoot 'hermes-plugin.mjs'), 'uninstall')
if ($Purge) { $args += '--purge' }
& $Node @args
exit $LASTEXITCODE
