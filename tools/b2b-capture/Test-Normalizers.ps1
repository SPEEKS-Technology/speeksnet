#Requires -Version 5.1
<#
    Regression tests for the pure value normalisers in SPEEKS-Capture.ps1.

        .\Test-Normalizers.ps1

    Run it after touching ANY of them. There is no CI on this repo and no JS or
    PowerShell toolchain on most of the machines it gets edited from, so this
    script is the only thing standing between a bad normaliser and a wrong number
    on a client quote.

    Adapted from Haydn's lib\Test-Normalizers.ps1 in the b2b-pickup build. His
    version could not run where it sat -- it resolved SpecRead.ps1 as
    lib\lib\SpecRead.ps1 -- so the loader here is different; the cases are his,
    plus the ones our own build turned out to need.

    FOUR SHIPPED BUGS ARE PINNED HERE AS NAMED CASES. Do not delete them:

      bug 1  a 512GB SSD reporting as 480GB, because tier snapping took the
             first match inside a tolerance instead of the nearest one
      bug 2  32GB of RAM reporting as 34GB, because memory is binary and storage
             is decimal and both were divided by 1e9
      bug 3  every discrete GPU losing its prefix ("3060", not "RTX 3060"),
             because -replace was handed a scriptblock -- a [Regex]::Replace
             feature, not a PowerShell operator feature. The operator
             stringifies it, so the field came out as the literal text of the
             scriptblock. Found by Haydn's suite, present in ours too.
      bug 4  "Intel(R) Arc(TM) A770" read as integrated, because the (TM) sits
             between the two halves of the name and \bArc\s+A770\b never matched

    THE ONE RULE TO REMEMBER: storage is decimal, memory is binary. A 512GB
    drive is 512.1 x 10^9 bytes; 32GB of RAM is 34,359,738,368. Two of the four
    bugs above came from applying one rule to both.
#>

$ErrorActionPreference = 'Stop'
$script:fail = 0
$script:ran  = 0

# The functions are extracted rather than dot-sourced, because the script they
# live in reads hardware and writes files the moment it is run.
$scriptPath = Join-Path $PSScriptRoot 'SPEEKS-Capture.ps1'
if (-not (Test-Path $scriptPath)) { Write-Host "Cannot find $scriptPath" -ForegroundColor Red; exit 1 }
$src = Get-Content -Raw $scriptPath
foreach ($fn in @('Format-Capacity','Normalize-Cpu','Normalize-Gpu','Test-DiscreteGpu','Get-PanelSize')) {
    $m = [regex]::Match($src, "(?ms)^function\s+$fn\s*\{.*?^\}")
    if (-not $m.Success) { Write-Host "COULD NOT EXTRACT $fn -- did it get renamed?" -ForegroundColor Red; $script:fail++; continue }
    Invoke-Expression $m.Value
}

# RAM normalisation is inline in the capture script rather than a function, so it
# is mirrored here. If you change it there, change it here -- and if that ever
# happens twice, make it a function in both places instead.
function RamText { param([double]$Bytes)
    $g = [math]::Round($Bytes / 1GB)
    $best = $null; $gap = [double]::MaxValue
    foreach ($t in @(2,4,6,8,12,16,20,24,32,36,40,48,64,96,128,192,256,384,512)) {
        $r = [math]::Abs($g - $t) / $t
        if ($r -lt $gap) { $gap = $r; $best = $t }
    }
    if ($null -ne $best -and $gap -le 0.06) { $g = [int]$best }
    if ($g -gt 0) { "${g}GB" } else { $null }
}

