# SPEEKSNET full backup — database, uploaded files, edge functions, project
# config and git — to a dated folder on this computer.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File Backup-Speeksnet.ps1
#
# Normally run nightly by the "SPEEKSNET Backup" scheduled task, which
# Install-BackupTask.ps1 sets up. Credentials come from Set-BackupCredentials.ps1.
# How to get things back out: RESTORE.md, which is copied next to the backups.
#
# WHY IT IS BUILT THIS WAY
# - Three people are changing the site, and git only covers the code. The
#   database, the uploaded photos and documents, and several edge functions that
#   exist ONLY on the server (listing-goals, weekly-kpi, ...) have no other copy.
# - Windows PowerShell 5.1, no modules, no npm: this has to run on a stock
#   Windows machine at 2am with nobody watching. pg_dump is fetched once as the
#   official portable binaries, matched to the server's major version.
# - Each part is attempted even if an earlier one fails, and the snapshot folder
#   is only given its final name when every part succeeded. A folder ending in
#   ".partial" is a failed run; LAST-BACKUP.txt says which part and why.
# - Uploaded files are MIRRORED rather than copied per snapshot (~280 MB, mostly
#   photos, that almost never change), and the mirror NEVER DELETES: a file
#   removed from Supabase stays here, and a file that changed keeps its old
#   version under _previous-versions. Each snapshot records exactly which files
#   existed at that moment, so a restore can put back that set.

