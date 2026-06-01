/* =========================================================
   SPEEKSNET | UNIVERSAL APP JAVASCRIPT
   ========================================================= */

(function () {
  const img = new Image();
  img.src = 'favicon.svg';
  img.onload = function () {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    function applyFavicon() {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 64, 64);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = mq.matches ? '#FAFAFA' : '#0A0A0A';
      ctx.fillRect(0, 0, 64, 64);
      let link = document.querySelector('link[rel="icon"]');
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
      link.type = 'image/png';
      link.href = canvas.toDataURL('image/png');
    }
    applyFavicon();
    mq.addEventListener('change', applyFavicon);
  };
})();

// --- 1. API URLS ---
const _BASE = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1';
const CMS_URL           = `${_BASE}/cms`;
const HOTKEYS_URL       = `${_BASE}/hotkeys`;
const DOCS_URL          = `${_BASE}/docs`;
const MONTHLY_KPI_URL   = `${_BASE}/monthly-kpi`;
const VARIANCE_API_URL  = `${_BASE}/variance`;
const HUB_URL           = `${_BASE}/hub`;
const WEEKLY_KPI_URL    = `${_BASE}/weekly-kpi`;
const AUTH_URL          = `${_BASE}/auth`;
const RECORDS_URL       = `${_BASE}/records`;
const QUICK_MSG_URL     = `${_BASE}/quick-messages`;
const GOALS_API_URL     = `${_BASE}/listing-goals`;
const SCORECARD_URL     = `${_BASE}/scorecard`;
const EBAY_ALERTS_URL   = `${_BASE}/ebay-alerts`;
const STORE_COMMENT_URL = `${_BASE}/store-comments`;
const CHECKLIST_URL     = `${_BASE}/checklist`;
const TUTORIAL_URL      = `${_BASE}/tutorial`;
const PATCH_NOTES_URL   = `${_BASE}/patch-notes`;
const TICKER_URL        = `${_BASE}/ticker`;
const KPI_MANAGE_URL    = `${_BASE}/kpi-manage`;
const MONTHLY_BRIEF_URL = `${_BASE}/monthly-brief`;

// --- 2. NAV COMPACT MODE ---
(function () {
    let naturalNavWidth = 0;

    function measureNaturalWidth() {
        const navBar = document.querySelector('.top-nav .nav-bar');
        if (!navBar) return 0;
        // Force nav-bar to its natural size so we can read the true content width
        navBar.style.flexShrink = '0';
        navBar.style.width = 'max-content';
        const w = navBar.getBoundingClientRect().width;
        navBar.style.flexShrink = '';
        navBar.style.width = '';
        return w;
    }

    function checkNavCompact() {
        const topNav = document.querySelector('.top-nav');
        const navLeft = document.querySelector('.nav-left');
        const navRight = document.querySelector('.nav-right');
        if (!topNav || !navLeft || !navRight) return;
        if (navLeft.getBoundingClientRect().width === 0) return; // nav still hidden

        // Capture natural width once, after the nav is actually visible
        if (!naturalNavWidth) naturalNavWidth = measureNaturalWidth();
        if (!naturalNavWidth) return;

        // slot = total space between nav-left's right edge and nav-right's left edge.
        // Both are flex-shrink:0 so this value only depends on viewport width — no feedback loop.
        const slot = navRight.getBoundingClientRect().left - navLeft.getBoundingClientRect().right;
        topNav.classList.toggle('nav-compact', slot < naturalNavWidth + 70);
    }

    document.addEventListener('DOMContentLoaded', function () {
        const topNav = document.querySelector('.top-nav');
        if (!topNav) return;

        new ResizeObserver(checkNavCompact).observe(topNav);

        // The nav is hidden behind auth; measure as soon as is-authenticated is applied to body
        new MutationObserver(function () {
            if (document.body.classList.contains('is-authenticated')) checkNavCompact();
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

        checkNavCompact(); // no-op if not yet auth'd, harmless

        // Pre-fetch ticker data during login screen so it's ready the moment the user logs in.
        loadTickerItems();
    });
})();

// --- 3. GLOBAL HELPERS & UTILITIES ---
function parseNum(val) {
    if (!val && val !== 0) return 0;
    if (typeof val === 'number') return val;
    let num = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    return isNaN(num) ? 0 : num;
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe.toString()
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

function formatSmartValue(val, name) {
    if (val === null || val === undefined || String(val).trim() === '') return '-';
    let num = parseFloat(val);
    let nameL = name.toLowerCase();
    
    if (isNaN(num)) return String(val).trim();
    if (nameL.match(/%|rate|variance|margin|gm|cogs/)) {
        return `${num.toFixed(2).replace(/\.00$/, '')}%`;
    }
    
    const isCur = nameL.match(/sales|cost|refund|discount|profit|value|buying|confiscation/) || nameL === 'recycled inventory';       
    if (isCur && !nameL.match(/ranking|score|reviews|#|returning|time|gm/)) {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num).replace(/\.00$/, '');
    }
    
    return new Intl.NumberFormat('en-US').format(num);
}

// --- 4. GLOBAL UI, MODALS & TABS ---
let savedScrollPosition = 0;

function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const mainContent = document.querySelector('.main-content');
    const toggleBtn = document.querySelector('.sidebar-toggle');
    
    sidebar?.classList.toggle('collapsed');
    mainContent?.classList.toggle('expanded');
    toggleBtn?.classList.toggle('collapsed');
    
    localStorage.setItem('speeksSidebar', sidebar?.classList.contains('collapsed') ? 'collapsed' : 'expanded');
}

function lockAndBlurScreen() {
    document.body.classList.add('no-scroll');
    const overlay = document.getElementById('globalOverlay');
    if (overlay) overlay.classList.add('show');
}

function closeAllModals() {
    document.body.classList.remove('no-scroll');
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.paddingRight = '';
    
    const topNav = document.querySelector('.top-nav');
    if (topNav) {
        topNav.style.paddingRight = ''; 
    }
    
    const overlay = document.getElementById('globalOverlay');
    if (overlay) overlay.classList.remove('show');

    const modals = document.querySelectorAll('.modal-menu');
    modals.forEach(modal => {
        modal.classList.remove('show');
    });
}

function toggleModal(modalId, badgeId = null) {
    const dropdown = document.getElementById(modalId);
    if (!dropdown) return;
    
    const isOpen = dropdown.classList.contains('show');
    closeAllModals(); 
    
    if (!isOpen) {
        dropdown.classList.add('show');
        lockAndBlurScreen();
        
    }
}

async function loadCMS() {
    try {
        const response = await fetch(`${CMS_URL}?v=${Date.now()}`);
        const data = await response.json();
        
        const annContainer = document.getElementById('ann-container');
        if (annContainer) {
            let showBadge = false;
            let recentHtml = "";
            let archiveHtml = "";
            let recentCount = 0;
            let archiveCount = 0;
            
            const currentUser = sessionStorage.getItem('speeksUserName');
            const cleanUser = currentUser ? String(currentUser).trim().toLowerCase() : null;
            const userRole = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase();
            const isPrivileged = userRole === 'ceo' || userRole === 'district manager';

            if (data.announcements && data.announcements.length > 0) {
                const sortedAnns = [...data.announcements].reverse();
                const now = new Date();

                sortedAnns.forEach((item, index) => {
                    let displayDate = "";
                    let displayTime = "";
                    let isArchived = false;
                    let unreadHtmlAttr = "";

                    if (item.date) {
                        const annDate = new Date(item.date);
                        if (!isNaN(annDate.getTime())) {
                            displayDate = annDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
                            const h = annDate.getHours(), min = annDate.getMinutes();
                            if (h !== 0 || min !== 0) {
                                const ampm = h >= 12 ? 'pm' : 'am';
                                displayTime = `${h % 12 || 12}:${String(min).padStart(2, '0')}${ampm}`;
                            }
                        }
                    }

                    if (cleanUser) {
                        const localReadKey = 'speeksLocalRead_' + cleanUser;
                        const localRead = new Set(JSON.parse(localStorage.getItem(localReadKey) || '[]'));
                        const inReadBy = !!(item.readBy && item.readBy.some(u => String(u).trim().toLowerCase() === cleanUser));
                        if (inReadBy && localRead.has(item.rowId)) {
                            localRead.delete(item.rowId);
                            localStorage.setItem(localReadKey, JSON.stringify([...localRead]));
                        }
                        isArchived = inReadBy || localRead.has(item.rowId);
                        if (!isArchived) {
                            showBadge = true;
                            unreadHtmlAttr = `data-ann-id="${item.rowId}"`;
                        }
                    } else if (item.date) {
                        const annDate = new Date(item.date);
                        if (!isNaN(annDate.getTime())) {
                            isArchived = (now - annDate) / (1000 * 60 * 60) > 48;
                        }
                    }

                    const annId = item.rowId || index;
                    const rData = item.reactions || {};
                    const availableEmojis = ['👍', '🎉', '👀', '🔥', '🫡', '💵'];
                    
                    let reactionsHtml = `<div class="ann-reactions" id="reactions_${annId}">`;
                    
                    availableEmojis.forEach((emoji, eIdx) => {
                        let count = 0;
                        let hasReacted = false;
                        let usersList = [];
                        
                        if (rData[emoji] && Array.isArray(rData[emoji])) {
                            usersList = rData[emoji];
                            count = usersList.length;
                            
                            if (cleanUser) {
                                hasReacted = usersList.some(u => String(u).trim().toLowerCase() === cleanUser);
                            }
                        }

                        let displayStyle = count > 0 ? 'flex' : 'none';
                        let activeClass = hasReacted ? 'reacted' : '';
                        let tooltipText = usersList.length > 0 ? `title="Reacted by: ${usersList.join(', ')}"` : '';

                        reactionsHtml += `<button class="reaction-btn ${activeClass}" id="btn_${annId}_${eIdx}" data-emoji="${emoji}" style="display: ${displayStyle};" onclick="toggleReaction('${annId}', '${emoji}')" ${tooltipText}><span style="pointer-events: none;">${emoji}</span> <span class="count" style="pointer-events: none;">${count}</span></button>`;
                    });

                    reactionsHtml += `
                        <div class="reaction-picker-wrapper" style="position: relative;">
                            <button class="add-reaction-btn" onclick="toggleReactionPicker('${annId}')">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
                                <span style="font-size: 14px; margin-left: -4px;">+</span>
                            </button>
                            <div class="reaction-picker-popover" id="picker_${annId}">
                                ${availableEmojis.map(emoji => `<button type="button" onclick="toggleReaction('${annId}', '${emoji}'); toggleReactionPicker('${annId}')">${emoji}</button>`).join('')}
                            </div>
                        </div>
                    `;
                    reactionsHtml += `</div>`;

                    const markReadBtn = (!isArchived && cleanUser) ? `
                        <button class="mark-read-btn" onclick="markAnnouncementRead(${annId})">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                            Mark as Read
                        </button>` : '';

                    const readBy = item.readBy || [];
                    const readReceiptHtml = isPrivileged ? `
                        <div class="read-receipt" id="receipt_${annId}">
                            <button class="read-receipt-btn" onclick="toggleReadReceipt('${annId}')">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                                ${readBy.length} read
                            </button>
                            <div class="read-receipt-popover" id="receipt-popover_${annId}">
                                <div class="rr-title">Read by</div>
                                ${readBy.length === 0
                                    ? '<div class="rr-empty">No reads yet</div>'
                                    : readBy.map(u => `<div class="rr-name">${u}</div>`).join('')}
                            </div>
                        </div>` : '';

                    const html = `
                        <div class="notif-item"${unreadHtmlAttr ? ` ${unreadHtmlAttr}` : ''}>
                            <div class="ann-header">
                                <span class="ann-author">${item.author || 'Announcement'}</span>
                                <div class="ann-header-right">
                                    ${readReceiptHtml}
                                    ${displayDate ? `<small class="ann-date">${displayDate}${displayTime ? ` · ${displayTime}` : ''}</small>` : ''}
                                </div>
                            </div>
                            <hr />
                            <div class="ann-text">${item.text || ''}</div>
                            <div class="ann-card-footer">
                                ${reactionsHtml}
                                ${markReadBtn}
                            </div>
                        </div>`;

                    if (isArchived) {
                        archiveHtml += html;
                        archiveCount++;
                    } else {
                        recentHtml += html;
                        recentCount++;
                    }
                });

                recentHtml = recentCount === 0 ? '<div style="padding: 20px; color:#999; text-align:center;">No recent announcements</div>' : recentHtml;
                archiveHtml = archiveCount === 0 ? '<div style="padding: 20px; color:#999; text-align:center;">No archived announcements</div>' : archiveHtml;
                feedAnnouncementsToTicker(showBadge ? sortedAnns.slice(0, 2) : []);
                _tickerSourceDone('cms');
            } else {
                recentHtml = archiveHtml = '<div style="padding: 20px; color:#999; text-align:center;">No announcements</div>';
                _tickerSourceDone('cms');
            }

            annContainer.innerHTML = recentHtml;
            const archiveContainer = document.getElementById('archive-container');
            if (archiveContainer) archiveContainer.innerHTML = archiveHtml;

            const badge = document.getElementById('notifBadge');
            if (badge) {
                if (showBadge) {
                    if (currentUser) localStorage.setItem('speeksUnreadAnnouncements_' + currentUser, 'true');
                    badge.style.display = 'block';
                    badge.classList.add('active');
                } else {
                    if (currentUser) localStorage.removeItem('speeksUnreadAnnouncements_' + currentUser);
                    updateMainBadge(); // keep dot alive if patch notes are also unseen
                }
            }
            const recentBadge = document.getElementById('recentBadge');
            if (recentBadge) {
                recentBadge.style.display = showBadge ? 'block' : 'none';
                recentBadge.classList.toggle('active', showBadge);
            }
        }

        const activeContainer = document.getElementById('active-container');
        if (activeContainer) {
            const act = data.active || [];
            const upc = data.upcoming || [];
            activeContainer.innerHTML = act.length ? 
                act.map(t => `<div class="cms-item cms-active">${t}</div>`).join('') : 
                '<div class="cms-item">No active projects</div>';
            
            const upcomingContainer = document.getElementById('upcoming-container');
            if (upcomingContainer) {
                upcomingContainer.innerHTML = upc.length ? 
                    upc.map(t => `<div class="cms-item cms-upcoming">${t}</div>`).join('') : 
                    '<div class="cms-item">No upcoming projects</div>';
            }
        }
    } catch (e) {
        console.error("CMS Sync Failed", e);
        _tickerSourceDone('cms');
    }
}

function markAnnouncementRead(rowId) {
    const userName = sessionStorage.getItem('speeksUserName');
    if (!userName) return;

    const cleanUser = String(userName).trim().toLowerCase();
    const localReadKey = 'speeksLocalRead_' + cleanUser;
    const localRead = new Set(JSON.parse(localStorage.getItem(localReadKey) || '[]'));
    localRead.add(rowId);
    localStorage.setItem(localReadKey, JSON.stringify([...localRead]));

    fetch(CMS_URL, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ type: 'mark_read', user: userName, rowIds: [rowId] })
    }).catch(() => {});

    const card = document.querySelector(`.notif-item[data-ann-id="${rowId}"]`);
    if (card) {
        card.classList.add('ann-dismissing');
        card.addEventListener('animationend', () => {
            card.remove();
            const container = document.getElementById('ann-container');
            if (container && !container.querySelector('.notif-item[data-ann-id]')) {
                localStorage.removeItem('speeksUnreadAnnouncements_' + cleanUser);
                updateMainBadge(); // keep dot alive if patch notes are also unseen
            }
            // Reload both tabs so the item appears in Archive immediately
            loadCMS();
        }, { once: true });
    }
}

function toggleNotifs() { toggleModal('notifDropdown', 'notifBadge'); }
function toggleCalendar() { toggleModal('calendarDropdown'); }
function toggleIdeaModal() { toggleModal('ideaModal'); }

function switchAnnTab(tab) {
    const isRecent = tab === 'recent';
    const isArchive = tab === 'archive';
    const isPatchNotes = tab === 'patchnotes';

    const annC = document.getElementById('ann-container');
    if (annC) {
        annC.style.display = isRecent ? 'block' : 'none';
        annC.classList.remove('hidden');
    }

    const archC = document.getElementById('archive-container');
    if (archC) {
        archC.style.display = isArchive ? 'block' : 'none';
        archC.classList.remove('hidden');
    }

    const pnC = document.getElementById('pn-container');
    if (pnC) {
        pnC.style.display = isPatchNotes ? 'block' : 'none';
        pnC.classList.remove('hidden');
        if (isPatchNotes) loadPatchNotes();
    }

    document.getElementById('tab-recent').classList.toggle('active', isRecent);
    document.getElementById('tab-archive').classList.toggle('active', isArchive);
    const pnTab = document.getElementById('tab-patchnotes');
    if (pnTab) pnTab.classList.toggle('active', isPatchNotes);
}

// DEV TOOLS DROPDOWN GLOBAL TOGGLE
window.toggleDevDropdown = function(e) {
    e.stopPropagation();
    const dropdown = document.getElementById('devDropdown');
    if (dropdown) dropdown.classList.toggle('open');
};

document.addEventListener('click', (e) => {
    const devDropdown = document.getElementById('devDropdown');
    if (devDropdown && !devDropdown.contains(e.target)) {
        devDropdown.classList.remove('open');
    }
});

window.addEventListener('click', (e) => { 
    if (e.target === document.getElementById('globalOverlay')) closeAllModals(); 
});

document.addEventListener('keydown', (e) => { 
    if (e.key === 'Escape') closeAllModals(); 
});


// --- ANNOUNCEMENT REACTION LOGIC ---
window.toggleReaction = function(id, emoji) {
    const container = document.getElementById('reactions_' + id);
    if (!container) return;
    
    const availableEmojis = ['👍', '🎉', '👀', '🔥', '🫡', '💵'];
    const eIdx = availableEmojis.indexOf(emoji);
    const btn = document.getElementById(`btn_${id}_${eIdx}`);
    if (!btn || btn.hasAttribute('disabled')) return;

    const isReacted = btn.classList.contains('reacted');
    const countSpan = btn.querySelector('.count');
    let count = parseInt(countSpan.innerText) || 0;
    const userName = sessionStorage.getItem('speeksUserName') || 'Unknown';
    
    // We will build a single payload to prevent race conditions
    let payload = { type: 'reaction', rowId: id, user: userName };

    if (isReacted) {
        btn.classList.remove('reacted');
        const newCount = Math.max(0, count - 1);
        countSpan.innerText = newCount;
        if (newCount === 0) btn.style.display = 'none';
        
        payload.removeEmoji = emoji; // Tell backend to remove
    } else {
        const currentReacted = container.querySelector('.reaction-btn.reacted');
        
        if (currentReacted) {
            currentReacted.classList.remove('reacted');
            const oldSpan = currentReacted.querySelector('.count');
            const oldCount = Math.max(0, (parseInt(oldSpan.innerText) || 0) - 1);
            oldSpan.innerText = oldCount;
            if (oldCount === 0) currentReacted.style.display = 'none';
            
            payload.removeEmoji = currentReacted.getAttribute('data-emoji'); // Tell backend to swap this out
        }

        btn.style.display = 'flex'; 
        btn.classList.add('reacted');
        countSpan.innerText = count + 1;
        
        payload.addEmoji = emoji; // Tell backend to add this in
    }

    // Fire ONE single request to the database
    fetch(CMS_URL, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
    }).catch(() => {});
};

window.toggleReactionPicker = function(id) {
    const picker = document.getElementById('picker_' + id);
    if (picker) picker.classList.toggle('show');
};

// Close all open pickers if clicked outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.reaction-picker-wrapper')) {
        document.querySelectorAll('.reaction-picker-popover.show').forEach(p => p.classList.remove('show'));
    }
});

window.toggleReadReceipt = function(id) {
    const popover = document.getElementById('receipt-popover_' + id);
    if (!popover) return;
    const isOpen = popover.classList.contains('show');
    document.querySelectorAll('.read-receipt-popover.show').forEach(p => p.classList.remove('show'));
    if (!isOpen) popover.classList.add('show');
};

document.addEventListener('click', (e) => {
    if (!e.target.closest('.read-receipt')) {
        document.querySelectorAll('.read-receipt-popover.show').forEach(p => p.classList.remove('show'));
    }
});

// --- REACTION LIVE POLLING ---
let _reactionPollInterval = null;

async function pollReactions() {
    try {
        const response = await fetch(`${CMS_URL}?v=${Date.now()}`);
        const data = await response.json();
        if (!data.announcements) return;

        const currentUser = sessionStorage.getItem('speeksUserName');
        const cleanUser = currentUser ? String(currentUser).trim().toLowerCase() : null;
        const availableEmojis = ['👍', '🎉', '👀', '🔥', '🫡', '💵'];

        // If any announcement isn't rendered yet, a new one was posted — reload the full list
        const hasNew = data.announcements.some(item => !document.getElementById(`reactions_${item.rowId}`));
        if (hasNew) { loadCMS(); return; }

        data.announcements.forEach(item => {
            const annId = item.rowId;
            if (!document.getElementById(`reactions_${annId}`)) return;

            const rData = item.reactions || {};
            availableEmojis.forEach((emoji, eIdx) => {
                const btn = document.getElementById(`btn_${annId}_${eIdx}`);
                if (!btn || btn.hasAttribute('disabled')) return;

                const usersList = Array.isArray(rData[emoji]) ? rData[emoji] : [];
                const count = usersList.length;
                const hasReacted = cleanUser ? usersList.some(u => String(u).trim().toLowerCase() === cleanUser) : false;

                const countSpan = btn.querySelector('.count');
                if (countSpan) countSpan.innerText = count;
                btn.style.display = count > 0 ? 'flex' : 'none';
                btn.classList.toggle('reacted', hasReacted);

                if (usersList.length > 0) {
                    btn.setAttribute('title', `Reacted by: ${usersList.join(', ')}`);
                } else {
                    btn.removeAttribute('title');
                }
            });
        });
    } catch (e) {}
}

function startReactionPolling() {
    if (_reactionPollInterval) clearInterval(_reactionPollInterval);
    _reactionPollInterval = setInterval(pollReactions, 15000);
}

// --- 4B. MODULE: INFO TICKER ---
const _TICKER_PPS = 40;
const _TICKER_DEFAULTS = [
    { icon: '⭐', text: 'Ask every customer for a Google Review — every one counts', _type: 'static' },
    { icon: '📋', text: 'Use the Margin Guide for every offer', _type: 'static' },
    { icon: '📦', text: 'Listing efficiency is key — process fast, list faster', _type: 'static' },
    { icon: '💬', text: 'Use PayMore and SPEEKS Discord for buying & listing help', _type: 'static' },
];

let _tickerAnnouncement   = null;
let _tickerChampions      = null;
let _tickerLeaderboard    = null;
let _tickerStatic         = [];
let _tickerShown          = false;
let _tickerIniting        = false;

// Each source gets a Promise; we await all of them before starting the ticker.
let _tickerSrcResolvers   = {};
let _tickerSrcPromises    = {};

function _tickerResetSources() {
    ['static', 'cms', 'hub', 'champions'].forEach(name => {
        _tickerSrcPromises[name] = new Promise(resolve => { _tickerSrcResolvers[name] = resolve; });
    });
}
_tickerResetSources();

function _tickerSourceDone(name) {
    if (_tickerSrcResolvers[name]) _tickerSrcResolvers[name]();
}

// Always assemble items in fixed order: announcement → champions → leaderboard → static
function _getOrderedTickerItems() {
    const items = [];
    if (_tickerAnnouncement) items.push(_tickerAnnouncement);
    if (_tickerChampions)    items.push(_tickerChampions);
    if (_tickerLeaderboard)  items.push(_tickerLeaderboard);
    items.push(..._tickerStatic);
    return items.length ? items : [..._TICKER_DEFAULTS];
}

function _syncLayout() {
    const nav = document.querySelector('.top-nav');
    const ticker = document.getElementById('infoTicker');
    if (!nav) return;
    const navH = Math.round(nav.getBoundingClientRect().height);
    const tickerH = document.body.classList.contains('is-authenticated') ? 32 : 0;
    const totalTop = navH + tickerH;
    if (ticker) ticker.style.top = navH + 'px';
    document.documentElement.style.setProperty('--panel-top', totalTop + 'px');
}

async function initTicker() {
    if (_tickerIniting || _tickerShown) return;
    _tickerIniting = true;
    const ticker = document.getElementById('infoTicker');
    if (!ticker) { _tickerIniting = false; return; }

    requestAnimationFrame(_syncLayout);
    const nav = document.querySelector('.top-nav');
    if (nav && window.ResizeObserver) new ResizeObserver(_syncLayout).observe(nav);
    window.addEventListener('resize', _syncLayout);

    // Wait until all 4 sources check in, or 12 s absolute max
    await Promise.race([
        Promise.allSettled(Object.values(_tickerSrcPromises)),
        new Promise(r => setTimeout(r, 12000))
    ]);

    if (_tickerShown) return;
    _tickerShown = true;

    if (!_tickerLeaderboard && typeof cachedLeaderboardData !== 'undefined' && cachedLeaderboardData) {
        feedLeaderboardToTicker(cachedLeaderboardData);
    }
    _loadCachedLeaderboard();
    _loadCachedChampions();
    _applyTickerContent();
}

function _resetTicker() {
    const track = document.getElementById('tickerTrack');
    if (track) {
        if (track._tickerLoopHandler) {
            track.removeEventListener('animationend', track._tickerLoopHandler);
            track._tickerLoopHandler = null;
        }
        track.style.animation = 'none';
        track.innerHTML = '';
    }
    _tickerAnnouncement = null;
    _tickerChampions    = null;
    _tickerLeaderboard  = null;
    _tickerStatic       = [];
    _tickerShown        = false;
    _tickerIniting      = false;
    _tickerResetSources();
    loadTickerItems();
    initTicker();
}

function _applyTickerContent() {
    const track = document.getElementById('tickerTrack');
    if (!track) return;
    const sep  = '<span class="ticker-sep">◆</span>';
    const html = _getOrderedTickerItems().map(item =>
        `<span class="ticker-item"><span class="t-icon">${item.icon}</span>${escapeHtml(item.text)}</span>${sep}`
    ).join('');
    track.innerHTML = html + html;
    track.style.animation = 'none';
    void track.offsetHeight;
    const cw   = track.scrollWidth / 2;
    const ctnW = (track.parentElement ? track.parentElement.offsetWidth : 0);
    const durIntro = ((ctnW + cw) / _TICKER_PPS).toFixed(1);
    const durLoop  = (cw / _TICKER_PPS).toFixed(1);
    let styleEl = document.getElementById('_tickerKeyframes');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = '_tickerKeyframes';
        document.head.appendChild(styleEl);
    }
    // Phase 1: enter from right and scroll through all content exactly once.
    // Phase 2: seamless infinite loop (translateX(0) == translateX(-cw) visually
    //          because content is doubled, so the cut is invisible).
    styleEl.textContent = [
        `@keyframes ticker-intro{from{transform:translateX(${ctnW}px)}to{transform:translateX(${-cw}px)}}`,
        `@keyframes ticker-loop{from{transform:translateX(0px)}to{transform:translateX(${-cw}px)}}`
    ].join('');
    // Clean up any leftover listener from a previous call (admin save, etc.)
    if (track._tickerLoopHandler) {
        track.removeEventListener('animationend', track._tickerLoopHandler);
    }
    track._tickerLoopHandler = function onIntroEnd() {
        track.removeEventListener('animationend', track._tickerLoopHandler);
        track._tickerLoopHandler = null;
        track.style.animation = 'none';
        void track.offsetHeight;
        track.style.animation = `ticker-loop ${durLoop}s linear infinite`;
    };
    track.addEventListener('animationend', track._tickerLoopHandler);
    track.style.animation = `ticker-intro ${durIntro}s linear`;
}

function feedAnnouncementsToTicker(announcements) {
    if (!announcements || !announcements.length) { _tickerAnnouncement = null; return; }
    const isHighPriority = announcements.some(a => a.text && (a.text.includes('HIGH PRIORITY') || a.text.includes('🚨')));
    _tickerAnnouncement = {
        icon: isHighPriority ? '🚨' : '📣',
        text: isHighPriority ? 'High Priority Announcement — check the bell!' : 'New Announcement posted — check the bell!',
        _type: 'announcement'
    };
}

function feedLeaderboardToTicker(leaderboardData) {
    if (!leaderboardData || !leaderboardData.activeStores) return;
    const stores = leaderboardData.activeStores;
    const getLeader = (data) => {
        const norm = {};
        Object.keys(data).forEach(k => norm[k.toLowerCase()] = data[k]);
        const scores = stores.map(s => {
            const arr = (norm[String(s).toLowerCase()] || []).filter(v => v !== null && v !== undefined && v !== '');
            return { store: s, val: arr.length ? (parseFloat(arr[arr.length - 1]) || 0) : 0 };
        }).sort((a, b) => b.val - a.val);
        return scores.length && scores[0].val > 0 ? scores[0].store : null;
    };
    const gpLeader = getLeader(leaderboardData.gp || {});
    const revLeader = getLeader(leaderboardData.revenue || {});
    let text;
    if (gpLeader && revLeader && gpLeader !== revLeader) {
        text = `Monthly GP Leader: ${gpLeader}  ·  Revenue Leader: ${revLeader}`;
    } else if (gpLeader || revLeader) {
        text = `${gpLeader || revLeader} is leading district GP & Revenue this month`;
    }
    if (text) {
        _tickerLeaderboard = { icon: '🏆', text, _type: 'leaderboard' };
        localStorage.setItem('_tickerLeaderboardCache', JSON.stringify(_tickerLeaderboard));
    } else {
        const cached = localStorage.getItem('_tickerLeaderboardCache');
        if (cached) try { _tickerLeaderboard = JSON.parse(cached); } catch (_) {}
    }
}

function _loadCachedLeaderboard() {
    if (_tickerLeaderboard) return;
    const cached = localStorage.getItem('_tickerLeaderboardCache');
    if (cached) try { _tickerLeaderboard = JSON.parse(cached); } catch (_) {}
}

function feedChampionsToTicker(allBuyers, allListers, allGoogleReviews) {
    const getTop = (arr, key) => {
        if (!arr.length) return null;
        const merged = {};
        arr.forEach(e => {
            if (!merged[e.name]) merged[e.name] = { ...e };
            else merged[e.name][key] = Math.max(merged[e.name][key], e[key]);
        });
        return Object.values(merged).sort((a, b) => b[key] - a[key])[0] || null;
    };
    const topBuyer = getTop(allBuyers, 'score');
    const topLister = getTop(allListers, 'listed');
    const topReviewer = getTop(allGoogleReviews, 'reviews');
    const parts = [];
    if (topBuyer)    parts.push(`Buying: ${topBuyer.name} (${topBuyer.store})`);
    if (topLister)   parts.push(`Listing: ${topLister.name} (${topLister.store})`);
    if (topReviewer) parts.push(`Reviews: ${topReviewer.name} (${topReviewer.store})`);
    if (parts.length) {
        _tickerChampions = { icon: '🥇', text: 'Weekly Champions — ' + parts.join('  ·  '), _type: 'champions' };
        localStorage.setItem('_tickerChampionsCache', JSON.stringify(_tickerChampions));
    } else {
        const cached = localStorage.getItem('_tickerChampionsCache');
        if (cached) try { _tickerChampions = JSON.parse(cached); } catch (_) {}
    }
}

function _loadCachedChampions() {
    if (_tickerChampions) return;
    const cached = localStorage.getItem('_tickerChampionsCache');
    if (cached) try { _tickerChampions = JSON.parse(cached); } catch (_) {}
}

async function loadTickerItems() {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    let loaded = false;
    try {
        const res = await fetch(`${TICKER_URL}?v=${Date.now()}`, { signal: controller.signal });
        const data = await res.json();
        if (data.items && data.items.length > 0) {
            localStorage.setItem('_tickerStaticCache', JSON.stringify(data.items));
            _tickerStatic = data.items.map(item => ({ icon: item.icon || '📌', text: item.text, _type: 'static' }));
            loaded = true;
        }
    } catch (e) { console.warn('[Ticker] AppScript fetch failed — using cache:', e); }
    if (!loaded) {
        try {
            const cached = JSON.parse(localStorage.getItem('_tickerStaticCache') || '[]');
            if (cached.length > 0) {
                _tickerStatic = cached.map(item => ({ icon: item.icon || '📌', text: item.text, _type: 'static' }));
            }
        } catch (_) {}
    }
    clearTimeout(tid);
    _tickerSourceDone('static');
}

const TICKER_EMOJIS = [
    '⭐','🌟','🏆','🥇','🎯','🔥','💡','📣',
    '📋','📦','💬','📊','📈','📉','🔔','📌',
    '✅','❌','⚠️','ℹ️','🚨','💰','💳','🛒',
    '📱','💻','🖥️','📷','🎮','🔧','⚡','🔑',
    '📝','🗓️','⏰','🚀','💪','👍','🤝','💼',
    '🎖️','🏅','🎁','🎉','👀','📢','🔍','💎',
    '🌐','🛍️','🧩','🏠','🎵','🎬','📚','🎪'
];

let _tickerPickerListenerAdded = false;

async function toggleManageTicker() {
    const dropdown = document.getElementById('manageTickerDropdown');
    if (!dropdown) return;
    const isOpen = dropdown.classList.contains('show');
    closeAllModals();
    if (!isOpen) {
        dropdown.classList.add('show');
        lockAndBlurScreen();
        if (!_tickerPickerListenerAdded) {
            _tickerPickerListenerAdded = true;
            document.addEventListener('click', function(e) {
                if (!e.target.closest('.t-icon-wrap')) {
                    document.querySelectorAll('.emoji-picker-panel.show').forEach(p => p.classList.remove('show'));
                }
            });
        }
        const list = document.getElementById('manageTickerList');
        list.innerHTML = '<div class="status-message">Loading...</div>';
        try {
            const res = await fetch(`${TICKER_URL}?v=${Date.now()}`);
            const data = await res.json();
            list.innerHTML = '';
            const items = data.items || [];
            if (items.length === 0) { addTickerRow(); } else { items.forEach(addTickerRow); }
        } catch (e) {
            list.innerHTML = '<div style="color:var(--red-alert); padding:20px; text-align:center;">Failed to load ticker items.</div>';
        }
    }
}

function addTickerRow(item = { icon: '📌', text: '' }) {
    const row = document.createElement('div');
    row.className = 'manage-row ticker-manage-row';
    const icon = item.icon || '📌';
    const text = item.text || '';
    const emojiGrid = TICKER_EMOJIS.map(e =>
        `<span class="emoji-option" data-emoji="${e}" onclick="selectTickerEmoji(this)">${e}</span>`
    ).join('');
    row.innerHTML = `
        <div class="t-icon-wrap">
            <button type="button" class="t-icon-btn" onclick="toggleEmojiPicker(this)" title="Pick emoji">${icon}</button>
            <input type="hidden" class="t-icon" value="${escapeHtml(icon)}">
            <div class="emoji-picker-panel"><div class="emoji-picker-grid">${emojiGrid}</div></div>
        </div>
        <input type="text" class="t-text" placeholder="Ticker message..." value="${escapeHtml(text)}">
        <button class="del-btn" onclick="this.closest('.manage-row').remove()" title="Remove">✖</button>
    `;
    document.getElementById('manageTickerList').appendChild(row);
}

function toggleEmojiPicker(btn) {
    const panel = btn.parentElement.querySelector('.emoji-picker-panel');
    const isOpen = panel.classList.contains('show');
    document.querySelectorAll('.emoji-picker-panel.show').forEach(p => p.classList.remove('show'));
    if (!isOpen) panel.classList.add('show');
}

function selectTickerEmoji(span) {
    const emoji = span.dataset.emoji;
    const wrap = span.closest('.t-icon-wrap');
    wrap.querySelector('.t-icon-btn').textContent = emoji;
    wrap.querySelector('.t-icon').value = emoji;
    wrap.querySelector('.emoji-picker-panel').classList.remove('show');
}

async function saveTickerItems() {
    const btn = document.getElementById('saveTickerBtn');
    const items = [];
    document.querySelectorAll('#manageTickerList .manage-row').forEach(row => {
        const text = row.querySelector('.t-text').value.trim();
        if (text) items.push({ icon: row.querySelector('.t-icon').value.trim() || '📌', text });
    });
    btn.textContent = 'Saving...';
    btn.style.opacity = '0.7';
    try {
        await fetch(TICKER_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ items }) });
        _tickerStatic = items.length ? items.map(item => ({ icon: item.icon, text: item.text, _type: 'static' })) : [..._TICKER_DEFAULTS];
        if (_tickerShown) _applyTickerContent();
        closeAllModals();
    } catch (e) {
        alert('Failed to save ticker items.');
    } finally {
        btn.textContent = 'Save Changes';
        btn.style.opacity = '1';
    }
}

// --- 5. MODULE: USER MANAGEMENT ---
let globalUsersData = [];

async function toggleManageUsers() {
    const dropdown = document.getElementById('manageUsersDropdown');
    if (!dropdown) return;
    
    const isOpen = dropdown.classList.contains('show');
    closeAllModals(); 
    
    if (!isOpen) {
        dropdown.classList.add('show');
        lockAndBlurScreen(); 

        const list = document.getElementById('manageUsersList');
        list.innerHTML = '<div class="status-message">Loading...</div>';
        
        try {
            let cachedData = localStorage.getItem('speeksAuthCache');
            let data = cachedData ? JSON.parse(cachedData) : null;
            
            if (!data) {
                list.innerHTML = '<div class="status-message">Syncing Database...</div>';
                const res = await fetch(`${AUTH_URL}?v=${Date.now()}`);
                data = await res.json();
                localStorage.setItem('speeksAuthCache', JSON.stringify(data));
            }
            
            globalUsersData = data.users || [];
            populateUsersModal();
            
            fetch(`${AUTH_URL}?v=${Date.now()}`).then(r => r.json()).then(newData => {
                localStorage.setItem('speeksAuthCache', JSON.stringify(newData));
            }).catch(e => {});

        } catch (e) {
            list.innerHTML = '<div style="color:var(--red-alert); padding:20px; text-align:center;">Failed to sync data.</div>';
        }
    }
}

function populateUsersModal() {
    const list = document.getElementById('manageUsersList');
    list.innerHTML = '';
    if (globalUsersData.length === 0) {
        addManageUserRow();
    } else {
        globalUsersData.forEach(user => addManageUserRow(user));
    }
}

function addManageUserRow(user = { name: '', pin: '', store: 'LEE', role: 'Employee' }) {
    const row = document.createElement('div');
    row.className = 'user-manage-row';

    const stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL', 'CORP'];
    const roles = ['CEO', 'District Manager', 'Owner (Manager)', 'Manager', 'Assistant Manager', 'Employee', 'Training', 'TOM'];

    const storeOptions = stores.map(s => `<option value="${s}" ${(user.store || '').toUpperCase() === s ? 'selected' : ''}>${s}</option>`).join('');
    const roleOptions = roles.map(r => `<option value="${r}" ${(user.role || '').toLowerCase() === r.toLowerCase() ? 'selected' : ''}>${r}</option>`).join('');

    row.innerHTML = `
        <input type="text" class="u-name" placeholder="Full Name" value="${user.name}" style="flex: 2;">
        <input type="text" class="u-pin" placeholder="PIN" maxlength="4" value="${user.pin}" style="flex: 1; max-width: 80px;" oninput="this.value = this.value.replace(/[^0-9]/g, '').slice(0,4)">
        <select class="u-store" style="flex: 1;">${storeOptions}</select>
        <select class="u-role" style="flex: 1.5;">${roleOptions}</select>
        <button class="del-btn" onclick="this.parentElement.remove()" title="Delete User">✖</button>
    `;
    document.getElementById('manageUsersList').appendChild(row);
}

async function saveManageUsers() {
    const btn = document.getElementById('saveUsersBtn');
    const updatedUsers = [];
    let valid = true;

    document.querySelectorAll('.user-manage-row').forEach(row => {
        const name = row.querySelector('.u-name').value.trim();
        const pin = row.querySelector('.u-pin').value.trim();
        const store = row.querySelector('.u-store').value;
        const role = row.querySelector('.u-role').value;

        if (name || pin) {
            if (pin.length !== 4) {
                alert(`Error: The PIN for ${name || 'a user'} must be exactly 4 digits.`);
                valid = false;
            }
            updatedUsers.push({ name, pin, store, role });
        }
    });

    if (!valid) return;

    btn.textContent = "Saving...";
    btn.style.opacity = "0.7";

    try {
        const res = await fetch(AUTH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(updatedUsers)
        });

        if (res.ok) {
            alert("Database successfully updated!");
            if (typeof startAuthFetch === 'function') startAuthFetch(); 
            closeAllModals();
        } else {
            alert("Error saving users.");
        }
    } catch (e) {
        console.error(e);
        alert("Failed to connect to server.");
    } finally {
        btn.textContent = "Save Changes";
        btn.style.opacity = "1";
    }
}

// --- 6. MODULE: HUB / HOTKEYS ---
async function loadHotkeys() {
    const tbody = document.getElementById('kbBody');
    if (!tbody) return;
    
    try {
        const response = await fetch(`${HOTKEYS_URL}?v=${Date.now()}`);
        const data = await response.json();
        
        tbody.innerHTML = data.map(item => {
            const brand = item.brand || "";
            if (brand.toLowerCase() === "brand" || !brand) return '';
            
            return `<tr>
                <td><span class="bubble b-generic">${brand}</span></td>
                <td>${item.device}</td>
                <td>${item.hotkey}</td>
                <td>${item.func}</td>
            </tr>`;
        }).join('');
    } catch (e) {
        console.error("Failed to load hotkeys", e);
    }
}

function filterKB() {
    const searchEl = document.getElementById("kbSearch");
    const kbBody = document.getElementById("kbBody");
    if (!searchEl || !kbBody) return;
    const filter = searchEl.value.toUpperCase();
    const rows = kbBody.getElementsByTagName("tr");
    
    for (let i = 0; i < rows.length; i++) {
        const textContent = rows[i].textContent || rows[i].innerText;
        rows[i].style.display = textContent.toUpperCase().includes(filter) ? "" : "none";
    }
}

// --- 7. MODULE: DOCS & POLICIES ---
let globalDocsData = []; 

async function toggleManageDocs() {
    const dropdown = document.getElementById('manageDocsDropdown');
    if (!dropdown) return;
    
    const isOpen = dropdown.classList.contains('show');
    closeAllModals();
    
    if (!isOpen) {
        dropdown.classList.add('show');
        lockAndBlurScreen();

        const list = document.getElementById('manageDocsList');
        
        if (!globalDocsData || globalDocsData.length === 0) {
            list.innerHTML = '<div class="status-message">Syncing Data...</div>';
            try {
                const res = await fetch(`${DOCS_URL}?v=${Date.now()}`);
                globalDocsData = await res.json();
                localStorage.setItem('speeksDocsData', JSON.stringify(globalDocsData));
                populateManageModal();
            } catch (e) {
                list.innerHTML = '<div style="color:var(--red-alert); padding:20px; text-align:center;">Failed to load policies.</div>';
            }
        } else {
            populateManageModal();
        }
    }
}

function populateManageModal() {
    const list = document.getElementById('manageDocsList');
    list.innerHTML = '';
    
    if (globalDocsData.length === 0) {
        addManageRow();
    } else {
        globalDocsData.forEach(doc => addManageRow(doc));
    }
}

function addManageRow(doc = { category: '', icon: '📄', title: '', desc: '', link: '' }) {
    let baseCat = doc.category || '';
    let isPinned = baseCat.toLowerCase().includes('pinned');
    
    if (isPinned) {
        baseCat = baseCat.replace(/,?\s*["']?pinned["']?/ig, '').trim();
    }

    const row = document.createElement('div'); 
    row.className = 'manage-row';
    row.innerHTML = `
        <input type="text" class="m-category" placeholder="Category" value="${baseCat}">
        <label class="pin-label">
            <input type="checkbox" class="m-pinned" ${isPinned ? 'checked' : ''}> Pin
        </label>
        <input type="text" class="m-icon" placeholder="Icon" value="${doc.icon || ''}">
        <input type="text" class="m-title" placeholder="Title" value="${doc.title || ''}">
        <textarea class="m-desc" placeholder="Description">${doc.desc || ''}</textarea>
        <input type="text" class="m-link" placeholder="URL Link" value="${doc.link || ''}">
        <button class="del-btn" onclick="this.parentElement.remove()" title="Delete">✖</button>
    `;
    document.getElementById('manageDocsList').appendChild(row);
}

async function saveDocs() {
    const btn = document.getElementById('saveDocsBtn');
    const updatedDocs = [];
    
    document.querySelectorAll('.manage-row').forEach(row => {
        const title = row.querySelector('.m-title').value.trim();
        if (title) {
            let category = row.querySelector('.m-category').value.trim();
            if (row.querySelector('.m-pinned').checked) {
                category = category ? `${category}, Pinned` : 'Pinned';
            }
            
            updatedDocs.push({
                category: category,
                icon: row.querySelector('.m-icon').value.trim(), 
                title: title,
                desc: row.querySelector('.m-desc').value.trim(), 
                link: row.querySelector('.m-link').value.trim()
            });
        }
    });

    btn.textContent = "Saving..."; 
    btn.style.opacity = "0.7";
    
    try {
        const res = await fetch(DOCS_URL, { method: 'POST', body: JSON.stringify(updatedDocs) });
        if (res.ok) {
            globalDocsData = updatedDocs; 
            localStorage.setItem('speeksDocsData', JSON.stringify(updatedDocs));
            renderDocs(updatedDocs); 
            closeAllModals();
        } else {
            alert("Error saving data.");
        }
    } catch (e) { 
        alert("Failed to connect to server."); 
    } finally { 
        btn.textContent = "Save Changes"; 
        btn.style.opacity = "1"; 
    }
}

function renderDocs(docs) {
    const container = document.getElementById('content-container');
    if (!container) return;
    
    if (!docs || docs.length === 0) {
        container.innerHTML = '<div class="empty-state">No documents found.</div>';
        return;
    }
    
    const groupedDocs = {};
    docs.forEach(doc => {
        let cleanCat = (doc.category || "Uncategorized").replace(/,?\s*["']?pinned["']?/ig, '').trim() || "General"; 
        if (!groupedDocs[cleanCat]) groupedDocs[cleanCat] = [];
        groupedDocs[cleanCat].push(doc);
        
        if ((doc.category || "").toLowerCase().includes('pinned')) {
            if (!groupedDocs['📌 Pinned']) groupedDocs['📌 Pinned'] = [];
            groupedDocs['📌 Pinned'].push(doc);
        }
    });

    container.innerHTML = Object.keys(groupedDocs)
        .sort((a, b) => a === '📌 Pinned' ? -1 : (b === '📌 Pinned' ? 1 : a.localeCompare(b)))
        .map(cat => {
            const isPin = cat === '📌 Pinned';
            const catTitleStyle = isPin ? 'color: var(--sage-professional); border-bottom-color: var(--sage-professional);' : '';
            
            let html = `<div class="category-section">`;
            html += `<div class="category-title" style="${catTitleStyle}">${cat}</div>`;
            html += `<div class="docs-grid">`;
            
            html += groupedDocs[cat].map(item => {
                const searchStr = `${item.title} ${item.desc} ${cat}`.toLowerCase();
                const cardStyle = isPin ? 'position: relative; border: 1px solid var(--sage-professional); box-shadow: 0 4px 10px rgba(90, 141, 59, 0.08);' : 'position: relative;';
                const pinBadge = isPin ? `<div style="position: absolute; top: 12px; right: 15px; font-size: 16px; filter: drop-shadow(0 2px 4px rgba(90,141,59,0.3));">📌</div>` : '';
                
                return `
                    <a href="${item.link}" target="_blank" class="doc-card" style="${cardStyle}" data-search="${searchStr}">
                        ${pinBadge}
                        <div class="doc-icon">${item.icon}</div>
                        <div class="doc-info">
                            <div class="doc-title">${item.title}</div>
                            <div class="doc-desc">${item.desc}</div>
                        </div>
                    </a>`;
            }).join('');
            
            html += `</div></div>`;
            return html;
        }).join('');
        
    filterDocs();
}

async function loadDocs() {
    const cached = localStorage.getItem('speeksDocsData');
    if (cached) {
        try { 
            globalDocsData = JSON.parse(cached);
            renderDocs(globalDocsData); 
        } catch (e) {}
    } else {
        document.getElementById('content-container').innerHTML = '<div class="empty-state">Syncing Data...</div>';
    }

    try {
        const response = await fetch(`${DOCS_URL}?v=${Date.now()}`);
        globalDocsData = await response.json();
        localStorage.setItem('speeksDocsData', JSON.stringify(globalDocsData));
        renderDocs(globalDocsData);
    } catch (e) { 
        if (!cached) {
            document.getElementById('content-container').innerHTML = '<div class="empty-state">Failed to load documents.</div>'; 
        }
    }
}

function filterDocs() {
    const searchInput = document.getElementById('docSearch');
    const search = searchInput ? searchInput.value.toLowerCase() : "";
    let hasVis = false;

    document.querySelectorAll('.category-section').forEach(s => {
        const catTitle = s.querySelector('.category-title')?.innerText.toLowerCase() || "";
        const isPinnedSection = catTitle.includes('pinned');

        if (isPinnedSection && search.length > 0) {
            s.classList.add('hidden');
            s.querySelectorAll('.doc-card').forEach(c => c.classList.add('hidden'));
        } else {
            let sectionHasVis = false;
            s.querySelectorAll('.doc-card').forEach(c => {
                const match = c.getAttribute('data-search').includes(search);
                c.classList.toggle('hidden', !match);
                if (match) sectionHasVis = true;
            });
            s.classList.toggle('hidden', !sectionHasVis);
            if (sectionHasVis) hasVis = true;
        }
    });

    const noResults = document.getElementById('noResults');
    if (noResults) noResults.classList.toggle('hidden', hasVis || search === '');
}


// --- 8. MODULE: AUTH & DASHBOARD CORE UTILITIES ---
let dynamicMonths = [];
let rawKPIData = [];
let monthlyKpiCache = {};
let weeklyKpiCache = {};
let liveVarianceDataCache = {};
let hubDataCache = null;
let authFetchPromise = null;

function startAuthFetch() { 
    authFetchPromise = fetch(`${AUTH_URL}?v=${Date.now()}`)
        .then(r => {
            if (r.ok) {
                return r.json().then(data => {
                    localStorage.setItem('speeksAuthCache', JSON.stringify(data));
                    return data;
                });
            }
            return null;
        })
        .catch(() => null); 
}

let _pinAutoTimer = null;

function handlePINAutoTrigger() {
    const input = document.getElementById('pinInput');
    const btn = document.getElementById('unlockBtn');

    if (_pinAutoTimer) {
        clearTimeout(_pinAutoTimer);
        _pinAutoTimer = null;
        btn.classList.remove('loading');
    }

    if (input.value.length === 4) {
        input.classList.add('pin-filled');
        btn.classList.add('loading');
        _pinAutoTimer = setTimeout(() => {
            _pinAutoTimer = null;
            checkPIN();
        }, 900);
    } else {
        input.classList.remove('pin-filled');
    }
}

async function checkPIN() {
    const pin = document.getElementById('pinInput').value;
    const err = document.getElementById('pinError');
    const btn = document.getElementById('unlockBtn');

    if (!pin) return;

    if (_pinAutoTimer) { clearTimeout(_pinAutoTimer); _pinAutoTimer = null; }

    btn.classList.add('loading');
    err.style.display = 'none';

    try {
        let cachedData = localStorage.getItem('speeksAuthCache');
        let payload = cachedData ? JSON.parse(cachedData) : null;
        
        if (!payload) {
            payload = await authFetchPromise;
        }

        if (!payload || !payload.users) throw new Error("Could not load users.");
        
        const matched = payload.users.find(u => u.pin === String(pin));
        
        if (matched) {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserName', matched.name);
            sessionStorage.setItem('speeksUserRole', matched.role ? matched.role.toLowerCase() : 'employee');
            sessionStorage.setItem('speeksUserStore', matched.store ? matched.store.toUpperCase() : 'ALL');
            sessionStorage.setItem('speeksUserPin', matched.pin);
            
            const authOverlay = document.getElementById('authOverlay');
            if (authOverlay) authOverlay.style.display = 'none'; 
            
            document.documentElement.classList.remove('no-scroll');
            document.body.classList.remove('no-scroll');
            document.documentElement.style.overflow = '';
            document.body.style.overflow = '';
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.classList.add('is-authenticated');

            closeAllModals();
            applyRoleBasedUI();
            checkAndShowTutorial(matched.name);

            if (typeof initDashboardData === 'function') initDashboardData();
            initTicker();
        } else {
            err.innerText = "Incorrect PIN. Please try again.";
            err.style.display = 'block';
            document.getElementById('pinInput').value = '';
        }
    } catch (e) {
        console.error(e);
        err.innerText = "Connection Error."; 
        err.style.display = 'block'; 
    } finally {
        btn.classList.remove('loading');
        document.getElementById('pinInput').classList.remove('pin-filled');
    }
}

function generateSparklineSVG(dataArray) {
    const valid = (dataArray || [])
        .map(v => parseFloat(String(v).replace(/[$,%]/g, '')))
        .filter(n => !isNaN(n));
        
    if (!valid.length) return '';
    
    const min = Math.min(...valid);
    const range = Math.max(...valid) - min || 1;
    
    const pathData = valid.map((v, i) => {
        const x = 2 + (i / (valid.length - 1)) * 66;
        const y = 2 + 16 - ((v - min) / range) * 16;
        return `${x},${y}`;
    }).join(' L ');
    
    return `<svg class="sparkline" viewBox="0 0 70 20"><path d="M ${pathData}"></path></svg>`;
}

function toggleCategory(el) { 
    el.parentElement.classList.toggle('collapsed'); 
}

function groupKPIs(data) {
    const cats = {
        "Buying Metrics":    [],
        "No Deal Tracking":  [],
        "Listings":          [],
        "Rankings & Reviews":[],
        "Other Metrics":     [],
    };

    let all = [];
    if (Array.isArray(data)) {
        data.forEach(item => {
            if (item.metrics) all.push(...item.metrics);
            else if (item.name) all.push(item);
        });
    }

    all.forEach(m => {
        if (!m?.name) return;
        const n = m.name.toLowerCase();
        if (n.match(/buying value|buying cost|estimated gross profit|gross margin|transaction count|customer conversion|device count|device conversion|avg transaction/)) {
            cats["Buying Metrics"].push(m);
        } else if (n.match(/no deal count|no deal value|no deal cost|lost profit|% no deal/)) {
            cats["No Deal Tracking"].push(m);
        } else if (n.match(/listed count|listed retail|listed cost|listed sold|listed gross|% listed/)) {
            cats["Listings"].push(m);
        } else if (n.match(/google|paymore/)) {
            cats["Rankings & Reviews"].push(m);
        } else {
            cats["Other Metrics"].push(m);
        }
    });

    return Object.keys(cats)
        .map(c => ({ category: c, metrics: cats[c] }))
        .filter(g => g.metrics.length > 0);
}

// --- 9. MODULE: MONTHLY KPI DASHBOARD ---
async function fetchKPIData(isRetry = false) {
    const store = document.getElementById('kpiStoreSelect')?.value;
    const cont = document.getElementById('kpiDashboardContainer');
    
    if (!cont) return;

    // Helper to setup the Primary and Compare dropdowns
    const setDD = (primarySelect, compareSelect, monthArray) => {
        const currP = primarySelect.options[primarySelect.selectedIndex]?.text;
        const currC = compareSelect.options[compareSelect.selectedIndex]?.text;
        
        primarySelect.innerHTML = ''; 
        compareSelect.innerHTML = ''; 
        
        monthArray.forEach((m, i) => { 
            primarySelect.add(new Option(m, i)); 
            compareSelect.add(new Option(m, i)); 
        });
        
        primarySelect.value = monthArray.indexOf(currP) !== -1 ? monthArray.indexOf(currP) : monthArray.length - 1; 
        compareSelect.value = monthArray.indexOf(currC) !== -1 ? monthArray.indexOf(currC) : Math.max(0, monthArray.length - 2); 
    };

    const _syncAMSelects = () => {
        const amP = document.getElementById('am-primaryMonthSelect');
        const amC = document.getElementById('am-compareMonthSelect');
        if (amP && amC) {
            setDD(amP, amC, dynamicMonths);
            renderAMKPIDashboard();
        }
    };

    // Use cached data if available for instant loading
    if (monthlyKpiCache[store]) {
        dynamicMonths = monthlyKpiCache[store].months;
        rawKPIData = monthlyKpiCache[store].data;
        setDD(document.getElementById('primaryMonthSelect'), document.getElementById('compareMonthSelect'), dynamicMonths);
        _syncAMSelects();
        return renderKPIDashboard();
    }

    try {
        const response = await fetch(`${MONTHLY_KPI_URL}?store=${store}&v=${Date.now()}`);
        const payload = await response.json();

        monthlyKpiCache[store] = {
            months: payload.months,
            data: groupKPIs(payload.data)
        };

        dynamicMonths = monthlyKpiCache[store].months;
        rawKPIData = monthlyKpiCache[store].data;

        setDD(document.getElementById('primaryMonthSelect'), document.getElementById('compareMonthSelect'), dynamicMonths);
        _syncAMSelects();
        renderKPIDashboard();
    } catch (e) {
        console.error("Monthly KPI fetch failed:", e);
    }
}

function renderKPIDashboard(opts) {
    opts = opts || {};
    const storeId  = opts.storeId  || 'kpiStoreSelect';
    const pId      = opts.pId      || 'primaryMonthSelect';
    const cId      = opts.cId      || 'compareMonthSelect';
    const contId   = opts.contId   || 'kpiDashboardContainer';
    const pLabelId = opts.pLabelId || 'header-primary-label';
    const cLabelId = opts.cLabelId || 'header-compare-label';
    const vPrefix  = opts.vPrefix  || 'kpi-view';

    const store = document.getElementById(storeId).value;
    const pIdx = document.getElementById(pId).value;
    const cIdx = document.getElementById(cId).value;
    const cont = document.getElementById(contId);

    document.getElementById(pLabelId).innerText = dynamicMonths[pIdx];
    document.getElementById(cLabelId).innerText = dynamicMonths[cIdx];

    const vId = `${vPrefix}-${store}-${pIdx}-${cIdx}`;

    // Hide all existing views
    Array.from(cont.children).forEach(c => c.style.display = 'none');

    // If we've already built this specific comparison view, just show it
    if (document.getElementById(vId)) {
        return document.getElementById(vId).style.display = 'block';
    }

    setTimeout(() => {
        const newView = document.createElement('div');
        newView.id = vId;

        let html = '';

        rawKPIData.forEach(cat => {
            html += `
            <div class="kpi-category">
                <div class="kpi-category-header" onclick="toggleCategory(this)">
                    ${cat.category}
                    <span class="chevron">▼</span>
                </div>
                <div class="kpi-category-content">`;

            cat.metrics.forEach(m => {
                const rP = m.values[pIdx];
                const rC = m.values[cIdx];
                const dNum = parseNum(rP) - parseNum(rC);

                let dStr = m.name.toLowerCase().match(/%|rate|variance|margin|gm|cogs/)
                    ? `${Math.abs(dNum).toFixed(2).replace(/\.00$/, '')}%`
                    : formatSmartValue(Math.abs(dNum), m.name);

                let bClass = 'delta-neutral';
                let sign = '';

                if (Math.abs(dNum) > 0.001) {
                    sign = dNum > 0 ? '+' : '-';
                    bClass = dNum > 0 ? (m.inverse ? 'delta-neg' : 'delta-pos') : (m.inverse ? 'delta-pos' : 'delta-neg');
                } else {
                    dStr = '0';
                }

                html += `
                <div class="kpi-row">
                    <div class="kpi-name-col">
                        <span class="kpi-name">${m.name}</span>
                        ${generateSparklineSVG(m.values)}
                    </div>
                    <div class="kpi-value-col kpi-primary-val">${formatSmartValue(rP, m.name)}</div>
                    <div class="kpi-value-col" style="color: #888;">${formatSmartValue(rC, m.name)}</div>
                    <div class="kpi-delta-col">
                        <span class="delta-badge ${bClass}">${sign}${dStr}</span>
                    </div>
                </div>`;
            });

            html += `</div></div>`;
        });

        newView.innerHTML = html;
        cont.appendChild(newView);
    }, 10);
}

function renderAMKPIDashboard() {
    renderKPIDashboard({
        storeId:  'am-kpiStoreSelect',
        pId:      'am-primaryMonthSelect',
        cId:      'am-compareMonthSelect',
        contId:   'am-kpiDashboardContainer',
        pLabelId: 'am-header-primary-label',
        cLabelId: 'am-header-compare-label',
        vPrefix:  'am-kpi-view'
    });
}

// --- 10. MODULE: LIVE VARIANCE REPORTS ---
let _varianceSyncListener = null;
let _weeklyGridResizeListener = null;
function formatVariancePct(num) {
    return Math.abs(num) < 0.001 ? '0.00%' : `${num < 0 ? '-' : '+'}${Math.abs(num).toFixed(2)}%`; 
}

function createVarianceStoreCard(sKey) {
    if (sKey === "NONE" || !liveVarianceDataCache[sKey]?.employees) return '';

    const d = liveVarianceDataCache[sKey];
    const totalColorClass = d.total < 0 ? 'delta-neg' : (d.total > 0 ? 'delta-pos' : 'delta-neutral');

    let html = `
    <div style="border: 1px solid #eee; border-radius: 12px; background: white; overflow: hidden;">
        <div style="background: #f9fafb; padding: 15px 20px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: flex-start;">
            <span style="font-size: 16px; font-weight: 900; color: var(--slate-charcoal); text-transform: uppercase;">${sKey} TOTAL</span>
            <span class="delta-badge ${totalColorClass}" style="font-size: 16px; padding: 8px 14px;">${formatVariancePct(d.total)}</span>
        </div>
        <div class="vw-scroll-area" style="display: flex; flex-direction: column;">`;
        
    d.employees.forEach(e => {
        const empColorClass = e.val < 0 ? 'delta-neg' : (e.val > 0 ? 'delta-pos' : 'delta-neutral');
        html += `
            <div class="kpi-row" style="padding: 0 20px; height: 48px; grid-template-columns: 1fr auto; border-top: 1px solid #f5f5f5; border-radius: 0; border-left: none; border-right: none; margin: 0; background: white;">
                <span class="kpi-name">${e.name}</span>
                <span class="delta-badge ${empColorClass}">${formatVariancePct(e.val)}</span>
            </div>`;
    });
    
    html += `</div></div>`;
    return html;
}

function renderVariance() {
    const p = document.getElementById('vw-primary')?.value;
    const c = document.getElementById('vw-compare')?.value;
    const cont = document.getElementById('vw-dashboard-container');
    
    if (!cont || !p) return;
    
    cont.style.gridTemplateColumns = c === "NONE" ? "1fr" : "1fr 1fr"; 
    cont.innerHTML = createVarianceStoreCard(p) + createVarianceStoreCard(c);
    
    const dateSpan = document.getElementById('variance-date-display');
    if (dateSpan && liveVarianceDataCache[p]) {
        const d = liveVarianceDataCache[p];
        let pTxt = "Current";
        if (d.dateFrom && d.dateTo) {
            const fmt = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            pTxt = `${fmt(d.dateFrom)} – ${fmt(d.dateTo)}`;
        }
        dateSpan.innerText = pTxt;
    }

    // --- BULLETPROOF HEIGHT SYNC ENGINE ---
    setTimeout(() => {
        const varianceCard = cont.closest('.card');
        const kpiCard = document.querySelector('.kpi-master-card');
        
        if (varianceCard && kpiCard) {
            const syncHeights = () => {
                if (window.innerWidth > 1100) {
                    // 1. Temporarily stop the grid from stretching them so we can measure the TRUE height
                    varianceCard.style.alignSelf = 'start';
                    kpiCard.style.alignSelf = 'start';
                    
                    // 2. Strip any fixed heights to let them breathe
                    varianceCard.style.height = 'auto';
                    kpiCard.style.height = 'auto';
                    
                    // 3. Measure the TRUE, content-only height of the Variance card
                    const targetHeight = varianceCard.offsetHeight;
                    
                    // 4. Force the KPI card to match that exact pixel height!
                    kpiCard.style.setProperty('height', targetHeight + 'px', 'important');
                } else {
                    // Mobile behavior: Let them stack naturally
                    varianceCard.style.alignSelf = 'stretch';
                    kpiCard.style.alignSelf = 'stretch';
                    varianceCard.style.height = 'auto';
                    kpiCard.style.setProperty('height', '500px', 'important'); 
                }
            };
            
            syncHeights();

            // If the user resizes their window, re-sync the heights!
            if (_varianceSyncListener) window.removeEventListener('resize', _varianceSyncListener);
            _varianceSyncListener = syncHeights;
            window.addEventListener('resize', syncHeights);
        }
    }, 50); // 50ms delay gives the browser time to paint the HTML before we measure it
}

async function fetchVarianceData() {
    const cont = document.getElementById('vw-dashboard-container'); 
    if (!cont) return;
    
    try {
        const response = await fetch(`${VARIANCE_API_URL}?v=${Date.now()}`);
        const d = await response.json();
        
        if (d.error) {
            cont.innerHTML = `<div style="padding: 40px; text-align: center; color: #dc2626; font-weight: 600; grid-column: 1 / -1;">Error: ${d.error}</div>`;
            return;
        }
        
        liveVarianceDataCache = d; 
        renderVariance();
    } catch (e) { 
        cont.innerHTML = '<div style="padding: 40px; text-align: center; color: #dc2626; font-weight: 600; grid-column: 1 / -1;">Failed to sync Variance data.</div>'; 
    }
}

// --- 10b. VARIANCE INPUT TOOL ---
function toggleVarianceInput() {
    closeAllModals();
    const modal = document.getElementById('varianceInputModal');
    if (!modal) return;
    modal.classList.add('show');
    lockAndBlurScreen();
    loadVarianceStoreEmployees();
}

function loadVarianceStoreEmployees() {
    const store = document.getElementById('vi-store')?.value;
    const container = document.getElementById('vi-employees');
    if (!container || !store) return;
    container.innerHTML = '';

    // Get users for this store from auth cache
    let storeUsers = [];
    try {
        const authData = JSON.parse(localStorage.getItem('speeksAuthCache') || '{}');
        storeUsers = (authData.users || []).filter(u =>
            (u.store || '').toUpperCase() === store.toUpperCase() &&
            (u.role || '').toLowerCase() !== 'training'
        );
    } catch (_) {}

    // Build a map of existing variance % from the last report for this store
    const lastPcts = {};
    const cached = liveVarianceDataCache?.[store];
    if (cached?.employees?.length > 0) {
        cached.employees.forEach(e => { lastPcts[e.name.toLowerCase()] = e.val; });
    }

    if (storeUsers.length === 0) {
        container.innerHTML = '<div style="color:#888; font-size:13px; text-align:center; padding:10px;">No users found for this store.</div>';
        return;
    }

    storeUsers.forEach(u => {
        const existingPct = lastPcts[u.name.toLowerCase()] ?? '';
        addVarianceEmployeeRow(u.name, existingPct);
    });
}

function addVarianceEmployeeRow(name, pct) {
    const container = document.getElementById('vi-employees');
    if (!container) return;
    const row = document.createElement('div');
    row.style.cssText = 'display: grid; grid-template-columns: 1fr 110px; gap: 8px; align-items: center;';
    row.dataset.empName = name;
    row.innerHTML = `
        <span class="vi-emp-name" style="font-size: 13px; font-weight: 600; color: var(--slate-charcoal); padding: 0 4px;">${escapeHtml(String(name))}</span>
        <input type="number" class="form-input-lg vi-emp-pct" placeholder="%" step="0.01" value="${pct !== '' ? pct : ''}" style="margin: 0; text-align: right;">`;
    container.appendChild(row);
}

async function submitVarianceReport() {
    const store = document.getElementById('vi-store')?.value;
    const dateFrom = document.getElementById('vi-date-from')?.value;
    const dateTo = document.getElementById('vi-date-to')?.value;
    const storePct = parseFloat(document.getElementById('vi-store-pct')?.value);
    const btn = document.getElementById('vi-submit-btn');

    if (!store || !dateFrom || !dateTo || isNaN(storePct)) {
        alert('Please fill in the store, date range, and store variance %.');
        return;
    }
    if (dateFrom > dateTo) {
        alert('Date From must be before Date To.');
        return;
    }

    const employees = [];
    document.querySelectorAll('#vi-employees > div[data-emp-name]').forEach(row => {
        const name = row.dataset.empName;
        const pct = parseFloat(row.querySelector('.vi-emp-pct')?.value);
        if (name && !isNaN(pct)) employees.push({ name, pct });
    });

    btn.textContent = 'Submitting...';
    btn.disabled = true;

    try {
        const res = await fetch(VARIANCE_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ store, dateFrom, dateTo, storePct, employees })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        alert(`Variance report for ${store} submitted successfully!`);
        closeAllModals();
        fetchVarianceData();
    } catch (e) {
        alert('Failed to submit: ' + (e.message || 'Unknown error'));
    } finally {
        btn.textContent = 'Submit Report';
        btn.disabled = false;
    }
}

// --- 11. MODULE: WEEKLY KPI GRID ---
function formatTime(val) {
    if (!val) return ""; 
    let s = String(val).trim();
    if (!s.includes(':')) {
        return s.includes('.') ? s.split('.')[0] + ':' + (s.split('.')[1] + '0').substring(0,2) : (!isNaN(s) ? s + ':00' : s);
    }
    return s.length <= 5 ? s : s;
}

function checkRule(r, v) {
    if (!v) return false; 
    let n = parseNum(v);
    
    if (r === 'margin') return n < 51; 
    if (r === 'conversion') return n < 85; 
    if (r === 'nodeals') return n > 7;
    if (r === 'variance') return n < 0; // NEW: Negative variance turns red
    if (r === 'time') {
        const timeVal = String(v).includes(':') ? parseInt(v.split(':')[0]) + (parseInt(v.split(':')[1])/60) : n;
        return timeVal > 13;
    }
    return false;
}

async function fetchWeeklyKPIs() {
    const cont  = document.getElementById('weeklyKpiContainer');
    const store = document.getElementById('weeklyKpiStoreSelect')?.value;
    const pB    = document.getElementById('weeklyKpiPeriod');

    if (!cont || !store) return;

    cont.style.display = 'block';
    cont.classList.remove('weekly-kpi-grid');

    const vId = `weekly-view-${store}`;
    Array.from(cont.children).forEach(c => c.style.display = 'none');

    if (document.getElementById(vId)) {
        document.getElementById(vId).style.display = 'grid';
        pB.innerText = weeklyKpiCache[store]?.periodText || '';
        pB.style.display = weeklyKpiCache[store]?.periodText ? 'inline-block' : 'none';
        return;
    }

    let msg = document.getElementById('weekly-fetch-msg');
    if (!msg) {
        msg = document.createElement('div');
        msg.id = 'weekly-fetch-msg';
        msg.style.cssText = 'padding: 40px; text-align: center; color: #888; font-weight: 600;';
        cont.appendChild(msg);
    }
    msg.innerText = 'Syncing Data...';
    msg.style.display = 'block';

    try {
        const resp = await fetch(`${WEEKLY_KPI_URL}?store=${store}&v=${Date.now()}`);
        const d    = await resp.json();

        const emps  = d.employees   || [];
        const total = d.store_total || {};
        const pTxt  = d.period_label || '';

        weeklyKpiCache[store] = { periodText: pTxt };
        pB.innerText      = pTxt;
        pB.style.display  = pTxt ? 'inline-block' : 'none';

        if (!emps.length) {
            msg.innerText   = 'No data entered yet for this week.';
            msg.style.color = '#888';
            return;
        }

        msg.style.display = 'none';
        const nV = document.createElement('div');
        nV.id        = vId;
        nV.className = 'weekly-kpi-grid';
        nV.style.cssText = 'display:grid; gap:20px; align-items:start;';

        const applyGridColumns = () => {
            const w = nV.parentElement ? nV.parentElement.offsetWidth : window.innerWidth;
            if (w > 700)      nV.style.gridTemplateColumns = 'repeat(3, 1fr)';
            else if (w > 420) nV.style.gridTemplateColumns = 'repeat(2, 1fr)';
            else              nV.style.gridTemplateColumns = '1fr';
        };
        applyGridColumns();
        if (_weeklyGridResizeListener) window.removeEventListener('resize', _weeklyGridResizeListener);
        _weeklyGridResizeListener = applyGridColumns;
        window.addEventListener('resize', applyGridColumns);

        const fmt$ = v => (v != null && v !== '') ? `$${Math.round(Number(v)).toLocaleString()}` : '—';
        const fmtPct = v => (v != null && v !== '') ? `${Number(v).toFixed(1)}%` : '—';
        const fmtN   = v => (v != null && v !== '') ? String(v) : '—';
        const fmtMin = v => (v != null && v !== '') ? `${Number(v).toFixed(1)}` : '—';

        const buildCol = (title, storeMain, storeBadge, getMain, getBadge, ruleName, mainFmt, badgeFmt) => {
            let h = `<div style="border:1px solid #eee;border-radius:12px;background:white;overflow:hidden;display:flex;flex-direction:column;">
                <div style="background:#f9fafb;padding:15px;border-bottom:1px solid #eee;text-align:center;">
                    <h4 style="font-size:12px;font-weight:800;color:var(--slate-charcoal);text-transform:uppercase;margin-bottom:10px;letter-spacing:0.5px;white-space:nowrap;">${title}</h4>
                    <div style="display:grid;grid-template-columns:1fr 75px 55px;align-items:center;background:white;padding:0 12px;height:40px;border-radius:8px;border:1px solid #eee;gap:8px;">
                        <span style="font-size:11px;font-weight:800;color:#888;text-align:left;">STORE TOTAL</span>
                        <span style="font-size:13px;font-weight:800;text-align:right;white-space:nowrap;color:${checkRule(ruleName,storeMain)?'var(--red-alert)':'var(--slate-charcoal)'};">${mainFmt(storeMain)}</span>`;
            h += storeBadge != null
                ? `<span style="display:flex;justify-content:flex-end;"><span class="delta-badge ${checkRule(ruleName,storeBadge)?'delta-neg':'delta-neutral'}">${badgeFmt(storeBadge)}</span></span>`
                : `<span></span>`;
            h += `</div></div><div style="display:flex;flex-direction:column;">`;
            emps.forEach(e => {
                const mv = getMain(e), bv = getBadge ? getBadge(e) : null;
                h += `<div class="kpi-row" style="display:grid;grid-template-columns:1fr 75px 55px;align-items:center;padding:0 15px;height:48px;border-top:1px solid #f5f5f5;background:white;margin:0;border-left:none;border-right:none;gap:8px;">
                    <span class="kpi-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${e.employee_name}</span>
                    <span style="text-align:right;font-size:12px;font-weight:${checkRule(ruleName,mv)?'900':'700'};color:${checkRule(ruleName,mv)?'var(--red-alert)':'#555'};white-space:nowrap;">${mainFmt(mv)}</span>`;
                h += bv != null
                    ? `<span style="display:flex;justify-content:flex-end;"><span class="delta-badge ${checkRule(ruleName,bv)?'delta-neg':'delta-neutral'}">${badgeFmt(bv)}</span></span>`
                    : `<span></span>`;
                h += `</div>`;
            });
            h += `</div></div>`;
            return h;
        };

        nV.innerHTML =
            buildCol('Buying Performance',
                total.buying_value,          total.gross_margin_pct,
                e => e.buying_value,         e => e.gross_margin_pct,
                'margin', fmt$, fmtPct) +
            buildCol('Customer Conversion',
                total.transaction_count,     total.customer_conversion_pct,
                e => e.transaction_count,    e => e.customer_conversion_pct,
                'conversion', fmtN, fmtPct) +
            buildCol('No Deals',
                total.no_deal_count,         total.no_deal_vs_buying_pct,
                e => e.no_deal_count,        e => e.no_deal_vs_buying_pct,
                null, fmtN, fmtPct) +
            buildCol('Avg Trans. Time',
                total.avg_transaction_time,  null,
                e => e.avg_transaction_time, null,
                null, fmtMin, null) +
            buildCol('Listed / Sold',
                total.listed_count,          total.listed_sold_pct,
                e => e.listed_count,         e => e.listed_sold_pct,
                null, fmtN, fmtPct);

        cont.appendChild(nV);

    } catch (e) {
        msg.innerText   = 'Failed to load Weekly KPI.';
        msg.style.color = '#dc2626';
    }
}

// --- 11b. MODULE: KPI VIEW / ENTRY ---

let _kpiCurrentTab     = 'weekly';
let _kpiPeriodsData    = [];   // [{ period_end_date, period_label, is_editable, entries[] }]
let _kpiEditingPeriod  = null; // period_end_date string currently in edit mode

// Keep these for backward compat with saveKpiEntry
let _kpiEntryPeriodType    = 'weekly';
let _kpiEntryPeriodEndDate = '';
let _kpiEntryData          = [];


// ── KPI Grid constants ────────────────────────────────────────────────────────
const _KPI_GRID_FIELDS = [
    { key: 'buying_value',            step: '0.01', computed: false },
    { key: 'buying_cost',             step: '0.01', computed: false },
    { key: 'estimated_gross_profit',               computed: true  },
    { key: 'gross_margin_pct',                     computed: true  },
    { key: 'transaction_count',       step: '1',   computed: false },
    { key: 'transaction_converted',   step: '1',   computed: false },
    { key: 'customer_conversion_pct',              computed: true  },
    { key: 'device_count',            step: '1',   computed: false },
    { key: 'device_converted',        step: '1',   computed: false },
    { key: 'device_conversion_pct',                computed: true  },
    { key: 'avg_transaction_time',    step: '0.1', computed: false },
    { key: 'no_deal_count',           step: '1',   computed: false },
    { key: 'no_deal_value',           step: '0.01',computed: false },
    { key: 'no_deal_cost',            step: '0.01',computed: false },
    { key: 'lost_profit',                          computed: true  },
    { key: 'no_deal_vs_buying_pct',                computed: true  },
    { key: 'listed_count',            step: '1',   computed: false },
    { key: 'listed_retail_price',     step: '0.01',computed: false },
    { key: 'listed_cost',             step: '0.01',computed: false },
    { key: 'listed_sold_value',       step: '0.01',computed: false },
    { key: 'listed_gross_margin_pct',              computed: true  },
    { key: 'listed_sold_pct',                      computed: true  },
    { key: 'mtd_google_reviews',      step: '1',   computed: false },
];
const _KPI_INPUT_FIELDS = _KPI_GRID_FIELDS.filter(f => !f.computed).map(f => f.key);
const _KPI_INT_FIELDS   = new Set(['transaction_count','transaction_converted','device_count','device_converted','no_deal_count','listed_count','mtd_google_reviews']);

// ── Derived-field calculator ──────────────────────────────────────────────────
function _kpiCalcDerived(entry) {
    const bv  = Number(entry.buying_value)          || 0;
    const bc  = Number(entry.buying_cost)           || 0;
    const tc  = Number(entry.transaction_count)     || 0;
    const tco = Number(entry.transaction_converted) || 0;
    const dc  = Number(entry.device_count)          || 0;
    const dco = Number(entry.device_converted)      || 0;
    const ndv = Number(entry.no_deal_value)         || 0;
    const ndc = Number(entry.no_deal_cost)          || 0;
    const lrp = Number(entry.listed_retail_price)   || 0;
    const lc  = Number(entry.listed_cost)           || 0;
    const lsv = Number(entry.listed_sold_value)     || 0;
    const gp  = bv - bc;
    const r2  = n => n !== null ? Math.round(n * 100) / 100 : null;
    return {
        ...entry,
        estimated_gross_profit:  gp,
        gross_margin_pct:        bv  > 0 ? r2((1 - bc  / bv)  * 100) : null,
        customer_conversion_pct: tc  > 0 ? r2((tco / tc)  * 100)     : null,
        device_conversion_pct:   dc  > 0 ? r2((dco / dc)  * 100)     : null,
        lost_profit:             ndv - ndc,
        no_deal_vs_buying_pct:   gp  > 0 ? r2(((ndv - ndc) / gp) * 100) : null,
        listed_gross_margin_pct: lrp > 0 ? r2((1 - lc  / lrp) * 100)    : null,
        listed_sold_pct:         lrp > 0 ? r2((lsv / lrp) * 100)         : null,
    };
}

function _kpiFormatComputed(key, val) {
    if (val == null || val === '') return '—';
    const n = Number(val);
    if (isNaN(n)) return '—';
    const pctKeys = ['gross_margin_pct','customer_conversion_pct','device_conversion_pct',
                     'no_deal_vs_buying_pct','listed_gross_margin_pct','listed_sold_pct'];
    const dollarKeys = ['estimated_gross_profit','lost_profit','buying_value','buying_cost',
                        'no_deal_value','no_deal_cost','listed_retail_price','listed_cost','listed_sold_value'];
    if (pctKeys.includes(key))    return n.toFixed(1) + '%';
    if (dollarKeys.includes(key)) return '$' + Math.round(n).toLocaleString();
    if (key === 'avg_transaction_time') return n.toFixed(1);
    return String(Math.round(n * 10) / 10);
}

function _kpiComputeAverages(periods) {
    if (!periods || !periods.length) return [];
    const empNames = periods[0].entries.map(e => e.employee_name);
    return empNames.map(name => {
        const empRows = periods.map(p => p.entries.find(e => e.employee_name === name)).filter(Boolean);
        const avg = { employee_name: name };
        _KPI_INPUT_FIELDS.forEach(f => {
            const vals = empRows.map(e => e[f]).filter(v => v != null && v !== '' && !isNaN(Number(v)));
            avg[f] = vals.length ? vals.reduce((a, b) => a + Number(b), 0) / vals.length : null;
        });
        return _kpiCalcDerived(avg);
    });
}

// ── HTML builders ─────────────────────────────────────────────────────────────
function _kpiTheadHtml() {
    return '<colgroup>' +
        '<col class="col-name">' +
        '<col span="2" class="col-buying-input"><col span="2" class="col-computed">' +
        '<col span="2" class="col-buying-input"><col class="col-computed">' +
        '<col span="2" class="col-buying-input"><col class="col-computed">' +
        '<col class="col-buying-input">' +
        '<col span="3" class="col-nd-input"><col span="2" class="col-computed">' +
        '<col span="4" class="col-listing-input"><col span="2" class="col-computed">' +
        '<col class="col-review-input">' +
        '</colgroup>' +
        '<thead><tr>' +
        '<th rowspan="2" class="kpi-grid-th kpi-grid-name-col">Employee</th>' +
        '<th colspan="11" class="kpi-grid-section-header kpi-section-buying">Buying</th>' +
        '<th colspan="5"  class="kpi-grid-section-header kpi-section-nodeals">No Deals</th>' +
        '<th colspan="6"  class="kpi-grid-section-header kpi-section-listings">Listings</th>' +
        '<th colspan="1"  class="kpi-grid-section-header kpi-section-reviews">Reviews</th>' +
        '</tr><tr>' +
        '<th class="kpi-grid-th kpi-col-input">Buy Value</th>' +
        '<th class="kpi-grid-th kpi-col-input">Buy Cost</th>' +
        '<th class="kpi-grid-th kpi-col-computed">Est. GP</th>' +
        '<th class="kpi-grid-th kpi-col-computed">Margin %</th>' +
        '<th class="kpi-grid-th kpi-col-input"># Trans.</th>' +
        '<th class="kpi-grid-th kpi-col-input"># Conv.</th>' +
        '<th class="kpi-grid-th kpi-col-computed">Conv %</th>' +
        '<th class="kpi-grid-th kpi-col-input"># Devices</th>' +
        '<th class="kpi-grid-th kpi-col-input"># Dev Conv.</th>' +
        '<th class="kpi-grid-th kpi-col-computed">Dev Conv %</th>' +
        '<th class="kpi-grid-th kpi-col-input">Avg Time</th>' +
        '<th class="kpi-grid-th kpi-col-input"># No Deals</th>' +
        '<th class="kpi-grid-th kpi-col-input">ND Value</th>' +
        '<th class="kpi-grid-th kpi-col-input">ND Cost</th>' +
        '<th class="kpi-grid-th kpi-col-computed">Lost Profit</th>' +
        '<th class="kpi-grid-th kpi-col-computed">% vs Buy GP</th>' +
        '<th class="kpi-grid-th kpi-col-input"># Listed</th>' +
        '<th class="kpi-grid-th kpi-col-input">Retail ($)</th>' +
        '<th class="kpi-grid-th kpi-col-input">Cost ($)</th>' +
        '<th class="kpi-grid-th kpi-col-input">Sold ($)</th>' +
        '<th class="kpi-grid-th kpi-col-computed">Listed Margin</th>' +
        '<th class="kpi-grid-th kpi-col-computed">% Sold</th>' +
        '<th class="kpi-grid-th kpi-col-input">Google Reviews</th>' +
        '</tr></thead>';
}

function _kpiSectionDividerHtml(label, badge, badgeClass, controls, borderColor) {
    const bdg = badge ? '<span class="kpi-section-badge ' + badgeClass + '">' + badge + '</span>' : '';
    return '<tr class="kpi-section-divider-row"><td colspan="24"><div class="kpi-section-header-inner" style="border-left:4px solid ' + borderColor + ';">' +
        '<div class="align-center gap-8"><span class="kpi-section-label">' + label + '</span>' + bdg + '</div>' +
        '<div class="align-center gap-8">' + controls + '</div>' +
        '</div></td></tr>';
}

function _kpiSectionControls(periodDate, isEditing, isEditable) {
    const pk = periodDate.replace(/-/g, '');
    if (!isEditable) return '<span class="kpi-readonly-label">🔒 Read only</span>';
    if (isEditing) {
        return '<button class="kpi-cancel-btn" onclick="_kpiCancelEdit()">Cancel</button>' +
               '<button class="kpi-save-section-btn" id="kpiSaveBtn-' + pk + '" onclick="_kpiSavePeriod(\'' + periodDate + '\')">Save</button>';
    }
    return '<button class="kpi-edit-section-btn" onclick="_kpiStartEdit(\'' + periodDate + '\')">✏️ Edit</button>';
}

function _kpiEmpRowsHtml(entries, periodDate, isEditing, isAvg) {
    const pk = periodDate.replace(/-/g, '');
    return entries.map(function(entry, empIdx) {
        const hasSaved = !!entry.id;
        const sc = hasSaved ? '#16a34a' : 'transparent';
        const rowClass = isAvg ? 'kpi-avg-row' : (empIdx % 2 === 1 ? 'kpi-row-alt' : '');
        let cells = '<td class="kpi-grid-name-col"><div class="kpi-grid-name-cell">' +
            '<span class="kpi-grid-emp-name">' + entry.employee_name + '</span>' +
            (!isAvg ? '<span class="kpi-grid-status" id="kpiS-' + pk + '-' + empIdx + '" style="color:' + sc + '" title="' + (hasSaved ? 'Saved' : '') + '">' + (hasSaved ? '✓' : '') + '</span>' : '') +
            '</div></td>';
        _KPI_GRID_FIELDS.forEach(function(f) {
            if (f.computed || isAvg) {
                cells += '<td class="kpi-grid-computed' + (isAvg ? ' kpi-avg-cell' : '') + '" id="kpiC-' + pk + '-' + empIdx + '-' + f.key + '">' + _kpiFormatComputed(f.key, entry[f.key]) + '</td>';
            } else {
                const val = entry[f.key] != null ? entry[f.key] : '';
                const dis = isEditing ? '' : 'disabled';
                cells += '<td class="kpi-grid-td-input"><input class="kpi-grid-input" type="number" step="' + f.step + '" min="0" id="kpi-' + pk + '-' + empIdx + '-' + f.key + '" value="' + val + '" ' + dis + ' oninput="_kpiUpdateRow(\'' + pk + '\',' + empIdx + ')"></td>';
            }
        });
        return '<tr class="' + rowClass + '" data-period="' + periodDate + '">' + cells + '</tr>';
    }).join('');
}

function _kpiUpdateRow(pk, empIdx) {
    const g   = function(k) { var el = document.getElementById('kpi-' + pk + '-' + empIdx + '-' + k); return el ? (Number(el.value) || 0) : 0; };
    const bv  = g('buying_value'),        bc  = g('buying_cost');
    const tc  = g('transaction_count'),   tco = g('transaction_converted');
    const dc  = g('device_count'),        dco = g('device_converted');
    const ndv = g('no_deal_value'),       ndc = g('no_deal_cost');
    const lrp = g('listed_retail_price'),  lc = g('listed_cost'), lsv = g('listed_sold_value');
    const gp  = bv - bc;
    const r2  = function(n) { return n !== null ? Math.round(n * 100) / 100 : null; };
    const computed = {
        estimated_gross_profit:  gp,
        gross_margin_pct:        bv  > 0 ? r2((1-bc/bv)*100)        : null,
        customer_conversion_pct: tc  > 0 ? r2((tco/tc)*100)         : null,
        device_conversion_pct:   dc  > 0 ? r2((dco/dc)*100)         : null,
        lost_profit:             ndv - ndc,
        no_deal_vs_buying_pct:   gp  > 0 ? r2(((ndv-ndc)/gp)*100)  : null,
        listed_gross_margin_pct: lrp > 0 ? r2((1-lc/lrp)*100)      : null,
        listed_sold_pct:         lrp > 0 ? r2((lsv/lrp)*100)        : null,
    };
    Object.keys(computed).forEach(function(key) {
        const el = document.getElementById('kpiC-' + pk + '-' + empIdx + '-' + key);
        if (el) el.textContent = _kpiFormatComputed(key, computed[key]);
    });
    const statusEl = document.getElementById('kpiS-' + pk + '-' + empIdx);
    if (statusEl) { statusEl.textContent = '●'; statusEl.style.color = '#f59e0b'; statusEl.title = 'Unsaved'; }
}

function _kpiStoreTotalRowHtml(entries) {
    // Sum all numeric input fields; average avg_transaction_time
    const totals = { employee_name: 'Store Total' };
    _KPI_INPUT_FIELDS.forEach(function(f) {
        if (f === 'avg_transaction_time') {
            const vals = entries.map(function(e) { return Number(e[f]); }).filter(function(v) { return v > 0 && !isNaN(v); });
            totals[f] = vals.length ? vals.reduce(function(a, b) { return a + b; }, 0) / vals.length : null;
        } else {
            const vals = entries.map(function(e) { return Number(e[f]); }).filter(function(v) { return v != null && !isNaN(v); });
            totals[f] = vals.length ? vals.reduce(function(a, b) { return a + b; }, 0) : null;
        }
    });
    const computed = _kpiCalcDerived(totals);
    let cells = '<td class="kpi-grid-name-col kpi-total-name-col"><div class="kpi-grid-name-cell"><span class="kpi-grid-emp-name kpi-total-emp-name">Store Total</span></div></td>';
    _KPI_GRID_FIELDS.forEach(function(f) {
        cells += '<td class="kpi-grid-computed kpi-total-cell">' + _kpiFormatComputed(f.key, computed[f.key]) + '</td>';
    });
    return '<tr class="kpi-total-row">' + cells + '</tr>';
}

function _kpiWeekRangeLabel(periodEndDate) {
    const end = new Date(periodEndDate + 'T12:00:00');
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sm = months[start.getMonth()], sd = start.getDate();
    const em = months[end.getMonth()],   ed = end.getDate();
    return 'Week ' + sm + ' ' + sd + ' - ' + em + ' ' + ed;
}

function _kpiRenderWeekly(periods) {
    const body = document.getElementById('kpiModalBody');
    if (!body) return;
    const store = sessionStorage.getItem('speeksUserStore') || '';
    const sub = document.getElementById('kpiModalSubtitle');
    if (sub) sub.textContent = store + ' · 4-Week View';
    if (!periods || !periods.length) {
        body.innerHTML = '<div class="kpi-empty-state">No weekly KPI data yet. Click Edit on the current week to get started.</div>';
        return;
    }
    const wkBadges  = ['Current Week','Last Week','2 Weeks Ago','3 Weeks Ago'];
    const wkBClass  = ['badge-current','badge-prev','badge-old','badge-old'];
    let tbody = '';
    periods.forEach(function(p, i) {
        const isEd = _kpiEditingPeriod === p.period_end_date;
        tbody += _kpiSectionDividerHtml('📅 ' + _kpiWeekRangeLabel(p.period_end_date), wkBadges[i] || '', wkBClass[i] || 'badge-old',
            _kpiSectionControls(p.period_end_date, isEd, p.is_editable), '#3b82f6');
        tbody += _kpiEmpRowsHtml(p.entries, p.period_end_date, isEd, false);
        const hasSavedData = p.entries.some(function(e) { return e.id; });
        if (hasSavedData) tbody += _kpiStoreTotalRowHtml(p.entries);
    });
    body.innerHTML = '<div class="kpi-grid-scroll-wrapper"><table class="kpi-entry-grid kpi-full-table">' + _kpiTheadHtml() + '<tbody>' + tbody + '</tbody></table></div>';
}

function _kpiExportCSV() {
    if (!_kpiPeriodsData || !_kpiPeriodsData.length) return;
    const store = sessionStorage.getItem('speeksUserStore') || 'STORE';
    const isWeekly = _kpiCurrentTab === 'weekly';

    const headers = [
        'Period','Employee',
        'Buy Value','Buy Cost','Est. GP','Margin %',
        '# Trans','# Conv.','Conv. %',
        '# Devices','# Dev Conv.','Dev Conv. %',
        'Avg Time (min)',
        '# No Deals','ND Value','ND Cost','Lost Profit','% vs Buy GP',
        '# Listed','Retail ($)','Cost ($)','Sold ($)','Listed Margin %','% Sold',
        'Google Reviews'
    ];

    const csvRows = [headers];

    _kpiPeriodsData.forEach(function(p) {
        const label = isWeekly ? _kpiWeekRangeLabel(p.period_end_date) : p.period_label;
        p.entries.forEach(function(raw) {
            const e = _kpiCalcDerived(raw);
            const r2 = function(v) { return v == null ? '' : Math.round(v * 100) / 100; };
            csvRows.push([
                label,
                e.employee_name,
                r2(e.buying_value),       r2(e.buying_cost),
                r2(e.estimated_gross_profit), r2(e.gross_margin_pct),
                r2(e.transaction_count),  r2(e.transaction_converted), r2(e.customer_conversion_pct),
                r2(e.device_count),       r2(e.device_converted),      r2(e.device_conversion_pct),
                r2(e.avg_transaction_time),
                r2(e.no_deal_count),      r2(e.no_deal_value),         r2(e.no_deal_cost),
                r2(e.lost_profit),        r2(e.no_deal_vs_buying_pct),
                r2(e.listed_count),       r2(e.listed_retail_price),   r2(e.listed_cost),
                r2(e.listed_sold_value),  r2(e.listed_gross_margin_pct), r2(e.listed_sold_pct),
                r2(e.mtd_google_reviews)
            ]);
        });
    });

    const csv = csvRows.map(function(row) {
        return row.map(function(v) {
            const s = String(v);
            return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(',');
    }).join('\r\n');

    const tab = isWeekly ? 'Weekly' : 'Monthly';
    const ts  = new Date().toISOString().slice(0, 10);
    const filename = store + '_KPI_' + tab + '_' + ts + '.csv';

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// --- 11c. MODULE: MONTHLY PERFORMANCE BRIEF (district-level, DM-editable) ---
let _mbData = {};        // { period_end_date: { metric_key: value } }
let _mbMonths = [];      // sorted date strings
let _mbMetrics = [];     // catalog [{key,label,type,section}]
let _mbEditable = '';    // editable period_end_date
let _mbEditing = false;

function _mbMonthLabel(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function _mbFmt(type, v) {
    if (v == null || v === '' || isNaN(Number(v))) return '—';
    const n = Number(v);
    if (type === 'money')  return '$' + Math.round(n).toLocaleString();
    if (type === 'pct')    return n.toFixed(1) + '%';
    if (type === 'rating') return n.toFixed(1) + ' ★';
    if (type === 'int')    return Math.round(n).toLocaleString();
    return String(Math.round(n * 10) / 10);
}

// Metrics where a DECREASE is good (lower = better). All others: increase = good.
const _MB_INVERSE = new Set([
    'avg_transaction_time', 'inventory_cost', 'inventory_cost_under_30', 'pct_inventory_over_30',
    'recycled_inventory', 'recycled_pct_inventory', 'inventory_confiscation',
    'refunds', 'discounts', 'return_rate', 'shipping_label_cost', 'shipping_cost_pct_sales',
    'paymore_ranking', 'defect_rate', 'late_shipment_rate', 'case_no_resolution',
]);

// Absolute difference (primary − compare), signed and formatted by type.
function _mbFmtDelta(type, diff) {
    const s = diff > 0 ? '+' : (diff < 0 ? '-' : '');
    const a = Math.abs(diff);
    if (type === 'money')  return s + '$' + Math.round(a).toLocaleString();
    if (type === 'pct')    return s + a.toFixed(1) + ' pts';
    if (type === 'rating') return s + a.toFixed(1);
    if (type === 'int')    return s + Math.round(a).toLocaleString();
    return s + (Math.round(a * 10) / 10);
}

async function fetchMonthlyBrief() {
    const body = document.getElementById('mbBody');
    if (!body) return;
    const sel = document.getElementById('mbStoreSelect');
    let store = sel ? sel.value : (sessionStorage.getItem('speeksUserStore') || 'OVL');
    // Managers without the picker default to their own store
    if (sel && sel.offsetParent === null) { store = sessionStorage.getItem('speeksUserStore') || store; }
    _mbEditing = false;
    body.innerHTML = '<div class="status-message">Syncing Performance Brief…</div>';
    try {
        const d = await fetch(`${MONTHLY_BRIEF_URL}?store=${store}&v=${Date.now()}`).then(r => r.json());
        _mbData     = d.data || {};
        _mbMonths   = d.months || [];
        _mbMetrics  = d.metrics || [];
        _mbEditable = d.editable_period || '';
        _mbPopulateMonthSelects();
        renderMonthlyBrief();
    } catch (e) {
        body.innerHTML = '<div class="status-message" style="color:var(--red-alert)">Failed to load brief.</div>';
    }
}

function _mbPopulateMonthSelects() {
    const pSel = document.getElementById('mbPrimaryMonth');
    const cSel = document.getElementById('mbCompareMonth');
    if (!pSel || !cSel) return;
    const desc = [..._mbMonths].sort().reverse(); // newest first
    const opts = desc.map(m => `<option value="${m}">${_mbMonthLabel(m)}</option>`).join('');
    const prevP = pSel.value, prevC = cSel.value;
    pSel.innerHTML = opts;
    cSel.innerHTML = opts;
    // Default: primary = newest, compare = previous month
    pSel.value = (prevP && desc.includes(prevP)) ? prevP : desc[0];
    cSel.value = (prevC && desc.includes(prevC)) ? prevC : (desc[1] || desc[0]);
}

function renderMonthlyBrief() {
    const body = document.getElementById('mbBody');
    if (!body) return;
    const pDate = document.getElementById('mbPrimaryMonth')?.value;
    const cDate = document.getElementById('mbCompareMonth')?.value;
    if (!pDate) { body.innerHTML = '<div class="status-message">No data available.</div>'; return; }

    // Edit button only for DM, and only when the primary selection is the editable month
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const isDM = role === 'district manager';
    const canEdit = isDM && pDate === _mbEditable;
    const editBtn = document.getElementById('mbEditBtn');
    if (editBtn) editBtn.style.display = (canEdit && !_mbEditing) ? 'inline-block' : 'none';
    document.getElementById('mbSaveBtn').style.display   = (_mbEditing) ? 'inline-block' : 'none';
    document.getElementById('mbCancelBtn').style.display = (_mbEditing) ? 'inline-block' : 'none';

    const pVals = _mbData[pDate] || {};
    const cVals = _mbData[cDate] || {};

    // Group metrics by section
    const sections = [];
    const bySection = {};
    _mbMetrics.forEach(m => {
        if (!bySection[m.section]) { bySection[m.section] = []; sections.push(m.section); }
        bySection[m.section].push(m);
    });

    let html = '<table class="mb-table"><thead><tr>' +
        '<th class="mb-th-metric">Metric</th>' +
        '<th class="mb-th-val">' + _mbMonthLabel(pDate) + '</th>' +
        '<th class="mb-th-val">' + _mbMonthLabel(cDate) + '</th>' +
        '<th class="mb-th-delta">Δ</th>' +
        '</tr></thead><tbody>';

    sections.forEach(sec => {
        html += '<tr class="mb-section-row"><td colspan="4">' + sec + '</td></tr>';
        bySection[sec].forEach(m => {
            const pv = pVals[m.key];
            const cv = cVals[m.key];
            let primaryCell;
            if (_mbEditing && canEdit) {
                const step = (m.type === 'int') ? '1' : (m.type === 'rating' ? '0.1' : '0.01');
                primaryCell = '<input class="mb-input" type="number" step="' + step + '" id="mb-in-' + m.key + '" value="' + (pv != null ? pv : '') + '">';
            } else {
                primaryCell = _mbFmt(m.type, pv);
            }
            // Delta = primary column − compare column. Color by whether the change
            // is good for THIS metric (some metrics are better when they drop).
            let delta = '—', deltaCls = '';
            if (pv != null && cv != null && !isNaN(pv) && !isNaN(cv)) {
                const diff = Number(cv) - Number(pv);
                delta = _mbFmtDelta(m.type, diff);
                if (diff !== 0) {
                    const good = _MB_INVERSE.has(m.key) ? (diff < 0) : (diff > 0);
                    deltaCls = good ? 'mb-up' : 'mb-down';
                }
            }
            html += '<tr class="mb-row">' +
                '<td class="mb-metric-name">' + m.label + '</td>' +
                '<td class="mb-val mb-val-primary">' + primaryCell + '</td>' +
                '<td class="mb-val">' + _mbFmt(m.type, cv) + '</td>' +
                '<td class="mb-delta ' + deltaCls + '">' + delta + '</td>' +
                '</tr>';
        });
    });

    html += '</tbody></table>';
    body.innerHTML = html;
}

function mbStartEdit() {
    _mbEditing = true;
    // Force primary to the editable month
    const pSel = document.getElementById('mbPrimaryMonth');
    if (pSel && _mbEditable) {
        if (![...pSel.options].some(o => o.value === _mbEditable)) {
            pSel.add(new Option(_mbMonthLabel(_mbEditable), _mbEditable), 0);
        }
        pSel.value = _mbEditable;
    }
    renderMonthlyBrief();
}

function mbCancelEdit() {
    _mbEditing = false;
    renderMonthlyBrief();
}

async function mbSaveBrief() {
    const store = document.getElementById('mbStoreSelect')?.value || sessionStorage.getItem('speeksUserStore');
    const pin   = sessionStorage.getItem('speeksUserPin');
    if (!pin) { alert('Session expired — please sign in again.'); return; }

    const values = {};
    _mbMetrics.forEach(m => {
        const el = document.getElementById('mb-in-' + m.key);
        if (el) values[m.key] = el.value === '' ? null : Number(el.value);
    });

    const saveBtn = document.getElementById('mbSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
        const resp = await fetch(MONTHLY_BRIEF_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-pin': pin },
            body: JSON.stringify({ store, period_end_date: _mbEditable, values }),
        });
        const result = await resp.json();
        if (!resp.ok || result.error) throw new Error(result.error || 'Save failed');
        // Merge saved values into local cache
        _mbData[_mbEditable] = Object.assign({}, _mbData[_mbEditable] || {}, values);
        if (!_mbMonths.includes(_mbEditable)) { _mbMonths.push(_mbEditable); _mbPopulateMonthSelects(); }
        _mbEditing = false;
        renderMonthlyBrief();
    } catch (e) {
        alert('Could not save: ' + e.message);
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    }
}

function _kpiRenderMonthly(periods) {
    const body = document.getElementById('kpiModalBody');
    if (!body) return;
    const store = sessionStorage.getItem('speeksUserStore') || '';
    const sub = document.getElementById('kpiModalSubtitle');
    if (sub) sub.textContent = store + ' · Monthly';
    if (!periods || !periods.length) {
        body.innerHTML = '<div class="kpi-empty-state">No monthly KPI data yet. Click Edit on the current month to get started.</div>';
        return;
    }
    const moBadges  = ['Current Month','Last Month'];
    const moBClass  = ['badge-current','badge-prev'];
    let tbody = '';
    periods.forEach(function(p, i) {
        const isEd = _kpiEditingPeriod === p.period_end_date;
        tbody += _kpiSectionDividerHtml('📆 ' + p.period_label, i < 2 ? moBadges[i] : null, i < 2 ? moBClass[i] : '',
            _kpiSectionControls(p.period_end_date, isEd, p.is_editable), '#7c3aed');
        tbody += _kpiEmpRowsHtml(p.entries, p.period_end_date, isEd, false);
        const hasSavedData = p.entries.some(function(e) { return e.id; });
        if (hasSavedData) tbody += _kpiStoreTotalRowHtml(p.entries);
    });
    body.innerHTML = '<div class="kpi-grid-scroll-wrapper"><table class="kpi-entry-grid kpi-full-table">' + _kpiTheadHtml() + '<tbody>' + tbody + '</tbody></table></div>';
}

async function _kpiLoadAll(tab) {
    const modalSel = document.getElementById('kpiModalStoreSelect');
    const store = (modalSel && modalSel.offsetParent !== null && modalSel.value) || sessionStorage.getItem('speeksUserStore');
    if (!store) return;
    const body = document.getElementById('kpiModalBody');
    if (body) body.innerHTML = '<div class="kpi-empty-state">Loading…</div>';
    try {
        const resp = await fetch(KPI_MANAGE_URL + '?store=' + store + '&period_type=' + tab + '&v=' + Date.now());
        const data = await resp.json();
        _kpiPeriodsData = data.periods || [];
        if (tab === 'weekly') _kpiRenderWeekly(_kpiPeriodsData);
        else                  _kpiRenderMonthly(_kpiPeriodsData);
    } catch(e) {
        if (body) body.innerHTML = '<div class="kpi-empty-state" style="color:var(--red-alert)">Failed to load KPI data.</div>';
    }
}

function toggleDmKpiPicker(e) {
    e.stopPropagation();
    const dd = document.getElementById('dmKpiDropdown');
    if (!dd) return;
    const open = dd.classList.toggle('open');
    if (open) {
        const close = () => { dd.classList.remove('open'); document.removeEventListener('click', close); };
        setTimeout(() => document.addEventListener('click', close), 0);
    }
}

async function openKpiEntryPanelForStore(store, tab) {
    const sel = document.getElementById('kpiModalStoreSelect');
    if (sel) sel.value = store;
    await openKpiEntryPanel(tab);
}

async function openKpiEntryPanel(tab) {
    _kpiCurrentTab = tab || 'weekly';
    _kpiEditingPeriod = null;
    // Seed the modal store selector with the user's own store (managers); DMs keep whatever is selected
    const sel = document.getElementById('kpiModalStoreSelect');
    const userStore = sessionStorage.getItem('speeksUserStore');
    if (sel && userStore && sel.offsetParent === null) sel.value = userStore;
    document.getElementById('kpi-tab-weekly') && document.getElementById('kpi-tab-weekly').classList.toggle('active', _kpiCurrentTab === 'weekly');
    document.getElementById('kpi-tab-monthly') && document.getElementById('kpi-tab-monthly').classList.toggle('active', _kpiCurrentTab === 'monthly');
    toggleModal('kpiEntryModal');
    await _kpiLoadAll(_kpiCurrentTab);
}

async function switchKpiTab(tab) {
    _kpiCurrentTab = tab;
    _kpiEditingPeriod = null;
    document.getElementById('kpi-tab-weekly') && document.getElementById('kpi-tab-weekly').classList.toggle('active', tab === 'weekly');
    document.getElementById('kpi-tab-monthly') && document.getElementById('kpi-tab-monthly').classList.toggle('active', tab === 'monthly');
    await _kpiLoadAll(tab);
}

function _kpiStartEdit(periodDate) {
    if (_kpiEditingPeriod === periodDate) return;
    _kpiEditingPeriod = periodDate;
    if (_kpiCurrentTab === 'weekly') _kpiRenderWeekly(_kpiPeriodsData);
    else _kpiRenderMonthly(_kpiPeriodsData);
}

function _kpiCancelEdit() {
    _kpiEditingPeriod = null;
    if (_kpiCurrentTab === 'weekly') _kpiRenderWeekly(_kpiPeriodsData);
    else _kpiRenderMonthly(_kpiPeriodsData);
}

async function _kpiSavePeriod(periodDate) {
    const store = sessionStorage.getItem('speeksUserStore');
    const pin   = sessionStorage.getItem('speeksUserPin');
    if (!store || !pin) return;
    const pk     = periodDate.replace(/-/g, '');
    const period = _kpiPeriodsData.find(function(p) { return p.period_end_date === periodDate; });
    if (!period) return;
    const saveBtn = document.getElementById('kpiSaveBtn-' + pk);
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
    for (let empIdx = 0; empIdx < period.entries.length; empIdx++) {
        const entry   = period.entries[empIdx];
        const reqBody = { store: store, period_type: _kpiCurrentTab, period_end_date: periodDate, employee_name: entry.employee_name };
        _KPI_INPUT_FIELDS.forEach(function(f) {
            const el = document.getElementById('kpi-' + pk + '-' + empIdx + '-' + f);
            if (el && el.value !== '') reqBody[f] = _KPI_INT_FIELDS.has(f) ? parseInt(el.value) : parseFloat(el.value);
        });
        const hasData = _KPI_INPUT_FIELDS.some(function(f) { return reqBody[f] != null; });
        if (!hasData) continue;
        try {
            const resp   = await fetch(KPI_MANAGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-pin': pin }, body: JSON.stringify(reqBody) });
            const result = await resp.json();
            if (!resp.ok) throw new Error(result.error || 'Save failed');
            period.entries[empIdx] = result.entry;
            const s = document.getElementById('kpiS-' + pk + '-' + empIdx);
            if (s) { s.textContent = '✓'; s.style.color = '#16a34a'; s.title = 'Saved'; }
        } catch(e) {
            const s = document.getElementById('kpiS-' + pk + '-' + empIdx);
            if (s) { s.textContent = '✗'; s.style.color = 'var(--red-alert)'; s.title = String(e.message); }
        }
    }
    _kpiEditingPeriod = null;
    await _kpiLoadAll(_kpiCurrentTab);
}

function _kpiGetThisSunday() {
    const d = new Date(); d.setHours(0,0,0,0);
    const day = d.getDay(); d.setDate(d.getDate() + (day === 0 ? 0 : 7 - day));
    return d.toISOString().slice(0,10);
}
function _kpiGetLastDayOfMonth() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth()+1, 0).toISOString().slice(0,10);
}


// --- 12. MODULE: HUB DATA & LIVE DASHBOARDS ---

async function fetchHubData() {
    try {
        const response = await fetch(`${HUB_URL}?v=${Date.now()}`);
        const freshData = await response.json();


        hubDataCache = freshData;

        if (document.getElementById('bs-buy-val')) renderBuyingSales();
        renderMonthlyGoalsBanner();
        renderDistrictGoals();
        
        // Render Live Data globally (Fixes CEO Rings)
        renderLiveData(hubDataCache);
        
        // Let the Hub power the Leaderboard automatically!
        if (hubDataCache.leaderboard) {
            cachedLeaderboardData = hubDataCache.leaderboard;
            feedLeaderboardToTicker(cachedLeaderboardData);
            if (document.getElementById('lb-wrapper')) drawLeaderboard();
        } else if (document.getElementById('lb-wrapper')) {
            document.getElementById('lb-wrapper').innerHTML = '<div class="status-message" style="color:var(--red-alert);">Please Deploy "New Version" of Hub App Script!</div>';
        }
        _tickerSourceDone('hub');
    } catch(e) {
        console.error("Hub Sync Failed", e);
        // Delay so a concurrent fetchHubData call (syncAllData vs initDashboardData race)
        // has time to succeed and set the leaderboard before the ticker starts.
        setTimeout(() => _tickerSourceDone('hub'), 2000);
    }
}

function renderBuyingSales() {
    if (!hubDataCache) return; 
    
    const storeSelect = document.getElementById('bsStoreSelect');
    const store = storeSelect ? storeSelect.value.toLowerCase() : 'ovl'; 
    if (!store) return;

    // --- BUYING SIDE MATH ---
    let bV = parseNum(hubDataCache[`${store}BuyVal`]);
    let bP = parseNum(hubDataCache[`${store}BuyProj`]);
    let mN = parseNum(hubDataCache[`${store}BuyMargin`]);
    
    if (String(hubDataCache[`${store}BuyMargin`]).includes('%') === false && mN > 0 && mN <= 1.5) {
        mN = mN * 100;
    }

    document.querySelectorAll('#bs-buy-val').forEach(el => el.innerText = `$${Math.round(bV).toLocaleString()}`);
    document.querySelectorAll('#bs-buy-proj').forEach(el => el.innerText = `$${Math.round(bP).toLocaleString()}`);
    document.querySelectorAll('#bs-buy-margin').forEach(el => {
        el.innerText = mN.toFixed(1) + '%';
        el.className = mN > 0 && mN < 51 ? 'delta-badge delta-neg' : 'delta-badge delta-pos';
    });

    // --- SALES SIDE MATH ---
    let p = parseNum(hubDataCache[`${store}Pct`]); 
    p = Math.round(p > 0 && p <= 1 && !String(hubDataCache[`${store}Pct`]).includes('%') ? p * 100 : p);
    
    document.querySelectorAll('#bs-pct').forEach(el => el.innerText = p + '%');
    document.querySelectorAll('#bs-goal').forEach(el => el.innerText = `$${Math.round(parseNum(hubDataCache[`${store}Goal`])).toLocaleString()}`);
    document.querySelectorAll('#bs-t-gp').forEach(el => el.innerText = `$${Math.round(parseNum(hubDataCache[`${store}TrackGP`])).toLocaleString()}`);
    
    document.querySelectorAll('#bs-bar').forEach(bar => {
        bar.style.strokeDashoffset = 402 - (Math.min(p, 100)/100) * 402; 
        bar.style.stroke = p < 100 ? "var(--red-alert)" : "var(--sage-professional)";
    });

    // --- SELLING MARGIN MATH ---
    let sellMarginNum = 0;
    const rev = parseNum(hubDataCache[`${store}Rev`]);
    const gp = parseNum(hubDataCache[`${store}GP`]);
    
    if (hubDataCache[`${store}SellMargin`]) {
        let smRaw = parseNum(hubDataCache[`${store}SellMargin`]);
        sellMarginNum = (!String(hubDataCache[`${store}SellMargin`]).includes('%') && smRaw > 0 && smRaw <= 1.5) ? (smRaw * 100) : smRaw;
    } else if (rev > 0) {
        sellMarginNum = (gp / rev) * 100;
    }
    
    document.querySelectorAll('#bs-sell-margin').forEach(smb => {
        smb.innerText = sellMarginNum.toFixed(1) + '%';
        smb.className = sellMarginNum >= 55.0 ? 'delta-badge delta-pos' : 'delta-badge delta-neg';
    });

    document.querySelectorAll('#bs-rev').forEach(el => el.innerText = `$${Math.round(rev).toLocaleString()}`);

    const bsDateEl = document.getElementById('bs-last-updated');
    if (bsDateEl) {
        bsDateEl.innerText = hubDataCache[`${store}BuyDate`] || '—';
    }
}

function renderLiveData(d) {
    if (!d) return;
    
    // Update the progress rings for BOTH standard and CEO views safely
    [
        { base: 'ovl', api: 'ovl' },
        { base: 'lee', api: 'lee' },
        { base: 'wsp', api: 'wsp' },
        { base: 'mpl', api: 'mpl' },
        { base: 'bal', api: 'bal' }
    ].forEach(store => {
        // --- Core Math ---
        let p = Math.round(d[`${store.api}Pct`] || 0);
        let goalTxt = `$${Math.round(d[`${store.api}Goal`] || 0).toLocaleString()}`;
        let tGpTxt = `$${Math.round(d[`${store.api}TrackGP`] || 0).toLocaleString()}`;

        // --- Buying Math ---
        let bV = parseNum(d[`${store.api}BuyVal`]);
        let bP = parseNum(d[`${store.api}BuyProj`]);
        let mN = parseNum(d[`${store.api}BuyMargin`]);
        if (String(d[`${store.api}BuyMargin`]).includes('%') === false && mN > 0 && mN <= 1.5) mN = mN * 100;

        // --- Selling Margin Math ---
        let sellMarginNum = 0;
        const rev = parseNum(d[`${store.api}Rev`]);
        const gp = parseNum(d[`${store.api}GP`]);
        if (d[`${store.api}SellMargin`]) {
            let smRaw = parseNum(d[`${store.api}SellMargin`]);
            sellMarginNum = (!String(d[`${store.api}SellMargin`]).includes('%') && smRaw > 0 && smRaw <= 1.5) ? (smRaw * 100) : smRaw;
        } else if (rev > 0) {
            sellMarginNum = (gp / rev) * 100;
        }

        // 1. Update Main Dropdown Rings (Sales Only)
        if(document.getElementById(`${store.api}-pct`)) document.getElementById(`${store.api}-pct`).innerText = p + '%';
        if(document.getElementById(`${store.api}-goal`)) document.getElementById(`${store.api}-goal`).innerText = `Goal: ${goalTxt}`;
        if(document.getElementById(`${store.api}-t-gp`)) document.getElementById(`${store.api}-t-gp`).innerText = tGpTxt;
        
        // 2. Update CEO Rings (Sales)
        if(document.getElementById(`ceo-${store.base}-pct`)) document.getElementById(`ceo-${store.base}-pct`).innerText = p + '%';
        if(document.getElementById(`ceo-${store.base}-goal`)) document.getElementById(`ceo-${store.base}-goal`).innerText = goalTxt;
        if(document.getElementById(`ceo-${store.base}-rev`)) document.getElementById(`ceo-${store.base}-rev`).innerText = `$${Math.round(rev).toLocaleString()}`;
        if(document.getElementById(`ceo-${store.base}-t-gp`)) document.getElementById(`ceo-${store.base}-t-gp`).innerText = tGpTxt;
        if(document.getElementById(`ceo-${store.base}-sell-margin`)) {
            let el = document.getElementById(`ceo-${store.base}-sell-margin`);
            el.innerText = sellMarginNum.toFixed(1) + '%';
            el.className = sellMarginNum >= 55.0 ? 'ceo-badge badge-pos' : 'ceo-badge badge-neg';
        }

        // 3. Update CEO Rings (Buying)
        if(document.getElementById(`ceo-${store.base}-buy-val`)) document.getElementById(`ceo-${store.base}-buy-val`).innerText = `$${Math.round(bV).toLocaleString()}`;
        if(document.getElementById(`ceo-${store.base}-buy-proj`)) document.getElementById(`ceo-${store.base}-buy-proj`).innerText = `$${Math.round(bP).toLocaleString()}`;
        if(document.getElementById(`ceo-${store.base}-buy-margin`)) {
            let el = document.getElementById(`ceo-${store.base}-buy-margin`);
            el.innerText = mN.toFixed(1) + '%';
            el.className = (mN > 0 && mN < 51) ? 'ceo-badge badge-neg' : 'ceo-badge badge-pos';
        }

        // 4. Update the SVG Bars
        let offset = 402 - (Math.min(p, 100)/100)*402;
        let color = p < 100 ? "var(--red-alert)" : "var(--sage-professional)";
        
        setTimeout(() => {
            let mainBar = document.getElementById(`${store.api}-bar`);
            if(mainBar) { mainBar.style.strokeDashoffset = offset; mainBar.style.stroke = color; }
            
            let ceoBar = document.getElementById(`ceo-${store.base}-bar`);
            if(ceoBar) { ceoBar.style.strokeDashoffset = offset; ceoBar.style.stroke = color; }
        }, 50);
    });

    // Update the Revenue and GP Leaderboards
    if (document.getElementById('rev-list')) {
        const sArr = [
            {n:'OVL', r:d.ovlRev, g:d.ovlGP}, 
            {n:'LEE', r:d.leeRev, g:d.leeGP}, 
            {n:'WSP', r:d.wspRev, g:d.wspGP}
        ];
        
        const buildLbRow = (s, i, val) => `
            <div class="lb-row">
                <div class="lb-rank ${i === 0 ? 'lb-gold' : ''}">#${i + 1}</div>
                <div class="lb-name">${s.n}</div>
                <div class="lb-val">$${Math.round(val).toLocaleString()}</div>
            </div>`;

        document.getElementById('rev-list').innerHTML = [...sArr].sort((a,b) => b.r - a.r).map((s,i) => buildLbRow(s, i, s.r)).join('');
        document.getElementById('gp-list').innerHTML = [...sArr].sort((a,b) => b.g - a.g).map((s,i) => buildLbRow(s, i, s.g)).join('');
        
        const n = new Date(); 
        const formattedTime = `${n.getHours() % 12 || 12}:${String(n.getMinutes()).padStart(2,'0')} ${n.getHours() >= 12 ? 'PM' : 'AM'}`;
        document.getElementById('lastSyncedText').innerText = `Last Synced: ${formattedTime}`;
    }

    const ceoBsDateEl = document.getElementById('ceo-bs-last-updated');
    if (ceoBsDateEl) {
        ceoBsDateEl.innerText = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    }
}

// --- 13. MODULE: CHARTS & LEADERBOARDS ---
let mainChartInstance = null;
let leaderboardChartInstance = null;
let currentLeaderboardMetric = 'Revenue'; 
let cachedLeaderboardData = null; 
let currentTimeframe = '4-Week'; 
let currentChartMode = 'averages';
let _rawChartCache = JSON.parse(localStorage.getItem('speeksKpiChartCache')) || {};
// Discard any old CSV-format cache entries (they had array data, not {mode, tf, ...})
let kpiChartCache = (_rawChartCache['4-Week']?.mode && _rawChartCache['Monthly']?.mode) ? _rawChartCache : { '4-Week': null, 'Monthly': null };
let _latestPatchKey = null; // title|date of the most recent patch notes group

function switchPageTab(tab) {
    ['trends', 'records'].forEach(t => { 
        document.getElementById('pane-' + t)?.classList.toggle('active', t === tab); 
        document.getElementById('tab-btn-' + t)?.classList.toggle('active', t === tab); 
    });
    if (tab === 'records') renderRecords();
}

function setChartMode(mode) {
    currentChartMode = mode;
    document.getElementById('btn-chart-avg')?.classList.toggle('active', mode === 'averages');
    document.getElementById('btn-chart-emp')?.classList.toggle('active', mode === 'employees');
    loadKpiData(); 
}

function setTimeframe(t) { 
    currentTimeframe = t; 
    document.getElementById('btn-4week')?.classList.toggle('active', t === '4-Week'); 
    document.getElementById('btn-monthly')?.classList.toggle('active', t === 'Monthly'); 
    loadKpiData(); 
}

function switchLeaderboardMetric(metric) {
    currentLeaderboardMetric = metric;
    
    const revBtn = document.getElementById('lb-tab-rev');
    const gpBtn = document.getElementById('lb-tab-gp');
    
    if (revBtn && gpBtn) {
        revBtn.classList.toggle('active', metric === 'Revenue');
        revBtn.style.color = metric === 'Revenue' ? 'var(--slate-charcoal)' : '#a0aab2';
        
        gpBtn.classList.toggle('active', metric === 'GP');
        gpBtn.style.color = metric === 'GP' ? 'var(--slate-charcoal)' : '#a0aab2';
    }
    
    drawLeaderboard(); 
}

function loadKpiData() {
    const mSelect = document.getElementById('metricSelector');
    if (!mSelect) return;
    const loader = document.getElementById('chartLoading');
    if (loader) { loader.style.display = 'flex'; loader.innerHTML = '<div class="status-message">Syncing Live Data...</div>'; }
    fetchChartData(currentTimeframe);
}

async function fetchChartData(tf) {
    const loader = document.getElementById('chartLoading');
    if (loader) { loader.style.display = 'flex'; loader.innerHTML = '<div class="status-message">Syncing Data...</div>'; }

    const STORES = ['OVL','LEE','WSP','MPL','BAL'];
    const safeJson = (url) => fetch(url).then(r => r.json()).catch(() => null);

    try {
        let payload;
        if (currentChartMode === 'averages') {
            if (tf === 'Monthly') {
                const results = await Promise.all(STORES.map(s => safeJson(`${MONTHLY_KPI_URL}?store=${s}&v=${Date.now()}`)));
                payload = { mode: 'averages', tf, stores: STORES, results };
            } else {
                const results = await Promise.all(STORES.map(s => safeJson(`${KPI_MANAGE_URL}?store=${s}&period_type=weekly&v=${Date.now()}`)));
                payload = { mode: 'averages', tf, stores: STORES, results };
            }
        } else {
            const store = document.getElementById('dmChartStoreSelector')?.value || sessionStorage.getItem('speeksUserStore') || 'OVL';
            const pt = tf === 'Monthly' ? 'monthly' : 'weekly';
            const result = await safeJson(`${KPI_MANAGE_URL}?store=${store}&period_type=${pt}&v=${Date.now()}`);
            payload = { mode: 'employees', tf, store, result };
        }

        kpiChartCache[tf] = payload;
        try { localStorage.setItem('speeksKpiChartCache', JSON.stringify(kpiChartCache)); } catch(e) {}

        if (currentTimeframe === tf) {
            const mSelect = document.getElementById('metricSelector');
            if (mSelect) renderKpiChart(payload, mSelect.value);
        }
    } catch (e) {
        console.error('fetchChartData error:', e);
        if (loader) loader.innerHTML = '<div class="status-message" style="color:var(--red-alert);">Failed to load chart data.</div>';
    }
}

function syncAllData() {
    try {
        const mSelect = document.getElementById('metricSelector');
        const cached = kpiChartCache && kpiChartCache[currentTimeframe];
        if (cached && cached.mode && mSelect) renderKpiChart(cached, mSelect.value);
    } catch (e) {}

    try {
        if (typeof cachedLeaderboardData !== 'undefined' && cachedLeaderboardData) drawLeaderboard();
    } catch (e) {}

    try {
        if (typeof hubDataCache !== 'undefined' && hubDataCache) renderLiveData(hubDataCache);
    } catch (e) {}

    fetchChartData(currentTimeframe);
    fetchHubData();
    if (typeof loadCMS === 'function') loadCMS();
    if (typeof fetchRecordsData === 'function') fetchRecordsData();
}

// --- 14. MODULE: RECORDS MANAGER ---
let recordsCache = JSON.parse(localStorage.getItem('speeksRecordsCache')) || null;

async function fetchRecordsData() { 
    try { 
        const response = await fetch(`${RECORDS_URL}?v=${Date.now()}`);
        recordsCache = await response.json(); 
        localStorage.setItem('speeksRecordsCache', JSON.stringify(recordsCache)); 
        
        if (document.getElementById('pane-records')?.classList.contains('active')) {
            renderRecords(); 
        }
    } catch (e) {} 
}

function renderRecords() {
    const cont = document.getElementById('recordsContainer'); 
    if (!cont) return;
    
    if (!recordsCache?.length) {
        cont.innerHTML = '<div class="status-message">Syncing Data...</div>';
        return;
    }
    
    const map = {}; 
    recordsCache.forEach(r => { 
        let l = String(r.label).trim();
        let s = String(r.section).toUpperCase().trim(); 
        
        if (!map[l]) map[l] = { c: null, s: [] }; 
        if (s === 'COMPANY' || s === 'COMPANY WIDE') map[l].c = r; 
        else map[l].s.push(r); 
    });
    
    let bC = 0; 
    let html = '<div class="records-masonry-grid">';
    
    Object.keys(map).forEach(l => {
        let d = map[l]; 
        bC++; 
        let oId = 'overflow-board-' + bC; 
        d.s.sort((a, b) => parseNum(b.value) - parseNum(a.value)); 
        let cR = d.c || d.s[0];
        
        html += `
        <div class="record-metric-card">
            <div class="rmc-header" style="background: var(--slate-charcoal);">${l}</div>`;
            
        if (cR) {
            html += `
            <div class="rmc-champion">
                <div class="rmc-crown">👑 Company Record</div>
                <div class="rmc-champ-val">${cR.value || '-'}</div>
                <div class="rmc-champ-sub">${cR.subtext || ''}</div>
            </div>`;
        }
        
        if (d.s.length) {
            html += `<div class="rmc-list">`;
            html += d.s.slice(0, 3).map((s, i) => `
                <div class="rmc-list-item">
                    <div class="rmc-rank">${i===0 ? '🥇' : (i===1 ? '🥈' : '🥉')}</div>
                    <div class="rmc-store">${s.section}</div>
                    <div class="rmc-score">
                        <span class="rmc-score-val">${s.value || '-'}</span>
                        <span class="rmc-score-date">${s.subtext || ''}</span>
                    </div>
                </div>`).join('');
                
            if (d.s.length > 3) {
                html += `
                <div id="${oId}" class="hidden-board">
                    ${d.s.slice(3).map((s, i) => `
                    <div class="rmc-list-item">
                        <div class="rmc-rank" style="font-size:11px; color:#999;">#${i+4}</div>
                        <div class="rmc-store">${s.section}</div>
                        <div class="rmc-score">
                            <span class="rmc-score-val">${s.value || '-'}</span>
                            <span class="rmc-score-date">${s.subtext || ''}</span>
                        </div>
                    </div>`).join('')}
                </div>
                <button class="rmc-expand-btn" onclick="toggleBoard('${oId}', this)">See Full Leaderboard ▾</button>`;
            }
            html += `</div>`;
        }
        html += `</div>`;
    });
    
    html += '</div>';
    cont.innerHTML = html;
}

function toggleBoard(id, btn) { 
    const el = document.getElementById(id); 
    el.classList.toggle('open'); 
    btn.innerText = el.classList.contains('open') ? 'Hide Leaderboard ▴' : 'See Full Leaderboard ▾'; 
}

async function toggleManageRecords() {
    const dropdown = document.getElementById('manageRecordsDropdown');
    if (!dropdown) return;
    
    const isOpen = dropdown.classList.contains('show');
    closeAllModals(); 
    
    if (!isOpen) {
        dropdown.classList.add('show');
        lockAndBlurScreen();

        const list = document.getElementById('manageRecordsList');
        list.innerHTML = '<div class="status-message">Syncing Database...</div>';
        
        try {
            if (!recordsCache || recordsCache.length === 0) {
                const res = await fetch(`${RECORDS_URL}?v=${Date.now()}`);
                recordsCache = await res.json();
                localStorage.setItem('speeksRecordsCache', JSON.stringify(recordsCache));
            }
            populateRecordsModal();
        } catch (e) {
            list.innerHTML = '<div style="color:var(--red-alert); padding:20px; text-align:center;">Failed to sync data.</div>';
        }
    }
}

function populateRecordsModal() {
    const list = document.getElementById('manageRecordsList');
    let html = '';
    
    if (!recordsCache || recordsCache.length === 0) {
        list.innerHTML = '<div style="padding: 20px; text-align: center; color: #888; font-weight: 600;">No records found.</div>';
        return;
    }

    recordsCache.forEach(r => {
        html += `
        <div class="record-manage-row" data-store="${r.section || ''}" data-label="${r.label || ''}" style="background: #fff; padding: 12px 15px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 10px; display: flex; align-items: center; gap: 15px;">
            <div style="flex: 2; display: flex; flex-direction: column; gap: 2px;">
                <span style="color: #94a3b8; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;">${r.section || 'COMPANY'}</span>
                <span style="font-size: 13px; font-weight: 800; color: var(--slate-charcoal); line-height: 1.2;">${r.label || ''}</span>
            </div>
            <input type="text" class="r-val" placeholder="Value (e.g. $5,000)" value="${r.value || ''}" style="flex: 1; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; font-weight: 600; color: var(--slate-charcoal); outline: none;">
            <input type="text" class="r-date" placeholder="Date (e.g. Oct 12)" value="${r.subtext || ''}" style="flex: 1; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; font-weight: 600; color: var(--slate-charcoal); outline: none;">
        </div>`;
    });
    
    list.innerHTML = html;
}

function populateAlertsModal() {
    const list = document.getElementById('manageAlertsList');
    const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    
    // Explicit conversion logic: Decimal to Percentage
    const fmtInput = (val) => {
        if (val === null || val === undefined || String(val).trim() === '') return '';
        let str = String(val).trim();
        if (str.includes('%')) {
            return parseFloat(str.replace(/[^0-9.-]/g, '')).toFixed(2);
        }
        let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
        if (isNaN(num)) return str;
        return (num * 100).toFixed(2);
    };

    let html = '';

    STORES.forEach(storeName => {
        let sData = globalAlertsData.find(s => s.store.toUpperCase() === storeName) || { 
            store: storeName, currentHigh: '', currentVeryHigh: '', projectedHigh: '', projectedVeryHigh: '',
            defectRate: '', lateShipment: '', casesClosed: '', tracking: '' 
        };
        
        html += `
            <div class="alert-manage-row" data-store="${storeName}" style="background: #fff; padding: 15px; border-radius: 8px; border: 1px solid #ddd; margin-bottom: 15px;">
                <div style="font-weight: 900; color: var(--slate-charcoal); font-size: 14px; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 5px;">${storeName}</div>
                
                <div style="font-size: 11px; font-weight: 800; color: #888; text-transform: uppercase; margin-bottom: 6px;">eBay Performance Metrics</div>
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 15px;">
                    <input type="text" class="a-ch" placeholder="Cur. High" title="Current High" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${sData.currentHigh || ''}">
                    <input type="text" class="a-cvh" placeholder="Cur. Very High" title="Current Very High" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${sData.currentVeryHigh || ''}">
                    <input type="text" class="a-ph" placeholder="Proj. High" title="Projected High" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${sData.projectedHigh || ''}">
                    <input type="text" class="a-pvh" placeholder="Proj. Very High" title="Projected Very High" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${sData.projectedVeryHigh || ''}">
                </div>

                <div style="font-size: 11px; font-weight: 800; color: #888; text-transform: uppercase; margin-bottom: 6px;">eBay Top Rated Metrics</div>
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;">
                    <input type="text" class="a-dr" placeholder="Defect Rate" title="Transaction Defect Rate" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${fmtInput(sData.defectRate)}">
                    <input type="text" class="a-ls" placeholder="Late Shipment" title="Late Shipment Rate" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${fmtInput(sData.lateShipment)}">
                    <input type="text" class="a-cc" placeholder="Cases Closed" title="Cases Closed w/o Resolution" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${fmtInput(sData.casesClosed)}">
                    <input type="text" class="a-tr" placeholder="Tracking" title="Tracking Uploaded" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${fmtInput(sData.tracking)}">
                </div>
            </div>
        `;
    });

    list.innerHTML = html;
}

async function saveManageRecords() {
    const btn = document.getElementById('saveRecordsBtn');
    btn.textContent = "Saving...";
    btn.style.opacity = "0.7";

    const updatedRecords = [];
    document.querySelectorAll('.record-manage-row').forEach(row => {
        updatedRecords.push({
            store: row.getAttribute('data-store'),
            label: row.getAttribute('data-label'),
            value: row.querySelector('.r-val').value.trim(),
            date: row.querySelector('.r-date').value.trim()
        });
    });

    try {
        const res = await fetch(RECORDS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(updatedRecords)
        });

        if (res.ok) {
            alert("Company Records successfully updated!");
            closeAllModals();
            recordsCache = null; 
            if (typeof fetchRecordsData === 'function') fetchRecordsData();
        } else {
            alert("Error saving records. Make sure Apps Script is deployed properly.");
        }
    } catch (e) {
        alert("Failed to connect to server.");
    } finally {
        btn.textContent = "Save Changes";
        btn.style.opacity = "1";
    }
}

// --- 15. MODULE: MONTHLY AWARDS ---
let awardsCache = null;
let currentAwardVideoUrl = null;

const STORE_EMOJI_MAP = { OVL: '🟣', LEE: '🔵', WSP: '🟢', MPL: '🟠', BAL: '🔴' };
const AWARD_NAMES = ['The Beyond The Benchmark Award', 'The Scroll Stopper Award', 'The Brand Beacon Award'];
const AWARD_EMOJIS = ['🎯', '👀', '💡'];
const AWARD_DISPLAY_LINES = [['The Beyond The', 'Benchmark Award'], ['The Scroll', 'Stopper Award'], ['The Brand', 'Beacon Award']];
const AWARD_DESCRIPTIONS = ['Best Store Performance Relative to Monthly Goal', 'Funniest Post/Video', 'Best Brand Encapsulation Post/Video'];

function toVideoEmbed(url) {
    if (!url) return null;
    // Google Drive file link
    const driveFile = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
    if (driveFile) return { type: 'iframe', src: `https://drive.google.com/file/d/${driveFile[1]}/preview` };
    const driveOpen = url.match(/drive\.google\.com\/open\?id=([A-Za-z0-9_-]+)/);
    if (driveOpen) return { type: 'iframe', src: `https://drive.google.com/file/d/${driveOpen[1]}/preview` };
    // Direct video file (MP4, WebM, etc.)
    if (/\.(mp4|webm|ogg)(\?|$)/i.test(url)) return { type: 'video', src: url };
    // YouTube fallback
    const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (yt) return { type: 'iframe', src: `https://www.youtube.com/embed/${yt[1]}` };
    return null;
}

function buildVideoHtml(url) {
    const v = toVideoEmbed(url);
    if (!v) return '';
    if (v.type === 'video') return `<video controls src="${v.src}" style="width:100%;height:100%;display:block;"></video>`;
    return `<iframe src="${v.src}" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen loading="lazy" style="width:100%;height:100%;display:block;"></iframe>`;
}

async function fetchAwardsData() {
    try {
        const res = await fetch(`${RECORDS_URL}?type=awards&v=${Date.now()}`);
        const raw = await res.json();
        // Deduplicate by month — later rows win (most recent save for a month)
        const byMonth = new Map();
        raw.forEach(a => byMonth.set(a.month, a));
        awardsCache = Array.from(byMonth.values());
        renderAwards();
        renderAwardVideos();
    } catch (e) {}
}

function renderAwards() {
    const container = document.getElementById('awards-cards-container');
    const monthLabel = document.getElementById('awards-month-label');
    if (!container) return;

    if (!awardsCache || awardsCache.length === 0) {
        container.innerHTML = '<div class="status-message">No awards data yet.</div>';
        return;
    }

    const latest = awardsCache[awardsCache.length - 1];
    if (monthLabel) monthLabel.textContent = latest.month || '';

    const winners = [latest.winner1, latest.winner2, latest.winner3];
    const hasAny = winners.some(w => w);
    if (!hasAny) {
        container.innerHTML = '<div class="status-message">No award winners set for this month yet.</div>';
        return;
    }

    container.innerHTML = AWARD_NAMES.map((name, i) => {
        const store = winners[i];
        const [line1, line2] = AWARD_DISPLAY_LINES[i];
        return `
        <div class="award-card-trophy-wrap">
            <button class="award-info-btn" data-desc="${escapeHtml(AWARD_DESCRIPTIONS[i])}">i</button>
            <div class="award-card">
                <div class="award-card-header">
                    <div class="award-card-name">${escapeHtml(line1)}<br>${escapeHtml(line2)}</div>
                </div>
                <div class="award-card-sep"><span>◆</span></div>
                <div class="award-card-body">
                    <div class="award-card-winner">${store ? escapeHtml(store) : '<span style="opacity:0.45;">—</span>'}</div>
                </div>
            </div>
        </div>`;
    }).join('');

}

function renderAwardVideos() {
    const btn = document.getElementById('awards-video-btn');
    const latest = (awardsCache || []).slice(-1)[0];
    currentAwardVideoUrl = (latest && latest.videoUrl) ? latest.videoUrl : null;
    if (btn) btn.style.display = currentAwardVideoUrl ? '' : 'none';
}

function openAwardVideo() {
    if (!currentAwardVideoUrl) return;
    const overlay = document.getElementById('awardVideoOverlay');
    const content = document.getElementById('awardVideoContent');
    if (!overlay || !content) return;
    content.innerHTML = buildVideoHtml(currentAwardVideoUrl);
    overlay.style.display = 'flex';
}

function closeAwardVideo() {
    const overlay = document.getElementById('awardVideoOverlay');
    const content = document.getElementById('awardVideoContent');
    if (overlay) overlay.style.display = 'none';
    if (content) content.innerHTML = '';
}

function toggleManageAwards() {
    const dropdown = document.getElementById('manageAwardsDropdown');
    if (!dropdown) return;

    const isOpen = dropdown.classList.contains('show');
    closeAllModals();

    if (!isOpen) {
        dropdown.classList.add('show');
        lockAndBlurScreen();

        const editTabBtn = document.getElementById('awards-tab-edit');
        if (editTabBtn) editTabBtn.style.display = '';
        const editFooter = document.getElementById('awardsEditFooter');
        if (editFooter) editFooter.style.display = '';

        switchAwardsTab('edit');

        if (!awardsCache) {
            fetchAwardsData().then(prefillAwardsForm);
        } else {
            prefillAwardsForm();
        }
    }
}

function prefillAwardsForm() {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    if (awardsCache && awardsCache.length > 0) {
        const latest = awardsCache[awardsCache.length - 1];
        setVal('awardsMonthInput', latest.month);
        setVal('awardsVideoInput', latest.videoUrl);
        setVal('award1Store', latest.winner1);
        setVal('award2Store', latest.winner2);
        setVal('award3Store', latest.winner3);
    } else {
        setVal('awardsMonthInput', new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
    }
}

function toggleAwardsHistory() {
    const dropdown = document.getElementById('manageAwardsDropdown');
    if (!dropdown) return;

    const isOpen = dropdown.classList.contains('show');
    closeAllModals();

    if (!isOpen) {
        dropdown.classList.add('show');
        lockAndBlurScreen();

        const editTabBtn = document.getElementById('awards-tab-edit');
        if (editTabBtn) editTabBtn.style.display = 'none';
        const editFooter = document.getElementById('awardsEditFooter');
        if (editFooter) editFooter.style.display = 'none';

        if (!awardsCache) {
            fetchAwardsData().then(() => switchAwardsTab('history'));
        } else {
            switchAwardsTab('history');
        }
    }
}

function switchAwardsTab(tab) {
    document.getElementById('awardsTabEdit').style.display = tab === 'edit' ? '' : 'none';
    document.getElementById('awardsTabHistory').style.display = tab === 'history' ? '' : 'none';
    document.getElementById('awards-tab-edit')?.classList.toggle('active', tab === 'edit');
    document.getElementById('awards-tab-history')?.classList.toggle('active', tab === 'history');
    if (tab === 'history') renderAwardsHistory();
}

function renderAwardsHistory() {
    const list = document.getElementById('awardsHistoryList');
    if (!list) return;

    if (!awardsCache || awardsCache.length === 0) {
        list.innerHTML = '<div class="status-message">No history yet.</div>';
        return;
    }

    const winnerKeys = ['winner1', 'winner2', 'winner3'];

    list.innerHTML = [...awardsCache].reverse().map(a => `
        <div class="awards-history-entry">
            <div class="awards-history-month">${escapeHtml(a.month)}</div>
            ${AWARD_NAMES.map((name, i) => {
                const store = a[winnerKeys[i]];
                return `<div class="awards-history-row">
                    <span class="awards-history-medal">${AWARD_EMOJIS[i]}</span>
                    <span class="awards-history-awardname">${escapeHtml(name)}</span>
                    <span class="awards-history-winner">${store ? `${STORE_EMOJI_MAP[store] || ''} ${store}` : '—'}</span>
                </div>`;
            }).join('')}
            ${a.videoUrl ? `<div class="awards-history-video-link"><a href="${escapeHtml(a.videoUrl)}" target="_blank">🎬 Watch Video</a></div>` : ''}
        </div>`).join('');
}

function clearAwardsForm() {
    ['awardsMonthInput', 'awardsVideoInput', 'award1Store', 'award2Store', 'award3Store'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const status = document.getElementById('awardsSaveStatus');
    if (status) status.textContent = '';
}

async function saveAwards() {
    const btn = document.getElementById('saveAwardsBtn');
    const status = document.getElementById('awardsSaveStatus');
    const getVal = id => (document.getElementById(id)?.value || '').trim();

    const month = getVal('awardsMonthInput');
    if (!month) { alert('Please enter the month (e.g. May 2026).'); return; }

    btn.textContent = 'Saving...';
    btn.disabled = true;

    const payload = {
        type: 'awards',
        month,
        winner1: getVal('award1Store'),
        winner2: getVal('award2Store'),
        winner3: getVal('award3Store'),
        videoUrl: getVal('awardsVideoInput'),
    };

    try {
        await fetch(RECORDS_URL, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });

        if (!awardsCache) awardsCache = [];
        const idx = awardsCache.findIndex(a => a.month === month);
        if (idx >= 0) awardsCache[idx] = { ...payload };
        else awardsCache.push({ ...payload });

        renderAwards();
        renderAwardVideos();
        closeAllModals();
    } catch (e) {
        if (status) status.textContent = '✗ Error saving.';
    } finally {
        btn.textContent = 'Save Awards';
        btn.disabled = false;
    }
}

// --- 16. MODULE: QUICK MESSAGES ---
let quickMsgCache = null;
let currentQMTab = 'common';

async function loadQuickMessages() {
    const contentDiv = document.getElementById('qmContent');
    if (quickMsgCache && contentDiv.querySelector('.qm-item')) return; 

    contentDiv.innerHTML = '<div class="status-message">Syncing Data...</div>';

    try {
        const response = await fetch(QUICK_MSG_URL);
        quickMsgCache = await response.json(); 
        renderQMTab(currentQMTab);
    } catch (error) {
        console.error("Error loading Quick Messages:", error);
        contentDiv.innerHTML = '<div class="status-message" style="color: var(--red-alert);">Failed to load messages. Ensure Apps Script is deployed as a "New Version".</div>';
    }
}

function switchQMTab(tab) {
    currentQMTab = tab;
    
    const btnCommon = document.getElementById('qm-tab-common');
    const btnNoDeals = document.getElementById('qm-tab-nodeals');
    const btnReviews = document.getElementById('qm-tab-reviews');
    const btnNetworking = document.getElementById('qm-tab-networking');
    
    if (btnCommon && btnNoDeals && btnReviews) {
        btnCommon.classList.toggle('active', tab === 'common');
        btnNoDeals.classList.toggle('active', tab === 'nodeals');
        btnReviews.classList.toggle('active', tab === 'reviews');
        if (btnNetworking) btnNetworking.classList.toggle('active', tab === 'networking');
    }
    
    renderQMTab(tab);
}

function renderQMTab(tab) {
    const contentDiv = document.getElementById('qmContent');
    if (!quickMsgCache) return;

    let rawData = quickMsgCache.common;
    if (tab === 'nodeals') rawData = quickMsgCache.noDeals;
    if (tab === 'reviews') rawData = quickMsgCache.reviews;
    if (tab === 'networking') rawData = quickMsgCache.networking;
    
    let userStore = sessionStorage.getItem('speeksUserStore') || 'OVL';
    if (userStore === 'ALL') userStore = 'CORP';

    if (!rawData || rawData.length === 0) {
        contentDiv.innerHTML = '<div style="padding: 20px; color: #888; text-align: center; font-weight: 600;">No messages found in this tab.</div>';
        return;
    }

    const groupedData = {};
    
    rawData.forEach(row => {
        const rowStore = String(row.store || "Everyone").trim().toUpperCase();
        
        if (tab === 'networking' || rowStore === 'EVERYONE' || rowStore === userStore.toUpperCase()) {
            const category = row.category;
            if (!groupedData[category]) groupedData[category] = [];
            groupedData[category].push(row);
        }
    });

    let html = '';

    if (tab === 'common') {
        for (const [category, items] of Object.entries(groupedData)) {
            html += `
            <div class="qm-category-wrapper">
                <div class="qm-category" onclick="this.classList.toggle('open'); this.nextElementSibling.classList.toggle('open')">
                    <span> 🗂️ ${escapeHtml(category)}</span>
                    <span class="qm-caret" style="font-size:10px; color:#a0aab2; transition: transform 0.3s;">▼</span>
                </div>
                <div class="qm-category-items">
                    ${items.map(item => `
                        <div class="qm-item">
                            <div class="qm-item-header">
                                <div class="qm-item-name" onclick="this.parentElement.nextElementSibling.classList.toggle('open')">
                                    ${escapeHtml(item.name)}
                                </div>
                                <button class="qm-copy-btn" title="Copy Message" data-message="${escapeHtml(item.message)}" onclick="copyQMToClipboard(this)">
                                    Copy
                                </button>
                            </div>
                            <div class="qm-item-message">
                                ${escapeHtml(item.message)}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }
    } else if (tab === 'nodeals' || tab === 'networking') {
        html += '<div class="qm-category-items open" style="margin-left: 0; padding-left: 0; border: none; background: transparent;">';
        for (const [category, items] of Object.entries(groupedData)) {
            html += items.map(item => `
                <div class="qm-item">
                    <div class="qm-item-header">
                        <div class="qm-item-name" onclick="this.parentElement.nextElementSibling.classList.toggle('open')">
                            ${escapeHtml(item.name)}
                        </div>
                        <button class="qm-copy-btn" title="Copy Message" data-message="${escapeHtml(item.message)}" onclick="copyQMToClipboard(this)">
                            Copy
                        </button>
                    </div>
                    <div class="qm-item-message">
                        ${escapeHtml(item.message)}
                    </div>
                </div>
            `).join('');
        }
        html += '</div>';
    } else if (tab === 'reviews') {
        // --- NEW BANNER FOR NON-5-STAR REVIEWS ---
        html += `
        <div style="margin-bottom: 15px; background: #fffbeb; border: 1px solid #fde68a; padding: 15px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;">
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <span style="font-size: 13px; font-weight: 900; color: #92400e;">Handling a Sub-5-Star Review?</span>
                <span style="font-size: 11px; font-weight: 700; color: #b45309;">Follow the SOP for mixed or negative feedback before replying.</span>
            </div>
            <a href="https://drive.google.com/file/d/1HKhBSVl7dNkgLd6f9O1_9Rhf9sYeAA1b/view?usp=sharing" target="_blank" class="mini-action-btn" style="background: white; border-color: #fde68a; color: #92400e; box-shadow: 0 2px 4px rgba(251,191,36,0.15);">View Process ↗</a>
        </div>`;

        html += '<div class="qm-category-items open" style="margin-left: 0; padding-left: 0; border: none; background: transparent; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start;">';
        for (const [category, items] of Object.entries(groupedData)) {
            html += items.map(item => `
                <div class="qm-item" style="margin-bottom: 0;">
                    <div class="qm-item-header">
                        <div class="qm-item-name" onclick="this.parentElement.nextElementSibling.classList.toggle('open')">
                            ${escapeHtml(item.name)}
                        </div>
                        <button class="qm-copy-btn" title="Copy Message" data-message="${escapeHtml(item.message)}" onclick="copyQMToClipboard(this)">
                            Copy
                        </button>
                    </div>
                    <div class="qm-item-message">
                        ${escapeHtml(item.message)}
                    </div>
                </div>
            `).join('');
        }
        html += '</div>';
    }
    
    if (html === '' || html.includes('style="margin-left: 0; padding-left: 0; border: none; background: transparent;"></div>') || html.includes('style="margin-left: 0; padding-left: 0; border: none; background: transparent; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start;"></div>')) {
        html = '<div style="padding: 20px; color: #888; text-align: center; font-weight: 600;">No messages available for your location.</div>';
    }
    
    contentDiv.innerHTML = html;
}

function copyQMToClipboard(button) {
    const textToCopy = button.getAttribute('data-message');
    navigator.clipboard.writeText(textToCopy).then(() => {
        const originalText = button.innerText;
        button.innerText = 'Copied!'; 
        button.style.background = '#d1fae5';
        button.style.color = '#065f46';
        button.style.borderColor = '#34d399';
        
        setTimeout(() => { 
            button.innerText = originalText; 
            button.style.background = '';
            button.style.color = '';
            button.style.borderColor = '';
        }, 1500);
    }).catch(err => console.error('Failed to copy text: ', err));
}

// --- 16. MODULE: GLOBAL AUTH OVERLAY ---
function injectGlobalAuth() {
    if (!document.getElementById('authOverlay')) {
        const overlayHtml = `
        <div id="authOverlay" class="auth-page" style="display: none;">
            <div class="auth-split-layout">
                <div class="auth-brand-side">
                    <img src="images/speeks_logo.png" alt="SPEEKS Logo" class="auth-logo">
                    <div class="auth-brand-text">
                        <h1>SPEEKSNET</h1>
                        <p>Internal Operations Portal</p>
                    </div>
                </div>
                <div class="auth-form-side">
                    <div class="auth-form-container">
                        <div class="auth-badge">SECURE ACCESS</div>
                        <h2>Welcome Back</h2>
                        <p id="authSubtitle">Please enter your 4-digit PIN to securely access the hub.</p>
                        <div id="pinInputContainer" class="pin-container">
                            <input type="password" id="pinInput" maxlength="4" placeholder="••••" onkeypress="if(event.key === 'Enter') checkPIN()" oninput="handlePINAutoTrigger()">
                            <button id="unlockBtn" class="btn-primary auth-btn" onclick="checkPIN()">Unlock Portal</button>
                            <div id="pinError" class="pin-error">Incorrect PIN. Please try again.</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', overlayHtml);
    }
}

function handleSignOut() {
    // Remove the login state
    sessionStorage.removeItem('speeksUnlocked');
    sessionStorage.removeItem('speeksUserName');
    sessionStorage.removeItem('speeksUserRole');
    sessionStorage.removeItem('speeksUserStore');
    
    // Remove the comment tracker so it pops up again on next login
    sessionStorage.removeItem('speeksSeenCommentKeys');
    
    location.reload(); 
}

// --- 17. MODULE: IDEA SUBMISSION MODAL ---
let isIdeaSubmitting = false; 

function injectIdeaModal() {
    if (!document.getElementById('ideaModal')) {
        const modalHtml = `
        <iframe name="hidden_iframe" id="hidden_iframe" style="display:none;" onload="handleIframeLoad()"></iframe>
        <div class="modal-menu idea-menu" id="ideaModal">
            <div class="modal-header">
                <h3>Submit an Idea</h3>
                <button class="modal-close-btn" onclick="closeAllModals()">✖</button>
            </div>
            <div class="modal-content" style="padding: 25px;">
                <form id="ideaForm" action="https://formsubmit.co/ethan.kushnir@speekstechnology.com" method="POST" enctype="multipart/form-data" target="hidden_iframe" onsubmit="prepareIdeaSubmit()">
                    <input type="hidden" name="_captcha" value="false">
                    <input type="hidden" name="_subject" id="ideaDynamicSubject" value="New SPEEKS Idea">
                    <div style="margin-bottom: 15px;">
                        <label class="idea-label">Your Name</label>
                        <input type="text" id="ideaName" name="Name" class="idea-input" required placeholder="John Doe">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label class="idea-label">Category</label>
                        <select id="ideaCategory" name="Category" class="idea-input">
                            <option value="New Feature">New Feature</option>
                            <option value="Process Improvement">Process Improvement</option>
                            <option value="Bug Fix / Issue">Bug Fix / Issue</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label class="idea-label">Idea Details</label>
                        <textarea id="ideaDesc" name="Idea_Description" required rows="5" class="idea-input" placeholder="Describe your idea here..."></textarea>
                    </div>
                    <div style="margin-bottom: 20px;">
                        <label class="idea-label">Attach a File (Optional)</label>
                        <input type="file" id="ideaFile" name="Attachment" class="idea-input" accept="image/*,.pdf,.doc,.docx" style="padding: 10px;">
                    </div>
                    <div style="display:flex; justify-content:flex-end; gap:10px;">
                        <button type="button" class="btn-secondary" onclick="closeAllModals()">Cancel</button>
                        <button type="submit" class="btn-primary" id="submitIdeaBtn">Submit Idea</button>
                    </div>
                </form>
                <div id="ideaSuccess" style="display:none; text-align:center; padding: 30px 10px;">
                    <div style="font-size: 40px; margin-bottom: 10px;">🎉</div>
                    <h3 style="color: var(--sage-professional); margin-bottom: 10px; font-weight: 800;">Idea Submitted!</h3>
                    <p style="color: #666; font-size: 14px; margin-bottom: 20px; font-weight: 500;">Thanks for helping us improve SPEEKS.</p>
                    <button class="btn-primary" onclick="closeAllModals(); setTimeout(() => { document.getElementById('ideaForm').style.display='block'; document.getElementById('ideaSuccess').style.display='none'; document.getElementById('ideaForm').reset(); }, 500);">Close</button>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
    }
}

function prepareIdeaSubmit() {
    isIdeaSubmitting = true; 
    const btn = document.getElementById('submitIdeaBtn');
    btn.innerText = 'Sending...';
    btn.style.opacity = '0.7';
    const category = document.getElementById('ideaCategory').value;
    document.getElementById('ideaDynamicSubject').value = 'New SPEEKS Idea: ' + category;
}

function handleIframeLoad() {
    if (isIdeaSubmitting) {
        document.getElementById('ideaForm').style.display = 'none';
        document.getElementById('ideaSuccess').style.display = 'block';
        const btn = document.getElementById('submitIdeaBtn');
        btn.innerText = 'Submit Idea';
        btn.style.opacity = '1';
        isIdeaSubmitting = false; 
    }
}

async function fetchScorecardData() {
    const container = document.getElementById('scorecard-widget-body');
    if (!container) return;

    // 1. Check if they are actually logged in! 
    // If there is no store in memory yet (they are behind the lock screen), ABORT!
    let targetStore = sessionStorage.getItem('speeksUserStore');
    if (!targetStore) return; 
    
    // If CORP/ALL, default to OVL just so the widget has something to show
    if (targetStore === 'ALL' || targetStore === 'CORP') targetStore = 'OVL'; 

    container.innerHTML = '<div style="display: flex; justify-content: center; align-items: center; min-height: 150px; width: 100%; color: #94a3b8; font-weight: 600; font-size: 14px;">Syncing Data...</div>';

    try {
        const response = await fetch(`${SCORECARD_URL}?v=${Date.now()}`);
        const json = await response.json();
        if (!json.success) throw new Error(json.error);
        
        const storeData = json.data.find(item => String(item.store).toUpperCase() === targetStore.toUpperCase());

        if (!storeData) {
            container.innerHTML = `<div style="color: #888; text-align: center; padding: 20px 0; font-weight: bold;">No data found for ${targetStore}.</div>`;
            return;
        }

        // REMOVED the code that overrides the "Store Scorecard" title here!

        const latestScore = parseFloat(storeData.score) || 0;
        const displayScore = latestScore * 2;
        const rawDate = storeData.date || 'Recent';

        const formatWeekOf = (d) => {
            const p = new Date(d);
            if (isNaN(p.getTime())) return String(d);
            const diff = p.getUTCDay() === 0 ? -6 : 1 - p.getUTCDay();
            const mon = new Date(p);
            mon.setUTCDate(p.getUTCDate() + diff);
            return "Week of " + mon.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
        };

        let displayDate = rawDate;
        const parsedDate = new Date(rawDate);
        if (!isNaN(parsedDate.getTime())) displayDate = formatWeekOf(rawDate);
        let scoreColor = 'var(--red-alert)';
        if (displayScore > 8) scoreColor = 'var(--sage-professional)';
        else if (displayScore >= 6) scoreColor = 'var(--idea-gold)';

        const isRecent = (dateStr) => {
            if (!dateStr) return false;
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return false;
            return Date.now() - d.getTime() < 48 * 60 * 60 * 1000;
        };

        const recentBucketIndices = [];
        if (storeData.buckets) {
            storeData.buckets.forEach((b, i) => {
                if (b.categories && b.categories.length > 0 && isRecent(b.sectionDate)) {
                    recentBucketIndices.push(i);
                }
            });
        }
        const showOverallDot = recentBucketIndices.length > 1;
        const singleRecentBucketIdx = recentBucketIndices.length === 1 ? recentBucketIndices[0] : -1;

        const pulse = (displayScore < 6 || showOverallDot)
            ? `<div class="notif-dot active" style="display:block; position:absolute; top:-2px; right:-14px; width:12px; height:12px;"></div>`
            : '';

        const renderCategoryCard = (cat) => {
            let originalVal = parseFloat(cat.score);
            let displayVal = cat.score;
            let bg = '#f1f5f9', color = '#64748b';
            if (!isNaN(originalVal)) {
                let sVal = originalVal * 2;
                displayVal = sVal;
                if (sVal >= 8) { bg = '#d1fae5'; color = '#059669'; }
                else if (sVal >= 6) { bg = '#fef3c7'; color = '#d97706'; }
                else { bg = '#fee2e2'; color = '#dc2626'; }
            }
            return `<div style="display: flex; justify-content: space-between; align-items: center; background: #fff; border: 1px solid #e2e8f0; padding: 8px; border-radius: 8px; gap: 6px;">
                <span style="font-size: 9px; font-weight: 800; color: var(--slate-charcoal); text-transform: uppercase; line-height: 1.3;">${cat.name}</span>
                <span style="font-size: 11px; font-weight: 900; background: ${bg}; color: ${color}; padding: 2px 6px; border-radius: 6px; flex-shrink: 0;">${displayVal}</span>
            </div>`;
        };

        let breakdownHtml = '';
        if (storeData.buckets && storeData.buckets.some(b => b.categories && b.categories.length > 0)) {
            breakdownHtml = `<div style="max-height: 340px; overflow-y: auto; padding-right: 4px; margin-top: 15px; border-top: 1px solid #f0f0f0; padding-top: 15px;" class="kpi-scroll-area">`;
            storeData.buckets.forEach((bucket, bIdx) => {
                if (!bucket.categories || bucket.categories.length === 0) return;
                let bAvgNum = bucket.avg * 2;
                let bBg = '#f1f5f9', bColor = '#64748b';
                if (bAvgNum >= 8) { bBg = '#d1fae5'; bColor = '#059669'; }
                else if (bAvgNum >= 6) { bBg = '#fef3c7'; bColor = '#d97706'; }
                else { bBg = '#fee2e2'; bColor = '#dc2626'; }
                const bDateStr = bucket.sectionDate ? formatWeekOf(bucket.sectionDate) : '';
                const sectionPulse = (!showOverallDot && bIdx === singleRecentBucketIdx)
                    ? `<div class="notif-dot active" style="position:relative; top:auto; right:auto; width:9px; height:9px; border:1px solid white; flex-shrink:0;"></div>`
                    : '';
                breakdownHtml += `<div style="margin-bottom: 12px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; min-width: 0;">
                        <span style="font-size: 9px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;">${bucket.name}</span>
                        <span style="font-size: 10px; font-weight: 900; background: ${bBg}; color: ${bColor}; padding: 2px 7px; border-radius: 6px; flex-shrink: 0;">${bAvgNum.toFixed(1)}</span>
                        ${bDateStr ? `<span style="font-size: 9px; color: #94a3b8; font-style: italic; white-space: nowrap; flex-shrink: 0;">${bDateStr}</span>` : ''}
                        ${sectionPulse}
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;">
                        ${bucket.categories.map(renderCategoryCard).join('')}
                    </div>
                </div>`;
            });
            breakdownHtml += `</div>`;
        } else if (storeData.breakdown && storeData.breakdown.length > 0) {
            breakdownHtml = `<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; max-height: 280px; overflow-y: auto; padding-right: 4px; margin-top: 15px; border-top: 1px solid #f0f0f0; padding-top: 15px;" class="kpi-scroll-area">
                ${storeData.breakdown.map(renderCategoryCard).join('')}
            </div>`;
        }

        container.innerHTML = `
        <div class="scorecard-widget" style="padding: 20px; align-items: stretch; text-align: left; justify-content: flex-start;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div class="scorecard-label" style="text-align: left; margin-bottom: 2px;">Store Average</div>
                    <div class="scorecard-date" style="margin-bottom: 0; font-size: 11px;">${displayDate}</div>
                </div>
                <div style="position: relative; display: inline-block;">
                    <div class="scorecard-val" style="color: ${scoreColor}; font-size: 36px; text-shadow: 0 4px 15px ${scoreColor}30; line-height: 1;">
                        ${displayScore.toFixed(1)}
                    </div>
                    ${pulse}
                </div>
            </div>
            ${breakdownHtml}
        </div>`;
    } catch (error) {
        console.error('Error fetching scorecard:', error);
        container.innerHTML = '<div style="color: var(--red-alert); font-weight: bold; padding: 20px 0; text-align: center;">Error syncing scorecard.</div>';
    }
}

async function fetchAlertsData() {
    const container = document.getElementById('alerts-widget-body');
    if (!container) return;

    // 1. Check if they are actually logged in! 
    let targetStore = sessionStorage.getItem('speeksUserStore');
    if (!targetStore) return; // ABORT if behind the lock screen!
    
    // 2. Default to OVL only if it's the CEO/Corp viewing the widget
    if (targetStore === 'ALL' || targetStore === 'CORP') targetStore = 'OVL'; 

    // 3. Force the loading state immediately to clear any stale UI
    container.innerHTML = '<div class="status-message">Syncing Data...</div>';

    try {
        const response = await fetch(EBAY_ALERTS_URL);
        const json = await response.json();
        if (!json.success) throw new Error(json.error);

        const storeData = json.data.find(item => String(item.store).toUpperCase() === targetStore.toUpperCase());
        if (!storeData) return;

        const formatPercent = (val) => {
            if (val === null || val === undefined) return '0%';
            let str = String(val).trim();
            if (str === '' || str === 'null') return '0%';
            if (str.endsWith('%')) return str;
            let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
            if (isNaN(num)) return '0%';
            return num.toFixed(2) + '%';
        };

        // NEW: Dynamic Severity Calculator for eBay Top Rated Thresholds
        const getSeverity = (type, rawVal) => {
            if (rawVal === null || rawVal === undefined || String(rawVal).trim() === '') return 'clear';
            let str = String(rawVal).trim();

            let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
            if (isNaN(num)) return 'clear';

            // Values are stored as percentages (e.g. 0.12 = 0.12%, 99.19 = 99.19%)
            let valToCheck = num;

            if (type === 'defectRate') {
                if (valToCheck >= 0.5) return 'very-high'; // Red
                if (valToCheck >= 0.25) return 'high';     // Yellow
                return 'clear';                            // Green
            }
            if (type === 'lateShipment') {
                if (valToCheck >= 3.0) return 'very-high';
                if (valToCheck >= 1.5) return 'high';
                return 'clear';
            }
            if (type === 'casesClosed') {
                if (valToCheck >= 0.3) return 'very-high';
                if (valToCheck >= 0.15) return 'high';
                return 'clear';
            }
            if (type === 'tracking') {
                if (valToCheck <= 95.0) return 'very-high';
                if (valToCheck <= 97.5) return 'high';
                return 'clear';
            }
            return 'clear';
        };

        const buildMiniAlertCard = (title, rawValue, severity, isPercent) => {
            // Default styling is Green ("clear")
            let bgColor = '#d1fae5';
            let textColor = '#065f46'; 
            let displayText = 'All Clear';
            let pulseHtml = '';
            
            if (rawValue !== null && rawValue !== undefined && String(rawValue).trim() !== '') {
                if (isPercent) {
                    displayText = formatPercent(rawValue);
                } else {
                    if (String(rawValue).includes(',')) {
                        displayText = String(rawValue).split(',').map(s =>
                            `<span style="display:block; padding: 2px 0;">${s.trim()}</span>`
                        ).join('<div style="height:1px; background:rgba(0,0,0,0.1); margin: 3px 0;"></div>');
                    } else {
                        displayText = rawValue;
                    }
                }

                if (severity === 'high') {
                    bgColor = '#fef3c7';
                    textColor = '#92400e';
                } else if (severity === 'very-high') {
                    bgColor = '#fee2e2';
                    textColor = '#991b1b';
                    pulseHtml = '<div class="notif-dot active" style="display:block; position:absolute; top:-3px; right:-3px; width:8px; height:8px; border-width: 1px; z-index: 5;"></div>';
                }
            }

            return `
            <div style="position: relative; background: #fff; padding: 8px 12px; border-radius: 8px; border: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 2px rgba(0,0,0,0.02); height: 100%; box-sizing: border-box;">
                ${pulseHtml}
                <div style="font-size: 9px; font-weight: 800; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 10px; flex-shrink: 0;">${title}</div>
                <div style="font-size: 10px; font-weight: 900; color: ${textColor}; background-color: ${bgColor}; padding: 4px 8px; border-radius: 6px; text-align: right; line-height: 1.3;">
                    ${displayText}
                </div>
            </div>`;
        };

        container.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 15px; width: 100%;">
            
            <div>
                <div style="font-size: 10px; font-weight: 800; color: var(--slate-charcoal); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">eBay Performance Metrics</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    ${buildMiniAlertCard('Current High', storeData.currentHigh, 'high', false)}
                    ${buildMiniAlertCard('Current Very High', storeData.currentVeryHigh, 'very-high', false)}
                    ${buildMiniAlertCard('Projected High', storeData.projectedHigh, 'high', false)}
                    ${buildMiniAlertCard('Projected Very High', storeData.projectedVeryHigh, 'very-high', false)}
                </div>
            </div>

            <div style="height: 1px; background: #e2e8f0; width: 100%;"></div>
            
            <div>
                <div style="font-size: 10px; font-weight: 800; color: var(--slate-charcoal); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">eBay Top Rated Metrics</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    ${buildMiniAlertCard('Defect Rate', storeData.defectRate, getSeverity('defectRate', storeData.defectRate), true)}
                    ${buildMiniAlertCard('Late Shipment', storeData.lateShipment, getSeverity('lateShipment', storeData.lateShipment), true)}
                    ${buildMiniAlertCard('Cases Closed', storeData.casesClosed, getSeverity('casesClosed', storeData.casesClosed), true)}
                    ${buildMiniAlertCard('Tracking', storeData.tracking, getSeverity('tracking', storeData.tracking), true)}
                </div>
            </div>

        </div>`;
    } catch (error) {
        console.error('Error fetching alerts:', error);
    }
}

// ============================================================================
// 19. MODULE: DISTRICT COMMAND CENTER (MASTER DASHBOARDS)
// ============================================================================
let districtKpiCache = null;

async function fetchDistrictMonthlyKPIs() {
    const container = document.getElementById('district-kpi-body');
    if (!container) return;

    const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    localStorage.removeItem('speeksDistKpiData');

    try {
        const promises = STORES.map(store => 
            fetch(`${MONTHLY_KPI_URL}?store=${store}&v=${Date.now()}`)
            .then(r => r.json())
            .then(data => ({store, data}))
            .catch(e => ({store, error: true}))
        );
        
        const results = await Promise.all(promises);
        districtKpiCache = { masterMonths: [], stores: {} };

        results.forEach(res => {
            if (res.store === 'OVL' && res.data && res.data.months) { 
                districtKpiCache.masterMonths = res.data.months; 
            }
            if (res.data && !res.data.error && res.data.data) {
                districtKpiCache.stores[res.store] = { months: res.data.months || [], data: groupKPIs(res.data.data) };
            } else {
                districtKpiCache.stores[res.store] = { months: [], data: [] }; 
            }
        });

        localStorage.setItem('speeksDistKpiData', JSON.stringify(districtKpiCache));
        buildDistrictKpiDropdowns();
        renderDistrictKPIs();
        
    } catch (e) {
        console.error("District KPI Error:", e);
        container.innerHTML = '<div style="color: var(--red-alert); font-weight: bold; text-align: center; padding: 20px;">Failed to load District KPIs. Connection Timed Out.</div>';
    }
}

function buildDistrictKpiDropdowns() {
    if (!districtKpiCache || !districtKpiCache.masterMonths) return;
    const sel = document.getElementById('dist-kpi-month');
    if (!sel) return;

    const months = districtKpiCache.masterMonths;
    const currVal = sel.value;
    sel.innerHTML = '';
    
    const monthsMap = {
        "Jan": "January", "Feb": "February", "Mar": "March", "Apr": "April",
        "May": "May", "Jun": "June", "Jul": "July", "Aug": "August",
        "Sep": "September", "Oct": "October", "Nov": "November", "Dec": "December"
    };

    months.forEach((m, i) => {
        let displayText = m;
        let parts = String(m).trim().split(/[- ]/);
        if (parts.length >= 2) {
            let monthPart = parts[0];
            monthPart = monthPart.charAt(0).toUpperCase() + monthPart.slice(1).toLowerCase();
            let fullM = monthsMap[monthPart] || monthPart;
            let y = parts[parts.length - 1];
            let fullY = y.length === 2 ? "20" + y : y; 
            displayText = `${fullM} ${fullY}`;
        }
        sel.add(new Option(displayText, i));
    });

    sel.value = currVal !== "" && currVal < months.length ? currVal : months.length - 1;
}

window.renderDistrictKPIs = function() {
    const container = document.getElementById('district-kpi-body');
    const mIdx = parseInt(document.getElementById('dist-kpi-month').value);
    
    if (!districtKpiCache || !districtKpiCache.stores['OVL']) return;

    const targetMonthRaw = districtKpiCache.masterMonths[mIdx];
    if (!targetMonthRaw) return;
    const targetMonthClean = String(targetMonthRaw).replace(/[^a-z0-9]/gi, '').toLowerCase();

    const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    const baseline = districtKpiCache.stores['OVL'].data; 
    
    if (!baseline) return;
    let html = '';

    baseline.forEach(cat => {
        html += `
        <div class="kpi-category">
            <div class="kpi-category-header" onclick="toggleCategory(this)">
                ${cat.category}
                <span class="chevron">▼</span>
            </div>
            <div class="kpi-category-content">`;

        cat.metrics.forEach(m => {
            const metricName = m.name;
            const isInverse = m.inverse;
            let rowHtml = `
            <div class="kpi-row" style="display: grid; grid-template-columns: minmax(130px, 1.5fr) repeat(5, minmax(85px, 1fr)); padding: 12px 10px; align-items: center; border-bottom: 1px solid #f8fafc;">
                <div class="kpi-name-col">
                    <span class="kpi-name" style="font-size: 11px; font-weight: 800; color: #555; text-transform: uppercase;">${metricName}</span>
                </div>`;

            STORES.forEach(store => {
                const storeObj = districtKpiCache.stores[store];
                const storeMonthIdx = storeObj.months.findIndex(m => String(m).replace(/[^a-z0-9]/gi, '').toLowerCase() === targetMonthClean);
                const storeCat = storeObj.data?.find(c => c.category === cat.category);
                const storeMetric = storeCat?.metrics.find(sm => sm.name === metricName);

                if (storeMetric && storeMonthIdx !== -1 && storeMetric.values[storeMonthIdx] !== undefined) {
                    const rawVal = storeMetric.values[storeMonthIdx];
                    const numVal = parseNum(rawVal);
                    let displayStr = rawVal;
                    
                    if (rawVal === "" || rawVal === null) {
                        rowHtml += `<div style="text-align: center;"><span style="font-size: 11px; color: #ccc; font-weight: 800;">-</span></div>`;
                        return; 
                    } else if (!isNaN(numVal) && rawVal !== "") {
                        if (metricName.toLowerCase().match(/%|rate|variance|margin|gm|cogs/) && !String(rawVal).includes('%')) {
                            displayStr = `${numVal.toFixed(2).replace(/\.00$/, '')}%`;
                        } else if (!isNaN(numVal) && typeof rawVal === 'number') {
                            displayStr = formatSmartValue(numVal, metricName);
                        }
                    }

                    let bg = '#f1f5f9'; 
                    let txt = 'var(--slate-charcoal)';

                    if (storeMonthIdx > 0 && storeMetric.values[storeMonthIdx - 1] !== undefined && storeMetric.values[storeMonthIdx - 1] !== "") {
                        const prevVal = parseNum(storeMetric.values[storeMonthIdx - 1]);
                        const dNum = numVal - prevVal;
                        
                        if (Math.abs(dNum) > 0.001) {
                            const isPositiveImpact = dNum > 0 ? !isInverse : isInverse;
                            if (isPositiveImpact) { bg = '#d1fae5'; txt = '#065f46'; } 
                            else { bg = '#fee2e2'; txt = '#991b1b'; }
                        }
                    }

                    rowHtml += `
                    <div style="text-align: center;">
                        <span style="display: inline-flex; align-items: center; justify-content: center; min-width: 65px; font-size: 11px; font-weight: 900; color: ${txt}; background: ${bg}; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.05); box-shadow: inset 0 2px 4px rgba(0,0,0,0.02); box-sizing: border-box; white-space: nowrap;">
                            ${displayStr}
                        </span>
                    </div>`;
                } else {
                    rowHtml += `<div style="text-align: center;"><span style="font-size: 11px; color: #ccc; font-weight: 800;">-</span></div>`;
                }
            });

            rowHtml += `</div>`;
            html += rowHtml;
        });

        html += `</div></div>`;
    });

    container.innerHTML = html;
};

async function fetchMasterDistrictDashboard() {
    const container = document.getElementById('district-master-body');
    if (!container) return;

    const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    const STORE_ICONS = { 'OVL': '🟣', 'LEE': '🔵', 'WSP': '🟢', 'MPL': '🟠', 'BAL': '🔴' };
    
    const PORTAL_LINKS = {
        'OVL': 'https://drive.google.com/drive/folders/1dd1nkndo_Pqt3kztaHcpYWL-NgOWIP-E?usp=drive_link',
        'LEE': 'https://drive.google.com/drive/folders/1Xv6ICOpEXNMeWk4QJBfS7CR6tIFRuElk?usp=drive_link',
        'WSP': 'https://drive.google.com/drive/folders/1xGGzefFbX7rzBnusmCUEk2GnHxJaJqhC?usp=drive_link',
        'MPL': 'https://drive.google.com/drive/folders/1Y5MiKRorTD1mg-lLY4SccYCqw2fZUrND?usp=drive_link',
        'BAL': 'https://drive.google.com/drive/folders/1LnAuBH9t7MwtrB9egWK5PFJWQqPcZ-tL?usp=drive_link'
    };

    const renderMasterBoard = (hubData, varData, scoreData, alertsData, weeklyResults) => {
        let html = '';
        STORES.forEach(store => {
            const sLower = store.toLowerCase();
            const icon = STORE_ICONS[store];
            const storeLastEdited = hubData[`${sLower}BuyDate`] || null;

            // 1. SCORECARD & HEADER
            const sScore = scoreData.data?.find(s => s.store.toUpperCase() === store) || {};
            const scoreNum = (parseFloat(sScore.score) || 0) * 2;
            let sColor = scoreNum > 8 ? '#065f46' : (scoreNum >= 6 ? '#92400e' : '#991b1b');
            let sBg = scoreNum > 8 ? '#d1fae5' : (scoreNum >= 6 ? '#fef3c7' : '#fee2e2');

            let displayDate = "Recent";
            if (sScore.date) {
                const parsedDate = new Date(sScore.date);
                if (!isNaN(parsedDate.getTime())) {
                    const day = parsedDate.getUTCDay();
                    const diffToMonday = day === 0 ? -6 : 1 - day;
                    const mondayDate = new Date(parsedDate);
                    mondayDate.setUTCDate(parsedDate.getUTCDate() + diffToMonday);
                    displayDate = mondayDate.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
                }
            }

            // 2. EBAY ALERTS DATA
            const sAlerts = alertsData.data?.find(a => a.store.toUpperCase() === store) || {};
            
            // Vertical Action Needed List
            const issues = [];
            if (sAlerts.currentVeryHigh) issues.push({text: sAlerts.currentVeryHigh, type: 'red', tip: 'Active Issue: Very High'});
            if (sAlerts.currentHigh) issues.push({text: sAlerts.currentHigh, type: 'yellow', tip: 'Active Issue: High'});
            if (sAlerts.projectedVeryHigh) issues.push({text: sAlerts.projectedVeryHigh, type: 'red', tip: 'Projected Issue: Very High'});
            if (sAlerts.projectedHigh) issues.push({text: sAlerts.projectedHigh, type: 'yellow', tip: 'Projected Issue: High'});
            if (issues.length === 0) issues.push({text: 'All Clear', type: 'green', tip: 'No active or projected alerts.'});

            // 4 New Service Metrics logic
            const formatPercent = (val) => {
                if (val === null || val === undefined) return '0%';
                let str = String(val).trim();
                if (str === '' || str === 'null') return '0%';
                if (str.endsWith('%')) return str;
                let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
                if (isNaN(num)) return '0%';
                return num.toFixed(2) + '%';
            };

            const getSev = (type, rawVal) => {
                if (rawVal === null || rawVal === undefined || String(rawVal).trim() === '') return 'clear';
                let str = String(rawVal).trim();
                let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
                if (isNaN(num)) return 'clear';
                let valToCheck = num;

                if (type === 'defectRate') {
                    if (valToCheck >= 0.5) return 'very-high';
                    if (valToCheck >= 0.25) return 'high';
                }
                if (type === 'lateShipment') {
                    if (valToCheck >= 3.0) return 'very-high';
                    if (valToCheck >= 1.5) return 'high';
                }
                if (type === 'casesClosed') {
                    if (valToCheck >= 0.3) return 'very-high';
                    if (valToCheck >= 0.15) return 'high';
                }
                if (type === 'tracking') {
                    if (valToCheck <= 95.0) return 'very-high';
                    if (valToCheck <= 97.5) return 'high';
                }
                return 'clear';
            };

            const buildMiniAlertCard = (title, rawValue, severity, isPercent) => {
                let bgColor = '#d1fae5';
                let textColor = '#065f46'; 
                let displayText = 'All Clear';
                let pulseHtml = '';
                
                if (rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== '') {
                    if (isPercent) {
                        displayText = formatPercent(rawValue);
                    } else {
                        displayText = String(rawValue); 
                    }

                    if (severity === 'high') {
                        bgColor = '#fef3c7'; 
                        textColor = '#92400e';
                    } else if (severity === 'very-high') {
                        bgColor = '#fee2e2';
                        textColor = '#991b1b';
                        // Positioned perfectly on the corner
                        pulseHtml = '<div class="notif-dot active" style="display:block; position:absolute; top:-4px; right:-4px; width:10px; height:10px; border-width: 2px; z-index: 5;"></div>';
                    }
                }

                // REMOVED 'overflow: hidden' from the outer div so the dot isn't clipped!
                return `
                <div style="position: relative; background: #fff; padding: 8px 8px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; width: 100%; box-sizing: border-box; min-height: 42px; gap: 4px;">
                    ${pulseHtml}
                    <span style="font-size: 9px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;">${title}</span>
                    <span style="font-size: 11px; font-weight: 900; color: ${textColor}; background: ${bgColor}; padding: 3px 6px; border-radius: 6px; text-align: center; white-space: nowrap; flex-shrink: 0;">${displayText}</span>
                </div>`;
            };

            // 3. BUYING & SELLING SNAPSHOT
            let rawPctStr = String(hubData[`${sLower}Pct`]);
            let rawPct = parseFloat(rawPctStr) || 0;
            let salesPctNum = (!rawPctStr.includes('%') && rawPct > 0 && rawPct <= 1.5) ? (rawPct * 100) : rawPct;
            const salesPct = Number.isInteger(salesPctNum) ? salesPctNum : salesPctNum.toFixed(2);
            
            const gpTrack = Math.round(parseFloat(hubData[`${sLower}TrackGP`])) || 0;
            const buyProj = Math.round(parseFloat(hubData[`${sLower}BuyProj`])) || 0;
            const storeGoalText = `$${Math.round(parseFloat(hubData[`${sLower}Goal`]) || 0).toLocaleString()}`;
            
            let sellMarginNum = 0;
            const rev = parseFloat(hubData[`${sLower}Rev`]) || 0;
            const gp = parseFloat(hubData[`${sLower}GP`]) || 0;
            if (hubData[`${sLower}SellMargin`]) {
                let smRaw = parseFloat(hubData[`${sLower}SellMargin`]);
                sellMarginNum = (!String(hubData[`${sLower}SellMargin`]).includes('%') && smRaw > 0 && smRaw <= 1.5) ? (smRaw * 100) : smRaw;
            } else if (rev > 0) {
                sellMarginNum = (gp / rev) * 100;
            }
            const sellMargin = Number.isInteger(sellMarginNum) ? sellMarginNum : sellMarginNum.toFixed(2);

            let rawMarginStr = String(hubData[`${sLower}BuyMargin`]);
            let rawMargin = parseFloat(rawMarginStr) || 0;
            let buyMarginNum = (!rawMarginStr.includes('%') && rawMargin > 0 && rawMargin <= 1.5) ? (rawMargin * 100) : rawMargin;
            const buyMargin = Number.isInteger(buyMarginNum) ? buyMarginNum : buyMarginNum.toFixed(2);

            const pctColor = salesPctNum >= 100 ? '#065f46' : '#991b1b';
            const pctBg = salesPctNum >= 100 ? '#d1fae5' : '#fee2e2';
            const sellMarginColor = sellMarginNum >= 55.5 ? '#065f46' : '#991b1b';
            const sellMarginBg = sellMarginNum >= 55.5 ? '#d1fae5' : '#fee2e2';
            const marginColor = (buyMarginNum > 0 && buyMarginNum < 51) ? '#991b1b' : '#065f46';
            const marginBg = (buyMarginNum > 0 && buyMarginNum < 51) ? '#fee2e2' : '#d1fae5';

            // 4. LIVE VARIANCE
            const sVar = varData[store] || {};
            const totalVar = parseFloat(sVar.total) || 0;
            const vColor = totalVar < 0 ? '#991b1b' : (totalVar > 0 ? '#065f46' : '#64748b');
            const vBg = totalVar < 0 ? '#fee2e2' : (totalVar > 0 ? '#d1fae5' : '#f1f5f9');
            const vSign = totalVar > 0 ? '+' : '';

            // 5. WEEKLY METRICS
            const sWeekData = weeklyResults.find(w => w.store === store);
            const wAvg = sWeekData?.sAvg || {};

            const renderLineStat = (label, val, ruleType) => {
                let isBad = false;
                let displayVal = val || '-';
                if (displayVal !== '-' && (ruleType === 'margin' || ruleType === 'conversion') && !String(displayVal).includes('%')) displayVal += '%';
                
                if (val && val !== '-') {
                    let n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
                    if (ruleType === 'margin') isBad = n < 51;
                    if (ruleType === 'conversion') isBad = n < 85;
                    if (ruleType === 'nodeals') isBad = n > 7;
                    if (ruleType === 'time') {
                        let t = String(val);
                        let timeVal = t.includes(':') ? parseInt(t.split(':')[0]) + (parseInt(t.split(':')[1])/60) : n;
                        isBad = timeVal > 13;
                    }
                }
                
                let bg = ruleType === 'nobg' ? 'transparent' : (ruleType === null ? '#f1f5f9' : (isBad ? '#fee2e2' : '#d1fae5'));
                let txt = ruleType === 'nobg' ? 'var(--slate-charcoal)' : (ruleType === null ? 'var(--slate-charcoal)' : (isBad ? '#991b1b' : '#065f46'));
                let pad = ruleType === 'nobg' ? '0' : '3px 8px';
                if (displayVal === '-') { bg = '#f1f5f9'; txt = '#888'; pad = '3px 8px'; }
                
                return `
                <div class="master-stat-row">
                    <span class="master-stat-label">${label}</span>
                    <span class="master-stat-val" style="color: ${txt}; background: ${bg}; padding: ${pad};">${displayVal}</span>
                </div>`;
            };

            html += `
            <div class="card master-card">
                <div class="master-card-header" style="background: var(--slate-charcoal); display: flex; justify-content: space-between; align-items: stretch;">
                    <div style="display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; gap: 10px;">
                        <a href="${PORTAL_LINKS[store]}" target="_blank" class="portal-link-title">
                            ${icon} ${store}
                        </a>
                        <span class="master-card-date" style="margin: 0;">Goal: ${storeGoalText}</span>
                    </div>
                    <div style="display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; gap: 10px;">
                        <span class="master-card-score" style="background: ${sBg}; color: ${sColor};">${scoreNum.toFixed(1)}</span>
                        <span class="master-card-date" style="margin: 0;">Week of ${displayDate}</span>
                    </div>
                </div>

                <div class="master-card-body">
                    <div>
                        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px;">
                            <div class="master-section-title" style="margin-bottom:0;min-width:0;">Buying &amp; Selling Snapshot</div>
                            ${storeLastEdited ? `<span class="master-section-title" style="margin-bottom:0;white-space:nowrap;">${storeLastEdited}</span>` : ''}
                        </div>
                        <div class="master-stat-box">
                            <div class="master-stat-row"><span class="master-stat-label">Sales vs Goal</span><span class="master-stat-val" style="color: ${pctColor}; background: ${pctBg};">${salesPct}%</span></div>
                            <div class="master-stat-row"><span class="master-stat-label">Revenue</span><span class="master-stat-val" style="color: var(--slate-charcoal);">$${Math.round(rev).toLocaleString()}</span></div>
                            <div class="master-stat-row"><span class="master-stat-label">GP Tracking</span><span class="master-stat-val" style="color: var(--slate-charcoal);">$${gpTrack.toLocaleString()}</span></div>
                            <div class="master-stat-row dashed"><span class="master-stat-label">Sell Margin</span><span class="master-stat-val" style="color: ${sellMarginColor}; background: ${sellMarginBg};">${sellMarginNum > 0 ? sellMargin + '%' : '-'}</span></div>
                            <div class="master-stat-row"><span class="master-stat-label">Buy Tracking</span><span class="master-stat-val" style="color: var(--slate-charcoal);">$${buyProj.toLocaleString()}</span></div>
                            <div class="master-stat-row dashed"><span class="master-stat-label">Buy Margin</span><span class="master-stat-val" style="color: ${marginColor}; background: ${marginBg};">${buyMargin}%</span></div>
                            <div class="master-stat-row"><span class="master-stat-label">Variance Total</span><span class="master-stat-val" style="color: ${vColor}; background: ${vBg};">${vSign}${totalVar.toFixed(2)}%</span></div>
                        </div>
                    </div>

                    <div>
                        <div class="master-section-title">Weekly Metrics</div>
                        <div class="master-stat-box">
                            ${renderLineStat('Conversion', wAvg.conversion, 'conversion')}
                            ${renderLineStat('Margin', wAvg.buyMargin, 'margin')}
                            ${renderLineStat('Trans. Time', wAvg.time, 'time')}
                            ${renderLineStat('No Deals', wAvg.noDeals, 'nodeals')}
                            <div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed #e2e8f0;">
                                ${renderLineStat('Listed Devices', wAvg.listed, 'nobg')}
                            </div>
                        </div>
                    </div>

                    <div style="flex-grow: 1; display: flex; flex-direction: column;">
                        
                        <div class="master-section-title">eBay Top Rated Metrics</div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 15px;">
                            ${buildMiniAlertCard('Defect Rate', sAlerts.defectRate, getSev('defectRate', sAlerts.defectRate), true)}
                            ${buildMiniAlertCard('Late Shipment', sAlerts.lateShipment, getSev('lateShipment', sAlerts.lateShipment), true)}
                            ${buildMiniAlertCard('Cases Closed', sAlerts.casesClosed, getSev('casesClosed', sAlerts.casesClosed), true)}
                            ${buildMiniAlertCard('Tracking', sAlerts.tracking, getSev('tracking', sAlerts.tracking), true)}
                        </div>

                        <div class="master-section-title">eBay Performance Metrics</div>
                        <div style="display: flex; flex-direction: column; gap: 6px; flex-grow: 1;">
                            ${issues.map(b => {
                                let bg = b.type === 'red' ? '#fee2e2' : (b.type === 'yellow' ? '#fef3c7' : '#d1fae5');
                                let txt = b.type === 'red' ? '#991b1b' : (b.type === 'yellow' ? '#92400e' : '#065f46');
                                let pulse = b.type === 'red' ? `<div class="notif-dot active" style="display:block; position:absolute; top:-4px; right:-4px; width:12px; height:12px; border-width: 2px;"></div>` : '';
                                return `
                                <div class="master-action-badge" style="color: ${txt}; background: ${bg};">
                                    ${pulse}<span>${b.text}</span>
                                    <div class="fast-tip">${b.tip}</div>
                                </div>`;
                            }).join('')}
                        </div>
                    </div>
                </div>
            </div>`;
        });

        container.innerHTML = html;
    };

    const cachedHtml = localStorage.getItem('speeksDistMasterHtml');
    if (cachedHtml) container.innerHTML = cachedHtml;

    try {
        const [hubData, varData, scoreData, alertsData] = await Promise.all([
            fetch(`${HUB_URL}?v=${Date.now()}`).then(r => r.json()),
            fetch(`${VARIANCE_API_URL}?v=${Date.now()}`).then(r => r.json()),
            fetch(SCORECARD_URL).then(r => r.json()),
            fetch(EBAY_ALERTS_URL).then(r => r.json())
        ]);

        const weeklyPromises = STORES.map(async (store) => {
            const d = await fetch(`${WEEKLY_KPI_URL}?store=${store}&v=${Date.now()}`).then(r => r.json());
            const t = d.store_total || {};
            const fmtPct = v => v != null ? `${Number(v).toFixed(1)}` : '';
            const fmtN   = v => v != null ? String(Math.round(Number(v))) : '';
            const fmtMin = v => v != null ? `${Number(v).toFixed(1)}` : '';
            const sAvg = {
                buyMargin:  fmtPct(t.gross_margin_pct),
                conversion: fmtPct(t.customer_conversion_pct),
                time:       fmtMin(t.avg_transaction_time),
                noDeals:    fmtN(t.no_deal_count),
                listed:     fmtN(t.listed_count),
            };
            return { store, sAvg };
        });

        const weeklyResults = await Promise.all(weeklyPromises);
        renderMasterBoard(hubData, varData, scoreData, alertsData, weeklyResults);
        localStorage.setItem('speeksDistMasterHtml', container.innerHTML);

    } catch (error) { 
        if (!cachedHtml) {
            container.innerHTML = '<div style="color: var(--red-alert); font-weight: bold; text-align: center; grid-column: 1 / -1;">Error compiling Master Dashboard.</div>'; 
        }
    }
}


// ============================================================================
// 20. MODULE: LISTING GOALS ENGINE
// ============================================================================
let goalsRoster = [];
let liveGoalsData = [];
let allDistrictGoalsData = [];
let editingYesterday = false;
let goalsTargetStore = 'OVL';
let currentAppDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
let currentDmGoalView = 'daily';

function normalizeGoalDate(s) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? String(s).trim() : d.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
}

function toggleEditDate(isYest) {
    editingYesterday = isYest;
    buildGoalsEditForm(); // Re-render the form for the selected day
}

function runScheduledTasks() {
    const now = new Date();
    const ctDateStr = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    const ctTimeString = now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
    const hours = parseInt(ctTimeString, 10);
    
    const isPulseTime = (hours === 9) || (hours === 19);
    const dot = document.getElementById('goals-pulse-dot');
    if (dot) dot.style.display = isPulseTime ? 'block' : 'none';

    if (ctDateStr !== currentAppDate) {
        currentAppDate = ctDateStr;
        const activeTab = document.getElementById('tab-daily')?.classList.contains('active') ? 'daily' : 'weekly';
        renderGoalsScoreboard(activeTab);
    }
}

async function initListingGoals() {
    runScheduledTasks();
    setInterval(runScheduledTasks, 60000); 
    await fetchLiveGoalsData();
}

async function fetchLiveGoalsData() {
    const list = document.getElementById('goals-roster-list');
    if (!list) return;
    list.innerHTML = '<div class="status-message">Syncing Data...</div>';

    goalsTargetStore = sessionStorage.getItem('speeksUserStore') || 'OVL';
    if (goalsTargetStore === 'ALL' || goalsTargetStore === 'CORP') goalsTargetStore = 'OVL'; 

    try {
        // Build roster from auth cache — works for all stores immediately, no extra API call
        const _authRaw = localStorage.getItem('speeksAuthCache');
        if (_authRaw) {
            const _authData = JSON.parse(_authRaw);
            const _excluded = ['ceo', 'district manager'];
            const _emps = (_authData.users || [])
                .filter(u => (u.store || '').trim().toUpperCase() === goalsTargetStore.toUpperCase() && !_excluded.includes((u.role || '').toLowerCase()))
                .map(u => u.name)
                .filter(Boolean);
            goalsRoster = _emps.length ? _emps : ['No Employees Found'];
        }

        liveGoalsData = await fetch(`${GOALS_API_URL}?store=${goalsTargetStore}&v=${Date.now()}`).then(r => r.json()).catch(() => []);
        if (!Array.isArray(liveGoalsData)) liveGoalsData = [];

        renderGoalsScoreboard('daily');
    } catch (e) {
        list.innerHTML = '<div style="color: var(--red-alert); font-weight: bold; text-align: center; padding: 20px 0;">Error loading roster.</div>';
    }
}

function renderGoalsScoreboard(viewType = 'daily') {
    const list = document.getElementById('goals-roster-list');
    const dateDisplay = document.getElementById('goals-date-display');
    if (!list) return;
    
    let totalG = 0; 
    let totalR = 0;
    let html = '';

    const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    const now = new Date();
    const day = now.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() + diffToMonday);
    startOfWeek.setHours(0,0,0,0);

    if (dateDisplay) {
        if (viewType === 'daily') {
            dateDisplay.innerText = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        } else {
            dateDisplay.innerText = "Week of " + startOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
    }

    goalsRoster.forEach(emp => {
        let empGoal = 0;
        let empResult = 0;
        let empRole = '-';
        let dailyStats = {};

        const rosterName = String(emp).trim().toLowerCase();
        const rosterFirst = rosterName.split(' ')[0];
        const empRecords = liveGoalsData.filter(r => {
            const dbName = String(r.employee).trim().toLowerCase();
            if (dbName === rosterName) return true;
            const dbFirst = dbName.split(' ')[0];
            if (dbFirst.length > 2 && rosterFirst.length > 2) {
                if (dbFirst.startsWith(rosterFirst) || rosterFirst.startsWith(dbFirst)) return true;
            }
            return false;
        });
        const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

        empRecords.forEach(record => {
            const isToday = normalizeGoalDate(record.date) === todayStr;
            const recDate = new Date(record.date);
            const isThisWeek = recDate >= startOfWeek;

            if (viewType === 'daily' && isToday) {
                empGoal = parseInt(record.goal) || 0;
                empResult = parseInt(record.result) || 0;
                empRole = record.role || '-';
            } else if (viewType === 'weekly' && isThisWeek) {
                const rG = parseInt(record.goal) || 0;
                const rR = parseInt(record.result) || 0;
                const dayKey = daysOfWeek[(recDate.getDay() + 6) % 7];
                dailyStats[dayKey] = { goal: rG, result: rR }; // last row in sheet wins per day
            }
        });

        if (viewType === 'weekly') {
            Object.values(dailyStats).forEach(d => { empGoal += d.goal; empResult += d.result; });
        }

        totalG += empGoal;
        totalR += empResult;

        let resultClass = 'delta-neutral';
        if (empGoal > 0 || empResult > 0) {
            resultClass = empResult >= empGoal ? 'delta-pos' : 'delta-neg';
        }

        let dailyBreakdownHtml = '';
        if (viewType === 'weekly') {
            const currentDayIdx = (now.getDay() + 6) % 7; 
            dailyBreakdownHtml = '<div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; padding-top: 4px; border-top: 1px dashed #f0f0f0;">';
            
            daysOfWeek.forEach((dName, idx) => {
                if (dailyStats[dName]) {
                    const dG = dailyStats[dName].goal;
                    const dR = dailyStats[dName].result;
                    const dClass = dR >= dG ? 'color: #065f46; background: #d1fae5;' : 'color: #991b1b; background: #fee2e2;';
                    dailyBreakdownHtml += `<div style="font-size: 9px; font-weight: 800; padding: 2px 6px; border-radius: 4px; ${dClass}">${dName}: ${dR}/${dG}</div>`;
                } else if (idx <= currentDayIdx) {
                    dailyBreakdownHtml += `<div style="font-size: 9px; font-weight: 800; padding: 2px 6px; border-radius: 4px; color: #64748b; background: #f1f5f9;" title="Not Logged">${dName}: N/A</div>`;
                } else {
                    dailyBreakdownHtml += `<div style="font-size: 9px; font-weight: 800; padding: 2px 6px; border-radius: 4px; color: #cbd5e1; border: 1px dashed #e2e8f0; background: transparent;">${dName}</div>`;
                }
            });
            dailyBreakdownHtml += '</div>';
        }

        html += `
        <div style="display: flex; flex-direction: column; border-bottom: 1px solid #f8fafc; padding: 6px 0;">
            <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; align-items: center;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <span class="goals-roster-name" style="font-size: 13px; font-weight: 800; color: var(--slate-charcoal); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${emp}</span>
                    ${viewType === 'daily' && empRole !== '-' ? `<span class="goals-roster-badge" style="font-size: 10px; background: #e2e8f0; color: var(--slate-charcoal); padding: 3px 6px; border-radius: 4px; display: inline-block; width: fit-content;">${empRole}</span>` : ''}
                </div>
                <div style="display: flex; justify-content: center;">
                    <span class="goals-roster-val target" style="font-size: 14px; text-align: center; font-weight: 900; color: var(--slate-charcoal); width: 36px; display: inline-block;">${empGoal || '-'}</span>
                </div>
                <div style="display: flex; justify-content: center; align-items: center;">
                    <span class="delta-badge ${resultClass}" style="font-size: 14px; width: 36px; height: 26px; padding: 0; display: inline-flex; justify-content: center; align-items: center;">${empResult || '-'}</span>
                </div>
            </div>
            ${dailyBreakdownHtml}
        </div>`;
    });

    list.innerHTML = html;
    document.getElementById('goals-total-target').innerText = totalG;
    
    const actualEl = document.getElementById('goals-total-actual');
    actualEl.innerText = totalR;
    
    if (totalG > 0 || totalR > 0) {
        if (totalR >= totalG) {
            actualEl.style.backgroundColor = '#d1fae5'; 
            actualEl.style.color = '#065f46';           
        } else {
            actualEl.style.backgroundColor = '#fee2e2'; 
            actualEl.style.color = '#991b1b';           
        }
    } else {
        actualEl.style.backgroundColor = '#f1f5f9';     
        actualEl.style.color = 'var(--slate-charcoal)'; 
    }
}

function switchGoalTab(tab) {
    const tD = document.getElementById('tab-daily');
    const tW = document.getElementById('tab-weekly');
    const actionBtn = document.getElementById('goals-action-btn');

    if (tab === 'daily') {
        tD.className = 'goal-tab active';
        tW.className = 'goal-tab inactive';
        actionBtn.style.display = 'block';
        renderGoalsScoreboard('daily');
    } else {
        tW.className = 'goal-tab active';
        tD.className = 'goal-tab inactive';
        actionBtn.style.display = 'none'; 
        renderGoalsScoreboard('weekly');
    }
}

function flipGoalCard(showEdit) {
    const flipper = document.getElementById('goals-flipper');
    const tabContainer = document.querySelector('.goal-tab-container');
    
    if (showEdit) {
        editingYesterday = false; // Always default to "Today" when initially flipping open
        buildGoalsEditForm();
        flipper.classList.add('is-flipped');
        if (tabContainer) {
            tabContainer.style.pointerEvents = 'none';
            tabContainer.style.opacity = '0.5';
        }
    } else {
        flipper.classList.remove('is-flipped');
        if (tabContainer) {
            tabContainer.style.pointerEvents = 'auto';
            tabContainer.style.opacity = '1';
        }
    }
}

function buildGoalsEditForm() {
    const container = document.getElementById('goals-edit-list');
    const now = new Date();
    
    // Shift the target date if they toggled to Yesterday
    if (editingYesterday) {
        now.setDate(now.getDate() - 1);
    }
    const targetDateStr = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    
    let html = '';
    const availableRoles = goalsRoster.length <= 2 ? ['B1', 'B2', 'L1'] : ['B1', 'B2', 'L1', 'L2'];

    // Inject the Toggle into the Header title space dynamically
    const titleEl = document.getElementById('goals-input-title');
    if (titleEl) {
        titleEl.innerHTML = `
            <div class="timeframe-toggle dark-toggle" style="margin-left: 0;">
                <button class="toggle-btn ${!editingYesterday ? 'active' : ''}" onclick="toggleEditDate(false)">Today</button>
                <button class="toggle-btn ${editingYesterday ? 'active' : ''}" onclick="toggleEditDate(true)">Yesterday</button>
            </div>
        `;
    }

    goalsRoster.forEach((emp, idx) => {
        // Find the record for the TARGET date (either Today or Yesterday)
        const targetRecord = liveGoalsData.find(r => r.employee === emp && r.date === targetDateStr) || { role: '', goal: '', result: '' };
        
        let rolesHtml = '';
        availableRoles.forEach(r => {
            const isActive = targetRecord.role === r ? 'active' : '';
            rolesHtml += `<button type="button" class="role-dot ${isActive}" onclick="selectRole(this, '${emp}', '${r}')">${r}</button>`;
        });

        html += `
        <div class="goals-edit-item">
            <div class="goals-edit-name">${emp}</div>
            <div class="goals-edit-controls">
                <div class="goals-edit-roles" id="roles-${idx}">
                    ${rolesHtml}
                </div>
                <div style="display:flex; gap: 8px;">
                    <input type="number" id="input-goal-${idx}" class="goal-input" placeholder="Goal" value="${targetRecord.goal}" title="Target Goal" />
                    <input type="number" id="input-result-${idx}" class="goal-input" placeholder="Actual" value="${targetRecord.result}" title="Actual Result" style="border-color: #a7f3d0; background: #ecfdf5;" />
                </div>
            </div>
        </div>`;
    });

    container.innerHTML = html;
}

function buildGoalsEditForm() {
    const container = document.getElementById('goals-edit-list');
    const now = new Date();
    
    // 1. Calculate the current time in Central Time to enforce the 10:30 AM lock
    const ctTimeString = now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: false, hour: 'numeric', minute: 'numeric' });
    const [hours, minutes] = ctTimeString.split(':').map(Number);
    const isPastCutoff = (hours > 10) || (hours === 10 && minutes >= 30);

    // 2. Shift the target date if they toggled to Yesterday
    if (editingYesterday) {
        now.setDate(now.getDate() - 1);
    }
    const targetDateStr = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    
    // 3. Determine if the Goal and Role should be locked
    const lockGoal = editingYesterday || (!editingYesterday && isPastCutoff);
    let lockWarning = "Target Goal";
    if (lockGoal) {
        lockWarning = editingYesterday ? "Goals cannot be changed retroactively." : "Goal setting locked after 10:30 AM.";
    }
    
    let html = '';
    const availableRoles = goalsRoster.length <= 2 ? ['B1', 'B2', 'L1'] : ['B1', 'B2', 'L1', 'L2'];

    // Inject the Toggle into the Header title space dynamically
    const titleEl = document.getElementById('goals-input-title');
    if (titleEl) {
        titleEl.innerHTML = `
            <div class="timeframe-toggle dark-toggle" style="margin-left: 0;">
                <button class="toggle-btn ${!editingYesterday ? 'active' : ''}" onclick="toggleEditDate(false)">Today</button>
                <button class="toggle-btn ${editingYesterday ? 'active' : ''}" onclick="toggleEditDate(true)">Yesterday</button>
            </div>
        `;
    }
    
    // Optional: Add a visual warning at the top if goals are locked
    if (lockGoal) {
        html += `<div style="font-size: 10px; color: var(--red-alert); font-weight: 800; text-align: center; margin-bottom: 12px; text-transform: uppercase;">⚠️ ${lockWarning}</div>`;
    }

    goalsRoster.forEach((emp, idx) => {
        const empNameNorm = String(emp).trim().toLowerCase();
        const targetRecord = liveGoalsData.find(r => {
            const dbName = String(r.employee).trim().toLowerCase();
            const nameMatch = dbName === empNameNorm || dbName.split(' ')[0].startsWith(empNameNorm.split(' ')[0]) || empNameNorm.split(' ')[0].startsWith(dbName.split(' ')[0]);
            const dateMatch = normalizeGoalDate(r.date) === targetDateStr;
            return nameMatch && dateMatch;
        }) || { role: '', goal: '', result: '' };

        let rolesHtml = '';
        availableRoles.forEach(r => {
            const isActive = targetRecord.role === r ? 'active' : '';
            // If the goal is locked, we also lock the role from being changed
            const disableRole = lockGoal ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : '';
            rolesHtml += `<button type="button" class="role-dot ${isActive}" ${disableRole} onclick="selectRole(this, '${emp}', '${r}')">${r}</button>`;
        });

        // If the goal is locked, we make the input unclickable and gray it out
        const disableGoalAttr = lockGoal ? 'disabled style="background: #f1f5f9; color: #94a3b8; border-color: #e2e8f0; cursor: not-allowed;"' : '';

        html += `
        <div class="goals-edit-item">
            <div class="goals-edit-name">${emp}</div>
            <div class="goals-edit-controls">
                <div class="goals-edit-roles" id="roles-${idx}">
                    ${rolesHtml}
                </div>
                <div style="display:flex; gap: 8px;">
                    <input type="number" id="input-goal-${idx}" class="goal-input" placeholder="Goal" value="${targetRecord.goal}" title="${lockWarning}" ${disableGoalAttr} />
                    <input type="number" id="input-result-${idx}" class="goal-input" placeholder="Actual" value="${targetRecord.result}" title="Actual Result" style="border-color: #a7f3d0; background: #ecfdf5;" />
                </div>
            </div>
        </div>`;
    });

    container.innerHTML = html;
    setTimeout(updateRoleLocks, 50); // <--- ADD THIS LINE
}

async function saveGoalsData() {
    const btn = document.getElementById('saveGoalsBtn');
    btn.innerText = "Saving to Database...";
    btn.style.opacity = "0.7";

    const now = new Date();
    if (editingYesterday) {
        now.setDate(now.getDate() - 1);
    }
    const targetDateStr = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });

    let payloadEmployees = [];

    goalsRoster.forEach((emp, idx) => {
        const roleGroup = document.getElementById(`roles-${idx}`);
        const activeBtn = roleGroup?.querySelector('.active');
        const role = activeBtn ? (activeBtn.getAttribute('data-selected-role') || activeBtn.innerText) : '-';
        
        const goal = document.getElementById(`input-goal-${idx}`).value;
        const result = document.getElementById(`input-result-${idx}`).value;

        if (role !== '-' || goal !== '' || result !== '') {
            payloadEmployees.push({ employee: emp, role: role, goal: goal, result: result });
        }
    });

    try {
        const response = await fetch(GOALS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ 
                store: goalsTargetStore, 
                date: targetDateStr, 
                employees: payloadEmployees 
            })
        });

        if(response.ok) {
            // Instantly update the local cache so the UI reflects it
            liveGoalsData = liveGoalsData.filter(r => !(r.date === targetDateStr && r.store === goalsTargetStore));
            payloadEmployees.forEach(p => {
                liveGoalsData.push({ date: targetDateStr, store: goalsTargetStore, employee: p.employee, role: p.role, goal: p.goal, result: p.result });
            });

            document.getElementById('goals-pulse-dot').style.display = 'none';
            const activeTab = document.getElementById('tab-daily').classList.contains('active') ? 'daily' : 'weekly';
            renderGoalsScoreboard(activeTab);
            flipGoalCard(false);

            // =========================================================
            // BULLETPROOF CHECKLIST AUTO-COMPLETE
            // =========================================================
            const userName = sessionStorage.getItem('speeksUserName') || 'Unknown';
            const store = sessionStorage.getItem('speeksUserStore') || 'OVL';
            let targetTaskId = null;

            // Step 1: Check if the user has already opened the TASKS tab today
            if (checklistDataCache && checklistDataCache.daily && checklistDataCache.daily.length > 0) {
                const task = checklistDataCache.daily.find(t => t.text.toLowerCase().includes('listing goals'));
                if (task) {
                    targetTaskId = task.id;
                    if (!task.checked) {
                        task.checked = true; // Visually check it off in memory
                        if (typeof renderChecklist === 'function') renderChecklist();
                    }
                }
            } 
            
            // Step 2: If the TASKS tab is unopened, silently fetch their list to find the correct Task ID
            if (!targetTaskId) {
                try {
                    const res = await fetch(`${CHECKLIST_URL}?user=${encodeURIComponent(userName)}&store=${store}&v=${Date.now()}`);
                    const data = await res.json();
                    if (data && data.daily) {
                        const task = data.daily.find(t => t.text.toLowerCase().includes('listing goals'));
                        if (task && !task.checked) targetTaskId = task.id;
                    }
                } catch (e) {
                }
            }

            // Step 3: Tell the Apps Script to flip the specific store column to TRUE
            if (targetTaskId) {
                fetch(CHECKLIST_URL, {
                    method: 'POST', mode: 'no-cors',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({ action: 'toggle', id: targetTaskId, checked: true, user: userName, store: store })
                }).catch(() => {});
            }
            // =========================================================

        } else {
            alert("Error saving goals to server.");
        }
    } catch (error) {
        alert("Connection failed. Please try again.");
    } finally {
        btn.innerText = "Save Changes";
        btn.style.opacity = "1";
    }
}

// --- DM COMPACT GOALS WIDGET ---
async function fetchDmGoalsData() {
    const cont = document.getElementById('dm-compact-goals-container');
    if (!cont) return;

    const stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    
    try {
        const fetches = stores.map(s => fetch(`${GOALS_API_URL}?store=${s}&v=${Date.now()}`).then(r => r.json()));
        const results = await Promise.all(fetches);
        allDistrictGoalsData = results.flat();
        renderCompactDmGoals();
    } catch (e) {
        cont.innerHTML = '<div class="status-message" style="color:var(--red-alert);">Network Sync Failed.</div>';
    }
}

function switchCompactDmTab(view) {
    currentDmGoalView = view;
    document.getElementById('dm-compact-tab-daily').classList.toggle('active', view === 'daily');
    document.getElementById('dm-compact-tab-weekly').classList.toggle('active', view === 'weekly');
    renderCompactDmGoals();
}

function toggleDmStoreAccordion(store) {
    const rosterDiv = document.getElementById(`dm-roster-${store}`);
    const caret = document.getElementById(`dm-caret-${store}`);
    const isOpen = rosterDiv.style.display === 'block';
    
    document.querySelectorAll('.dm-store-roster').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.dm-store-caret').forEach(el => el.style.transform = 'rotate(-90deg)');

    if (!isOpen) {
        rosterDiv.style.display = 'block';
        caret.style.transform = 'rotate(0deg)'; 
    }
}

function renderCompactDmGoals() {
    const cont = document.getElementById('dm-compact-goals-container');
    if (!cont) return;

    const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() + (now.getDay() === 0 ? -6 : 1 - now.getDay()));
    startOfWeek.setHours(0,0,0,0);

    const stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    let html = '<div style="display: flex; flex-direction: column;">';

    stores.forEach((store, idx) => {
        const storeData = allDistrictGoalsData.filter(r => r.store === store);
        let tGoal = 0, tResult = 0;
        let activeEmps = new Set();

        const storeDedup = {};
        storeData.forEach(r => {
            const recDate = new Date(r.date);
            const isToday = r.date === todayStr;
            const isThisWeek = recDate >= startOfWeek;

            if ((currentDmGoalView === 'daily' && isToday) || (currentDmGoalView === 'weekly' && isThisWeek)) {
                storeDedup[`${r.employee}|${r.date}`] = r; // last row in sheet wins per employee per day
                activeEmps.add(r.employee);
            }
        });
        Object.values(storeDedup).forEach(r => {
            tGoal += parseInt(r.goal) || 0;
            tResult += parseInt(r.result) || 0;
        });

        const progress = tGoal > 0 ? Math.min(100, Math.round((tResult / tGoal) * 100)) : 0;
        const colorClass = tResult >= tGoal && tGoal > 0 ? 'var(--sage-professional)' : (tResult > 0 ? 'var(--idea-gold)' : '#cbd5e1');
        const isMuted = tGoal === 0 && tResult === 0 ? 'opacity: 0.6;' : '';

        html += `
        <div onclick="toggleDmStoreAccordion('${store}')" class="lb-row" style="display: grid; grid-template-columns: 50px 1fr 70px 20px; align-items: center; border-bottom: 1px solid ${idx === stores.length-1 ? 'transparent' : '#f0f0f0'}; cursor: pointer; padding: 12px 15px; margin: 0; ${isMuted}">
            <span style="font-size: 14px; font-weight: 900; color: var(--slate-charcoal);">${store}</span>
            <div style="padding-right: 15px;">
                <div style="width: 100%; height: 6px; background: #f1f5f9; border-radius: 3px; overflow: hidden; display: flex;">
                    <div style="height: 100%; width: ${progress}%; background: ${colorClass}; border-radius: 3px; transition: width 0.5s ease;"></div>
                </div>
            </div>
            <div style="text-align: right; font-size: 14px; font-weight: 900; color: var(--slate-charcoal);">
                ${tResult} <span style="font-size: 11px; color: #888; font-weight: 600;">/ ${tGoal}</span>
            </div>
           <div id="dm-caret-${store}" class="dm-store-caret" style="text-align: right; color: #888; font-size: 10px; font-weight: 800; transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); transform: rotate(-90deg);">▼</div>
        </div>`;

        html += `<div id="dm-roster-${store}" class="dm-store-roster" style="display: none; background: #fdfdfd; padding: 10px 20px; border-bottom: 1px solid #e2e8f0; box-shadow: inset 0 3px 6px rgba(0,0,0,0.02);">`;
        
        if (activeEmps.size === 0) {
            html += `<div style="font-size: 12px; color: #888; text-align: center; font-weight: 600; padding: 10px 0;">No data logged.</div></div>`;
            return;
        }

        Array.from(activeEmps).forEach(emp => {
            const empRecords = storeData.filter(r => r.employee === emp);
            let eG = 0, eR = 0;
            let dailyStats = {}; 

            const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            empRecords.forEach(r => {
                const recDate = new Date(r.date);
                if ((currentDmGoalView === 'daily' && r.date === todayStr) || (currentDmGoalView === 'weekly' && recDate >= startOfWeek)) {
                    const rG = parseInt(r.goal) || 0;
                    const rR = parseInt(r.result) || 0;
                    if (currentDmGoalView === 'weekly') {
                        const dayIdx = (recDate.getDay() + 6) % 7;
                        dailyStats[daysOfWeek[dayIdx]] = { goal: rG, result: rR }; // last row wins per day
                    } else {
                        eG = rG; // daily: last record wins
                        eR = rR;
                    }
                }
            });
            if (currentDmGoalView === 'weekly') {
                Object.values(dailyStats).forEach(d => { eG += d.goal; eR += d.result; });
            }

            const rClass = eG > 0 || eR > 0 ? (eR >= eG ? 'delta-pos' : 'delta-neg') : 'delta-neutral';

            let dailyBreakdownHtml = '';
            if (currentDmGoalView === 'weekly') {
                const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                const currentDayIdx = (now.getDay() + 6) % 7;
                const pillStyle = "flex: 1; min-width: 0; text-align: center; font-size: 9px; font-weight: 800; padding: 4px 2px; border-radius: 4px; white-space: nowrap;";
                
                dailyBreakdownHtml = '<div style="display: flex; gap: 6px; margin-top: 4px; padding-top: 4px; width: 100%;">';
                
                daysOfWeek.forEach((dName, dIdx) => {
                    if (dailyStats[dName]) {
                        const dG = dailyStats[dName].goal;
                        const dR = dailyStats[dName].result;
                        const dClass = dR >= dG ? 'color: #065f46; background: #d1fae5;' : 'color: #991b1b; background: #fee2e2;';
                        dailyBreakdownHtml += `<div style="${pillStyle} ${dClass}">${dName}: ${dR}/${dG}</div>`;
                    } else if (dIdx <= currentDayIdx) {
                        dailyBreakdownHtml += `<div style="${pillStyle} color: #64748b; background: #f1f5f9;" title="Not Logged">${dName}</div>`;
                    } else {
                        dailyBreakdownHtml += `<div style="${pillStyle} color: #cbd5e1; border: 1px dashed #e2e8f0; background: transparent;">${dName}</div>`;
                    }
                });
                dailyBreakdownHtml += '</div>';
            }

            html += `
            <div style="display: flex; flex-direction: column; padding: 8px 0; border-bottom: 1px dashed #f0f0f0;">
                <div style="display: grid; grid-template-columns: 1fr auto auto; gap: 15px; align-items: center;">
                    <span style="font-size: 13px; font-weight: 700; color: var(--slate-charcoal);">${emp}</span>
                    <div style="display: flex; justify-content: center;">
                        <span style="font-size: 14px; font-weight: 800; color: #64748b; width: 36px; text-align: center; display: inline-block;">${eG || '-'}</span>
                    </div>
                    <div style="display: flex; justify-content: center; align-items: center;">
                        <span class="delta-badge ${rClass}" style="font-size: 14px; width: 36px; height: 26px; padding: 0; display: inline-flex; justify-content: center; align-items: center;">${eR || '-'}</span>
                    </div>
                </div>
                ${dailyBreakdownHtml}
            </div>`;
        });
        
        html += `</div>`; 
    });

    html += '</div>'; 
    cont.innerHTML = html;
}

// ============================================================================
// 21. MODULE: EMPLOYEE DASHBOARD WIDGETS
// ============================================================================

async function fetchAndRenderEmployeeGoals() {
    const container = document.getElementById('employee-goals-widget-body');
    const dateLabel = document.getElementById('emp-goals-date');
    const pulseDot = document.getElementById('emp-goals-pulse-dot');
    if (!container) return;

    const userName = sessionStorage.getItem('speeksUserName') || '';
    let store = sessionStorage.getItem('speeksUserStore') || 'OVL';
    if (store === 'ALL' || store === 'CORP') store = 'OVL';

    const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() + (now.getDay() === 0 ? -6 : 1 - now.getDay()));
    startOfWeek.setHours(0,0,0,0);

    const ctTimeString = now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
    const hours = parseInt(ctTimeString, 10);
    
    if (pulseDot) {
        pulseDot.style.display = (hours === 9 || hours === 19) ? 'block' : 'none';
    }

    if (dateLabel) {
        dateLabel.innerText = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }

    try {
        const res = await fetch(`${GOALS_API_URL}?store=${store}&v=${Date.now()}`);
        const data = await res.json();
        
        const myRecords = data.filter(r => {
            const dbName = String(r.employee).trim().toLowerCase();
            const sessionName = String(userName).trim().toLowerCase();
            
            if (dbName === sessionName) return true; 
            
            const dbFirstName = dbName.split(' ')[0];
            const sessionFirstName = sessionName.split(' ')[0];
            
            if (dbFirstName.length > 2 && sessionFirstName.length > 2) {
                if (dbFirstName.startsWith(sessionFirstName) || sessionFirstName.startsWith(dbFirstName)) return true;
            }
            return false;
        });
        
        let todayGoal = 0;
        let todayRole = '';
        let dailyStats = {};

        myRecords.forEach(r => {
            const recDate = new Date(r.date);
            const g = parseInt(r.goal) || 0;
            const resVal = parseInt(r.result) || 0;

            if (r.date === todayStr) {
                todayGoal = g;
                if (r.role && r.role !== '-') todayRole = r.role;
            }
            
            if (recDate >= startOfWeek) {
                const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                const dayIdx = (recDate.getDay() + 6) % 7; 
                dailyStats[daysOfWeek[dayIdx]] = { goal: g, result: resVal };
            }
        });

        const roleTranslations = { 'B1': 'Buyer 1', 'B2': 'Buyer 2', 'L1': 'Lister 1', 'L2': 'Lister 2' };
        const displayRole = roleTranslations[todayRole] || todayRole;

        const roleDescriptions = {
            'B1': 'You\'re the lead buyer — first up for every customer who walks through the door. When someone comes in, that\'s your call.',
            'B2': 'You\'re the second buyer in rotation. Hang back and jump in the moment a second customer arrives.',
            'L1': 'Dedicated listing only — no buying, no shipping, no exceptions. Your entire focus today is getting items listed and nothing else.',
            'L2': 'You\'re a primary lister throughout the day, but also serve as the emergency buyer when 4 or more separate customers are in the store at once.'
        };
        const roleDesc = roleDescriptions[todayRole] || '';

        const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const currentDayIdx = (now.getDay() + 6) % 7;
        
        let dailyBreakdownHtml = '<div class="emp-pill-container">';
        
        daysOfWeek.forEach((dName, dIdx) => {
            if (dailyStats[dName]) {
                const dG = dailyStats[dName].goal;
                const dR = dailyStats[dName].result;
                const dClass = dR >= dG ? 'pill-pass' : 'pill-fail';
                dailyBreakdownHtml += `<div class="emp-daily-pill ${dClass}">${dName}: ${dR}/${dG}</div>`;
            } else if (dIdx <= currentDayIdx) {
                dailyBreakdownHtml += `<div class="emp-daily-pill pill-null" title="Not Logged">${dName}</div>`;
            } else {
                dailyBreakdownHtml += `<div class="emp-daily-pill pill-future">${dName}</div>`;
            }
        });
        dailyBreakdownHtml += '</div>';

        container.innerHTML = `
            <div class="emp-goals-top-row">
                <div class="emp-goal-col">
                    <span class="emp-goal-label">TODAY'S TARGET</span>
                    <span class="emp-goal-value">${todayGoal > 0 ? todayGoal : '-'}</span>
                </div>
                <div class="emp-goal-col emp-goal-col-right">
                    <span class="emp-goal-label">MY ROLE</span>
                    <span class="emp-goal-value">${displayRole || '-'}</span>
                </div>
            </div>

            ${roleDesc ? `<div class="emp-role-description">${roleDesc}</div>` : ''}

            <div class="emp-week-section">
                <span class="emp-goal-label">THIS WEEK'S BREAKDOWN</span>
                ${dailyBreakdownHtml}
            </div>
        `;
    } catch (e) {
        container.innerHTML = '<div class="status-message" style="color:var(--red-alert);">Failed to sync goals.</div>';
    }
}

async function fetchAndRenderEmployeeKPIs() {
    const container = document.getElementById('employee-kpi-widget-body');
    const periodLabel = document.getElementById('emp-kpi-period');
    if (!container) return;

    const userName = sessionStorage.getItem('speeksUserName') || '';
    let store = sessionStorage.getItem('speeksUserStore') || 'OVL';
    if (store === 'ALL' || store === 'CORP') store = 'OVL';

    try {
        const response = await fetch(`${WEEKLY_KPI_URL}?store=${store}&v=${Date.now()}`);
        const d = await response.json();

        // New clean JSON format: { employees, store_total, period_label }
        const emps   = d.employees   || [];
        const total  = d.store_total || {};
        const pTxt   = d.period_label || '';

        const fmtBuy = v => v != null ? `$${Math.round(Number(v)).toLocaleString()}` : '';
        const fmtPct = v => v != null ? `${Number(v).toFixed(1)}` : '';
        const fmtN   = v => v != null ? String(Math.round(Number(v))) : '';
        const fmtMin = v => v != null ? `${Number(v).toFixed(1)}` : '';

        let sAvg = {
            buyVal:     fmtBuy(total.buying_value),
            buyMargin:  fmtPct(total.gross_margin_pct),
            customers:  fmtN(total.transaction_count),
            conversion: fmtPct(total.customer_conversion_pct),
            time:       fmtMin(total.avg_transaction_time),
            noDeals:    fmtN(total.no_deal_count),
            listed:     fmtN(total.listed_count),
        };

        const sessionName      = String(userName).trim().toLowerCase();
        const sessionFirstName = sessionName.split(' ')[0];
        const myEntry = emps.find(e => {
            const dbName  = String(e.employee_name).trim().toLowerCase();
            if (dbName === sessionName) return true;
            const dbFirst = dbName.split(' ')[0];
            return dbFirst.length > 2 && sessionFirstName.length > 2 &&
                   (dbFirst.startsWith(sessionFirstName) || sessionFirstName.startsWith(dbFirst));
        });

        let myData = {};
        if (myEntry) {
            myData = {
                buyVal:     fmtBuy(myEntry.buying_value),
                buyMargin:  fmtPct(myEntry.gross_margin_pct),
                customers:  fmtN(myEntry.transaction_count),
                conversion: fmtPct(myEntry.customer_conversion_pct),
                time:       fmtMin(myEntry.avg_transaction_time),
                noDeals:    fmtN(myEntry.no_deal_count),
                listed:     fmtN(myEntry.listed_count),
            };
        }

        if (periodLabel) periodLabel.innerText = pTxt;

        // --- NEW: ROBUST VARIANCE FETCH ---
        let formattedMyVar = '-';
        let formattedStoreVar = '-';
        
        let vData = typeof liveVarianceDataCache !== 'undefined' ? liveVarianceDataCache : null;
        
        // If cache isn't ready yet, force an immediate fetch so we don't load a blank widget
        if (!vData || Object.keys(vData).length === 0) {
            try {
                const vRes = await fetch(`${VARIANCE_API_URL}?v=${Date.now()}`);
                vData = await vRes.json();
                if (typeof liveVarianceDataCache !== 'undefined') liveVarianceDataCache = vData;
            } catch(e) { /* fallback variance unavailable */ }
        }

        if (vData && vData[store]) {
            const sVar = vData[store];
            
            // Safe formatting helper to convert decimal to percentage string
            const safeFormatVar = (val) => {
                let n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
                if (isNaN(n)) return '-';
                return Math.abs(n) < 0.001 ? '0.00%' : `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(2)}%`;
            };

            formattedStoreVar = safeFormatVar(sVar.total);
            
            const sessionName = String(userName).trim().toLowerCase();
            const sessionFirstName = sessionName.split(' ')[0];
            
            if (sVar.employees) {
                const empVarMatch = sVar.employees.find(e => {
                    const dbName = String(e.name).trim().toLowerCase();
                    if (dbName === sessionName) return true; 
                    const dbFirstName = dbName.split(' ')[0];
                    if (dbFirstName.length > 2 && sessionFirstName.length > 2) {
                        return dbFirstName.startsWith(sessionFirstName) || sessionFirstName.startsWith(dbFirstName);
                    }
                    return false;
                });
                
                if (empVarMatch) {
                    formattedMyVar = safeFormatVar(empVarMatch.val);
                }
            }
        }

        if (Object.keys(myData).length === 0) {
            container.innerHTML = '<div class="status-message">No KPI data found for your user this week.</div>';
            return;
        }

        const buildStatGridItem = (title, myVal, storeVal, ruleStr, isPercent = false, prefixLabel = "Store:", showBubble = true) => {
            const myIsBad = ruleStr ? checkRule(ruleStr, myVal) : false;
            
            let displayMyVal = myVal || '-';
            if (displayMyVal !== '-' && isPercent && !String(displayMyVal).includes('%')) displayMyVal += '%';
            
            let displayStoreVal = storeVal || '-';
            if (displayStoreVal !== '-' && isPercent && !String(displayStoreVal).includes('%')) displayStoreVal += '%';

            let centerHtml = '';
            if (showBubble) {
                const badgeClass = displayMyVal === '-' ? 'badge-null' : (myIsBad ? 'badge-fail' : 'badge-pass');
                centerHtml = `<div class="emp-kpi-badge ${badgeClass}" style="margin: 4px 0; padding: 4px 6px; font-size: 11px;">${displayMyVal}</div>`;
            } else {
                centerHtml = `<div style="font-size: 13px; font-weight: 900; color: var(--slate-charcoal); margin: 4px 0; padding: 4px 0;">${displayMyVal}</div>`;
            }

            return `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 6px; border: 1px dashed #e2e8f0; border-radius: 6px; background: #fdfdfd; height: 100%;">
                <span style="font-size: 9px; font-weight: 900; color: var(--slate-charcoal); text-transform: uppercase; line-height: 1;">${title}</span>
                ${centerHtml}
                <span style="font-size: 8px; font-weight: 700; color: #a0aab2; text-transform: uppercase;">${prefixLabel} <strong>${displayStoreVal}</strong></span>
            </div>`;
        };

        // Split into two grid rows to stretch the bottom 3 boxes evenly
        container.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 6px; height: 100%;">
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; flex: 1;">
                    ${buildStatGridItem('Buying Value', myData.buyVal, sAvg.buyVal, null, false, 'Store Total:', false)}
                    ${buildStatGridItem('Margin', myData.buyMargin, sAvg.buyMargin, 'margin', true, 'Store Avg:', true)}
                    ${buildStatGridItem('Conversion', myData.conversion, sAvg.conversion, 'conversion', true, 'Store Avg:', true)}
                    ${buildStatGridItem('Variance', formattedMyVar, formattedStoreVar, 'variance', false, 'Store Total:', true)}
                </div>
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; flex: 1;">
                    ${buildStatGridItem('No Deals', myData.noDeals, sAvg.noDeals, 'nodeals', false, 'Store Total:', true)}
                    ${buildStatGridItem('Trans. Time', myData.time, sAvg.time, 'time', false, 'Store Avg:', true)}
                    ${buildStatGridItem('Listed Dev.', myData.listed, sAvg.listed, null, false, 'Store Total:', false)}
                </div>
            </div>
        `;
    } catch (e) {
        container.innerHTML = '<div class="status-message" style="color:var(--red-alert);">Failed to sync KPIs.</div>';
    }
}

// ============================================================================
// 22. MODULE: FIRST-LOGIN TUTORIAL
// ============================================================================

let _tutorialSlide = 0;
const _TUTORIAL_TOTAL = 8;

async function checkAndShowTutorial(userName) {
    const key = 'speeksTutorial_' + userName.trim().toLowerCase().replace(/\s+/g, '_');
    if (localStorage.getItem(key) === 'done') return;

    if (TUTORIAL_URL) {
        try {
            const res = await fetch(`${TUTORIAL_URL}?user=${encodeURIComponent(userName)}&v=${Date.now()}`);
            const data = await res.json();
            if (data.completed) { localStorage.setItem(key, 'done'); return; }
        } catch (e) { /* network error — still show tutorial, server will re-check next login */ }
    }

    _tutorialSlide = 0;
    _updateTutorialUI();
    const overlay = document.getElementById('tutorialOverlay');
    if (overlay) overlay.classList.add('active');
    document.body.classList.add('no-scroll');
}

function tutorialNav(dir) {
    const next = _tutorialSlide + dir;
    if (next < 0) return;
    if (next >= _TUTORIAL_TOTAL) { _completeTutorial(); return; }
    _tutorialSlide = next;
    _updateTutorialUI();
}

function _updateTutorialUI() {
    document.querySelectorAll('.tutorial-slide').forEach((s, i) => s.classList.toggle('active', i === _tutorialSlide));
    document.querySelectorAll('.tut-dot').forEach((d, i) => d.classList.toggle('active', i === _tutorialSlide));

    const prev = document.getElementById('tutorialPrev');
    const next = document.getElementById('tutorialNext');
    const counter = document.getElementById('tutorialCounter');
    const isLast = _tutorialSlide === _TUTORIAL_TOTAL - 1;

    if (prev) prev.disabled = _tutorialSlide === 0;
    if (counter) counter.textContent = `${_tutorialSlide + 1} of ${_TUTORIAL_TOTAL}`;
    if (next) {
        next.textContent = isLast ? 'Get Started! 🚀' : 'Next →';
        next.classList.toggle('tut-finish', isLast);
    }
}

async function _completeTutorial() {
    const overlay = document.getElementById('tutorialOverlay');
    if (overlay) overlay.classList.remove('active');
    document.body.classList.remove('no-scroll');

    const userName = sessionStorage.getItem('speeksUserName') || '';
    const key = 'speeksTutorial_' + userName.trim().toLowerCase().replace(/\s+/g, '_');
    localStorage.setItem(key, 'done');

    if (userName && TUTORIAL_URL) {
        fetch(TUTORIAL_URL, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'complete', user: userName })
        }).catch(() => {});
    }
}

// ============================================================================
// 23. MODULE: ROLE-BASED UI & INITIALIZATION
// ============================================================================

function applyRoleBasedUI() {
    const userRole = sessionStorage.getItem('speeksUserRole') || 'employee';
    const userStore = sessionStorage.getItem('speeksUserStore') || 'ALL';
    const userName = sessionStorage.getItem('speeksUserName') || 'User';

    const greetingEl = document.getElementById('userGreeting');
    if (greetingEl) greetingEl.innerText = `Welcome ${userName}!`;

    const userRoleClass = `role-${userRole.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-')}`;
    const userStoreClass = `store-${userStore.toLowerCase()}`;

    document.querySelectorAll('.dynamic-module-flex, .dynamic-module-block, .dynamic-module').forEach(module => {
        const classes = Array.from(module.classList);
        const requiredRoles = classes.filter(c => c.startsWith('role-'));
        const requiredStores = classes.filter(c => c.startsWith('store-'));

        const passesRole = requiredRoles.length === 0 ||
            requiredRoles.includes(userRoleClass) ||
            (userRoleClass === 'role-assistant-manager' && requiredRoles.includes('role-employee'));
        const passesStore = requiredStores.length === 0 || requiredStores.includes(userStoreClass);

        if (passesRole && passesStore) {
            let displayType = module.classList.contains('dynamic-module-flex') ? 'flex' : 'block';
            module.style.setProperty('display', displayType, 'important');
        } else {
            module.style.setProperty('display', 'none', 'important');
        }
    });

    if (userRole === 'employee' || userRole === 'assistant manager') {
        document.querySelectorAll('.manager-only').forEach(el => el.style.setProperty('display', 'none', 'important'));
    }

    if (userRoleClass === 'role-assistant-manager') {
        document.body.classList.add('am-mode');
        const empRow = document.querySelector('.employee-dashboard-row');
        if (empRow) {
            empRow.style.setProperty('display', 'grid', 'important');
            empRow.style.setProperty('grid-template-columns', '1fr 1fr', 'important');
            empRow.style.setProperty('align-items', 'stretch', 'important');
        }
        const bsCard = document.querySelector('.buying-sales-module');
        if (bsCard) bsCard.style.setProperty('display', 'flex', 'important');
    }

    if (userStore !== 'ALL') {
        ['kpiStoreSelect', 'am-kpiStoreSelect', 'weeklyKpiStoreSelect', 'bsStoreSelect', 'vw-primary', 'dmChartStoreSelector', 'mbStoreSelect'].forEach(id => {
            const dropdown = document.getElementById(id);
            if (dropdown && Array.from(dropdown.options).some(opt => opt.value === userStore)) {
                dropdown.value = userStore;
            }
        });
    }

}

function checkInstantNotifCache() {
    const currentUser = sessionStorage.getItem('speeksUserName');
    if (!currentUser) return;

    const hasAnns   = localStorage.getItem('speeksUnreadAnnouncements_' + currentUser) === 'true';
    const hasPatch  = localStorage.getItem('speeksUnseenPatchNotes_'     + currentUser) === 'true';
    if (hasAnns || hasPatch) {
        const badge = document.getElementById('notifBadge');
        if (badge) { badge.style.display = 'block'; badge.classList.add('active'); }
    }
}

// Shows/hides the main bell badge based on BOTH unread announcements AND unseen patch notes
function updateMainBadge() {
    const currentUser = sessionStorage.getItem('speeksUserName');
    const cleanUser   = currentUser ? String(currentUser).trim().toLowerCase() : null;
    const hasAnns  = cleanUser && localStorage.getItem('speeksUnreadAnnouncements_' + cleanUser) === 'true';
    const hasPatch = cleanUser && localStorage.getItem('speeksUnseenPatchNotes_'     + cleanUser) === 'true';
    const show = hasAnns || hasPatch;
    const badge = document.getElementById('notifBadge');
    if (badge) { badge.style.display = show ? 'block' : 'none'; badge.classList.toggle('active', show); }
}

// Called after fetching patch notes — shows/hides the tab dot and main badge
function checkPatchNotesBadge() {
    if (!_latestPatchKey) return;
    const currentUser = sessionStorage.getItem('speeksUserName');
    const cleanUser   = currentUser ? String(currentUser).trim().toLowerCase() : null;
    const seen  = cleanUser ? localStorage.getItem('speeksPatchNotesSeen_' + cleanUser) : null;
    const isNew = seen !== _latestPatchKey;

    if (cleanUser) {
        if (isNew) localStorage.setItem('speeksUnseenPatchNotes_' + cleanUser, 'true');
        else        localStorage.removeItem('speeksUnseenPatchNotes_' + cleanUser);
    }
    const pnBadge = document.getElementById('patchNotesBadge');
    if (pnBadge) { pnBadge.style.display = isNew ? 'block' : 'none'; pnBadge.classList.toggle('active', isNew); }

    if (isNew) {
        const mainBadge = document.getElementById('notifBadge');
        if (mainBadge) { mainBadge.style.display = 'block'; mainBadge.classList.add('active'); }
    } else {
        updateMainBadge();
    }
}

// Lightweight background fetch — just checks if there's a new patch notes version
async function checkForNewPatchNotes() {
    try {
        const data = await fetch(`${PATCH_NOTES_URL}?v=${Date.now()}`).then(r => r.json());
        if (!data.entries || !data.entries.length) return;
        const groups = buildPatchGroups(data.entries);
        if (groups.length > 0) {
            _latestPatchKey = groups[0].title + '|' + groups[0].date;

            // Restore read state from server in case browser data was cleared
            const currentUser = sessionStorage.getItem('speeksUserName');
            const cleanUser   = currentUser ? String(currentUser).trim().toLowerCase() : null;
            if (cleanUser) {
                try {
                    const readData = await fetch(`${PATCH_NOTES_URL}?action=getPatchRead&user=${encodeURIComponent(cleanUser)}&v=${Date.now()}`).then(r => r.json());
                    if (readData.lastSeenKey === _latestPatchKey) {
                        localStorage.setItem('speeksPatchNotesSeen_' + cleanUser, _latestPatchKey);
                        localStorage.removeItem('speeksUnseenPatchNotes_' + cleanUser);
                    }
                } catch (e) {}
            }

            checkPatchNotesBadge();
        }
    } catch (e) {}
}

function initDashboardData() { 
    // 1. Instantly check memory for the red dot before any servers are contacted
    checkInstantNotifCache();

    const runInit = () => {
        if (typeof initChecklists === 'function') initChecklists();
        renderMonthlyGoalsBanner();
        renderDistrictGoals();
        syncGoalsFromSheet();
        renderCompanyProjectsBanner();
        renderStoreInitiatives();
        renderDistrictCompanyProjects();
        renderDistrictInitiativesGrid();
        syncInitiativesFromSheet();

        // Re-sync announcements immediately after login so it knows who you are!
        setTimeout(loadCMS, 50);
        setTimeout(checkForNewPatchNotes, 800); // background check for new patch notes
        setTimeout(startReactionPolling, 3000);

        setTimeout(fetchHubData, 100); 
        setTimeout(fetchVarianceData, 300); 
        setTimeout(fetchWeeklyKPIs, 500); 
        
        setTimeout(fetchScorecardData, 600);
        setTimeout(fetchAlertsData, 650);
        setTimeout(fetchMasterDistrictDashboard, 680);
        setTimeout(fetchKPIData, 700);
        setTimeout(fetchDistrictMonthlyKPIs, 750);
        setTimeout(fetchRecordsData, 800);
        setTimeout(() => { if (document.getElementById('mainKpiChart')) fetchChartData(currentTimeframe); }, 950);
        setTimeout(() => { if (document.getElementById('mbBody')) fetchMonthlyBrief(); }, 1000);
        setTimeout(fetchChampions, 850);
        setTimeout(fetchAwardsData, 900);
        setTimeout(fetchDmGoalsData, 1000);
        setTimeout(fetchAndRenderEmployeeGoals, 1100);
        setTimeout(fetchAndRenderEmployeeKPIs, 1200);
        setTimeout(fetchAndDisplayStoreComment, 1500);
        startStoreCommentPolling();


        // Pre-load checklist in background so chip + glow appear without opening the panel
        const _clRole = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase();
        if (_clRole === 'manager' || _clRole === 'district manager') {
            setTimeout(loadChecklist, 1200);
        }


        if (typeof preloadAllStores === 'function') setTimeout(preloadAllStores, 4000); 
        if (typeof initListingGoals === 'function') setTimeout(initListingGoals, 200);
    };

    if (typeof Chart === 'undefined') {
        const s1 = document.createElement('script'); 
        s1.src = 'https://cdn.jsdelivr.net/npm/chart.js';
        
        const s2 = document.createElement('script'); 
        s2.src = 'https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.0.0';
        
        s1.onload = () => { 
            document.head.appendChild(s2); 
            s2.onload = runInit; 
        };
        document.head.appendChild(s1);
    } else {
        runInit();
    }
}

// --- INIT LISTENERS ---
document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => document.body.classList.remove('preload'), 150);

    if (localStorage.getItem('speeksSidebar') === 'collapsed') { 
        document.querySelector('.sidebar')?.classList.add('collapsed'); 
        document.querySelector('.main-content')?.classList.add('expanded'); 
        document.querySelector('.sidebar-toggle')?.classList.add('collapsed'); 
    }
    
    loadCMS();
    injectGlobalAuth();
    injectIdeaModal(); 
    startAuthFetch();
    
    if (document.getElementById('kbBody')) loadHotkeys();
    if (document.getElementById('content-container') && document.getElementById('docSearch')) { 
        loadDocs(); 
        document.getElementById('docSearch').addEventListener('keyup', filterDocs); 
    }

    if (sessionStorage.getItem('speeksUnlocked') === 'true') {
        document.body.classList.add('is-authenticated');
        const authOverlay = document.getElementById('authOverlay');
        if (authOverlay) authOverlay.style.display = 'none';
        document.body.style.overflow = '';

        closeAllModals();
        applyRoleBasedUI();
        initDashboardData();
        initTicker();
        if (document.getElementById('mainKpiChart')) syncAllData();
    } else {
        if (!window.location.href.includes('index.html') && document.getElementById('authOverlay')) {
            window.location.href = "index.html"; 
            return;
        }
        const authOverlay = document.getElementById('authOverlay');
        if (authOverlay) {
            authOverlay.style.display = 'flex'; 
            document.body.style.overflow = 'hidden'; 
            document.getElementById('pinInput')?.focus(); 
        }
    }
    
    ['kpiStoreSelect', 'am-kpiStoreSelect', 'weeklyKpiStoreSelect', 'vw-primary', 'vw-compare'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            if (id === 'kpiStoreSelect') {
                fetchKPIData(false);
            } else if (id === 'am-kpiStoreSelect') {
                const origStore = document.getElementById('kpiStoreSelect');
                if (origStore) origStore.value = document.getElementById('am-kpiStoreSelect').value;
                fetchKPIData(false);
            } else if (id === 'weeklyKpiStoreSelect') {
                fetchWeeklyKPIs();
            } else {
                renderVariance();
            }
        });
    });
    
});

// ============================================================================
// 23. CUSTOM TOOLTIP LOGIC
// ============================================================================
const customTooltip = document.createElement('div');
customTooltip.className = 'speeks-tooltip';
document.body.appendChild(customTooltip);

document.addEventListener('mouseover', function(e) {
    const goalMini = e.target.closest('.dg-goal-mini');
    if (goalMini) {
        const title = goalMini.dataset.goalTitle;
        const desc = goalMini.dataset.goalDesc;
        if (title) {
            customTooltip.style.setProperty('--tip-color', 'var(--sage-professional)');
            customTooltip.innerHTML = `
                <strong style="display:block; margin-bottom: 6px; color: var(--sage-professional); font-size: 13px;">${title}</strong>
                ${desc ? `<span style="font-size: 12px; color: var(--slate-charcoal); line-height: 1.5;">${desc}</span>` : ''}`;
            customTooltip.classList.add('show');
            return;
        }
    }

    const panelItem = e.target.closest('.cpb-project-item, .mgb-goal-item');
    if (panelItem) {
        const titleEl = panelItem.querySelector('.mgb-goal-title');
        const descEl  = panelItem.querySelector('.mgb-goal-desc');
        const isTitleCut = titleEl && titleEl.scrollWidth > titleEl.clientWidth;
        const isDescCut  = descEl  && descEl.scrollHeight > descEl.clientHeight;
        if (isTitleCut || isDescCut) {
            const color = panelItem.classList.contains('cpb-initiative-item') ? '#f59e0b'
                        : panelItem.classList.contains('mgb-goal-item')       ? '#5a8d3b'
                        : '#3b82f6';
            customTooltip.style.setProperty('--tip-color', color);
            customTooltip.innerHTML = `
                <strong style="display:block; margin-bottom: 6px; font-size: 13px; color: var(--slate-charcoal);">${titleEl ? titleEl.innerText.trim() : ''}</strong>
                ${descEl ? `<span style="font-size: 12px; color: #64748b; line-height: 1.4;">${descEl.innerText.trim()}</span>` : ''}`;
            customTooltip.classList.add('show');
            return;
        }
    }

    const card = e.target.closest('.doc-card');

    if (card) {
        const titleEl = card.querySelector('.doc-title');
        const descEl = card.querySelector('.doc-desc');

        if (titleEl && descEl) {
            const isTitleCut = titleEl.scrollWidth > titleEl.clientWidth;
            const isDescCut = descEl.scrollHeight > descEl.clientHeight;

            if (isTitleCut || isDescCut) {
                customTooltip.innerHTML = `
                    <strong style="display:block; margin-bottom: 6px; color: var(--sage-professional); font-size: 14px; white-space: nowrap;">
                        ${titleEl.innerText.trim()}
                    </strong>
                    <span style="font-size: 12px; color: var(--slate-charcoal); line-height: 1.4;">
                        ${descEl.innerText.trim()}
                    </span>`;
                customTooltip.classList.add('show');
                return;
            }
        }
    }
    customTooltip.classList.remove('show');
});

document.addEventListener('mousemove', function(e) {
    if (customTooltip.classList.contains('show')) {
        let x = e.pageX + 15;
        let y = e.pageY + 15;
        
        if (x + customTooltip.offsetWidth > window.innerWidth - 20) {
            x = e.pageX - customTooltip.offsetWidth - 10;
        }
        
        customTooltip.style.left = x + 'px';
        customTooltip.style.top = y + 'px';
    }
});

document.addEventListener('mouseout', function(e) {
    if (e.target.closest('.doc-card') || e.target.closest('.dg-goal-mini')) {
        customTooltip.classList.remove('show');
    }
});

window.addEventListener('scroll', function() {
    customTooltip.classList.remove('show');
}, { passive: true });

// ============================================================================
// 24. ZERO-FLICKER SPA ROUTER
// ============================================================================
document.addEventListener('click', async (e) => {
    const link = e.target.closest('.nav-link'); 
    
    if (link && link.href && link.href.startsWith(window.location.origin) && !link.href.includes('#')) {
        e.preventDefault(); 
        
        const targetUrl = link.href;
        if (targetUrl === window.location.href) return; 
        
        try {
            const response = await fetch(targetUrl);
            const html = await response.text();
            
            const parser = new DOMParser();
            const newDoc = parser.parseFromString(html, 'text/html');
            
            const currentMain = document.querySelector('.main-content');
            const newMain = newDoc.querySelector('.main-content');
            
            if (currentMain && newMain) {
                currentMain.innerHTML = newMain.innerHTML;
            }

            document.querySelectorAll('.nav-link').forEach(nav => nav.classList.remove('active'));
            const newActiveLink = Array.from(document.querySelectorAll('.nav-link')).find(n => n.href === targetUrl);
            if (newActiveLink) newActiveLink.classList.add('active');

            window.history.pushState({ path: targetUrl }, '', targetUrl);
            document.title = newDoc.title;

            applyRoleBasedUI();
            closeAllModals();

            if (targetUrl.includes('docs.html')) {
                if (typeof loadDocs === 'function') loadDocs();
                const docSearch = document.getElementById('docSearch');
                if (docSearch) docSearch.addEventListener('keyup', filterDocs);
            } else {
                setTimeout(() => {
                    if (typeof initDashboardData === 'function') initDashboardData();
                    if (document.getElementById('mainKpiChart') && typeof syncAllData === 'function') syncAllData();
                    if (document.getElementById('pane-records') && typeof fetchRecordsData === 'function') fetchRecordsData();
                    if (document.getElementById('listing-champions-body') && typeof fetchChampions === 'function') fetchChampions();
                }, 100);
            }

        } catch (err) {
            console.error("SPA Routing failed, falling back to hard load", err);
            window.location.href = targetUrl; 
        }
    }
});

window.addEventListener('popstate', () => {
    window.location.reload(); 
});

// ============================================================================
// 25. THE MISSING FUNCTIONS (CHARTS & MANAGER MODALS)
// ============================================================================

// --- CHART: RENDER KPI ---
function renderKpiChart(payload, metric) {
    if (!document.getElementById('mainKpiChart')) return;
    if (typeof Chart === 'undefined') {
        const loader = document.getElementById('chartLoading');
        if (loader) { loader.innerHTML = '<div class="status-message" style="color:var(--red-alert);">Chart.js Library Missing!</div>'; loader.style.display = 'flex'; }
        return;
    }
    if (!payload) return;

    // ── Metric config ────────────────────────────────────────────────────────
    const METRIC = {
        conversion: { field: 'customer_conversion_pct', moName: 'Customer Conversion %', unit: '%',  isPct: true  },
        margin:     { field: 'gross_margin_pct',         moName: 'Gross Margin %',         unit: '%',  isPct: true  },
        nodeals:    { field: 'no_deal_count',             moName: 'No Deal Count',           unit: '',   isPct: false },
        time:       { field: 'avg_transaction_time',      moName: 'Avg Transaction Time',    unit: ' min',isPct: false },
    };
    const mc = METRIC[metric] || METRIC.conversion;
    const { field, unit, isPct } = mc;

    const STORE_COLORS = { OVL:'#a855f7', LEE:'#3b82f6', WSP:'#22c55e', MPL:'#f97316', BAL:'#ef4444' };
    const EMP_COLORS   = ['#a855f7','#3b82f6','#22c55e','#f97316','#ef4444','#14b8a6','#eab308','#ec4899'];

    const dmDropdown = document.getElementById('dmChartStoreSelector');
    if (dmDropdown) dmDropdown.style.display = payload.mode === 'employees' ? 'block' : 'none';

    const safeVal = (v) => {
        if (v == null || isNaN(Number(v))) return null;
        const n = Number(v);
        if (!isFinite(n)) return null;
        if (n === 0 && metric !== 'nodeals') return null;
        return n;
    };

    let lbls = [], fData = [], nums = [];

    // ── AVERAGES MODE ────────────────────────────────────────────────────────
    if (payload.mode === 'averages') {

        if (payload.tf === 'Monthly') {
            // monthly-kpi returns { months:[...], data:[{name, values}] } per store
            const first = (payload.results || []).find(r => r && r.months && r.months.length);
            lbls = first ? first.months : [];

            (payload.results || []).forEach((r, idx) => {
                if (!r || !r.months || !r.data) return;
                const store = payload.stores[idx];
                const row = r.data.find(m => m.name.toLowerCase().includes(
                    metric === 'conversion' ? 'customer conversion' :
                    metric === 'margin'     ? 'gross margin'        :
                    metric === 'nodeals'    ? 'no deal count'       : 'avg transaction'
                ));
                if (!row) return;
                const vals = lbls.map(lbl => {
                    const i = r.months.indexOf(lbl);
                    return i === -1 ? null : safeVal(row.values[i]);
                });
                const valid = vals.filter(v => v !== null);
                if (!valid.length) return;
                nums.push(...valid);
                fData.push({ label: '   ' + store + '   ', data: vals, borderColor: STORE_COLORS[store], backgroundColor: STORE_COLORS[store], tension: 0.4, pointRadius: 5, spanGaps: true });
            });

        } else {
            // 4-Week: kpi-manage returns periods newest-first — reverse for left=old, right=new
            const first = (payload.results || []).find(r => r && r.periods && r.periods.length);
            lbls = first ? [...first.periods].reverse().map(p => _kpiWeekRangeLabel(p.period_end_date)) : [];

            (payload.results || []).forEach((r, idx) => {
                if (!r || !r.periods) return;
                const store = payload.stores[idx];
                const vals = [...r.periods].reverse().map(p => {
                    if (!p.entries || !p.entries.length) return null;
                    const total = _kpiStoreTotalRowHtml ? (() => {
                        // compute totals inline without the HTML builder
                        const t2 = { employee_name: 'Store Total' };
                        _KPI_INPUT_FIELDS.forEach(function(f) {
                            if (f === 'avg_transaction_time') {
                                const vs = p.entries.map(e => Number(e[f])).filter(v => v > 0 && !isNaN(v));
                                t2[f] = vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : null;
                            } else {
                                const vs = p.entries.map(e => Number(e[f])).filter(v => v != null && !isNaN(v));
                                t2[f] = vs.length ? vs.reduce((a,b)=>a+b,0) : null;
                            }
                        });
                        return _kpiCalcDerived(t2);
                    })() : null;
                    return total ? safeVal(total[field]) : null;
                });
                const valid = vals.filter(v => v !== null);
                if (!valid.length) return;
                nums.push(...valid);
                fData.push({ label: '   ' + store + '   ', data: vals, borderColor: STORE_COLORS[store], backgroundColor: STORE_COLORS[store], tension: 0.4, pointRadius: 5, spanGaps: true });
            });
        }

    // ── EMPLOYEES MODE ───────────────────────────────────────────────────────
    } else {
        const r = payload.result;
        if (!r || !r.periods || !r.periods.length) {
            const loader = document.getElementById('chartLoading');
            if (loader) { loader.innerHTML = '<div class="status-message">No data available.</div>'; loader.style.display = 'flex'; }
            return;
        }

        // kpi-manage returns newest-first — reverse so chart reads left=old, right=new
        const periods = [...r.periods].reverse();

        lbls = payload.tf === 'Monthly'
            ? periods.map(p => p.period_label)
            : periods.map(p => _kpiWeekRangeLabel(p.period_end_date));

        // Only chart employees who are still current — use the editable (current) period's
        // roster as the authoritative list, filtering out anyone who has since left the store
        const editablePeriod = r.periods.find(p => p.is_editable);
        const currentEmpSet = editablePeriod
            ? new Set(editablePeriod.entries.map(e => e.employee_name))
            : null;

        const allEmpNames = [...new Set(periods.flatMap(p => (p.entries || []).map(e => e.employee_name)))];
        const empNames = currentEmpSet ? allEmpNames.filter(n => currentEmpSet.has(n)) : allEmpNames;

        empNames.forEach((name, eIdx) => {
            const vals = periods.map(p => {
                const entry = (p.entries || []).find(e => e.employee_name === name);
                if (!entry) return null;
                const computed = _kpiCalcDerived(entry);
                return safeVal(computed[field]);
            });
            const valid = vals.filter(v => v !== null);
            if (!valid.length) return;
            nums.push(...valid);
            const color = EMP_COLORS[eIdx % EMP_COLORS.length];
            fData.push({ label: '   ' + name + '   ', data: vals, borderColor: color, backgroundColor: color, tension: 0.4, pointRadius: 5, spanGaps: true });
        });
    }

    // ── Y-axis bounds ────────────────────────────────────────────────────────
    let yMin = 0, yMax = 100;
    if (nums.length) {
        const mx = Math.max(...nums), mn = Math.min(...nums);
        if (isPct) {
            yMin = Math.max(0, Math.floor(mn/10)*10 - 10);
            yMax = Math.min(100, Math.ceil(mx/10)*10 + 10);
        } else if (metric === 'time') {
            yMin = Math.max(0, Math.floor(mn) - 1);
            yMax = Math.ceil(mx) + 1;
        } else {
            yMin = 0;
            yMax = Math.max(1, Math.ceil(mx * 1.2));
        }
    }

    const fmtVal = (v) => {
        if (v === null) return '';
        if (metric === 'time') { const m2=Math.floor(v), s=Math.round((v-m2)*60); return m2+':'+(s<10?'0':'')+s; }
        return (Math.round(v*10)/10) + unit;
    };

    // ── Draw chart ───────────────────────────────────────────────────────────
    if (mainChartInstance) mainChartInstance.destroy();

    mainChartInstance = new Chart(document.getElementById('mainKpiChart').getContext('2d'), {
        type: 'line',
        plugins: typeof ChartDataLabels !== 'undefined' ? [ChartDataLabels] : [],
        data: { labels: lbls, datasets: fData },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 55, right: 20, left: 10, bottom: 0 } },
            animation: { duration: 400 },
            plugins: {
                legend: { position: 'bottom', labels: { font: { size: 13, family:"'Inter',sans-serif", weight:'bold' }, usePointStyle: true, boxWidth: 8, padding: 20 } },
                datalabels: { align:'top', anchor:'end', formatter: fmtVal, font:{ size:11, weight:'bold' }, color:'#666', offset:4 },
                tooltip: { callbacks: { label: ctx => { const lbl = ctx.dataset.label.trim(); return lbl + ': ' + fmtVal(ctx.parsed.y); } } }
            },
            scales: {
                y: { min: yMin, max: yMax, ticks: { callback: v => metric === 'time' ? (Math.floor(v)+':'+(Math.round((v-Math.floor(v))*60)<10?'0':'')+Math.round((v-Math.floor(v))*60)) : (v+unit) } },
                x: { grid: { display: false } }
            }
        }
    });

    const activeLoader = document.getElementById('chartLoading');
    if (activeLoader) activeLoader.style.display = 'none';
}

// --- CHART: DRAW LEADERBOARD ---
function drawLeaderboard() {
    const wrapper = document.getElementById('lb-wrapper');
    const monthLabel = document.getElementById('lb-month-display');
    
    if (!wrapper || !cachedLeaderboardData || !cachedLeaderboardData.activeStores) return;

    if (typeof Chart === 'undefined') {
        setTimeout(drawLeaderboard, 100); 
        return;
    }

    const now = new Date();
    if (monthLabel) {
        monthLabel.innerText = now.toLocaleString('default', { month: 'long', year: 'numeric' }).toUpperCase();
    }

    wrapper.style.display = 'block';
    wrapper.innerHTML = '<canvas id="leaderboardCanvas" style="width: 100%; height: 100%;"></canvas>';
    const canvas = document.getElementById('leaderboardCanvas');

    const colors = { 'OVL': '#a855f7', 'LEE': '#3b82f6', 'WSP': '#22c55e', 'MPL': '#f97316', 'BAL': '#ef4444' };
    const daysInMonthCount = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dateLabels = Array.from({length: daysInMonthCount}, (_, i) => `${now.getMonth() + 1}/${i + 1}`);

    let datasets = [];
    const dataPacket = currentLeaderboardMetric === 'Revenue' ? cachedLeaderboardData.revenue : cachedLeaderboardData.gp;

    cachedLeaderboardData.activeStores.forEach(store => {
        if (dataPacket[store]) {
            datasets.push({
                label: '   ' + store + '   ', 
                data: dataPacket[store],
                borderColor: colors[store],
                backgroundColor: colors[store],
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 6,
                tension: 0.1
            });
        }
    });

    let finalScores = [];
    datasets.forEach((ds, i) => {
        let lastIdx = ds.data.findLastIndex(v => v !== null);
        let lastVal = lastIdx !== -1 ? ds.data[lastIdx] : 0;
        finalScores.push({ index: i, val: lastVal, lastIdx: lastIdx });
    });
    
    finalScores.sort((a, b) => b.val - a.val);

    let ranks = {};
    finalScores.forEach((item, pos) => {
        if (pos < 3) ranks[item.index] = { rank: pos + 1, lastIdx: item.lastIdx };
    });

    const checkeredPlugin = {
        id: 'checkeredFinishLine',
        beforeDatasetsDraw: (chart) => {
            const { ctx, chartArea } = chart;
            if (!chartArea) return;
            const { top, bottom, right } = chartArea;
            
            const totalHeight = bottom - top;
            const rowCount = Math.round(totalHeight / 12); 
            const squareSize = totalHeight / rowCount; 
            
            const cols = 2; 
            const lineWidth = squareSize * cols;
            const startX = right - lineWidth;

            ctx.save();
            for (let row = 0; row < rowCount; row++) {
                const currentY = top + (row * squareSize);
                for (let col = 0; col < cols; col++) {
                    ctx.fillStyle = ((col + row) % 2 === 0) ? '#e2e8f0' : '#1a1c1e';
                    ctx.fillRect(startX + (col * squareSize), currentY, squareSize + 0.5, squareSize + 0.5);
                }
            }
            ctx.restore();
        }
    };

    try {
        const ctx = canvas.getContext('2d');
        if (leaderboardChartInstance) leaderboardChartInstance.destroy(); 

        let activePlugins = typeof ChartDataLabels !== 'undefined' ? [ChartDataLabels, checkeredPlugin] : [checkeredPlugin];

        leaderboardChartInstance = new Chart(ctx, {
            type: 'line',
            plugins: activePlugins,
            data: { labels: dateLabels, datasets: datasets },
            options: {
                animation: false, 
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                layout: { padding: { top: 40, right: 50, left: 10, bottom: 0 } },
                plugins: {
                    tooltip: {
                        itemSort: function(a, b) { return b.parsed.y - a.parsed.y; },
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label.trim() || ''; 
                                if (label) label += ': ';
                                if (context.parsed.y !== null) {
                                    label += new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(context.parsed.y);
                                }
                                return label;
                            }
                        }
                    },
                    legend: {
                        position: 'bottom',
                        labels: { font: { size: 13, family: "'Inter', sans-serif", weight: 'bold' }, usePointStyle: true, boxWidth: 8, padding: 20 }
                    },
                    datalabels: {
                        display: function(context) {
                            const rankInfo = ranks[context.datasetIndex];
                            if (!rankInfo) return false; 
                            return context.dataIndex === rankInfo.lastIdx; 
                        },
                        formatter: function(value, context) {
                            const r = ranks[context.datasetIndex].rank;
                            return r === 1 ? '🥇 1st' : (r === 2 ? '🥈 2nd' : '🥉 3rd');
                        },
                        backgroundColor: function(context) { return context.dataset.backgroundColor; },
                        color: 'white',
                        borderRadius: 6,
                        font: { size: 10, weight: 'bold', family: "'Inter', sans-serif" },
                        padding: { top: 4, bottom: 4, left: 8, right: 8 },
                        align: 'right',  
                        anchor: 'center',
                        offset: 4
                    }
                },
                scales: {
                    y: {
                        afterFit: function(scale) { scale.width = 75; },
                        beginAtZero: true,
                        max: datasets.length === 0 ? 1000 : undefined, 
                        ticks: { callback: function(value) { return '$' + (value / 1000) + 'k'; } },
                        grid: { borderDash: [4, 4] }
                    },
                    x: { 
                        grid: { display: false },
                        ticks: { font: { size: 11, weight: 'bold', family: "'Inter', sans-serif" }, color: '#a0aab2', maxRotation: 45, minRotation: 45 }
                    }
                }
            }
        });
    } catch (e) {
        console.error("Chart.js failed to draw.", e);
    }
}

// --- MODAL: MANAGE ANNOUNCEMENTS ---
function toggleManageAnnouncements() {
    closeAllModals();
    const dropdown = document.getElementById('manageAnnouncementsDropdown');
    if(dropdown) dropdown.classList.add('show');
    
    lockAndBlurScreen();
    
    document.getElementById('annTitleInput').value = '';
    document.getElementById('annPriorityInput').checked = false;
    document.getElementById('annBodyInput').innerHTML = '';
    checkActiveFormats(); 
}

function formatText(command) {
    const editor = document.getElementById('annBodyInput');
    editor.focus(); 
    document.execCommand(command, false, null);
    checkActiveFormats();
}

function checkActiveFormats() {
    document.getElementById('btn-fmt-bold')?.classList.toggle('active-format', document.queryCommandState('bold'));
    document.getElementById('btn-fmt-italic')?.classList.toggle('active-format', document.queryCommandState('italic'));
    document.getElementById('btn-fmt-underline')?.classList.toggle('active-format', document.queryCommandState('underline'));
    document.getElementById('btn-fmt-list')?.classList.toggle('active-format', document.queryCommandState('insertUnorderedList'));
}

document.addEventListener('DOMContentLoaded', () => {
    const editor = document.getElementById('annBodyInput');
    if (editor) {
        editor.addEventListener('keyup', checkActiveFormats);
        editor.addEventListener('mouseup', checkActiveFormats);
        editor.addEventListener('click', checkActiveFormats);
    }
});

async function publishAnnouncement() {
    const title = document.getElementById('annTitleInput').value.trim();
    const body = document.getElementById('annBodyInput').innerHTML.trim();
    const isPriority = document.getElementById('annPriorityInput').checked;
    const btn = document.getElementById('publishAnnBtn');

    if (!title || !body) {
        alert("Wait! You must fill out both a Title and a Message before publishing.");
        return;
    }

    btn.innerHTML = "Publishing... ⏳";
    btn.style.opacity = "0.7";
    btn.style.pointerEvents = "none";

    let compiledMessage = "";
    if (isPriority) {
        compiledMessage += `<span style="color: #ef4444; font-weight: 900; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">🚨 HIGH PRIORITY</span><br>`;
    }
    compiledMessage += `<strong style="font-size: 16px; color: var(--slate-charcoal); display: block; margin-bottom: 8px;">${title}</strong>`;
    compiledMessage += body;

    const payload = {
        text: compiledMessage,
        date: new Date().toISOString(),
        author: sessionStorage.getItem('speeksUserName') || 'Executive Team'
    };

    try {
        await fetch(CMS_URL, {
            method: 'POST',
            mode: 'no-cors', 
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });
        
        alert("Success! Your announcement has been published to all stores.");
        closeAllModals(); 
        if(typeof syncAllData === 'function') syncAllData(); 
        
    } catch (error) {
        console.error("Error publishing announcement:", error);
        alert("Failed to connect to the server.");
    } finally {
        btn.innerHTML = "<span>Publish to All Stores</span> 🚀";
        btn.style.opacity = "1";
        btn.style.pointerEvents = "auto";
    }
}

// ============================================================================
// 24. MODULE: MONTHLY TEAM GOALS
// ============================================================================

function _mgbKey(store, date) {
    const d = date || new Date();
    return `monthlyGoals_${(store || 'NONE').toUpperCase()}_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthlyGoals(store) {
    try { const r = localStorage.getItem(_mgbKey(store)); return r ? JSON.parse(r) : null; } catch { return null; }
}

function putMonthlyGoals(store, data) {
    localStorage.setItem(_mgbKey(store), JSON.stringify(data));
}

const MONTHLY_GOALS_URL = 'https://script.google.com/macros/s/AKfycbyytrXgeMLoFMqxKBqW2SfLoXk-8SnoKQoKVmhgPkW84ffuj5sgMumekFdZN1CsJcpMJQ/exec';

function _mgbYearMonth(date) {
    const d = date || new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function syncGoalsFromSheet() {
    if (!MONTHLY_GOALS_URL) return;
    try {
        const ym  = _mgbYearMonth();
        const res = await fetch(`${MONTHLY_GOALS_URL}?action=getAll&yearMonth=${ym}&t=${Date.now()}`);
        const map = await res.json();
        ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'].forEach(store => {
            if (map[store]) putMonthlyGoals(store, map[store]);
        });
        renderMonthlyGoalsBanner();
        renderDistrictGoals();
    } catch (err) {
        console.warn('Goals sync failed:', err);
    }
}

async function _postGoalsToSheet(store, payload) {
    if (!MONTHLY_GOALS_URL) return;
    try {
        await fetch(MONTHLY_GOALS_URL, {
            method:   'POST',
            headers:  { 'Content-Type': 'text/plain' },
            body:     JSON.stringify({ store, yearMonth: _mgbYearMonth(), ...payload }),
            redirect: 'follow',
        });
    } catch (err) {
        console.warn('Goals post failed:', err);
    }
}




function _mgbMonthLabel(date) {
    return (date || new Date()).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// --- Banner ---

let _mgbExpanded = false;

const _storeColors = { OVL: '#7c3aed', LEE: '#2563eb', WSP: '#5a8d3b', MPL: '#ea580c', BAL: '#dc2626' };

function renderMonthlyGoalsBanner() {
    if (_selectedGoalDate) return; // viewing a past month — don't override
    const store = sessionStorage.getItem('speeksUserStore') || '';
    const labelEl = document.getElementById('giGoalsLabel');
    if (labelEl) labelEl.textContent = _mgbMonthLabel() + ' Goals';

    const data  = getMonthlyGoals(store);
    const goals = data?.goals || [];
    const listEl = document.getElementById('giGoalsList');

    if (!goals.length) {
        if (listEl) listEl.innerHTML = '<div class="status-message" style="padding: 8px 0;">No goals have been set for this month yet.</div>';
        return;
    }

    let html = '';
    goals.forEach(g => {
        html += `<div class="mgb-goal-item">
            <span class="mgb-goal-title">${escapeHtml(g.title)}</span>
            ${g.description ? `<span class="mgb-goal-desc">${escapeHtml(g.description)}</span>` : ''}
        </div>`;
    });
    if (listEl) listEl.innerHTML = html;
}

function toggleGoalsBanner() { toggleGoalsPanel(); }

// --- Previous Months Dropdown ---

let _selectedGoalDate = null; // null = current month

function _closePrevMonths() {
    const dropdown = document.getElementById('giPrevMonthsList');
    const btn      = document.getElementById('giPrevToggleBtn');
    if (dropdown) dropdown.classList.remove('open');
    // keep btn.active if a past month is selected
    if (btn) btn.classList.toggle('active', !!_selectedGoalDate);
}

function _resetToCurrentMonth() {
    _selectedGoalDate = null;
    _closePrevMonths();
    const editBtn = document.getElementById('giEditGoalsBtn');
    if (editBtn) {
        const isManager = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().replace(/\s+/g, '-') === 'manager';
        editBtn.style.setProperty('display', isManager ? 'block' : 'none', 'important');
    }
    renderMonthlyGoalsBanner();
}

function _buildMonthDropdown(dropdown) {
    const now  = new Date();
    const nowYm = _mgbYearMonth();
    const selYm = _selectedGoalDate ? _mgbYearMonth(_selectedGoalDate) : nowYm;
    const months = [now];
    for (let i = 1; i <= 3; i++) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
    dropdown.innerHTML = months.map((d, idx) => {
        const ym       = _mgbYearMonth(d);
        const label    = _mgbMonthLabel(d);
        const selected = ym === selYm ? ' selected' : '';
        const tag      = idx === 0 ? '<span class="gi-month-current-tag">Current</span>' : '';
        return `<div class="gi-month-option${selected}" onclick="selectGoalMonth('${ym}')">${label}${tag}</div>`;
    }).join('');
}

window.togglePrevMonths = function(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('giPrevMonthsList');
    const btn      = document.getElementById('giPrevToggleBtn');
    if (!dropdown || !btn) return;
    const opening = !dropdown.classList.contains('open');
    dropdown.classList.toggle('open', opening);
    btn.classList.toggle('active', opening || !!_selectedGoalDate);
    if (opening) {
        _buildMonthDropdown(dropdown);
        setTimeout(() => {
            document.addEventListener('click', function _giClickAway(ev) {
                const wrap = document.querySelector('.gi-prev-wrapper');
                if (wrap && wrap.contains(ev.target)) return;
                document.getElementById('giPrevMonthsList')?.classList.remove('open');
                const b = document.getElementById('giPrevToggleBtn');
                if (b) b.classList.toggle('active', !!_selectedGoalDate);
                document.removeEventListener('click', _giClickAway);
            });
        }, 0);
    }
};

window.selectGoalMonth = async function(ym) {
    const dropdown  = document.getElementById('giPrevMonthsList');
    const btn       = document.getElementById('giPrevToggleBtn');
    const editBtn   = document.getElementById('giEditGoalsBtn');
    if (dropdown) dropdown.classList.remove('open');

    const nowYm = _mgbYearMonth();
    const isManager = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().replace(/\s+/g, '-') === 'manager';
    if (ym === nowYm) {
        _selectedGoalDate = null;
        if (btn) btn.classList.remove('active');
        if (editBtn) editBtn.style.setProperty('display', isManager ? 'block' : 'none', 'important');
        renderMonthlyGoalsBanner();
        return;
    }

    if (editBtn) editBtn.style.setProperty('display', 'none', 'important');

    const [year, month] = ym.split('-').map(Number);
    _selectedGoalDate = new Date(year, month - 1, 1);
    if (btn) btn.classList.add('active');

    const labelEl = document.getElementById('giGoalsLabel');
    if (labelEl) labelEl.textContent = _mgbMonthLabel(_selectedGoalDate) + ' Goals';

    const listEl = document.getElementById('giGoalsList');
    if (!listEl) return;
    listEl.innerHTML = '<div class="status-message">Loading...</div>';

    const store    = sessionStorage.getItem('speeksUserStore') || '';
    const cacheKey = _mgbKey(store, _selectedGoalDate);
    let goals = null;
    try { const raw = localStorage.getItem(cacheKey); if (raw) goals = JSON.parse(raw)?.goals ?? []; } catch {}

    if (goals === null) {
        try {
            const res   = await fetch(`${MONTHLY_GOALS_URL}?action=getAll&yearMonth=${ym}&t=${Date.now()}`);
            const map   = await res.json();
            const entry = map[(store || '').toUpperCase()];
            if (entry) { localStorage.setItem(cacheKey, JSON.stringify(entry)); goals = entry.goals || []; }
            else goals = [];
        } catch { goals = null; }
    }

    if (!goals?.length) {
        listEl.innerHTML = `<div class="status-message" style="padding:8px 0;">${goals === null ? 'Could not load.' : 'No goals recorded for this month.'}</div>`;
        return;
    }
    listEl.innerHTML = goals.map(g => `<div class="mgb-goal-item">
        <span class="mgb-goal-title">${escapeHtml(g.title)}</span>
        ${g.description ? `<span class="mgb-goal-desc">${escapeHtml(g.description)}</span>` : ''}
    </div>`).join('');
};

window.toggleGoalsPanel = function(event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('goalsSidePanel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    const toggle = document.querySelector('.gi-nav-toggle');
    if (toggle) toggle.classList.toggle('panel-active', isOpen);
    if (!isOpen) _closePrevMonths();
    if (isOpen) {
        document.getElementById('checklistSidePanel')?.classList.remove('open');
        document.querySelector('.cl-nav-toggle')?.classList.remove('panel-active');
    }
};

// --- Edit Modal ---

function openEditGoalsModal() {
    const store = sessionStorage.getItem('speeksUserStore') || '';
    const goals = getMonthlyGoals(store)?.goals || [];
    const list  = document.getElementById('editGoalsList');
    if (!list) return;
    list.innerHTML = '';
    if (goals.length === 0) { addGoalRow(); } else { goals.forEach(g => addGoalRow(g)); }
    _updateAddGoalBtn();
    toggleModal('editMonthlyGoalsModal');
}

function addGoalRow(existing) {
    const list = document.getElementById('editGoalsList');
    if (!list || list.children.length >= 6) return;
    const row = document.createElement('div');
    row.className = 'edit-goal-row';
    row.innerHTML = `
        <div class="edit-goal-inner">
            <input type="text" class="form-input-lg edit-goal-title" style="margin:0; font-size:13px;" placeholder="Goal title  (e.g. Hit $45K Revenue)" value="${escapeHtml(existing?.title || '')}">
            <input type="text" class="form-input-lg edit-goal-desc" style="margin:0; font-size:12px;" placeholder="Description (optional)" value="${escapeHtml(existing?.description || '')}">
        </div>
        <button class="edit-goal-remove-btn" onclick="this.closest('.edit-goal-row').remove(); _updateAddGoalBtn();" title="Remove">✕</button>`;
    list.appendChild(row);
    _updateAddGoalBtn();
}

function _updateAddGoalBtn() {
    const list = document.getElementById('editGoalsList');
    const btn  = document.getElementById('addGoalRowBtn');
    if (btn) btn.style.display = (list?.children.length ?? 0) >= 6 ? 'none' : '';
}

function saveMonthlyGoals() {
    const store    = sessionStorage.getItem('speeksUserStore') || '';
    const userName = sessionStorage.getItem('speeksUserName')  || 'Manager';
    const goals    = [];
    document.querySelectorAll('#editGoalsList .edit-goal-row').forEach(row => {
        const title       = row.querySelector('.edit-goal-title')?.value.trim();
        const description = row.querySelector('.edit-goal-desc')?.value.trim();
        if (!title) return;
        goals.push({ title, description });
    });
    const payload = {
        goals,
        setBy:     userName,
        updatedAt: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    };
    putMonthlyGoals(store, payload);
    closeAllModals();
    renderMonthlyGoalsBanner();
    renderDistrictGoals();
    _postGoalsToSheet(store, payload);
}

// --- District Overview ---

function renderDistrictGoals() {
    const container = document.getElementById('districtGoalsGrid');
    if (!container) return;
    const monthEl = document.getElementById('districtGoalsMonth');
    if (monthEl) monthEl.textContent = _mgbMonthLabel();
    const stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    const emojis = { OVL: '🟣', LEE: '🔵', WSP: '🟢', MPL: '🟠', BAL: '🔴' };

    let goalsRow = '';
    let initiativesRow = '';

    stores.forEach(store => {
        const data        = getMonthlyGoals(store);
        const goals       = data?.goals || [];
        const initiatives = getStoreInitiatives(store)?.initiatives || [];

        const goalsContent = goals.length
            ? goals.map(g => `<div class="dg-goal-mini" data-goal-title="${escapeHtml(g.title)}" data-goal-desc="${escapeHtml(g.description || '')}"><div class="dg-goal-mini-label">${escapeHtml(g.title)}</div></div>`).join('')
            : '<div class="dg-no-goals">No goals set</div>';

        const initiativeItems = initiatives.length
            ? initiatives.map(i => {
                const badge = i.status === 'upcoming'
                    ? '<span class="si-status-badge si-status-badge--upcoming">Upcoming</span>'
                    : '<span class="si-status-badge si-status-badge--current">Current</span>';
                return `<div class="dg-goal-mini dg-initiative-mini" data-goal-title="${escapeHtml(i.title)}" data-goal-desc="${escapeHtml(i.description || '')}"><div class="dg-goal-mini-label">${escapeHtml(i.title)}</div>${badge}</div>`;
            }).join('')
            : '<div class="dg-no-goals">No initiatives set</div>';

        goalsRow += `<div class="dg-goals-col">
            <div class="dg-store-header">${emojis[store]} ${store}</div>
            ${goalsContent}
        </div>`;

        initiativesRow += `<div class="dg-initiatives-col">
            <div class="dg-initiatives-divider">Initiatives &amp; Projects <button class="dg-edit-btn" onclick="openEditStoreInitiativesModal('${store}')">Edit ✏️</button></div>
            ${initiativeItems}
        </div>`;
    });

    container.innerHTML = goalsRow + initiativesRow;
}

// ============================================================================
// 25. MODULE: COMPANY INITIATIVES & STORE PROJECTS
// ============================================================================

// --- Storage helpers ---

function getCompanyProjects() {
    try { const r = localStorage.getItem('companyProjects'); return r ? JSON.parse(r) : null; } catch { return null; }
}

function putCompanyProjects(data) {
    localStorage.setItem('companyProjects', JSON.stringify(data));
}

function getStoreInitiatives(store) {
    try { const r = localStorage.getItem(`storeInitiatives_${(store || '').toUpperCase()}`); return r ? JSON.parse(r) : null; } catch { return null; }
}

function putStoreInitiatives(store, data) {
    localStorage.setItem(`storeInitiatives_${(store || '').toUpperCase()}`, JSON.stringify(data));
}

// --- Company Projects Banner ---

let _cpbExpanded = false;

function renderCompanyProjectsBanner() {
    const store       = sessionStorage.getItem('speeksUserStore') || '';
    const listEl      = document.getElementById('giInitiativesList');
    const projects    = getCompanyProjects()?.projects || [];
    const initiatives = getStoreInitiatives(store)?.initiatives || [];
    const allItems    = [...projects, ...initiatives];

    if (!allItems.length) {
        if (listEl) listEl.innerHTML = '<div class="status-message" style="padding: 8px 0;">No initiatives have been set yet.</div>';
        return;
    }

    if (listEl) {
        let html = '';
        if (projects.length) {
            html += '<div class="cpb-section-label">Company</div>';
            projects.forEach(p => {
                const badge = p.status === 'upcoming'
                    ? '<span class="si-status-badge si-status-badge--upcoming">Upcoming</span>'
                    : '<span class="si-status-badge si-status-badge--current">Current</span>';
                html += `<div class="cpb-project-item">
                    <div class="cpb-item-title-row"><span class="mgb-goal-title">${escapeHtml(p.title)}</span>${badge}</div>
                    ${p.description ? `<span class="mgb-goal-desc">${escapeHtml(p.description)}</span>` : ''}
                </div>`;
            });
        }
        if (initiatives.length) {
            html += `<div class="cpb-section-label${projects.length ? ' cpb-section-label--spaced' : ''}">${escapeHtml(store)}</div>`;
            initiatives.forEach(i => {
                const badge = i.status === 'upcoming'
                    ? '<span class="si-status-badge si-status-badge--upcoming">Upcoming</span>'
                    : '<span class="si-status-badge si-status-badge--current">Current</span>';
                html += `<div class="cpb-project-item cpb-initiative-item">
                    <div class="cpb-item-title-row"><span class="mgb-goal-title">${escapeHtml(i.title)}</span>${badge}</div>
                    ${i.description ? `<span class="mgb-goal-desc">${escapeHtml(i.description)}</span>` : ''}
                </div>`;
            });
        }
        listEl.innerHTML = html;
    }
}

function toggleCompanyProjectsBanner() { toggleGoalsPanel(); }

// --- Edit Company Projects Modal ---

function openEditCompanyProjectsModal() {
    const projects = getCompanyProjects()?.projects || [];
    const list = document.getElementById('editCompanyProjectsList');
    if (!list) return;
    list.innerHTML = '';
    if (projects.length === 0) { addCompanyProjectRow(); } else { projects.forEach(p => addCompanyProjectRow(p)); }
    _updateAddCompanyProjectBtn();
    toggleModal('editCompanyProjectsModal');
}

window.toggleSiStatus = function(btn) {
    btn.closest('.si-status-toggle')?.querySelectorAll('.si-status-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
};

function _siStatusToggleHtml(status) {
    const cur = (!status || status === 'current') ? 'active' : '';
    const upc = status === 'upcoming' ? 'active' : '';
    return `<div class="si-status-toggle">
        <button type="button" class="si-status-btn ${cur}" data-val="current" onclick="toggleSiStatus(this)">Current</button>
        <button type="button" class="si-status-btn ${upc}" data-val="upcoming" onclick="toggleSiStatus(this)">Upcoming</button>
    </div>`;
}

function addCompanyProjectRow(existing) {
    const list = document.getElementById('editCompanyProjectsList');
    if (!list || list.children.length >= 8) return;
    const row = document.createElement('div');
    row.className = 'edit-goal-row';
    row.innerHTML = `
        <div class="edit-goal-inner">
            <input type="text" class="form-input-lg edit-cp-title" style="margin:0; font-size:13px;" placeholder="Initiative title (e.g. Launch Loyalty Program)" value="${escapeHtml(existing?.title || '')}">
            <input type="text" class="form-input-lg edit-cp-desc" style="margin:0; font-size:12px;" placeholder="Description (optional)" value="${escapeHtml(existing?.description || '')}">
            ${_siStatusToggleHtml(existing?.status)}
        </div>
        <button class="edit-goal-remove-btn" onclick="this.closest('.edit-goal-row').remove(); _updateAddCompanyProjectBtn();" title="Remove">✕</button>`;
    list.appendChild(row);
    _updateAddCompanyProjectBtn();
}

function _updateAddCompanyProjectBtn() {
    const list = document.getElementById('editCompanyProjectsList');
    const btn  = document.getElementById('addCompanyProjectRowBtn');
    if (btn) btn.style.display = (list?.children.length ?? 0) >= 8 ? 'none' : '';
}

function saveCompanyProjects() {
    const userName = sessionStorage.getItem('speeksUserName') || 'CEO';
    const projects = [];
    document.querySelectorAll('#editCompanyProjectsList .edit-goal-row').forEach(row => {
        const title       = row.querySelector('.edit-cp-title')?.value.trim();
        const description = row.querySelector('.edit-cp-desc')?.value.trim();
        const status      = row.querySelector('.si-status-btn.active')?.dataset.val || 'current';
        if (!title) return;
        projects.push({ title, description, status });
    });
    const payload = {
        projects,
        setBy:     userName,
        updatedAt: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    };
    putCompanyProjects(payload);
    closeAllModals();
    renderCompanyProjectsBanner();
    renderDistrictCompanyProjects();
    _postCompanyProjectsToSheet(payload);
}

async function _postCompanyProjectsToSheet(payload) {
    if (!MONTHLY_GOALS_URL) return;
    try {
        await fetch(MONTHLY_GOALS_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify({ action: 'setCompanyProjects', ...payload }),
            redirect: 'follow',
        });
    } catch (err) {
        console.warn('Company projects post failed:', err);
    }
}

// --- Store Initiatives ---

function renderStoreInitiatives() {
    renderCompanyProjectsBanner();
}

let _editingInitiativesForStore = null;

function openEditStoreInitiativesModal(storeOverride) {
    _editingInitiativesForStore = storeOverride || sessionStorage.getItem('speeksUserStore') || '';
    const initiatives = getStoreInitiatives(_editingInitiativesForStore)?.initiatives || [];
    const list        = document.getElementById('editStoreInitiativesList');
    const titleEl     = document.getElementById('editStoreInitiativesTitle');
    if (titleEl) titleEl.textContent = `${_editingInitiativesForStore} Initiatives`;
    if (!list) return;
    list.innerHTML = '';
    if (initiatives.length === 0) { addStoreInitiativeRow(); } else { initiatives.forEach(i => addStoreInitiativeRow(i)); }
    _updateAddStoreInitiativeBtn();
    toggleModal('editStoreInitiativesModal');
}

function addStoreInitiativeRow(existing) {
    const list = document.getElementById('editStoreInitiativesList');
    if (!list || list.children.length >= 6) return;
    const row = document.createElement('div');
    row.className = 'edit-goal-row';
    row.innerHTML = `
        <div class="edit-goal-inner">
            <input type="text" class="form-input-lg edit-si-title" style="margin:0; font-size:13px;" placeholder="Initiative title (e.g. Test new shelf layout)" value="${escapeHtml(existing?.title || '')}">
            <input type="text" class="form-input-lg edit-si-desc" style="margin:0; font-size:12px;" placeholder="Description (optional)" value="${escapeHtml(existing?.description || '')}">
            ${_siStatusToggleHtml(existing?.status)}
        </div>
        <button class="edit-goal-remove-btn" onclick="this.closest('.edit-goal-row').remove(); _updateAddStoreInitiativeBtn();" title="Remove">✕</button>`;
    list.appendChild(row);
    _updateAddStoreInitiativeBtn();
}

function _updateAddStoreInitiativeBtn() {
    const list = document.getElementById('editStoreInitiativesList');
    const btn  = document.getElementById('addStoreInitiativeRowBtn');
    if (btn) btn.style.display = (list?.children.length ?? 0) >= 6 ? 'none' : '';
}

function saveStoreInitiatives() {
    const store       = _editingInitiativesForStore || sessionStorage.getItem('speeksUserStore') || '';
    const userName    = sessionStorage.getItem('speeksUserName') || 'Manager';
    const initiatives = [];
    document.querySelectorAll('#editStoreInitiativesList .edit-goal-row').forEach(row => {
        const title       = row.querySelector('.edit-si-title')?.value.trim();
        const description = row.querySelector('.edit-si-desc')?.value.trim();
        const status      = row.querySelector('.si-status-btn.active')?.dataset.val || 'current';
        if (!title) return;
        initiatives.push({ title, description, status });
    });
    const payload = {
        initiatives,
        setBy:     userName,
        updatedAt: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    };
    putStoreInitiatives(store, payload);
    closeAllModals();
    renderStoreInitiatives();
    renderDistrictGoals();
    _postStoreInitiativesToSheet(store, payload);
}

async function _postStoreInitiativesToSheet(store, payload) {
    if (!MONTHLY_GOALS_URL) return;
    try {
        await fetch(MONTHLY_GOALS_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify({ action: 'setStoreInitiatives', store, ...payload }),
            redirect: 'follow',
        });
    } catch (err) {
        console.warn('Store initiatives post failed:', err);
    }
}

// --- District Views ---

function renderDistrictCompanyProjects() {
    const container = document.getElementById('districtCompanyProjects');
    if (!container) return;
    const data     = getCompanyProjects();
    const projects = data?.projects || [];

    const itemsHtml = projects.length
        ? projects.map(p => {
            const badge = p.status === 'upcoming'
                ? '<span class="si-status-badge si-status-badge--upcoming">Upcoming</span>'
                : '<span class="si-status-badge si-status-badge--current">Current</span>';
            return `<div class="dg-goal-mini" data-goal-title="${escapeHtml(p.title)}" data-goal-desc="${escapeHtml(p.description || '')}"><div class="dg-goal-mini-label">${escapeHtml(p.title)}</div>${badge}</div>`;
        }).join('')
        : '<div class="dg-no-goals">No company initiatives set</div>';

    container.innerHTML = `
        <div class="district-cp-section">
            <div class="district-cp-header-row">
                <span class="district-cp-header">Company Initiatives &amp; Projects</span>
                <button class="dg-edit-btn" onclick="openEditCompanyProjectsModal()">Edit ✏️</button>
            </div>
            <div class="district-cp-items">${itemsHtml}</div>
        </div>`;
}

function renderDistrictInitiativesGrid() {
    const panel     = document.getElementById('districtInitiativesPanel');
    const container = document.getElementById('districtInitiativesGrid');
    if (!container) return;

    const stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    const emojis = { OVL: '🟣', LEE: '🔵', WSP: '🟢', MPL: '🟠', BAL: '🔴' };
    let hasAny = false;
    let html   = '';

    stores.forEach(store => {
        const data  = getStoreInitiatives(store);
        const items = data?.initiatives || [];
        if (items.length) hasAny = true;
        const inner = items.length
            ? items.map(i => {
                const badge = i.status === 'upcoming'
                    ? '<span class="si-status-badge si-status-badge--upcoming">Upcoming</span>'
                    : '<span class="si-status-badge si-status-badge--current">Current</span>';
                return `<div class="dg-goal-mini" data-goal-title="${escapeHtml(i.title)}" data-goal-desc="${escapeHtml(i.description || '')}"><div class="dg-goal-mini-label">${escapeHtml(i.title)}</div>${badge}</div>`;
            }).join('')
            : '<div class="dg-no-goals">No initiatives set</div>';
        html += `<div class="dg-store-card"><div class="dg-store-header">${emojis[store]} ${store}</div>${inner}</div>`;
    });

    container.innerHTML = html;
    if (panel) panel.style.display = hasAny ? 'block' : 'none';
}

// --- Sync from Sheet ---

async function syncInitiativesFromSheet() {
    if (!MONTHLY_GOALS_URL) return;
    try {
        const res  = await fetch(`${MONTHLY_GOALS_URL}?action=getAllInitiatives&t=${Date.now()}`);
        const data = await res.json();
        if (data.company) {
            // Preserve local status values the sheet may not return yet
            const localCompany = getCompanyProjects();
            if (localCompany?.projects && data.company.projects) {
                const localByTitle = {};
                localCompany.projects.forEach(p => { localByTitle[p.title] = p.status; });
                data.company.projects = data.company.projects.map(p => ({
                    ...p, status: p.status || localByTitle[p.title] || 'current'
                }));
            }
            putCompanyProjects(data.company);
        }
        ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'].forEach(store => {
            if (data[store]) {
                const local = getStoreInitiatives(store);
                if (local?.initiatives && data[store].initiatives) {
                    const localByTitle = {};
                    local.initiatives.forEach(i => { localByTitle[i.title] = i.status; });
                    data[store].initiatives = data[store].initiatives.map(i => ({
                        ...i, status: i.status || localByTitle[i.title] || 'current'
                    }));
                }
                putStoreInitiatives(store, data[store]);
            }
        });
        renderCompanyProjectsBanner();
        renderStoreInitiatives();
        renderDistrictCompanyProjects();
        renderDistrictInitiativesGrid();
    } catch (err) {
        console.warn('Initiatives sync failed:', err);
    }
}

// --- MODAL: MANAGE ALERTS ---
async function toggleManageAlerts() {
    const dropdown = document.getElementById('manageAlertsDropdown');
    if (!dropdown) return;
    
    const isOpen = dropdown.classList.contains('show');
    closeAllModals(); 
    
    if (!isOpen) {
        dropdown.classList.add('show');
        lockAndBlurScreen();

        const list = document.getElementById('manageAlertsList');
        list.innerHTML = '<div class="status-message">Syncing Data...</div>';
        
        try {
            const res = await fetch(`${EBAY_ALERTS_URL}?v=${Date.now()}`);
            const json = await res.json();
            if (json.success && json.data) {
                globalAlertsData = json.data;
                populateAlertsModal();
            } else {
                throw new Error("Invalid data format");
            }
        } catch (e) {
            list.innerHTML = '<div style="color:var(--red-alert); padding:20px; text-align:center;">Failed to load metrics.</div>';
        }
    }
}

function populateAlertsModal() {
    const list = document.getElementById('manageAlertsList');
    const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    
    const fmtInput = (val) => {
        if (val === null || val === undefined || String(val).trim() === '') return '';
        let str = String(val).trim();
        
        if (isNaN(parseFloat(str))) return str;
        
        if (str.includes('%')) {
            return parseFloat(str.replace(/[^0-9.-]/g, '')).toFixed(2);
        }
        
        let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
        return (num * 100).toFixed(2);
    };

    let html = '';

    STORES.forEach(storeName => {
        let sData = globalAlertsData.find(s => s.store.toUpperCase() === storeName) || { 
            store: storeName, currentHigh: '', currentVeryHigh: '', projectedHigh: '', projectedVeryHigh: '',
            defectRate: '', lateShipment: '', casesClosed: '', tracking: '' 
        };
        
        html += `
            <div class="alert-manage-row" data-store="${storeName}" style="background: #fff; padding: 15px; border-radius: 8px; border: 1px solid #ddd; margin-bottom: 15px;">
                <div style="font-weight: 900; color: var(--slate-charcoal); font-size: 14px; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 5px;">${storeName}</div>
                
                <div style="font-size: 11px; font-weight: 800; color: #888; text-transform: uppercase; margin-bottom: 6px;">eBay Performance Metrics</div>
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 15px;">
                    <input type="text" class="a-ch" placeholder="Current High" title="Current High" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${sData.currentHigh || ''}">
                    <input type="text" class="a-cvh" placeholder="Current Very High" title="Current Very High" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${sData.currentVeryHigh || ''}">
                    <input type="text" class="a-ph" placeholder="Projected High" title="Projected High" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${sData.projectedHigh || ''}">
                    <input type="text" class="a-pvh" placeholder="Projected Very High" title="Projected Very High" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${sData.projectedVeryHigh || ''}">
                </div>

                <div style="font-size: 11px; font-weight: 800; color: #888; text-transform: uppercase; margin-bottom: 6px;">eBay Top Rated Metrics</div>
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;">
                    <input type="text" class="a-dr" placeholder="Defect Rate" title="Transaction Defect Rate" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${fmtInput(sData.defectRate)}">
                    <input type="text" class="a-ls" placeholder="Late Shipment" title="Late Shipment Rate" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${fmtInput(sData.lateShipment)}">
                    <input type="text" class="a-cc" placeholder="Cases Closed" title="Cases Closed w/o Resolution" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${fmtInput(sData.casesClosed)}">
                    <input type="text" class="a-tr" placeholder="Tracking" title="Tracking Uploaded" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; outline: none;" value="${fmtInput(sData.tracking)}">
                </div>
            </div>
        `;
    });

    list.innerHTML = html;
}

async function saveAlertsData() {
    const btn = document.getElementById('saveAlertsBtn');
    btn.textContent = "Saving...";
    btn.style.opacity = "0.7";
    btn.style.pointerEvents = "none"; 

    // Takes your input (e.g. 99.12) and appends "%" for Google Sheets
    const formatForSheet = (val) => {
        if (!val || String(val).trim() === '') return '';
        let str = String(val).trim();
        
        // If they typed text like "N/A" or "All Clear", leave it alone
        if (isNaN(parseFloat(str))) return str;
        
        // Strip any accidental % signs the user typed
        let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
        
        // Send back exactly what they typed + "%". e.g. "99.12" -> "99.12%"
        return num + '%'; 
    };

    const updatedAlerts = [];
    document.querySelectorAll('.alert-manage-row').forEach(row => {
        updatedAlerts.push({
            store: row.getAttribute('data-store'),
            currentHigh: row.querySelector('.a-ch').value.trim(),
            currentVeryHigh: row.querySelector('.a-cvh').value.trim(),
            projectedHigh: row.querySelector('.a-ph').value.trim(),
            projectedVeryHigh: row.querySelector('.a-pvh').value.trim(),
            defectRate: formatForSheet(row.querySelector('.a-dr').value),
            lateShipment: formatForSheet(row.querySelector('.a-ls').value),
            casesClosed: formatForSheet(row.querySelector('.a-cc').value),
            tracking: formatForSheet(row.querySelector('.a-tr').value)
        });
    });

    try {
        await fetch(EBAY_ALERTS_URL, {
            method: 'POST',
            mode: 'no-cors', 
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ data: updatedAlerts }) 
        });

        alert("eBay Performance Metrics successfully updated!");
        closeAllModals();
        if (typeof fetchAlertsData === 'function') fetchAlertsData(); 
        if (typeof fetchMasterDistrictDashboard === 'function') fetchMasterDistrictDashboard();
        
    } catch (e) {
        console.error(e);
        alert("Failed to connect to server.");
    } finally {
        btn.textContent = "Save Changes";
        btn.style.opacity = "1";
        btn.style.pointerEvents = "auto";
    }
}

// --- MODAL: MANAGE HOTKEYS ---
async function toggleManageHotkeys() {
    const dropdown = document.getElementById('manageHotkeysDropdown');
    if (!dropdown) return;
    
    const isOpen = dropdown.classList.contains('show');
    closeAllModals(); 
    
    if (!isOpen) {
        dropdown.classList.add('show');
        lockAndBlurScreen();

        const list = document.getElementById('manageHotkeysList');
        list.innerHTML = '<div class="status-message">Syncing Database...</div>';
        
        try {
            const res = await fetch(`${HOTKEYS_URL}?v=${Date.now()}`);
            globalHotkeysData = await res.json();
            populateHotkeysModal();
        } catch (e) {
            list.innerHTML = '<div style="color:var(--red-alert); padding:20px; text-align:center;">Failed to sync data.</div>';
        }
    }
}

function populateHotkeysModal() {
    const list = document.getElementById('manageHotkeysList');
    list.innerHTML = '';
    
    if (!globalHotkeysData || globalHotkeysData.length === 0) {
        addManageHotkeyRow();
    } else {
        globalHotkeysData.forEach(item => addManageHotkeyRow(item));
    }
}

function addManageHotkeyRow(item = { brand: '', device: '', hotkey: '', func: '' }) {
    const row = document.createElement('div');
    row.className = 'hotkey-manage-row';

    row.innerHTML = `
        <input type="text" class="h-brand" placeholder="Brand (e.g., Apple)" value="${item.brand}">
        <input type="text" class="h-device" placeholder="Device (e.g., MacBook)" value="${item.device}">
        <input type="text" class="h-hotkey" placeholder="Hotkey (e.g., Cmd+R)" value="${item.hotkey}">
        <input type="text" class="h-func" placeholder="Function" value="${item.func}">
        <button class="del-btn" onclick="this.parentElement.remove()" title="Delete">✖</button>
    `;
    document.getElementById('manageHotkeysList').appendChild(row);
}

async function saveManageHotkeys() {
    const btn = document.getElementById('saveHotkeysBtn');
    const updatedHotkeys = [];

    document.querySelectorAll('#manageHotkeysList .hotkey-manage-row').forEach(row => {
        const brand = row.querySelector('.h-brand').value.trim();
        const device = row.querySelector('.h-device').value.trim();
        const hotkey = row.querySelector('.h-hotkey').value.trim();
        const func = row.querySelector('.h-func').value.trim();

        if (brand || device || hotkey || func) {
            updatedHotkeys.push({ brand, device, hotkey, func });
        }
    });

    updatedHotkeys.sort((a, b) => {
        const brandCompare = a.brand.localeCompare(b.brand, undefined, { sensitivity: 'base' });
        if (brandCompare !== 0) return brandCompare;
        return a.device.localeCompare(b.device, undefined, { sensitivity: 'base' });
    });

    btn.textContent = "Saving...";
    btn.style.opacity = "0.7";

    try {
        const res = await fetch(HOTKEYS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(updatedHotkeys)
        });

        if (res.ok) {
            alert("System Hotkeys successfully updated!");
            closeAllModals();
            if (typeof loadHotkeys === 'function') loadHotkeys(); 
        } else {
            alert("Error saving hotkeys.");
        }
    } catch (e) {
        console.error(e);
        alert("Failed to connect to server.");
    } finally {
        btn.textContent = "Save Changes";
        btn.style.opacity = "1";
    }
}

// --- DM SCORECARD SUBMISSION LOGIC ---
const SCORECARD_CATEGORIES = [
    "Front of House Cleanliness",
    "Back of House Cleanliness",
    "Recycle Organization",
    "Retail Displays",
    "Overall Organization",
    "Staff Goals Readiness",        // index 5 — In-Store Operations ends here
    "Online Store Pictures",        // index 6 — Media and Markets starts here
    "5 Facebook Listings",
    "2 Social Media Posts",
    "Store Listing Review",
    "Store Buying Review"
];

const SCORECARD_BUCKETS = [
    { label: "In-Store Operations", count: 6 },
    { label: "Media and Markets", count: 3 },
    { label: "Store Reviews", count: 2 }
];

function openScorecardModal() {
    // 1. Let your native portal handle the animations and overlays!
    toggleModal('scorecardSubmitModal');

    // 2. Auto-fill today's date
    const dateInput = document.getElementById('dm-score-date');
    if (dateInput) dateInput.valueAsDate = new Date();

    // 3. Generate the inputs grouped by bucket, each with a section toggle
    const container = document.getElementById('dm-category-inputs');
    if (container) {
        let html = '';
        let catIndex = 0;
        SCORECARD_BUCKETS.forEach((bucket, bIdx) => {
            html += `<div style="grid-column: 1 / -1; margin-top: ${bIdx > 0 ? '8px' : '0'}; padding-bottom: 4px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between;">
                <span style="font-size: 10px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;">${bucket.label}</span>
                <label style="display: flex; align-items: center; gap: 5px; cursor: pointer; font-size: 10px; color: #94a3b8; font-weight: 700;">
                    <input type="checkbox" id="section-toggle-${bIdx}" checked onchange="toggleScorecardSection(${bIdx})" style="cursor: pointer; width: 13px; height: 13px;">
                    Update
                </label>
            </div>
            <div id="section-inputs-${bIdx}" style="display: contents;">`;
            for (let i = 0; i < bucket.count; i++) {
                const cat = SCORECARD_CATEGORIES[catIndex];
                html += `<div style="display: flex; flex-direction: column;">
                    <label class="form-label-caps">${cat}</label>
                    <select id="score-input-${catIndex}" class="form-input-lg" style="margin-top: 0; padding: 10px; font-size: 14px;">
                        <option value="">--</option>
                        <option value="5">5</option>
                        <option value="4">4</option>
                        <option value="3">3</option>
                        <option value="2">2</option>
                        <option value="1">1</option>
                        <option value="0">0</option>
                    </select>
                </div>`;
                catIndex++;
            }
            html += `</div>`;
        });
        container.innerHTML = html;
    }
}

function toggleScorecardSection(bIdx) {
    const enabled = document.getElementById(`section-toggle-${bIdx}`).checked;
    const wrapper = document.getElementById(`section-inputs-${bIdx}`);
    if (wrapper) wrapper.style.display = enabled ? 'contents' : 'none';
}

// We don't even need a custom close function anymore!
// Your native "closeAllModals()" command takes care of it.

function closeScorecardModal() {
    closeAllModals(); // Your native function handles hiding everything
}

function submitNewScorecard() {
    const store = document.getElementById('dm-store-select').value;
    const date = document.getElementById('dm-score-date').value;
    const btn = document.getElementById('submitScorecardBtn');

    // Determine which sections are enabled
    const enabledSections = SCORECARD_BUCKETS.map((b, i) => {
        const toggle = document.getElementById(`section-toggle-${i}`);
        return toggle ? toggle.checked : true;
    });

    const isPartial = !enabledSections.every(e => e);

    if (!enabledSections.some(e => e)) {
        alert("Please enable at least one section to update.");
        return;
    }

    // Gather scores per section — blanks are allowed (Apps Script carries previous value forward)
    let catIndex = 0;
    let sectionData = [];

    SCORECARD_BUCKETS.forEach((bucket, bIdx) => {
        const enabled = enabledSections[bIdx];
        const scores = [];
        for (let i = 0; i < bucket.count; i++) {
            const val = document.getElementById(`score-input-${catIndex}`).value;
            scores.push(val === '' ? null : parseFloat(val));
            catIndex++;
        }
        if (enabled) sectionData.push({ bucketIndex: bIdx, scores: scores });
    });

    btn.innerText = "Saving...";
    btn.style.opacity = "0.7";
    btn.disabled = true;

    let payload;
    if (isPartial) {
        payload = {
            action: 'submit_scorecard',
            store: store,
            date: date,
            partial: true,
            sections: sectionData
        };
    } else {
        payload = {
            action: 'submit_scorecard',
            store: store,
            date: date,
            scores: sectionData.flatMap(s => s.scores)
        };
    }

    fetch(SCORECARD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).then(async res => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Save failed');

        btn.innerText = "Saved Successfully!";
        btn.style.background = "var(--sage-professional)";

        setTimeout(() => {
            if (typeof fetchScorecardData === 'function') fetchScorecardData();
            if (typeof fetchMasterDistrictDashboard === 'function') fetchMasterDistrictDashboard();
            closeScorecardModal();
            btn.innerText = "Save Scorecard";
            btn.style.background = "";
            btn.disabled = false;
        }, 1500);
    }).catch(err => {
        alert("Error saving scorecard: " + (err.message || err));
        btn.innerText = "Save Scorecard";
        btn.style.background = "";
        btn.disabled = false;
    });
}

// --- STORE COMMENTS LOGIC ---

// Per-comment fingerprint tracking so new comments always show even after closing a previous one
function _getSeenCommentKeys() {
    try { return new Set(JSON.parse(sessionStorage.getItem('speeksSeenCommentKeys') || '[]')); }
    catch(e) { return new Set(); }
}
function _saveSeenCommentKeys(keys) {
    sessionStorage.setItem('speeksSeenCommentKeys', JSON.stringify([...keys]));
}
function _commentKey(c) {
    return `${String(c.store||'').trim()}|${String(c.date||'').trim()}|${String(c.author||'').trim()}|${String(c.message||'').trim()}`.slice(0, 120);
}

let _storeCommentPollingStarted = false;
function startStoreCommentPolling() {
    if (_storeCommentPollingStarted) return;
    _storeCommentPollingStarted = true;
    setInterval(fetchAndDisplayStoreComment, 30 * 1000);
}

// Opens the modal normally from the Speeks Tools menu (Fully Unlocked)
function toggleSendCommentModal() {
    openCEOStoreComment(null); 
}

// Opens the modal from the CEO Rings and locks it to the specific store
window.openCEOStoreComment = function(targetStore) {
    closeAllModals();
    const dropdown = document.getElementById('sendCommentModal');
    
    if (dropdown) {
        dropdown.classList.add('show');
        lockAndBlurScreen();
        
        // Clear previous message
        document.getElementById('commentMessageInput').value = '';
        
        const storeSelect = document.getElementById('commentStoreSelect');
        if (storeSelect) {
            if (targetStore) {
                // Lock it to the specific store clicked
                storeSelect.value = targetStore;
                storeSelect.disabled = true;
                storeSelect.style.opacity = '0.6';
                storeSelect.style.cursor = 'not-allowed';
            } else {
                // Unlock it for general use via the Speeks Tools menu
                storeSelect.value = 'ALL';
                storeSelect.disabled = false;
                storeSelect.style.opacity = '1';
                storeSelect.style.cursor = 'pointer';
            }
        }
    }
};

async function submitStoreComment() {
    const store = document.getElementById('commentStoreSelect').value;
    const message = document.getElementById('commentMessageInput').value.trim();
    const btn = document.getElementById('sendCommentBtn');

    if (!message) {
        alert("Please write a message before sending.");
        return;
    }

    btn.innerText = "Sending...";
    btn.style.opacity = "0.7";

    const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    const author = sessionStorage.getItem('speeksUserName') || 'Executive Team';

    const payload = {
        date: todayStr,
        store: store,
        author: author,
        message: message
    };

    try {
        await fetch(STORE_COMMENT_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });
        
        alert("Success! The message is live for " + store);
        closeAllModals();
    } catch (e) {
        alert("Failed to send the message.");
    } finally {
        btn.innerText = "Send Message";
        btn.style.opacity = "1";
    }
}

// Helper to close the bubble (comments already marked seen when bubble was shown)
window.closeDailyCommentBubble = function() {
    const bubble = document.getElementById('dailyMessageBubble');
    if (bubble) bubble.style.display = 'none';
};

async function fetchAndDisplayStoreComment() {
    const userStore = String(sessionStorage.getItem('speeksUserStore') || 'OVL').trim().toUpperCase();
    const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });

    try {
        const res = await fetch(`${STORE_COMMENT_URL}?v=${Date.now()}`);
        const comments = await res.json();

        const todayComments = comments.filter(c => {
            const cStore = String(c.store || '').trim().toUpperCase();
            let rawDateStr = String(c.date || '').trim();
            let parsedDateStr = "";

            try {
                const parsed = new Date(c.date);
                if (!isNaN(parsed.getTime())) {
                    parsedDateStr = parsed.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
                }
            } catch(e) {}

            const isToday = (parsedDateStr === todayStr || rawDateStr.includes(todayStr));
            const isForMe = (cStore === userStore || cStore === 'ALL' || cStore === 'CORP');

            return isToday && isForMe;
        }).reverse(); // Newest first

        // Only show comments the user hasn't seen yet in this session
        const seenKeys = _getSeenCommentKeys();
        const newComments = todayComments.filter(c => !seenKeys.has(_commentKey(c)));
        if (newComments.length === 0) return;

        // Mark all today's comments seen now so repeat polls don't re-show the same ones
        todayComments.forEach(c => seenKeys.add(_commentKey(c)));
        _saveSeenCommentKeys(seenKeys);

        if (newComments.length > 0) {
            const bubble = document.getElementById('dailyMessageBubble');
            const textEl = document.getElementById('dailyMessageBubbleText');
            const iconEl = document.getElementById('dailyMessageBubbleIcon');
            
            if (bubble && textEl && iconEl) {
                iconEl.style.display = 'none';
                textEl.style.display = 'flex';
                textEl.style.flexDirection = 'column';
                textEl.style.gap = '8px';
                textEl.style.padding = '2px 0';

                // Build the HTML for new (unseen) messages only
                let messagesHtml = '';
                newComments.forEach(msg => {
                    const authorName = msg.author || 'Executive Team';
                    const emoji = '📣';

                    const cStore = String(msg.store || '').trim().toUpperCase();
                    const isAllStores = (cStore === 'ALL' || cStore === 'CORP');
                    const scopeBadge = isAllStores
                        ? `<span style="display:inline-block;font-size:10px;font-weight:600;background:rgba(255,255,255,0.12);color:#fde68a;border:1px solid rgba(253,230,138,0.35);border-radius:4px;padding:1px 5px;margin-left:5px;vertical-align:middle;letter-spacing:0.3px;">Company</span>`
                        : `<span style="display:inline-block;font-size:10px;font-weight:600;background:rgba(255,255,255,0.08);color:#a7f3d0;border:1px solid rgba(167,243,208,0.3);border-radius:4px;padding:1px 5px;margin-left:5px;vertical-align:middle;letter-spacing:0.3px;">${cStore}</span>`;

                    messagesHtml += `
                        <div style="display: flex; align-items: flex-start; gap: 8px; line-height: 1.4;">
                            <span style="font-size: 15px; flex-shrink: 0; margin-top: -2px;">${emoji}</span>
                            <span><strong style="color: #fef3c7;">${authorName}:</strong>${scopeBadge} <span style="opacity: 0.95;">${msg.message}</span></span>
                        </div>
                    `;
                });

                textEl.innerHTML = messagesHtml;

                setTimeout(() => {
                    bubble.style.display = 'flex';
                    bubble.animate([
                        { transform: 'scale(0.9) translateX(10px)', opacity: 0 },
                        { transform: 'scale(1) translateX(0)', opacity: 1 }
                    ], { duration: 400, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });
                }, 1500); 
            }
        }
    } catch (e) {
        console.error("Failed to fetch store comments. Error:", e);
    }
}

// --- 14.5. MODULE: WEEKLY CHAMPIONS (LISTERS & BUYERS) ---
async function fetchChampions() {
    const listerBody = document.getElementById('lister-champions-body');
    const buyerBody = document.getElementById('buyer-champions-body');
    const grBody = document.getElementById('google-review-champions-body');
    const lDate = document.getElementById('lister-champions-date');
    const bDate = document.getElementById('buyer-champions-date');
    const grDate = document.getElementById('google-review-champions-date');
    try {
        const stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
        let allListers = [];
        let allBuyers = [];
        let allGoogleReviews = [];

        // 1. Calculate "Week Of" based on the previous Monday
        const now = new Date();
        const day = now.getDay();
        const diffToMonday = day === 0 ? -6 : 1 - day;
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() + diffToMonday);
        const weekText = "Week of " + startOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        
        if (lDate) lDate.innerText = weekText;
        if (bDate) bDate.innerText = weekText;
        if (grDate) grDate.innerText = weekText;

        // 2. User Directory matching (Gets Full Names)
        let authCache = {};
        try { authCache = JSON.parse(localStorage.getItem('speeksAuthCache')) || {}; } catch(e){}
        const users = authCache.users || [];
        const getFullName = (shortName) => {
            const s = String(shortName).toLowerCase().trim();
            const matched = users.find(u => {
                const full = String(u.name).toLowerCase().trim();
                return full === s || full.split(' ')[0] === s || full.startsWith(s);
            });
            return matched ? matched.name : shortName; 
        };

        // 3. FETCH LISTERS
        const listerFetches = stores.map(s => fetch(`${WEEKLY_KPI_URL}?store=${s}&v=${Date.now()}`).then(r => r.json()));
        const listerResults = await Promise.all(listerFetches);

        listerResults.forEach((d, storeIdx) => {
            // New clean JSON format: { employees, store_total, period_label }
            (d.employees || []).forEach(e => {
                const listed  = parseNum(e.listed_count);
                const reviews = parseNum(e.mtd_google_reviews);
                if (listed  > 0) allListers.push({ name: getFullName(e.employee_name), store: stores[storeIdx], listed });
                if (reviews > 0) allGoogleReviews.push({ name: getFullName(e.employee_name), store: stores[storeIdx], reviews });
            });
        });

        // 4. FETCH BUYERS — reads from each store's weekly entries and ranks by buying_value
        try {
            const buyerFetches = stores.map(s => fetch(`${WEEKLY_KPI_URL}?store=${s}&v=${Date.now()}`).then(r => r.json()));
            const buyerResults = await Promise.all(buyerFetches);
            buyerResults.forEach((d, storeIdx) => {
                (d.employees || []).forEach(e => {
                    const score = parseNum(e.buying_value);
                    if (score > 0) allBuyers.push({ name: getFullName(e.employee_name), store: stores[storeIdx], score });
                });
            });
        } catch (buyerErr) {
            console.error("Failed to fetch Weekly Buyers:", buyerErr);
        }

        // 5. BUILDER HELPER
        const buildPodiumHtml = (dataArray, sortBy, labelText, type) => {
            const merged = {};
            dataArray.forEach(emp => {
                if (!merged[emp.name]) merged[emp.name] = { ...emp };
                else {
                    if (type === 'lister') merged[emp.name].listed += emp.listed;
                    if (type === 'buyer') merged[emp.name].score = Math.max(merged[emp.name].score, emp.score);
                    if (type === 'review') merged[emp.name].reviews += emp.reviews;
                }
            });
            
            const uniqueEmps = Object.values(merged);
            uniqueEmps.sort((a, b) => b[sortBy] - a[sortBy]);
            const top3 = uniqueEmps.slice(0, 3);

            if (top3.length === 0) return '<div style="color: #888; font-weight: 600; text-align: center; width: 100%;">No data available yet.</div>';

            const podiumTheme = ['#e2e8f0', '#fef08a', '#fed7aa']; 

            const podiumOrder = [
                { data: top3[1], place: 2, height: '155px', color: podiumTheme[0], medal: '🥈' },
                { data: top3[0], place: 1, height: '215px', color: podiumTheme[1], medal: '🥇' },
                { data: top3[2], place: 3, height: '115px', color: podiumTheme[2], medal: '🥉' }
            ];

            let html = '';
            podiumOrder.forEach(podium => {
                if (!podium.data) return; 
                const emp = podium.data;
                const isFirst = podium.place === 1;
                
                // Only render the inner score/items text block if it is the Lister or Review podium
                let blockContent = '';
                if (type === 'lister' || type === 'review') {
                    const val = type === 'lister' ? emp.listed : emp.reviews;
                    blockContent = `
                        <div style="z-index: 2; display: flex; flex-direction: column; align-items: center;">
                            <span style="font-size: ${isFirst ? '32px' : '26px'}; font-weight: 900; color: var(--slate-charcoal); line-height: 1;">${val}</span>
                            <span style="font-size: 9px; font-weight: 900; color: #64748b; text-transform: uppercase; margin-top: 4px;">${labelText}</span>
                        </div>`;
                }

                html += `
                <div style="display: flex; flex-direction: column; align-items: center; width: 130px;">
                    <div style="margin-bottom: 12px; text-align: center; display: flex; flex-direction: column; align-items: center; z-index: 2;">
                        <div style="font-size: ${isFirst ? '46px' : '34px'}; line-height: 1; margin-bottom: 8px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));">${podium.medal}</div>
                        <div style="font-size: ${isFirst ? '14px' : '12px'}; font-weight: 900; color: var(--slate-charcoal); line-height: 1.2; text-align: center;">${emp.name}</div>
                        <div style="font-size: 10px; font-weight: 800; color: #888; text-transform: uppercase; margin-top: 4px;">${emp.store}</div>
                    </div>
                    
                    <div style="width: 100%; height: ${podium.height}; background: linear-gradient(to bottom, ${podium.color}, #ffffff); border: 1px solid rgba(0,0,0,0.05); border-bottom: none; border-radius: 12px 12px 0 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding-top: 15px; position: relative; overflow: hidden;">
                        
                        ${blockContent}
                        
                        <span style="position: absolute; bottom: 8px; font-size: 42px; font-weight: 900; color: #000000; opacity: 0.12; line-height: 1; user-select: none; z-index: 1;">${podium.place}</span>
                    </div>
                </div>`;
            });
            return html;
        };

        feedChampionsToTicker(allBuyers, allListers, allGoogleReviews);
        _tickerSourceDone('champions');

        if (listerBody) listerBody.innerHTML = buildPodiumHtml(allListers, 'listed', 'Items', 'lister');
        if (grBody) grBody.innerHTML = buildPodiumHtml(allGoogleReviews, 'reviews', 'Reviews', 'review');
        if (buyerBody) buyerBody.innerHTML = buildPodiumHtml(allBuyers, 'score', 'Score', 'buyer');

    } catch (e) {
        if (listerBody) listerBody.innerHTML = '<div style="color: var(--red-alert); font-weight: bold;">Failed to load Champions.</div>';
        if (grBody) grBody.innerHTML = '<div style="color: var(--red-alert); font-weight: bold;">Failed to load Champions.</div>';
        if (buyerBody) buyerBody.innerHTML = '<div style="color: var(--red-alert); font-weight: bold;">Failed to load Champions.</div>';
        _tickerSourceDone('champions');
    }
}

// ============================================================================
// MANAGER CHECKLIST MODULE
// ============================================================================
let currentChecklistTab = 'daily';
let checklistDataCache = { daily: [], weekly: [], monthly: [], quarterly: [] };

// For assistant managers, returns the store's primary manager name so both share the same checklist data.
// All other roles return their own name, preserving existing behavior.
function getChecklistUser() {
    const role = sessionStorage.getItem('speeksUserRole') || '';
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';
    const userName = sessionStorage.getItem('speeksUserName') || 'Unknown';

    if (role !== 'assistant manager') return userName;

    try {
        const authCache = JSON.parse(localStorage.getItem('speeksAuthCache')) || {};
        const users = authCache.users || [];
        for (const targetRole of ['owner (manager)', 'manager']) {
            const mgr = users.find(u =>
                u.store && u.store.toUpperCase() === store &&
                u.role && u.role.toLowerCase() === targetRole
            );
            if (mgr) return mgr.name;
        }
    } catch (e) {}

    return userName;
}

function switchChecklistTab(tab) {
    currentChecklistTab = tab;
    document.getElementById('cl-tab-daily').classList.toggle('active', tab === 'daily');
    document.getElementById('cl-tab-weekly').classList.toggle('active', tab === 'weekly');
    document.getElementById('cl-tab-monthly').classList.toggle('active', tab === 'monthly');
    
    // Safety check just in case the button isn't on the screen
    const qTab = document.getElementById('cl-tab-quarterly');
    if (qTab) qTab.classList.toggle('active', tab === 'quarterly');
    
    renderChecklist();
}

async function loadChecklist() {
    const container = document.getElementById('checklistContent');
    const userName = getChecklistUser();
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';

    const role = sessionStorage.getItem('speeksUserRole') || '';
    const isAssistantManager = role === 'assistant manager';

    // Assistant managers only see Daily
    const weeklyTab = document.getElementById('cl-tab-weekly');
    const monthlyTab = document.getElementById('cl-tab-monthly');
    if (weeklyTab) weeklyTab.style.display = isAssistantManager ? 'none' : '';
    if (monthlyTab) monthlyTab.style.display = isAssistantManager ? 'none' : '';
    if (isAssistantManager && currentChecklistTab !== 'daily') switchChecklistTab('daily');

    // Only show Quarterly tab for CORP/ALL stores
    const qTab = document.getElementById('cl-tab-quarterly');
    if (qTab) {
        if (!isAssistantManager && (store === 'CORP' || store === 'ALL')) {
            qTab.style.display = 'inline-flex';
        } else {
            qTab.style.display = 'none';
            if (currentChecklistTab === 'quarterly') switchChecklistTab('daily');
        }
    }

    container.innerHTML = '<div class="status-message">Syncing Checklist...</div>';

    try {
        const res = await fetch(`${CHECKLIST_URL}?user=${encodeURIComponent(userName)}&store=${store}&v=${Date.now()}`);
        checklistDataCache = await res.json();
        renderChecklist();
    } catch (e) {
        console.error("Checklist Fetch Error", e);
        container.innerHTML = '<div class="status-message" style="color: var(--red-alert);">Failed to load checklist.</div>';
    }
}

function renderChecklist() {
    const container = document.getElementById('checklistContent');
    const items = checklistDataCache[currentChecklistTab] || [];

    if (items.length === 0) {
        container.innerHTML = `<div style="text-align: center; padding: 30px; color: #888; font-weight: 600; font-size: 13px;">No tasks for this tab. Add one below!</div>`;
        return;
    }

    let html = '';
    items.forEach(item => {
        const completedClass = item.checked ? 'completed' : '';
        
        // Only allow deletion of personal items
        const deleteHtml = !item.isGlobal ? 
            `<button class="cl-delete-btn" onclick="deleteChecklistItem('${item.id}')" title="Delete Task">✖</button>` : '';

        html += `
        <div class="cl-item ${completedClass}">
            <input type="checkbox" class="cl-checkbox" ${item.checked ? 'checked' : ''} onchange="toggleChecklistState('${item.id}', this.checked)">
            <div class="cl-content-wrapper" style="justify-content: center;">
                <span class="cl-text">${escapeHtml(item.text)}</span>
            </div>
            ${deleteHtml}
        </div>`;
    });

    container.innerHTML = html;
    updateChecklistChip();
}

// --- API ACTIONS (POST to Apps Script) ---
async function toggleChecklistState(id, isChecked) {
    const userName = getChecklistUser();
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';
    
    const item = checklistDataCache[currentChecklistTab].find(i => i.id === id);
    if (item) item.checked = isChecked;
    renderChecklist(); 

    fetch(CHECKLIST_URL, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'toggle', id: id, checked: isChecked, user: userName, store: store }) // <--- Added store here
    }).catch(() => {});
}

async function addChecklistItem() {
    const input = document.getElementById('newChecklistTask');
    const text = input.value.trim();
    if (!text) return;

    input.value = 'Saving...';
    input.disabled = true;

    const userName = getChecklistUser();
    const store = sessionStorage.getItem('speeksUserStore');
    const tempId = 'temp_' + Date.now();

    const payload = {
        action: 'add',
        tab: currentChecklistTab,
        text: text,
        user: userName,
        store: store
    };

    try {
        await fetch(CHECKLIST_URL, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });
        
        // Optimistically add to local cache so they see it instantly
        checklistDataCache[currentChecklistTab].push({ id: tempId, text: text, isGlobal: false, checked: false });
        renderChecklist();
    } catch (e) {
        alert("Failed to add task.");
    } finally {
        input.value = '';
        input.disabled = false;
        input.focus();
    }
}

async function deleteChecklistItem(id) {
    const userName = getChecklistUser();
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';

    checklistDataCache[currentChecklistTab] = checklistDataCache[currentChecklistTab].filter(i => i.id !== id);
    renderChecklist();

    fetch(CHECKLIST_URL, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'delete', id: id, user: userName, store: store })
    }).catch(() => {});
}

function clearChecklistTab() {
    const items = checklistDataCache[currentChecklistTab] || [];
    const checkedItems = items.filter(i => i.checked);
    if (checkedItems.length === 0) return;

    const userName = getChecklistUser();
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';

    items.forEach(i => i.checked = false);
    renderChecklist();

    checkedItems.forEach(item => {
        fetch(CHECKLIST_URL, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'toggle', id: item.id, checked: false, user: userName, store: store })
        }).catch(() => {});
    });
}

// --- CHECKLIST NUDGE HELPERS ---
function updateChecklistChip() {
    const chip = document.getElementById('cl-progress-chip');
    const btn = document.querySelector('.cl-nav-toggle');
    if (!chip || !btn) return;

    const dailyItems = checklistDataCache['daily'] || [];
    const total = dailyItems.length;
    if (total === 0) {
        chip.textContent = '';
        btn.classList.remove('cl-needs-attention');
        return;
    }

    const done = dailyItems.filter(i => i.checked).length;
    chip.textContent = done === total ? '✓ All done' : `${done}/${total} done`;

    const panel = document.getElementById('checklistSidePanel');
    const isOpen = panel && panel.classList.contains('open');
    btn.classList.toggle('cl-needs-attention', done < total && !isOpen);
}


// --- BULLETPROOF TOGGLE & CLICK-AWAY LOGIC ---
window.toggleChecklistPanel = function(event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('checklistSidePanel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    const toggle = document.querySelector('.cl-nav-toggle');
    if (toggle) {
        toggle.classList.toggle('panel-active', isOpen);
        if (isOpen) toggle.classList.remove('cl-needs-attention');
    }
    if (isOpen) {
        document.getElementById('goalsSidePanel')?.classList.remove('open');
        document.querySelector('.gi-nav-toggle')?.classList.remove('panel-active');
        _resetToCurrentMonth?.();
    }
};

// Closes the panel if you click outside of it
document.addEventListener('click', function(e) {
    // CRITICAL FIX: If the clicked element was just removed from the DOM (like deleting a task), ignore the click!
    if (!document.body.contains(e.target)) return;
    // Don't close panels while a modal is open or the click was inside one (e.g. ✖ button fires closeAllModals before bubbling)
    if (document.getElementById('globalOverlay')?.classList.contains('show')) return;
    if (e.target.closest('.modal-menu')) return;

    const clPanel = document.getElementById('checklistSidePanel');
    if (clPanel && clPanel.classList.contains('open')) {
        if (!clPanel.contains(e.target)) {
            clPanel.classList.remove('open');
            document.querySelector('.cl-nav-toggle')?.classList.remove('panel-active');
                }
    }

    const giPanel = document.getElementById('goalsSidePanel');
    const giToggle = document.querySelector('.gi-nav-toggle');
    if (giPanel && giPanel.classList.contains('open')) {
        if (!giPanel.contains(e.target) && !giToggle?.contains(e.target)) {
            giPanel.classList.remove('open');
            giToggle?.classList.remove('panel-active');
            _resetToCurrentMonth();
                }
    }
});

// --- ROLE SELECTION LOGIC ---
window.updateRoleLocks = function() {
    // Find which roles are currently selected by anyone
    const activeRoles = Array.from(document.querySelectorAll('.role-dot.active')).map(btn => btn.innerText);
    
    document.querySelectorAll('.role-dot').forEach(btn => {
        if (!btn.classList.contains('active')) {
            if (activeRoles.includes(btn.innerText)) {
                // Gray it out and mark it as taken
                btn.style.opacity = '0.3';
                btn.style.cursor = 'not-allowed';
                btn.dataset.roleTaken = 'true';
            } else {
                // Only restore if it isn't locked by the 10:30am cutoff
                if (!btn.hasAttribute('disabled')) {
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                    btn.dataset.roleTaken = 'false';
                }
            }
        } else {
            // If it is active, make sure it looks fully visible
            if (!btn.hasAttribute('disabled')) {
                btn.style.opacity = '1';
                btn.style.cursor = 'pointer';
            }
        }
    });
};

window.selectRole = function(clickedBtn, emp, role) {
    if (clickedBtn.hasAttribute('disabled')) return;
    
    // Prevent selecting if someone else already has it
    if (clickedBtn.dataset.roleTaken === 'true') {
        alert(`The role ${role} is already assigned to another team member. Please deselect it from them first.`);
        return;
    }

    const isAlreadyActive = clickedBtn.classList.contains('active');

    // 1. If clicking the already active role, toggle it off and free it up
    if (isAlreadyActive) {
        clickedBtn.classList.remove('active');
        updateRoleLocks(); // Re-check the board
        return;
    }

    // 2. Remove ALL roles from the CURRENT employee (Only 1 role per person)
    const parentRow = clickedBtn.closest('.goals-edit-roles');
    if (parentRow) {
        parentRow.querySelectorAll('.role-dot').forEach(btn => {
            btn.classList.remove('active');
        });
    }

    // 3. Make the newly clicked button active
    clickedBtn.classList.add('active');

    // 4. Lock this role out for everyone else
    updateRoleLocks();
};

// --- PATCH NOTES ---
function parsePatchDate(d) {
    if (!d) return new Date(0);
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(d)) {
        const p = d.split('/');
        return new Date(p[2], p[0] - 1, p[1]);
    }
    const fallback = new Date(d);
    return isNaN(fallback) ? new Date(0) : fallback;
}

function formatPatchDate(d) {
    const date = parsePatchDate(d);
    if (!date || isNaN(date.getTime()) || date.getTime() === 0) return d;
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function formatPatchSummary(text) {
    if (!text) return '';
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    if (!lines.length) return text;
    let html = '', inList = false;
    lines.forEach(l => {
        if (/^[-•]/.test(l)) {
            if (!inList) { html += '<ul class="pn-bullet-list">'; inList = true; }
            html += `<li>${l.replace(/^[-•]\s*/, '')}</li>`;
        } else {
            if (inList) { html += '</ul>'; inList = false; }
            html += `<span class="pn-item-line">${l}</span>`;
        }
    });
    if (inList) html += '</ul>';
    return html;
}

function buildPatchGroups(entries) {
    const groups = {};
    entries.forEach(e => {
        const key = e.title + '|' + e.date;
        if (!groups[key]) groups[key] = { title: e.title, date: e.date, items: [] };
        groups[key].items.push(e);
    });
    return Object.values(groups).sort((a, b) => parsePatchDate(b.date) - parsePatchDate(a.date));
}

function buildPatchCardHTML(group, isLatest) {
    const versionLabel = group.title;
    const catOrder = ['New Features', 'Improvements', 'Bug Fixes'];
    const catIcons = { 'New Features': '✨', 'Improvements': '🚀', 'Bug Fixes': '🔧' };
    const sections = catOrder.map(cat => {
        const items = group.items.filter(i => i.category === cat);
        if (!items.length) return '';
        return `
            <div class="pn-section">
                <h4 class="pn-section-title">${catIcons[cat]} ${cat.toUpperCase()}</h4>
                ${items.map(item => `
                    <div class="pn-item">
                        <div class="pn-item-text">${formatPatchSummary(item.summary)}</div>
                    </div>`).join('')}
            </div>`;
    }).join('');
    return `
        <div class="pn-release-card">
            <div class="pn-release-card-header">
                <div class="pn-header-left">
                    <span class="pn-version">${versionLabel}</span>
                    ${isLatest ? '<span class="pn-latest-badge">Latest</span>' : ''}
                </div>
                <span class="pn-date">${formatPatchDate(group.date)}</span>
            </div>
            <div class="pn-release-card-body">${sections}</div>
        </div>`;
}

async function loadPatchNotes() {
    const listEl = document.getElementById('patchNotesList');
    if (listEl) listEl.innerHTML = '<div class="pn-loading">Loading patch notes...</div>';

    try {
        const response = await fetch(`${PATCH_NOTES_URL}?v=${Date.now()}`);
        const data = await response.json();
        renderPatchNotes(data);
    } catch (e) {
        if (listEl) listEl.innerHTML = '<div class="pn-loading">Failed to load patch notes.</div>';
    }
}

function renderPatchNotes(data) {
    const listEl = document.getElementById('patchNotesList');
    if (!listEl) return;

    const { entries } = data;
    if (!entries || !entries.length) {
        listEl.innerHTML = '<div class="pn-loading">No patch notes available.</div>';
        return;
    }

    const sorted = buildPatchGroups(entries);
    listEl.innerHTML = sorted.map((g, i) => buildPatchCardHTML(g, i === 0)).join('');

    // User is now viewing the patch notes — mark latest version as seen
    if (sorted.length > 0) {
        _latestPatchKey = sorted[0].title + '|' + sorted[0].date;
        const currentUser = sessionStorage.getItem('speeksUserName');
        const cleanUser   = currentUser ? String(currentUser).trim().toLowerCase() : null;
        if (cleanUser) {
            localStorage.setItem('speeksPatchNotesSeen_'   + cleanUser, _latestPatchKey);
            localStorage.removeItem('speeksUnseenPatchNotes_' + cleanUser);
            // Persist read state server-side so it survives browser data clearing
            fetch(PATCH_NOTES_URL, {
                method: 'POST',
                body: JSON.stringify({ action: 'markPatchRead', user: cleanUser, lastSeenKey: _latestPatchKey })
            }).catch(() => {});
        }
        const pnBadge = document.getElementById('patchNotesBadge');
        if (pnBadge) { pnBadge.style.display = 'none'; pnBadge.classList.remove('active'); }
        updateMainBadge();
    }
}

function togglePatchNotes() {
    const modal = document.getElementById('notifDropdown');
    if (!modal) return;
    const isOpen = modal.classList.contains('show');
    closeAllModals();
    if (!isOpen) {
        modal.classList.add('show');
        lockAndBlurScreen();
        switchAnnTab('patchnotes');
    }
}

// --- PATCH NOTES MANAGE ---
function switchPNManageTab(tab) {
    const isAdd = tab === 'add';
    document.getElementById('pnManageAdd').style.display   = isAdd  ? '' : 'none';
    document.getElementById('pnManageEdit').style.display  = isAdd  ? 'none' : '';
    document.getElementById('pnActionsBar').style.display  = isAdd  ? '' : 'none';
    document.getElementById('pnmTab-add').classList.toggle('active',  isAdd);
    document.getElementById('pnmTab-edit').classList.toggle('active', !isAdd);
    if (!isAdd) loadPatchNotesEditor();
}

function togglePatchNotesManage() {
    const modal = document.getElementById('patchNotesManageModal');
    if (!modal) return;
    const isOpen = modal.classList.contains('show');
    closeAllModals();
    if (!isOpen) {
        modal.classList.add('show');
        lockAndBlurScreen();
        switchPNManageTab('add');
        const list = document.getElementById('pnItemsList');
        if (list) { list.innerHTML = ''; addPatchItem(); }
    }
}

function addPatchItem() {
    const list = document.getElementById('pnItemsList');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'pn-item-row';
    row.innerHTML = `
        <div class="pn-item-row-top">
            <select class="form-input-lg pn-item-category">
                <option value="">— Select a category —</option>
                <option value="New Features">✨ New Features</option>
                <option value="Improvements">🚀 Improvements</option>
                <option value="Bug Fixes">🔧 Bug Fixes</option>
            </select>
            <button class="pn-remove-btn" onclick="removePatchItem(this)" title="Remove">✖</button>
        </div>
        <textarea class="form-input-lg pn-textarea pn-item-summary" placeholder="Describe what changed... (start lines with - for bullet points)"></textarea>`;
    list.appendChild(row);
}

function removePatchItem(btn) {
    const list = document.getElementById('pnItemsList');
    if (list && list.querySelectorAll('.pn-item-row').length > 1) btn.closest('.pn-item-row').remove();
}

async function savePatchEntry() {
    const title   = document.getElementById('pnEntryTitle').value.trim();
    const dateRaw = document.getElementById('pnEntryDate').value;
    const status  = document.getElementById('pnEntrySaveStatus');
    const btn     = document.getElementById('pnSaveEntryBtn');

    if (!title || !dateRaw) { status.textContent = 'Version title and date are required.'; status.className = 'pn-save-status pn-save-error'; return; }

    const rows = document.querySelectorAll('.pn-item-row');
    const items = [];
    let allValid = true;
    rows.forEach(row => {
        const category = row.querySelector('.pn-item-category').value;
        const summary  = row.querySelector('.pn-item-summary').value.trim();
        if (!category || !summary) { allValid = false; return; }
        items.push({ category, summary });
    });

    if (!allValid || !items.length) { status.textContent = 'Each item needs a category and summary.'; status.className = 'pn-save-status pn-save-error'; return; }

    const [y, m, d] = dateRaw.split('-');
    const date = `${m}/${d}/${y}`;

    btn.disabled = true;
    status.textContent = 'Saving...';
    status.className = 'pn-save-status';

    try {
        await fetch(PATCH_NOTES_URL, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'addEntries', title, date, items })
        });
        status.textContent = `${items.length} item${items.length !== 1 ? 's' : ''} saved!`;
        status.className = 'pn-save-status pn-save-ok';
        document.getElementById('pnEntryTitle').value = '';
        document.getElementById('pnEntryDate').value  = '';
        document.getElementById('pnItemsList').innerHTML = '';
        addPatchItem();
    } catch (e) {
        status.textContent = 'Save failed.';
        status.className = 'pn-save-status pn-save-error';
    }
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 4000);
}

// --- PATCH NOTES EDITOR ---
async function loadPatchNotesEditor() {
    const list = document.getElementById('pnEditList');
    if (!list) return;
    list.innerHTML = '<div class="pn-loading">Loading...</div>';
    try {
        const response = await fetch(`${PATCH_NOTES_URL}?v=${Date.now()}`);
        const data = await response.json();
        renderPatchNotesEditor(data);
    } catch (e) {
        list.innerHTML = '<div class="pn-loading">Failed to load.</div>';
    }
}

function renderPatchNotesEditor(data) {
    const list = document.getElementById('pnEditList');
    if (!list) return;
    const { entries } = data;
    if (!entries || !entries.length) { list.innerHTML = '<div class="pn-loading">No patch notes to edit.</div>'; return; }

    const sorted = buildPatchGroups(entries);
    const catBadge = { 'New Features': 'pn-badge-new', 'Improvements': 'pn-badge-improved', 'Bug Fixes': 'pn-badge-fixed' };

    list.innerHTML = sorted.map(group => {
        const vLabel = group.title;
        return `
            <div class="pne-group">
                <div class="pne-group-header">
                    <span class="pne-group-title">${vLabel}</span>
                    <span class="pne-group-date">${formatPatchDate(group.date)}</span>
                </div>
                ${group.items.map(item => `
                    <div class="pne-item" id="pne-item-${item.rowNum}"
                         data-rownum="${item.rowNum}"
                         data-category="${item.category}"
                         data-summary="${item.summary.replace(/"/g, '&quot;').replace(/\n/g, '&#10;')}"
                         data-title="${group.title}"
                         data-date="${group.date}">
                        <div class="pne-item-view">
                            <span class="pn-badge ${catBadge[item.category] || ''}">${item.category}</span>
                            <span class="pne-item-summary">${item.summary.replace(/\n/g, ' ')}</span>
                            <div class="pne-item-actions">
                                <button class="pne-btn" onclick="startEditPatchItem(${item.rowNum})">Edit</button>
                                <button class="pne-btn pne-btn-delete" onclick="promptDeletePatchItem(${item.rowNum})">Delete</button>
                            </div>
                        </div>
                    </div>`).join('')}
            </div>`;
    }).join('');
}

function startEditPatchItem(rowNum) {
    const el = document.getElementById(`pne-item-${rowNum}`);
    if (!el) return;
    const { category, summary } = el.dataset;
    const decodedSummary = summary.replace(/&#10;/g, '\n');
    const viewDiv = el.querySelector('.pne-item-view');
    if (viewDiv) viewDiv.style.display = 'none';

    const editDiv = document.createElement('div');
    editDiv.className = 'pne-item-edit';
    editDiv.innerHTML = `
        <select class="form-input-lg pne-edit-cat">
            <option value="New Features" ${category === 'New Features' ? 'selected' : ''}>✨ New Features</option>
            <option value="Improvements" ${category === 'Improvements' ? 'selected' : ''}>🚀 Improvements</option>
            <option value="Bug Fixes"    ${category === 'Bug Fixes'    ? 'selected' : ''}>🔧 Bug Fixes</option>
        </select>
        <textarea class="form-input-lg pn-textarea pne-edit-sum">${decodedSummary}</textarea>
        <div class="pne-edit-actions">
            <button class="btn-primary" onclick="saveEditPatchItem(${rowNum})">Save Changes</button>
            <button class="pne-btn" onclick="cancelEditPatchItem(${rowNum})">Cancel</button>
        </div>`;
    el.appendChild(editDiv);
}

function cancelEditPatchItem(rowNum) {
    const el = document.getElementById(`pne-item-${rowNum}`);
    if (!el) return;
    const viewDiv = el.querySelector('.pne-item-view');
    const editDiv = el.querySelector('.pne-item-edit');
    if (viewDiv) viewDiv.style.display = '';
    if (editDiv) editDiv.remove();
}

async function saveEditPatchItem(rowNum) {
    const el       = document.getElementById(`pne-item-${rowNum}`);
    if (!el) return;
    const category = el.querySelector('.pne-edit-cat').value;
    const summary  = el.querySelector('.pne-edit-sum').value.trim();
    const { title, date } = el.dataset;
    if (!category || !summary) return;

    const saveBtn = el.querySelector('.btn-primary');
    if (saveBtn) saveBtn.textContent = 'Saving...';
    if (saveBtn) saveBtn.disabled = true;

    try {
        await fetch(PATCH_NOTES_URL, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'editEntry', rowNum, title, date, category, summary })
        });
        loadPatchNotesEditor();
    } catch (e) {
        if (saveBtn) { saveBtn.textContent = 'Save Changes'; saveBtn.disabled = false; }
    }
}

function promptDeletePatchItem(rowNum) {
    const el = document.getElementById(`pne-item-${rowNum}`);
    if (!el) return;
    const actions = el.querySelector('.pne-item-actions');
    if (!actions) return;
    actions.innerHTML = `
        <span class="pne-confirm-label">Delete this item?</span>
        <button class="pne-btn pne-btn-confirm-delete" onclick="confirmDeletePatchItem(${rowNum})">Yes, Delete</button>
        <button class="pne-btn" onclick="loadPatchNotesEditor()">Cancel</button>`;
}

async function confirmDeletePatchItem(rowNum) {
    const btn = document.querySelector(`#pne-item-${rowNum} .pne-btn-confirm-delete`);
    if (btn) { btn.textContent = 'Deleting...'; btn.disabled = true; }
    try {
        await fetch(PATCH_NOTES_URL, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'deleteEntry', rowNum })
        });
    } catch (e) { /* no-cors always throws, reload regardless */ }
    loadPatchNotesEditor();
}
