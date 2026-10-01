# Saves the two secrets the nightly backup needs, encrypted to THIS Windows user
# on THIS computer (DPAPI via Export-Clixml). Nobody else — and no other machine
# the file is copied to — can read them back.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File Set-BackupCredentials.ps1
#
# Run it yourself, in your own PowerShell window: it asks for each value with the
# input hidden, so neither secret is ever typed into a chat or saved in plain text.
#
#   1. Supabase access token  — supabase.com/dashboard/account/tokens -> Generate
#      new token (name it "SPEEKSNET backup"). Starts with sbp_. Used for the
#      function code, project settings and the key that downloads uploaded files.
#   2. Database password      — the project's Postgres password. If nobody has it,
#      Project Settings -> Database -> Reset database password. Nothing in the
#      site uses that password (the app and edge functions use API keys), so
#      resetting it breaks nothing.

param(
    # Deliberately NOT beside the backups: those go to a shared Google Drive
    # folder, and credentials — even ones only this Windows login can decrypt —
    # do not belong anywhere the team can open.
    [string]$WorkDir = (Join-Path $env:LOCALAPPDATA 'SPEEKSNET Backup'),
    [string]$ProjectRef = 'ejzaqmyxxrkmxvzbjeuo'
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Plain([Security.SecureString]$s) {
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

Write-Host ''
Write-Host 'SPEEKSNET backup - save credentials' -ForegroundColor Green
Write-Host "Saved to: $WorkDir\credentials.xml (readable only by $env:USERNAME on $env:COMPUTERNAME)"
Write-Host ''

# ---- access token, checked before it is saved ----------------------------------
$pool = $null
while ($true) {
    $tok = Read-Host 'Supabase access token (sbp_...)' -AsSecureString
    $t = Plain $tok
    try {
        $p = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ProjectRef" -Headers @{ Authorization = "Bearer $t" } -TimeoutSec 30
        Write-Host "  token works - project: $($p.name)" -ForegroundColor Green
        try { $pool = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ProjectRef/config/database/pooler" -Headers @{ Authorization = "Bearer $t" } -TimeoutSec 30 } catch {}
        break
    } catch {
        Write-Host "  that token was refused: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host '  Try again (or Ctrl+C to stop).'
    }
}

# ---- database password ---------------------------------------------------------
# Not checked here: that needs pg_dump, which the first backup run downloads. The
# first run reports a wrong password plainly in LAST-BACKUP.txt.
$pw = Read-Host 'Database password' -AsSecureString
if ((Plain $pw).Length -eq 0) { throw 'No database password entered.' }

$primary = @($pool | Where-Object { $_.database_type -eq 'PRIMARY' })[0]
$out = @{
    AccessToken = New-Object Management.Automation.PSCredential('supabase-access-token', $tok)
    DbPassword  = New-Object Management.Automation.PSCredential('postgres', $pw)
    PoolerHost  = $(if ($primary) { $primary.db_host } else { $null })
    SavedAt     = (Get-Date).ToString('s')
}
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$out | Export-Clixml -Path (Join-Path $WorkDir 'credentials.xml')
Write-Host ''
Write-Host 'Saved.' -ForegroundColor Green
