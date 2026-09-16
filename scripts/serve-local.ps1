# serve-local.ps1 - a static server for the site, with nothing to install.
#
#   powershell -ExecutionPolicy Bypass -File scripts\serve-local.ps1
#   then open http://localhost:5501/
#
# WHY THIS EXISTS. The site is plain static files and the normal way to run it
# is the Live Server extension - .vscode/settings.json already pins its port to
# 5501 so both routes serve on the same address and a bookmark keeps working.
# This is the fallback for a machine without that extension: there is no node
# and no python here, so `npx serve` and `python -m http.server` are both out.
#
# IT HAS TO BE HTTP, NOT file://. speeks.js makes hundreds of fetch calls to
# Supabase, and a page opened from disk sends Origin: null, which CORS refuses.
# Opening index.html directly looks like it works right up until the data is
# meant to appear.
#
# !! ASCII ONLY IN THIS FILE, DELIBERATELY. Windows PowerShell 5.1 reads a
# script with no byte-order mark as ANSI, not UTF-8. The first version of this
# file had em-dashes in the comments; 5.1 decoded one into three bytes, the
# third of which it read as a quote character, and the parse died on a line
# nowhere near the real problem ("Unexpected token 'is'"). Plain hyphens cannot
# do that. If you need a non-ASCII character here, save the file with a BOM.
#
# No live-reload - refresh the browser yourself. Ctrl+C stops it.

param(
  [int]$Port = 5501,
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Root -PathType Container)) {
  Write-Error "root not found: $Root"
  exit 1
}
$Root = (Resolve-Path $Root).Path

# Content-Type matters more than it looks: a .js served as text/plain is
# refused by the browser under a strict MIME check, and a .svg served wrong
# renders as a broken image rather than an error anyone would trace back here.
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.mjs'  = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.webp' = 'image/webp'
  '.ico'  = 'image/x-icon'
  '.woff' = 'font/woff'
  '.woff2'= 'font/woff2'
  '.ttf'  = 'font/ttf'
  '.map'  = 'application/json; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.csv'  = 'text/csv; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Write-Error ("could not listen on port $Port - is Live Server (or another copy of this) " +
               "already using it? " + $_.Exception.Message)
  exit 1
}

Write-Host ""
Write-Host "  serving $Root"
Write-Host "  http://localhost:$Port/"
Write-Host "  Ctrl+C to stop"
Write-Host ""

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $status = 200

    try {
      $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '') { $rel = 'index.html' }

      $path = Join-Path $Root $rel
      if (Test-Path $path -PathType Container) { $path = Join-Path $path 'index.html' }

      # REFUSE ANYTHING OUTSIDE THE ROOT. "GET /../../.ssh/id_rsa" is a real
      # request a scanner will make, and Join-Path resolves it happily. Compare
      # the FULL path, not the relative one, because that is the only form the
      # traversal has already collapsed in.
      $full = $null
      try { $full = [System.IO.Path]::GetFullPath($path) } catch { $full = $null }
      if (-not $full -or -not $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $status = 403
        $body = [Text.Encoding]::UTF8.GetBytes('403 forbidden')
        $res.ContentType = 'text/plain; charset=utf-8'
      }
      elseif (Test-Path $full -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $ct = $mime[$ext]
        if (-not $ct) { $ct = 'application/octet-stream' }
        $body = [System.IO.File]::ReadAllBytes($full)
        $res.ContentType = $ct
        # A cached stylesheet is the classic "my change did nothing" half hour.
        $res.Headers.Add('Cache-Control', 'no-store, must-revalidate')
      }
      else {
        $status = 404
        $body = [Text.Encoding]::UTF8.GetBytes("404 not found: /$rel")
        $res.ContentType = 'text/plain; charset=utf-8'
      }

      $res.StatusCode = $status
      $res.ContentLength64 = $body.Length
      $res.OutputStream.Write($body, 0, $body.Length)
    } catch {
      # One bad request must not take the server down - the browser cancelling a
      # request mid-flight throws here and is completely normal.
      Write-Host ("  !! " + $req.HttpMethod + " " + $req.Url.AbsolutePath + ": " + $_.Exception.Message)
    } finally {
      try { $res.Close() } catch {}
    }

    $flag = ' '
    if ($status -ne 200) { $flag = '!' }
    Write-Host ("  $flag $status  " + $req.HttpMethod + " " + $req.Url.AbsolutePath)
  }
} finally {
  $listener.Stop()
  $listener.Close()
  Write-Host ""
  Write-Host "  stopped"
}
