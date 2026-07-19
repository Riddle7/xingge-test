# 从 KV 读取所有 count_ 值，生成迁移 SQL
$types = @(
  'S-F-R-Re','S-F-R-E','S-F-P-Re','S-F-P-E',
  'S-M-R-Re','S-M-R-E','S-M-P-Re','S-M-P-E',
  'O-F-R-Re','O-F-R-E','O-F-P-Re','O-F-P-E',
  'O-M-R-Re','O-M-R-E','O-M-P-Re','O-M-P-E',
  'HYBRID'
)

$sqlLines = @()
$sqlLines += "-- 从 KV 迁移现有计数到 D1"
$total = 0

foreach ($t in $types) {
  $key = "count_$t"
  $val = npx wrangler kv key get --binding CPTI_STATS --remote "$key" 2>$null
  $val = "$val".Trim()
  if (-not $val) { $val = "0" }
  $count = [int]$val
  $total += $count
  Write-Host ("  {0}: {1}" -f $t, $count)
  $sqlLines += "UPDATE counts SET count = $count WHERE type = '$t';"
}

$sqlLines += "INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_total', '$total');"
$sqlLines += "INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_at', datetime('now'));"

$sql = $sqlLines -join "`n"
Set-Content -Path "migrate-data.sql" -Value $sql -Encoding UTF8
Write-Host ""
Write-Host ("Total: $total")
Write-Host "Generated migrate-data.sql"
