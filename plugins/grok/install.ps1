<#
.SYNOPSIS
  Grok 外掛（模型名稱結尾為 (WEB) 的網頁模型）- Windows 安裝腳本

.DESCRIPTION
  用法：powershell -ExecutionPolicy Bypass -File plugins\grok\install.ps1 [-Url URL] [-RefreshModels] [-NoClose] [-Purge]
  會先關閉所有執行中的 Grok（先請它們結束、不行才強制）；關不掉就不動設定並提示你手動關閉。
  不需要系統管理員。核心邏輯在 grok-plugin.mjs，需要 Node.js（PATH 裡的 node，或 %USERPROFILE%\.webchatmcp\node）。
#>
[CmdletBinding()]
param([string]$Url, [switch]$RefreshModels, [switch]$NoClose, [switch]$Purge)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $local = Join-Path $HOME '.webchatmcp\node\node.exe'
  if (Test-Path $local) { $node = $local }
}
if (-not $node) {
  Write-Host '[grok-webchat] 錯誤：找不到 Node.js；請先安裝 WebChatMCP（script\install.ps1）或 Node.js 22+' -ForegroundColor Red
  exit 1
}
$argsList = @((Join-Path $PSScriptRoot 'grok-plugin.mjs'), 'install')
if ($Url) { $argsList += @('--url', $Url) }
if ($RefreshModels) { $argsList += '--refresh-models' }
if ($NoClose) { $argsList += '--no-close' }
if ($Purge) { $argsList += '--purge' }
& $node @argsList
exit $LASTEXITCODE
