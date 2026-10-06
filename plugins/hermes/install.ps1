<#
.SYNOPSIS
  Hermes Agent 外掛（webchat 模型提供商）- Windows 安裝腳本

.DESCRIPTION
  用法：powershell -ExecutionPolicy Bypass -File plugins\hermes\install.ps1 [-Force]
  Windows 建立符號連結需要特殊權限，所以一律複製，並留下安裝標記。
  目標：%HERMES_HOME%\plugins\model-providers\webchat（預設 %USERPROFILE%\.hermes）。
  會在 .env 寫入假的 WEBCHAT_API_KEY（橋接不驗證）。不改 config.yaml。
  不需要系統管理員。裝完請重啟 Hermes。
#>
[CmdletBinding()]
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$Node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $Node -and (Test-Path "$HOME\.webchatmcp\node\node.exe")) { $Node = "$HOME\.webchatmcp\node\node.exe" }
if (-not $Node) { Write-Host '[hermes-webchat] 錯誤：找不到 Node.js' -ForegroundColor Red; exit 1 }
$args = @((Join-Path $PSScriptRoot 'hermes-plugin.mjs'), 'install', '--copy')
if ($Force) { $args += '--force' }
& $Node @args
exit $LASTEXITCODE
