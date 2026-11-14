<#
.SYNOPSIS
  校验 project-index/1 登记文件的哈希和日志。默认只读。

.DESCRIPTION
  -ExpectedRoot 用任务单授权的项目根约束索引声明的 root。
  -Rebuild 在文件和日志齐全时更新索引，并滚动保留一份 <索引文件>.bak。
  退出码 0 表示一致或重建成功，1 表示变更或缺件，2 表示用法、格式或读取错误。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Index,
  [string]$ExpectedRoot,
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

function Fail([string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit 2
}

function Stamp($Value) {
  $valueText = [string]$Value
  $valueText.Substring(0, [Math]::Min(12, $valueText.Length))
}

function Assert-PlainPath([string]$Path) {
  $current = [IO.Path]::GetPathRoot($Path)
  foreach ($segment in ($Path.Substring($current.Length) -split '[\\/]')) {
    if ($segment.Length -eq 0) { continue }
    $current = [IO.Path]::Combine($current, $segment)
    try {
      $attributes = [IO.File]::GetAttributes($current)
    } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] {
      return
    }
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
      Fail "拒绝链接或重解析点: $current"
    }
  }
}

function Get-ScopedPath([string]$RelativePath, [string]$Root) {
  $portable = $RelativePath.Replace('\', '/')
  if ([string]::IsNullOrWhiteSpace($portable) -or $portable -match '^/|(^|/)\.\.(/|$)|[:\x00-\x1f]') {
    Fail "要求项目根内的相对路径: $RelativePath"
  }
  if ($IsWindows -and ($portable.Split('/') | Where-Object { $_ -ne '.' -and $_ -match '[. ]$' })) {
    Fail "拒绝含 Windows 路径别名的条目: $RelativePath"
  }
  $fullPath = [IO.Path]::GetFullPath($portable, $Root)
  $fromRoot = [IO.Path]::GetRelativePath($Root, $fullPath)
  if ([IO.Path]::IsPathRooted($fromRoot) -or $fromRoot -match '^\.\.([\\/]|$)') {
    Fail "路径超出项目根: $RelativePath"
  }
  Assert-PlainPath $fullPath
  $fullPath
}

try {
  $indexPath = [IO.Path]::GetFullPath($Index, $PWD.ProviderPath)
  Assert-PlainPath $indexPath
  if (-not [IO.File]::Exists($indexPath)) { Fail "找不到索引文件: $Index" }
  $indexBytes = [IO.File]::ReadAllBytes($indexPath)
  $indexText = [Text.Encoding]::UTF8.GetString($indexBytes).TrimStart([char]0xFEFF)
  $idx = ConvertFrom-Json -InputObject $indexText -AsHashtable
  if ($idx -isnot [System.Collections.IDictionary] -or $idx.spec -ne 'project-index/1') {
    Fail '索引格式错误，仅支持 project-index/1'
  }
  if ($idx.root -isnot [string] -or [string]::IsNullOrWhiteSpace($idx.root)) {
    Fail '索引必须声明 root'
  }
  $indexDir = [IO.Path]::GetDirectoryName($indexPath)
  $root = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($idx.root, $indexDir))
  $comparer = if ($IsWindows) { [StringComparer]::OrdinalIgnoreCase } else { [StringComparer]::Ordinal }
  if ($PSBoundParameters.ContainsKey('ExpectedRoot')) {
    $expected = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($ExpectedRoot, $PWD.ProviderPath))
    if (-not $comparer.Equals($expected, $root)) {
      Fail "索引声明的 root 与授权项目根不一致: $root"
    }
  }
  Assert-PlainPath $root
  if (-not [IO.Directory]::Exists($root)) { Fail "root 不存在或不是目录: $root" }
  if ($idx.entries -isnot [array] -or $idx.entries.Count -eq 0) { Fail 'entries 必须为非空数组' }

  $logRoot = $null
  if ($idx.Contains('logRoot')) { $logRoot = Get-ScopedPath $idx.logRoot $root }
  $seen = [System.Collections.Generic.HashSet[string]]::new($comparer)
  $entries = foreach ($entry in $idx.entries) {
    if ($entry -isnot [System.Collections.IDictionary] -or $entry.path -isnot [string]) {
      Fail '索引条目必须声明文件 path'
    }
    $filePath = Get-ScopedPath $entry.path $root
    if ($comparer.Equals($filePath, $root) -or $comparer.Equals($filePath, $indexPath)) {
      Fail "条目必须指向正文文件: $($entry.path)"
    }
    if (-not $seen.Add($filePath)) { Fail "同一文件被登记多次: $($entry.path)" }

    $logPath = $null
    if ($logRoot) {
      $relative = [IO.Path]::GetRelativePath($root, $filePath)
      $logPath = Get-ScopedPath ($relative + '.md') $logRoot
    }
    [pscustomobject]@{ Entry = $entry; FilePath = $filePath; LogPath = $logPath }
  }

  $missing = $false
  $needsRebuild = $false
  $rows = foreach ($item in $entries) {
    $entry = $item.Entry
    $status = '未变'
    $actual = '—'
    $indexStamp = Stamp $entry.sha256
    if ([IO.File]::Exists($item.FilePath)) {
      $file = Get-Item -LiteralPath $item.FilePath
      $hash = (Get-FileHash -LiteralPath $item.FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
      $timestamp = $file.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      $actual = Stamp $hash
      if ($hash -ne $entry.sha256) {
        $status = '已变'
        $needsRebuild = $true
      }
      if ($Rebuild) {
        $entry.sha256 = $hash
        $entry.bytes = $file.Length
        $entry.updatedAt = $timestamp
      }
    } else {
      $status = '缺失'
      $missing = $true
    }
    if ($item.LogPath -and -not [IO.File]::Exists($item.LogPath)) {
      $status = if ($status -eq '未变') { '日志缺失' } else { "$status、日志缺失" }
      $missing = $true
    }
    [pscustomobject]@{ 状态 = $status; 级 = $entry.tier; 路由 = $entry.route; 文件 = $entry.path; 索引 = $indexStamp; 实际 = $actual }
  }

  if ($Rebuild -and -not $missing) {
    if (-not $needsRebuild) {
      Write-Output '索引已一致，无需重建'
      exit 0
    }
    $backupPath = "$indexPath.bak"
    Assert-PlainPath $backupPath
    if ($seen.Contains($backupPath)) { Fail '索引备份路径与登记文件冲突' }

    $idx.generatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $json = $idx | ConvertTo-Json -Depth 16
    $stagedPath = [IO.Path]::Combine($indexDir, [IO.Path]::GetRandomFileName())
    try {
      [IO.File]::WriteAllText($stagedPath, $json, [Text.UTF8Encoding]::new($false))
      $currentBytes = [IO.File]::ReadAllBytes($indexPath)
      if ([Convert]::ToBase64String($currentBytes) -cne [Convert]::ToBase64String($indexBytes)) {
        Fail '索引在检查期间发生变化，需重新读取'
      }
      [IO.File]::Replace($stagedPath, $indexPath, $backupPath)
    } finally {
      [IO.File]::Delete($stagedPath)
    }
    Write-Output "已重建索引: $indexPath"
    Write-Output "上一版索引: $backupPath"
    exit 0
  }

  Write-Output "索引: $indexPath"
  Write-Output "root: $root"
  $rows | Format-Table -AutoSize | Out-String -Width 220 | Write-Output
  $changed = @($rows | Where-Object { $_.状态 -ne '未变' })
  if ($changed.Count -eq 0) {
    Write-Output 'CHANGED: (none)'
    exit 0
  }
  if ($Rebuild -and $missing) { Write-Output '文件或日志缺失，索引未重建' }
  Write-Output "CHANGED: $($changed.Count) 个"
  foreach ($row in $changed) { Write-Output "  $($row.状态)  $($row.文件)" }
  exit 1
} catch {
  Fail "索引校验失败: $($_.Exception.Message)"
}
