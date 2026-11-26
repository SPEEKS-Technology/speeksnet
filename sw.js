// SPEEKSNET SERVICE WORKER — phone alerts only (Alerts Hub phase 1, 2026-11-20)
// ---------------------------------------------------------------------------
// This file exists for push notifications and nothing else. There is
// deliberately NO fetch handler and NO cache: the site ships fixes through the
// ?v= cache-buster on every page, and a caching service worker would serve
// yesterday's speeks.js straight past it. If offline support is ever wanted,
// it has to respect that scheme first.
//
// It must live at the site root so its scope covers every page. iOS only
// delivers push to a site added to the Home Screen, and it revokes push for
// any page that receives a push without showing a notification, so every push
// event below ends in showNotification, even when the payload is unreadable.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; } catch (_) {
        d = { title: 'SPEEKSNET', body: event.data ? event.data.text() : '' };
    }
    const title = d.title || 'SPEEKSNET';
    const opts = {
        body: d.body || '',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        data: { url: d.url || 'index.html' },
    };
    // Same tag = the newer alert replaces the older one instead of stacking.
    if (d.tag) { opts.tag = d.tag; opts.renotify = true; }
    event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL((event.notification.data && event.notification.data.url) || 'index.html', self.registration.scope).href;
    event.waitUntil((async () => {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of wins) {
            if (new URL(w.url).origin === new URL(target).origin && 'focus' in w) {
                await w.focus();
                if ('navigate' in w) { try { await w.navigate(target); } catch (_) { /* cross-scope: focus is enough */ } }
                return;
            }
        }
        await self.clients.openWindow(target);
    })());
});
