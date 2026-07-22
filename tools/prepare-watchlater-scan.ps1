[CmdletBinding()]
param(
    [switch]$NoOpen,
    [switch]$NoPause,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Bilibili 稍后再看一键扫描'

$toolRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path $env:WATCHLATER_ROOT 'tools' }
$projectRoot = Split-Path -Parent $toolRoot
$collectorPath = Join-Path $toolRoot 'bilibili-watchlater-console.js'
$watchLaterUrl = 'https://www.bilibili.com/watchlater/list?spm_id_from=333.1007.0.0#/list'
$localAppUrl = 'http://localhost:4173/'

if (-not (Test-Path -LiteralPath $collectorPath -PathType Leaf)) {
    throw "找不到采集脚本：$collectorPath"
}

$collector = Get-Content -Raw -LiteralPath $collectorPath -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($collector)) {
    throw "采集脚本内容为空：$collectorPath"
}

if (-not $DryRun) {
    $setClipboard = Get-Command Set-Clipboard -ErrorAction SilentlyContinue
    if ($setClipboard) {
        Set-Clipboard -Value $collector
    }
    else {
        $collector | & clip.exe
        if ($LASTEXITCODE -ne 0) {
            throw '无法把采集脚本复制到 Windows 剪贴板。'
        }
    }
}

Write-Host ''
Write-Host 'Bilibili 稍后再看扫描器已经准备完成。' -ForegroundColor Green
Write-Host "采集脚本：$collectorPath"

if ($DryRun) {
    Write-Host '测试运行完成：没有修改剪贴板，也没有打开浏览器。' -ForegroundColor Yellow
    exit 0
}

Write-Host '采集代码已经复制到剪贴板。' -ForegroundColor Cyan

if (-not $NoOpen) {
    Start-Process $watchLaterUrl
    Write-Host '已经使用默认浏览器打开 Bilibili 稍后再看页面。' -ForegroundColor Cyan
}

Write-Host ''
Write-Host '接下来请完成以下步骤：' -ForegroundColor White
Write-Host '  1. 切换到已经登录正确账号的 Bilibili 稍后再看标签页。'
Write-Host '  2. 按 F12 或 Ctrl+Shift+I，打开 Console（控制台）。'
Write-Host '  3. 粘贴剪贴板内容并按 Enter。'
Write-Host '  4. 页面自动滚动和计数增长时，请保持标签页打开。'
Write-Host '  5. 等待 bilibili-watchlater-export.json 自动下载。'
Write-Host "  6. 打开 $localAppUrl，选择“本地文件”模式并导入 JSON。"
Write-Host ''
Write-Host "导入后的元数据保存到：$projectRoot\data\watchlater.json"
Write-Host "下载后的封面保存到：$projectRoot\data\covers\"
Write-Host ''
Write-Host '该脚本不会读取或导出你的 Bilibili Cookie。' -ForegroundColor DarkGray

if (-not $NoPause) {
    [void](Read-Host '按 Enter 关闭此窗口')
}
