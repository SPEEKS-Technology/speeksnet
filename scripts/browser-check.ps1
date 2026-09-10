# Browser check runner — no Node required.
#
#   powershell -File scripts/browser-check.ps1 b2b-check.js
#   powershell -File scripts/browser-check.ps1 b2b-check.js -Keep
#
# WHY THIS EXISTS ALONGSIDE scripts/*-check.js
# The Puppeteer harnesses need `npm i puppeteer-core`, and Node is not installed
# on the machine this repo is currently worked on — so every one of them is
# unrunnable and the project had no executable verification at all. Headless
# Chrome alone is enough for the thing that matters most on a 47k-line
# hand-written file: does it still parse, and do the functions I just touched
# still return what they should. That needs no package manager.
#
# HOW IT WORKS
# Builds a throwaway page that seeds a session (speeks.js redirects any page to
# index.html without one, which would navigate the harness away before it could
# report), loads speeks.js, then runs the named check file. The check file gets
# `t(name, fn)` — return $true to pass, or a string explaining the failure.
#
# A parse error anywhere in speeks.js means NO function in it gets hoisted, so
# the probe block below doubles as a whole-file syntax check.

param(
    [Parameter(Mandatory = $true)][string]$Check,
    # -Html <page>: inline that page's markup into the harness, so a check can
    # assert about the REAL DOM -- ids, role classes, data-feature, which
    # element sits inside which -- rather than about a copy of the markup
    # written into the check, which only ever proves the copy agrees with
    # itself.
    #
    # Opt-in: without it every existing run is byte-for-byte unchanged.
    # <script> blocks are stripped, because the page bootstrap would either
    # navigate the harness away or fire against half-built globals, and the
    # markup is the only part being asserted about.
    [string]$Html = "",
    [switch]$Keep,
    [int]$TimeoutMs = 20000
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoUrl = ($repo -replace '\\', '/')

$chrome = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Error "Chrome not found. Install it, or edit the paths in this script." }

$checkPath = if (Test-Path $Check) { (Resolve-Path $Check).Path } else { Join-Path $PSScriptRoot $Check }
if (-not (Test-Path $checkPath)) { Write-Error "Check file not found: $Check" }
$checkJs = [IO.File]::ReadAllText($checkPath)

# -Html: the page's own markup, scripts removed. Everything between <body> and
# </body> so the harness keeps its own <head> (the stylesheet link and the
# session seeding both live there).
$pageMarkup = ""
if ($Html) {
    $htmlPath = if (Test-Path $Html) { (Resolve-Path $Html).Path } else { Join-Path $repo $Html }
    if (-not (Test-Path $htmlPath)) { Write-Error "HTML file not found: $Html" }
    $raw = [IO.File]::ReadAllText($htmlPath)
    $m = [regex]::Match($raw, '(?is)<body[^>]*>(.*)</body>')
    $pageMarkup = if ($m.Success) { $m.Groups[1].Value } else { $raw }
    # Singleline so a multi-line script block goes in one bite, and the lazy
    # quantifier so two of them are not swallowed as one.
    $pageMarkup = [regex]::Replace($pageMarkup, '(?is)<script.*?</script>', '')
    # noscript carries a duplicate of parts of the page in some shells, which
    # would put a second copy of an id in the DOM and quietly break every
    # getElementById assertion.
    $pageMarkup = [regex]::Replace($pageMarkup, '(?is)<noscript.*?</noscript>', '')
}

$harness = @"
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- The real stylesheet, so a check can measure LAYOUT and not just strings:
     overflow, wrapping and clipping are invisible to an assertion about HTML.
     Harmless to the string-based checks. -->
<link rel="stylesheet" href="file:///$repoUrl/styles.css">
</head><body>
<div id="speeks-check-out">not-run</div>
$pageMarkup
<script>
  try {
    sessionStorage.setItem('speeksUnlocked', 'true');
    sessionStorage.setItem('speeksUserName', 'Browser Check');
    sessionStorage.setItem('speeksUserRole', 'MOCD');
    sessionStorage.setItem('speeksUserStore', 'CORP');
  } catch (e) {}
  window.__err = [];
  window.onerror = function (m, s, l) { window.__err.push(m + ' @' + l); return true; };
  window.__log = [];

  // BLOCKING DIALOGS ARE FATAL IN HEADLESS. alert/confirm/prompt never return
  // there, so one of them hangs the whole run with no output and no error --
  // and speeks.js reaches for alert() readily (e.g. _b2bSay falls back to it
  // whenever its footer element is absent, which it always is in a harness).
  // Record the calls instead. confirm answers yes so a guarded action proceeds;
  // prompt answers null so a cancel is the default rather than a fabricated
  // value. Assertions can read window.__dialogs.
  window.__dialogs = [];
  window.alert   = function (m) { window.__dialogs.push('alert: ' + m); };
  window.confirm = function (m) { window.__dialogs.push('confirm: ' + m); return true; };
  window.prompt  = function (m) { window.__dialogs.push('prompt: ' + m); return null; };

  // Nothing in a check may touch the network: the page is on file://, so every
  // request fails slowly and asynchronously, landing in a .catch() long after
  // the test that caused it has restored its own stubs. Fail loudly instead.
  window.__fetches = [];
  window.fetch = function (u) {
    window.__fetches.push(String(u));
    return Promise.reject(new Error('network blocked in browser-check'));
  };
  // A check may return true, a failure string, OR a promise of either.
  //
  // The whole check file runs in one synchronous script block, so a microtask
  // queued by .then() has NOT run by the time the next t() executes. An
  // assertion written that way reads its own variables before they are set and
  // reports a failure that is not real -- which is exactly what happened to the
  // first attempt at the Outlook virtual-file checks. Returning the promise
  // reserves the log slot now and fills it when it settles; the output write
  // below waits on all of them.
  window.__pending = [];
  window.t = function (name, fn) {
    var verdict = function (r) {
      return (r === true ? 'PASS  ' : 'FAIL  ') + name + (r === true ? '' : ' -> ' + r);
    };
    try {
      var r = fn();
      if (r && typeof r.then === 'function') {
        var slot = window.__log.length;
        // Placeholder, so a promise that never settles reports itself rather
        // than vanishing from the output.
        window.__log.push('STALLED  ' + name + ' -> never settled');
        window.__pending.push(r.then(
          function (v) { window.__log[slot] = verdict(v); },
          function (e) { window.__log[slot] = 'ERROR ' + name + ' -> ' + ((e && e.message) || e); }
        ));
        return;
      }
      window.__log.push(verdict(r));
    } catch (e) { window.__log.push('ERROR ' + name + ' -> ' + e.message); }
  };
