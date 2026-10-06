<#
.SYNOPSIS
  WebChatMCP.js - Windows 安裝、背景執行與更新腳本

.DESCRIPTION
  用法（在倉庫內，PowerShell 5.1 以上；不需要系統管理員）：
    powershell -ExecutionPolicy Bypass -File script\install.ps1 [install]   安裝：補齊 git、Node.js、相依套件、內建瀏覽器，建置並註冊背景工作後啟動
    powershell -ExecutionPolicy Bypass -File script\install.ps1 update [-Force]
                                                                             更新：先關掉執行中的服務，拉取最新程式、重新建置，再把服務啟動回來
    ... start | stop | restart | status | logs
    ... uninstall [-Purge] [-PurgeProfile]

  遠端一行安裝（自動補齊 git 與 Node.js，下載原始碼到 %USERPROFILE%\.webchatmcp\app 後安裝並啟動）：
    & ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF)))
    & ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF))) update

  背景服務：工作排程器（登入時啟動、隱藏視窗、失敗自動重啟）。服務以 HTTP 提供 MCP（預設 http://127.0.0.1:8321/mcp）。
  環境變數寫在 %USERPROFILE%\.webchatmcp\<服務名>.env。Node.js 不夠新時只下載到 %USERPROFILE%\.webchatmcp\node、缺 git 時下載 MinGit 到 %USERPROFILE%\.webchatmcp\git（都驗證 SHA-256）。
  可用環境變數：WEBCHATMCP_HOME（資料目錄）、WEBCHATMCP_SERVICE_NAME（服務名，預設 webchatmcp）、WEBCHATMCP_APP_DIR（遠端安裝的原始碼位置）、WEBCHATMCP_REPO／WEBCHATMCP_BRANCH。
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'update', 'start', 'stop', 'restart', 'status', 'logs', 'uninstall', 'help')]
  [string]$Action = 'install',
  [switch]$Force,
  [switch]$Purge,
  [switch]$PurgeProfile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Name = if ($env:WEBCHATMCP_SERVICE_NAME) { $env:WEBCHATMCP_SERVICE_NAME } else { 'webchatmcp' }
$Data = if ($env:WEBCHATMCP_HOME) { $env:WEBCHATMCP_HOME } else { Join-Path $HOME '.webchatmcp' }
$Repo = if ($env:WEBCHATMCP_REPO) { $env:WEBCHATMCP_REPO } else { 'https://github.com/JS-PACKAGE/WebChatMCP.js.git' }
$Branch = if ($env:WEBCHATMCP_BRANCH) { $env:WEBCHATMCP_BRANCH } else { 'main' }

# 在倉庫內執行就用該倉庫；從 irm 下載的 scriptblock（沒有 $PSScriptRoot）或倉庫外執行則是「遠端模式」，原始碼放在 APP_DIR。
$Root = $null
if ($PSScriptRoot) {
  $candidate = Split-Path -Parent $PSScriptRoot
  $pkg = Join-Path $candidate 'package.json'
  if ((Test-Path $pkg) -and ((Get-Content -Raw -LiteralPath $pkg) -match '"name":\s*"webchatmcp\.js"')) { $Root = $candidate }
}
$Remote = -not $Root
if ($Remote) { $Root = if ($env:WEBCHATMCP_APP_DIR) { $env:WEBCHATMCP_APP_DIR } else { Join-Path $Data 'app' } }
$SelfScript = Join-Path $Root 'script\install.ps1'
$GitHome = Join-Path $Data 'git'
$LogDir = Join-Path $Data 'logs'
# 伺服器的日誌走 stderr（stdout 專供 JSON-RPC），所以 .err.log 才是主要日誌。
$OutLog = Join-Path $LogDir "$Name.out.log"
$ErrLog = Join-Path $LogDir "$Name.err.log"
$EnvFile = Join-Path $Data "$Name.env"
$Launcher = Join-Path $Data "$Name-run.ps1"
$NodeHome = Join-Path $Data 'node'
$MinNodeMajor = 22
$TaskName = $Name
$NodeExe = $null

function Say([string]$Message) { Write-Host "[$Name] $Message" }
function Warn([string]$Message) { Write-Host "[$Name] 注意：$Message" -ForegroundColor Yellow }
function Die([string]$Message) { throw "[$Name] 錯誤：$Message" }

# 單引號字串跳脫，供產生 PowerShell 腳本時安全嵌入路徑。
function Quote([string]$Text) { "'" + $Text.Replace("'", "''") + "'" }

