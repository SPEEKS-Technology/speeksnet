# Installs (or updates) the nightly "SPEEKSNET Backup" scheduled task.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File Install-BackupTask.ps1
#
# The scripts are COPIED into the backup folder and the task runs that copy, not
# the one in the repo: checking out a branch that predates tools/backup would
# otherwise delete the script out from under tonight's run. Re-run this after
# changing Backup-Speeksnet.ps1 to pick the change up.
#
# Runs as you, "only when logged on" — the saved credentials are encrypted to
# your Windows login and a task running without it could not read them. Locked
# is fine; signed out is not. If the PC is asleep at 2am it wakes to run, and if
# it was off, the task runs as soon as it is next on.

param(
    [string]$Root = 'G:\My Drive\SPEEKS INTRANET\SPEEKSNET Backups',
    [string]$At = '2:00am'
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$toolDir = Join-Path $env:LOCALAPPDATA 'SPEEKSNET Backup\_tool'
New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
Copy-Item (Join-Path $here 'Backup-Speeksnet.ps1'), (Join-Path $here 'Set-BackupCredentials.ps1') $toolDir -Force
Copy-Item (Join-Path $here 'RESTORE.md') $Root -Force

$script = Join-Path $toolDir 'Backup-Speeksnet.ps1'
# conhost --headless: no console window flashes up on the screen at 2am.
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
    -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`" -Root `"$Root`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'SPEEKSNET Backup' -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description "Nightly full SPEEKSNET backup to $Root. See RESTORE.md there." -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName 'SPEEKSNET Backup'
Write-Host "Installed. Next run: $($info.NextRunTime)"
