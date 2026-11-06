<#
.SYNOPSIS
  项目索引校验器 —— 按 INDEX.json 重算哈希，报告「变了什么」。

.DESCRIPTION
  默认只读：比对索引登记的 sha256 与文件实际哈希，打印表格 + 机器可读清单。
  -Rebuild：把所有条目的 sha256/bytes/updatedAt 与 generatedAt 重算并回写索引。
  「同步不及时」的防线就在这里：不靠人记得更新索引，靠每次进场都重算。

  退出码：0 = 全部一致；1 = 有变更或缺失；2 = 用法/格式错误。
  拒绝而不是猜测：spec 不认识、root 不存在、同一文件登记多次 —— 一律报错退出。

.PARAMETER Index
  索引文件路径（project-index/1 格式的 JSON）。

.PARAMETER Rebuild
  重算并回写索引。会把 generatedAt 更新为现在。

.EXAMPLE
  pwsh -File check.ps1 -Index .\INDEX.json
.EXAMPLE
  pwsh -File check.ps1 -Index .\INDEX.json -Rebuild
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Index,
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

# 用法/格式错误一律退出码 2，且不走 Write-Error（本脚本 ErrorAction=Stop，Write-Error 会抛而不是继续）。
function Fail { param([string]$m) [Console]::Error.WriteLine($m); exit 2 }
function Stamp { param($p) ([string]$p).Substring(0, [Math]::Min(12, ([string]$p).Length)) }

if (-not (Test-Path -LiteralPath $Index)) { Fail "找不到索引文件: $Index" }
$idxPath = (Resolve-Path -LiteralPath $Index).Path
$idx = Get-Content -LiteralPath $idxPath -Raw -Encoding utf8 | ConvertFrom-Json

if ($idx.spec -ne 'project-index/1') {
  Fail ("不认识的 spec: '" + $idx.spec + "' —— 本件只认 project-index/1。拒绝处理，不猜。")
}

$root = [string]$idx.root
if (-not [IO.Path]::IsPathRooted($root)) { $root = Join-Path (Split-Path -Parent $idxPath) $root }
if (-not (Test-Path -LiteralPath $root)) { Fail "root 不存在: $root" }
$root = (Resolve-Path -LiteralPath $root).Path

$entries = @($idx.entries)
if ($entries.Count -eq 0) { Fail "entries 为空 —— 一份什么都没登记的索引没有意义" }

$dup = @($entries | Group-Object path | Where-Object { $_.Count -gt 1 })
if ($dup.Count -gt 0) {
  Fail ("同一文件被登记多次（按错误处理）: " + (($dup | ForEach-Object { $_.Name }) -join ', '))
}

$rows = New-Object System.Collections.Generic.List[object]
foreach ($e in $entries) {
  $full = Join-Path $root ([string]$e.path)
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    $rows.Add([pscustomobject]@{ 状态 = '缺失'; 级 = $e.tier; 路由 = $e.route; 文件 = $e.path; 索引 = (Stamp $e.sha256); 实际 = '—' })
    continue
  }
  $fi = Get-Item -LiteralPath $full
  $h = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLower()
  $same = ($h -eq ([string]$e.sha256).ToLower())
  $rows.Add([pscustomobject]@{
      状态 = $(if ($same) { '未变' } else { '已变' })
      级   = $e.tier
      路由 = $e.route
      文件 = $e.path
      索引 = (Stamp $e.sha256)
      实际 = $h.Substring(0, 12)
    })
  if ($Rebuild) {
    $e.sha256 = $h
    $e.bytes = [int]$fi.Length
    $e.updatedAt = $fi.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
}

if ($Rebuild) {
  $idx.generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $json = $idx | ConvertTo-Json -Depth 8
  Set-Content -LiteralPath $idxPath -Value $json -Encoding utf8 -NoNewline
  Write-Output ("已重建索引: {0}" -f $idxPath)
  Write-Output ("  entries = {0}   generatedAt = {1}" -f $entries.Count, $idx.generatedAt)
  exit 0
}

$changed = @($rows | Where-Object { $_.状态 -ne '未变' })

Write-Output ("索引     : {0}" -f $idxPath)
Write-Output ("root     : {0}" -f $root)
Write-Output ("登记     : {0} 个文件   generatedAt = {1}" -f $entries.Count, $idx.generatedAt)
Write-Output ''
$rows | Format-Table -AutoSize | Out-String -Width 220 | Write-Output

if ($changed.Count -eq 0) {
  Write-Output 'CHANGED: (none)'
  exit 0
}
Write-Output ("CHANGED: {0} 个" -f $changed.Count)
foreach ($c in $changed) { Write-Output ("  {0}  {1}" -f $c.状态, $c.文件) }
exit 1