# 執行外部命令，失敗（結束碼非 0）就中止。
function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { Die "$File $($Arguments -join ' ') 失敗（結束碼 $LASTEXITCODE）" }
}

# ───────────────────────── Node.js ─────────────────────────

function Get-NodeMajor([string]$Exe) {
  try { [int](& $Exe -p 'process.versions.node.split(".")[0]') } catch { 0 }
}

function Find-Node {
  $local = Join-Path $NodeHome 'node.exe'
  if ((Test-Path $local) -and ((Get-NodeMajor $local) -ge $MinNodeMajor)) { return $local }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and ((Get-NodeMajor $cmd.Source) -ge $MinNodeMajor)) { return $cmd.Source }
  return $null
}

function Install-NodeLocally {
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { Die "不支援的 CPU 架構：$($env:PROCESSOR_ARCHITECTURE)" }
  }
  $base = "https://nodejs.org/dist/latest-v$MinNodeMajor.x"
  Say "找不到 Node.js >= $MinNodeMajor，下載官方版本到 $NodeHome"
  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
  $line = ($sums -split "`n") | Where-Object { $_ -match "  node-v[\d.]+-win-$arch\.zip\s*$" } | Select-Object -First 1
  if (-not $line) { Die "SHASUMS256.txt 找不到 win-$arch 的套件" }
  $parts = $line.Trim() -split '\s+'
  $want = $parts[0].ToLower()
  $file = $parts[1]
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp $file
    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
    $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want) { Die "Node.js 套件 SHA-256 不符（預期 $want，實際 $got）" }
    Expand-Archive -Path $zip -DestinationPath $tmp
    $inner = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
    if (Test-Path $NodeHome) { Remove-Item $NodeHome -Recurse -Force }
    New-Item -ItemType Directory -Path $Data -Force | Out-Null
    Move-Item -Path $inner.FullName -Destination $NodeHome
  }
  finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-Node {
  $found = Find-Node
  if (-not $found) {
    Install-NodeLocally
    $found = Find-Node
    if (-not $found) { Die 'Node.js 安裝失敗' }
  }
  $script:NodeExe = $found
  $env:PATH = (Split-Path -Parent $found) + ';' + $env:PATH
  Say "使用 Node.js $(& $found -v)（$found）"
}

# ───────────────────────── git 與原始碼 ─────────────────────────

