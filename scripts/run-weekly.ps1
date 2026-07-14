# Arch competition trends WEEKLY generator - called by Windows Task Scheduler Mondays 09:00 KST.
# ASCII-only on purpose: the repo lives under a Korean path, so we resolve the
# Desktop folder via the API instead of hardcoding Korean bytes in this script.
$ErrorActionPreference = 'Continue'

# Scheduled tasks run with a minimal PATH - point at node / git / npm-global (codex) explicitly.
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Users\myh43\AppData\Roaming\npm;$env:Path"

$repo = Join-Path ([Environment]::GetFolderPath('Desktop')) 'work\_inspect\arch-trends-curation'
Set-Location $repo
$log = Join-Path $repo 'daily.log'

function Log($m) {
  "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m |
    Out-File -FilePath $log -Append -Encoding utf8
}

Log "==== start ===="
git pull --quiet origin main *>> $log

node scripts/build-local.mjs *>> $log
if ($LASTEXITCODE -ne 0) { Log "generator failed (exit $LASTEXITCODE)"; exit 1 }

git add -A *>> $log
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m ("weekly: " + (Get-Date -Format 'yyyy-MM-dd')) *>> $log
  git push origin main *>> $log
  Log "pushed"
} else {
  Log "no changes (this week's episode already exists)"
}
