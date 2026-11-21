// LOADING MESSAGES ARE TITLE CASE — site-wide (Ethan, 2026-11-21: "Loading
// Projects instead of Loading projects … make sure the whole site follows this").
//
//   powershell -File scripts/browser-check.ps1 loading-text-check.js
//   powershell -File scripts/browser-check.ps1 loading-text-check.js -Html index.html
//   (any page: index, operations, b2b, workspace, stats, docs — and arcade
//   where that page exists; it is not on pre-release as of 2026-11-21)
//
// Every "Loading <words>…" placeholder capitalises each word except the small
// ones (the, of, for, …), the same rule as every other label: "Loading Projects…",
// "Loading the Month…". Two places say it:
//   - speeks.js — read from the source of every global function, which is where
//     the site builds its placeholders;
//   - the page's own markup, when run with -Html (the popups every page carries:
//     patch notes, history, expenses, notification settings).

var LOADING_MINOR = { a: 1, an: 1, the: 1, and: 1, or: 1, 'for': 1, of: 1, 'in': 1, on: 1, to: 1, at: 1, by: 1, from: 1 };
var LOADING_RE = /Loading((?: [A-Za-z][\w'’-]*)+)(…|\.\.\.|&hellip;)/g;

function loadingOffenders(text) {
    var bad = [];
    String(text).replace(LOADING_RE, function (m, words) {
        var wrong = words.trim().split(' ').some(function (w) {
            return LOADING_MINOR[w.toLowerCase()] ? w !== w.toLowerCase() : /^[a-z]/.test(w);
        });
        if (wrong) bad.push(m);
        return m;
    });
    return bad;
}

t('loading: every "Loading …" message in speeks.js is Title Case', function () {
    var bad = [];
    Object.keys(window).forEach(function (k) {
        var f;
        try { f = window[k]; } catch (e) { return; }
        if (typeof f !== 'function') return;
        var src;
        try { src = Function.prototype.toString.call(f); } catch (e) { return; }
        if (src.indexOf('Loading') === -1 || /\[native code\]/.test(src)) return;
        loadingOffenders(src).forEach(function (m) { bad.push(k + ': ' + m); });
    });
    return bad.length === 0 || bad.slice(0, 8).join(' | ');
});

t('loading: the page\'s own markup is Title Case too (run with -Html)', function () {
    // Markup only: the harness inlines this file in a <script>, and its own
    // examples above would otherwise count.
    var copy = document.body.cloneNode(true);
    Array.prototype.forEach.call(copy.querySelectorAll('script'), function (s) { s.remove(); });
    return loadingOffenders(copy.innerHTML).join(' | ') || true;
});

t('loading: the rule itself — catches "Loading projects…", passes "Loading the Month…"', function () {
    var a = loadingOffenders('<div>Loading projects…</div>').length === 1;
    var b = loadingOffenders('<div>Loading the Month…</div><div>Loading Patch Notes...</div>').length === 0;
    var c = loadingOffenders('<div>Loading The Month…</div>').length === 1;
    return (a && b && c) || 'lower=' + a + ' ok=' + b + ' minor=' + c;
});
