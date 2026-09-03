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
    [switch]$Live,

    # Override the endpoint. Only wanted for testing against a branch.
    [string]$PostTo = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/b2b-intake'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'
$ToolVersion = '0.1.0'

# Every probe below runs inside this. A machine with a dead battery, no
# discrete GPU, or a panel that reports no EDID must still produce a usable
# record for every OTHER field -- one missing value is a blank, not a failure.
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
    if ($Name -match '(?i)\b(UHD|Iris|HD Graphics|Vega|Radeon Graphics|Microsoft Basic|Remote Display|Meta Virtual|Parsec|DisplayLink)\b') { return $false }
    # Intel Arc is two different things wearing one name, so it cannot sit in the
    # list below. The A- and B-series are real cards; "Arc 130V" / "Arc 140V"
    # (Lunar Lake) and bare "Arc Graphics" (Meteor Lake) are the integrated GPU on
    # the CPU package. Only a letter-and-number model is discrete. This machine
    # reports "Intel(R) Arc(TM) 130V GPU (8GB)" and was being sold as having a
    # dedicated GPU it does not have.
    if ($Name -match '(?i)\bArc\b') { return [bool]($Name -match '(?i)\bArc\s+[AB]\d{3}\b') }
    if ($Name -match '(?i)\b(GeForce|RTX|GTX|Quadro|NVIDIA|Radeon (RX|Pro|R[579])|FirePro)\b') { return $true }
    return $false
}

function Normalize-Gpu {
    param([string]$Raw)
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $s = $Raw -replace '\((R|TM|C|r|tm)\)', ''
    $s = $s -replace '(?i)\s+Laptop GPU$', ''
    $s = $s -replace '(?i)\s+with Max-Q.*$', ''
    $s = ($s -replace '\s+', ' ').Trim()
    if ($s -match '(?i)\b((?:RTX|GTX)\s*[A-Z]?[0-9]{3,4}\s*(?:Ti|SUPER|Ti SUPER)?)\b') {
        return (($Matches[1] -replace '\s+', ' ').Trim() -replace '(?i)^(RTX|GTX)\s*', { $args[0].Value.ToUpper().Trim() + ' ' })
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
    $tiers = @(128, 240, 250, 256, 320, 480, 500, 512, 640, 750, 1000, 1024, 2000, 2048, 4000, 4096, 8000)
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
    # Within 8% of a marketing size means it IS that size.
    if ($null -ne $best -and $bestRel -lt 0.08) {
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
foreach ($t in @(4,8,12,16,24,32,48,64,96,128)) { if ([math]::Abs($ramGb - $t) -le 1) { $ramGb = $t; break } }
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
$sessionCode = $Session
if (-not $sessionCode -and $Live) {
    Write-Host ''
    Write-Host '  Session code from the pricing sheet (Enter to skip): ' -NoNewline -ForegroundColor Cyan
    $sessionCode = (Read-Host).Trim()
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

    $payload = @{ action = 'submit'; code = $sessionCode; capture = $record }
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
