<#
.SYNOPSIS
  Oh My Pi 外掛（webchat 模型提供商）- Windows 安裝腳本

.DESCRIPTION
  用法：powershell -ExecutionPolicy Bypass -File plugins\omp\install.ps1 [-Force]
  Windows 建立符號連結需要特殊權限，所以一律以「複製」安裝，並留下安裝標記（.webchatmcp-installed）。
  更新倉庫後重跑本腳本即可更新。目標已存在且不是本腳本裝的，預設拒絕覆蓋；-Force 才會取代。
  目標：%OMP_EXTENSIONS_DIR% 或 %PI_CODING_AGENT_DIR%\extensions 或 %USERPROFILE%\.omp\agent\extensions 下的 webchat。
  不需要系統管理員。裝完請重啟 omp。反安裝：plugins\omp\uninstall.ps1
#>
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$Src = Join-Path $PSScriptRoot 'webchat'
$AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.omp\agent' }
$ExtDir = if ($env:OMP_EXTENSIONS_DIR) { $env:OMP_EXTENSIONS_DIR } else { Join-Path $AgentDir 'extensions' }
$Dest = Join-Path $ExtDir 'webchat'
$Mark = '.webchatmcp-installed'

function Say([string]$Message) { Write-Host "[omp-webchat] $Message" }

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

  if (-not (Get-Command omp -ErrorAction SilentlyContinue)) { Say '注意：PATH 裡找不到 omp；外掛已就位，安裝 omp 後即可使用' }
  $url = if ($env:WEBCHATMCP_URL) { $env:WEBCHATMCP_URL } else { 'http://127.0.0.1:8321/mcp' }
  $reachable = $true
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url | Out-Null }
  catch { if (-not $_.Exception.Response) { $reachable = $false } }
  if (-not $reachable) { Say "注意：連不上 WebChatMCP 伺服器（$url）。請先安裝並啟動：& ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF)))" }
  Say '請重啟 omp，然後用：omp --model webchat/chatgpt（指令 /webchat-refresh、/webchat-login、/webchat-logout）'
}
catch {
  Write-Host "[omp-webchat] 錯誤：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