param(
    # Google Drive (SPEEKS INTRANET), so the backups are off this machine and the
    # team can reach them. Drive for desktop mounts it at G:.
    [string]$Root = 'G:\My Drive\SPEEKS INTRANET\SPEEKSNET Backups',
    [string]$ProjectRef = 'ejzaqmyxxrkmxvzbjeuo',
    [string]$GitRemote = 'https://github.com/SPEEKS-Technology/speeksnet.git',
    [string]$LocalRepo = 'C:\Users\User\Documents\GitHub\speeksnet',
    [int]$KeepDaily = 14,
    [int]$KeepWeekly = 8,
    [string]$PgVersion = '17.6-1',
    # WORKING FILES STAY ON THIS PC, even when the backups go to Google Drive:
    #   - the PostgreSQL tools are 315 MB of binaries that would sync for nothing;
    #   - the git mirror is a live repository of tens of thousands of loose objects,
    #     rewritten nightly — a sync client's worst case, and the bundles inside each
    #     snapshot are the actual backup;
    #   - the credentials are encrypted to this Windows login, so they are useless
    #     anywhere else and have no business in a folder the team can open.
    [string]$WorkDir = (Join-Path $env:LOCALAPPDATA 'SPEEKSNET Backup')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is 10x slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$stamp    = Get-Date -Format 'yyyy-MM-dd_HHmm'
$started  = Get-Date
$snapName = $stamp
$snap     = Join-Path $Root ($snapName + '.partial')
$logDir   = Join-Path $Root '_logs'
$log      = Join-Path $logDir ($stamp + '.log')
$results  = [ordered]@{}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

# GOOGLE DRIVE MAY NOT BE THERE. If Drive for desktop has not mounted yet — it can
# still be starting at 2am, or be signed out — creating the folder would silently
# make a REAL directory on a drive that is about to appear, and the backup would
# land somewhere nobody looks. Stop instead, and leave the reason where the next
# run (and Ethan) will see it.
$rootDrive = Split-Path -Qualifier $Root
if ($rootDrive -and -not (Test-Path ($rootDrive + '\'))) {
    $msg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm')  BACKUP DID NOT RUN: $rootDrive is not available. " +
           "Google Drive for desktop is probably not running or not signed in. Nothing was written."
    Add-Content -Path (Join-Path $WorkDir 'BACKUP-PROBLEM.txt') -Value $msg -Encoding UTF8
    Write-Host $msg
    exit 1
}

New-Item -ItemType Directory -Force -Path $Root, $snap, $logDir | Out-Null

function Log([string]$msg) {
    $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Host $line
}

# Runs one part, records ok/failed and the reason, and never throws — so a
# storage hiccup cannot cost the night's database dump.
function Step([string]$name, [scriptblock]$body) {
    Log "== $name"
    $t = Get-Date
    try {
        $detail = & $body
        $results[$name] = [ordered]@{ ok = $true; seconds = [int]((Get-Date) - $t).TotalSeconds; detail = "$detail" }
        Log "   ok: $detail"
    } catch {
        $results[$name] = [ordered]@{ ok = $false; seconds = [int]((Get-Date) - $t).TotalSeconds; detail = $_.Exception.Message }
        Log "   FAILED: $($_.Exception.Message)"
    }
}

function Save-Json($obj, [string]$path) {
    $dir = Split-Path $path -Parent
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    # -Depth 20: the default of 2 silently flattens nested config into strings.
    [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
}

function Format-Size([double]$bytes) {
    if ($bytes -ge 1GB) { return '{0:N2} GB' -f ($bytes / 1GB) }
    if ($bytes -ge 1MB) { return '{0:N1} MB' -f ($bytes / 1MB) }
    return '{0:N0} KB' -f ($bytes / 1KB)
}

# Runs a native exe with its stderr in a file rather than the PowerShell error
# stream, which in 5.1 wraps every stderr line in an ErrorRecord and trips
# ErrorActionPreference=Stop even on success.
function Invoke-Native([string]$exe, [string[]]$argList, [string]$what) {
    $errFile = Join-Path $logDir ($stamp + '.stderr.tmp')
    $outFile = Join-Path $logDir ($stamp + '.stdout.tmp')
    $quoted = $argList | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
    $p = Start-Process -FilePath $exe -ArgumentList ($quoted -join ' ') -NoNewWindow -Wait -PassThru `
        -RedirectStandardError $errFile -RedirectStandardOutput $outFile
    $err = if (Test-Path $errFile) { (Get-Content $errFile -Raw) } else { '' }
    $out = if (Test-Path $outFile) { (Get-Content $outFile -Raw) } else { '' }
    Remove-Item $errFile, $outFile -ErrorAction SilentlyContinue
    if ($err) { Add-Content -Path $log -Value ("   [$what stderr] " + $err.Trim()) -Encoding UTF8 }
    if ($p.ExitCode -ne 0) { throw "$what exited $($p.ExitCode): $(($err + ' ' + $out).Trim())" }
    return $out
}

Log "SPEEKSNET backup starting -> $snap"

# ---- credentials -------------------------------------------------------------
$credPath = Join-Path $WorkDir 'credentials.xml'
# Earlier installs kept them beside the backups; move them out of Drive's reach once.
$legacyCred = Join-Path $Root '_config\credentials.xml'
if ((Test-Path $legacyCred) -and -not (Test-Path $credPath)) {
    Move-Item $legacyCred $credPath -Force
    Remove-Item (Split-Path $legacyCred -Parent) -Recurse -Force -ErrorAction SilentlyContinue
}
$creds = $null
if (Test-Path $credPath) {
    try { $creds = Import-Clixml $credPath } catch { Log "Could not read credentials: $($_.Exception.Message)" }
} else {
    Log "No credentials at $credPath. Run Set-BackupCredentials.ps1 first."
}
function Plain([Security.SecureString]$s) {
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$pat = if ($creds -and $creds.AccessToken) { Plain $creds.AccessToken.Password } else { $null }
$dbPassword = if ($creds -and $creds.DbPassword) { Plain $creds.DbPassword.Password } else { $null }

$api = "https://api.supabase.com/v1/projects/$ProjectRef"

# ⚠️ WINDOWS POWERSHELL 5.1 HANDS A JSON ARRAY BACK AS ONE ITEM. Invoke-RestMethod
# returns the whole Object[] as a single pipeline object, so @(...) around it is an
# array of ONE element — the list — and every $fn.slug / $b.id became an array of
# all of them. That failed the first real run (a Join-Path on Object[], and a
# storage URL ending in "System.Object[]"). Piping through ForEach-Object is what
# actually unrolls it.
function ToList($x) { return @($x | ForEach-Object { $_ }) }

# Writes out the parts of a multipart/form-data response — the edge function's own
# source files. Done by hand because PowerShell 5.1 has no multipart parser, and
# on bytes rather than on a string so nothing is mangled by an encoding guess.
# Returns the file names written.
function Save-MultipartFiles($response, [string]$boundary, [string]$dest) {
    $bytes = $response.Content
    if ($bytes -is [string]) { $bytes = [Text.Encoding]::UTF8.GetBytes($bytes) }
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    $boundary = $boundary.Trim('"')
    $written = @()
    foreach ($part in ($text -split [regex]::Escape('--' + $boundary))) {
        if ($part.Trim() -in @('', '--')) { continue }
        $split = $part -split "`r`n`r`n", 2
        if ($split.Count -lt 2) { continue }
        $headers = $split[0]
        $body = $split[1]
        # The trailing CRLF belongs to the boundary, not to the file.
        if ($body.EndsWith("`r`n")) { $body = $body.Substring(0, $body.Length - 2) }
        $name = $null
        if ($headers -match 'filename="([^"]+)"') { $name = $Matches[1] }
        elseif ($headers -match 'name="([^"]+)"') { $name = $Matches[1] }
        if (-not $name) { continue }
        # Paths arrive as the function's own layout (source/index.ts); keep it,
        # minus anything that would climb out of the folder.
        $rel = ($name -replace '^[\\/]+', '') -replace '\.\.', '_'
        $path = Join-Path $dest $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
        [IO.File]::WriteAllText($path, $body, (New-Object Text.UTF8Encoding $false))
        $written += $rel
    }
    return $written
}
function Api([string]$path) {
    if (-not $pat) { throw 'no Supabase access token saved' }
    return Invoke-RestMethod -Uri ($api + $path) -Headers @{ Authorization = "Bearer $pat" } -TimeoutSec 120
}

# ---- 1. database ---------------------------------------------------------------
Step 'database' {
    if (-not $dbPassword) { throw 'no database password saved' }

    # Portable pg_dump, once. Only pgsql/bin is unpacked — it holds pg_dump and
    # every DLL it loads; the other 300 MB of the archive is the server.
    $pgBin = Join-Path $WorkDir "pgsql-$PgVersion\pgsql\bin"
    $pgDump = Join-Path $pgBin 'pg_dump.exe'
    if (-not (Test-Path $pgDump)) {
        $toolDir = Join-Path $WorkDir "pgsql-$PgVersion"
        New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
        $zip = Join-Path $toolDir 'pgsql.zip'
        Log "   downloading PostgreSQL $PgVersion client tools (one time, ~315 MB)"
        Invoke-WebRequest -Uri "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 1800
        Invoke-Native "$env:SystemRoot\System32\tar.exe" @('-xf', $zip, '-C', $toolDir, 'pgsql/bin') 'tar' | Out-Null
        Remove-Item $zip
        if (-not (Test-Path $pgDump)) { throw "pg_dump.exe not found after unpacking to $toolDir" }
    }

    # The direct db.<ref>.supabase.co host is IPv6-only, which most home and
    # office connections cannot reach. The session pooler speaks IPv4 and, unlike
    # the transaction pooler, supports everything pg_dump does.
    $host_ = $null; $user = $null; $port = 5432; $dbname = 'postgres'
    try {
        $pool = Api '/config/database/pooler'
        $primary = @($pool | Where-Object { $_.database_type -eq 'PRIMARY' })[0]
        if (-not $primary) { $primary = @($pool)[0] }
        $host_ = $primary.db_host; $user = $primary.db_user; $dbname = $primary.db_name
    } catch {
        if ($creds.PoolerHost) { $host_ = $creds.PoolerHost; $user = "postgres.$ProjectRef" }
        else { throw "could not look up the connection pooler: $($_.Exception.Message)" }
    }

    $dbDir = Join-Path $snap 'database'
    New-Item -ItemType Directory -Force -Path $dbDir | Out-Null
    $env:PGPASSWORD = $dbPassword
    $env:PGSSLMODE = 'require'
    $env:PGCONNECT_TIMEOUT = '30'
    try {
        $common = @('-h', $host_, '-p', "$port", '-U', $user, '-d', $dbname, '--no-password')
        # The full database in pg_dump's custom format: compressed, and restorable
        # table by table with pg_restore -t. Every schema — public, but also cron
        # (the 52 scheduled jobs), storage (which file lives where) and auth.
        Invoke-Native $pgDump ($common + @('-Fc', '--no-owner', '-f', (Join-Path $dbDir 'speeksnet-full.dump'))) 'pg_dump full' | Out-Null
        # The same structure as plain SQL, so a table's definition can be read or
        # diffed without restoring anything.
        Invoke-Native $pgDump ($common + @('--schema-only', '--no-owner', '-f', (Join-Path $dbDir 'schema.sql'))) 'pg_dump schema' | Out-Null
    } finally {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
    $size = (Get-Item (Join-Path $dbDir 'speeksnet-full.dump')).Length
    if ($size -lt 1MB) { throw "the dump is only $(Format-Size $size), which cannot be the whole database" }
    "full dump $(Format-Size $size) via $host_"
}

# ---- 2. project config and edge functions --------------------------------------
Step 'project config' {
    $cfgDir = Join-Path $snap 'project'
    $saved = @()
    $parts = [ordered]@{
        'project.json'          = ''
        'auth-config.json'      = '/config/auth'
        'postgrest-config.json' = '/postgrest'
        'storage-config.json'   = '/config/storage'
        'pooler-config.json'    = '/config/database/pooler'
        # Names and digests only: Supabase never hands a secret's value back.
        'function-secrets-names.json' = '/secrets'
    }
    # ⚠️ REDACTED BEFORE IT IS WRITTEN. /postgrest hands back the project's
    # jwt_secret, which signs admin-level tokens, and the auth config can carry SMTP
    # and provider secrets. The backups live in a folder the whole team can open, so
    # a secret in them is a secret published. Nothing is lost for a restore: a new
    # project issues its own JWT secret, and while this one exists its keys can be
    # read from the dashboard. The field name stays, so you can see what existed.
    function Hide-Secrets($obj) {
        if ($null -eq $obj) { return $obj }
        if ($obj -is [Array]) { return @($obj | ForEach-Object { Hide-Secrets $_ }) }
        if ($obj -isnot [psobject] -or $obj -is [string] -or $obj -is [ValueType]) { return $obj }
        $out = [ordered]@{}
        foreach ($p in $obj.PSObject.Properties) {
            $v = $p.Value
            if ($p.Name -match 'secret|password|private_key|client_secret|dsn|access_key' -and
                $v -is [string] -and $v.Length -ge 16) {
                $out[$p.Name] = "(redacted by backup - $($v.Length) chars; read it from the Supabase dashboard if you ever need it)"
            } elseif ($v -is [psobject] -and $v -isnot [string] -and $v -isnot [ValueType]) {
                $out[$p.Name] = Hide-Secrets $v
            } else {
                $out[$p.Name] = $v
            }
        }
        return [pscustomobject]$out
    }

    foreach ($file in $parts.Keys) {
        try {
            $data = Hide-Secrets (Api $parts[$file])
            if ($file -eq 'function-secrets-names.json') {
                $data = @($data | ForEach-Object { [ordered]@{ name = $_.name; digest = $_.value } })
            }
            Save-Json $data (Join-Path $cfgDir $file)
            $saved += $file
        } catch {
            Log "   ($file skipped: $($_.Exception.Message))"
        }
    }
    if ($saved.Count -eq 0) { throw 'nothing could be read from the Supabase API' }
    "$($saved.Count) of $($parts.Count) settings files"
}

Step 'edge functions' {
    $fnDir = Join-Path $snap 'functions'
    New-Item -ItemType Directory -Force -Path $fnDir | Out-Null
    $list = ToList (Api '/functions')
    # The list carries what a redeploy needs besides the code: verify_jwt (every
    # function here runs with it OFF) and the entrypoint path.
    Save-Json $list (Join-Path $fnDir '_functions.json')

    # Reuse the previous snapshot's copy of any function whose version has not
    # moved — the list of ~100 functions changes a few a week.
    $prev = Get-ChildItem $Root -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{4}$' } |
        Sort-Object Name -Descending | Select-Object -First 1
    $prevList = @{}
    if ($prev -and (Test-Path (Join-Path $prev.FullName 'functions\_functions.json'))) {
        ToList (Get-Content (Join-Path $prev.FullName 'functions\_functions.json') -Raw | ConvertFrom-Json) |
            ForEach-Object { $prevList[$_.slug] = $_.version }
    }

    $fetched = 0; $reused = 0; $failed = @()
    foreach ($fn in $list) {
        $dest = Join-Path $fnDir $fn.slug
        $prevDir = if ($prev) { Join-Path $prev.FullName ("functions\" + $fn.slug) } else { $null }
        # Reuse only a copy that actually holds source. The night this moved from
        # the deployed bundle to the source files, every function's version was
        # unchanged, so the old 7 MB bundles were copied forward instead.
        $prevUsable = $prevDir -and (Test-Path $prevDir) -and -not (Test-Path (Join-Path $prevDir 'deployed-body.bin')) `
            -and (Get-ChildItem $prevDir -Recurse -File -Filter '*.ts' -ErrorAction SilentlyContinue).Count -gt 0
        if ($prevUsable -and $prevList.ContainsKey($fn.slug) -and $prevList[$fn.slug] -eq $fn.version) {
            Copy-Item $prevDir $dest -Recurse
            $reused++
            continue
        }
        try {
            New-Item -ItemType Directory -Force -Path $dest | Out-Null
            # ASK FOR THE SOURCE, NOT THE BUNDLE. Without an Accept header this
            # endpoint returns the deployed eszip — every dependency inlined, 7 MB
            # a function, 319 MB a night for code that is a few KB. With
            # multipart/form-data it hands back the function's OWN files, which is
            # both what a person would read and what a redeploy needs.
            $resp = Invoke-WebRequest -Uri "$api/functions/$($fn.slug)/body" `
                -Headers @{ Authorization = "Bearer $pat"; Accept = 'multipart/form-data' } `
                -UseBasicParsing -TimeoutSec 120
            $ctype = "$($resp.Headers['Content-Type'])"
            $files = @()
            if ($ctype -match 'boundary=(.+)$') {
                $files = Save-MultipartFiles $resp $Matches[1] $dest
            }
            if ($files.Count -eq 0) {
                # Unexpected shape: keep whatever came back rather than nothing.
                [IO.File]::WriteAllBytes((Join-Path $dest 'deployed-body.bin'), $resp.Content)
                $files = @('deployed-body.bin (raw: the API did not return source files)')
            }
            Save-Json ([ordered]@{ slug = $fn.slug; version = $fn.version; verify_jwt = $fn.verify_jwt;
                entrypoint_path = $fn.entrypoint_path; files = $files }) (Join-Path $dest 'meta.json')
            $fetched++
        } catch {
            $failed += $fn.slug
            Log "   $($fn.slug): $($_.Exception.Message)"
        }
    }
    if ($failed.Count) { throw "$($failed.Count) of $($list.Count) functions could not be downloaded: $($failed -join ', ')" }
    "$($list.Count) functions ($fetched downloaded, $reused unchanged)"
}

# ---- 3. uploaded files ---------------------------------------------------------
Step 'storage' {
    if (-not $pat) { throw 'no Supabase access token saved' }
    $keys = ToList (Api '/api-keys?reveal=true')
    $service = @($keys | Where-Object { $_.name -eq 'service_role' })[0].api_key
    if (-not $service) { throw 'the service_role key was not returned by the API' }
    $base = "https://$ProjectRef.supabase.co/storage/v1"
    $h = @{ apikey = $service; Authorization = "Bearer $service" }

    $mirror = Join-Path $Root '_storage-mirror'
    $versions = Join-Path $mirror ('_previous-versions\' + $stamp)
    $buckets = ToList (Invoke-RestMethod -Uri "$base/bucket" -Headers $h -TimeoutSec 60)
    Save-Json $buckets (Join-Path $snap 'storage\_buckets.json')

    # Windows cannot hold : * ? " < > | in a file name. Such names are stored
    # with those characters replaced, and the manifest keeps the real key.
    function ConvertTo-LocalName([string]$key) { return ($key -replace '[:*?"<>|]', '_') -replace '/', '\' }
    function Enc([string]$key) { return (($key -split '/') | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/' }

    $manifest = @(); $downloaded = 0; $bytesNew = 0; $total = 0; $bytesTotal = 0
    foreach ($b in $buckets) {
        $bucket = $b.id
        $idxPath = Join-Path $mirror "$bucket\_index.json"
        $index = @{}
        if (Test-Path $idxPath) {
            (Get-Content $idxPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $index[$_.Name] = $_.Value }
        }
        $queue = New-Object System.Collections.Queue
        $queue.Enqueue('')
        while ($queue.Count) {
            $prefix = $queue.Dequeue()
            $offset = 0
            do {
                $body = @{ prefix = $prefix; limit = 1000; offset = $offset; sortBy = @{ column = 'name'; order = 'asc' } } | ConvertTo-Json
                $page = ToList (Invoke-RestMethod -Method Post -Uri "$base/object/list/$bucket" -Headers $h -ContentType 'application/json' -Body $body -TimeoutSec 120)
                foreach ($o in $page) {
                    $key = if ($prefix) { "$prefix$($o.name)" } else { $o.name }
                    if (-not $o.id) { $queue.Enqueue("$key/"); continue }   # a folder
                    $etag = "$($o.metadata.eTag)"; $size = [int64]$o.metadata.size
                    $local = Join-Path $mirror ("$bucket\" + (ConvertTo-LocalName $key))
                    $total++; $bytesTotal += $size
                    $manifest += [ordered]@{ bucket = $bucket; key = $key; size = $size; etag = $etag; updated = $o.updated_at; local = (ConvertTo-LocalName $key) }
                    if ((Test-Path $local) -and $index[$key] -eq $etag) { continue }
                    if (Test-Path $local) {
                        # Changed upstream: keep what we had.
                        $old = Join-Path $versions ("$bucket\" + (ConvertTo-LocalName $key))
                        New-Item -ItemType Directory -Force -Path (Split-Path $old -Parent) | Out-Null
                        Move-Item $local $old -Force
                    }
                    New-Item -ItemType Directory -Force -Path (Split-Path $local -Parent) | Out-Null
                    Invoke-WebRequest -Uri "$base/object/$bucket/$(Enc $key)" -Headers $h -OutFile $local -UseBasicParsing -TimeoutSec 600
                    $index[$key] = $etag
                    $downloaded++; $bytesNew += $size
                }
                $offset += $page.Count
            } while ($page.Count -eq 1000)
        }
        Save-Json $index $idxPath
    }
    # Which files existed at this moment, and which mirror file holds each one.
    Save-Json $manifest (Join-Path $snap 'storage\_files-at-this-time.json')
    "$total files ($(Format-Size $bytesTotal)) in $($buckets.Count) buckets; $downloaded new or changed ($(Format-Size $bytesNew)) -> _storage-mirror"
}

# ---- 4. git --------------------------------------------------------------------
Step 'git' {
    $gitDir = Join-Path $snap 'git'
    New-Item -ItemType Directory -Force -Path $gitDir | Out-Null
    $mirrorRepo = Join-Path $WorkDir 'speeksnet.git'
    if (-not (Test-Path $mirrorRepo)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $mirrorRepo -Parent) | Out-Null
        Invoke-Native 'git' @('clone', '--mirror', '--quiet', $GitRemote, $mirrorRepo) 'git clone' | Out-Null
    } else {
        # No --prune: a branch deleted on GitHub stays here.
        Invoke-Native 'git' @('-C', $mirrorRepo, 'remote', 'update') 'git fetch' | Out-Null
    }
    # A bundle is the repository as it stood tonight — every branch at tonight's
    # commit — in one file. The mirror alone would be overwritten by a force-push;
    # the bundles are what let you go back past one.
    Invoke-Native 'git' @('-C', $mirrorRepo, 'bundle', 'create', (Join-Path $gitDir 'github-all-branches.bundle'), '--all') 'git bundle github' | Out-Null
    $detail = "GitHub bundle $(Format-Size (Get-Item (Join-Path $gitDir 'github-all-branches.bundle')).Length)"
    # This computer's own clone too: local branches and commits not pushed yet.
    if (Test-Path (Join-Path $LocalRepo '.git')) {
        Invoke-Native 'git' @('-C', $LocalRepo, 'bundle', 'create', (Join-Path $gitDir 'this-computer-all-branches.bundle'), '--all') 'git bundle local' | Out-Null
        $status = Invoke-Native 'git' @('-C', $LocalRepo, 'status', '--short', '--branch') 'git status'
        [IO.File]::WriteAllText((Join-Path $gitDir 'this-computer-status.txt'), $status)
        $detail += ', local clone bundled'
    }
    $detail
}

# ---- finish --------------------------------------------------------------------
$allOk = -not ($results.Values | Where-Object { -not $_.ok })
$finalPath = $snap
if ($allOk) {
    $finalPath = Join-Path $Root $snapName
    Rename-Item $snap $finalPath
}
$snapSize = (Get-ChildItem $finalPath -Recurse -File | Measure-Object Length -Sum).Sum
Save-Json ([ordered]@{
    started = $started.ToString('s'); finished = (Get-Date).ToString('s')
    complete = $allOk; project = $ProjectRef; computer = $env:COMPUTERNAME; size = (Format-Size $snapSize)
    parts = $results
}) (Join-Path $finalPath 'manifest.json')

# ---- retention: 14 daily + 8 weekly --------------------------------------------
# Only complete snapshots count. Newest per calendar day for the last $KeepDaily
# days that HAVE a backup (a week the PC was off does not eat the allowance), and
# newest per Monday-starting week for the last $KeepWeekly weeks. The mirror, the
# tools and the logs are never touched here.
try {
    $snaps = @(Get-ChildItem $Root -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{4}$' } | Sort-Object Name -Descending)
    $keep = @{}
    $snaps | Group-Object { $_.Name.Substring(0, 10) } | Select-Object -First $KeepDaily |
        ForEach-Object { $keep[$_.Group[0].Name] = $true }
    $snaps | Group-Object {
        $d = [datetime]::ParseExact($_.Name.Substring(0, 10), 'yyyy-MM-dd', $null)
        $d.AddDays(-(([int]$d.DayOfWeek + 6) % 7)).ToString('yyyy-MM-dd')
    } | Select-Object -First $KeepWeekly | ForEach-Object { $keep[$_.Group[0].Name] = $true }
    foreach ($s in $snaps) {
        if (-not $keep[$s.Name]) { Log "retention: removing $($s.Name)"; Remove-Item $s.FullName -Recurse -Force }
    }
    # Failed runs: kept a few days for diagnosis, then cleared.
    Get-ChildItem $Root -Directory | Where-Object { $_.Name -like '*.partial' -and $_.LastWriteTime -lt (Get-Date).AddDays(-3) } |
        ForEach-Object { Log "retention: removing failed run $($_.Name)"; Remove-Item $_.FullName -Recurse -Force }
    Get-ChildItem $logDir -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } | Remove-Item -Force
} catch {
    Log "retention FAILED (nothing was lost, old snapshots just were not cleared): $($_.Exception.Message)"
}

# ---- status file ---------------------------------------------------------------
$lines = @()
$lines += $(if ($allOk) { "OK  -  last backup completed $(Get-Date -Format 'dddd MMM d, yyyy h:mm tt')" } else { "PROBLEM  -  backup on $(Get-Date -Format 'dddd MMM d, yyyy h:mm tt') did NOT complete" })
$lines += ''
foreach ($k in $results.Keys) {
    $r = $results[$k]
    $lines += ('{0,-16} {1,-7} {2}' -f $k, $(if ($r.ok) { 'ok' } else { 'FAILED' }), $r.detail)
}
$lines += ''
$lines += "Folder: $finalPath  ($(Format-Size $snapSize))"
$lines += "Log:    $log"
[IO.File]::WriteAllText((Join-Path $Root 'LAST-BACKUP.txt'), ($lines -join "`r`n"))
Log ($lines[0])
if (-not $allOk) { exit 1 }
