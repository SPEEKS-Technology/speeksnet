// RETIRED BUBBLES — no feed reminder may float on screen.
//
//   powershell -File scripts/browser-check.ps1 retired-bubble-check.js -Html index.html
//
// Floating alert toasts were retired 2026-07-21: every reminder lives in the
// SPEEKS Feed, and its bubble element is only an invisible state-carrier that
// _samGatherReminders reads (computed display = live). The hiding is ONE css
// rule in styles.css listing ids by hand, so every new reminder has to be added
// to it — and three have shipped without it (recat 2026-08-21, then the claims
// "due today" card 2026-10-08, which floated a red "Card expired … overdue"
// toast until Ethan caught it 2026-10-12).
//
// So this walks _samReminderCfg() — the list every reminder must be in to reach
// the feed at all — and fails any id that is visible while live. A new reminder
// added to the feed but not to the css rule fails here, by name.

t('every feed reminder bubble is invisible while live', function () {
    var cfg = _samReminderCfg();
    if (!cfg || !cfg.length) return '_samReminderCfg() returned nothing';
    var visible = [];
    cfg.forEach(function (c) {
        var el = document.getElementById(c.id);
        var made = false;
        if (!el) { el = document.createElement('div'); el.id = c.id; document.body.appendChild(el); made = true; }
        var was = el.style.display;
        el.style.display = 'flex';
        var cs = getComputedStyle(el);
        if (cs.visibility !== 'hidden' || cs.opacity !== '0') visible.push(c.id);
        el.style.display = was;
        if (made) el.remove();
    });
    return !visible.length || 'visible on screen (add to the RETIRED FLOATING ALERT TOASTS rule in styles.css): ' + visible.join(', ');
});

t('the claims due-today bubble is a bare carrier, not a styled toast', function () {
    var b = _claimsDueBubbleEl();
    if (!b) return 'no bubble created (is #claimAlertBubble in the page?)';
    if (/gradient|box-shadow/.test(b.style.cssText)) return 'it still carries toast styling: ' + b.style.cssText;
    return true;
});

t('the claims due-today card still reaches the feed', function () {
    var b = _claimsDueBubbleEl();
    var t = document.getElementById('claimsDueAlertBubbleText');
    t.dataset.summary = 'Card expired $262.43 (#KS01-15305) — overdue';
    b.style.display = 'flex';
    var got = _samGatherReminders().some(function (r) { return /KS01-15305/.test(JSON.stringify(r)); });
    b.style.display = 'none';
    return got || 'hidden bubble no longer feeds _samGatherReminders';
});