</script>
<script src="file:///$repoUrl/speeks.js"></script>
<script>
  // Whole-file parse probe: these span the very start and the very end of
  // speeks.js, so if any of them is missing the file did not parse.
  t('speeks.js parses (first + last declarations hoisted)', function () {
    var miss = ['_stampVersion', '_usageSessionId', '_ddWatch', '_ddScan']
      .filter(function (k) { return typeof window[k] !== 'function'; });
    return miss.length === 0 || 'missing: ' + miss.join(',');
  });
  t('APP_VERSION is readable', function () {
    return (typeof APP_VERSION === 'string' && APP_VERSION.length > 0) || 'got ' + typeof APP_VERSION;
  });
</script>
<script>
$checkJs
</script>
<script>
  // Surface what would otherwise be invisible: a dialog that would have hung a
  // real headless run, and any request that escaped towards the network.
  if (window.__dialogs.length) {
    window.__log.push('NOTE  ' + window.__dialogs.length + ' dialog(s) suppressed: '
      + window.__dialogs.slice(0, 4).join(' / '));
  }
  if (window.__fetches.length) {
    window.__log.push('NOTE  ' + window.__fetches.length + ' network call(s) blocked: '
      + window.__fetches.slice(0, 3).join(' / '));
  }
  // Wait for any promise-returning checks before writing, but never wait
  // forever: a check that hangs must still produce a report, with its own
  // STALLED placeholder naming it. --virtual-time-budget advances the clock,
  // so this timer costs no real seconds.
  var write = function () {
    document.getElementById('speeks-check-out').textContent =
      window.__log.join('\u0000') + '\u0000LOAD-ERRORS=' +
      (window.__err.length ? window.__err.join(' | ') : 'none');
  };
  write();   // immediately, so a later crash still leaves a readable report
  var settled = window.__pending.map(function (p) { return p.catch(function () {}); });
  Promise.race([
    Promise.all(settled),
    new Promise(function (res) { setTimeout(res, 5000); }),
  ]).then(write, write);
</script>
</body></html>
"@

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("speeks-check-" + [Guid]::NewGuid().ToString('N') + ".html")
[IO.File]::WriteAllText($tmp, $harness, (New-Object Text.UTF8Encoding($false)))

try {
    $url = "file:///" + ($tmp -replace '\\', '/')
    # Two Windows-specific traps here, both learned the hard way:
    #
    #  1. `2>&1` is REQUIRED. Without it this returns nothing at all — Chrome's
    #     --dump-dom output only reaches the pipeline on the merged stream.
    #     Start-Process with -RedirectStandardOutput writes an empty file too.
    #  2. But in PowerShell 5.1, merging a native command's stderr wraps each
    #     line in an ErrorRecord, and under $ErrorActionPreference='Stop' that
    #     aborts the script even though Chrome exited 0 (it always writes GCM /
    #     DEPRECATED_ENDPOINT noise). So drop to 'Continue' across the call and
    #     flatten every record to a plain string afterwards.
    #
    # Deliberately no --user-data-dir: with a profile directory Chrome tries to
    # restore a session and dies with "Multiple targets are not supported in
    # headless mode" before it ever loads the page.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = (& $chrome --headless --disable-gpu --no-sandbox `
            --allow-file-access-from-files --virtual-time-budget=$TimeoutMs `
            --dump-dom $url 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
    } finally { $ErrorActionPreference = $prevEAP }

    $m = [regex]::Match($raw, '<div id="speeks-check-out">(.*?)</div>', 'Singleline')
    if (-not $m.Success) {
        Write-Output "Could not read the harness result (Chrome returned $($raw.Length) chars)."
        Write-Output "The page probably navigated away or Chrome failed to start."
        exit 2
    }

    # The page HTML-escapes whatever it prints, so undo that for the console.
    $text = $m.Groups[1].Value.
        Replace('&lt;', '<').Replace('&gt;', '>').Replace('&quot;', '"').
        Replace('&#39;', "'").Replace('&amp;', '&')
    $lines = $text -split "`0"

    $lines | ForEach-Object { Write-Output $_ }
    $pass = @($lines | Where-Object { $_ -like 'PASS*' }).Count
    $fail = @($lines | Where-Object { $_ -like 'FAIL*' -or $_ -like 'ERROR*' }).Count
    Write-Output ""
    Write-Output "$pass passed, $fail failed"
    if ($fail -gt 0) { exit 1 }
}
finally {
    if ($Keep) {
        Write-Output "harness kept: $tmp"
    } else {
        try { Remove-Item $tmp -Force -ErrorAction Stop } catch {}
    }
}
