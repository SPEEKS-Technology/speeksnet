#Requires -Version 5.1
<#
    SPEEKS B2B Collate  --  v0.1.0
    -------------------------------------------------------------------------
    Runs on Haydn's PC, not on the bench machines. Reads every capture JSON a
    batch produced, folds identical units into line items, orders them the way
    the pricing sheet wants to be worked, builds the eBay research links, and
    writes two files:

        batch.html   the review sheet -- what you actually work from
        batch.json   the same data shaped for b2b-deals `update_item`,
                     which is what Nick imports

    Zero-install by design, same as the capture side: Windows PowerShell 5.1.

    Usage:
        .\SPEEKS-Collate.ps1
        .\SPEEKS-Collate.ps1 -CaptureDir D:\captures -OutDir .\out -Client ACM
#>

[CmdletBinding()]
param(
    [string]$CaptureDir,
    [string]$OutDir,
    # Client acronym, only used to label the batch. SKUs are minted server-side
    # by b2b-deals on add_item, never here -- line numbering belongs to the deal.
    [string]$Client = '',
    [string]$BatchName = ''
)

$ErrorActionPreference = 'Continue'
$ToolVersion = '0.1.0'

if (-not $CaptureDir) {
    $root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    $CaptureDir = Join-Path $root 'captures'
}
if (-not $OutDir) {
    $OutDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
}
if (-not $BatchName) { $BatchName = 'Batch ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }

if (-not (Test-Path $CaptureDir)) {
    Write-Host "No capture folder at $CaptureDir" -ForegroundColor Red
    Write-Host 'Point -CaptureDir at the folder the USB wrote to.' -ForegroundColor DarkYellow
    exit 1
}

# ============================================================== sort settings
#
# This is the "taste" block. Everything about ordering is here so it can be
# rewritten without touching the rest of the file.
#
# IMPORTANT: this orders by a SPEC-STRENGTH proxy, not by offer. Offer does not
# exist yet at this point in the flow -- pricing happens after, in SPEEKSnet.
# The proxy exists so the sheet opens with the machines worth the most attention
# at the top, and so identical families sit together. Replace it with real offer
# once prices come back from the pricing pass.

$TypeOrder = @{ 'laptop' = 0; 'computer' = 1; 'desktop' = 2; 'other' = 9 }

# CPU class -> weight. Coarse on purpose: the difference between an i7 and an i5
# moves price hard, the difference between two i7s of the same generation does not.
function Get-CpuTier {
    param([string]$Cpu)
    if (-not $Cpu) { return 0 }
    switch -Regex ($Cpu) {
        '(?i)\bi9-|Ryzen 9|Ultra 9'            { return 9 }
        '(?i)\bi7-|Ryzen 7|Ultra 7|Xeon'       { return 7 }
        '(?i)\bi5-|Ryzen 5|Ultra 5'            { return 5 }
        '(?i)\bi3-|Ryzen 3|Ultra 3'            { return 3 }
        '(?i)Pentium|Celeron|Athlon|N[0-9]{4}' { return 1 }
        default                                { return 2 }
    }
}

# Generation, so a 13th-gen i5 outranks a 6th-gen i7 where it should.
function Get-CpuGen {
    param([string]$Cpu)
    if (-not $Cpu) { return 0 }
    if ($Cpu -match '(?i)\bi[3579]-([0-9]{2})[0-9]{3}[A-Za-z]*\b') { return [int]$Matches[1] }
    if ($Cpu -match '(?i)\bi[3579]-([0-9])[0-9]{3}[A-Za-z]*\b')    { return [int]$Matches[1] }
    if ($Cpu -match '(?i)Ryzen [3579] ([0-9])[0-9]{3}')            { return [int]$Matches[1] }
    if ($Cpu -match '(?i)Ultra [3579] ([0-9]{3})')                 { return 14 }
    return 0
}

function Get-SizeGb {
    param([string]$Text)
    if (-not $Text) { return 0 }
    if ($Text -match '(?i)([0-9.]+)\s*TB') { return [double]$Matches[1] * 1000 }
    if ($Text -match '(?i)([0-9.]+)\s*GB') { return [double]$Matches[1] }
    return 0
}

# The single number the sheet is ordered by. Weighted so the things that
# actually move resale price dominate: a discrete GPU first, then CPU class,
# then how recent the silicon is, then RAM, then storage as a tiebreak.
function Get-SpecRank {
    param($Item)
    $rank = 0.0
    if ($Item.gpu)                       { $rank += 4000 }
    if ($Item.gpu -match '(?i)RTX')      { $rank += 1500 }
    $rank += (Get-CpuTier $Item.cpu) * 300
    $rank += (Get-CpuGen  $Item.cpu) * 60
    $rank += (Get-SizeGb  $Item.ram) * 12
    $rank += (Get-SizeGb  $Item.storage) * 0.4
    if ($Item.condition -eq 'New')       { $rank += 600 }
    elseif ($Item.condition -eq 'Like New') { $rank += 400 }
    elseif ($Item.condition -eq 'Fair')  { $rank -= 400 }
    elseif ($Item.condition -in @('Broken','For Parts')) { $rank -= 3000 }
    return $rank
}

# "Legion S7 16IAH7" -> "Legion". Families group together in the sheet, and the
# family itself sorts by its best member, so all the Legions sit above all the
# ThinkPads when the best Legion beats the best ThinkPad.
function Get-Family {
    param([string]$Model, [string]$Make)
    if (-not $Model) { return $Make }
    $known = @('ThinkPad','ThinkBook','ThinkCentre','ThinkStation','IdeaPad','IdeaCentre','Legion','Yoga','Latitude','Inspiron','OptiPlex','Precision','Vostro','XPS','EliteBook','ProBook','ZBook','EliteDesk','ProDesk','Pavilion','Envy','Omen','Victus','Surface','MacBook','iMac','Aspire','Nitro','Predator','Swift','TravelMate','VivoBook','ZenBook','ROG','TUF','ExpertBook')
    foreach ($k in $known) { if ($Model -match "(?i)\b$k\b") { return $k } }
    return ($Model -split '\s+')[0]
}

# =============================================================== eBay linking
#
# Two queries per line, deliberately. The focused one is what you want when the
# model is common enough to have comps; the broad one is the fallback when the
# focused query returns four results and none of them sold.

$EbayCategory = @{ 'laptop' = '177'; 'computer' = '177'; 'desktop' = '179'; 'other' = '' }

function Get-EbayLinks {
    param($Item)
    $focused = @($Item.make, $Item.model, $Item.cpu, $Item.ram) | Where-Object { $_ }
    $broad   = @($Item.make, $Item.model) | Where-Object { $_ }
    $cat = $EbayCategory[[string]$Item.item_type]
    if (-not $cat) { $cat = '' }

    $encF = [uri]::EscapeDataString(($focused -join ' '))
    $encB = [uri]::EscapeDataString(($broad -join ' '))

    [ordered]@{
        # Terapeak / Seller Hub Research. 90 days of SOLD, which is the window
        # the valuation methodology anchors to.
        research_focused = "https://www.ebay.com/sh/research?marketplace=EBAY-US&tabName=SOLD&keywords=$encF&dayRange=90&categoryId=$cat&offset=0&limit=50&sorting=match"
        research_broad   = "https://www.ebay.com/sh/research?marketplace=EBAY-US&tabName=SOLD&keywords=$encB&dayRange=90&categoryId=$cat&offset=0&limit=50&sorting=match"
        # Public sold search. Works without Seller Hub, useful for a second pair
        # of eyes who is not signed into the business account.
        sold_search      = "https://www.ebay.com/sch/i.html?_nkw=$encF&_sacat=$cat&LH_Sold=1&LH_Complete=1&_ipg=120"
        query_focused    = ($focused -join ' ')
        query_broad      = ($broad -join ' ')
    }
}

# ==================================================================== reading

$files = @(Get-ChildItem -Path $CaptureDir -Filter '*.json' -File -ErrorAction SilentlyContinue)
if ($files.Count -eq 0) {
    Write-Host "No capture files in $CaptureDir" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host "  Reading $($files.Count) capture file(s) from $CaptureDir" -ForegroundColor Cyan

$units = @()
$bad = @()
foreach ($f in $files) {
    try {
        $u = Get-Content -Path $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $u.serial) { throw 'no serial in file' }
        $units += $u
    } catch {
        $bad += [pscustomobject]@{ file = $f.Name; error = $_.Exception.Message }
    }
}
foreach ($b in $bad) { Write-Host "    skipped $($b.file): $($b.error)" -ForegroundColor DarkYellow }

# A unit re-tested after a repair writes the same filename, so duplicates should
# not normally reach here. Guarding anyway: two records for one serial would
# inflate a line's quantity and put the same serial in the pool twice.
$seen = @{}
$deduped = @()
foreach ($u in ($units | Sort-Object { $_.captured_at } -Descending)) {
    $k = [string]$u.serial
    if ($seen.ContainsKey($k)) { continue }
    $seen[$k] = $true
    $deduped += $u
}
if ($deduped.Count -ne $units.Count) {
    Write-Host "    collapsed $($units.Count - $deduped.Count) duplicate serial(s), newest capture kept" -ForegroundColor DarkYellow
}
$units = $deduped

# =================================================================== grouping
#
# Same model, same specs, same condition, same wipe requirement = one line.
# Battery health is deliberately NOT in the key: it varies per unit and would
# shatter every pallet into singles. It is reported as a range instead.

$groups = @{}
foreach ($u in $units) {
    # Screen is deliberately NOT part of the key. A laptop tested while docked,
    # or one whose panel returns no EDID, reports null for it -- and one null
    # must never split an otherwise identical pallet into two line items.
    # Panels are collected instead, and a real disagreement is FLAGGED for a
    # manual split rather than silently applied or silently ignored.
    $key = (@(
        $u.make, $u.model, $u.item_type, $u.cpu, $u.ram, $u.storage, $u.gpu,
        $u.condition, [string]$u.wipe_required
    ) -join '|').ToLower()

    if (-not $groups.ContainsKey($key)) {
        $groups[$key] = [pscustomobject]@{
            make          = $u.make
            model         = $u.model
            item_type     = $u.item_type
            cpu           = $u.cpu
            ram           = $u.ram
            storage       = $u.storage
            gpu           = $u.gpu
            screens       = @()
            condition     = $u.condition
            wipe_required = [bool]$u.wipe_required
            serials       = @()
            batteries     = @()
            notes         = @()
            client_notes  = @()
            missing       = @()
        }
    }
    $g = $groups[$key]
    $g.serials += [string]$u.serial
    if ($u.detail.screen_text) { $g.screens += [string]$u.detail.screen_text }
    if ($u.battery_health -match '([0-9]+)%') { $g.batteries += [int]$Matches[1] }
    if ($u.staff_notes)  { $g.notes        += ("{0}: {1}" -f $u.serial, $u.staff_notes) }
    if ($u.client_notes) { $g.client_notes += [string]$u.client_notes }
    if ($u.detail.missing_specs) { $g.missing += @($u.detail.missing_specs) }
}

# ==================================================================== shaping

$lines = @()
foreach ($g in $groups.Values) {
    $battery = $null
    if ($g.batteries.Count -gt 0) {
        $lo = ($g.batteries | Measure-Object -Minimum).Minimum
        $hi = ($g.batteries | Measure-Object -Maximum).Maximum
        # A range is the honest answer for a multi-unit line. Buy-side pricing
        # should look at the bottom of it, so the low end leads.
        $battery = if ($lo -eq $hi) { "$lo%" } else { "$lo-$hi%" }
    }

    $panels = @($g.screens | Select-Object -Unique)
    $screen = switch ($panels.Count) { 0 { $null } 1 { $panels[0] } default { $panels -join '  /  ' } }
    $mixedPanels = ($panels.Count -gt 1)

    $item = [pscustomobject]@{
        make           = $g.make
        model          = $g.model
        item_type      = $g.item_type
        cpu            = $g.cpu
        ram            = $g.ram
        storage        = $g.storage
        gpu            = $g.gpu
        battery_health = $battery
        screen         = $screen
        condition      = $g.condition
        wipe_required  = $g.wipe_required
        quantity       = $g.serials.Count
        # Matches the b2b_deal_items.serials format exactly: one entry per unit,
        # comma separated, count must equal quantity or submit_pricing refuses.
        serials        = ($g.serials -join ',')
        staff_notes    = ($g.notes -join ' | ')
        client_notes   = (($g.client_notes | Select-Object -Unique) -join ' | ')
        missing_specs  = (($g.missing | Select-Object -Unique) -join ', ')
    }

    $links = Get-EbayLinks $item
    # listing_info is the right home for the link: staff_notes caps at 1000 and
    # is read while pricing, listing_info caps at 2000 and exists for whoever
    # lists it. A 300-char URL belongs in the roomy one.
    $listingInfo = @()
    if ($item.screen) { $listingInfo += "Screen: $($item.screen)" }
    if ($battery)     { $listingInfo += "Battery: $battery" }
    $listingInfo += "Pricing: $($links.research_focused)"

    $item | Add-Member -NotePropertyName listing_info -NotePropertyValue ($listingInfo -join ' | ')
    $item | Add-Member -NotePropertyName links        -NotePropertyValue $links
    $item | Add-Member -NotePropertyName mixed_panels -NotePropertyValue $mixedPanels
    # Mirrors unreasonedNames() in b2b-deals: Broken and For Parts print a
    # client-facing reason on the quote, and submit_pricing refuses the line
    # without one. Caught here so it is not discovered at submit time.
    $item | Add-Member -NotePropertyName needs_reason -NotePropertyValue (
        ($item.condition -in @('Broken','For Parts')) -and [string]::IsNullOrWhiteSpace($item.client_notes))
    $item | Add-Member -NotePropertyName family       -NotePropertyValue (Get-Family $item.model $item.make)
    $item | Add-Member -NotePropertyName spec_rank    -NotePropertyValue (Get-SpecRank $item)
    $lines += $item
}

# ==================================================================== sorting

# Families rank by their strongest member, so a family's block lands where its
# best machine says it should rather than where its average does.
$familyBest = @{}
foreach ($l in $lines) {
    $fk = "$($l.item_type)|$($l.make)|$($l.family)".ToLower()
    if (-not $familyBest.ContainsKey($fk) -or $l.spec_rank -gt $familyBest[$fk]) { $familyBest[$fk] = $l.spec_rank }
}
# Same for brands: the brand with the strongest single machine leads its type.
$brandBest = @{}
foreach ($l in $lines) {
    $bk = "$($l.item_type)|$($l.make)".ToLower()
    if (-not $brandBest.ContainsKey($bk) -or $l.spec_rank -gt $brandBest[$bk]) { $brandBest[$bk] = $l.spec_rank }
}

$sorted = $lines | Sort-Object `
    @{ Expression = { if ($TypeOrder.ContainsKey([string]$_.item_type)) { $TypeOrder[[string]$_.item_type] } else { 5 } } }, `
    @{ Expression = { -1 * $brandBest["$($_.item_type)|$($_.make)".ToLower()] } }, `
    @{ Expression = { [string]$_.make } }, `
    @{ Expression = { -1 * $familyBest["$($_.item_type)|$($_.make)|$($_.family)".ToLower()] } }, `
    @{ Expression = { [string]$_.family } }, `
    @{ Expression = { -1 * $_.spec_rank } }, `
    @{ Expression = { [string]$_.model } }

# =================================================================== batch.json

$payload = [ordered]@{
    schema       = 'speeks.b2b.batch/1'
    tool_version = $ToolVersion
    generated_at = (Get-Date).ToString('o')
    batch_name   = $BatchName
    client       = $Client
    unit_count   = $units.Count
    line_count   = @($sorted).Count
    # Shaped for b2b-deals `update_item` / `add_item`. Every key below is a real
    # field on b2b_deal_items; nothing here needs remapping on import.
    lines        = @($sorted | ForEach-Object {
        [ordered]@{
            make           = $_.make
            model          = $_.model
            item_type      = $_.item_type
            cpu            = $_.cpu
            ram            = $_.ram
            storage        = $_.storage
            gpu            = $_.gpu
            battery_health = $_.battery_health
            condition      = $_.condition
            quantity       = $_.quantity
            serials        = $_.serials
            staff_notes    = $_.staff_notes
            client_notes   = $_.client_notes
            listing_info   = $_.listing_info
            wipe_required  = $_.wipe_required
            # Not set here on purpose. disposition, value and offer are pricing
            # decisions and belong to whoever is doing the pricing pass.
            disposition    = 'purchase'
            _research      = $_.links
            _sort_rank     = [math]::Round($_.spec_rank)
        }
    })
}

$jsonOut = Join-Path $OutDir 'batch.json'
$payload | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonOut -Encoding UTF8

# =================================================================== batch.html

function E { param([string]$s) if ($null -eq $s) { return '' }; [System.Web.HttpUtility]::HtmlEncode($s) }
Add-Type -AssemblyName System.Web -ErrorAction SilentlyContinue
if (-not ('System.Web.HttpUtility' -as [type])) {
    function E { param([string]$s)
        if ($null -eq $s) { return '' }
        $s -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;' -replace '"','&quot;'
    }
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<!doctype html><html lang="en"><head><meta charset="utf-8">')
[void]$sb.AppendLine('<meta name="viewport" content="width=device-width,initial-scale=1">')
[void]$sb.AppendLine("<title>$(E $BatchName) - SPEEKS B2B</title>")
[void]$sb.AppendLine(@'
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#12151a;--dim:#5b6470;--line:#dfe3e8;--accent:#0b5fff;--warn:#b4530a;--ok:#0f7a3d}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#161b22;--ink:#e6edf3;--dim:#8b949e;--line:#2a313a;--accent:#5a9bff;--warn:#e0873a;--ok:#3fb96b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:20px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
h1{margin:0 0 4px;font-size:19px}
.sub{color:var(--dim);font-size:13px}
main{padding:20px 24px;max-width:1180px}
.line{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:14px;overflow:hidden}
.lh{display:flex;gap:12px;align-items:baseline;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.qty{background:var(--accent);color:#fff;border-radius:6px;padding:2px 9px;font-weight:700;font-size:13px}
.nm{font-weight:640;font-size:15px}
.badge{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:20px;padding:1px 9px}
.badge.w{color:var(--warn);border-color:var(--warn)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:1px;background:var(--line)}
.f{background:var(--card);padding:9px 12px;min-height:52px}
.f .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)}
.f .v{font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-word}
.f .v.none{color:var(--dim);font-style:italic;font-family:inherit}
.f[data-copy]{cursor:pointer}
.f[data-copy]:hover{outline:2px solid var(--accent);outline-offset:-2px}
.f.copied{background:color-mix(in srgb,var(--ok) 18%,var(--card))}
.foot{padding:11px 16px;display:flex;gap:9px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line)}
a.btn,button.btn{font:inherit;font-size:12.5px;padding:6px 12px;border-radius:7px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer;text-decoration:none}
a.btn.p{background:var(--accent);color:#fff;border-color:transparent;font-weight:600}
textarea{width:100%;font-family:ui-monospace,Consolas,monospace;font-size:12px;border:1px solid var(--line);border-radius:7px;padding:8px;background:var(--bg);color:var(--ink);resize:vertical}
details{padding:0 16px 12px}
summary{cursor:pointer;color:var(--dim);font-size:12.5px;padding:8px 0}
.warn{color:var(--warn);font-size:12.5px;padding:8px 16px;border-top:1px solid var(--line)}
.note{color:var(--dim);font-size:12.5px;padding:0 16px 12px}
</style>
'@)
[void]$sb.AppendLine('</head><body>')
[void]$sb.AppendLine("<header><h1>$(E $BatchName)</h1><div class=""sub"">$($units.Count) units &middot; $(@($sorted).Count) line items &middot; click any field to copy &middot; generated $(Get-Date -Format 'yyyy-MM-dd HH:mm')</div></header><main>")

$idx = 0
foreach ($l in $sorted) {
    $idx++
    $title = (@($l.make, $l.model) | Where-Object { $_ }) -join ' '
    [void]$sb.AppendLine('<section class="line">')
    [void]$sb.AppendLine('<div class="lh">')
    [void]$sb.AppendLine("<span class=""qty"">$($l.quantity)x</span><span class=""nm"">$(E $title)</span>")
    [void]$sb.AppendLine("<span class=""badge"">$(E $l.item_type)</span>")
    if ($l.condition) { [void]$sb.AppendLine("<span class=""badge"">$(E $l.condition)</span>") }
    if ($l.wipe_required) { [void]$sb.AppendLine('<span class="badge w">certified wipe</span>') }
    [void]$sb.AppendLine('</div>')

    [void]$sb.AppendLine('<div class="grid">')
    $fields = [ordered]@{
        'Brand' = $l.make; 'Model' = $l.model; 'CPU' = $l.cpu; 'RAM' = $l.ram
        'Storage' = $l.storage; 'GPU' = $l.gpu; 'Screen' = $l.screen; 'Battery' = $l.battery_health
        'Condition' = $l.condition; 'Quantity' = [string]$l.quantity
    }
    foreach ($k in $fields.Keys) {
        $v = [string]$fields[$k]
        if ([string]::IsNullOrWhiteSpace($v)) {
            [void]$sb.AppendLine("<div class=""f""><div class=""k"">$(E $k)</div><div class=""v none"">-</div></div>")
        } else {
            [void]$sb.AppendLine("<div class=""f"" data-copy=""$(E $v)""><div class=""k"">$(E $k)</div><div class=""v"">$(E $v)</div></div>")
        }
    }
    [void]$sb.AppendLine('</div>')

    if ($l.mixed_panels) {
        [void]$sb.AppendLine("<div class=""warn"">Mixed panels on this line: $(E $l.screen) &mdash; check whether this should be split into separate line items.</div>")
    }
    if ($l.needs_reason) {
        [void]$sb.AppendLine("<div class=""warn"">Condition is $(E $l.condition) with no client reason &mdash; this prints on the quote and SPEEKSnet will refuse the line without it.</div>")
    }
    if ($l.missing_specs) {
        [void]$sb.AppendLine("<div class=""warn"">Missing $(E $l.missing_specs) &mdash; SPEEKSnet will refuse to submit this line until it is filled in.</div>")
    }

    [void]$sb.AppendLine('<div class="foot">')
    [void]$sb.AppendLine("<a class=""btn p"" href=""$(E $l.links.research_focused)"" target=""_blank"" rel=""noopener"">Check pricing</a>")
    [void]$sb.AppendLine("<a class=""btn"" href=""$(E $l.links.research_broad)"" target=""_blank"" rel=""noopener"">Broader</a>")
    [void]$sb.AppendLine("<a class=""btn"" href=""$(E $l.links.sold_search)"" target=""_blank"" rel=""noopener"">Public sold</a>")
    [void]$sb.AppendLine("<button class=""btn"" data-copy=""$(E $l.listing_info)"">Copy listing info</button>")
    [void]$sb.AppendLine("<span class=""badge"">query: $(E $l.links.query_focused)</span>")
    [void]$sb.AppendLine('</div>')

    [void]$sb.AppendLine("<details><summary>Serials ($($l.quantity)) &mdash; paste straight into the Serials box</summary>")
    [void]$sb.AppendLine("<textarea rows=""3"" readonly onclick=""this.select()"">$(E $l.serials)</textarea>")
    if ($l.staff_notes) { [void]$sb.AppendLine("<div class=""note"" style=""padding-left:0"">Notes: $(E $l.staff_notes)</div>") }
    [void]$sb.AppendLine('</details>')
    [void]$sb.AppendLine('</section>')
}

[void]$sb.AppendLine(@'
</main>
<script>
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-copy]');
  if (!el) return;
  var text = el.getAttribute('data-copy');
  navigator.clipboard.writeText(text).then(function () {
    el.classList.add('copied');
    setTimeout(function () { el.classList.remove('copied'); }, 700);
  }).catch(function () {
    // Clipboard API needs a secure context; a file:// page is not one in every
    // browser. Fall back to the old execCommand path so the button still works.
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); el.classList.add('copied');
          setTimeout(function () { el.classList.remove('copied'); }, 700); } catch (err) {}
    document.body.removeChild(ta);
  });
});
</script>
</body></html>
'@)

$htmlOut = Join-Path $OutDir 'batch.html'
$sb.ToString() | Set-Content -Path $htmlOut -Encoding UTF8

# ==================================================================== summary

Write-Host ''
Write-Host "  $($units.Count) units  ->  $(@($sorted).Count) line items" -ForegroundColor Green
Write-Host ''
foreach ($l in $sorted) {
    $nm = (@($l.make, $l.model) | Where-Object { $_ }) -join ' '
    $spec = (@($l.cpu, $l.ram, $l.storage, $l.gpu) | Where-Object { $_ }) -join ' / '
    Write-Host ("    {0,3}x  {1,-34} {2}" -f $l.quantity, $nm, $spec)
}
$noReason = @($sorted | Where-Object { $_.needs_reason })
if ($noReason.Count -gt 0) {
    Write-Host ''
    Write-Host "  $($noReason.Count) line(s) marked Broken/For Parts with no client reason -- add one before submitting." -ForegroundColor Yellow
}
$mixed = @($sorted | Where-Object { $_.mixed_panels })
if ($mixed.Count -gt 0) {
    Write-Host "  $($mixed.Count) line(s) have mixed panels -- check whether they should be split." -ForegroundColor Yellow
}
$flagged = @($sorted | Where-Object { $_.missing_specs })
if ($flagged.Count -gt 0) {
    Write-Host ''
    Write-Host "  $($flagged.Count) line(s) missing required specs -- SPEEKSnet will refuse these until filled." -ForegroundColor Yellow
}
Write-Host ''
Write-Host '    Review sheet  ' -NoNewline -ForegroundColor DarkGray; Write-Host $htmlOut -ForegroundColor Green
Write-Host '    Import file   ' -NoNewline -ForegroundColor DarkGray; Write-Host $jsonOut -ForegroundColor Green
Write-Host ''
try { Start-Process $htmlOut } catch { }
