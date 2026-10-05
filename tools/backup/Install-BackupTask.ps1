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
# is fine; signed out is not. If the PC is asleep or off at 2am, the backup runs
# the next time you log on or unlock it.

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
# 2am is when it runs if the PC is awake. It no longer WAKES the PC for it: this
# is a laptop, and a 2am wake with the lid shut drops straight back into Modern
# Standby with Google Drive not serving files — that is what the Sep 30 run did, and most likely every night from Sep 22 —
# no backup and no error. Logon and unlock catch up the first time
# someone opens it; the script skips itself once today's snapshot exists.
$unlockClass = Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskSessionStateChangeTrigger
$unlock = New-CimInstance -CimClass $unlockClass -ClientOnly
$unlock.StateChange = 8   # TASK_SESSION_UNLOCK
$unlock.UserId = "$env:USERDOMAIN\$env:USERNAME"
$unlock.Enabled = $true
$trigger = @(
    (New-ScheduledTaskTrigger -Daily -At $At),
    (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
    $unlock
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'SPEEKSNET Backup' -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description "Nightly full SPEEKSNET backup to $Root. See RESTORE.md there." -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName 'SPEEKSNET Backup'
Write-Host "Installed. Next run: $($info.NextRunTime)"
