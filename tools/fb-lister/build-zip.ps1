# Rebuilds SPEEKS-Marketplace-Lister.zip from extension/.
# Run after ANY change to the extension, bump "version" in extension/manifest.json
# AND FB_LISTER_VERSION in speeks.js to match, then bump the speeks.js
# cache-buster in the six pages so the download link picks up the new version.
#
# The zip holds one folder, SPEEKS-Marketplace-Lister/, so "Extract All" gives a
# folder people can point Chrome's "Load unpacked" at directly.
#
# Written entry by entry, not with Compress-Archive: PS 5.1's Compress-Archive
# stores backslash paths, which a Mac unzips as one file named "a\b".
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'extension'
$out  = Join-Path $here 'SPEEKS-Marketplace-Lister.zip'
if (Test-Path $out) { Remove-Item $out }
$zip = [IO.Compression.ZipFile]::Open($out, 'Create')
try {
  Get-ChildItem $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "SPEEKS-Marketplace-Lister/$rel") | Out-Null
  }
} finally { $zip.Dispose() }
$v = (Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json).version
Write-Output "Built $out (version $v)"
