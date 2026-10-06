<#
.SYNOPSIS
  Pi 外掛（webchat 模型提供商）- Windows 安裝腳本

.DESCRIPTION
  用法：powershell -ExecutionPolicy Bypass -File plugins\pi\install.ps1 [-Force]
  Windows 建立符號連結需要特殊權限，所以一律以「複製」安裝，並留下安裝標記（.webchatmcp-installed）。
  更新倉庫後重跑本腳本即可更新。目標已存在且不是本腳本裝的，預設拒絕覆蓋；-Force 才會取代。
  目標：%PI_EXTENSIONS_DIR% 或 %PI_CODING_AGENT_DIR%\extensions 或 %USERPROFILE%\.pi\agent\extensions 下的 webchat。
  不需要系統管理員。裝完請重啟 pi。反安裝：plugins\pi\uninstall.ps1
#>
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$Src = Join-Path $PSScriptRoot 'webchat'
$AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi\agent' }
$ExtDir = if ($env:PI_EXTENSIONS_DIR) { $env:PI_EXTENSIONS_DIR } else { Join-Path $AgentDir 'extensions' }
$Dest = Join-Path $ExtDir 'webchat'
$Mark = '.webchatmcp-installed'

function Say([string]$Message) { Write-Host "[pi-webchat] $Message" }

try {
  if (-not (Test-Path (Join-Path $Src 'index.js'))) { throw "找不到外掛原始檔：$Src" }
  New-Item -ItemType Directory -Path $ExtDir -Force | Out-Null
  if (Test-Path $Dest) {
    if ((Test-Path (Join-Path $Dest $Mark)) -or $Force) {
      Remove-Item $Dest -Recurse -Force
    }
    else {
      throw "$Dest 已存在而且不是本腳本安裝的；確認後加 -Force 取代"
    }
  }
  New-Item -ItemType Directory -Path $Dest | Out-Null
  Copy-Item -Path (Join-Path $Src '*') -Destination $Dest -Recurse -Force
  New-Item -ItemType File -Path (Join-Path $Dest $Mark) | Out-Null
  Say "已安裝（複製）：$Dest"

  if (-not (Get-Command pi -ErrorAction SilentlyContinue)) { Say '注意：PATH 裡找不到 pi；外掛已就位，安裝 pi 後即可使用' }
  $url = if ($env:WEBCHATMCP_URL) { $env:WEBCHATMCP_URL } else { 'http://127.0.0.1:8321/mcp' }
  $reachable = $true
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url | Out-Null }
  catch { if (-not $_.Exception.Response) { $reachable = $false } }
  if (-not $reachable) { Say "注意：連不上 WebChatMCP 伺服器（$url）。請先安裝並啟動：& ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF)))" }
  Say '請重啟 pi，然後用 /webchat-login（省略＝四個服務都檢查）與 /webchat-refresh，再選 webchat/<服務>/<模型標籤>'
}
catch {
  Write-Host "[pi-webchat] 錯誤：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
