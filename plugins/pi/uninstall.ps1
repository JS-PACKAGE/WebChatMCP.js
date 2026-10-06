<#
.SYNOPSIS
  Pi 外掛（webchat 模型提供商）- Windows 反安裝腳本

.DESCRIPTION
  用法：powershell -ExecutionPolicy Bypass -File plugins\pi\uninstall.ps1 [-Purge]
  移除 install.ps1 裝進 pi 擴充目錄的外掛（帶有安裝標記者）；不是本腳本裝的一律不動。
  -Purge 另外刪除 /webchat-refresh 產生的模型快取（%USERPROFILE%\.pi\agent\webchat-models.json）。
  不會動 WebChatMCP 伺服器與其登入 profile。移除後請重啟 pi。
#>
[CmdletBinding()]
param([switch]$Purge)

$ErrorActionPreference = 'Stop'
$AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi\agent' }
$ExtDir = if ($env:PI_EXTENSIONS_DIR) { $env:PI_EXTENSIONS_DIR } else { Join-Path $AgentDir 'extensions' }
$Dest = Join-Path $ExtDir 'webchat'
$Mark = '.webchatmcp-installed'
$Cache = if ($env:WEBCHATMCP_PI_CACHE) { $env:WEBCHATMCP_PI_CACHE } else { Join-Path $AgentDir 'webchat-models.json' }

function Say([string]$Message) { Write-Host "[pi-webchat] $Message" }

try {
  if (Test-Path (Join-Path $Dest $Mark)) {
    Remove-Item $Dest -Recurse -Force
    Say "已移除外掛：$Dest"
  }
  elseif (Test-Path $Dest) {
    Say "$Dest 不是本腳本裝的，未動"
  }
  else {
    Say "沒有安裝（找不到 $Dest）"
  }
  if ($Purge -and (Test-Path $Cache)) {
    Remove-Item $Cache -Force
    Say "已刪除模型快取：$Cache"
  }
  Say '請重啟 pi 讓變更生效'
}
catch {
  Write-Host "[pi-webchat] 錯誤：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