function Check { param($Label, $Got, $Want)
    $script:ran++
    $ok = ([string]$Got -eq [string]$Want)
    if (-not $ok) { $script:fail++ }
    Write-Host ("  {0}  {1,-30} got {2,-24} want {3}" -f $(if ($ok) { 'ok  ' } else { 'FAIL' }), $Label, $Got, $Want) `
        -ForegroundColor $(if ($ok) { 'DarkGray' } else { 'Red' })
}

Write-Host ''
Write-Host 'STORAGE  (decimal GB -- the number printed on the drive)' -ForegroundColor Cyan
Check '64GB eMMC'         (Format-Capacity 64023257088)   '64GB'
Check '120GB SSD'         (Format-Capacity 120034123776)  '120GB'
Check '128GB SSD'         (Format-Capacity 128035676160)  '128GB'
Check '240GB SSD'         (Format-Capacity 240057409536)  '240GB'
Check '250GB SSD'         (Format-Capacity 250059350016)  '250GB'
Check '256GB SSD'         (Format-Capacity 256060514304)  '256GB'
Check '320GB HDD'         (Format-Capacity 320072933376)  '320GB'
Check '400GB enterprise'  (Format-Capacity 400088457216)  '400GB'
Check '480GB SSD'         (Format-Capacity 480103981056)  '480GB'
Check '500GB HDD'         (Format-Capacity 500107862016)  '500GB'
Check '512GB SSD [bug 1]' (Format-Capacity 512110190592)  '512GB'
Check '600GB SAS'         (Format-Capacity 600127266816)  '600GB'
Check '800GB enterprise'  (Format-Capacity 800166076416)  '800GB'
# Not 960GB. We sell that class as 1TB, so it must snap UP -- a listing
# decision, deliberately baked into the tier list. See Format-Capacity.
Check '960GB reads 1TB'   (Format-Capacity 960197124096)  '1TB'
Check '1TB SSD'           (Format-Capacity 1000204886016) '1TB'
Check '2TB HDD'           (Format-Capacity 2000398934016) '2TB'
Check '4TB HDD'           (Format-Capacity 4000787030016) '4TB'
Check '8TB HDD'           (Format-Capacity 8001563222016) '8TB'

Write-Host ''
Write-Host 'MEMORY  (binary GiB -- the number printed on the module)' -ForegroundColor Cyan
Check '4GB'               (RamText 4294967296)   '4GB'
Check '8GB'               (RamText 8589934592)   '8GB'
Check '12GB (8+4)'        (RamText 12884901888)  '12GB'
Check '16GB'              (RamText 17179869184)  '16GB'
Check '24GB (16+8)'       (RamText 25769803776)  '24GB'
Check '32GB [bug 2]'      (RamText 34359738368)  '32GB'
Check '64GB'              (RamText 68719476736)  '64GB'
Check '16GB, iGPU carve'  (RamText 17055322112)  '16GB'
Check '8GB, iGPU carve'   (RamText 8455716864)   '8GB'

Write-Host ''
Write-Host 'CPU' -ForegroundColor Cyan
Check 'Alder Lake i7'  (Normalize-Cpu '12th Gen Intel(R) Core(TM) i7-12700H')     'i7-12700H'
Check 'Kaby Lake i5'   (Normalize-Cpu 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz') 'i5-8250U'
Check 'Ryzen 7'        (Normalize-Cpu 'AMD Ryzen 7 5800H with Radeon Graphics')   'Ryzen 7 5800H'
Check 'Core Ultra'     (Normalize-Cpu 'Intel(R) Core(TM) Ultra 7 155H')           'Core Ultra 7 155H'
Check 'Celeron'        (Normalize-Cpu 'Intel(R) Celeron(R) N4020 CPU @ 1.10GHz')  'Celeron N4020'

Write-Host ''
Write-Host 'GPU' -ForegroundColor Cyan
Check 'RTX laptop [bug 3]'  (Normalize-Gpu 'NVIDIA GeForce RTX 3060 Laptop GPU') 'RTX 3060'
Check 'GTX Ti'              (Normalize-Gpu 'NVIDIA GeForce GTX 1650 Ti')         'GTX 1650 Ti'
Check 'GTX SUPER'           (Normalize-Gpu 'NVIDIA GeForce GTX 1660 SUPER')      'GTX 1660 SUPER'
Check 'RTX A-series'        (Normalize-Gpu 'NVIDIA RTX A2000 Laptop GPU')        'RTX A2000'
Check 'RTX 4090'            (Normalize-Gpu 'NVIDIA GeForce RTX 4090')            'RTX 4090'
Check 'Quadro'              (Normalize-Gpu 'NVIDIA Quadro T1000')                'Quadro T1000'
Check 'Radeon RX'           (Normalize-Gpu 'AMD Radeon RX 6600M')                'Radeon RX 6600M'
Check 'Iris Xe is iGPU'     (Test-DiscreteGpu 'Intel(R) Iris(R) Xe Graphics')    'False'
Check 'UHD is iGPU'         (Test-DiscreteGpu 'Intel(R) UHD Graphics 620')       'False'
Check 'AMD Radeon is iGPU'  (Test-DiscreteGpu 'AMD Radeon(TM) Graphics')         'False'
Check 'RTX 3080 is dGPU'    (Test-DiscreteGpu 'NVIDIA GeForce RTX 3080')         'True'
# Arc is both an integrated and a discrete brand, and the (TM) sits between the
# name and the model. Lunar Lake's Arc 130V is on the CPU package; an A770 is a
# card.
Check 'Arc 130V is iGPU'    (Test-DiscreteGpu 'Intel(R) Arc(TM) 130V GPU (8GB)') 'False'
Check 'Arc A770 dGPU [bug 4]' (Test-DiscreteGpu 'Intel(R) Arc(TM) A770 Graphics') 'True'

Write-Host ''
Write-Host 'PANEL  (EDID centimetres -> snapped inches)' -ForegroundColor Cyan
Check '15.6 inch'     (Get-PanelSize 34.4 19.4) '15.6'
Check '14 inch'       (Get-PanelSize 30.9 17.4) '14'
Check '13.3 inch'     (Get-PanelSize 29.4 16.5) '13.3'
Check '16 inch 16:10' (Get-PanelSize 34.5 21.5) '16'

Write-Host ''
if ($script:fail -eq 0) {
    Write-Host "  ALL PASS  ($($script:ran) checks)" -ForegroundColor Green
    exit 0
}
Write-Host "  $($script:fail) FAILURE(S) of $($script:ran)" -ForegroundColor Red
exit 1
