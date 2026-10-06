<#
.SYNOPSIS
  WebChatMCP.js - Windows 反安裝：先停掉執行中的服務，再移除工作排程器中的背景服務。

.DESCRIPTION
  用法：powershell -ExecutionPolicy Bypass -File script\uninstall.ps1 [-Purge] [-PurgeProfile]
    （無參數）      只移除服務註冊；程式碼、登入 profile 與設定檔保留
    -Purge          另外刪除 Node.js、日誌與設定檔
    -PurgeProfile   另外刪除瀏覽器 profile（所有登入狀態，無法復原）
  與 WEBCHATMCP_HOME／WEBCHATMCP_SERVICE_NAME 的用法同 install.ps1；實作在 install.ps1 的 uninstall 動作。
#>
[CmdletBinding()]
param(
  [switch]$Purge,
  [switch]$PurgeProfile
)

$arguments = @{ Action = 'uninstall' }
if ($Purge) { $arguments.Purge = $true }
if ($PurgeProfile) { $arguments.PurgeProfile = $true }
& (Join-Path $PSScriptRoot 'install.ps1') @arguments
exit $LASTEXITCODE