function Find-Git {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($candidate in @((Join-Path $GitHome 'cmd\git.exe'), (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'))) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

# 沒有 git 時下載 MinGit（Git for Windows 的免安裝精簡版）到 $GitHome，用 GitHub 提供的 SHA-256 驗證；不需要系統管理員。
function Install-GitLocally {
  $suffix = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { '64-bit' }
    'ARM64' { 'arm64' }
    default { Die "不支援的 CPU 架構：$($env:PROCESSOR_ARCHITECTURE)" }
  }
  Say "找不到 git，下載 MinGit 到 $GitHome"
  $release = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'WebChatMCP-installer' } `
    'https://api.github.com/repos/git-for-windows/git/releases/latest'
  $asset = $release.assets | Where-Object { $_.name -match "^MinGit-[\d.]+-$suffix\.zip$" } | Select-Object -First 1
  if (-not $asset) { Die "找不到 MinGit（$suffix）的下載檔；請自行安裝 git（winget install Git.Git）後重試" }
  if (-not $asset.digest -or -not $asset.digest.StartsWith('sha256:')) {
    Die '無法取得 MinGit 的 SHA-256 以驗證下載；請自行安裝 git（winget install Git.Git）後重試'
  }
  $want = $asset.digest.Substring(7).ToLower()
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp $asset.name
    Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $zip
    $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want) { Die "MinGit SHA-256 不符（預期 $want，實際 $got）" }
    if (Test-Path $GitHome) { Remove-Item $GitHome -Recurse -Force }
    New-Item -ItemType Directory -Path $GitHome -Force | Out-Null
    Expand-Archive -Path $zip -DestinationPath $GitHome
  }
  finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-Git {
  $found = Find-Git
  if (-not $found) {
    Install-GitLocally
    $found = Find-Git
    if (-not $found) { Die 'git 安裝失敗' }
  }
  $env:PATH = (Split-Path -Parent $found) + ';' + $env:PATH
}

# 遠端模式：取得／更新原始碼到 $Root。已存在且有新版時會先關掉執行中的服務。
function Fetch-Source {
  if (-not $Remote) { return }
  Ensure-Git
  # git 的 stderr（例如沒有追蹤分支）不應被當成終止錯誤，結果一律以結束碼判斷。
  $ErrorActionPreference = 'Continue'
  if (Test-Path (Join-Path $Root '.git')) {
    & git -C $Root fetch --quiet origin
    $upstream = (& git -C $Root rev-parse '@{u}' 2>$null)
    if ($LASTEXITCODE -eq 0) {
      & git -C $Root merge-base --is-ancestor $upstream HEAD
      if ($LASTEXITCODE -ne 0) {
        Say "原始碼有新版，先關閉執行中的服務再更新 $Root"
        Stop-All
        & git -C $Root checkout -- dist 2>$null
        & git -C $Root pull --ff-only --quiet
        if ($LASTEXITCODE -ne 0) { Die "git pull --ff-only 失敗（$Root 有本地修改或分岔？）" }
      }
    }
  }
  else {
    if ((Test-Path $Root) -and (Get-ChildItem -LiteralPath $Root -Force | Select-Object -First 1)) {
      Die "$Root 已存在但不是 git 倉庫，請移走或用 WEBCHATMCP_APP_DIR 指定其他位置"
    }
    Say "下載原始碼：$Repo（$Branch）-> $Root"
    New-Item -ItemType Directory -Path (Split-Path -Parent $Root) -Force | Out-Null
    & git clone --quiet --branch $Branch $Repo $Root
    if ($LASTEXITCODE -ne 0) { Die 'git clone 失敗' }
  }
}

function Show-Usage {
  Write-Host @'
用法：install.ps1 [install|update|start|stop|restart|status|logs|uninstall] [-Force] [-Purge] [-PurgeProfile]
  install     安裝：補齊 git、Node.js、相依套件與內建瀏覽器，建置並註冊背景工作後啟動（預設）
  update      更新：先關掉執行中的服務，拉取最新程式、重新建置，再啟動（-Force 強制重新建置）
  start|stop|restart|status|logs
  uninstall   移除背景工作（-Purge 另刪 Node.js／git／日誌／設定，-PurgeProfile 另刪登入 profile）
遠端：& ([scriptblock]::Create((irm https://webchatmcp.js-package.xyz/script/install.ps1).TrimStart([char]0xFEFF))) <指令>
'@
}

# ───────────────────────── 建置 ─────────────────────────

function Build-App {
  Push-Location $Root
  try {
    Say '安裝相依套件（npm ci；依 package-lock.json 安裝，不會改動它）'
    Invoke-Native 'npm' @('ci', '--no-fund', '--no-audit')
    Say '安裝內建瀏覽器（Playwright Chromium）'
    Invoke-Native 'npx' @('playwright', 'install', 'chromium')
    Say '建置（npm run build）'
    Invoke-Native 'npm' @('run', 'build')
  }
  finally {
    Pop-Location
  }
}

# ───────────────────────── 設定與服務 ─────────────────────────

function Get-ServicePort {
  if (Test-Path $EnvFile) {
    $match = Select-String -Path $EnvFile -Pattern '^\s*WEBCHATMCP_PORT\s*=\s*(\d+)' | Select-Object -Last 1
    if ($match) { return [int]$match.Matches[0].Groups[1].Value }
  }
  if ($env:WEBCHATMCP_PORT) { return [int]$env:WEBCHATMCP_PORT }
  return 8321
}

function Write-EnvTemplate {
  if (Test-Path $EnvFile) { return }
  New-Item -ItemType Directory -Path $Data -Force | Out-Null
  $template = @'
# WebChatMCP.js 背景服務的環境變數（KEY=VALUE，每行一個；改完執行 script\install.ps1 restart）
# WEBCHATMCP_PORT=8321
# WEBCHATMCP_HOST=127.0.0.1        # 0.0.0.0 會開放區網，HTTP 無認證，慎用
# WEBCHATMCP_PROFILE_DIR=C:\Users\you\.webchatmcp\profile
# WEBCHATMCP_CHANNEL=chromium      # chromium / chrome / msedge
# WEBCHATMCP_HEADLESS=1            # 設 0 一律顯示瀏覽器視窗
# WEBCHATMCP_ANSWER_TIMEOUT_MS=120000
'@
  [IO.File]::WriteAllText($EnvFile, $template, (New-Object Text.UTF8Encoding($true)))
}

function Write-Launcher {
  New-Item -ItemType Directory -Path $Data, $LogDir -Force | Out-Null
  $script = Join-Path $Root 'dist\WebChatMCP.js'
  $body = @"
# 由 script\install.ps1 產生；重新安裝或更新時會覆寫。
`$ErrorActionPreference = 'Stop'
if (Test-Path $(Quote $EnvFile)) {
  Get-Content -LiteralPath $(Quote $EnvFile) | ForEach-Object {
    `$line = `$_.Trim()
    if (`$line -and -not `$line.StartsWith('#') -and `$line.Contains('=')) {
      `$pair = `$line.Split('=', 2)
      [Environment]::SetEnvironmentVariable(`$pair[0].Trim(), `$pair[1].Trim().Trim('"').Trim("'"), 'Process')
    }
  }
}
`$env:PATH = $(Quote ((Split-Path -Parent $NodeExe) + ';')) + `$env:PATH
`$p = Start-Process -FilePath $(Quote $NodeExe) ``
  -ArgumentList ('"' + $(Quote $script) + '"') ``
  -WorkingDirectory $(Quote $Root) -NoNewWindow -Wait -PassThru ``
  -RedirectStandardOutput $(Quote $OutLog) -RedirectStandardError $(Quote $ErrLog)
exit `$p.ExitCode
"@
  [IO.File]::WriteAllText($Launcher, $body, (New-Object Text.UTF8Encoding($true)))
}

function Write-Service {
  Write-EnvTemplate
  Write-Launcher
  $who = "$env:USERDOMAIN\$env:USERNAME"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $who
  $principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -Hidden
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'WebChatMCP.js (MCP server with a built-in browser)' -Force | Out-Null
}

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
function Test-ServiceInstalled { [bool](Get-Task) }
function Test-ServiceRunning {
  $task = Get-Task
  [bool]($task -and $task.State -eq 'Running')
}

function Start-Service-Task {
  if (-not (Test-ServiceInstalled)) { Die '尚未安裝服務，請先執行 script\install.ps1 install' }
  if (Test-ServiceRunning) { Say '服務已在執行'; return }
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Say "服務已啟動（HTTP http://127.0.0.1:$(Get-ServicePort)/mcp）"
}

# 結束殘留的 WebChatMCP.js 行程（含 MCP 用戶端以 stdio 啟動的實例）與本服務的啟動腳本，連同子行程（Chromium）一起。
function Stop-Strays {
  $rootLike = "*$($Root)\dist\WebChatMCP.js*"
  $targets = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and (
      (($_.Name -eq 'node.exe') -and ($_.CommandLine -like $rootLike)) -or
      (($_.Name -match '^powershell(\.exe)?$|^pwsh(\.exe)?$') -and ($_.CommandLine -like "*$Launcher*"))
    )
  }
  foreach ($proc in $targets) {
    Say "結束行程 $($proc.Name)（PID $($proc.ProcessId)）"
    try { & taskkill.exe /PID $proc.ProcessId /T /F *> $null } catch { }
  }
}

function Stop-All {
  if (Test-ServiceInstalled) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  Stop-Strays
}

function Get-HttpCode {
  try {
    (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$(Get-ServicePort)/mcp").StatusCode
  }
  catch {
    if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  }
}

# 等 HTTP 端點開始回應（任何 HTTP 狀態碼都代表服務已起來），最多約 20 秒。
function Wait-Http {
  for ($i = 0; $i -lt 40; $i++) {
    if ((Get-HttpCode) -ne 0) { return }
    Start-Sleep -Milliseconds 500
  }
  Warn "等不到 HTTP 端點回應，請查看日誌：$ErrLog"
}

# ───────────────────────── 指令 ─────────────────────────

function Invoke-Status {
  $installed = if (Test-ServiceInstalled) { '是' } else { '否' }
  $running = if (Test-ServiceRunning) { '是' } else { '否' }
  $code = Get-HttpCode
  $codeText = if ($code -eq 0) { '無回應' } else { "$code" }
  Say "背景方式：工作排程器；已安裝：$installed；執行中：$running"
  Say "HTTP http://127.0.0.1:$(Get-ServicePort)/mcp 回應碼：$codeText"
  Say "設定檔：$EnvFile；日誌：$ErrLog"
}

function Invoke-Install {
  Fetch-Source
  Ensure-Node
  Build-App
  Write-Service
  Start-Service-Task
  Wait-Http
  Invoke-Status
  Write-Host ''
  Write-Host "MCP 用戶端請連 HTTP：http://127.0.0.1:$(Get-ServicePort)/mcp"
  Write-Host '（背景服務與 stdio 實例共用同一個瀏覽器 profile，建議只用其中一種連線方式。）'
  Write-Host "登入請呼叫 webchat_login；更新請執行：powershell -ExecutionPolicy Bypass -File `"$SelfScript`" update"
}

function Invoke-Update {
  # git 的 stderr（例如沒有追蹤分支）不應被當成終止錯誤，結果一律以結束碼判斷。
  $ErrorActionPreference = 'Continue'
  Ensure-Git
  if (-not (Test-Path (Join-Path $Root '.git'))) { Die "找不到原始碼倉庫（$Root），無法更新；請先執行安裝" }
  Push-Location $Root
  try {
    & git diff --quiet -- . ':(exclude)dist'
    $dirtyWork = $LASTEXITCODE -ne 0
    & git diff --cached --quiet -- . ':(exclude)dist'
    $dirtyIndex = $LASTEXITCODE -ne 0
    if ($dirtyWork -or $dirtyIndex) { Die '有未提交的修改，更新會覆蓋它們；請先 commit 或 stash' }
    Invoke-Native 'git' @('fetch', '--quiet', 'origin')
    $upstream = (& git rev-parse '@{u}' 2>$null)
    if ($LASTEXITCODE -ne 0) { Die '目前分支沒有追蹤的遠端分支' }
    $before = (& git rev-parse HEAD)
    & git merge-base --is-ancestor $upstream HEAD
    $upToDate = $LASTEXITCODE -eq 0
    if ($upToDate -and -not $Force) {
      Say "已是最新版本（$((& git rev-parse --short HEAD))）；要強制重新建置請加 -Force"
      return
    }

    Say '有新版本，先關閉執行中的服務'
    Stop-All
    # dist\ 是隨倉庫提交的建置產物，重新建置後可能與遠端版本略有差異；它會在下面重新建置，先還原以免擋住 pull。
    & git checkout -- dist 2>$null
    & git pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) { Die 'git pull --ff-only 失敗（本地與遠端分岔？），服務保持關閉，請手動處理後執行 start' }
    $after = (& git rev-parse HEAD)
    Ensure-Node
    Build-App
    if (Test-ServiceInstalled) {
      Write-Service
      Start-Service-Task
    }
    $version = (& $NodeExe -p "require('./package.json').version")
    Say "更新完成：$((& git rev-parse --short $before)) -> $((& git rev-parse --short $after))（$version）"
  }
  finally {
    Pop-Location
  }
}

function Invoke-Uninstall {
  Stop-All
  if (Test-ServiceInstalled) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Remove-Item $Launcher -Force -ErrorAction SilentlyContinue
  Say '已移除背景服務（程式碼、登入 profile 與設定檔保留）'
  if ($Purge) {
    Remove-Item $NodeHome, $GitHome, $LogDir, $EnvFile -Recurse -Force -ErrorAction SilentlyContinue
    Say '已刪除 Node.js、git、日誌與設定檔'
    # 遠端安裝下載的原始碼（$Data\app）屬於本腳本管理；在使用者自己的倉庫內執行時絕不刪除倉庫。
    if ($Remote -and (Test-Path (Join-Path $Root '.git'))) {
      Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
      Say "已刪除下載的原始碼：$Root"
    }
  }
  if ($PurgeProfile) {
    Remove-Item (Join-Path $Data 'profile') -Recurse -Force -ErrorAction SilentlyContinue
    Say '已刪除瀏覽器 profile（所有登入狀態）'
  }
}

function Require-Node {
  $found = Find-Node
  if (-not $found) { Die '找不到 Node.js，請先執行 install' }
  $script:NodeExe = $found
}

try {
  switch ($Action) {
    'install' { Invoke-Install }
    'update' { Invoke-Update }
    'start' { Require-Node; Start-Service-Task }
    'stop' { Stop-All; Say '已停止' }
    'restart' { Stop-All; Require-Node; Start-Service-Task }
    'status' { Invoke-Status }
    'logs' {
      if (-not (Test-Path $ErrLog)) { Die "還沒有日誌：$ErrLog" }
      Get-Content -Path $ErrLog -Tail 50 -Wait
    }
    'uninstall' { Invoke-Uninstall }
    'help' { Show-Usage }
  }
}
catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
