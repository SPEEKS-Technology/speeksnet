// ALERTS HUB phase 1 — the Phone Alerts block in Settings → Notifications.
//
//   powershell -File scripts/browser-check.ps1 alerts-hub-check.js
//
// The harness page is file://, which has no service worker, so the real
// environment is "unsupported". _pushEnv is swapped per test to draw each
// state; the branches that do not await draw synchronously, so the checks can
// read the DOM straight after the call. The crypto half is covered by
// scripts/alerts-hub-push-test.mjs (node, no browser).

function _ahMount() {
    var old = document.getElementById('notifySettingsBody');
    if (old) old.remove();
    var b = document.createElement('div');
    b.id = 'notifySettingsBody';
    document.body.appendChild(b);
    return b;
}
function _ahWithEnv(env, fn) {
    var real = window._pushEnv;
    window._pushEnv = function () { return env; };
    try { return fn(); } finally { window._pushEnv = real; }
}

t('the endpoint constant points at alerts-hub', function () {
    return /\/functions\/v1\/alerts-hub$/.test(ALERTS_HUB_URL) || 'ALERTS_HUB_URL = ' + ALERTS_HUB_URL;
});

t('the notification settings open with the Phone Alerts block on top', function () {
    var b = _ahMount();
    // The real file:// env reaches the await branch (draws a tick later), so
    // draw with a synchronous state to read the block straight away.
    _ahWithEnv({ ios: false, android: false, standalone: false, supported: false }, function () {
        renderNotifySettings({ prefs: { enabled: false }, categories: [], muted: [] });
    });
    var first = b.firstElementChild;
    if (!first || first.id !== 'nsPush') return 'first child is ' + (first && (first.id || first.className));
    return /Phone alerts/i.test(first.textContent) || 'block drew: ' + first.textContent.slice(0, 80);
});

t('iPhone in Safari (not from the Home Screen) gets the three steps, no button', function () {
    var b = _ahMount(); b.innerHTML = '<div id="nsPush"></div>';
    _ahWithEnv({ ios: true, android: false, standalone: false, supported: false }, _pushRender);
    var txt = b.textContent;
    if (!/Add to Home Screen/.test(txt)) return 'no Home Screen step: ' + txt.slice(0, 120);
    return !b.querySelector('button') || 'a button was drawn where it cannot work';
});

t('an unsupported browser says so plainly', function () {
    var b = _ahMount(); b.innerHTML = '<div id="nsPush"></div>';
    _ahWithEnv({ ios: false, android: false, standalone: false, supported: false }, _pushRender);
    return /can.t get phone alerts/.test(b.textContent) || b.textContent.slice(0, 120);
});

t('device names are Title Case', function () {
    var names = [
        _ahWithEnv({ ios: true }, _pushDeviceName),
        _ahWithEnv({ android: true }, _pushDeviceName),
        _ahWithEnv({}, _pushDeviceName),
    ];
    return names.join('|') === 'iPhone|Android Phone|This Computer' || names.join('|');
});

t('the VAPID key decodes to a 65-byte P-256 point', function () {
    // A real public key shape (87 base64url chars). Not ours — the live one is
    // fetched from the function at tap time, never baked in.
    var k = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
    var bytes = _pushKeyBytes(k);
    return (bytes.length === 65 && bytes[0] === 4) || 'got ' + bytes.length + ' bytes, first ' + bytes[0];
});

t('requestPermission is the first await in pushEnable (iOS needs the tap)', function () {
    var src = String(pushEnable);
    var firstAwait = src.indexOf('await ');
    return src.indexOf('await Notification.requestPermission()') === firstAwait
        || 'something is awaited before the permission prompt';
});

t('the handlers the buttons call are global', function () {
    var miss = ['pushEnable', 'pushTest', 'pushDisable'].filter(function (n) { return typeof window[n] !== 'function'; });
    return !miss.length || 'not on window: ' + miss.join(', ');
});
