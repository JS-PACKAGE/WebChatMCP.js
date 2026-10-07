<#
.SYNOPSIS
  Hermes Agent 外掛（webchat 模型提供商）- Windows 安裝腳本

.DESCRIPTION
  用法：powershell -ExecutionPolicy Bypass -File plugins\hermes\install.ps1 [-Force] [-RefreshModels] [-Url URL] [-Python PATH]
  在 HERMES_HOME/config.yaml（預設 %USERPROFILE%\.hermes）加入免金鑰的 providers.webchat。
  WebChatMCP 必須先啟動；清單為空時自動擷取模型，-RefreshModels 強制重新擷取。
  不改目前的 model.provider；舊版的本外掛 profile 與假金鑰會自動移除。
  不需要系統管理員。裝完請重啟 Hermes；非本腳本安裝的同名設定預設拒絕覆蓋。
#>
[CmdletBinding()]
param([switch]$Force, [switch]$RefreshModels, [string]$Url, [string]$Python)
$ErrorActionPreference = 'Stop'
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$Node = if ($NodeCommand) { $NodeCommand.Source } else { $null }
if (-not $Node -and (Test-Path "$HOME\.webchatmcp\node\node.exe")) { $Node = "$HOME\.webchatmcp\node\node.exe" }
if (-not $Node) { Write-Host '[hermes-webchat] 錯誤：找不到 Node.js' -ForegroundColor Red; exit 1 }
$args = @((Join-Path $PSScriptRoot 'hermes-plugin.mjs'), 'install')
if ($Force) { $args += '--force' }
if ($RefreshModels) { $args += '--refresh-models' }
if ($Url) { $args += @('--url', $Url) }
if ($Python) { $args += @('--python', $Python) }
& $Node @args
exit $LASTEXITCODE
