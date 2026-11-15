# install.ps1 - create a desktop shortcut that launches the panel windowlessly.
# Usage:  right-click -> Run with PowerShell,  or:  powershell -ExecutionPolicy Bypass -File install.ps1
# Nothing is written to the registry, and no startup entry is added unless you pass -AutoStart.

param(
  [switch]$AutoStart
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1) Node.js 22+ is the only requirement
$node = 'node'
$sysNode = 'C:\Program Files\nodejs\node.exe'
if (Test-Path $sysNode) { $node = $sysNode }
try {
  $ver = (& $node -v).Trim()
} catch {
  Write-Host "[X] 找不到 Node.js，请先安装 22 或更高版本： https://nodejs.org" -ForegroundColor Red
  exit 1
}
$major = [int](($ver -replace '^v', '') -split '\.')[0]
if ($major -lt 22) {
  Write-Host "[X] Node.js 版本过低：$ver（需要 v22 或更高）" -ForegroundColor Red
  exit 1
}
Write-Host "[OK] Node.js $ver"

# 2) sanity check the launcher files
foreach ($f in @('launch.mjs', 'inject.mjs', 'panel.js', 'start.vbs')) {
  if (-not (Test-Path (Join-Path $dir $f))) {
    Write-Host "[X] 缺少文件：$f —— 请确认本脚本与它们在同一目录" -ForegroundColor Red
    exit 1
  }
}

# 3) build the shortcut
$ws = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'))
if ($AutoStart) { $targets += [Environment]::GetFolderPath('Startup') }

foreach ($folder in $targets) {
  $lnkPath = Join-Path $folder 'Notion 用量面板.lnk'
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $lnk.Arguments = '"' + (Join-Path $dir 'start.vbs') + '"'
  $lnk.WorkingDirectory = $dir
  $lnk.Description = '启动 Notion 用量悬浮面板'

  # reuse Notion's own icon when we can find it
  $iconCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Notion\Notion.exe'),
    'C:\Program Files\Notion\Notion.exe'
  )
  foreach ($ic in $iconCandidates) {
    if (Test-Path $ic) { $lnk.IconLocation = "$ic,0"; break }
  }
  $lnk.Save()
  Write-Host "[OK] 已创建快捷方式：$lnkPath"
}

Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 先彻底退出 Notion（托盘图标也要退）'
Write-Host '  2. 双击桌面上的「Notion 用量面板」'
Write-Host '  3. 右下角出现胶囊即成功；点一下看完整卡片'
if (-not $AutoStart) {
  Write-Host ''
  Write-Host '想让它在开机/登录时自动启动：重新运行本脚本并加 -AutoStart'
}
