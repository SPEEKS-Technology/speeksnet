#Requires -Version 5.1
<#
    SPEEKS B2B Capture  --  v0.1.0
    -------------------------------------------------------------------------
    Runs on a test machine once Windows is up. Reads everything the B2B pricing
    sheet needs, asks the three things only a human can answer, and writes one
    JSON file per unit named after its serial.

    Field names match b2b_deal_items / the b2b-deals `update_item` action
    exactly, so the collated output can be POSTed straight in with no mapping
    layer in between.

    Deliberately zero-install: Windows PowerShell 5.1 ships with Windows, so
    this runs on a machine that was imaged twenty minutes ago with nothing
    added to it. No runtime, no modules, no internet.

    Usage (normally just double-click RUN-CAPTURE.bat instead):
        .\SPEEKS-Capture.ps1
        .\SPEEKS-Capture.ps1 -OutDir D:\captures -AlsoCopyTo \\HAYDN-PC\SpecDrop
        .\SPEEKS-Capture.ps1 -NoPrompt          # specs only, no questions
#>

[CmdletBinding()]
param(
    # Where the JSON lands. Defaults to the folder this script is sitting in,
    # which on the bench is the USB stick -- the one storage location that is
    # guaranteed present and needs no network.
    [string]$OutDir,

    # Optional second destination: a UNC share, a synced folder, anything the
    # machine can see. Best-effort -- a failure here never loses the capture,
    # because the local copy is already written by the time this is attempted.
    [string]$AlsoCopyTo,

    # Skip the condition/wipe/notes questions. For a pure spec sweep.
    [switch]$NoPrompt,

    # Also save a full-screen PNG named after the serial. Evidence for a unit
    # someone queries later, or a backup if a probe returns nonsense.
    [switch]$Screenshot,

    # ---- live intake (opt-in; without these two the script behaves exactly as
    # ---- it always has) ------------------------------------------------------
    #
    # The six-character code shown on the pricing sheet in SPEEKSnet when a
    # pricer starts a bench session. Given it, this machine posts its own reading
    # into that deal over wifi as well as writing the USB copy.
    #
    # The post is strictly a SECOND destination, exactly like -AlsoCopyTo: the
    # local JSON is written and confirmed before the network is touched, so a
    # laptop with no drivers, no wifi or a mistyped code loses nothing and the
    # USB/collate route still works untouched.
    [string]$Session,

    # Ask for the session code instead of passing it in. For the bench, where
    # RUN-CAPTURE.bat is double-clicked and nobody is typing arguments. Blank
    # answer means "not this time" and the run continues offline.
    #
    # Asked ONCE PER STICK, not once per machine. The answer is written to
    # config\speeks-device.json beside the script -- i.e. onto the USB -- and
    # every later run, on every later machine, reuses it. A pallet of forty
    # laptops is one code entry, not forty.
    [switch]$Live,

    # Forget this stick's saved session and ask for a new one. How you move a
    # stick from one pickup to the next. Without it a remembered code would keep
    # posting into the deal it was last used for, which is the one genuinely
    # dangerous thing a remembered credential can do.
    [switch]$NewSession,

    # A name for this stick, shown beside every machine it reports: "Bench 1",
    # "Haydn's stick". Saved on first use, so it only has to be given once.
    [string]$DeviceLabel,

    # Print what this stick is enrolled against and exit. Does not read the
    # machine and does not post.
    [switch]$WhoAmI,

    # Override the endpoint. Only wanted for testing against a branch.
    [string]$PostTo = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/b2b-intake'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'
$ToolVersion = '0.1.0'

# Every probe below runs inside this. A machine with a dead battery, no
# discrete GPU, or a panel that reports no EDID must still produce a usable
# record for every OTHER field -- one missing value is a blank, not a failure.
# ---------------------------------------------------------------- the stick
#
# Identity and session live WITH THE DRIVE, in config\speeks-device.json beside
# this script. That location is the point: the file travels on the USB, so the
# stick -- not the machine, and not the person -- is what remembers which pickup
# it is working. Plug it into the fortieth laptop of the day and it already
# knows; the tech types nothing.
#
# Two things are kept:
#   device_id     minted once, never again. Identifies THIS stick in the tray,
#                 so "which one did that come off" has an answer when three
#                 people are working one pallet.
#   session_code  the pricer's code for the pickup in hand. Cleared by
#                 -NewSession, which is how a stick is moved to the next job.
#
# Deliberately NOT a secret store. The code is a short-lived, single-deal,
# human-gated credential and nothing it reaches can move money on its own (see
# supabase/functions/b2b-intake). A stick that walks off can post junk into one
# review tray until somebody closes the session. If that ever stops being an
# acceptable blast radius, the answer is a per-device token hashed server-side
# with its own revoke -- Haydn's handoff spells that design out and it is the
# right next step, not a rewrite of this.
$DeviceConfigDir  = Join-Path $PSScriptRoot 'config'
$DeviceConfigPath = Join-Path $DeviceConfigDir 'speeks-device.json'

function Get-DeviceConfig {
    $cfg = [ordered]@{ device_id = $null; device_label = $null; session_code = $null; session_saved_at = $null }
    if (Test-Path $DeviceConfigPath) {
        try {
            $raw = Get-Content -Raw -Path $DeviceConfigPath -Encoding UTF8 | ConvertFrom-Json
            foreach ($k in @('device_id','device_label','session_code','session_saved_at')) {
                if ($null -ne $raw.$k) { $cfg[$k] = [string]$raw.$k }
            }
        } catch {
            # A corrupt config must not stop a capture. Mint a fresh identity and
            # carry on -- the USB write is what matters and it has not run yet.
            Write-Host '    Device config unreadable; starting a fresh one.' -ForegroundColor DarkYellow
        }
    }
    if (-not $cfg.device_id) {
        # usb-<12 hex>. Random rather than derived from the volume serial: a
        # stick can be reformatted or cloned, and two sticks answering to one id
        # would silently merge their captures in the tray.
        $b = New-Object byte[] 6
        ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($b)
        $cfg.device_id = 'usb-' + (($b | ForEach-Object { $_.ToString('x2') }) -join '')
        # Persisted the instant it is minted, not left to whatever runs later.
        # An id that is only saved on the paths that post would be re-minted on
        # every offline run, and the stick would answer to a different name each
        # time -- which is the one thing an identity may not do.
        [void](Save-DeviceConfig $cfg)
    }
    return $cfg
}

# Best-effort, exactly like -AlsoCopyTo. A write-protected or full stick must
# cost a warning and nothing else; the capture itself is already safe on disk.
function Save-DeviceConfig {
    param($Config)
    try {
        if (-not (Test-Path $DeviceConfigDir)) { New-Item -ItemType Directory -Path $DeviceConfigDir -Force -ErrorAction Stop | Out-Null }
        ($Config | ConvertTo-Json -Depth 4) | Set-Content -Path $DeviceConfigPath -Encoding UTF8 -ErrorAction Stop
        return $true
    } catch {
        Write-Host "    Couldn't save this stick's settings: $($_.Exception.Message)" -ForegroundColor DarkYellow
        Write-Host '      The capture is fine. You will be asked for the code again next run.' -ForegroundColor DarkGray
        return $false
    }
}

# Answered before anything touches the hardware, because the question is about
# the stick and not about the machine it happens to be in.
if ($WhoAmI) {
    $c = Get-DeviceConfig
    Write-Host ''
    Write-Host '  SPEEKS Capture -- this drive' -ForegroundColor Cyan
    Write-Host '  ---------------------------' -ForegroundColor DarkCyan
    Write-Host "    Device id   $($c.device_id)"
    Write-Host "    Label       $(if ($c.device_label) { $c.device_label } else { '(none -- set with -DeviceLabel)' })"
    if ($c.session_code) {
        Write-Host "    Session     $($c.session_code)" -ForegroundColor Green
        Write-Host "    Saved       $($c.session_saved_at)" -ForegroundColor DarkGray
        Write-Host '    Run -NewSession to move this stick to a different pickup.' -ForegroundColor DarkGray
    } else {
        Write-Host '    Session     (none -- runs offline; use -Live to enrol)' -ForegroundColor DarkYellow
    }
    Write-Host "    Config      $DeviceConfigPath" -ForegroundColor DarkGray
    Write-Host ''
    return
}

function Get-Safe {
    param([scriptblock]$Block, $Default = $null)
    try { $v = & $Block; if ($null -eq $v) { return $Default }; return $v }
    catch { return $Default }
}

function Write-Head { param([string]$Text)
    Write-Host ''
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ("  " + ('-' * $Text.Length)) -ForegroundColor DarkCyan
}

function Write-Field { param([string]$Label, $Value, [string]$Colour = 'White')
    $shown = if ([string]::IsNullOrWhiteSpace([string]$Value)) { '(not detected)' } else { [string]$Value }
    $tone  = if ([string]::IsNullOrWhiteSpace([string]$Value)) { 'DarkGray' } else { $Colour }
    Write-Host ("    {0,-16}" -f ($Label + ':')) -NoNewline
    Write-Host $shown -ForegroundColor $tone
}

# ---------------------------------------------------------------- normalisers
#
# These exist because the pricing sheet is read by humans and searched on eBay.
# "12th Gen Intel(R) Core(TM) i7-12700H" is what WMI says; "i7-12700H" is what
# goes in the CPU box and into a search query. The raw string is kept alongside
# every normalised value so nothing is ever actually lost to a bad regex.

function Normalize-Cpu {
    param([string]$Raw)
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $s = $Raw
    $s = $s -replace '\((R|TM|C|r|tm)\)', ''
    $s = $s -replace '\s+CPU\s*@.*$', ''
    $s = $s -replace '\s+@.*$', ''
    $s = $s -replace '\s+with\s+Radeon.*$', ''
    $s = $s -replace '\s+\d+-Core\s+Processor.*$', ''
    $s = $s -replace '\s+Processor$', ''
    $s = $s -replace '^\s*\d+(st|nd|rd|th)\s+Gen\s+', ''
    $s = ($s -replace '\s+', ' ').Trim()

    # Most specific first. Each returns the shape a lister would actually type.
    if ($s -match '\b(i[3579]-[0-9]{4,5}[A-Za-z]{0,3})\b')      { return $Matches[1] }
    if ($s -match '\bUltra\s+([3579])\s+([0-9]{3}[A-Za-z]{0,2})') { return "Core Ultra $($Matches[1]) $($Matches[2])" }
    if ($s -match '\b(Ryzen\s+[3579]\s+PRO\s+[0-9]{4}[A-Za-z]{0,3})\b') { return $Matches[1] }
    if ($s -match '\b(Ryzen\s+[3579]\s+[0-9]{4}[A-Za-z]{0,3})\b') { return $Matches[1] }
    if ($s -match '\b(Ryzen\s+(?:Threadripper|AI)\s+[\w\s]+?[0-9]{4}\w*)\b') { return $Matches[1].Trim() }
    if ($s -match '\bXeon\b')    { return ($s -replace '^Intel\s+', '').Trim() }
    if ($s -match '\b(Celeron|Pentium|Athlon)\b') { return ($s -replace '^(Intel|AMD)\s+', '').Trim() }
    return $s
}

# A discrete GPU is a selling point and belongs in the title. An integrated one
# is noise -- every machine has one. Splitting them here means the pricing sheet
# only ever shows a dGPU in the GPU box, which is what that column is for.
function Test-DiscreteGpu {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    # Strip (R)/(TM) BEFORE matching anything. Vendors put them mid-name --
    # "Intel(R) Arc(TM) A770 Graphics", "AMD Radeon(TM) Graphics" -- which breaks
    # every \b...\b test below that expects the words to be adjacent. "Arc A770"
    # was being read as integrated because of the (TM) between the two halves,
    # and the integrated denylist was missing "Radeon(TM) Graphics" for the same
    # reason (it only returned false by falling off the end, not by matching).
    $n = (($Name -replace '\((R|TM|C|r|tm)\)', ' ') -replace '\s+', ' ').Trim()
    if ($n -match '(?i)\b(UHD|Iris|HD Graphics|Vega|Radeon Graphics|Microsoft Basic|Remote Display|Meta Virtual|Parsec|DisplayLink)\b') { return $false }
    # Intel Arc is two different things wearing one name, so it cannot sit in the
    # list below. The A- and B-series are real cards; "Arc 130V" / "Arc 140V"
    # (Lunar Lake) and bare "Arc Graphics" (Meteor Lake) are the integrated GPU on
    # the CPU package. Only a letter-and-number model is discrete. This machine
    # reports "Intel(R) Arc(TM) 130V GPU (8GB)" and was being sold as having a
    # dedicated GPU it does not have.
    if ($n -match '(?i)\bArc\b') { return [bool]($n -match '(?i)\bArc\s+[AB]\d{3}\b') }
    if ($n -match '(?i)\b(GeForce|RTX|GTX|Quadro|NVIDIA|Radeon (RX|Pro|R[579])|FirePro)\b') { return $true }
    return $false
}

function Normalize-Gpu {
    param([string]$Raw)
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $s = $Raw -replace '\((R|TM|C|r|tm)\)', ''
    $s = $s -replace '(?i)\s+Laptop GPU$', ''
    $s = $s -replace '(?i)\s+with Max-Q.*$', ''
    $s = ($s -replace '\s+', ' ').Trim()
    # Built up from the captured groups, NOT by chaining -replace. The previous
    # version passed a scriptblock to -replace, which is a [Regex]::Replace
    # feature and not a PowerShell operator feature -- the operator stringifies
    # it, so every discrete NVIDIA card came out as the literal text of the
    # scriptblock followed by its number:
    #     " $args[0].Value.ToUpper().Trim() + ' ' 3060"
    # That went into the gpu field, onto the quote and into the eBay query, and
    # nothing failed loudly enough to notice. Found by Haydn's
    # lib\Test-Normalizers.ps1, which pins this as a named case; the shape below
    # is his.
    if ($s -match '(?i)\b(RTX|GTX)\s*([A-Z]?[0-9]{3,4})\s*(Ti\s*SUPER|SUPER|Ti)?\b') {
        $pre = $Matches[1].ToUpper()
        $num = $Matches[2].ToUpper()
        $suf = ''
        if ($Matches[3]) {
            $t = ($Matches[3] -replace '\s+', ' ').Trim()
            if     ($t -match '(?i)^ti\s*super$') { $suf = ' Ti SUPER' }
            elseif ($t -match '(?i)^super$')      { $suf = ' SUPER' }
            elseif ($t -match '(?i)^ti$')         { $suf = ' Ti' }
        }
        return "$pre $num$suf"
    }
    if ($s -match '(?i)\b(Radeon\s+(?:RX|Pro)\s+[\w\s]+?[0-9]{3,4}\w*)\b') { return $Matches[1].Trim() }
    if ($s -match '(?i)\b(Quadro\s+[\w]+)\b') { return $Matches[1] }
    if ($s -match '(?i)\b(Arc\s+[\w]+)\b')    { return $Matches[1] }
    return ($s -replace '(?i)^NVIDIA\s+', '' -replace '(?i)^GeForce\s+', 'GeForce ').Trim()
}

# Bytes -> the way a listing says it. 512110190592 is "512GB", not "476.9 GiB":
# nobody searches eBay for 476.9.
function Format-Capacity {
    param([double]$Bytes)
    if ($Bytes -le 0) { return $null }
    $gb = $Bytes / 1e9
    # Tier list and the 6% tolerance are Haydn's, from lib\SpecRead.ps1 in his
    # b2b-pickup build. Mine was too sparse and quietly rounded real sizes to the
    # wrong neighbour: a 120GB SSD read 128GB, a 600GB SAS read 640GB, and an
    # 800GB read 750GB. A denser list with a tighter tolerance fixes those and
    # leaves an odd enterprise size (a genuine 400GB SSD) alone rather than
    # rounding it into a marketing number it never had.
    #
    # 960 is deliberately ABSENT, and that is a LISTING decision, not a technical
    # one. We sell that class as 1TB and never as 960GB, so a 960GB drive must
    # snap up rather than find a tier of its own: 960.2 is 4% off 1000, inside
    # the tolerance below. Adding 960 here would be more accurate about the
    # hardware and wrong about the product.
    $tiers = @(16, 32, 64, 120, 128, 160, 180, 200, 240, 250, 256, 320, 400, 480, 500, 512,
               600, 640, 750, 800, 1000, 1024, 1200, 1500, 1600, 2000, 2048, 3000,
               4000, 4096, 6000, 8000, 12000, 16000)
    # The NEAREST marketing size, not the first one within 8%. Several tiers sit
    # closer together than the tolerance -- 480/500/512, 240/250/256, 1000/1024 --
    # so scanning ascending and returning the first match under the threshold
    # always answered with the SMALLER of the pair: a 512GB drive is 512.1
    # decimal GB, which is 6.7% from 480, so it read "480GB". Same for 256 -> 240.
    # Those are the two commonest laptop SSDs, and the wrong number went onto the
    # client quote and into the eBay comp search, where it prices against the
    # wrong machine. Comparing every tier and keeping the closest costs nothing
    # and cannot pick a neighbour over an exact match.
    $best = $null
    $bestRel = [double]::PositiveInfinity
    foreach ($t in $tiers) {
        $rel = [math]::Abs($gb - $t) / $t
        if ($rel -lt $bestRel) { $bestRel = $rel; $best = $t }
    }
    # Within 6% of a marketing size means it IS that size. Tighter than the 8%
    # this used, because the list above is now dense enough that 8% could reach
    # past a true neighbour.
    if ($null -ne $best -and $bestRel -le 0.06) {
        if ($best -ge 1000) { return ('{0:0.#}TB' -f ($best / 1000.0)) }
        return "${best}GB"
    }
    if ($gb -ge 1000) { return ('{0:0.#}TB' -f ($gb / 1000.0)) }
    return ('{0:0}GB' -f $gb)
}

# Panels report physical size in centimetres over WMI. Laptop panels come in a
# small set of sizes, so the raw diagonal is snapped to the nearest real one --
# a 15.6" panel measures 15.58" and must not print as 15.6" on one unit and
# 15.5" on the next, or two identical machines become two line items.
# Which WMI monitor is the machine's OWN screen.
#
# This exists because a docked bench lies. WmiMonitorBasicDisplayParams answers
# for every attached display, and taking the first one meant a laptop plugged
# into a monitor reported the MONITOR: a 14" OmniBook captured on a dock came out
# as 27.2", and that figure went onto the listing. The failure is worse than a
# missing value because it is confident -- null is handled everywhere downstream,
# a plausible wrong number is not.
#
# VideoOutputTechnology 0x80000000 (2147483648) is D3DKMDT_VOT_INTERNAL. Some
# makers report the embedded DisplayPort (11) or embedded UDI (13) variants
# instead, so all three count as internal.
#
# Returns the InstanceName, which is the key back into the other monitor classes.
function Get-InternalPanelInstance {
    $conn = @(Get-Safe {
        Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams -ErrorAction Stop
    } @())
    foreach ($c in $conn) {
        $tech = Get-Safe { [uint32]$c.VideoOutputTechnology } 0
        if ($tech -eq 2147483648 -or $tech -eq 11 -or $tech -eq 13) {
            return [string]$c.InstanceName
        }
    }
    return $null
}

# The internal panel's EDID, straight out of the registry.
#
# Needed because WmiMonitorBasicDisplayParams only answers for panels that are
# CURRENTLY ON. Dock a laptop and shut the lid -- which is how a bench actually
# runs -- and the internal panel drops out of that class entirely while the two
# external monitors remain, so there is nothing to match the internal instance
# against and the panel reads as unknown. Windows caches each display's EDID
# under Enum\DISPLAY regardless, so the physical size survives the lid being
# closed. Verified on this machine docked to two 27" Dells: WMI offered only the
# Dells, the registry still said 30x19cm / 1920x1200.
#
# InstanceName from WmiMonitorConnectionParams looks like
#   DISPLAY\BOE0D59\4&23d45159&0&UID8388688_0
# and the registry key drops that trailing _<n>.
function Get-PanelFromEdid {
    param([string]$InstanceName)
    if ([string]::IsNullOrWhiteSpace($InstanceName)) { return $null }
    $parts = $InstanceName -split '\\'
    if ($parts.Count -lt 3) { return $null }
    $monitorId = $parts[1]
    $instKey   = $parts[2] -replace '_\d+$', ''
    $path = "HKLM:\SYSTEM\CurrentControlSet\Enum\DISPLAY\$monitorId\$instKey\Device Parameters"
    $edid = Get-Safe { (Get-ItemProperty -Path $path -Name EDID -ErrorAction Stop).EDID }
    if (-not $edid -or $edid.Length -lt 62) { return $null }
    # Header must be 00 FF FF FF FF FF FF 00, or it is not an EDID block.
    if ($edid[0] -ne 0 -or $edid[1] -ne 255 -or $edid[7] -ne 0) { return $null }

    $hCm = [int]$edid[21]; $vCm = [int]$edid[22]
    $sizeIn = $null
    if ($hCm -gt 0 -and $vCm -gt 0) { $sizeIn = Get-PanelSize ([double]$hCm) ([double]$vCm) }

    # First detailed timing descriptor starts at 0x36; the active-pixel counts are
    # split across a low byte and the high nibble of a shared byte.
    $w = [int]$edid[56] + ((([int]$edid[58]) -band 0xF0) -shl 4)
    $h = [int]$edid[59] + ((([int]$edid[61]) -band 0xF0) -shl 4)
    if ($w -le 0 -or $h -le 0) { $w = $null; $h = $null }

    if (-not $sizeIn -and -not $w) { return $null }
    return [ordered]@{ size_in = $sizeIn; width = $w; height = $h; source = 'edid-registry' }
}

function Get-PanelSize {
    param([double]$WidthCm, [double]$HeightCm)
    if ($WidthCm -le 0 -or $HeightCm -le 0) { return $null }
    $inches = [math]::Sqrt(($WidthCm * $WidthCm) + ($HeightCm * $HeightCm)) / 2.54
    $common = @(10.1, 11.6, 12.3, 12.4, 12.5, 13.0, 13.3, 13.4, 13.5, 13.6, 14.0, 14.2, 15.0, 15.6, 16.0, 16.2, 17.0, 17.3, 18.0)
    $best = $null; $bestGap = 999.0
    foreach ($c in $common) {
        $gap = [math]::Abs($inches - $c)
        if ($gap -lt $bestGap) { $bestGap = $gap; $best = $c }
    }
    if ($bestGap -le 0.45) { return $best }
    return [math]::Round($inches, 1)
}

# ------------------------------------------------------------------- the read

Write-Host ''
Write-Host '  SPEEKS B2B Capture' -ForegroundColor Green -NoNewline
Write-Host "  v$ToolVersion" -ForegroundColor DarkGray
Write-Host '  Reading this machine...' -ForegroundColor DarkGray

$bios     = Get-Safe { Get-CimInstance Win32_BIOS -ErrorAction Stop }
$sys      = Get-Safe { Get-CimInstance Win32_ComputerSystem -ErrorAction Stop }
$prod     = Get-Safe { Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop }
$encl     = Get-Safe { Get-CimInstance Win32_SystemEnclosure -ErrorAction Stop }
$os       = Get-Safe { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop }
$cpus     = @(Get-Safe { Get-CimInstance Win32_Processor -ErrorAction Stop } @())
$mem      = @(Get-Safe { Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop } @())
$memArray = Get-Safe { Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction Stop | Select-Object -First 1 }
$vids     = @(Get-Safe { Get-CimInstance Win32_VideoController -ErrorAction Stop } @())

# --- identity -------------------------------------------------------------
$serial = Get-Safe { ([string]$bios.SerialNumber).Trim() }
if ([string]::IsNullOrWhiteSpace($serial) -or $serial -match '(?i)^(to be filled|system serial|default string|none|0+)$') {
    $serial = Get-Safe { ([string]$encl.SerialNumber).Trim() }
}
if ([string]::IsNullOrWhiteSpace($serial)) { $serial = 'NO-SERIAL' }

$make  = Get-Safe { ([string]$sys.Manufacturer).Trim() }
$model = Get-Safe { ([string]$sys.Model).Trim() }

# Lenovo is the odd one out and it is most of the fleet: Win32_ComputerSystem
# .Model holds the MTM ("82TF000RUS") and the human name ("Legion S7 16IAH7")
# lives on Win32_ComputerSystemProduct.Version. Every other maker puts the
# friendly name in .Model. Handled here rather than at collation time so the
# JSON is already right when Nick reads it.
$modelCode = $model
if ($make -match '(?i)lenovo') {
    $friendly = Get-Safe { ([string]$prod.Version).Trim() }
    if ($friendly -and $friendly -notmatch '(?i)^(none|default string|system version|lenovo product)$') {
        $model = $friendly
    }
}
$make = switch -Regex ($make) {
    '(?i)^lenovo'            { 'Lenovo';    break }
    '(?i)^hewlett|^hp\b'     { 'HP';        break }
    '(?i)^dell'              { 'Dell';      break }
    '(?i)^microsoft'         { 'Microsoft'; break }
    '(?i)^asus'              { 'ASUS';      break }
    '(?i)^acer'              { 'Acer';      break }
    '(?i)^apple'             { 'Apple';     break }
    '(?i)^toshiba|^dynabook' { 'Dynabook';  break }
    default                  { $make }
}

# Most makers repeat themselves: Win32_ComputerSystem.Model comes back as
# "HP OmniBook X Flip Laptop 14-fm0xxx", make and all. Brand and Model are
# separate columns on the pricing sheet, so the brand was being stored twice and
# every generated eBay query led with "HP HP OmniBook ...", which is not a phrase
# any buyer has ever typed and costs comps. Stripped after the switch above so it
# is the NORMALISED make being removed ("Hewlett-Packard" having already become
# "HP"). Kept as-is if removing it would leave the model empty -- a machine whose
# model really is just its brand name is worth less than a blank field.
if ($make -and $model) {
    $stripped = ($model -replace ('(?i)^\s*' + [regex]::Escape($make) + '\s+'), '').Trim()
    if ($stripped) { $model = $stripped }
}

# Makers pad the model with words that carry no information here.
# "HP OmniBook X Flip Laptop 14-fm0xxx" is 35 characters, of which "HP" repeats
# the Brand column and "Laptop" repeats item_type -- and the Model column on the
# pricing sheet can squeeze to 74px, so the padding is what pushes the part you
# actually need off the end of the cell. "15.6 inch" goes too: the panel is its
# own field, measured off the EDID rather than trusted from a marketing string.
#
# Only ever removed from the ENDS or as whole redundant words, never from the
# middle of a name, and never if it would empty the field.
$modelNoise = @(
    '(?i)\s+(Laptop|Notebook|Notebook\s+PC|Desktop\s+PC|Tablet\s+PC|All-in-One)\s+PC\b',
    '(?i)\s+(Laptop|Notebook\s+PC|Notebook|Desktop\s+PC|Tablet\s+PC)\b',
    '(?i)\s+\d{1,2}(\.\d)?\s*(inch|in\.?|")\b',
    '(?i)\s+\(?(PC|Computer)\)?$'
)
# Names where the "noise" word is the product, not padding. Microsoft's line IS
# "Surface Laptop", and trimming it yields "Surface 4", which is not a machine
# anybody sells. Framework's "Laptop 13" survives on its own because the rules
# above all require whitespace before the word, so a leading one is never
# matched -- but Surface is mid-string and needs saying out loud. Parked behind
# a placeholder for the duration of the trim and put back after.
$modelKeep = @('Surface Laptop Studio', 'Surface Laptop Go', 'Surface Laptop',
               'Surface Book', 'Notebook 9')
if ($model) {
    $trimmed = $model
    $parked = @{}
    for ($k = 0; $k -lt $modelKeep.Count; $k++) {
        $token = "@@K$k@@"
        if ($trimmed -match ('(?i)' + [regex]::Escape($modelKeep[$k]))) {
            $parked[$token] = [regex]::Match($trimmed, '(?i)' + [regex]::Escape($modelKeep[$k])).Value
            $trimmed = [regex]::Replace($trimmed, '(?i)' + [regex]::Escape($modelKeep[$k]), $token)
        }
    }
    foreach ($rx in $modelNoise) { $trimmed = ($trimmed -replace $rx, ' ') }
    foreach ($token in $parked.Keys) { $trimmed = $trimmed.Replace($token, $parked[$token]) }
    $trimmed = ($trimmed -replace '\s+', ' ').Trim()
    if ($trimmed) { $model = $trimmed }
}

# --- laptop or desktop ----------------------------------------------------
# Drives which spec fields are even allowed on the line: the table CHECK
# refuses battery_health on a desktop and refuses every spec on `other`.
$chassis = @(Get-Safe { $encl.ChassisTypes } @())
$itemType = 'other'
if ($chassis | Where-Object { $_ -in 8,9,10,11,12,14,18,21,30,31,32 }) { $itemType = 'laptop' }
elseif ($chassis | Where-Object { $_ -in 3,4,5,6,7,13,15,16,17,23,24,35 }) { $itemType = 'desktop' }
elseif ($null -ne $sys -and $sys.PCSystemType -eq 2) { $itemType = 'laptop' }
elseif ($null -ne $sys) { $itemType = 'desktop' }

# --- cpu ------------------------------------------------------------------
$cpuRaw  = Get-Safe { ([string]$cpus[0].Name).Trim() }
$cpuNorm = Normalize-Cpu $cpuRaw
$cpuCores = Get-Safe { [int]$cpus[0].NumberOfCores }

# --- memory ---------------------------------------------------------------
$ramBytes = 0
$sticks = @()
foreach ($m in $mem) {
    $cap = Get-Safe { [double]$m.Capacity } 0
    $ramBytes += $cap
    $sticks += [ordered]@{
        # 1GB, not 1e9 -- see the note on $ramGb below. A 16GiB stick divided by
        # 1e9 reports 17.
        size_gb = [math]::Round($cap / 1GB)
        speed   = Get-Safe { [int]$m.ConfiguredClockSpeed } (Get-Safe { [int]$m.Speed })
        slot    = Get-Safe { [string]$m.DeviceLocator }
    }
}
# Soldered memory sometimes reports nothing per-module. TotalPhysicalMemory is
# what the OS actually sees and is the honest fallback -- a Lenovo with 8GB
# soldered plus 8GB in a slot must read 16GB, not 8GB.
if ($ramBytes -le 0) { $ramBytes = Get-Safe { [double]$sys.TotalPhysicalMemory } 0 }
# Memory is binary and is sold that way -- 32GB of RAM is 34,359,738,368 bytes,
# not 32,000,000,000. Storage is the opposite (see Format-Capacity), which is why
# these two divide by different constants; it looks like an inconsistency and is
# not one. PowerShell's 1GB is 1073741824.
#
# This divided by 1e9 and read 34GB on a 32GB machine. The snap below hid it up
# to 16GB -- 16GiB/1e9 = 17.18, and |17-16| is within the +/-1 tolerance -- so the
# bug only ever showed on 24GB and above, where nobody had thought to look:
# 24->26, 32->34, 48->52, 64->69. RAM is one of the three specs pricing requires
# and it goes into the eBay query, where "34GB" matches nothing real.
$ramGb = [math]::Round($ramBytes / 1GB)
# Now a safety net for an odd reserve carve-out rather than the thing holding the
# number up: a correct division lands on the tier exactly.
# Nearest tier by RELATIVE gap, over the sizes memory actually ships in. The
# old +/-1 absolute snap was too tight at the top (a 512GB server is 3 off its
# tier after an iGPU carve-out and would not snap) and the list was missing
# 2/6/20/36/40/192/256/384/512 entirely. List and 6% are Haydn's.
$ramBest = $null; $ramGap = [double]::MaxValue
foreach ($t in @(2,4,6,8,12,16,20,24,32,36,40,48,64,96,128,192,256,384,512)) {
    $g = [math]::Abs($ramGb - $t) / $t
    if ($g -lt $ramGap) { $ramGap = $g; $ramBest = $t }
}
if ($null -ne $ramBest -and $ramGap -le 0.06) { $ramGb = [int]$ramBest }
$ramText = if ($ramGb -gt 0) { "${ramGb}GB" } else { $null }

# --- storage --------------------------------------------------------------
# Get-PhysicalDisk knows SSD from HDD; Win32_DiskDrive does not, and the
# difference is worth real money on a listing. Falls back where the module is
# absent (it is not, on any supported Windows, but a freshly imaged machine has
# surprised me before).
$disks = @()
$diskBytes = 0
$rawDisks = @(Get-Safe { Get-PhysicalDisk -ErrorAction Stop | Where-Object { $_.BusType -ne 'USB' } } @())
if ($rawDisks.Count -gt 0) {
    foreach ($d in $rawDisks) {
        $sz = Get-Safe { [double]$d.Size } 0
        $diskBytes += $sz
        $disks += [ordered]@{
            size    = Format-Capacity $sz
            media   = Get-Safe { [string]$d.MediaType }
            bus     = Get-Safe { [string]$d.BusType }
            health  = Get-Safe { [string]$d.HealthStatus }
            model   = Get-Safe { ([string]$d.FriendlyName).Trim() }
        }
    }
} else {
    foreach ($d in @(Get-Safe { Get-CimInstance Win32_DiskDrive -ErrorAction Stop | Where-Object { $_.InterfaceType -ne 'USB' } } @())) {
        $sz = Get-Safe { [double]$d.Size } 0
        $diskBytes += $sz
        $disks += [ordered]@{ size = Format-Capacity $sz; media = $null; bus = Get-Safe { [string]$d.InterfaceType }; health = $null; model = Get-Safe { ([string]$d.Model).Trim() } }
    }
}
$storageText = Format-Capacity $diskBytes
$storageKind = if ($disks | Where-Object { $_.media -match '(?i)SSD' }) { 'SSD' }
               elseif ($disks | Where-Object { $_.media -match '(?i)HDD' }) { 'HDD' }
               else { $null }
if ($storageText -and $storageKind) { $storageText = "$storageText $storageKind" }

# --- graphics -------------------------------------------------------------
$dGpuRaw = $null; $iGpuRaw = $null
foreach ($v in $vids) {
    $n = Get-Safe { ([string]$v.Name).Trim() }
    if (-not $n) { continue }
    if (Test-DiscreteGpu $n) { if (-not $dGpuRaw) { $dGpuRaw = $n } }
    elseif (-not $iGpuRaw)   { $iGpuRaw = $n }
}
$gpuNorm = if ($dGpuRaw) { Normalize-Gpu $dGpuRaw } else { $null }

# --- panel ----------------------------------------------------------------
$screenText = $null; $screenDetail = $null
if ($itemType -eq 'laptop') {
    # The machine's own panel, never whatever it is docked to. See
    # Get-InternalPanelInstance.
    $panels = @(Get-Safe { Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction Stop } @())
    $panelName = Get-InternalPanelInstance
    $panel = $null
    if ($panelName) {
        $panel = $panels | Where-Object { [string]$_.InstanceName -eq $panelName } | Select-Object -First 1
    }
    # No connection data at all (a VM, an old driver). One attached display on a
    # laptop is the laptop's own, so that case is still safe to read. Two or more
    # and there is nothing to tell them apart -- report nothing rather than guess,
    # because collation treats a null panel as "unknown" and a wrong one as fact.
    if (-not $panel -and $panels.Count -eq 1) {
        $panel = $panels[0]
        $panelName = [string]$panels[0].InstanceName
    }
    $sizeIn = $null
    if ($panel) { $sizeIn = Get-PanelSize ([double]$panel.MaxHorizontalImageSize) ([double]$panel.MaxVerticalImageSize) }

    # Docked with the lid shut: the internal panel is known by name but absent
    # from the WMI class above, so read its cached EDID instead. This is the
    # normal bench case, not an edge case.
    $edidPanel = $null
    if (-not $sizeIn -and $panelName) {
        $edidPanel = Get-PanelFromEdid $panelName
        if ($edidPanel) { $sizeIn = $edidPanel.size_in }
    }

    # NATIVE resolution off the panel's own EDID, not the adapter's current mode.
    # The current mode is whatever the machine happens to be driving right now,
    # which on a dock is the external monitor -- the same lie as the panel size,
    # and the reason the OmniBook read 1920x1080 when its panel is 1920x1200.
    $resW = $null; $resH = $null
    if ($panelName) {
        $modes = Get-Safe {
            Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorListedSupportedSourceModes -ErrorAction Stop |
                Where-Object { [string]$_.InstanceName -eq $panelName } | Select-Object -First 1
        }
        if ($modes) {
            $pref = Get-Safe { $modes.MonitorSourceModes[$modes.PreferredMonitorSourceModeIndex] }
            if ($pref) {
                $resW = Get-Safe { [int]$pref.HorizontalActivePixels }
                $resH = Get-Safe { [int]$pref.VerticalActivePixels }
            }
        }
    }
    # The same cached EDID carries the native mode, and it is the internal
    # panel's own -- so it beats the adapter's current mode, which on a dock
    # belongs to whichever monitor is driving.
    if ((-not $resW -or -not $resH) -and $edidPanel -and $edidPanel.width) {
        $resW = $edidPanel.width; $resH = $edidPanel.height
    }
    # Last resort: the adapter's current mode, and only when a single display is
    # attached, where it cannot be the wrong one.
    if ((-not $resW -or -not $resH) -and $panels.Count -le 1) {
        $resW = Get-Safe { [int]($vids | Where-Object { $_.CurrentHorizontalResolution } | Select-Object -First 1).CurrentHorizontalResolution }
        $resH = Get-Safe { [int]($vids | Where-Object { $_.CurrentVerticalResolution }   | Select-Object -First 1).CurrentVerticalResolution }
    }
    $touch = [bool](Get-Safe { Get-CimInstance Win32_PnPEntity -ErrorAction Stop | Where-Object { $_.Name -match '(?i)touch screen|touchscreen' } | Select-Object -First 1 })
    $bits = @()
    if ($sizeIn) { $bits += ('{0}"' -f $sizeIn) }
    if ($resW -and $resH) { $bits += "${resW}x${resH}" }
    $bits += $(if ($touch) { 'touch' } else { 'non-touch' })
    if ($bits.Count -gt 1) { $screenText = ($bits -join ' ') }
    $screenDetail = [ordered]@{ size_in = $sizeIn; width = $resW; height = $resH; touch = $touch }
}

# --- battery --------------------------------------------------------------
# Design capacity vs what it will actually hold now. This is the single number
# that decides whether a laptop lists as-is or needs a battery noted, and the
# vendor lookup can never tell you it.
$batteryText = $null; $batteryDetail = $null
if ($itemType -eq 'laptop') {
    $full   = Get-Safe { Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity -ErrorAction Stop | Select-Object -First 1 }
    $static = Get-Safe { Get-CimInstance -Namespace root\wmi -ClassName BatteryStaticData        -ErrorAction Stop | Select-Object -First 1 }
    $design = Get-Safe { [double]$static.DesignedCapacity } 0
    $now    = Get-Safe { [double]$full.FullChargedCapacity } 0
    if ($design -gt 0 -and $now -gt 0) {
        $pct = [math]::Round(($now / $design) * 100)
        if ($pct -gt 0 -and $pct -le 200) {
            $batteryText = "$pct%"
            $batteryDetail = [ordered]@{ percent = $pct; design_mwh = [int]$design; full_mwh = [int]$now }
        }
    }
    if (-not $batteryText) {
        $b = Get-Safe { Get-CimInstance Win32_Battery -ErrorAction Stop | Select-Object -First 1 }
        if (-not $b) { $batteryText = 'no battery detected' }
    }
}

# --- windows --------------------------------------------------------------
$winEdition = Get-Safe { ([string]$os.Caption).Trim() -replace '(?i)^Microsoft\s+', '' }
# BootTool already reads this from the ACPI MSDM table during imaging. Worth
# carrying: a machine with an embedded OEM key lists as licensed.
$oemKey = Get-Safe { ([string](Get-CimInstance -ClassName SoftwareLicensingService -ErrorAction Stop).OA3xOriginalProductKey).Trim() }

# ------------------------------------------------------------------- display

Write-Head "$make $model"
Write-Field 'Serial'    $serial 'Yellow'
Write-Field 'Type'      $itemType
Write-Field 'CPU'       $cpuNorm 'Green'
Write-Field 'RAM'       $ramText 'Green'
Write-Field 'Storage'   $storageText 'Green'
Write-Field 'GPU'       $(if ($gpuNorm) { $gpuNorm } else { '(integrated only)' })
if ($itemType -eq 'laptop') {
    Write-Field 'Screen'  $screenText
    Write-Field 'Battery' $batteryText
}
Write-Field 'Windows'   $winEdition
Write-Field 'OEM key'   $(if ($oemKey) { 'embedded' } else { $null })

# Loud, because a line with no CPU/RAM/storage is refused by submit_pricing and
# you want to know that here, at the bench, not two hours later in the sheet.
$missing = @()
if (-not $cpuNorm)     { $missing += 'CPU' }
if (-not $ramText)     { $missing += 'RAM' }
if (-not $storageText) { $missing += 'storage' }
if ($missing.Count -gt 0 -and $itemType -ne 'other') {
    Write-Host ''
    Write-Host "    !! Missing $($missing -join ', ') -- SPEEKSnet will refuse to submit this line." -ForegroundColor Red
    Write-Host '       Fill it in by hand at pricing, or re-run after drivers finish.' -ForegroundColor DarkYellow
}

# ------------------------------------------------------------------ the human

$condition = $null; $wipe = $false; $notes = ''
if (-not $NoPrompt) {
    $conditions = @('New', 'Like New', 'Good', 'Fair', 'Broken', 'For Parts')
    Write-Head 'Condition'
    for ($i = 0; $i -lt $conditions.Count; $i++) {
        Write-Host ("    [{0}] {1}" -f ($i + 1), $conditions[$i])
    }
    while (-not $condition) {
        $pick = Read-Host '    Number'
        $n = 0
        if ([int]::TryParse($pick, [ref]$n) -and $n -ge 1 -and $n -le $conditions.Count) { $condition = $conditions[$n - 1] }
        else { Write-Host '    Pick a number from the list.' -ForegroundColor DarkYellow }
    }
    # Broken and For Parts print a reason on the client's quote, and the edge
    # function refuses the line without one. Asked here so it is never the thing
    # that stops a submit later.
    if ($condition -in @('Broken', 'For Parts')) {
        Write-Host ''
        Write-Host '    This condition needs a client-facing reason (it prints on the quote).' -ForegroundColor DarkYellow
        $clientNote = Read-Host '    Reason'
    } else { $clientNote = '' }

    Write-Head 'Certified wipe'
    $w = Read-Host '    Does this need a certified data wipe? [y/N]'
    $wipe = ($w -match '(?i)^y')

    Write-Head 'Notes'
    Write-Host '    Anything else worth recording. Blank is fine.' -ForegroundColor DarkGray
    $notes = Read-Host '    Notes'
} else { $clientNote = '' }

# ------------------------------------------------------------------- writing

if (-not $OutDir) {
    $OutDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
}
$captureDir = Join-Path $OutDir 'captures'
if (-not (Test-Path $captureDir)) { New-Item -ItemType Directory -Path $captureDir -Force | Out-Null }

$safeSerial = ($serial -replace '[^A-Za-z0-9._-]', '_')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$record = [ordered]@{
    schema         = 'speeks.b2b.capture/1'
    tool_version   = $ToolVersion
    captured_at    = (Get-Date).ToString('o')
    captured_on    = $env:COMPUTERNAME

    serial         = $serial
    make           = $make
    model          = $model
    model_code     = $modelCode
    item_type      = $itemType

    cpu            = $cpuNorm
    ram            = $ramText
    storage        = $storageText
    gpu            = $gpuNorm
    battery_health = $batteryText

    condition      = $condition
    wipe_required  = $wipe
    staff_notes    = $notes
    client_notes   = $clientNote

    detail = [ordered]@{
        cpu_raw        = $cpuRaw
        cpu_cores      = $cpuCores
        gpu_raw        = $dGpuRaw
        igpu_raw       = $iGpuRaw
        ram_bytes      = [int64]$ramBytes
        ram_sticks     = $sticks
        ram_slots      = Get-Safe { [int]$memArray.MemoryDevices }
        storage_bytes  = [int64]$diskBytes
        disks          = $disks
        screen         = $screenDetail
        screen_text    = $screenText
        battery        = $batteryDetail
        windows        = $winEdition
        oem_key_present= [bool]$oemKey
        chassis_types  = $chassis
        missing_specs  = $missing
    }
}

$jsonPath = Join-Path $captureDir "$safeSerial.json"
# A re-test of the same unit should replace its record, not sit beside it as a
# second line item. Same serial, same file, last read wins.
$record | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonPath -Encoding UTF8

Write-Host ''
Write-Host '    Saved  ' -NoNewline -ForegroundColor DarkGray
Write-Host $jsonPath -ForegroundColor Green

if ($Screenshot) {
    try {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
        $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
        $shotPath = Join-Path $captureDir "$safeSerial-$stamp.png"
        $bmp.Save($shotPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Host '    Shot   ' -NoNewline -ForegroundColor DarkGray
        Write-Host $shotPath -ForegroundColor DarkGreen
    } catch {
        Write-Host "    Screenshot failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

# Best-effort second copy. The local write above has already succeeded, so a
# dead share or a machine with no network costs you nothing but a warning.
if ($AlsoCopyTo) {
    try {
        if (-not (Test-Path $AlsoCopyTo)) { New-Item -ItemType Directory -Path $AlsoCopyTo -Force -ErrorAction Stop | Out-Null }
        Copy-Item -Path $jsonPath -Destination (Join-Path $AlsoCopyTo "$safeSerial.json") -Force -ErrorAction Stop
        Write-Host '    Copied ' -NoNewline -ForegroundColor DarkGray
        Write-Host $AlsoCopyTo -ForegroundColor Green
    } catch {
        Write-Host "    Could not copy to $AlsoCopyTo -- the local copy is safe." -ForegroundColor DarkYellow
        Write-Host "      $($_.Exception.Message)" -ForegroundColor DarkGray
    }
}

# ------------------------------------------------------- live intake (opt-in)
#
# Runs LAST, after the USB copy is on disk and confirmed. Everything here is
# best-effort by design: this is a second destination, not the destination. A
# failure prints and the run still succeeds, because the capture is already
# safe and SPEEKS-Collate can still read it off the stick.
$deviceCfg = Get-DeviceConfig
$cfgDirty  = -not (Test-Path $DeviceConfigPath)   # a brand-new stick always saves

if ($DeviceLabel) { $deviceCfg.device_label = $DeviceLabel.Trim(); $cfgDirty = $true }
if ($NewSession)  { $deviceCfg.session_code = $null; $deviceCfg.session_saved_at = $null; $cfgDirty = $true }

# Precedence: what was passed in, then what the stick remembers, then ask.
# -NewSession forces the ask even though the stick had one.
$sessionCode = $Session
$fromStick   = $false
if (-not $sessionCode -and -not $NewSession -and $deviceCfg.session_code) {
    $sessionCode = $deviceCfg.session_code
    $fromStick   = $true
}
if (-not $sessionCode -and ($Live -or $NewSession)) {
    Write-Host ''
    Write-Host "  Stick $($deviceCfg.device_id)" -ForegroundColor DarkGray
    Write-Host '  Session code from the pricing sheet (Enter to skip): ' -NoNewline -ForegroundColor Cyan
    $sessionCode = (Read-Host).Trim()
}

# Remember it for the rest of the pallet. Only once it is known -- a blank
# answer must not wipe a code the stick was already carrying.
if ($sessionCode) {
    $sessionCode = $sessionCode.Trim().ToUpper()
    if ($deviceCfg.session_code -ne $sessionCode) {
        $deviceCfg.session_code     = $sessionCode
        $deviceCfg.session_saved_at = (Get-Date).ToString('o')
        $cfgDirty = $true
    }
}
if ($cfgDirty) { [void](Save-DeviceConfig $deviceCfg) }

if ($fromStick) {
    Write-Host ''
    Write-Host "    Stick   $($deviceCfg.device_id)$(if ($deviceCfg.device_label) { " ($($deviceCfg.device_label))" })" -ForegroundColor DarkGray
    Write-Host "    Session $sessionCode " -NoNewline -ForegroundColor DarkGray
    Write-Host 'remembered from this drive' -ForegroundColor DarkGreen
}

if ($sessionCode) {
    $sessionCode = $sessionCode.Trim().ToUpper()
    Write-Host ''
    Write-Host '    Sending' -NoNewline -ForegroundColor DarkGray
    Write-Host "  session $sessionCode" -ForegroundColor Cyan

    # A machine imaged twenty minutes ago can still default to TLS 1.0, which
    # Supabase refuses -- and the failure reads as "could not connect" rather
    # than anything about protocols. Set it explicitly.
    try {
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }

    # device_id rides on the record as well as the envelope, so the stored
    # payload can still answer "which stick" long after the row was promoted.
    $record.device_id    = $deviceCfg.device_id
    $record.device_label = $deviceCfg.device_label
    $payload = @{
        action       = 'submit'
        code         = $sessionCode
        device_id    = $deviceCfg.device_id
        device_label = $deviceCfg.device_label
        capture      = $record
    }
    # -Compress because the body travels over bench wifi, and UTF-8 bytes rather
    # than a string because Invoke-RestMethod on PS 5.1 will otherwise encode the
    # body as ISO-8859-1 and mangle any non-ASCII in a model name or a note.
    $bodyJson  = $payload | ConvertTo-Json -Depth 9 -Compress
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)

    # Three tries. Bench wifi drops, and a lost packet must not mean retyping a
    # machine -- but a REFUSED code is final, so that one stops immediately
    # instead of hammering the endpoint twice more for the same answer.
    $sent = $false
    for ($try = 1; $try -le 3 -and -not $sent; $try++) {
        try {
            $resp = Invoke-RestMethod -Uri $PostTo -Method Post -Body $bodyBytes `
                        -ContentType 'application/json; charset=utf-8' -TimeoutSec 20 -ErrorAction Stop
            if ($resp.success) {
                Write-Host '    Queued ' -NoNewline -ForegroundColor DarkGray
                Write-Host 'waiting for someone to accept it on the pricing sheet' -ForegroundColor Green
                $sent = $true
            } else {
                Write-Host "    Refused: $($resp.error)" -ForegroundColor Yellow
                break
            }
        } catch {
            # 403 is the closed/unknown-code answer and will not improve on a
            # retry. Anything else might.
            $status = $null
            try { $status = [int]$_.Exception.Response.StatusCode } catch { }
            if ($status -eq 403) {
                Write-Host '    Refused: that session is not open. Check the code on the sheet.' -ForegroundColor Yellow
                break
            }
            if ($try -lt 3) {
                Write-Host "    Attempt $try failed, retrying..." -ForegroundColor DarkYellow
                Start-Sleep -Seconds ($try * 2)
            } else {
                Write-Host '    Could not reach SPEEKSnet -- the USB copy is safe and collates as usual.' -ForegroundColor DarkYellow
                Write-Host "      $($_.Exception.Message)" -ForegroundColor DarkGray
            }
        }
    }
}

Write-Host ''
Write-Host '  Done. Next machine.' -ForegroundColor Green
Write-Host ''
if (-not $NoPrompt) { Read-Host '  Enter to close' | Out-Null }
