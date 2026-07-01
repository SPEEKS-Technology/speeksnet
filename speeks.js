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
const _SUPABASE_URL = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co';
const _SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqemFxbXl4eHJrbXh2emJqZXVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwNzA2NjAsImV4cCI6MjA5NDY0NjY2MH0.-SrbSaF-n8WkNW6tieDiA2FhGHB7qP4b6XrEyy2JF74';
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
const STORE_TARGETS_URL = `${_BASE}/store-targets`;
const SCORECARD_URL     = `${_BASE}/scorecard`;
const EBAY_ALERTS_URL   = `${_BASE}/ebay-alerts`;
const STORE_COMMENT_URL = `${_BASE}/store-comments`;
const CHECKLIST_URL     = `${_BASE}/checklist`;
const STORE_AUDIT_URL   = `${_BASE}/store-audit`;
const CLAIMS_URL        = `${_BASE}/shopify-claims`;
const PATCH_NOTES_URL   = `${_BASE}/patch-notes`;
const TICKER_URL        = `${_BASE}/ticker`;
const KPI_MANAGE_URL    = `${_BASE}/kpi-manage`;
const MONTHLY_BRIEF_URL = `${_BASE}/monthly-brief`;
const B2B_URL           = `${_BASE}/b2b-deals`;
const BOX_ITEMS_URL     = `${_SUPABASE_URL}/rest/v1/box_order_items?select=*&order=sort_order.asc`;
const BOX_CONFIG_URL    = `${_SUPABASE_URL}/rest/v1/box_order_config?select=*`;

// --- WRITE HELPER ---
// POST JSON to an edge function as a "simple" request: keeping Content-Type
// text/plain avoids a CORS preflight, and dropping mode:'no-cors' means the
// response is READABLE — so a failed write is detected instead of silently
// reported as success. Throws on HTTP error or an {error}/{success:false} body.
async function postWrite(url, payload) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty/non-JSON body */ }
    if (!res.ok || data.success === false || data.error) {
        throw new Error(data.error || `Request failed (HTTP ${res.status})`);
    }
    return data;
}

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

let _annDocsCache = [];

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

            _annDocsCache = (data.announcements || []).filter(a => a.docUrl).reverse();

            // New hires only see announcements from their onboarding day onward in the
            // recent feed; anything older is auto-archived. Cutoff = start of that day.
            // Blank (pre-existing users) means no filtering — they behave as before.
            let onboardCutoff = null;
            const onboardedRaw = sessionStorage.getItem('speeksUserOnboardedAt');
            if (onboardedRaw) {
                const od = new Date(onboardedRaw);
                if (!isNaN(od.getTime())) {
                    onboardCutoff = new Date(od.getFullYear(), od.getMonth(), od.getDate());
                }
            }

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
                        // Auto-archive anything posted before this user joined, so a new
                        // hire isn't flooded with the whole backlog (archive still shows it).
                        if (!isArchived && onboardCutoff && item.date) {
                            const aDate = new Date(item.date);
                            if (!isNaN(aDate.getTime()) && aDate < onboardCutoff) {
                                isArchived = true;
                            }
                        }
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
                        <button class="mark-read-btn" onclick="markAnnouncementRead('${annId}')">
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

                    const docLinkHtml = item.docUrl ? `
                        <a href="${item.docUrl}" target="_blank" rel="noopener" class="ann-doc-link">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                            ${item.docName || 'Attached Document'}
                        </a>` : '';

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
                            ${docLinkHtml}
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

    postWrite(CMS_URL, { type: 'mark_read', user: userName, rowIds: [rowId] })
        .catch(err => console.warn('mark_read failed:', err.message));

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
    if (annC) { annC.style.display = isRecent ? 'block' : 'none'; annC.classList.remove('hidden'); }

    const archC = document.getElementById('archive-container');
    if (archC) { archC.style.display = isArchive ? 'block' : 'none'; archC.classList.remove('hidden'); }

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

function openDocsModal() {
    closeAllModals();
    const modal = document.getElementById('annDocsModal');
    if (!modal) return;
    modal.classList.add('show');
    lockAndBlurScreen();
    loadAnnouncementDocs();
}

function loadAnnouncementDocs() {
    const list = document.getElementById('annDocsList');
    if (!list) return;
    if (!_annDocsCache.length) {
        list.innerHTML = '<div style="padding:30px;text-align:center;color:#999;font-size:14px;">No documents have been attached to announcements yet.</div>';
        return;
    }
    list.innerHTML = _annDocsCache.map(item => {
        const date = item.date ? new Date(item.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
        const ext = (item.docName || '').split('.').pop().toUpperCase();
        const extColors = { PDF: '#ef4444', DOC: '#3b82f6', DOCX: '#3b82f6', XLS: '#22c55e', XLSX: '#22c55e' };
        const badgeColor = extColors[ext] || '#64748b';
        return `
            <div class="ann-doc-card">
                <div class="ann-doc-badge" style="background:${badgeColor};">${ext || 'FILE'}</div>
                <div class="ann-doc-card-info">
                    <div class="ann-doc-card-name">${item.docName || 'Attached Document'}</div>
                    <div class="ann-doc-card-meta">${item.author || ''}${date ? ` · ${date}` : ''}</div>
                </div>
                <a href="${item.docUrl}" target="_blank" rel="noopener" class="ann-doc-dl-btn">⬇ Download</a>
            </div>`;
    }).join('');
}

// SPEEKS TOOLS PANEL
window.toggleToolsPanel = function(e) {
    if (e) e.stopPropagation();
    const panel = document.getElementById('toolsSidePanel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    const btn = document.getElementById('toolsNavBtn');
    if (btn) btn.classList.toggle('panel-open', isOpen);
    if (isOpen) {
        document.getElementById('checklistSidePanel')?.classList.remove('open');
        document.querySelector('.cl-nav-toggle')?.classList.remove('panel-active');
        document.getElementById('goalsSidePanel')?.classList.remove('open');
        document.querySelector('.gi-nav-toggle')?.classList.remove('panel-active');
    }
};

function _closeToolsPanel() {
    const panel = document.getElementById('toolsSidePanel');
    if (panel) panel.classList.remove('open');
    const btn = document.getElementById('toolsNavBtn');
    if (btn) btn.classList.remove('panel-open');
}

document.addEventListener('click', (e) => {
    const panel = document.getElementById('toolsSidePanel');
    const btn = document.getElementById('toolsNavBtn');
    if (panel && panel.classList.contains('open') && !panel.contains(e.target) && !btn?.contains(e.target)) {
        panel.classList.remove('open');
        btn?.classList.remove('panel-open');
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

    // Fire ONE single request to the database. Optimistic UI above is reconciled
    // by pollReactions() every 15s, so on failure we just log rather than alert.
    postWrite(CMS_URL, payload)
        .catch(err => console.warn('reaction save failed:', err.message));
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
        await postWrite(TICKER_URL, { items });
        _tickerStatic = items.length ? items.map(item => ({ icon: item.icon, text: item.text, _type: 'static' })) : [..._TICKER_DEFAULTS];
        if (_tickerShown) _applyTickerContent();
        closeAllModals();
    } catch (e) {
        alert('Failed to save ticker items: ' + (e.message || e));
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
    const roles = ['CEO', 'District Manager', 'Owner (Manager)', 'Manager', 'Multi-Store Manager', 'Assistant Manager', 'Employee', 'Training', 'TOM'];

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

            let _loginRole = matched.role ? matched.role.toLowerCase() : 'employee';
            let _loginStore = matched.store ? matched.store.toUpperCase() : 'ALL';
            // A Multi-Store Manager behaves EXACTLY like a store manager everywhere — so we
            // store their effective role as 'manager' (covers every role check, current and
            // future) and flag the multi-store capability separately to drive the store
            // switcher. Default to their first managed store.
            if (_loginRole === 'multi-store manager') {
                sessionStorage.setItem('speeksMultiStore', 'true');
                _loginRole = 'manager';
                _loginStore = MULTISTORE_MANAGER_STORES[0];
            } else {
                sessionStorage.removeItem('speeksMultiStore');
            }
            sessionStorage.setItem('speeksUserRole', _loginRole);
            sessionStorage.setItem('speeksUserStore', _loginStore);
            sessionStorage.setItem('speeksUserPin', matched.pin);
            // New-hire announcement baseline: blank for pre-existing users (no filtering).
            sessionStorage.setItem('speeksUserOnboardedAt', matched.onboarded_at || '');

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
            userInStore(u, store) &&
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

// Performance highlighting: returns 'kpi-cell-green', 'kpi-cell-red', or '' for a
// metric value against fixed targets. `listed_count` only grades on the Store Total row.
function _kpiThresholdCls(key, val, isStoreTotal) {
    if (val == null || val === '' || isNaN(Number(val))) return '';
    const v = Number(val);
    switch (key) {
        case 'gross_margin_pct':
            if (v >= 54) return 'kpi-cell-green';
            if (v <= 50) return 'kpi-cell-red';
            return '';
        case 'customer_conversion_pct':
        case 'device_conversion_pct':
            if (v >= 87) return 'kpi-cell-green';
            if (v <= 83) return 'kpi-cell-red';
            return '';
        case 'avg_transaction_time':
            if (v <= 12) return 'kpi-cell-green';
            if (v >= 17) return 'kpi-cell-red';
            return '';
        case 'no_deal_count':
            if (v <= 8)  return 'kpi-cell-green';
            if (v >= 10) return 'kpi-cell-red';
            return '';
        case 'listed_count':
            if (!isStoreTotal) return '';
            if (v >= 200) return 'kpi-cell-green';
            if (v <= 160) return 'kpi-cell-red';
            return '';
        default:
            return '';
    }
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
function _kpiColgroupHtml() {
    return '<colgroup>' +
        '<col class="col-name">' +
        '<col span="2" class="col-buying-input"><col span="2" class="col-computed">' +
        '<col span="2" class="col-buying-input"><col class="col-computed">' +
        '<col span="2" class="col-buying-input"><col class="col-computed">' +
        '<col class="col-buying-input">' +
        '<col span="3" class="col-nd-input"><col span="2" class="col-computed">' +
        '<col span="4" class="col-listing-input"><col span="2" class="col-computed">' +
        '<col class="col-review-input">' +
        '</colgroup>';
}

// The two-row column header block. Repeated inside each weekly/monthly section
// (right under the period divider) so the columns are always labeled as you
// scroll, instead of a single header at the top of the table.
function _kpiHeaderRowsHtml() {
    return '<tr class="kpi-grid-header-row">' +
        '<th rowspan="2" class="kpi-grid-th kpi-grid-name-col">Employee</th>' +
        '<th colspan="11" class="kpi-grid-section-header kpi-section-buying">Buying</th>' +
        '<th colspan="5"  class="kpi-grid-section-header kpi-section-nodeals">No Deals</th>' +
        '<th colspan="6"  class="kpi-grid-section-header kpi-section-listings">Listings</th>' +
        '<th colspan="1"  class="kpi-grid-section-header kpi-section-reviews">Reviews</th>' +
        '</tr><tr class="kpi-grid-header-row">' +
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
        '</tr>';
}

function _kpiSectionDividerHtml(label, badge, badgeClass, controls, borderColor) {
    const bdg = badge ? '<span class="kpi-section-badge ' + badgeClass + '">' + badge + '</span>' : '';
    return '<tr class="kpi-section-divider-row"><td colspan="24"><div class="kpi-section-header-inner" style="border-left:4px solid ' + borderColor + ';">' +
        '<div class="align-center gap-8"><span class="kpi-section-label">' + label + '</span>' + bdg + '</div>' +
        '<div class="align-center gap-8">' + controls + '</div>' +
        '</div></td></tr>';
}

function _kpiSectionControls(periodDate, isEditing, isEditable) {
    if (isEditing) return '<span class="kpi-editing-label">✏️ Editing</span>';
    return '';
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
            const tc = _kpiThresholdCls(f.key, entry[f.key], false);
            if (f.computed || isAvg) {
                cells += '<td class="kpi-grid-computed' + (isAvg ? ' kpi-avg-cell' : '') + (tc ? ' ' + tc : '') + '" id="kpiC-' + pk + '-' + empIdx + '-' + f.key + '">' + _kpiFormatComputed(f.key, entry[f.key]) + '</td>';
            } else if (!isEditing) {
                // View mode: formatted text — money columns show $, all centered.
                cells += '<td class="kpi-grid-computed kpi-grid-view-val' + (tc ? ' ' + tc : '') + '">' + _kpiFormatComputed(f.key, entry[f.key]) + '</td>';
            } else {
                const val = entry[f.key] != null ? entry[f.key] : '';
                cells += '<td class="kpi-grid-td-input"><input class="kpi-grid-input' + (tc ? ' ' + tc : '') + '" type="number" step="' + f.step + '" min="0" id="kpi-' + pk + '-' + empIdx + '-' + f.key + '" value="' + val + '" oninput="_kpiUpdateRow(\'' + pk + '\',' + empIdx + ')"></td>';
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
        if (el) {
            el.textContent = _kpiFormatComputed(key, computed[key]);
            const tc = _kpiThresholdCls(key, computed[key], false);
            el.className = 'kpi-grid-computed' + (tc ? ' ' + tc : '');
        }
    });
    // Re-grade the directly-entered metrics that carry highlighting (time, no deals)
    ['avg_transaction_time', 'no_deal_count'].forEach(function(key) {
        const el = document.getElementById('kpi-' + pk + '-' + empIdx + '-' + key);
        if (el) {
            const tc = _kpiThresholdCls(key, el.value, false);
            el.className = 'kpi-grid-input' + (tc ? ' ' + tc : '');
        }
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
        const tc = _kpiThresholdCls(f.key, computed[f.key], true);
        cells += '<td class="kpi-grid-computed kpi-total-cell' + (tc ? ' ' + tc : '') + '">' + _kpiFormatComputed(f.key, computed[f.key]) + '</td>';
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
    const _modalSel = document.getElementById('kpiModalStoreSelect');
    const store = (_modalSel && _modalSel.offsetParent !== null && _modalSel.value) || sessionStorage.getItem('speeksUserStore') || '';
    const sub = document.getElementById('kpiModalSubtitle');
    if (sub) sub.textContent = store + ' · 4-Week View';

    // Always show the current (editable) week plus any past weeks with saved data.
    // Rendering it even in view mode means clicking Edit just swaps its cells from
    // text to inputs IN PLACE — no new section appears, so nothing on the page shifts.
    let visible = (periods || []).filter(function(p) { return p.is_editable || p.entries.some(function(e) { return e.id; }); });
    if (_kpiEditingPeriod) {
        const ep = periods.find(function(p) { return p.period_end_date === _kpiEditingPeriod; });
        if (ep && !visible.find(function(p) { return p.period_end_date === ep.period_end_date; })) visible.unshift(ep);
        else if (ep) { visible = visible.filter(function(p) { return p.period_end_date !== ep.period_end_date; }); visible.unshift(ep); }
    }

    _kpiSyncHeaderBtns();
    if (!visible.length) {
        body.innerHTML = '<div class="kpi-empty-state">No weekly KPI data yet. Click ✏️ Edit above to enter the current week.</div>';
        return;
    }
    const wkBadges = ['Current Week','Last Week','2 Weeks Ago','3 Weeks Ago'];
    const wkBClass = ['badge-current','badge-prev','badge-old','badge-old'];
    let tbody = '';
    visible.forEach(function(p, i) {
        const isEd = _kpiEditingPeriod === p.period_end_date;
        tbody += _kpiSectionDividerHtml('📅 ' + _kpiWeekRangeLabel(p.period_end_date), wkBadges[i] || '', wkBClass[i] || 'badge-old',
            _kpiSectionControls(p.period_end_date, isEd, p.is_editable), '#3b82f6');
        tbody += _kpiHeaderRowsHtml();
        tbody += _kpiEmpRowsHtml(p.entries, p.period_end_date, isEd, false);
        const hasSavedData = p.entries.some(function(e) { return e.id; });
        if (hasSavedData) tbody += _kpiStoreTotalRowHtml(p.entries);
    });
    body.innerHTML = '<div class="kpi-grid-scroll-wrapper"><table class="kpi-entry-grid kpi-full-table">' + _kpiColgroupHtml() + '<tbody>' + tbody + '</tbody></table></div>';
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
let _mbView = null;          // 'overview' | 'store' (decided by role on first load)
let _mbOverviewData = {};    // { store: { period_end_date: { metric_key: value } } }
let _mbOverviewMonth = '';   // month shown in the overview (the editable/current one when open)
let _mbOverviewEditable = ''; // editable period_end_date (same across stores)

function _mbMonthLabel(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// Compact column header, e.g. "Apr '26"
function _mbMonthLabelShort(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleString('en-US', { month: 'short' }) + " '" + String(d.getFullYear()).slice(-2);
}

const MB_MONTH_WINDOW = 6; // how many recent months to show across the brief

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

// Metrics that never get good/bad coloring — month-over-month or cross-store
// comparison isn't meaningful for them (running totals / external rankings).
const _MB_NO_SHADE = new Set(['google_score', 'google_reviews', 'paymore_ranking']);

// Derived metrics, replicating the Monthly KPI spreadsheet's cell formulas.
// These are auto-calculated from the manually entered fields (and locked in edit
// mode). Percent metrics are stored as percent numbers (58.54), not fractions.
// Order matters: pct_non_ebay_sales uses the three channel percentages above it.
const _mbR2  = n => Math.round(n * 100) / 100;
const _mbPctOf = (num, den) => (num != null && den > 0) ? _mbR2(num / den * 100) : null;
const _MB_DERIVED = [
    ['buy_value_per_customer', v => (v.buying != null && v.num_customers > 0 && v.customer_close_rate > 0)
        ? _mbR2(v.buying / (v.num_customers * v.customer_close_rate / 100)) : null],
    ['pct_returning_customers', v => _mbPctOf(v.returning_customers, v.num_customers)],
    ['pct_inventory_over_30',   v => _mbPctOf(v.inventory_cost_under_30, v.inventory_cost)],
    ['return_rate',             v => _mbPctOf(v.refunds, v.gross_sales)],
    ['gross_profit',            v => (v.net_sales != null && v.cogs != null) ? _mbR2(v.net_sales - v.cogs) : null],
    ['gross_profit_pct',        v => (v.net_sales > 0 && v.cogs != null) ? _mbR2((1 - v.cogs / v.net_sales) * 100) : null],
    ['cogs_sold_vs_listed',     v => _mbPctOf(v.cogs, v.inventory_cost)],
    ['pct_sales_at_pos',        v => _mbPctOf(v.sales_at_pos, v.net_sales)],
    ['pct_sales_online',        v => _mbPctOf(v.sales_online, v.net_sales)],
    ['pct_sales_draft_order',   v => _mbPctOf(v.sale_draft_order, v.net_sales)],
    ['pct_non_ebay_sales',      v => (v.pct_sales_at_pos != null && v.pct_sales_online != null && v.pct_sales_draft_order != null)
        ? _mbR2(v.pct_sales_at_pos + v.pct_sales_online + v.pct_sales_draft_order) : null],
    ['shipping_cost_pct_sales', v => _mbPctOf(v.shipping_label_cost, v.net_sales)],
    ['recycled_pct_inventory',  v => _mbPctOf(v.recycled_inventory, v.inventory_cost)],
];
const _MB_DERIVED_KEYS = new Set(_MB_DERIVED.map(d => d[0]));

// Fills the derived keys of a values object in place (null when inputs incomplete).
function _mbApplyDerived(values) {
    _MB_DERIVED.forEach(([key, fn]) => {
        const x = fn(values);
        values[key] = (x == null || !isFinite(x)) ? null : x;
    });
    return values;
}

// Live recompute while typing in edit mode: reads every metric input with the
// given id prefix, derives, and writes results back into the locked inputs.
function _mbLiveDerive(prefix) {
    const values = {};
    _mbMetrics.forEach(m => {
        const el = document.getElementById(prefix + m.key);
        if (el) values[m.key] = el.value === '' ? null : Number(el.value);
    });
    _mbApplyDerived(values);
    _MB_DERIVED_KEYS.forEach(key => {
        const el = document.getElementById(prefix + key);
        if (el) el.value = values[key] != null ? values[key] : '';
    });
}

// Unsigned magnitude of a change, formatted by type (direction shown via arrow).
function _mbDeltaMag(type, diff) {
    const a = Math.abs(diff);
    if (type === 'money')  return '$' + Math.round(a).toLocaleString();
    if (type === 'pct')    return a.toFixed(1) + ' pts';
    if (type === 'rating') return a.toFixed(1);
    if (type === 'int')    return Math.round(a).toLocaleString();
    return String(Math.round(a * 10) / 10);
}

const MB_STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const MB_STORE_DOT = { OVL: '🟣', LEE: '🔵', WSP: '🟢', MPL: '🟠', BAL: '🔴' };

function _mbDefaultView() {
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    return (role === 'ceo' || role === 'district manager') ? 'overview' : 'store';
}

// Reflect the active view in the controls: highlight the toggle, and only show
// the store picker in Store View (and only for CEO/DM — Overview spans all stores).
function _mbSyncControls() {
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const canPickStore = (role === 'ceo' || role === 'district manager');
    document.getElementById('mbViewOverviewBtn')?.classList.toggle('active', _mbView === 'overview');
    document.getElementById('mbViewStoreBtn')?.classList.toggle('active', _mbView === 'store');
    const sel = document.getElementById('mbStoreSelect');
    if (sel) sel.style.display = (_mbView === 'store' && canPickStore) ? '' : 'none';
    const sub = document.getElementById('mbSubtitle');
    if (sub) {
        const store = (sel && canPickStore ? sel.value : null) || sessionStorage.getItem('speeksUserStore') || '';
        sub.textContent = _mbView === 'overview' ? 'All Stores' : (store + ' · Store View');
    }
}

function mbSetView(view) {
    if (_mbView === view) return;
    _mbView = view;
    _mbEditing = false;
    fetchMonthlyBrief();
}

// Dispatcher — loads + renders the data for whichever view is active.
function fetchMonthlyBrief() {
    if (_mbView === null) _mbView = _mbDefaultView();
    _mbSyncControls();
    return (_mbView === 'overview') ? fetchMonthlyBriefOverview() : fetchMonthlyBriefStore();
}

// OVERVIEW (CEO/DM): the most-recent month for every store, side by side.
async function fetchMonthlyBriefOverview() {
    const body = document.getElementById('mbBody');
    if (!body) return;
    _mbEditing = false;
    body.innerHTML = '<div class="status-message">Syncing Performance Brief…</div>';
    // allSettled so one store being unreachable doesn't blank the whole overview
    const settled = await Promise.allSettled(MB_STORES.map(s =>
        fetch(`${MONTHLY_BRIEF_URL}?store=${s}&v=${Date.now()}`).then(r => r.json()).then(d => ({ s, d }))
    ));
    _mbOverviewData = {};
    const dataMonths = new Set();
    let editable = '';
    let anyOk = false;
    settled.forEach(res => {
        if (res.status !== 'fulfilled') return;
        anyOk = true;
        const { s, d } = res.value;
        const data = d.data || {};
        _mbOverviewData[s] = data;
        // only count months that actually carry values (the API lists the open
        // edit window in `months` even before any numbers are entered for it)
        Object.keys(data).forEach(mo => { if (data[mo] && Object.keys(data[mo]).length) dataMonths.add(mo); });
        if ((d.metrics || []).length) _mbMetrics = d.metrics;
        if (d.editable_period) editable = d.editable_period;
    });
    if (!anyOk) {
        body.innerHTML = '<div class="status-message" style="color:var(--red-alert)">Failed to load overview.</div>';
        return;
    }
    _mbOverviewEditable = editable;
    // Display the most recent month that has data (useful for everyone); editing
    // switches to the open edit window, which may still be awaiting entry.
    _mbOverviewMonth = [...dataMonths].sort().reverse()[0] || editable || '';
    renderMonthlyBrief();
}

// STORE VIEW: 5-month history for a single store.
async function fetchMonthlyBriefStore() {
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
        renderMonthlyBrief();
    } catch (e) {
        body.innerHTML = '<div class="status-message" style="color:var(--red-alert)">Failed to load brief.</div>';
    }
}

function renderMonthlyBrief() {
    _mbSyncControls();
    if (_mbView === 'overview') return _mbRenderOverview();
    return _mbRenderStore();
}

function _mbRenderStore() {
    const body = document.getElementById('mbBody');
    if (!body) return;

    // Newest-first window of up to 5 months. Only include the editable month
    // when actively editing — it stays hidden until the user clicks Edit.
    const monthSet = new Set(_mbMonths);
    if (_mbEditable && _mbEditing) monthSet.add(_mbEditable);
    const months = [...monthSet].sort().reverse().slice(0, MB_MONTH_WINDOW)
        .filter(mo => {
            if (_mbEditing && mo === _mbEditable) return true;
            const d = _mbData[mo] || {};
            return Object.values(d).some(v => v != null);
        });
    if (!months.length) { body.innerHTML = '<div class="status-message">No data available.</div>'; return; }

    // Edit for DM, CEO, and owner-manager on the editable (current) month
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const isDM = role === 'district manager';
    const canEdit = (isDM || role === 'ceo' || role === 'owner manager') && !!_mbEditable && months.includes(_mbEditable);
    const editBtn = document.getElementById('mbEditBtn');
    if (editBtn) editBtn.style.display = (canEdit && !_mbEditing) ? 'inline-block' : 'none';
    const saveBtn = document.getElementById('mbSaveBtn');
    const cancelBtn = document.getElementById('mbCancelBtn');
    if (saveBtn)   saveBtn.style.display   = (_mbEditing) ? 'inline-block' : 'none';
    if (cancelBtn) cancelBtn.style.display = (_mbEditing) ? 'inline-block' : 'none';

    const totalCols = 1 + months.length + (months.length - 1); // metric + months + deltas between

    // Header: Metric | newest | Δ | prev | Δ | prev | …  (newest on the left)
    let head = '<th class="mb-th-metric">Metric</th>';
    months.forEach((mo, i) => {
        const isEditCol = (mo === _mbEditable);
        head += '<th class="mb-th-val' + (isEditCol ? ' mb-th-current' : '') + '">' + _mbMonthLabelShort(mo) + '</th>';
        if (i < months.length - 1) head += '<th class="mb-th-delta">Δ</th>';
    });

    // Group metrics by section (preserve catalog order)
    const sections = [];
    const bySection = {};
    _mbMetrics.forEach(m => {
        if (!bySection[m.section]) { bySection[m.section] = []; sections.push(m.section); }
        bySection[m.section].push(m);
    });

    let html = '<table class="mb-table"><thead><tr>' + head + '</tr></thead><tbody>';

    sections.forEach(sec => {
        html += '<tr class="mb-section-row"><td colspan="' + totalCols + '">' + sec + '</td></tr>';
        bySection[sec].forEach(m => {
            html += '<tr class="mb-row"><td class="mb-metric-name" title="' + m.label + '">' + m.label + '</td>';
            months.forEach((mo, i) => {
                const v = (_mbData[mo] || {})[m.key];
                // Value cell — editable month becomes an input in edit mode
                if (_mbEditing && canEdit && mo === _mbEditable) {
                    const step = (m.type === 'int') ? '1' : (m.type === 'rating' ? '0.1' : '0.01');
                    if (_MB_DERIVED_KEYS.has(m.key)) {
                        // spreadsheet-formula cell — locked, fills itself from the other inputs
                        html += '<td class="mb-val mb-val-primary"><input class="mb-input mb-input-auto" type="number" disabled ' +
                            'title="Auto-calculated" placeholder="auto" id="mb-in-' + m.key + '" value="' + (v != null ? v : '') + '"></td>';
                    } else {
                        html += '<td class="mb-val mb-val-primary"><input class="mb-input" type="number" step="' + step +
                            '" id="mb-in-' + m.key + '" value="' + (v != null ? v : '') + '" oninput="_mbLiveDerive(\'mb-in-\')"></td>';
                    }
                } else {
                    const ebayOverride = _mbEbayThresholdCls(m.key, v);
                    let cls;
                    if (ebayOverride !== null) {
                        // Clear eBay cells in the current month keep the primary column tint
                        cls = (ebayOverride === 'mb-val' && mo === _mbEditable) ? 'mb-val mb-val-primary' : ebayOverride;
                    } else {
                        cls = (mo === _mbEditable) ? 'mb-val mb-val-primary' : 'mb-val';
                    }
                    html += '<td class="' + cls + '">' + _mbFmt(m.type, v) + '</td>';
                }
                // Delta between this (newer, left) and the next (older, right) month.
                // diff = new − old so a positive value means it grew vs the prior month.
                if (i < months.length - 1) {
                    const older = (_mbData[months[i + 1]] || {})[m.key];
                    let chip = '<span class="mb-dash">—</span>';
                    if (v != null && older != null && !isNaN(v) && !isNaN(older)) {
                        const diff = Number(v) - Number(older);
                        if (diff === 0) {
                            chip = '<span class="mb-chip mb-chip-flat">0</span>';
                        } else if (_MB_NO_SHADE.has(m.key)) {
                            // direction only, no good/bad color
                            chip = '<span class="mb-chip mb-chip-flat">' +
                                (diff > 0 ? '▲' : '▼') + ' ' + _mbDeltaMag(m.type, diff) + '</span>';
                        } else {
                            // arrow = direction of change; color = good/bad for this metric
                            const good  = _MB_INVERSE.has(m.key) ? (diff < 0) : (diff > 0);
                            const arrow = diff > 0 ? '▲' : '▼';
                            chip = '<span class="mb-chip ' + (good ? 'mb-up' : 'mb-down') + '">' +
                                arrow + ' ' + _mbDeltaMag(m.type, diff) + '</span>';
                        }
                    }
                    html += '<td class="mb-delta">' + chip + '</td>';
                }
            });
            html += '</tr>';
        });
    });

    html += '</tbody></table>';
    body.innerHTML = html;
}

// Returns an override CSS class for eBay Health metrics based on absolute thresholds.
// Returns null for non-eBay-health metrics (fall through to best/worst logic).
function _mbEbayThresholdCls(key, val) {
    if (val == null) return null;
    const v = Number(val);
    if (isNaN(v)) return null;
    // Red fires at 80% of the way to the eBay limit (was 100%); warn at 50%.
    if (key === 'defect_rate') {
        if (v >= 0.40) return 'mb-val mb-ebay-bad';
        if (v >= 0.25) return 'mb-val mb-ebay-warn';
        return 'mb-val';
    }
    if (key === 'late_shipment_rate') {
        if (v >= 2.4) return 'mb-val mb-ebay-bad';
        if (v >= 1.5) return 'mb-val mb-ebay-warn';
        return 'mb-val';
    }
    if (key === 'case_no_resolution') {
        if (v >= 0.24) return 'mb-val mb-ebay-bad';
        if (v >= 0.15) return 'mb-val mb-ebay-warn';
        return 'mb-val';
    }
    if (key === 'tracking_uploaded') {
        if (v <= 96.0)  return 'mb-val mb-ebay-bad';
        if (v <= 97.5)  return 'mb-val mb-ebay-warn';
        return 'mb-val';
    }

    return null;
}

// OVERVIEW render: metrics × stores for the most-recent month, with the
// best store per metric flagged green and the worst red (honoring inverse metrics).
function _mbRenderOverview() {
    const body = document.getElementById('mbBody');
    if (!body) return;

    // DM and CEO can edit the current (editable) month across all stores from here
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const isDM = role === 'district manager';
    const canEdit = (isDM || role === 'ceo' || role === 'owner manager') && !!_mbOverviewEditable;
    const editing = _mbEditing && canEdit;
    // View the most recent month that has data; while editing, switch to the open window.
    const shownMonth = editing ? _mbOverviewEditable : _mbOverviewMonth;

    const editBtn = document.getElementById('mbEditBtn');
    if (editBtn) editBtn.style.display = (canEdit && !_mbEditing) ? 'inline-block' : 'none';
    const saveBtn = document.getElementById('mbSaveBtn');
    const cancelBtn = document.getElementById('mbCancelBtn');
    if (saveBtn)   saveBtn.style.display   = (editing) ? 'inline-block' : 'none';
    if (cancelBtn) cancelBtn.style.display = (editing) ? 'inline-block' : 'none';

    if (!shownMonth) { body.innerHTML = '<div class="status-message">No data available.</div>'; return; }

    const sections = [], bySection = {};
    _mbMetrics.forEach(m => {
        if (!bySection[m.section]) { bySection[m.section] = []; sections.push(m.section); }
        bySection[m.section].push(m);
    });

    const totalCols = 1 + MB_STORES.length;
    let head = '<th class="mb-th-metric">Metric</th>';
    MB_STORES.forEach(s => head += '<th class="mb-th-val">' + (MB_STORE_DOT[s] || '') + ' ' + s + '</th>');

    let html = '<div class="mb-overview-cap">All Stores · ' + _mbMonthLabel(shownMonth) +
        (editing ? '  ·  entering current month' : '') + '</div>';
    html += '<table class="mb-table mb-table-overview"><thead><tr>' + head + '</tr></thead><tbody>';

    sections.forEach(sec => {
        html += '<tr class="mb-section-row"><td colspan="' + totalCols + '">' + sec + '</td></tr>';
        bySection[sec].forEach(m => {
            const raw = MB_STORES.map(s => {
                const x = (_mbOverviewData[s] && _mbOverviewData[s][shownMonth] || {})[m.key];
                return (x == null || isNaN(x)) ? null : Number(x);
            });
            // best / worst store for this metric (only when not editing, ≥2 have data, and they differ)
            let bestIdx = -1, worstIdx = -1;
            if (!editing && !_MB_NO_SHADE.has(m.key) && raw.filter(x => x != null).length >= 2) {
                const inv = _MB_INVERSE.has(m.key);
                let best = inv ? Infinity : -Infinity, worst = inv ? -Infinity : Infinity;
                raw.forEach((x, idx) => {
                    if (x == null) return;
                    if (inv ? x < best : x > best) { best = x; bestIdx = idx; }
                    if (inv ? x > worst : x < worst) { worst = x; worstIdx = idx; }
                });
                if (best === worst) { bestIdx = worstIdx = -1; }
            }
            html += '<tr class="mb-row"><td class="mb-metric-name" title="' + m.label + '">' + m.label + '</td>';
            MB_STORES.forEach((s, idx) => {
                if (editing) {
                    const step = (m.type === 'int') ? '1' : (m.type === 'rating' ? '0.1' : '0.01');
                    if (_MB_DERIVED_KEYS.has(m.key)) {
                        html += '<td class="mb-val"><input class="mb-input mb-input-auto" type="number" disabled ' +
                            'title="Auto-calculated" placeholder="auto" id="mb-ov-' + s + '-' + m.key + '" value="' + (raw[idx] != null ? raw[idx] : '') + '"></td>';
                    } else {
                        html += '<td class="mb-val"><input class="mb-input" type="number" step="' + step +
                            '" id="mb-ov-' + s + '-' + m.key + '" value="' + (raw[idx] != null ? raw[idx] : '') +
                            '" oninput="_mbLiveDerive(\'mb-ov-' + s + '-\')"></td>';
                    }
                } else {
                    const ebayOverride = _mbEbayThresholdCls(m.key, raw[idx]);
                    const cls = ebayOverride !== null
                        ? ebayOverride
                        : (idx === bestIdx ? 'mb-val mb-best' : (idx === worstIdx ? 'mb-val mb-worst' : 'mb-val'));
                    html += '<td class="' + cls + '">' + _mbFmt(m.type, raw[idx]) + '</td>';
                }
            });
            html += '</tr>';
        });
    });
    html += '</tbody></table>';
    body.innerHTML = html;
}

function mbExportCSV() {
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const canPickStore = role === 'ceo' || role === 'district manager';
    const sel   = document.getElementById('mbStoreSelect');
    const store = (sel && canPickStore ? sel.value : null) || sessionStorage.getItem('speeksUserStore') || 'STORE';
    const ts    = new Date().toISOString().slice(0, 10);

    const esc = v => { const s = String(v == null ? '' : v); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const toCSV = rows => rows.map(r => r.map(esc).join(',')).join('\r\n');
    const dl = (csv, name) => {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a'); a.href = url; a.download = name; a.style.display = 'none';
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    };

    const sections = {}, secOrder = [];
    _mbMetrics.forEach(m => { if (!sections[m.section]) { sections[m.section] = []; secOrder.push(m.section); } sections[m.section].push(m); });

    if (_mbView === 'overview') {
        const month = _mbOverviewMonth;
        if (!month || !_mbMetrics.length) return;
        const rows = [['Section', 'Metric', ...MB_STORES]];
        secOrder.forEach(sec => {
            sections[sec].forEach(m => {
                const row = [sec, m.label];
                MB_STORES.forEach(s => { const v = (_mbOverviewData[s] || {})[month]; row.push(v ? v[m.key] : ''); });
                rows.push(row);
            });
        });
        dl(toCSV(rows), 'Monthly_Overview_' + _mbMonthLabelShort(month).replace(/[^a-zA-Z0-9]/g, '_') + '_' + ts + '.csv');
    } else {
        const monthSet = new Set(_mbMonths);
        const months = [...monthSet].sort().reverse().slice(0, MB_MONTH_WINDOW).filter(mo => _mbData[mo] && Object.keys(_mbData[mo]).length);
        if (!_mbMetrics.length || !months.length) return;
        const rows = [['Section', 'Metric', ...months.map(m => _mbMonthLabelShort(m))]];
        secOrder.forEach(sec => {
            sections[sec].forEach(m => {
                const row = [sec, m.label];
                months.forEach(mo => { const v = (_mbData[mo] || {})[m.key]; row.push(v != null ? v : ''); });
                rows.push(row);
            });
        });
        dl(toCSV(rows), store + '_Monthly_Brief_' + ts + '.csv');
    }
}

function mbStartEdit() {
    _mbEditing = true;
    renderMonthlyBrief();
}

function mbCancelEdit() {
    _mbEditing = false;
    renderMonthlyBrief();
}

// Save dispatcher — Overview saves every store's current month, Store View saves one.
function mbSaveBrief() {
    return (_mbView === 'overview') ? mbSaveOverview() : mbSaveBriefStore();
}

async function mbSaveBriefStore() {
    const store = document.getElementById('mbStoreSelect')?.value || sessionStorage.getItem('speeksUserStore');
    const pin   = sessionStorage.getItem('speeksUserPin');
    if (!pin) { alert('Session expired — please sign in again.'); return; }

    const values = {};
    _mbMetrics.forEach(m => {
        const el = document.getElementById('mb-in-' + m.key);
        if (el) values[m.key] = el.value === '' ? null : Number(el.value);
    });
    _mbApplyDerived(values);

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
        if (!_mbMonths.includes(_mbEditable)) { _mbMonths.push(_mbEditable); }
        _mbEditing = false;
        renderMonthlyBrief();
    } catch (e) {
        alert('Could not save: ' + e.message);
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    }
}

// OVERVIEW save (DM): posts the current month for every store in parallel.
async function mbSaveOverview() {
    const pin = sessionStorage.getItem('speeksUserPin');
    if (!pin) { alert('Session expired — please sign in again.'); return; }
    const period = _mbOverviewEditable;
    if (!period) return;

    const saveBtn = document.getElementById('mbSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
        await Promise.all(MB_STORES.map(async (s) => {
            const values = {};
            _mbMetrics.forEach(m => {
                const el = document.getElementById('mb-ov-' + s + '-' + m.key);
                if (el) values[m.key] = el.value === '' ? null : Number(el.value);
            });
            _mbApplyDerived(values);
            const resp = await fetch(MONTHLY_BRIEF_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-pin': pin },
                body: JSON.stringify({ store: s, period_end_date: period, values }),
            });
            const result = await resp.json();
            if (!resp.ok || result.error) throw new Error(result.error || ('Save failed for ' + s));
            _mbOverviewData[s] = _mbOverviewData[s] || {};
            _mbOverviewData[s][period] = Object.assign({}, _mbOverviewData[s][period] || {}, values);
        }));
        _mbEditing = false;
        _mbOverviewMonth = period; // the month we just entered is now the most recent with data
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
    const _modalSel = document.getElementById('kpiModalStoreSelect');
    const store = (_modalSel && _modalSel.offsetParent !== null && _modalSel.value) || sessionStorage.getItem('speeksUserStore') || '';
    const sub = document.getElementById('kpiModalSubtitle');
    if (sub) sub.textContent = store + ' · Monthly';

    // Always show the current (editable) month plus any past months with saved data.
    // Rendering it even in view mode means clicking Edit just swaps its cells from
    // text to inputs IN PLACE — no new section appears, so nothing on the page shifts.
    let visible = (periods || []).filter(function(p) { return p.is_editable || p.entries.some(function(e) { return e.id; }); });
    if (_kpiEditingPeriod) {
        const ep = periods.find(function(p) { return p.period_end_date === _kpiEditingPeriod; });
        if (ep && !visible.find(function(p) { return p.period_end_date === ep.period_end_date; })) visible.unshift(ep);
        else if (ep) { visible = visible.filter(function(p) { return p.period_end_date !== ep.period_end_date; }); visible.unshift(ep); }
    }

    _kpiSyncHeaderBtns();
    if (!visible.length) {
        body.innerHTML = '<div class="kpi-empty-state">No monthly KPI data yet. Click ✏️ Edit above to enter the current month.</div>';
        return;
    }
    const moBadges = ['Current Month','Last Month'];
    const moBClass = ['badge-current','badge-prev'];
    let tbody = '';
    visible.forEach(function(p, i) {
        const isEd = _kpiEditingPeriod === p.period_end_date;
        tbody += _kpiSectionDividerHtml('📆 ' + p.period_label, i < 2 ? moBadges[i] : null, i < 2 ? moBClass[i] : '',
            _kpiSectionControls(p.period_end_date, isEd, p.is_editable), '#7c3aed');
        tbody += _kpiHeaderRowsHtml();
        tbody += _kpiEmpRowsHtml(p.entries, p.period_end_date, isEd, false);
        const hasSavedData = p.entries.some(function(e) { return e.id; });
        if (hasSavedData) tbody += _kpiStoreTotalRowHtml(p.entries);
    });
    body.innerHTML = '<div class="kpi-grid-scroll-wrapper"><table class="kpi-entry-grid kpi-full-table">' + _kpiColgroupHtml() + '<tbody>' + tbody + '</tbody></table></div>';
}

function _kpiSyncHeaderBtns() {
    const editBtn   = document.getElementById('kpiEditBtn');
    const saveBtn   = document.getElementById('kpiSaveBtn');
    const cancelBtn = document.getElementById('kpiCancelBtn');
    const isEditing   = !!_kpiEditingPeriod;
    const hasEditable = (_kpiPeriodsData || []).some(function(p) { return p.is_editable; });
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const canEditRole = role === 'district manager' || role === 'ceo' || role === 'owner (manager)' || role === 'owner manager' || role === 'manager' || role === 'assistant manager';
    const hasPeriods  = (_kpiPeriodsData || []).length > 0;
    if (editBtn)   editBtn.style.display   = (!isEditing && canEditRole && (hasEditable || hasPeriods)) ? '' : 'none';
    if (saveBtn)   saveBtn.style.display   = isEditing ? '' : 'none';
    if (cancelBtn) cancelBtn.style.display = isEditing ? '' : 'none';
    _kpiDecorateEditBtn();
}

// ============================================================================
// Weekly-KPI reminder — guides managers Sat 4pm → Sun midnight (America/Chicago)
// Breadcrumb: Analytics nav-link → Store KPIs sub-tab → the Edit button.
// ============================================================================
const _KPI_REMINDER_ROLES = new Set(['manager', 'owner manager', 'owner (manager)', 'assistant manager']);

function _kpiReminderActive() {
    // Read the current wall-clock weekday + hour in Central time
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const wd = (parts.find(p => p.type === 'weekday') || {}).value || '';
    let hr = parseInt((parts.find(p => p.type === 'hour') || {}).value || '0', 10);
    if (hr === 24) hr = 0;                 // midnight edge
    if (wd === 'Sat') return hr >= 16;     // Saturday after 4pm
    return wd === 'Sun';                    // all day Sunday (until Mon 00:00)
}
function _kpiReminderOn() {
    return _kpiReminderActive() && _KPI_REMINDER_ROLES.has((sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim());
}

// add/remove a pulsing dot on an element (idempotent)
function _kpiToggleDot(el, on) {
    if (!el) return;
    el.classList.toggle('kpi-due', on);
    let dot = el.querySelector(':scope > .kpi-due-dot');
    if (on && !dot) { dot = document.createElement('span'); dot.className = 'kpi-due-dot'; el.appendChild(dot); }
    else if (!on && dot) dot.remove();
}

// Step 3: a nudging pill + pulse beside the Edit button (only when it's visible & on the weekly tab)
function _kpiDecorateEditBtn(force) {
    const btn = document.getElementById('kpiEditBtn');
    if (!btn) return;
    const on = (force !== undefined ? force : _kpiReminderOn());
    const wants = on && btn.style.display !== 'none' && _kpiCurrentTab === 'weekly';
    btn.classList.toggle('kpi-due-pulse', wants);
    let pill = document.getElementById('kpiDuePill');
    if (wants && !pill) {
        pill = document.createElement('span');
        pill.id = 'kpiDuePill';
        pill.className = 'kpi-due-pill';
        pill.innerHTML = "Enter this week’s KPIs 👉";
        btn.parentNode.insertBefore(pill, btn);
    } else if (!wants && pill) {
        pill.remove();
    }
}

// Steps 1 & 2: dots on the Analytics nav-link, the Store KPIs sub-tab, and the Weekly toggle
function applyKpiReminder() {
    const on = _kpiReminderOn();
    document.querySelectorAll('.nav-link[href="workspace.html"]').forEach(a => _kpiToggleDot(a, on));
    _kpiToggleDot(document.getElementById('ws-tab-kpis'), on);
    _kpiToggleDot(document.getElementById('kpi-tab-weekly'), on);
    _kpiDecorateEditBtn(on);
}

function kpiHeaderStartEdit() {
    const ep = (_kpiPeriodsData || []).find(function(p) { return p.is_editable; }) || (_kpiPeriodsData || [])[0];
    if (!ep) return;
    _kpiEditingPeriod = ep.period_end_date;
    if (_kpiCurrentTab === 'weekly') _kpiRenderWeekly(_kpiPeriodsData);
    else _kpiRenderMonthly(_kpiPeriodsData);
}

function kpiHeaderSave() {
    if (_kpiEditingPeriod) _kpiSavePeriod(_kpiEditingPeriod);
}

function kpiHeaderCancel() {
    _kpiEditingPeriod = null;
    if (_kpiCurrentTab === 'weekly') _kpiRenderWeekly(_kpiPeriodsData);
    else _kpiRenderMonthly(_kpiPeriodsData);
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

// ============================================================================
// ANALYTICS WORKSPACE (workspace.html) — Monthly Brief / Store KPIs / B2B
// ============================================================================
let _wsBriefLoaded = false;
let _wsKpiLoaded   = false;

// Loads the inline KPI grid (same markup/IDs as the old fullscreen modal, but
// rendered in-page rather than via toggleModal). Loads once per page-init.
async function loadWorkspaceKpis() {
    if (_wsKpiLoaded) return;
    _wsKpiLoaded = true;
    _kpiCurrentTab = 'weekly';
    _kpiEditingPeriod = null;
    // Managers (picker hidden) default to their own store; DMs keep selection
    const sel = document.getElementById('kpiModalStoreSelect');
    const userStore = sessionStorage.getItem('speeksUserStore');
    if (sel && userStore && sel.offsetParent === null) sel.value = userStore;
    document.getElementById('kpi-tab-weekly')?.classList.add('active');
    document.getElementById('kpi-tab-monthly')?.classList.remove('active');
    await _kpiLoadAll('weekly');
}

function switchWorkspaceTab(name) {
    document.querySelectorAll('.ws-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.ws-pane').forEach(p => p.classList.remove('active'));
    document.getElementById('ws-tab-' + name)?.classList.add('active');
    document.getElementById('ws-pane-' + name)?.classList.add('active');
    try { history.replaceState(null, '', 'workspace.html#' + name); } catch (e) {}

    if (name === 'brief') {
        if (!_wsBriefLoaded) { _wsBriefLoaded = true; if (typeof fetchMonthlyBrief === 'function') fetchMonthlyBrief(); }
    } else if (name === 'kpis') {
        loadWorkspaceKpis();
    } else if (name === 'b2b') {
        fetchB2BDeals();
    }
    applyKpiReminder();
}

// Detects the workspace page and opens the requested sub-tab (defaults to the
// brief, or honors a #brief / #kpis / #b2b deep-link). Safe no-op elsewhere.
function initWorkspace() {
    if (!document.querySelector('.ws-wrap')) return;
    _wsBriefLoaded = false;
    _wsKpiLoaded   = false;
    const hash = (window.location.hash || '').replace('#', '');
    // TEMP: B2B tab hidden — restore by putting 'b2b' back in the list and as the default.
    const initial = ['brief', 'kpis'].includes(hash) ? hash : 'brief';
    switchWorkspaceTab(initial);
    applyKpiReminder();
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
    // Mirror the load/render store resolution: DM/CEO/TOM save the store picked in
    // the (visible) selector; managers fall back to their own store. Reading only
    // sessionStorage here misrouted DM saves to their own store ('CORP').
    const modalSel = document.getElementById('kpiModalStoreSelect');
    const store = (modalSel && modalSel.offsetParent !== null && modalSel.value) || sessionStorage.getItem('speeksUserStore');
    const pin   = sessionStorage.getItem('speeksUserPin');
    if (!store || !pin) return;
    const pk     = periodDate.replace(/-/g, '');
    const period = _kpiPeriodsData.find(function(p) { return p.period_end_date === periodDate; });
    if (!period) return;
    const saveBtn = document.getElementById('kpiSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
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
        await postWrite(RECORDS_URL, payload);

        if (!awardsCache) awardsCache = [];
        const idx = awardsCache.findIndex(a => a.month === month);
        if (idx >= 0) awardsCache[idx] = { ...payload };
        else awardsCache.push({ ...payload });

        renderAwards();
        renderAwardVideos();
        closeAllModals();
    } catch (e) {
        if (status) status.textContent = '✗ Error saving.';
        alert('Failed to save awards: ' + (e.message || e));
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
            <a href="https://drive.google.com/file/d/1D4VBM5nSD0KpK-bzE3_O9OOncFCsk80w/view?usp=sharing" target="_blank" class="mini-action-btn" style="background: white; border-color: #fde68a; color: #92400e; box-shadow: 0 2px 4px rgba(251,191,36,0.15);">View Process ↗</a>
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
    sessionStorage.removeItem('speeksMultiStore');

    // Remove the comment tracker so it pops up again on next login
    sessionStorage.removeItem('speeksSeenCommentKeys');

    // Hide authenticated chrome and close any open panels BEFORE reloading, so the
    // teardown/fetch window can't briefly paint role-gated controls (e.g. the green
    // ticker toggles) as the layout collapses.
    document.body.classList.remove('is-authenticated');
    document.getElementById('checklistSidePanel')?.classList.remove('open');
    document.getElementById('goalsSidePanel')?.classList.remove('open');

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
        window._scorecardAllData = json.data || [];

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
            breakdownHtml = `<div style="max-height: 340px; overflow-y: auto; padding-right: 4px; margin-top: 12px;" class="kpi-scroll-area">`;
            storeData.buckets.forEach((bucket, bIdx) => {
                if (!bucket.categories || bucket.categories.length === 0) return;
                const bDateStr = bucket.sectionDate ? formatWeekOf(bucket.sectionDate) : '';
                const sectionPulse = (!showOverallDot && bIdx === singleRecentBucketIdx)
                    ? `<div class="notif-dot active" style="position:relative; top:auto; right:auto; width:9px; height:9px; border:1px solid white; flex-shrink:0;"></div>`
                    : '';
                const notesHtml = bucket.notes
                    ? `<div style="margin-top: 6px; padding: 6px 10px; background: #f8fafc; border-left: 3px solid #94a3b8; border-radius: 0 6px 6px 0; font-size: 11px; color: #475569; line-height: 1.5; font-style: italic;">${String(bucket.notes).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</div>`
                    : '';
                breakdownHtml += `<div style="margin-bottom: 12px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; min-width: 0;">
                        <span style="font-size: 9px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;">${bucket.name}</span>
                        ${bDateStr ? `<span style="font-size: 9px; color: #94a3b8; font-style: italic; white-space: nowrap; flex-shrink: 0;">${bDateStr}</span>` : ''}
                        ${sectionPulse}
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;">
                        ${bucket.categories.map(renderCategoryCard).join('')}
                    </div>
                    ${notesHtml}
                </div>`;
            });
            breakdownHtml += `</div>`;
        } else if (storeData.breakdown && storeData.breakdown.length > 0) {
            breakdownHtml = `<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; max-height: 280px; overflow-y: auto; padding-right: 4px; margin-top: 15px; border-top: 1px solid #f0f0f0; padding-top: 15px;" class="kpi-scroll-area">
                ${storeData.breakdown.map(renderCategoryCard).join('')}
            </div>`;
        }

        const auditHtml = buildAuditSummaryHtml(storeData.audit, targetStore);

        container.innerHTML = `
        <div class="scorecard-widget" style="padding: 20px; align-items: stretch; text-align: left; justify-content: flex-start;">
            ${auditHtml}
            <div style="margin-top: 15px; border-top: 1px solid #f0f0f0; padding-top: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div class="scorecard-label" style="text-align: left; margin-bottom: 2px;">Online &amp; Marketing</div>
                        <div class="scorecard-date" style="margin-bottom: 0; font-size: 11px;">${displayDate}</div>
                    </div>
                    <div style="position: relative; display: inline-block;">
                        <div class="scorecard-val" style="color: ${scoreColor}; font-size: 36px; text-shadow: 0 4px 15px ${scoreColor}30; line-height: 1;">
                            ${displayScore.toFixed(1)}<span style="color:#94a3b8;">/10</span>
                        </div>
                        ${pulse}
                    </div>
                </div>
                ${breakdownHtml}
            </div>
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

            // Red now fires at 80% of the way to the eBay limit (was 100%); yellow at 50%.
            if (type === 'defectRate') {
                if (valToCheck >= 0.40) return 'very-high'; // Red  (80% of 0.5 limit)
                if (valToCheck >= 0.25) return 'high';      // Yellow
                return 'clear';                             // Green
            }
            if (type === 'lateShipment') {
                if (valToCheck >= 2.4) return 'very-high';  // 80% of 3.0
                if (valToCheck >= 1.5) return 'high';
                return 'clear';
            }
            if (type === 'casesClosed') {
                if (valToCheck >= 0.24) return 'very-high'; // 80% of 0.3
                if (valToCheck >= 0.15) return 'high';
                return 'clear';
            }
            if (type === 'tracking') {
                if (valToCheck <= 96.0) return 'very-high'; // 80% toward the 95 floor
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

            // Practice audit badge (clickable into the full breakdown popout).
            const sAudit = sScore.audit || null;
            let auditBadge = '';
            if (sAudit) {
                const ac = auditPctColor(sAudit.pct);
                auditBadge = `<span onclick="event.stopPropagation(); openAuditBreakdown('${store}')" title="PayMore practice audit — ${sAudit.earned}/${sAudit.possible} · view full breakdown" style="display:inline-flex; align-items:center; gap:5px; height:25px; padding:0 10px; border-radius:8px; background:${ac.bg}; color:${ac.fg}; cursor:pointer; white-space:nowrap; box-sizing:border-box;">
                    <span style="font-size:8px; font-weight:800; letter-spacing:.6px; opacity:.75;">AUDIT</span>
                    <span style="font-size:14px; font-weight:900; line-height:1;">${sAudit.pct}%</span>
                </span>`;
            } else {
                auditBadge = `<span title="No practice audit submitted yet" style="display:inline-flex; align-items:center; gap:5px; height:25px; padding:0 10px; border-radius:8px; background:transparent; color:#94a3b8; border:1px dashed #4a5365; white-space:nowrap; box-sizing:border-box;">
                    <span style="font-size:8px; font-weight:800; letter-spacing:.6px;">AUDIT</span>
                    <span style="font-size:11px; font-weight:700; letter-spacing:.3px; line-height:1;">NO DATA</span>
                </span>`;
            }

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
                    if (valToCheck >= 0.40) return 'very-high';
                    if (valToCheck >= 0.25) return 'high';
                }
                if (type === 'lateShipment') {
                    if (valToCheck >= 2.4) return 'very-high';
                    if (valToCheck >= 1.5) return 'high';
                }
                if (type === 'casesClosed') {
                    if (valToCheck >= 0.24) return 'very-high';
                    if (valToCheck >= 0.15) return 'high';
                }
                if (type === 'tracking') {
                    if (valToCheck <= 96.0) return 'very-high';
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

                return `
                <div style="position: relative; background: #fff; padding: 8px 6px 7px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; box-sizing: border-box; min-height: 52px; gap: 5px; text-align: center;">
                    ${pulseHtml}
                    <span style="font-size: 8px; font-weight: 800; color: #b0bec5; text-transform: uppercase; letter-spacing: 0.4px; line-height: 1.2; word-break: break-word;">${title}</span>
                    <span style="font-size: 12px; font-weight: 900; color: ${textColor}; background: ${bgColor}; padding: 3px 8px; border-radius: 6px; white-space: nowrap;">${displayText}</span>
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
                        <span class="master-card-date goal-strong" style="margin: 0;">Goal: ${storeGoalText}</span>
                    </div>
                    <div style="display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; gap: 6px;">
                        <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                            <span class="master-card-score" style="background: ${sBg}; color: ${sColor};" title="Online & Marketing scorecard">${scoreNum.toFixed(1)}</span>
                            ${auditBadge}
                        </div>
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
let _l1SelectSeq = 0; // tracks order L1 was assigned, for FIFO when a 3rd L1 is picked
let managerWeeklyEntries = []; // [{ name, listed }] — this week's # Listed per employee (from Weekly KPI)
let managerWeeklyHistory = []; // [storeTotal, ...] completed weeks, oldest→newest (drives level-up bars)
let _goalsAutosaveTimer = null;
let _goalsChecklistDone = false;
let _priorWeekGoals = {};      // idx → sum of this week's saved daily goals EXCLUDING today (today is live)
let _weekTargetTotal = 0;      // store's weekly goal target (shown in the Week total)

// ----------------------------------------------------------------------------
// LISTING GOALS ENGINE — role → auto goal. Goals are derived, never typed.
// daily goal = role weight × store scale × day factor (stable; overtime-proof).
// Reference + visual sandbox: prototypes/listing-goals-prototype.html
// ----------------------------------------------------------------------------
const ListingGoalsEngine = {
    roleWeight: { B1: 5, B2: 8, L1: 25, L2: 25, L1_SHARED: 15 },
    saturdayFactor: 0.5,
    step: 10,           // ratchet step (+listings/week) once a store levels up
    ratchetWindow: 3,   // rolling weeks evaluated
    needHits: 2,        // weeks at/above target within window to level up
    needMiss: 2,        // weeks below target within window to flag for review

    // Incremental: ±20 listings per person, anchored at 4 people = 190 (floor 150).
    // 2→150, 3→170, 4→190, 5→210, 6→230. Mirrors baseForSize() in the
    // store-targets edge function so the frontend and server stay in lock-step.
    weeklyTarget(size)       { return Math.max(150, 110 + 20 * size); },
    modelSize(rosterSize)    { return rosterSize >= 4 ? 4 : 3; },

    // Standard staffed week, used ONLY to calibrate the scale so a normal week
    // sums to the weekly target. Day-to-day goals use the live roles selected.
    standardWeek(size) {
        return size >= 4
            ? { Mon:['B1','B2','L1'], Tue:['B1','B2','L1'], Wed:['B1','B2','L1'],
                Thu:['B1','B2','L1'], Fri:['B1','B2','L1','L2'], Sat:['B1','B2','L1','L2'] }
            : { Mon:['B1','L1'], Tue:['B1','L1'], Wed:['B1','L1'],
                Thu:['B1','B2','L1'], Fri:['B1','B2','L1'], Sat:['B1','B2','L1'] };
    },
    dayFactorFromDate(dateStr) {
        const dow = new Date(dateStr).getDay(); // 0 Sun .. 6 Sat
        if (dow === 6) return this.saturdayFactor; // Saturday: shorter + busiest
        if (dow === 0) return 0;                   // closed Sundays
        return 1;
    },
    weightFor(role, staffedCount) {
        // On 2-person days the lister also covers the floor → reduced weight.
        if (role === 'L1' && staffedCount <= 2) return this.roleWeight.L1_SHARED;
        return this.roleWeight[role] || 0;
    },
    scale(rosterSize) {
        const size = this.modelSize(rosterSize);
        const target = this.weeklyTarget(rosterSize);
        const wk = this.standardWeek(size);
        const factor = { Mon:1, Tue:1, Wed:1, Thu:1, Fri:1, Sat:this.saturdayFactor };
        let cap = 0;
        for (const day in wk) {
            const roles = wk[day];
            roles.forEach(r => { cap += this.weightFor(r, roles.length) * factor[day]; });
        }
        return cap > 0 ? target / cap : 0;
    },
    // The function the widgets call: goal for one role, on a date, given how
    // many people are staffed that day (needed for the shared-lister rule).
    goalFor(role, dateStr, rosterSize, staffedCount) {
        if (!role || role === '-') return 0;
        const g = this.weightFor(role, staffedCount) * this.scale(rosterSize) * this.dayFactorFromDate(dateStr);
        return Math.round(g);
    },
    // Level-up / flag evaluation. actuals = weekly # Listed, oldest → newest.
    ratchet(actuals, target) {
        const win = (actuals || []).slice(-this.ratchetWindow);
        const hits = win.filter(a => a >= target).length;
        const miss = win.filter(a => a < target).length;
        const lastTwo = (actuals || []).slice(-2);
        const twoInARow = lastTwo.length === 2 && lastTwo.every(a => a < target);
        return {
            hits, miss, twoInARow,
            levelUp: hits >= this.needHits,
            flagged: (miss >= this.needMiss || twoInARow),
            urgent: twoInARow,
            nextTarget: target + this.step
        };
    }
};

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
        if (document.getElementById('goals-manager-body')) renderManagerGoals();
    }
}

async function initListingGoals() {
    runScheduledTasks();
    setInterval(runScheduledTasks, 60000); 
    await fetchLiveGoalsData();
}

async function fetchLiveGoalsData() {
    const list = document.getElementById('goals-manager-body');
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
                .filter(u => userInStore(u, goalsTargetStore) && !_excluded.includes((u.role || '').toLowerCase()))
                .map(u => u.name)
                .filter(Boolean);
            goalsRoster = _emps.length ? _emps : ['No Employees Found'];
        }

        liveGoalsData = await fetch(`${GOALS_API_URL}?store=${goalsTargetStore}&v=${Date.now()}`).then(r => r.json()).catch(() => []);
        if (!Array.isArray(liveGoalsData)) liveGoalsData = [];

        await fetchManagerWeeklyKpi();
        renderManagerGoals();
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
            <span class="goals-info-i" data-tip-title="How goals are set" data-tip-desc="Just pick each person's role — the goal fills in automatically.">i</span>
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
                <div class="goal-auto-display" id="goal-display-${idx}" title="Set automatically from the selected role">–</div>
            </div>
        </div>`;
    });

    container.innerHTML = html;
    setTimeout(() => { updateRoleLocks(); recomputeGoalDisplays(); }, 50);
}

// Debounced auto-save — managers just pick roles, no Save button.
window.scheduleGoalsAutosave = function() {
    const status = document.getElementById('goals-save-status');
    if (status) { status.textContent = 'Saving…'; status.className = 'goals-save-status saving'; }
    clearTimeout(_goalsAutosaveTimer);
    _goalsAutosaveTimer = setTimeout(() => saveGoalsData(true), 900);
};

async function saveGoalsData(silent = false) {
    const status = document.getElementById('goals-save-status');
    if (status && !silent) { status.textContent = 'Saving…'; status.className = 'goals-save-status saving'; }

    const now = new Date();
    const targetDateStr = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });

    let payloadEmployees = [];

    // How many people are staffed today — needed for the shared-lister rule.
    let staffedCount = 0;
    goalsRoster.forEach((emp, idx) => {
        const group = document.getElementById(`roles-${idx}`);
        if (group && group.querySelector('.role-dot.active')) staffedCount++;
    });
    const rosterSize = effectiveTeamSize(goalsTargetStore);

    goalsRoster.forEach((emp, idx) => {
        const roleGroup = document.getElementById(`roles-${idx}`);
        const activeBtn = roleGroup?.querySelector('.role-dot.active');
        const role = activeBtn ? activeBtn.innerText : '-';

        // Goal is derived from the role — never typed.
        const goal = role !== '-' ? String(ListingGoalsEngine.goalFor(role, targetDateStr, rosterSize, staffedCount)) : '';

        // Results now come from the Weekly KPI (# Listed); preserve any existing value.
        const existing = liveGoalsData.find(r => r.employee === emp && normalizeGoalDate(r.date) === targetDateStr);
        const result = existing && existing.result != null ? String(existing.result) : '';

        if (role !== '-' || goal !== '' || result !== '') {
            payloadEmployees.push({ employee: emp, role: role, goal: goal, result: result });
        }
    });

    try {
        const response = await fetch(GOALS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ store: goalsTargetStore, date: targetDateStr, employees: payloadEmployees })
        });

        if (response.ok) {
            // Update the local cache so the UI reflects it instantly.
            liveGoalsData = liveGoalsData.filter(r => !(normalizeGoalDate(r.date) === targetDateStr && r.store === goalsTargetStore));
            payloadEmployees.forEach(p => {
                liveGoalsData.push({ date: targetDateStr, store: goalsTargetStore, employee: p.employee, role: p.role, goal: p.goal, result: p.result });
            });

            const pulse = document.getElementById('goals-pulse-dot');
            if (pulse) pulse.style.display = 'none';
            if (status) { status.textContent = 'Saved ✓'; status.className = 'goals-save-status saved'; }

            // Mark the "set listing goals" checklist task done — once per session load.
            if (!_goalsChecklistDone) {
                _goalsChecklistDone = true;
                markListingGoalsChecklistComplete();
            }
        } else {
            if (status) { status.textContent = 'Save failed'; status.className = 'goals-save-status error'; }
            else alert("Error saving goals to server.");
        }
    } catch (error) {
        if (status) { status.textContent = 'Save failed'; status.className = 'goals-save-status error'; }
        else alert("Connection failed. Please try again.");
    }
}

// Flip the manager's "Set Listing Goals" daily checklist task to done.
async function markListingGoalsChecklistComplete() {
    const userName = sessionStorage.getItem('speeksUserName') || 'Unknown';
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';
    let targetTaskId = null;

    if (checklistDataCache && checklistDataCache.daily && checklistDataCache.daily.length > 0) {
        const task = checklistDataCache.daily.find(t => t.text.toLowerCase().includes('listing goals'));
        if (task) {
            targetTaskId = task.id;
            if (!task.checked) { task.checked = true; if (typeof renderChecklist === 'function') renderChecklist(); }
        }
    }

    if (!targetTaskId) {
        try {
            const res = await fetch(`${CHECKLIST_URL}?user=${encodeURIComponent(userName)}&store=${store}&v=${Date.now()}`);
            const data = await res.json();
            if (data && data.daily) {
                const task = data.daily.find(t => t.text.toLowerCase().includes('listing goals'));
                if (task && !task.checked) targetTaskId = task.id;
            }
        } catch (e) {}
    }

    if (targetTaskId) {
        postWrite(CHECKLIST_URL, { action: 'toggle', id: targetTaskId, checked: true, user: userName, store: store })
            .catch(err => console.warn('Listing-goals checklist tick failed:', err.message));
    }
}

// ---- Inline manager scoreboard: pick roles → auto goals, weekly results, level-up ----
async function fetchManagerWeeklyKpi() {
    await fetchStoreTarget(goalsTargetStore);
    managerWeeklyHistory = weeksFor(goalsTargetStore);
}

function getWeeklyResultFor(emp) {
    const target = String(emp).trim().toLowerCase();
    const tFirst = target.split(' ')[0];
    for (const e of managerWeeklyEntries) {
        const n = String(e.name).trim().toLowerCase();
        if (n === target) return e.listed;
        const nFirst = n.split(' ')[0];
        if (nFirst.length > 2 && tFirst.length > 2 && (nFirst.startsWith(tFirst) || tFirst.startsWith(nFirst))) return e.listed;
    }
    return 0;
}

function renderManagerGoals() {
    const list = document.getElementById('goals-manager-body');
    if (!list) return;

    const now = new Date();
    const dateDisplay = document.getElementById('goals-date-display');
    if (dateDisplay) dateDisplay.innerText = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    const todayStr = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() + (now.getDay() === 0 ? -6 : 1 - now.getDay()));
    startOfWeek.setHours(0, 0, 0, 0);

    const availableRoles = goalsRoster.length <= 2 ? ['B1', 'B2', 'L1'] : ['B1', 'B2', 'L1', 'L2'];

    _priorWeekGoals = {};
    _weekTargetTotal = targetFor(goalsTargetStore);
    const storeTargetEl = document.getElementById('goals-store-target');
    if (storeTargetEl) storeTargetEl.innerText = `Goal: ${_weekTargetTotal} Listings`;

    let html = '';
    goalsRoster.forEach((emp, idx) => {
        const rec = liveGoalsData.find(r => r.employee === emp && normalizeGoalDate(r.date) === todayStr) || { role: '' };

        let rolesHtml = '';
        availableRoles.forEach(r => {
            const isActive = rec.role === r ? 'active' : '';
            rolesHtml += `<button type="button" class="role-dot ${isActive}" onclick="selectRole(this, '${emp}', '${r}')">${r}</button>`;
        });

        // Weekly goal = this week's saved daily goals, excluding today (today is added live).
        _priorWeekGoals[idx] = priorWeekGoal(emp, todayStr, startOfWeek);

        html += `
        <div class="goals-mgr-row">
            <div class="goals-mgr-emp">
                <span class="goals-roster-name">${emp}</span>
                <div class="goals-edit-roles" id="roles-${idx}">${rolesHtml}</div>
            </div>
            <div class="goal-auto-display" id="goal-display-${idx}">–</div>
            <div class="goals-mgr-week" id="week-display-${idx}">–</div>
        </div>`;
    });

    list.innerHTML = html;

    renderGoalsLevelUp();
    setTimeout(() => { updateRoleLocks(); recomputeGoalDisplays(); }, 30);
}

// Sum of an employee's saved daily goals this week, excluding today (last record per day wins).
function priorWeekGoal(emp, todayStr, startOfWeek) {
    const target = String(emp).trim().toLowerCase();
    const tFirst = target.split(' ')[0];
    const byDay = {};
    liveGoalsData.forEach(r => {
        const n = String(r.employee).trim().toLowerCase();
        const nFirst = n.split(' ')[0];
        const match = n === target || (nFirst.length > 2 && tFirst.length > 2 && (nFirst.startsWith(tFirst) || tFirst.startsWith(nFirst)));
        if (!match) return;
        const dStr = normalizeGoalDate(r.date);
        if (dStr === todayStr) return;
        if (new Date(r.date) >= startOfWeek) byDay[dStr] = parseInt(r.goal) || 0;
    });
    return Object.values(byDay).reduce((s, g) => s + g, 0);
}

// Roster size for a store (from auth cache), used to pick the weekly target.
function storeRosterSize(store) {
    try {
        const auth = JSON.parse(localStorage.getItem('speeksAuthCache') || '{}');
        const excluded = ['ceo', 'district manager'];
        return (auth.users || []).filter(u =>
            userInStore(u, store) &&
            !excluded.includes((u.role || '').toLowerCase())
        ).length || 4;
    } catch (e) { return 4; }
}

// Persisted per-store target + flag + last-4-week totals (server-side ratchet).
let _storeTargets = {}; // store -> { target, base, flag, weeks:[{week,total}] }

async function fetchStoreTarget(store) {
    try {
        const r = await fetch(`${STORE_TARGETS_URL}?store=${store}&v=${Date.now()}`).then(x => x.json());
        if (r && r.store) _storeTargets[r.store] = r;
        return r;
    } catch (e) { return null; }
}
async function fetchAllStoreTargets() {
    try {
        const arr = await fetch(`${STORE_TARGETS_URL}?v=${Date.now()}`).then(x => x.json());
        if (Array.isArray(arr)) arr.forEach(r => { if (r && r.store) _storeTargets[r.store] = r; });
        return arr || [];
    } catch (e) { return []; }
}
// Current weekly target for a store (server value; falls back to roster-derived base).
function targetFor(store) {
    return (_storeTargets[store] && _storeTargets[store].target) || ListingGoalsEngine.weeklyTarget(storeRosterSize(store));
}
// Effective team size for goal math. Prefers the server's settled size, which
// honors the timing rule (a subtraction shrinks the goal immediately, an addition
// waits until next week). Falls back to the live roster before the target loads.
function effectiveTeamSize(store) {
    const t = _storeTargets[store];
    if (t && typeof t.size === 'number') return t.size;
    return storeRosterSize(store);
}
// Last-4 completed-week listing totals (oldest→newest) for the bars.
function weeksFor(store) {
    return ((_storeTargets[store] && _storeTargets[store].weeks) || []).map(w => w.total);
}
// DM action on a flagged store: 'lower' (−10) or 'keep' (hold). Resolves the flag.
async function dmGoalAction(store, action) {
    try {
        await fetch(STORE_TARGETS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ store, action })
        });
        await fetchStoreTarget(store);
        renderCompactDmGoals();
    } catch (e) {}
}
window.dmGoalAction = dmGoalAction;

// Completed-week store listing totals (oldest→newest) from the Weekly KPI.
async function fetchStoreWeeklyHistory(store) {
    try {
        const resp = await fetch(`${KPI_MANAGE_URL}?store=${store}&period_type=weekly&v=${Date.now()}`);
        const data = await resp.json();
        const periods = (data && Array.isArray(data.periods)) ? data.periods : [];
        return periods.slice()
            .sort((a, b) => new Date(a.period_end_date) - new Date(b.period_end_date))
            .filter(p => !p.is_editable)
            .map(p => (p.entries || []).reduce((s, e) => s + (parseInt(e.listed_count) || 0), 0));
    } catch (e) { return []; }
}

// Running 4-week listing view (manager + employee/ASM + DM widgets).
// NOTE: the level-up ratchet logic stays server-side — the frontend only shows
// the last four weeks of totals so the mechanism can't be gamed.
function levelUpHtml(history, target) {
    const last4 = history.slice(-4);
    const padded = [...Array(Math.max(0, 4 - last4.length)).fill(null), ...last4];
    const bars = padded.map(v => v == null
        ? '<div class="lu-week empty"><span class="lu-week-num">–</span></div>'
        : `<div class="lu-week ${v >= target ? 'green' : 'red'}"><span class="lu-week-num">${v}</span></div>`
    ).join('');

    return `
        <div class="lu-head"><span class="lu-title">Last 4 Weeks</span></div>
        <div class="lu-weeks">${bars}</div>`;
}

function renderGoalsLevelUp() {
    const el = document.getElementById('goals-levelup');
    if (!el) return;
    el.innerHTML = levelUpHtml(managerWeeklyHistory, targetFor(goalsTargetStore));
}

// --- DM COMPACT GOALS WIDGET ---
let dmStoreHistory = {}; // store -> completed weekly listing totals (for level-up bars)

async function fetchDmGoalsData() {
    const cont = document.getElementById('dm-compact-goals-container');
    if (!cont) return;

    const stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

    try {
        const [goalsResults] = await Promise.all([
            Promise.all(stores.map(s => fetch(`${GOALS_API_URL}?store=${s}&v=${Date.now()}`).then(r => r.json()))),
            fetchAllStoreTargets()
        ]);
        allDistrictGoalsData = goalsResults.flat();
        dmStoreHistory = {};
        stores.forEach(s => { dmStoreHistory[s] = weeksFor(s); });
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

    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() + (now.getDay() === 0 ? -6 : 1 - now.getDay()));
    startOfWeek.setHours(0, 0, 0, 0);

    const stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    const roleName = { B1: 'Buyer 1', B2: 'Buyer 2', L1: 'Lister 1', L2: 'Lister 2' };
    let html = '<div style="display:flex; flex-direction:column;">';

    stores.forEach((store, idx) => {
        const target = targetFor(store);
        const flag = (_storeTargets[store] && _storeTargets[store].flag) || 'none';
        const storeData = allDistrictGoalsData.filter(r => r.store === store);

        // Per-employee today + weekly goals (last record per day wins). Read-only.
        const emps = {};
        storeData.forEach(r => {
            if (new Date(r.date) < startOfWeek) return;
            const dStr = normalizeGoalDate(r.date);
            if (!emps[r.employee]) emps[r.employee] = { role: '-', byDay: {} };
            emps[r.employee].byDay[dStr] = parseInt(r.goal) || 0;
            if (dStr === todayStr && r.role && r.role !== '-') emps[r.employee].role = r.role;
        });

        const empNames = Object.keys(emps);
        let todayTotal = 0, weekTotal = 0;
        empNames.forEach(e => {
            todayTotal += emps[e].byDay[todayStr] || 0;
            weekTotal += Object.values(emps[e].byDay).reduce((s, g) => s + g, 0);
        });

        const muted = weekTotal === 0 ? 'opacity:0.6;' : '';
        const lastBorder = idx === stores.length - 1 ? 'transparent' : '#f0f0f0';

        html += `
        <div onclick="toggleDmStoreAccordion('${store}')" class="lb-row dm-store-head" style="display:grid; grid-template-columns:60px 1fr auto 18px; align-items:center; gap:12px; border-bottom:1px solid ${lastBorder}; cursor:pointer; padding:13px 15px; ${muted}">
            <span style="font-size:14px; font-weight:900; color:var(--slate-charcoal);">${store}</span>
            <span style="font-size:14px; font-weight:900; color:var(--slate-charcoal); text-transform:uppercase; letter-spacing:0.04em;">Goal: ${target} Listings${flag === 'flagged' ? ' <span class="dm-flag-badge">⚠ Review</span>' : ''}</span>
            <span style="font-size:14px; font-weight:900; color:var(--slate-charcoal); text-align:right;">${weekTotal}<span style="font-size:14px; color:var(--slate-charcoal); font-weight:900;"> wk</span></span>
            <div id="dm-caret-${store}" class="dm-store-caret" style="text-align:right; color:#888; font-size:10px; font-weight:800; transition:transform 0.3s; transform:rotate(-90deg);">▼</div>
        </div>`;

        html += `<div id="dm-roster-${store}" class="dm-store-roster" style="display:none; background:#fdfdfd; padding:10px 18px 14px; border-bottom:1px solid #e2e8f0; box-shadow:inset 0 3px 6px rgba(0,0,0,0.02);">`;
        html += `<div class="goals-header-row"><span class="goals-header-lbl">Employee &amp; Role</span><span class="goals-header-lbl center">Today</span><span class="goals-header-lbl center">Week</span></div>`;

        if (empNames.length === 0) {
            html += `<div style="font-size:12px; color:#888; text-align:center; font-weight:600; padding:10px 0;">No roles set this week.</div>`;
        } else {
            empNames.forEach(e => {
                const eToday = emps[e].byDay[todayStr] || 0;
                const eWeek = Object.values(emps[e].byDay).reduce((s, g) => s + g, 0);
                const badge = emps[e].role !== '-' ? `<span class="dm-role-badge">${roleName[emps[e].role] || emps[e].role}</span>` : '';
                html += `
                <div class="goals-mgr-row">
                    <div class="goals-mgr-emp"><span class="goals-roster-name">${e}</span>${badge}</div>
                    <div class="goals-mgr-week">${eToday || '–'}</div>
                    <div class="goals-mgr-week">${eWeek || '–'}</div>
                </div>`;
            });
        }

        html += `<div class="goals-total-row"><span class="goals-total-lbl">Total</span><span class="goals-total-val target">${todayTotal}</span><span class="goals-total-val target">${weekTotal}</span></div>`;
        html += `<div class="goals-levelup">${levelUpHtml(dmStoreHistory[store] || [], target)}</div>`;
        if (flag === 'flagged') {
            html += `<div class="dm-flag-actions">
                <span class="dm-flag-msg">⚠️ Missed goal 2 weeks — review:</span>
                <button class="dm-flag-btn lower" onclick="event.stopPropagation(); dmGoalAction('${store}','lower')">Lower −10</button>
                <button class="dm-flag-btn keep" onclick="event.stopPropagation(); dmGoalAction('${store}','keep')">Keep</button>
            </div>`;
        }
        html += `</div>`;
    });

    html += '</div>';
    cont.innerHTML = html;
}

// --- DM AUDIT READINESS WIDGET (read-only, live through the week) ---
// Lets the DM/CEO see each store's daily + weekly audit checklist progress as
// it fills in, so they can follow up with managers before the Monday report.
let dmAuditData = {};            // { OVL: { daily:{items,total,completed}, weekly:{...} }, ... }
let currentDmAuditTab = 'daily';

async function fetchDmAuditData() {
    const cont = document.getElementById('dm-audit-container');
    if (!cont) return;
    try {
        const res = await fetch(`${STORE_AUDIT_URL}?action=overview&v=${Date.now()}`);
        const json = await res.json();
        dmAuditData = json.stores || {};
        renderDmAudit();
    } catch (e) {
        cont.innerHTML = '<div class="status-message" style="color:var(--red-alert);">Network Sync Failed.</div>';
    }
}

function switchDmAuditTab(view) {
    currentDmAuditTab = view;
    document.getElementById('dm-audit-tab-daily')?.classList.toggle('active', view === 'daily');
    document.getElementById('dm-audit-tab-weekly')?.classList.toggle('active', view === 'weekly');
    renderDmAudit();
}

function toggleDmAuditAccordion(store) {
    const rosterDiv = document.getElementById(`dm-audit-roster-${store}`);
    const caret = document.getElementById(`dm-audit-caret-${store}`);
    if (!rosterDiv) return;
    const isOpen = rosterDiv.style.display === 'block';

    document.querySelectorAll('.dm-audit-roster').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.dm-audit-caret').forEach(el => el.style.transform = 'rotate(-90deg)');

    if (!isOpen) {
        rosterDiv.style.display = 'block';
        if (caret) caret.style.transform = 'rotate(0deg)';
    }
}

// PayMore-style readiness colors: pass ≥80, watch ≥50, behind below.
function _auditPctColor(pct) {
    if (pct >= 80) return 'var(--green-go, #16a34a)';
    if (pct >= 50) return '#d97706';
    return 'var(--red-alert, #dc2626)';
}

function renderDmAudit() {
    const cont = document.getElementById('dm-audit-container');
    if (!cont) return;

    const stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    const tab = currentDmAuditTab;
    const periodWord = tab === 'daily' ? 'today' : 'this week';
    let html = '<div style="display:flex; flex-direction:column;">';

    stores.forEach((store, idx) => {
        const sd = dmAuditData[store] || {};
        const pd = sd[tab] || { items: [], total: 0, completed: 0 };
        const items = pd.items || [];
        const total = pd.total || items.length;
        const completed = pd.completed != null ? pd.completed : items.filter(i => i.checked).length;
        const pct = total ? Math.round((completed / total) * 100) : 0;
        const col = _auditPctColor(pct);
        const muted = completed === 0 ? 'opacity:0.6;' : '';
        const lastBorder = idx === stores.length - 1 ? 'transparent' : '#f0f0f0';

        html += `
        <div onclick="toggleDmAuditAccordion('${store}')" class="lb-row dm-store-head" style="display:grid; grid-template-columns:56px 1fr 92px 18px; align-items:center; gap:12px; border-bottom:1px solid ${lastBorder}; cursor:pointer; padding:13px 15px; ${muted}">
            <span style="font-size:14px; font-weight:900; color:var(--slate-charcoal);">${store}</span>
            <div style="height:8px; border-radius:6px; background:#eef2f6; overflow:hidden;"><div style="height:100%; width:${pct}%; background:${col}; border-radius:6px; transition:width .3s;"></div></div>
            <span style="font-size:13px; font-weight:900; color:${col}; text-align:right;">${completed}/${total} · ${pct}%</span>
            <div id="dm-audit-caret-${store}" class="dm-audit-caret" style="text-align:right; color:#888; font-size:10px; font-weight:800; transition:transform 0.3s; transform:rotate(-90deg);">▼</div>
        </div>`;

        html += `<div id="dm-audit-roster-${store}" class="dm-audit-roster" style="display:none; background:#fdfdfd; padding:10px 18px 14px; border-bottom:1px solid #e2e8f0; box-shadow:inset 0 3px 6px rgba(0,0,0,0.02);">`;
        if (items.length === 0) {
            html += `<div style="font-size:12px; color:#888; text-align:center; font-weight:600; padding:10px 0;">No ${tab} audit items set up yet.</div>`;
        } else {
            let lastSection = null;
            items.forEach(item => {
                if (item.section !== lastSection) {
                    html += `<div style="font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.5px; color:#94a3b8; margin:12px 0 4px;">${escapeHtml(item.section || 'General')}</div>`;
                    lastSection = item.section;
                }
                const done = !!item.checked;
                html += `
                <div style="display:flex; gap:9px; align-items:center; padding:5px 2px;">
                    <span style="font-size:14px; font-weight:900; line-height:1; color:${done ? 'var(--green-go,#16a34a)' : '#cbd5e1'};">${done ? '✓' : '○'}</span>
                    <span style="font-size:13px; font-weight:600; color:${done ? '#94a3b8' : 'var(--slate-charcoal)'}; ${done ? 'text-decoration:line-through;' : ''}">${escapeHtml(item.text)}</span>
                </div>`;
            });
            html += `<div style="margin-top:10px; font-size:12px; font-weight:800; color:${col}; text-align:right;">${completed} of ${total} done ${periodWord}</div>`;
        }
        html += `</div>`;
    });

    html += '</div>';
    cont.innerHTML = html;
}

function _dmLegacyGoalsUnused() {
    // (Superseded by the manager-style DM view above. Kept inert; never called.)
    const cont = { innerHTML: '' };
    const now = new Date();
    const todayStr = '';
    const startOfWeek = new Date(0);
    const currentDmGoalView = 'weekly';
    const stores = [];
    let html = '';
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
        
        // Personal weekly goal = sum of THIS person's daily goals, across
        // whatever roles they held each day (not tied to one fixed role).
        let weekGoalTotal = 0;
        Object.values(dailyStats).forEach(d => { weekGoalTotal += (d.goal || 0); });

        let dailyBreakdownHtml = '<div class="emp-pill-container">';

        daysOfWeek.forEach((dName, dIdx) => {
            if (dailyStats[dName] && dailyStats[dName].goal > 0) {
                dailyBreakdownHtml += `<div class="emp-daily-pill pill-goal">${dName}: ${dailyStats[dName].goal}</div>`;
            } else if (dIdx <= currentDayIdx) {
                dailyBreakdownHtml += `<div class="emp-daily-pill pill-null" title="No role set">${dName}</div>`;
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
                <div class="emp-week-head">
                    <span class="emp-goal-label">THIS WEEK'S GOALS
                        <span class="goals-info-i" data-tip-title="Your weekly goal" data-tip-desc="The sum of your daily listing goals so far this week — across whatever roles you've had each day.">i</span>
                    </span>
                    <span class="emp-week-total" title="Your goal so far this week">${weekGoalTotal || 0}</span>
                </div>
                ${dailyBreakdownHtml}
            </div>

            <div class="goals-levelup" id="emp-goals-levelup"></div>
        `;

        // Store goal in the header + level-up bar (mirrors the manager widget).
        await fetchStoreTarget(store);
        const empTarget = targetFor(store);
        const empStoreTargetEl = document.getElementById('emp-goals-store-target');
        if (empStoreTargetEl) empStoreTargetEl.innerText = `Goal: ${empTarget} Listings`;
        const empLuEl = document.getElementById('emp-goals-levelup');
        if (empLuEl) empLuEl.innerHTML = levelUpHtml(weeksFor(store), empTarget);
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
// 22b. MODULE: B2B DEAL STATUS TRACKER
// ============================================================================

const B2B_STORE_ICONS = { 'OVL': '🟣', 'LEE': '🔵', 'WSP': '🟢', 'MPL': '🟠', 'BAL': '🔴' };
const B2B_STORE_LIST  = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const B2B_CORP_ROLES  = ['district manager', 'ceo', 'tom'];   // can create + leave Location Pending
const B2B_APPROVERS   = ['ceo', 'district manager'];          // can approve
const B2B_STORE_ROLES = ['manager', 'owner (manager)', 'assistant manager']; // store actors

let b2bDealsCache = [];
let b2bCurrentDealId = null;

function b2bMoney(n) {
    return '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function b2bStoreLabel(store) {
    if (!store) return 'Unassigned';
    return `${B2B_STORE_ICONS[store] || '🏬'} ${store}`;
}

function b2bStatusBadge(status) {
    const slug = status.toLowerCase().replace(/\s+/g, '-');
    return `<span class="b2b-badge b2b-badge-${slug}">${status}</span>`;
}

// Who can act on a deal in its current state (UI gating; server enforces transition legality)
function b2bCanAct(deal) {
    const role  = (sessionStorage.getItem('speeksUserRole')  || '').toLowerCase();
    const store = (sessionStorage.getItem('speeksUserStore') || '').toUpperCase();
    switch (deal.status) {
        case 'Location Pending': return B2B_CORP_ROLES.includes(role);
        case 'Pricing':          return B2B_STORE_ROLES.includes(role) && deal.assigned_store === store;
        case 'Approval Pending': return B2B_APPROVERS.includes(role);
        case 'Approved':         return B2B_STORE_ROLES.includes(role) && deal.assigned_store === store;
        default:                 return false;
    }
}

const B2B_PIPELINE = ['Location Pending', 'Pricing', 'Approval Pending', 'Approved'];

async function fetchB2BDeals() {
    const list = document.getElementById('b2bDealList');
    if (!list) return; // not on this page
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase();
    let store = (sessionStorage.getItem('speeksUserStore') || 'ALL').toUpperCase();
    // Corporate roles can pick any store (or ALL) via the board filter
    if (B2B_CORP_ROLES.includes(role)) {
        store = document.getElementById('b2bStoreFilter')?.value || 'ALL';
    }
    try {
        const res = await fetch(`${B2B_URL}?store=${encodeURIComponent(store)}&v=${Date.now()}`);
        b2bDealsCache = await res.json();
        if (!Array.isArray(b2bDealsCache)) b2bDealsCache = [];
        renderB2BDeals();
    } catch (e) {
        list.innerHTML = '<div class="status-message" style="color: var(--red-alert);">Failed to load B2B deals.</div>';
    }
}

// Full-page Kanban-style pipeline: one column per state, deals as cards.
function renderB2BDeals() {
    const board = document.getElementById('b2bDealList');
    if (!board) return;
    const showCompleted = document.getElementById('b2bShowCompleted')?.checked;
    const columns = showCompleted ? [...B2B_PIPELINE, 'Completed'] : B2B_PIPELINE;

    const countEl = document.getElementById('b2b-count');
    if (countEl) {
        const actionable = b2bDealsCache.filter(b2bCanAct).length;
        countEl.textContent = actionable ? `• ${actionable} need${actionable === 1 ? 's' : ''} your action` : '';
    }

    board.innerHTML = columns.map(state => {
        const deals = b2bDealsCache.filter(d => d.status === state);
        const slug = state.toLowerCase().replace(/\s+/g, '-');
        const cards = deals.length
            ? deals.map(d => b2bCardHtml(d)).join('')
            : '<div class="b2b-col-empty">—</div>';
        return `
        <div class="b2b-col b2b-col-${slug}">
            <div class="b2b-col-head">
                ${b2bStatusBadge(state)}
                <span class="b2b-col-count">${deals.length}</span>
            </div>
            <div class="b2b-col-body">${cards}</div>
        </div>`;
    }).join('');
}

function b2bCardHtml(d) {
    const act = b2bCanAct(d);
    const pill = act ? '<span class="b2b-action-pill">Action needed</span>' : '';
    return `
        <div class="b2b-card ${act ? 'b2b-card-actionable' : ''}" onclick="openB2BDeal('${d.id}')">
            <div class="b2b-card-company">${escapeHtml(d.company)}</div>
            <div class="b2b-card-meta">
                <span>📅 ${escapeHtml(d.pickup_date)}</span>
                <span>${b2bStoreLabel(d.assigned_store)}</span>
            </div>
            <div class="b2b-card-totals">
                <span><b>${d.line_count || 0}</b> items · qty <b>${d.total_qty || 0}</b></span>
                <span>Offer <b>${b2bMoney(d.total_offer)}</b></span>
                <span>Value <b>${b2bMoney(d.total_value)}</b></span>
            </div>
            ${pill}
        </div>`;
}

// ----- Create -----
function openB2BCreate() {
    const modal = document.getElementById('b2bCreateModal');
    if (!modal) { console.warn('B2B create modal not found in DOM'); return; }
    const dateEl = document.getElementById('b2bPickupInput');
    if (dateEl && !dateEl.value) {
        dateEl.value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); // YYYY-MM-DD
    }
    const companyEl = document.getElementById('b2bCompanyInput');
    if (companyEl) companyEl.value = '';
    toggleModal('b2bCreateModal');
}

async function createB2BDeal() {
    const company = document.getElementById('b2bCompanyInput').value.trim();
    const pickup  = document.getElementById('b2bPickupInput').value;
    if (!company || !pickup) { alert('Please enter a company and pickup date.'); return; }

    const btn = document.getElementById('b2bCreateBtn');
    btn.disabled = true; btn.innerText = 'Creating...';
    try {
        const res = await fetch(B2B_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
                action: 'create',
                company,
                pickup_date: pickup,
                created_by: sessionStorage.getItem('speeksUserName') || 'Unknown'
            })
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || 'Failed');
        closeAllModals();
        await fetchB2BDeals();
    } catch (e) {
        alert('Could not create deal: ' + e.message);
    } finally {
        btn.disabled = false; btn.innerText = 'Create Deal';
    }
}

// ----- Detail view -----
async function openB2BDeal(id) {
    const deal = b2bDealsCache.find(d => d.id === id);
    if (!deal) return;
    b2bCurrentDealId = id;
    const body = document.getElementById('b2bDetailBody');
    document.getElementById('b2bDetailTitle').innerHTML = `${escapeHtml(deal.company)} ${b2bStatusBadge(deal.status)}`;
    body.innerHTML = '<div class="status-message">Loading items...</div>';

    const modal = document.getElementById('b2bDetailModal');
    closeAllModals();
    modal.classList.add('show');
    lockAndBlurScreen();

    let items = [];
    try {
        const res = await fetch(`${B2B_URL}?deal_id=${encodeURIComponent(id)}&v=${Date.now()}`);
        items = await res.json();
        if (!Array.isArray(items)) items = [];
    } catch (e) { /* show empty */ }
    renderB2BDetail(deal, items);
}

function renderB2BDetail(deal, items) {
    const body = document.getElementById('b2bDetailBody');
    const canAct = b2bCanAct(deal);
    const editable = deal.status === 'Pricing' && canAct;

    let html = `
        <div class="b2b-detail-summary">
            <div><span class="form-label-caps">Pickup</span> ${escapeHtml(deal.pickup_date)}</div>
            <div><span class="form-label-caps">Store</span> ${b2bStoreLabel(deal.assigned_store)}</div>
            <div><span class="form-label-caps">Logged by</span> ${escapeHtml(deal.created_by || '—')}</div>
        </div>`;

    // Location Pending: assign a store
    if (deal.status === 'Location Pending') {
        if (canAct) {
            html += `
            <div class="b2b-assign-box">
                <label class="form-label-caps">Assign to store</label>
                <select id="b2bAssignStore" class="form-input-lg" style="margin-bottom:12px;">
                    ${B2B_STORE_LIST.map(s => `<option value="${s}">${B2B_STORE_ICONS[s]} ${s}</option>`).join('')}
                </select>
                <button class="btn-primary" onclick="assignAndAdvanceB2B('${deal.id}')">Assign &amp; Start Pricing →</button>
            </div>`;
        } else {
            html += '<p class="status-message">Awaiting a store assignment from DM / CEO / TOM.</p>';
        }
        body.innerHTML = html;
        return;
    }

    // Items table (Pricing / Approval Pending / Approved / Completed)
    const totalOffer = items.reduce((s, it) => s + (it.qty_offer_total || 0), 0);
    const totalValue = items.reduce((s, it) => s + (it.qty_value_total || 0), 0);
    const totalQty   = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);

    html += '<div class="b2b-items-wrap"><table class="b2b-items-table"><thead><tr>' +
            '<th>Make</th><th>Model</th><th>Qty</th><th>Unit Value</th><th>Unit Offer</th>' +
            '<th>Value Total</th><th>Offer Total</th>' + (editable ? '<th></th>' : '') +
            '</tr></thead><tbody>';

    if (!items.length) {
        html += `<tr><td colspan="${editable ? 8 : 7}" class="b2b-empty-row">No items added yet.</td></tr>`;
    } else {
        html += items.map(it => editable ? `
            <tr>
                <td><input class="b2b-cell" value="${escapeHtml(it.make)}" onchange="updateB2BItem('${it.id}','make',this.value)"></td>
                <td><input class="b2b-cell" value="${escapeHtml(it.model)}" onchange="updateB2BItem('${it.id}','model',this.value)"></td>
                <td><input class="b2b-cell b2b-cell-num" type="number" min="0" value="${it.quantity}" onchange="updateB2BItem('${it.id}','quantity',this.value)"></td>
                <td><input class="b2b-cell b2b-cell-num" type="number" min="0" step="0.01" value="${it.value}" onchange="updateB2BItem('${it.id}','value',this.value)"></td>
                <td><input class="b2b-cell b2b-cell-num" type="number" min="0" step="0.01" value="${it.offer}" onchange="updateB2BItem('${it.id}','offer',this.value)"></td>
                <td>${b2bMoney(it.qty_value_total)}</td>
                <td>${b2bMoney(it.qty_offer_total)}</td>
                <td><button class="b2b-del-btn" onclick="deleteB2BItem('${it.id}')" title="Remove">✖</button></td>
            </tr>` : `
            <tr>
                <td>${escapeHtml(it.make)}</td>
                <td>${escapeHtml(it.model)}</td>
                <td>${it.quantity}</td>
                <td>${b2bMoney(it.value)}</td>
                <td>${b2bMoney(it.offer)}</td>
                <td>${b2bMoney(it.qty_value_total)}</td>
                <td>${b2bMoney(it.qty_offer_total)}</td>
            </tr>`).join('');
    }

    // Add-item row (Pricing only)
    if (editable) {
        html += `
            <tr class="b2b-add-row">
                <td><input id="b2bNewMake" class="b2b-cell" placeholder="Make"></td>
                <td><input id="b2bNewModel" class="b2b-cell" placeholder="Model"></td>
                <td><input id="b2bNewQty" class="b2b-cell b2b-cell-num" type="number" min="0" value="1"></td>
                <td><input id="b2bNewValue" class="b2b-cell b2b-cell-num" type="number" min="0" step="0.01" placeholder="0"></td>
                <td><input id="b2bNewOffer" class="b2b-cell b2b-cell-num" type="number" min="0" step="0.01" placeholder="0"></td>
                <td colspan="2"></td>
                <td><button class="b2b-add-btn" onclick="addB2BItem('${deal.id}')" title="Add item">＋</button></td>
            </tr>`;
    }

    html += '</tbody><tfoot><tr>' +
            `<td colspan="2"><b>Totals</b></td><td><b>${totalQty}</b></td><td></td><td></td>` +
            `<td><b>${b2bMoney(totalValue)}</b></td><td><b>${b2bMoney(totalOffer)}</b></td>` +
            (editable ? '<td></td>' : '') + '</tr></tfoot></table></div>';

    // Primary state action
    if (canAct) {
        if (deal.status === 'Pricing') {
            html += `<div class="b2b-detail-action"><button class="btn-primary" onclick="advanceB2BDeal('${deal.id}','Submit these items for approval?')">Submit for Approval →</button></div>`;
        } else if (deal.status === 'Approval Pending') {
            html += `<div class="b2b-detail-action"><button class="btn-primary" onclick="advanceB2BDeal('${deal.id}','Approve this deal?')">✓ Approve Deal</button></div>`;
        } else if (deal.status === 'Approved') {
            html += `<div class="b2b-detail-action"><button class="btn-primary" onclick="advanceB2BDeal('${deal.id}','Mark this deal completed and archive it?')">Mark Completed ✓</button></div>`;
        }
    }

    body.innerHTML = html;
}

// ----- State transitions -----
async function assignAndAdvanceB2B(id) {
    const store = document.getElementById('b2bAssignStore')?.value;
    if (!store) return;
    await b2bPost({ action: 'assign_advance', id, assigned_store: store }, 'Could not assign store');
    closeAllModals();
    await fetchB2BDeals();
}

async function advanceB2BDeal(id, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    await b2bPost({ action: 'advance', id }, 'Could not advance deal');
    closeAllModals();
    await fetchB2BDeals();
}

// ----- Item CRUD -----
async function addB2BItem(dealId) {
    const make  = document.getElementById('b2bNewMake').value.trim();
    const model = document.getElementById('b2bNewModel').value.trim();
    const qty   = document.getElementById('b2bNewQty').value;
    const value = document.getElementById('b2bNewValue').value;
    const offer = document.getElementById('b2bNewOffer').value;
    if (!make && !model) { alert('Enter a make or model.'); return; }
    await b2bPost({ action: 'add_item', deal_id: dealId, make, model, quantity: qty, value, offer }, 'Could not add item');
    await openB2BDeal(dealId);   // re-fetch items + re-render
    fetchB2BDeals();             // refresh card totals in background
}

async function updateB2BItem(id, field, value) {
    await b2bPost({ action: 'update_item', id, [field]: value }, 'Could not update item');
    if (b2bCurrentDealId) await openB2BDeal(b2bCurrentDealId);
    fetchB2BDeals();
}

async function deleteB2BItem(id) {
    await b2bPost({ action: 'delete_item', id }, 'Could not remove item');
    if (b2bCurrentDealId) await openB2BDeal(b2bCurrentDealId);
    fetchB2BDeals();
}

async function b2bPost(payload, errLabel) {
    try {
        const res = await fetch(B2B_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'Request failed');
        return out;
    } catch (e) {
        alert(`${errLabel}: ${e.message}`);
        throw e;
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

    const firstName = userName.split(' ')[0];
    const wsTitleEl = document.getElementById('wsTitle');
    if (wsTitleEl) wsTitleEl.innerHTML = `<span>📈</span> ${firstName}'s Workspace`;

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

    // ASM uses the same dashboard layout as the team-member view (no special grid).

    if (userStore !== 'ALL') {
        ['kpiStoreSelect', 'am-kpiStoreSelect', 'weeklyKpiStoreSelect', 'bsStoreSelect', 'vw-primary', 'dmChartStoreSelector', 'mbStoreSelect'].forEach(id => {
            const dropdown = document.getElementById(id);
            if (dropdown && Array.from(dropdown.options).some(opt => opt.value === userStore)) {
                dropdown.value = userStore;
            }
        });
    }

    initMultiStoreSwitcher();
}

// ===== MULTI-STORE MANAGER: global store switcher =====
// A Multi-Store Manager (e.g. Joseph Ortega) oversees more than one store and toggles
// which one the whole dashboard is scoped to. The first entry is the default (and is
// set as their `store` at login). Toggling re-points the session store and reloads, so
// every widget re-scopes through the normal load path. Single-store users never reach
// this code, so their dashboards/feeds are unaffected.
const MULTISTORE_MANAGER_STORES = ['BAL', 'MPL'];

// True if a directory user belongs to a given store's roster. A Multi-Store Manager
// belongs to EVERY store they manage (not just their home store), so they're included
// anywhere a regular store manager would be — variance, listing-goals roster, etc.
function userInStore(user, storeCode) {
    const store = String(storeCode || '').toUpperCase();
    if (String(user.store || '').toUpperCase() === store) return true;
    return String(user.role || '').toLowerCase() === 'multi-store manager'
        && MULTISTORE_MANAGER_STORES.includes(store);
}

// Effective role is 'manager', so multi-store status is tracked via this flag (set at login).
function isMultiStoreManager() {
    return sessionStorage.getItem('speeksMultiStore') === 'true';
}

function setMultiStore(store) {
    const next = String(store || '').toUpperCase();
    if (!next || !MULTISTORE_MANAGER_STORES.includes(next)) return;
    if (next === (sessionStorage.getItem('speeksUserStore') || '').toUpperCase()) return;
    sessionStorage.setItem('speeksUserStore', next);
    location.reload();
}

function initMultiStoreSwitcher() {
    const sw = document.querySelector('.msm-store-switch');
    if (!sw) return;
    if (!isMultiStoreManager()) { sw.style.display = 'none'; return; }
    const sel = sw.querySelector('#msmStoreSelect');
    const current = (sessionStorage.getItem('speeksUserStore') || MULTISTORE_MANAGER_STORES[0]).toUpperCase();
    if (sel) {
        sel.innerHTML = MULTISTORE_MANAGER_STORES
            .map(s => `<option value="${s}" ${s === current ? 'selected' : ''}>${s}</option>`)
            .join('');
    }
    sw.style.display = 'flex';
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
        setTimeout(fetchDmAuditData, 1050);
        // Keep audit readiness live while the DM has the dashboard open.
        if (!window._dmAuditSync) window._dmAuditSync = setInterval(() => {
            if (document.getElementById('dm-audit-container')) fetchDmAuditData();
        }, 60000);
        setTimeout(fetchAndRenderEmployeeGoals, 1100);
        setTimeout(fetchAndRenderEmployeeKPIs, 1200);
        setTimeout(fetchAndDisplayStoreComment, 1500);
        startStoreCommentPolling();
        // Both feed the SAME red bubble, so run them in sequence, not in parallel:
        // a DM/CEO-pushed reminder wins (it's personal + already states the aging
        // count); the generic aging alert only fires if no reminder claimed the
        // bubble. Awaiting avoids the login flicker of one overwriting the other.
        setTimeout(async () => { await checkClaimReminders(); checkAgingClaims(); }, 1600);


        // Pre-load checklist in background so chip + glow appear without opening the panel
        const _clRole = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase();
        if (_clRole === 'manager' || _clRole === 'district manager' || _clRole === 'assistant manager') {
            setTimeout(_prefetchChecklistForChip, 1200);
        }
        // Pre-load the store-audit checklist for its chip (managers + ASMs, not DM)
        if (['manager', 'owner (manager)', 'assistant manager'].includes(_clRole)) {
            setTimeout(_prefetchAuditForChip, 1300);
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
        initWorkspace();
        applyKpiReminder();
        // re-evaluate the weekly-KPI reminder window each minute so it appears/clears live
        setInterval(applyKpiReminder, 60000);
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
    const infoI = e.target.closest('.goals-info-i');
    if (infoI && infoI.dataset.tipTitle) {
        customTooltip.style.setProperty('--tip-color', 'var(--sage-professional)');
        customTooltip.innerHTML = `
            <strong style="display:block; margin-bottom: 6px; color: var(--sage-professional); font-size: 13px;">${infoI.dataset.tipTitle}</strong>
            ${infoI.dataset.tipDesc ? `<span style="font-size: 12px; color: var(--slate-charcoal); line-height: 1.5;">${infoI.dataset.tipDesc}</span>` : ''}`;
        customTooltip.classList.add('show');
        return;
    }

    const awardI = e.target.closest('.award-info-btn');
    if (awardI) {
        const wrap = awardI.closest('.award-card-trophy-wrap');
        const nameEl = wrap ? wrap.querySelector('.award-card-name') : null;
        const title = nameEl ? nameEl.innerText.replace(/\s+/g, ' ').trim() : 'Award';
        customTooltip.style.setProperty('--tip-color', 'var(--sage-professional)');
        customTooltip.innerHTML = `
            <strong style="display:block; margin-bottom: 6px; color: var(--sage-professional); font-size: 13px;">${title}</strong>
            ${awardI.dataset.desc ? `<span style="font-size: 12px; color: var(--slate-charcoal); line-height: 1.5;">${awardI.dataset.desc}</span>` : ''}`;
        customTooltip.classList.add('show');
        return;
    }

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
        const titleText = titleEl ? titleEl.innerText.trim() : '';
        const descText  = descEl  ? descEl.innerText.trim()  : '';
        if (titleText || descText) {
            const color = panelItem.classList.contains('cpb-initiative-item') ? '#f59e0b'
                        : panelItem.classList.contains('mgb-goal-item')       ? '#5a8d3b'
                        : '#3b82f6';
            customTooltip.style.setProperty('--tip-color', color);
            customTooltip.innerHTML = `
                <strong style="display:block; margin-bottom: 6px; font-size: 13px; color: var(--slate-charcoal);">${titleText}</strong>
                ${descText ? `<span style="font-size: 12px; color: #64748b; line-height: 1.4;">${descText}</span>` : ''}`;
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
        let x = e.pageX - customTooltip.offsetWidth - 15;
        let y = e.pageY + 15;

        if (x < 10) x = 10;
        if (y + customTooltip.offsetHeight > window.innerHeight - 20) {
            y = e.pageY - customTooltip.offsetHeight - 10;
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
                    if (typeof applyKpiReminder === 'function') applyKpiReminder();
                    if (document.querySelector('.ws-wrap') && typeof initWorkspace === 'function') initWorkspace();
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

function onAnnDocSelected(input) {
    const file = input.files?.[0];
    const nameEl = document.getElementById('annDocFileName');
    const clearBtn = document.getElementById('annDocClear');
    if (file) {
        nameEl.textContent = file.name;
        if (clearBtn) clearBtn.style.display = 'inline-flex';
    }
}

function clearAnnDoc() {
    const input = document.getElementById('annDocInput');
    const nameEl = document.getElementById('annDocFileName');
    const clearBtn = document.getElementById('annDocClear');
    if (input) input.value = '';
    if (nameEl) nameEl.textContent = 'No file selected';
    if (clearBtn) clearBtn.style.display = 'none';
}

async function publishAnnouncement() {
    const title = document.getElementById('annTitleInput').value.trim();
    const body = document.getElementById('annBodyInput').innerHTML.trim();
    const isPriority = document.getElementById('annPriorityInput').checked;
    const btn = document.getElementById('publishAnnBtn');
    const fileInput = document.getElementById('annDocInput');
    const file = fileInput?.files?.[0];

    if (!title || !body) {
        alert("Wait! You must fill out both a Title and a Message before publishing.");
        return;
    }

    btn.innerHTML = "Publishing... ⏳";
    btn.style.opacity = "0.7";
    btn.style.pointerEvents = "none";

    let docUrl = null;
    let docName = null;

    if (file) {
        btn.innerHTML = "Uploading document... ⏳";
        try {
            const safeName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const uploadResp = await fetch(
                `${_SUPABASE_URL}/storage/v1/object/ann-docs/${safeName}`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${_SUPABASE_ANON_KEY}`,
                        'apikey': _SUPABASE_ANON_KEY,
                        'Content-Type': file.type || 'application/octet-stream',
                        'x-upsert': 'true'
                    },
                    body: file
                }
            );
            if (uploadResp.ok) {
                docUrl = `${_SUPABASE_URL}/storage/v1/object/public/ann-docs/${safeName}`;
                docName = file.name;
            } else {
                const err = await uploadResp.text();
                console.error('Document upload failed:', err);
                alert('Document upload failed. The announcement will be published without the attachment.');
            }
        } catch (e) {
            console.error('Document upload error:', e);
            alert('Document upload failed. The announcement will be published without the attachment.');
        }
        btn.innerHTML = "Publishing... ⏳";
    }

    let compiledMessage = "";
    if (isPriority) {
        compiledMessage += `<span style="color: #ef4444; font-weight: 900; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">🚨 HIGH PRIORITY</span><br>`;
    }
    compiledMessage += `<strong style="font-size: 16px; color: var(--slate-charcoal); display: block; margin-bottom: 8px;">${title}</strong>`;
    compiledMessage += body;

    const payload = {
        type: 'publish',
        text: compiledMessage,
        author: sessionStorage.getItem('speeksUserName') || 'Executive Team',
        high_priority: isPriority,
        doc_url: docUrl,
        doc_name: docName
    };

    try {
        const resp = await fetch(CMS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) throw new Error(`Server error ${resp.status}`);
        alert("Success! Your announcement has been published to all stores.");
        document.getElementById('annTitleInput').value = '';
        document.getElementById('annBodyInput').innerHTML = '';
        document.getElementById('annPriorityInput').checked = false;
        clearAnnDoc();
        closeAllModals();
        if (typeof syncAllData === 'function') syncAllData();
    } catch (error) {
        console.error("Error publishing announcement:", error);
        alert("Failed to publish announcement. Please try again.");
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

        // Rate values are stored as the percentage number itself (e.g. 99.49 = 99.49%);
        // strip any stray '%' the value may carry and show the number as-is.
        return parseFloat(str.replace(/[^0-9.-]/g, '')).toFixed(2);
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
        const res = await fetch(EBAY_ALERTS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: updatedAlerts })
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Save failed');

        alert("eBay Performance Metrics successfully updated!");
        closeAllModals();
        if (typeof fetchAlertsData === 'function') fetchAlertsData();
        if (typeof fetchMasterDistrictDashboard === 'function') fetchMasterDistrictDashboard();

    } catch (e) {
        console.error(e);
        alert("Failed to save metrics: " + (e.message || e));
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

// ===== DM: MANAGER CHECKLIST (required tasks pushed to managers) =====
// Lets the District Manager create/edit/remove the "required" (non-deletable)
// checklist items managers see, targeted at specific stores per time period.
const MCL_PERIOD_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly' };

function _mclRole() {
    return (sessionStorage.getItem('speeksUserRole') || '').toLowerCase();
}

async function toggleManagerChecklist() {
    const dropdown = document.getElementById('managerChecklistDropdown');
    if (!dropdown) return;

    const isOpen = dropdown.classList.contains('show');
    closeAllModals();
    if (isOpen) return;

    dropdown.classList.add('show');
    lockAndBlurScreen();

    // Reset the add form to a clean state each time it opens
    const text = document.getElementById('mcl-text'); if (text) text.value = '';
    const period = document.getElementById('mcl-period'); if (period) period.value = 'daily';
    document.querySelectorAll('#mcl-stores input[type="checkbox"]').forEach(c => c.checked = false);
    // Default the view filter back to "All stores" (the tasks the DM created)
    const filter = document.getElementById('mcl-filter-store'); if (filter) filter.value = '';
    applyChecklistFilter('');
}

// The "Viewing" dropdown at the top of the Manager Checklist tool:
//  - ""    → all required tasks the DM created (across every store)
//  - store → that store's FULL checklist (DM-required + manager-added), all deletable
function applyChecklistFilter(store) {
    const label = document.getElementById('mcl-list-label');
    if (!store) {
        if (label) label.textContent = 'Current required tasks (all stores)';
        loadRequiredTasks();
    } else {
        if (label) label.textContent = `${store} checklist — required + manager-added`;
        loadStoreChecklistView(store);
    }
}

function mclToggleAllStores() {
    const boxes = [...document.querySelectorAll('#mcl-stores input[type="checkbox"]')];
    const allOn = boxes.length > 0 && boxes.every(b => b.checked);
    boxes.forEach(b => b.checked = !allOn);
}

async function loadRequiredTasks() {
    const list = document.getElementById('mcl-list');
    if (!list) return;
    list.innerHTML = '<div class="status-message">Loading required tasks…</div>';
    try {
        const res = await fetch(`${CHECKLIST_URL}?action=listRequired&v=${Date.now()}`);
        const data = await res.json();
        renderRequiredTasks(data.tasks || []);
    } catch (e) {
        list.innerHTML = '<div class="status-message" style="color: var(--red-alert);">Failed to load required tasks.</div>';
    }
}

function renderRequiredTasks(tasks) {
    const list = document.getElementById('mcl-list');
    if (!list) return;

    if (!tasks.length) {
        list.innerHTML = '<div style="text-align:center; padding:18px; color:#94a3b8; font-size:12px; font-weight:600;">No required tasks yet. Add one above.</div>';
        return;
    }

    const order = ['daily', 'weekly', 'monthly', 'quarterly'];
    const byPeriod = {};
    tasks.forEach(t => { (byPeriod[t.tab] = byPeriod[t.tab] || []).push(t); });

    let html = '';
    order.forEach(period => {
        const items = byPeriod[period];
        if (!items || !items.length) return;
        html += `<div class="mcl-group-label">${MCL_PERIOD_LABELS[period] || period}</div>`;
        items.forEach(t => {
            const badges = (t.stores || []).length
                ? t.stores.map(s => `<span class="mcl-badge">${s === 'CORP' ? 'Corp' : s}</span>`).join('')
                : '<span class="mcl-badge mcl-badge-none">No stores</span>';
            html += `
            <div class="mcl-row" data-id="${t.id}">
                <div class="mcl-row-main">
                    <span class="mcl-row-text">${escapeHtml(t.text)}</span>
                    <div class="mcl-row-badges">${badges}</div>
                </div>
                <div class="mcl-row-actions">
                    <button class="mcl-edit-btn" title="Edit task text" onclick="editRequiredTask('${t.id}')">✎</button>
                    <button class="mcl-del-btn" title="Delete for all managers" onclick="deleteRequiredTask('${t.id}')">✖</button>
                </div>
            </div>`;
        });
    });
    list.innerHTML = html;
}

// --- DM: view ONE store's full checklist — both the required tasks the DM set
//     and the personal tasks that store's manager added themselves. Read-only.
function _resolveStoreManager(store) {
    try {
        const authCache = JSON.parse(localStorage.getItem('speeksAuthCache')) || {};
        const users = authCache.users || [];
        for (const targetRole of ['owner (manager)', 'manager']) {
            const mgr = users.find(u =>
                u.store && u.store.toUpperCase() === String(store).toUpperCase() &&
                u.role && u.role.toLowerCase() === targetRole
            );
            if (mgr) return mgr.name;
        }
    } catch (e) {}
    return null;
}

async function loadStoreChecklistView(store) {
    const out = document.getElementById('mcl-list');
    if (!out) return;
    if (!store) { loadRequiredTasks(); return; }

    const mgr = _resolveStoreManager(store);
    if (!mgr) {
        out.innerHTML = `<div class="status-message" style="color:var(--red-alert);">No manager found for ${escapeHtml(store)} in the directory.</div>`;
        return;
    }
    out.innerHTML = `<div class="status-message">Loading ${escapeHtml(store)}'s checklist…</div>`;
    try {
        // The store's full checklist + the required-task master, so we can resolve
        // each global item back to its required-task id for deletion.
        const [data, reqResp] = await Promise.all([
            fetch(`${CHECKLIST_URL}?user=${encodeURIComponent(mgr)}&store=${encodeURIComponent(store)}&v=${Date.now()}`).then(r => r.json()),
            fetch(`${CHECKLIST_URL}?action=listRequired&v=${Date.now()}`).then(r => r.json()),
        ]);
        renderStoreChecklistView(store, mgr, data || {}, (reqResp && reqResp.tasks) || []);
    } catch (e) {
        out.innerHTML = `<div class="status-message" style="color:var(--red-alert);">Failed to load that store's checklist.</div>`;
    }
}

function renderStoreChecklistView(store, mgr, data, requiredTasks) {
    const out = document.getElementById('mcl-list');
    if (!out) return;
    const order = ['daily', 'weekly', 'monthly', 'quarterly'];
    const norm = s => String(s || '').trim().toLowerCase();
    const upper = s => String(s || '').toUpperCase();
    // Map a global checklist item back to the required task it came from.
    const findReqId = (tab, txt) => {
        const exact = requiredTasks.find(t => t.tab === tab && norm(t.text) === norm(txt) &&
            (t.stores || []).map(upper).includes(upper(store)));
        if (exact) return exact.id;
        const any = requiredTasks.find(t => t.tab === tab && norm(t.text) === norm(txt));
        return any ? any.id : null;
    };

    let html = `<div style="font-size:12px; font-weight:700; color:#64748b; margin:4px 0 10px;">Showing <strong style="color:var(--slate-charcoal);">${escapeHtml(store)}</strong> · manager <strong style="color:var(--slate-charcoal);">${escapeHtml(mgr)}</strong></div>`;
    let any = false;
    order.forEach(period => {
        const items = data[period] || [];
        if (!items.length) return;
        any = true;
        html += `<div class="mcl-group-label">${MCL_PERIOD_LABELS[period] || period}</div>`;
        items.forEach(it => {
            const check = it.checked ? `<span style="color:#16a34a; font-weight:800; margin-right:5px;">✓</span>` : '';
            let badge, delBtn;
            if (it.isGlobal) {
                const reqId = findReqId(period, it.text);
                badge = `<span class="mcl-badge" style="background:#e0e7ff; color:#4338ca;">Required</span>`;
                delBtn = `<button class="mcl-del-btn" title="Delete required task (removes it for every store it applies to)" onclick="deleteRequiredFromStoreView('${reqId}', '${store}')">✖</button>`;
            } else {
                badge = `<span class="mcl-badge" style="background:#dcfce7; color:#15803d;">Manager-added</span>`;
                delBtn = `<button class="mcl-del-btn" title="Delete this manager-added task" onclick="deleteStorePersonalItem('${store}', '${period}', '${it.id}')">✖</button>`;
            }
            html += `
            <div class="mcl-row">
                <div class="mcl-row-main">
                    <span class="mcl-row-text">${check}${escapeHtml(it.text)}</span>
                    <div class="mcl-row-badges">${badge}</div>
                </div>
                <div class="mcl-row-actions">${delBtn}</div>
            </div>`;
        });
    });
    if (!any) html += `<div style="text-align:center; padding:14px; color:#94a3b8; font-size:12px; font-weight:600;">No checklist items for this store.</div>`;
    out.innerHTML = html;
}

// DM deletes a manager-added (personal) task on that store's behalf. We send the
// DM's role + identity so the backend can authorize a cross-user delete (the
// `delete` handler must allow district manager / ceo to remove ANY user's item).
async function deleteStorePersonalItem(store, tab, id) {
    if (!confirm('Delete this manager-added task? This cannot be undone.')) return;
    const mgr = _resolveStoreManager(store);
    try {
        await postWrite(CHECKLIST_URL, {
            action: 'delete', id, tab, user: mgr, store,
            role: _mclRole(),
            requestedBy: sessionStorage.getItem('speeksUserName') || '',
        });
        loadStoreChecklistView(store);
    } catch (e) {
        alert('Could not delete: ' + (e.message || e));
    }
}

// DM deletes a required task from inside the per-store view (then reloads that view).
async function deleteRequiredFromStoreView(id, store) {
    if (!id || id === 'null') {
        alert('Could not resolve this required task — delete it from the "All stores" list instead.');
        return;
    }
    if (!confirm('Delete this required task for every store it applies to? This cannot be undone.')) return;
    try {
        await postWrite(CHECKLIST_URL, { action: 'deleteRequired', id, role: _mclRole() });
        loadStoreChecklistView(store);
    } catch (e) {
        alert('Could not delete: ' + (e.message || e));
    }
}

async function addRequiredTask() {
    const btn = document.getElementById('mcl-add-btn');
    const text = (document.getElementById('mcl-text').value || '').trim();
    const tab = document.getElementById('mcl-period').value;
    const stores = [...document.querySelectorAll('#mcl-stores input[type="checkbox"]:checked')].map(c => c.value);

    if (!text) { alert('Enter the task text.'); return; }
    if (!stores.length) { alert('Pick at least one store this task applies to.'); return; }

    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
        await postWrite(CHECKLIST_URL, {
            action: 'addRequired',
            tab, text, stores,
            user: sessionStorage.getItem('speeksUserName') || '',
            role: _mclRole()
        });
        document.getElementById('mcl-text').value = '';
        document.querySelectorAll('#mcl-stores input[type="checkbox"]').forEach(c => c.checked = false);
        await loadRequiredTasks();
    } catch (e) {
        alert('Could not add task: ' + (e.message || e));
    } finally {
        btn.disabled = false;
        btn.textContent = '+ Add Required Task';
    }
}

async function deleteRequiredTask(id) {
    if (!confirm('Delete this required task for all managers it applies to? This cannot be undone.')) return;
    try {
        await postWrite(CHECKLIST_URL, { action: 'deleteRequired', id, role: _mclRole() });
        await loadRequiredTasks();
    } catch (e) {
        alert('Could not delete task: ' + (e.message || e));
    }
}

async function editRequiredTask(id) {
    const row = document.querySelector(`.mcl-row[data-id="${id}"]`);
    if (!row) return;
    const current = row.querySelector('.mcl-row-text').textContent;
    const next = prompt('Edit task text:', current);
    if (next === null) return; // cancelled
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    try {
        await postWrite(CHECKLIST_URL, { action: 'editRequired', id, text: trimmed, role: _mclRole() });
        await loadRequiredTasks();
    } catch (e) {
        alert('Could not edit task: ' + (e.message || e));
    }
}

// --- DM SCORECARD SUBMISSION LOGIC ---
// The SPEEKS Scorecard is now just the former "Media and Markets" four
// categories, renamed "Online & Marketing" — the only thing the DM/CEO score
// by hand. (In-Store Operations + Store Reviews were retired; the PayMore
// practice Audit below now covers store condition.)
const SCORECARD_CATEGORIES = [
    "Online Store Pictures",
    "5 Facebook Listings",
    "2 Social Media Posts",
    "PayMore Sync"
];

const SCORECARD_BUCKETS = [
    { label: "Online & Marketing", count: 4 }
];

// ============================================================================
// PayMore practice Audit — exact transcription of Audit Playbook v3 (165 pts,
// 94 items, 8 sections). Binary scoring: checked = full points, else 0.
// Pass = 80%, target = 90%+. Shared shape with the scorecard edge fn, which
// re-derives earned/possible from the same point values (server-authoritative).
// ============================================================================
const AUDIT_TARGET_PCT = 90;
const AUDIT_PASS_PCT = 80;
const AUDIT_DEFINITION = [
    { key: "exterior", title: "Exterior", items: [
        { id: "ex1", pts: 1, text: "Sidewalks and entryways free of litter, debris, and obstructions" },
        { id: "ex2", pts: 1, text: "Exterior and road signage clean, lit (if applicable), free of damage or fading" },
        { id: "ex3", pts: 1, text: "Building exterior clean, well-maintained (windows, paint, no handmade signs on doors). Window decals and signage appropriate. Door hours match website" },
    ]},
    { key: "entry", title: "Entry & Sales Floor", items: [
        { id: "ef1", pts: 1, text: "Floors swept/mopped; entry mats clean" },
        { id: "ef2", pts: 1, text: "Customer area free of clutter; no products stored on the floor" },
        { id: "ef3", pts: 1, text: "Video games displayed on shelves and organized" },
        { id: "ef4", pts: 1, text: "Store lighting fully functional throughout (no burned out bulbs, adequate brightness and clean)" },
        { id: "ef5", pts: 1, text: "Walls, vents, and high surfaces free of dust and cobwebs" },
        { id: "ef6", pts: 2, text: "Ceiling tiles in place and in good shape; less than 10% of tiles with no water damage" },
        { id: "ef7", pts: 1, text: "Window ledges and sills clean; free of merchandise or debris" },
        { id: "ef8", pts: 1, text: "No recycling items in customer view" },
        { id: "ef9", pts: 1, text: "All customers greeted within 10 seconds of entering the store" },
        { id: "ef10", pts: 2, text: "Team acknowledges entering customers even while helping others" },
        { id: "ef11", pts: 1, text: "Customers asked for Google review at end of transaction" },
        { id: "ef12", pts: 1, text: "No QR codes or signage for Google review signage in transaction area" },
        { id: "ef13", pts: 1, text: "Music playing from RockBot system and volume is appropriate" },
        { id: "ef14", pts: 3, text: "Retail Browsing iPads on and locked to store website" },
    ]},
    { key: "display", title: "Display Cases & Merchandising", items: [
        { id: "dc1", pts: 1, text: "Display case glass is clean and fingerprint-free" },
        { id: "dc2", pts: 1, text: "Devices organized by category (i.e. all mobile phones together, tablets etc)" },
        { id: "dc3", pts: 1, text: "Phones and tablets positioned back-facing" },
        { id: "dc4", pts: 2, text: "Small items in PayMore stands; tags NOT visible to customers" },
        { id: "dc5", pts: 1, text: "Shelves full but not overcrowded; visually balanced" },
        { id: "dc6", pts: 2, text: "Gaming items: clean/dusted, organized by category (consoles together, cords, accessories, etc)" },
        { id: "dc7", pts: 2, text: "Consoles positioned on shelves; shelves are full but not overcrowded/balanced visually" },
        { id: "dc8", pts: 2, text: "Gaming small items in PayMore stands; tags NOT visible" },
        { id: "dc9", pts: 3, text: "All items in clean PayMore stands; tags NOT visible" },
        { id: "dc10", pts: 2, text: "All items forward-facing (excluding phones/tablets)" },
        { id: "dc11", pts: 3, text: "High-priced items (Apple phones, tablets) in locked case" },
        { id: "dc12", pts: 2, text: "Retail glass in good shape and clean — no cracks, scratches, or broken areas" },
    ]},
    { key: "counter", title: "Retail Counter", items: [
        { id: "rc1", pts: 1, text: "Counter neatly arranged, no clutter, no un-branded signage" },
        { id: "rc2", pts: 1, text: "Testing equipment out of customer view" },
        { id: "rc3", pts: 1, text: "Completed transactions out of customer view" },
        { id: "rc4", pts: 1, text: "Printer stored in cabinet underneath" },
        { id: "rc5", pts: 1, text: "No team member food or drink in customer view" },
        { id: "rc6", pts: 1, text: "PayMore branded retail bags stocked" },
        { id: "rc7", pts: 2, text: "All computers do not have any personal accounts open" },
        { id: "rc8", pts: 1, text: "PayMore branded signage at counter; Freedom to Trade In trifold nearby; promo materials in plexi frames (not taped)" },
    ]},
    { key: "buy", title: "Buy Transaction Area", items: [
        { id: "bt1", pts: 3, text: "Counter neatly arranged; no unbranded signage; testing equipment out of view (cables, gaming controllers, flashlights, etc); printer under cabinet" },
        { id: "bt2", pts: 1, text: "Completed transactions out of customer view" },
        { id: "bt3", pts: 2, text: "Diagnostic device/testing software present and stored out of view. Spec-Finder thumb drive available" },
        { id: "bt4", pts: 2, text: "Screen-display tester present; in-cabinet testing monitors working (may be covered with a PayMore branded mat)" },
        { id: "bt5", pts: 1, text: "Cable management for customer-facing monitors: cords neatly tied and snaked through the cabinet" },
        { id: "bt6", pts: 1, text: "Charger/cable tester present" },
        { id: "bt7", pts: 2, text: "PayMore Seller Book under the counter" },
        { id: "bt8", pts: 3, text: "Last 10 transactions: at least one signature on each page half on/off sticker" },
        { id: "bt9", pts: 7, text: "Green bin (<$100), Red bin (>$100), Blue bin (video games) — labeled (not handwritten), out of view; items bubble-wrapped with purchase order receipt" },
        { id: "bt10", pts: 3, text: "Larger items in white boxes: purchase order attached, bubble-wrapped, on shelving or neatly stacked on back counter (must be in boxes)" },
        { id: "bt11", pts: 3, text: "All intake merchandise logged immediately; no untagged or unlogged items" },
        { id: "bt12", pts: 4, text: "Cash drawer locked; keys out of customer reach" },
    ]},
    { key: "boh", title: "Back of House", items: [
        { id: "bh1", pts: 1, text: "Floors swept and clean" },
        { id: "bh2", pts: 2, text: "Walls in good condition (no holes). No stickers from customer devices stuck to the walls" },
        { id: "bh3", pts: 1, text: "Ceiling tiles in good shape (no missing tiles, no water damage)" },
        { id: "bh4", pts: 2, text: "Holding shelves labeled (A, B, C, D, etc.). Not handwritten" },
        { id: "bh5", pts: 1, text: "Holding shelves have colored bins (Green/Red/Blue), labeled correctly, not handwritten" },
        { id: "bh6", pts: 1, text: "Items in bins are bubble wrapped" },
        { id: "bh7", pts: 1, text: "All items tagged with purchase order and visible" },
        { id: "bh8", pts: 1, text: "Location on purchase order receipt matches shelf location" },
        { id: "bh9", pts: 2, text: "Shelves are organized and neat; all large items in boxes" },
        { id: "bh10", pts: 1, text: "Items in holding bins have the Shopify barcode" },
        { id: "bh11", pts: 2, text: "Ready-to-purchase shelves labeled (1, 2, 3, etc.). Not handwritten" },
        { id: "bh12", pts: 2, text: "Black bins present, labeled correctly (E1, E2, etc.); items bubble-wrapped, not handwritten" },
        { id: "bh13", pts: 1, text: "Boxes on ready-to-purchase shelves have Shopify barcode displayed" },
        { id: "bh14", pts: 3, text: "Ready-to-purchase shelves organized and neat; all large items in boxes; items tagged" },
        { id: "bh15", pts: 1, text: "Listing Station: barcode label printer present" },
        { id: "bh16", pts: 3, text: "Listing Station: Lenovo computer present, clean and organized" },
        { id: "bh17", pts: 3, text: "Testing Area: device cleaning material, external monitor, charging cables neat" },
        { id: "bh18", pts: 1, text: "Testing Area: troubleshooting accessories present (controllers, Spec-Finder, flash drives)" },
        { id: "bh19", pts: 2, text: "Testing Area: clean and organized" },
        { id: "bh20", pts: 2, text: "Shipping Area: bubble wrap/peanuts; unused boxes neatly stacked by size" },
        { id: "bh21", pts: 5, text: "Shipping Area: Lenovo computer, shipping label printer, scale, box re-adjusting tool, scanner present" },
        { id: "bh22", pts: 2, text: "Shipping Area: clean and organized" },
        { id: "bh23", pts: 4, text: "Photography Area: photo box or well-lit table with clean white butcher paper on a roll" },
        { id: "bh24", pts: 1, text: "Adequate lighting throughout all back-of-house areas" },
        { id: "bh25", pts: 1, text: "Recycling in proper containers; not stored on floor" },
        { id: "bh26", pts: 1, text: "All storage closets clean and organized" },
    ]},
    { key: "personnel", title: "Personnel & Appearance", items: [
        { id: "pa1", pts: 1, text: "PayMore Polo shirt worn. No T-shirt, vests, sweatshirts, etc" },
        { id: "pa2", pts: 1, text: "Khaki pants or jeans — no shorts, not faded, in good condition" },
        { id: "pa3", pts: 1, text: "Optional PayMore branded hat worn forward, or backwards during a transaction" },
        { id: "pa4", pts: 1, text: "Closed-toed shoes worn" },
        { id: "pa5", pts: 1, text: "No headphones or earbuds (unless testing a device)" },
        { id: "pa6", pts: 1, text: "Team members conducting themselves professionally" },
    ]},
    { key: "safety", title: "Safety & Security", items: [
        { id: "ss1", pts: 3, text: "Fire extinguishers tagged, charged, and hung 3.5–5 feet above the floor" },
        { id: "ss2", pts: 2, text: "First aid kit stocked according to OSHA requirements" },
        { id: "ss3", pts: 2, text: "Back door locked from outside, openable from inside without keys or bolts; no obstructions" },
        { id: "ss4", pts: 4, text: "Safe is locked; cash/bank deposits not sitting out" },
        { id: "ss5", pts: 5, text: "Store fully open and purchasing during all posted business hours" },
        { id: "ss6", pts: 2, text: "Labor law / workplace compliance poster displayed on the wall" },
        { id: "ss7", pts: 1, text: "All aisles have 32-inch clearance; no products/devices stored on the floor, unless too large to fit on the rack/shelf" },
        { id: "ss8", pts: 1, text: "All products on shelves at least 18 inches from the ceiling" },
        { id: "ss9", pts: 1, text: "All products clear from sprinkler systems" },
        { id: "ss10", pts: 4, text: "Restrooms: clean, maintained, stocked with soap, TP, paper towels" },
        { id: "ss11", pts: 1, text: "Restroom garbage not overflowing" },
        { id: "ss12", pts: 1, text: "No personal pictures, posters, stickers, political signage posted throughout the store" },
        { id: "ss13", pts: 1, text: "Second Hand License posted per state/country law. Hung in a glass case or framed, not taped/stapled. Record expiration" },
    ]},
];

// Total possible audit points (derived, = 165) and a quick id→{pts,text,section} lookup.
const AUDIT_POSSIBLE = AUDIT_DEFINITION.reduce((s, sec) => s + sec.items.reduce((a, i) => a + i.pts, 0), 0);
const AUDIT_ITEM_MAP = (() => {
    const m = {};
    AUDIT_DEFINITION.forEach(sec => sec.items.forEach(i => { m[i.id] = { pts: i.pts, text: i.text, section: sec.title }; }));
    return m;
})();

// Audit color by percentage: target 90+ green, pass 80+ amber, else red.
function auditPctColor(pct) {
    if (pct >= AUDIT_TARGET_PCT) return { bg: '#d1fae5', fg: '#059669' };
    if (pct >= AUDIT_PASS_PCT) return { bg: '#fef3c7', fg: '#d97706' };
    return { bg: '#fee2e2', fg: '#dc2626' };
}

function openScorecardModal() {
    toggleModal('scorecardSubmitModal');

    const dateInput = document.getElementById('dm-score-date');
    if (dateInput) dateInput.valueAsDate = new Date();

    switchScoreTab('scorecard');
    _buildScorecardModalInputs();
    renderAuditEntry();
}

// ---- Submit-modal tab switching (Scorecard | SPEEKS Audit) ----
let currentScoreTab = 'scorecard';
function switchScoreTab(tab) {
    currentScoreTab = tab;
    const scTab = document.getElementById('sc-tab-scorecard');
    const auTab = document.getElementById('sc-tab-audit');
    if (scTab) scTab.classList.toggle('active', tab === 'scorecard');
    if (auTab) auTab.classList.toggle('active', tab === 'audit');
    const scPanel = document.getElementById('sc-panel-scorecard');
    const auPanel = document.getElementById('sc-panel-audit');
    if (scPanel) scPanel.style.display = tab === 'scorecard' ? 'block' : 'none';
    if (auPanel) auPanel.style.display = tab === 'audit' ? 'block' : 'none';
    const scBtn = document.getElementById('submitScorecardBtn');
    const auBtn = document.getElementById('submitAuditBtn');
    if (scBtn) scBtn.style.display = tab === 'scorecard' ? '' : 'none';
    if (auBtn) auBtn.style.display = tab === 'audit' ? '' : 'none';
}

function onScoreStoreChange() {
    _buildScorecardModalInputs();
    renderAuditEntry();
}
function onScoreDateChange() {
    renderAuditEntry();
}

function _buildScorecardModalInputs() {
    const storeEl = document.getElementById('dm-store-select');
    const store = (storeEl ? storeEl.value : null) || sessionStorage.getItem('speeksUserStore') || '';
    const existingEntry = (window._scorecardAllData || []).find(d => String(d.store).toUpperCase() === store.toUpperCase());

    const container = document.getElementById('dm-category-inputs');
    if (!container) return;
    let html = '';
    let catIndex = 0;
    SCORECARD_BUCKETS.forEach((bucket, bIdx) => {
        const existingBucket = existingEntry && existingEntry.buckets
            ? existingEntry.buckets.find(b => b.name === bucket.label)
            : null;
        const existingNote = existingBucket && existingBucket.notes ? existingBucket.notes : '';
        html += `<div style="grid-column: 1 / -1; margin-top: ${bIdx > 0 ? '8px' : '0'}; padding-bottom: 4px; border-bottom: 1px solid #e2e8f0;">
                <span style="font-size: 10px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;">${bucket.label}</span>
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
        const escapedNote = existingNote.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        html += `<div style="grid-column: 1 / -1; margin-top: 4px; margin-bottom: 2px;">
                <label class="form-label-caps" style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">Section Notes <span style="font-weight: 400; text-transform: none; font-size: 10px; color: #94a3b8; letter-spacing: 0;">(optional)</span></label>
                <textarea id="score-notes-${bIdx}" class="scorecard-notes-input" rows="2" placeholder="Leave a note for the manager about this section...">${escapedNote}</textarea>
            </div>`;
        html += `</div>`;
    });
    container.innerHTML = html;
}

function refreshScorecardNotes() {
    _buildScorecardModalInputs();
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

    // Gather scores and notes per section
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
        const noteEl = document.getElementById(`score-notes-${bIdx}`);
        const notes = noteEl ? noteEl.value.trim() : '';
        if (enabled) sectionData.push({ bucketIndex: bIdx, scores: scores, notes: notes });
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
            scores: sectionData.flatMap(s => s.scores),
            sectionNotes: sectionData.map(s => s.notes)
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

// ============================================================================
// SPEEKS AUDIT — entry form (in the submit modal) + read-only breakdown popout.
// Uses AUDIT_DEFINITION / AUDIT_ITEM_MAP / AUDIT_POSSIBLE defined near the top.
// ============================================================================

// Returns the cached latest audit for the modal's selected store (or null).
function _selectedStoreAudit() {
    const store = (document.getElementById('dm-store-select')?.value || '').toUpperCase();
    const entry = (window._scorecardAllData || []).find(d => String(d.store).toUpperCase() === store);
    return entry && entry.audit ? entry.audit : null;
}

// Build the collapsible audit checklist. If an audit already exists for the
// selected store AND the chosen date matches it, pre-check its results (edit mode).
function renderAuditEntry() {
    const container = document.getElementById('audit-entry-container');
    if (!container) return;
    const dateVal = document.getElementById('dm-score-date')?.value || '';
    const existing = _selectedStoreAudit();
    const prefill = (existing && existing.date === dateVal && existing.results) ? existing.results : {};
    const auditorEl = document.getElementById('dm-audit-auditor');
    if (auditorEl) auditorEl.value = (existing && existing.date === dateVal && existing.auditor) ? existing.auditor : '';

    let html = '';
    AUDIT_DEFINITION.forEach((sec, sIdx) => {
        const secTotal = sec.items.reduce((a, i) => a + i.pts, 0);
        html += `<div class="audit-entry-section" style="border:1px solid #e2e8f0; border-radius:10px; margin-bottom:10px; overflow:hidden;">
            <div onclick="toggleAuditEntrySection(${sIdx})" style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:11px 13px; background:#f8fafc; cursor:pointer;">
                <span style="font-size:12px; font-weight:800; color:var(--slate-charcoal); text-transform:uppercase; letter-spacing:.4px;">${sec.title}</span>
                <span style="display:flex; align-items:center; gap:8px;">
                    <span id="audit-sec-sub-${sIdx}" style="font-size:11px; font-weight:900; color:#64748b; background:#fff; border:1px solid #e2e8f0; padding:3px 0; border-radius:6px; display:inline-block; min-width:56px; text-align:center;">0/${secTotal}</span>
                    <span id="audit-sec-caret-${sIdx}" style="color:#94a3b8; font-size:10px; font-weight:800; transition:transform .2s; transform:rotate(-90deg);">▼</span>
                </span>
            </div>
            <div id="audit-sec-body-${sIdx}" style="display:none; padding:6px 13px 11px;">`;
        sec.items.forEach(item => {
            const aw = _prefillAward(prefill[item.id], item.pts);
            let control;
            if (item.pts === 1) {
                // 1-point item → checkbox (0 or 1).
                control = `<input type="checkbox" class="audit-entry-input" data-section="${sIdx}" data-pts="1" data-itemid="${item.id}" ${aw >= 1 ? 'checked' : ''} onchange="onAuditEntryToggle(${sIdx})" style="width:18px; height:18px; cursor:pointer;">
                    <span style="font-size:10px; font-weight:800; color:#94a3b8; width:26px; text-align:right;">/ 1</span>`;
            } else {
                // multi-point item → 0..max points dropdown (partial credit).
                let opts = '';
                for (let p = 0; p <= item.pts; p++) opts += `<option value="${p}"${p === aw ? ' selected' : ''}>${p}</option>`;
                control = `<select class="audit-entry-input" data-section="${sIdx}" data-pts="${item.pts}" data-itemid="${item.id}" onchange="onAuditEntryToggle(${sIdx})" style="width:58px; padding:5px 6px; font-size:13px; font-weight:800; color:var(--slate-charcoal); border:1px solid #cbd5e1; border-radius:7px; cursor:pointer; background:#fff;">${opts}</select>
                    <span style="font-size:10px; font-weight:800; color:#94a3b8; width:26px; text-align:right;">/ ${item.pts}</span>`;
            }
            html += `<div style="display:flex; align-items:center; gap:10px; padding:7px 2px; border-bottom:1px solid #f1f5f9;">
                <span style="flex:1; font-size:12.5px; color:var(--slate-charcoal); line-height:1.4;">${escapeHtml(item.text)}</span>
                <span style="flex-shrink:0; display:flex; align-items:center; justify-content:flex-end; gap:8px; width:100px;">${control}</span>
            </div>`;
        });
        html += `</div></div>`;
    });
    container.innerHTML = html;

    // Refresh subtotals + running bar from the prefilled state.
    AUDIT_DEFINITION.forEach((_s, sIdx) => onAuditEntryToggle(sIdx, true));
    updateAuditRunningBar();
}

// Clamp a stored result value (boolean legacy or number) to 0..pts.
function _prefillAward(v, pts) {
    if (v === true) return pts;
    const num = Number(v);
    return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), 0), pts) : 0;
}

// Points awarded by one entry control (checkbox = 0|pts, select = its value).
function _auditItemAward(el) {
    const pts = parseInt(el.getAttribute('data-pts')) || 0;
    if (el.type === 'checkbox') return el.checked ? pts : 0;
    const v = parseInt(el.value);
    return Number.isFinite(v) ? Math.min(Math.max(v, 0), pts) : 0;
}

// One section open at a time — opening a section collapses the others.
function toggleAuditEntrySection(sIdx) {
    const body = document.getElementById(`audit-sec-body-${sIdx}`);
    const caret = document.getElementById(`audit-sec-caret-${sIdx}`);
    if (!body) return;
    const isOpen = body.style.display === 'block';
    document.querySelectorAll('[id^="audit-sec-body-"]').forEach(el => { el.style.display = 'none'; });
    document.querySelectorAll('[id^="audit-sec-caret-"]').forEach(el => { el.style.transform = 'rotate(-90deg)'; });
    if (!isOpen) {
        body.style.display = 'block';
        if (caret) caret.style.transform = 'rotate(0deg)';
    }
}

// Recompute one section's subtotal; if not a silent refresh, also bump the running bar.
function onAuditEntryToggle(sIdx, silent) {
    const sec = AUDIT_DEFINITION[sIdx];
    const secTotal = sec.items.reduce((a, i) => a + i.pts, 0);
    let earned = 0;
    document.querySelectorAll(`.audit-entry-input[data-section="${sIdx}"]`).forEach(el => { earned += _auditItemAward(el); });
    const sub = document.getElementById(`audit-sec-sub-${sIdx}`);
    if (sub) {
        sub.textContent = `${earned}/${secTotal}`;
        const full = earned === secTotal;
        sub.style.color = full ? '#059669' : (earned > 0 ? '#d97706' : '#64748b');
    }
    if (!silent) updateAuditRunningBar();
}

function _auditEntryTotals() {
    let earned = 0;
    document.querySelectorAll('.audit-entry-input').forEach(el => { earned += _auditItemAward(el); });
    return { earned, possible: AUDIT_POSSIBLE };
}

function updateAuditRunningBar() {
    const bar = document.getElementById('dm-audit-runningbar');
    if (!bar) return;
    const { earned, possible } = _auditEntryTotals();
    const pct = possible ? Math.round((earned / possible) * 1000) / 10 : 0;
    // Neutral (not alarming red) until the auditor starts checking items.
    const started = earned > 0;
    const c = started ? auditPctColor(pct) : { bg: '#f1f5f9', fg: '#64748b' };
    const verdict = !started ? 'Not started — check items as you walk the store'
        : (pct >= AUDIT_PASS_PCT ? (pct >= AUDIT_TARGET_PCT ? 'On target' : 'Passing') : 'Below pass')
          + ` · pass ${AUDIT_PASS_PCT}% · target ${AUDIT_TARGET_PCT}%+`;
    bar.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; background:${c.bg}; border-radius:10px; padding:10px 13px;">
            <span style="font-size:12px; font-weight:800; color:${c.fg}; text-transform:uppercase; letter-spacing:.4px;">Live Audit Score</span>
            <span style="font-size:18px; font-weight:900; color:${c.fg};">${earned}/${possible} <span style="font-size:13px;">(${pct}%)</span></span>
        </div>
        <div style="height:7px; border-radius:6px; background:#eef2f6; overflow:hidden; margin-top:6px;"><div style="height:100%; width:${pct}%; background:${c.fg}; border-radius:6px; transition:width .2s;"></div></div>
        <div style="font-size:10.5px; color:#94a3b8; font-weight:700; margin-top:4px;">${verdict}</div>`;
}

function submitNewAudit() {
    const store = document.getElementById('dm-store-select').value;
    const date = document.getElementById('dm-score-date').value;
    const auditor = (document.getElementById('dm-audit-auditor')?.value || '').trim()
        || sessionStorage.getItem('speeksUserName') || null;
    const btn = document.getElementById('submitAuditBtn');
    if (!store || !date) { alert('Pick a store and date.'); return; }

    const results = {};
    document.querySelectorAll('.audit-entry-input').forEach(el => {
        results[el.getAttribute('data-itemid')] = _auditItemAward(el);
    });

    btn.innerText = 'Saving...';
    btn.style.opacity = '0.7';
    btn.disabled = true;

    fetch(SCORECARD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit_audit', store, date, auditor, results })
    }).then(async res => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Save failed');
        btn.innerText = `Saved — ${json.earned}/${json.possible} (${json.pct}%)`;
        btn.style.background = 'var(--sage-professional)';
        setTimeout(() => {
            if (typeof fetchScorecardData === 'function') fetchScorecardData();
            if (typeof fetchMasterDistrictDashboard === 'function') fetchMasterDistrictDashboard();
            closeScorecardModal();
            btn.innerText = 'Save Audit';
            btn.style.background = '';
            btn.style.opacity = '';
            btn.disabled = false;
        }, 1400);
    }).catch(err => {
        alert('Error saving audit: ' + (err.message || err));
        btn.innerText = 'Save Audit';
        btn.style.background = '';
        btn.style.opacity = '';
        btn.disabled = false;
    });
}

// ---- Read-only Audit Breakdown popout (reused by every display site) ----
function openAuditBreakdown(store) {
    renderAuditBreakdown(store);
    toggleModal('auditBreakdownModal');   // closes any open modal, then shows this one + backdrop
}
function closeAuditBreakdown() {
    closeAllModals();
}

function renderAuditBreakdown(store) {
    const body = document.getElementById('audit-breakdown-body');
    const title = document.getElementById('audit-breakdown-title');
    if (!body) return;
    const entry = (window._scorecardAllData || []).find(d => String(d.store).toUpperCase() === String(store).toUpperCase());
    const audit = entry && entry.audit ? entry.audit : null;

    if (!audit) {
        if (title) title.textContent = `${store} · Audit Breakdown`;
        body.innerHTML = `<div style="padding:24px 4px; text-align:center; color:#94a3b8; font-weight:600;">No practice audit on file for ${store} yet.</div>`;
        return;
    }
    const results = audit.results || {};
    const c = auditPctColor(audit.pct);
    const dateStr = audit.date ? new Date(audit.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    if (title) title.textContent = `${store} · Audit Breakdown`;

    let html = `<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; background:${c.bg}; border-radius:10px; padding:12px 14px; margin-bottom:14px;">
        <div>
            <div style="font-size:11px; font-weight:800; color:${c.fg}; text-transform:uppercase; letter-spacing:.4px;">PayMore Audit${dateStr ? ' · ' + dateStr : ''}${audit.auditor ? ' · ' + escapeHtml(audit.auditor) : ''}</div>
            <div style="font-size:11px; color:#64748b; font-weight:600; margin-top:2px;">Pass ${AUDIT_PASS_PCT}% · Target ${AUDIT_TARGET_PCT}%+${audit.prevPct != null ? ` · prev ${audit.prevPct}%` : ''}</div>
        </div>
        <div style="font-size:22px; font-weight:900; color:${c.fg};">${audit.earned}/${audit.possible} <span style="font-size:14px;">(${audit.pct}%)</span></div>
    </div>`;

    AUDIT_DEFINITION.forEach(sec => {
        const secTotal = sec.items.reduce((a, i) => a + i.pts, 0);
        let secEarned = 0;
        sec.items.forEach(i => { secEarned += _prefillAward(results[i.id], i.pts); });
        const secFull = secEarned === secTotal;
        html += `<div style="margin-bottom:12px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:5px;">
                <span style="font-size:11px; font-weight:800; color:#94a3b8; text-transform:uppercase; letter-spacing:.5px;">${sec.title}</span>
                <span style="font-size:11px; font-weight:900; color:${secFull ? '#059669' : (secEarned > 0 ? '#d97706' : '#dc2626')};">${secEarned}/${secTotal}</span>
            </div>`;
        sec.items.forEach(item => {
            const aw = _prefillAward(results[item.id], item.pts);
            const full = aw === item.pts, none = aw === 0;
            const icon = full ? '✓' : (none ? '✗' : '◐');
            const iconColor = full ? '#16a34a' : (none ? '#dc2626' : '#d97706');
            const valColor = full ? '#16a34a' : (none ? '#cbd5e1' : '#d97706');
            html += `<div style="display:flex; align-items:flex-start; gap:9px; padding:4px 2px;">
                <span style="font-size:13px; font-weight:900; line-height:1.3; color:${iconColor}; flex-shrink:0;">${icon}</span>
                <span style="font-size:12px; color:${full ? '#94a3b8' : 'var(--slate-charcoal)'}; line-height:1.4; flex:1; ${full ? '' : 'font-weight:600;'}">${escapeHtml(item.text)}</span>
                <span style="font-size:11px; font-weight:800; color:${valColor}; flex-shrink:0;">${aw}/${item.pts}</span>
            </div>`;
        });
        html += `</div>`;
    });
    body.innerHTML = html;
}

// Audit summary block for the manager Store Scorecard widget: score + trend +
// missed points + a button into the full breakdown popout.
function buildAuditSummaryHtml(audit, store) {
    if (!audit) {
        return `<div style="display:flex; align-items:center; justify-content:space-between;">
                <span class="scorecard-label" style="text-align:left;">PayMore Audit</span>
                <span style="font-size:12px; color:#94a3b8; font-weight:700;">No practice audit yet</span>
            </div>`;
    }
    const c = auditPctColor(audit.pct);
    const dateStr = audit.date ? new Date(audit.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    let trend = '';
    if (audit.prevPct != null) {
        const delta = Math.round((audit.pct - audit.prevPct) * 10) / 10;
        const up = delta >= 0;
        trend = `<span style="font-size:11px; font-weight:800; color:${up ? '#16a34a' : '#dc2626'};">${up ? '▲' : '▼'} ${Math.abs(delta)}%</span>`;
    }

    return `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <div>
                <div class="scorecard-label" style="text-align:left; margin-bottom:2px;">PayMore Audit</div>
                <div class="scorecard-date" style="font-size:11px;">${dateStr}${audit.auditor ? ' · ' + escapeHtml(audit.auditor) : ''}</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                ${trend}
                <span style="font-size:16px; font-weight:900; background:${c.bg}; color:${c.fg}; padding:4px 10px; border-radius:8px;">${audit.earned}/${audit.possible} · ${audit.pct}%</span>
            </div>
        </div>
        <button onclick="openAuditBreakdown('${store}')" class="btn-secondary" style="margin-top:10px; width:100%; padding:8px; font-size:12px; font-weight:800;">View Full Breakdown</button>`;
}

// =========================================================
//  SHOPIFY INSURANCE CLAIMS / ITEM-NOT-RECEIVED TOOL
//  Store managers + owner-managers + multi-store managers log
//  claims here. A manager sees their store's cases; a Multi-Store
//  Manager sees every store they manage, from either dashboard.
// =========================================================
const CLAIM_STATUS = {
    in_progress: { label: 'In Progress', bg: '#fef3c7', fg: '#b45309' },
    recovered:   { label: 'Recovered',   bg: '#d1fae5', fg: '#059669' },
    denied:      { label: 'Denied',      bg: '#fee2e2', fg: '#dc2626' },
};

// Which store(s) this user can file/view claims for.
function _claimStores() {
    if (typeof isMultiStoreManager === 'function' && isMultiStoreManager()) {
        return [...MULTISTORE_MANAGER_STORES];
    }
    const s = (sessionStorage.getItem('speeksUserStore') || '').toUpperCase();
    return (s && s !== 'ALL' && s !== 'CORP') ? [s] : [];
}

function openClaimsModal() {
    toggleModal('claimsModal');
    _buildClaimStorePicker();
    ['claim-case-number', 'claim-sku', 'claim-price', 'claim-cost', 'claim-detail'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    const r = document.getElementById('claim-reason'); if (r) r.selectedIndex = 0;
    const ct = document.getElementById('claim-type'); if (ct) ct.selectedIndex = 0;
    _onClaimReasonChange();
    switchClaimsTab('new');
}

// "Claim Type" (Damage / Loss) only applies to a Claim, not an Item-Not-Received case.
function _onClaimReasonChange() {
    const reason = (document.getElementById('claim-reason') || {}).value;
    const wrap = document.getElementById('claim-type-wrap');
    if (wrap) wrap.style.display = reason !== 'Item Not Received' ? 'block' : 'none';
}

function switchClaimsTab(tab) {
    const nb = document.getElementById('claims-tab-new');
    const vb = document.getElementById('claims-tab-view');
    if (nb) nb.classList.toggle('active', tab === 'new');
    if (vb) vb.classList.toggle('active', tab === 'view');
    const np = document.getElementById('claims-panel-new');
    const vp = document.getElementById('claims-panel-view');
    if (np) np.style.display = tab === 'new' ? 'block' : 'none';
    if (vp) vp.style.display = tab === 'view' ? 'block' : 'none';
    const sb = document.getElementById('submitClaimBtn');
    if (sb) sb.style.display = tab === 'new' ? '' : 'none';
    if (tab === 'view') fetchMyClaims();
}

// MSM gets a store chooser; a single-store manager is locked to their store.
function _buildClaimStorePicker() {
    const row = document.getElementById('claims-store-row');
    const sel = document.getElementById('claim-store');
    if (!sel) return;
    const stores = _claimStores();
    sel.innerHTML = stores.map(s => `<option value="${s}">${s}</option>`).join('');
    const multi = stores.length > 1;
    sel.disabled = !multi;
    sel.style.opacity = multi ? '1' : '0.7';
    sel.style.cursor = multi ? 'pointer' : 'not-allowed';
    if (row) row.style.display = stores.length ? 'block' : 'none';
    if (sel.options.length) sel.selectedIndex = 0;
}

async function submitClaim() {
    const val = id => (document.getElementById(id) || {}).value;
    const store = (val('claim-store') || '').toUpperCase();
    const caseNumber = (val('claim-case-number') || '').trim();
    const sku = (val('claim-sku') || '').trim();
    const priceRaw = val('claim-price');
    const costRaw = val('claim-cost');
    const reason = val('claim-reason');
    const claimType = val('claim-type');
    const detail = (val('claim-detail') || '').trim();
    const status = 'in_progress'; // a ticket is always open the moment it's created

    // Every claim type (Shopify / USPS / UPS) carries its Damage/Loss type;
    // only Item Not Received stands alone.
    const reasonType = reason !== 'Item Not Received' ? `${reason} — ${claimType}` : reason;

    if (!store) { alert('Please select a store for this case.'); return; }
    if (!caseNumber) { alert('Please enter a case number.'); return; }

    const num = v => (v === '' || v == null) ? null : Number(v);
    const btn = document.getElementById('submitClaimBtn');
    const old = btn ? btn.innerText : '';
    if (btn) { btn.disabled = true; btn.innerText = 'Saving…'; }
    try {
        const res = await fetch(CLAIMS_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'submit_claim', store, case_number: caseNumber, item_sku: sku,
                price: num(priceRaw), cost: num(costRaw),
                reason_type: reasonType, reason_detail: detail || null, status,
                created_by: sessionStorage.getItem('speeksUserName') || null,
            }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Save failed');
        switchClaimsTab('view'); // jump to My Cases so they see it landed
    } catch (e) {
        alert('Could not save the case: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = old; }
    }
}

let _claimsAll = []; // last fetched cases, so the MSM store filter can re-render without refetching

async function fetchMyClaims() {
    const wrap = document.getElementById('claims-table-wrap');
    if (!wrap) return;
    const stores = _claimStores();
    if (!stores.length) {
        wrap.innerHTML = '<div style="padding:24px; text-align:center; color:#94a3b8; font-weight:600;">No store assigned to your account.</div>';
        return;
    }
    wrap.innerHTML = '<div style="padding:24px; text-align:center; color:#94a3b8; font-weight:600;">Loading cases…</div>';
    try {
        const res = await fetch(`${CLAIMS_URL}?stores=${encodeURIComponent(stores.join(','))}&v=${Date.now()}`);
        const json = await res.json();
        if (!json.success) throw new Error(json.error);
        _claimsAll = json.data || [];
        _buildClaimsViewFilter(stores);
        renderClaimsTable();
    } catch (e) {
        wrap.innerHTML = '<div style="color:var(--red-alert); padding:24px; text-align:center; font-weight:700;">Error loading cases.</div>';
    }
}

// MSM-only: a store filter on the My Cases tab (single-store managers don't need it).
function _buildClaimsViewFilter(stores) {
    const row = document.getElementById('claims-view-filter-row');
    const sel = document.getElementById('claims-view-filter');
    if (!row || !sel) return;
    if (stores.length <= 1) { row.style.display = 'none'; return; }
    row.style.display = 'block';
    const current = sel.value;
    sel.innerHTML = `<option value="">All stores</option>` +
        stores.map(s => `<option value="${s}">${s}</option>`).join('');
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
}

function renderClaimsTable() {
    const wrap = document.getElementById('claims-table-wrap');
    if (!wrap) return;
    const stores = _claimStores();
    const multi = stores.length > 1;
    const filterStore = (document.getElementById('claims-view-filter') || {}).value || '';
    const filterStatus = (document.getElementById('claims-status-filter') || {}).value || '';
    let rows = _claimsAll;
    if (filterStore) rows = rows.filter(r => (r.store || '').toUpperCase() === filterStore);
    const showStore = multi && !filterStore; // store column only matters when mixing stores
    const colCount = (showStore ? 1 : 0) + 10; // # column + 9 base

    // A follow-up loss claim is a real claim row with parent_id pointing at the
    // Item-Not-Received ticket it came from. Render it nested under its parent.
    const byId = {}; rows.forEach(r => { byId[r.id] = r; });
    const kidsOf = {}; rows.forEach(r => { if (r.parent_id) (kidsOf[r.parent_id] = kidsOf[r.parent_id] || []).push(r); });
    // Status filter applies to top-level claims; their child claims render alongside.
    let tops = rows.filter(r => !r.parent_id || !byId[r.parent_id]);
    if (filterStatus) tops = tops.filter(r => r.status === filterStatus);
    // Needs-attention first: over-7-day open → other open → escalated INRs → resolved;
    // newest first within each group. (An INR with a child loss claim isn't "aging".)
    const clRank = r => {
        if (r.status !== 'in_progress') return 3;
        if ((kidsOf[r.id] || []).length) return 2;
        if (_isClaimAging(r)) return 0;
        return 1;
    };
    tops.sort((a, b) => clRank(a) - clRank(b) || new Date(b.created_at) - new Date(a.created_at));

    if (!tops.length) {
        wrap.innerHTML = '<div style="padding:28px 20px; text-align:center; color:#94a3b8; font-weight:600;">No cases match this view.</div>';
        return;
    }
    const th = t => `<th style="text-align:left; font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.4px; color:#94a3b8; padding:8px 10px; border-bottom:1px solid #e2e8f0; white-space:nowrap;">${t}</th>`;
    let html = `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:12.5px;">
        <thead><tr>${th('#')}${showStore ? th('Store') : ''}${th('Case #')}${th('SKU')}${th('Value')}${th('Cost')}${th('Reason')}${th('Status')}${th('Created')}${th('Resolved')}${th('')}</tr></thead><tbody>`;
    let n = 0;
    tops.forEach(r => {
        const kids = kidsOf[r.id] || [];
        const isINR = String(r.reason_type || '').toLowerCase().startsWith('item not received');
        const canEscalate = isINR && !kids.length; // one loss claim per INR ticket
        n++;
        html += _claimRowHtml(r, showStore, false, canEscalate, kids.length > 0, `${n}`);
        if (canEscalate) html += _escalateFormRow(r, colCount);
        kids.forEach((k, ci) => { html += _claimRowHtml(k, showStore, true, false, false, `${n}.${ci + 1}`); });
    });
    html += '</tbody></table></div>';
    wrap.innerHTML = html;
}

// One claim row. `isChild` nests it (indent + blue edge) under its parent INR ticket;
// it's otherwise a full, normal claim row with its own status/value/cost/dates/actions.
function _claimRowHtml(r, showStore, isChild, canEscalate, hasChild, num) {
    const fmtPrice = v => (v == null || v === '') ? '—' : '$' + Number(v).toFixed(2);
    const fmtDate = d => { const x = new Date(d); return isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    const td = (c, extra = '') => `<td style="padding:9px 10px; border-bottom:1px solid #f1f5f9; vertical-align:top; ${extra}">${c}</td>`;
    const opts = Object.entries(CLAIM_STATUS).map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${v.label}</option>`).join('');
    const sc = CLAIM_STATUS[r.status] || CLAIM_STATUS.in_progress;
    const aging = _isClaimAging(r) && !hasChild; // a parent superseded by a loss claim isn't "aging"
    const caret = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5L5 6.5L8 3.5" stroke="#475569" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
    // Once a loss claim is opened, status tracking moves to that child claim — so a
    // parent INR with a child shows a static status, and only the claim has the pill.
    const statusCell = hasChild
        ? `<span style="font-size:11px; font-weight:800; color:#94a3b8;">${sc.label}</span><div style="font-size:9px; color:#cbd5e1; font-weight:800; text-transform:uppercase; letter-spacing:.3px; margin-top:1px;">on claim ↓</div>`
        : `<select onchange="updateClaimStatus('${r.id}', this.value)" style="appearance:none; -webkit-appearance:none; font-size:11px; font-weight:800; border:1.5px solid ${sc.fg}55; border-radius:999px; padding:5px 26px 5px 12px; cursor:pointer; background-color:#fff; color:#1e293b; background-image:url('data:image/svg+xml,${caret}'); background-repeat:no-repeat; background-position:right 9px center;">${opts}</select>`;

    let reasonCell = `${escapeHtml(r.reason_type || '—')}`;
    if (r.reason_detail) reasonCell += `<div style="color:#94a3b8; font-size:11px; margin-top:2px;">${escapeHtml(r.reason_detail)}</div>`;
    if (aging) reasonCell += `<div style="color:#dc2626; font-size:11px; font-weight:800; margin-top:3px;">⚠️ Open ${_claimDaysOpen(r)} days${canEscalate ? ' · likely lost' : ''}</div>`;

    const sBtn = 'font-size:11px; font-weight:800; border-radius:7px; padding:5px 9px; cursor:pointer; line-height:1; white-space:nowrap;';
    const acts = [];
    if (aging) acts.push(`<button onclick="ackClaim('${r.id}')" title="Mark that you checked on this — resets the 7-day reminder" style="${sBtn} background:#ecfdf5; border:1.5px solid #a7f3d0; color:#047857;">✓ Still in progress</button>`);
    if (canEscalate) acts.push(`<button onclick="toggleEscalateRow('${r.id}')" title="Open a loss claim on this ticket" style="${sBtn} background:#eff6ff; border:1.5px solid #bfdbfe; color:#1d4ed8;">Open a claim</button>`);
    // Deleting a claim needs DM/CEO approval — the trash button sends a request, and a
    // claim already awaiting approval shows a pending badge instead.
    if (r.delete_requested_at) {
        acts.push(`<span title="Waiting on DM/CEO approval" style="display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:800; color:#b45309; background:#fffbeb; border:1.5px solid #fde68a; border-radius:9px; padding:6px 9px; white-space:nowrap;">🗑 Delete requested</span>`);
    } else {
        acts.push(`<button onclick="requestClaimDelete('${r.id}', ${!!hasChild})" title="Request deletion (a DM or CEO must approve)" style="display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; background:#fff5f5; border:1.5px solid #fecaca; border-radius:9px; cursor:pointer; font-size:17px; line-height:1;" onmouseover="this.style.background='#fee2e2';" onmouseout="this.style.background='#fff5f5';">🗑</button>`);
    }
    const actionsCell = `<div style="display:flex; flex-direction:column; gap:5px; align-items:flex-start;">${acts.join('')}</div>`;

    const resolvedCell = r.resolved_at
        ? `<span style="color:${sc.fg}; white-space:nowrap; font-weight:700;">${fmtDate(r.resolved_at)}</span>`
        : `<span style="color:#cbd5e1; white-space:nowrap;">—</span>`;

    // Aging → red tint/edge; otherwise a child claim gets a blue tint/edge.
    let rowStyle = '';
    if (aging) rowStyle = 'background:#fef2f2; box-shadow:inset 3px 0 0 #dc2626;';
    else if (isChild) rowStyle = 'background:#f0f7ff; box-shadow:inset 3px 0 0 #93c5fd;';

    const caseCell = isChild
        ? `<span style="color:#60a5fa; font-weight:900; margin-right:5px;">↳</span><span style="font-weight:700; color:var(--slate-charcoal);">${escapeHtml(r.case_number || '')}</span>`
        : `<span style="font-weight:700; color:var(--slate-charcoal);">${escapeHtml(r.case_number || '')}</span>`;

    return `<tr style="${rowStyle}">
        ${td(`<span style="font-weight:800; color:${isChild ? '#94a3b8' : 'var(--slate-charcoal)'};">${num}</span>`, 'white-space:nowrap;')}
        ${showStore ? td(isChild ? '' : `<span style="font-weight:800; color:var(--slate-charcoal);">${escapeHtml(r.store || '')}</span>`) : ''}
        ${td(caseCell, isChild ? 'padding-left:20px;' : '')}
        ${td(escapeHtml(r.item_sku || '—'))}
        ${td(fmtPrice(r.price), 'white-space:nowrap; font-weight:700;')}
        ${td(fmtPrice(r.cost), 'white-space:nowrap; font-weight:700; color:#64748b;')}
        ${td(reasonCell)}
        ${td(statusCell, 'white-space:nowrap;')}
        ${td(`<span style="color:#94a3b8; white-space:nowrap;">${fmtDate(r.created_at)}</span>`)}
        ${td(resolvedCell)}
        ${td(actionsCell)}
    </tr>`;
}

// Inline form (a hidden table row) for opening a loss claim on an Item-Not-Received
// ticket — same fields as a new claim, prefilled with the item's value/cost.
function _escalateFormRow(r, colCount) {
    const inp = 'width:100%; padding:7px 9px; border:1.5px solid #cbd5e1; border-radius:7px; font-size:12px; font-weight:600; box-sizing:border-box; background:#fff;';
    const lbl = t => `<label style="display:block; font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:.4px; color:#94a3b8; margin-bottom:3px;">${t}</label>`;
    const val = r.price != null ? r.price : '';
    const cost = r.cost != null ? r.cost : '';
    return `<tr id="esc-row-${r.id}" style="display:none; background:#f1f5f9;">
        <td colspan="${colCount}" style="padding:14px 16px; border-bottom:1px solid #e2e8f0;">
            <div style="font-weight:800; font-size:12px; color:#1d4ed8; margin-bottom:10px;">Open a loss claim on this ticket</div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:10px;">
                <div>${lbl('Claim')}<select id="esc-${r.id}-reason" style="${inp}"><option value="Shopify Claim">Shopify Claim</option><option value="USPS Claim">USPS Claim</option><option value="UPS Claim">UPS Claim</option></select></div>
                <div>${lbl('Type')}<select id="esc-${r.id}-type" style="${inp}"><option value="Loss">Loss</option><option value="Damage">Damage</option></select></div>
                <div>${lbl('Claim #')}<input id="esc-${r.id}-num" style="${inp}" placeholder="e.g. 9400-1234"></div>
                <div>${lbl('Value')}<input id="esc-${r.id}-value" type="number" step="0.01" min="0" value="${val}" style="${inp}"></div>
                <div>${lbl('Cost')}<input id="esc-${r.id}-cost" type="number" step="0.01" min="0" value="${cost}" style="${inp}"></div>
                <div>${lbl('Detail (optional)')}<input id="esc-${r.id}-detail" style="${inp}" placeholder="Notes"></div>
            </div>
            <div style="display:flex; gap:8px; margin-top:12px;">
                <button onclick="saveEscalation('${r.id}')" class="btn-primary" style="font-size:12px; padding:7px 16px;">Save claim</button>
                <button onclick="toggleEscalateRow('${r.id}')" class="btn-secondary" style="font-size:12px; padding:7px 16px;">Cancel</button>
            </div>
        </td>
    </tr>`;
}

function toggleEscalateRow(id) {
    const row = document.getElementById('esc-row-' + id);
    if (row) row.style.display = (row.style.display === 'none' || !row.style.display) ? 'table-row' : 'none';
}

// "Still in progress" — verify the manager checked on an aging case (resets the clock).
async function ackClaim(id) {
    try {
        const res = await fetch(CLAIMS_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'ack_claim', id }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Failed');
        const seen = _seenAgingClaims(); seen.delete(id); _saveSeenAgingClaims(seen);
        fetchMyClaims();
    } catch (e) {
        alert('Could not update: ' + e.message);
    }
}

// Save the inline "open a claim" form — creates a real child claim linked to the
// Item-Not-Received ticket (and resets the parent's clock; that's a check-in).
async function saveEscalation(id) {
    const g = s => { const el = document.getElementById(`esc-${id}-${s}`); return el ? String(el.value).trim() : ''; };
    const reason = g('reason'), type = g('type'), num = g('num'), value = g('value'), cost = g('cost'), detail = g('detail');
    const num2 = v => (v === '' || v == null) ? null : Number(v);
    try {
        const res = await fetch(CLAIMS_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'escalate_claim', id,
                reason_type: `${reason} — ${type}`,
                case_number: num || null,
                price: num2(value), cost: num2(cost),
                reason_detail: detail || null,
                created_by: sessionStorage.getItem('speeksUserName') || null,
            }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Failed');
        const seen = _seenAgingClaims(); seen.delete(id); _saveSeenAgingClaims(seen);
        fetchMyClaims();
    } catch (e) {
        alert('Could not save: ' + e.message);
    }
}

// =========================================================
//  DM / CEO CLAIMS OVERSIGHT — checks & balances across all stores
// =========================================================
const _CLAIMS_OVERSIGHT_STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
let _oversightAll = [];
let _ovStore = '', _ovStatus = ''; // oversight "All claims" filters

function openClaimsOversight() {
    toggleModal('claimsOversightModal');
    fetchAllClaims();
}

async function fetchAllClaims() {
    const body = document.getElementById('claims-oversight-body');
    if (!body) return;
    body.innerHTML = '<div class="status-message">Loading all claims…</div>';
    try {
        const res = await fetch(`${CLAIMS_URL}?v=${Date.now()}`); // no stores param → every store
        const json = await res.json();
        if (!json.success) throw new Error(json.error);
        _oversightAll = json.data || [];
        renderClaimsOversight();
    } catch (e) {
        body.innerHTML = '<div class="status-message" style="color:var(--red-alert);">Failed to load claims.</div>';
    }
}

function renderClaimsOversight() {
    const body = document.getElementById('claims-oversight-body');
    if (!body) return;
    const rows = _oversightAll;
    // An INR ticket that's been escalated to a loss claim (has a child) is no longer
    // an open claim itself — the child loss claim is the active one. Exclude it.
    const supersededParents = new Set(rows.filter(r => r.parent_id).map(r => r.parent_id));
    const open = rows.filter(r => r.status === 'in_progress' && !supersededParents.has(r.id));
    const aging = open.filter(_isClaimAging);
    const reviewed = open.filter(r => r.last_checked_at && !_isClaimAging(r)); // checked in & current
    const resolved = rows.filter(r => r.status !== 'in_progress');
    const fmtDate = d => { const x = new Date(d); return isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

    const card = (label, val, color) => `<div style="flex:1; min-width:110px; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:13px 15px;">
        <div style="font-size:26px; font-weight:900; color:${color}; line-height:1;">${val}</div>
        <div style="font-size:10.5px; font-weight:800; text-transform:uppercase; letter-spacing:.4px; color:#94a3b8; margin-top:4px;">${label}</div>
    </div>`;
    let html = `<div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px;">
        ${card('Open', open.length, '#1e293b')}
        ${card('Over 7 days', aging.length, aging.length ? '#dc2626' : '#94a3b8')}
        ${card('Reviewed', reviewed.length, '#059669')}
        ${card('Resolved', resolved.length, '#64748b')}
    </div>`;

    // Pending delete requests — a manager can't remove a claim directly; a DM/CEO
    // approves (permanently deletes) or denies (keeps it). Shown up top for action.
    const deleteReqs = rows.filter(r => r.delete_requested_at)
        .sort((a, b) => new Date(a.delete_requested_at) - new Date(b.delete_requested_at));
    if (deleteReqs.length) {
        html += `<div style="background:#fffbeb; border:1.5px solid #fde68a; border-radius:12px; padding:14px 16px; margin-bottom:18px;">
            <div style="font-weight:800; font-size:13px; color:#92400e; margin-bottom:10px;">🗑 Delete requests (${deleteReqs.length}) — approval needed</div>
            <div style="display:flex; flex-direction:column; gap:8px;">`;
        deleteReqs.forEach(r => {
            const who = r.delete_requested_by ? escapeHtml(r.delete_requested_by) : 'Manager';
            html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; background:#fff; border:1px solid #fde68a; border-radius:9px; padding:9px 12px;">
                <div style="font-size:12.5px; color:var(--slate-charcoal);">
                    <span style="font-weight:800;">${escapeHtml(r.store || '')}</span>
                    · <span style="font-weight:700;">${escapeHtml(r.case_number || '')}</span>
                    <span style="color:#94a3b8;"> — ${escapeHtml(r.reason_type || '')}</span>
                    <span style="color:#b45309; font-weight:700;"> · requested by ${who}</span>
                </div>
                <div style="display:flex; gap:8px;">
                    <button onclick="approveClaimDelete('${r.id}')" style="font-size:11px; font-weight:800; border-radius:7px; padding:6px 13px; cursor:pointer; background:#fef2f2; border:1.5px solid #fecaca; color:#b91c1c;">Approve delete</button>
                    <button onclick="denyClaimDelete('${r.id}')" style="font-size:11px; font-weight:800; border-radius:7px; padding:6px 13px; cursor:pointer; background:#f1f5f9; border:1.5px solid #cbd5e1; color:#475569;">Deny</button>
                </div>
            </div>`;
        });
        html += `</div></div>`;
    }

    // Per-store breakdown + a reminder ping.
    const byStore = {};
    _CLAIMS_OVERSIGHT_STORES.forEach(s => { byStore[s] = { open: 0, aging: 0, reviewed: 0 }; });
    open.forEach(r => {
        const s = (r.store || '').toUpperCase();
        if (!byStore[s]) byStore[s] = { open: 0, aging: 0, reviewed: 0 };
        byStore[s].open++;
        if (_isClaimAging(r)) byStore[s].aging++;
        else if (r.last_checked_at) byStore[s].reviewed++;
    });
    const th = t => `<th style="text-align:left; font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.4px; color:#94a3b8; padding:8px 10px; border-bottom:1px solid #e2e8f0;">${t}</th>`;
    const td = (c, extra = '') => `<td style="padding:9px 10px; border-bottom:1px solid #f1f5f9; ${extra}">${c}</td>`;
    html += `<div style="font-weight:800; font-size:13px; margin-bottom:8px; color:var(--slate-charcoal);">By store</div>
        <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:12.5px; margin-bottom:20px;">
        <thead><tr>${th('Store')}${th('Open')}${th('Over 7 Days')}${th('Reviewed')}${th('')}</tr></thead><tbody>`;
    Object.keys(byStore).forEach(s => {
        const d = byStore[s];
        // A reminder is only warranted for claims over 7 days that haven't been
        // reviewed or escalated to a claim — i.e. the store's aging count. If a
        // store is caught up (or only has fresh/reviewed claims), no button.
        const ping = d.aging
            ? `<button onclick="pingStoreClaims('${s}')" style="font-size:11px; font-weight:800; border-radius:7px; padding:5px 11px; cursor:pointer; background:#eff6ff; border:1.5px solid #bfdbfe; color:#1d4ed8;">🔔 Send reminder</button>`
            : `<span style="color:#cbd5e1; font-size:11px;">—</span>`;
        html += `<tr>
            ${td(`<span style="font-weight:800; color:var(--slate-charcoal);">${s}</span>`)}
            ${td(`<span style="font-weight:700;">${d.open}</span>`)}
            ${td(`<span style="font-weight:800; color:${d.aging ? '#dc2626' : '#cbd5e1'};">${d.aging}</span>`)}
            ${td(`<span style="font-weight:800; color:${d.reviewed ? '#059669' : '#cbd5e1'};">${d.reviewed}</span>`)}
            ${td(ping, 'text-align:right;')}
        </tr>`;
    });
    html += `</tbody></table></div>`;

    // Full claims list — every claim across all stores, with details + store/status filters.
    const byId = {}; rows.forEach(r => { byId[r.id] = r; });
    const storeOpts = ['', ..._CLAIMS_OVERSIGHT_STORES].map(s => `<option value="${s}" ${s === _ovStore ? 'selected' : ''}>${s || 'All stores'}</option>`).join('');
    const statusOpts = [['', 'All statuses'], ['in_progress', 'In Progress'], ['recovered', 'Recovered'], ['denied', 'Denied']]
        .map(([v, l]) => `<option value="${v}" ${v === _ovStatus ? 'selected' : ''}>${l}</option>`).join('');
    const selStyle = 'padding:8px 10px; border:1.5px solid #cbd5e1; border-radius:8px; font-size:12.5px; font-weight:600; background:#fff;';
    html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin:6px 0 10px;">
        <div style="font-weight:800; font-size:13px; color:var(--slate-charcoal);">All claims</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <select onchange="_ovStore=this.value; renderClaimsOversight();" style="${selStyle}">${storeOpts}</select>
            <select onchange="_ovStatus=this.value; renderClaimsOversight();" style="${selStyle}">${statusOpts}</select>
        </div>
    </div>`;

    // Nest loss claims under their original INR ticket (same as the manager view).
    const hasKids = new Set(rows.filter(r => r.parent_id).map(r => r.parent_id));
    const kidsOf = {}; rows.forEach(r => { if (r.parent_id) (kidsOf[r.parent_id] = kidsOf[r.parent_id] || []).push(r); });
    let tops = rows.filter(r => !r.parent_id || !byId[r.parent_id]);
    if (_ovStore) tops = tops.filter(r => (r.store || '').toUpperCase() === _ovStore);
    if (_ovStatus) tops = tops.filter(r => r.status === _ovStatus);
    // Sort needs-attention first: over-7-day open claims → other open → escalated
    // INRs → resolved; newest created first within each group.
    const ovRank = r => {
        if (r.status !== 'in_progress') return 3;          // resolved (recovered/denied)
        if (supersededParents.has(r.id)) return 2;         // INR that became a loss claim
        if (_isClaimAging(r)) return 0;                    // open & over 7 days — act now
        return 1;                                          // open & current
    };
    tops.sort((a, b) => ovRank(a) - ovRank(b) || new Date(b.created_at) - new Date(a.created_at));
    if (!tops.length) {
        html += `<div style="padding:18px; text-align:center; color:#94a3b8; font-weight:600; background:#f8fafc; border-radius:10px;">No claims match this view.</div>`;
    } else {
        html += `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead><tr>${th('#')}${th('Store')}${th('Case #')}${th('SKU')}${th('Value')}${th('Cost')}${th('Reason')}${th('Status')}${th('Created')}${th('Reviewed')}</tr></thead><tbody>`;
        let n = 0;
        tops.forEach(r => {
            n++;
            html += _ovRowHtml(r, byId, hasKids.has(r.id), `${n}`);
            (kidsOf[r.id] || []).forEach((k, ci) => { html += _ovRowHtml(k, byId, false, `${n}.${ci + 1}`); });
        });
        html += `</tbody></table></div>`;
    }
    body.innerHTML = html;
}

// Read-only detail row for the oversight "All claims" table. A child loss claim
// (parent_id set) is indented and notes which ticket it came from.
function _ovRowHtml(r, byId, hasChild, num) {
    const isChild = !!r.parent_id;
    const fmtPrice = v => (v == null || v === '') ? '—' : '$' + Number(v).toFixed(2);
    const fmtDate = d => { const x = new Date(d); return isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    const td = (c, extra = '') => `<td style="padding:8px 10px; border-bottom:1px solid #f1f5f9; vertical-align:top; ${extra}">${c}</td>`;
    const sc = CLAIM_STATUS[r.status] || CLAIM_STATUS.in_progress;
    const aging = _isClaimAging(r) && !hasChild;
    // Mirror the manager view: a parent INR with a child shows status "on claim ↓".
    const statusCell = hasChild
        ? `<span style="font-size:11px; font-weight:800; color:#94a3b8;">${sc.label}</span><div style="font-size:9px; color:#cbd5e1; font-weight:800; text-transform:uppercase; letter-spacing:.3px; margin-top:1px;">on claim ↓</div>`
        : `<span style="display:inline-block; font-size:10px; font-weight:800; background:${sc.bg}; color:${sc.fg}; border-radius:999px; padding:3px 10px; white-space:nowrap;">${sc.label}</span>`;
    let reasonCell = escapeHtml(r.reason_type || '—');
    if (aging) reasonCell += `<div style="color:#dc2626; font-size:10.5px; font-weight:800; margin-top:2px;">⚠️ Open ${_claimDaysOpen(r)} days</div>`;
    if (r.delete_requested_at) reasonCell += `<div style="color:#b45309; font-size:10.5px; font-weight:800; margin-top:2px;">🗑 Delete requested</div>`;
    const reviewed = r.status !== 'in_progress'
        ? `<span style="color:#cbd5e1;">—</span>`
        : (r.last_checked_at ? `<span style="color:#059669; font-weight:700; white-space:nowrap;">${fmtDate(r.last_checked_at)}</span>` : `<span style="color:#dc2626; font-weight:800;">Never</span>`);
    let rowStyle = '';
    if (aging) rowStyle = 'background:#fef2f2; box-shadow:inset 3px 0 0 #dc2626;';
    else if (isChild) rowStyle = 'background:#f0f7ff; box-shadow:inset 3px 0 0 #93c5fd;';
    const parent = isChild ? byId[r.parent_id] : null;
    const caseCell = isChild
        ? `<span style="color:#60a5fa; font-weight:900; margin-right:5px;">↳</span><span style="font-weight:700; color:var(--slate-charcoal);">${escapeHtml(r.case_number || '')}</span>${parent ? `<div style="font-size:10px; color:#94a3b8; font-weight:600;">claim on ${escapeHtml(parent.case_number || '')}</div>` : ''}`
        : `<span style="font-weight:700; color:var(--slate-charcoal);">${escapeHtml(r.case_number || '')}</span>`;
    return `<tr style="${rowStyle}">
        ${td(`<span style="font-weight:800; color:${isChild ? '#94a3b8' : 'var(--slate-charcoal)'};">${num}</span>`, 'white-space:nowrap;')}
        ${td(`<span style="font-weight:800; color:var(--slate-charcoal);">${escapeHtml(r.store || '')}</span>`)}
        ${td(caseCell, isChild ? 'padding-left:18px;' : '')}
        ${td(escapeHtml(r.item_sku || '—'))}
        ${td(fmtPrice(r.price), 'white-space:nowrap; font-weight:700;')}
        ${td(fmtPrice(r.cost), 'white-space:nowrap; font-weight:700; color:#64748b;')}
        ${td(reasonCell)}
        ${td(statusCell, 'white-space:nowrap;')}
        ${td(`<span style="color:#94a3b8; white-space:nowrap;">${fmtDate(r.created_at)}</span>`)}
        ${td(reviewed)}
    </tr>`;
}

// Nudge a store's manager to review their open claims. Delivers as a dedicated RED
// review pop-up on the manager's dashboard (separate from green store comments).
async function pingStoreClaims(store) {
    const rows = _oversightAll || [];
    // Reminders target only claims that are actually behind: open, over 7 days,
    // not yet reviewed ("Still in progress") and not already escalated to a claim.
    // Escalated INRs (parents with a child loss claim) are excluded like everywhere else.
    const sup = new Set(rows.filter(r => r.parent_id).map(r => r.parent_id));
    const aging = rows.filter(r => r.status === 'in_progress'
        && (r.store || '').toUpperCase() === store
        && !sup.has(r.id)
        && _isClaimAging(r));
    if (!aging.length) {
        alert(`${store} has no claims over 7 days awaiting review — nothing to remind about.`);
        return;
    }
    if (!confirm(`Send ${store} a reminder to review ${aging.length} claim${aging.length === 1 ? '' : 's'} open over 7 days without a review?`)) return;
    // Message is generic — the manager's popup computes the live over-7-day count.
    try {
        const res = await fetch(CLAIMS_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'send_reminder', store,
                message: 'Please review your open insurance claims.',
                from: sessionStorage.getItem('speeksUserName') || 'Leadership',
            }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Failed');
        alert(`Reminder sent to ${store}.`);
    } catch (e) {
        alert('Could not send the reminder: ' + (e.message || e));
    }
}

async function updateClaimStatus(id, status) {
    try {
        const res = await fetch(CLAIMS_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update_status', id, status }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Update failed');
        fetchMyClaims();
    } catch (e) {
        alert('Could not update status: ' + e.message);
        fetchMyClaims();
    }
}

// Manager-side: request deletion. Claims are never deleted directly by a manager —
// a DM/CEO must approve, so nothing is quietly removed.
async function requestClaimDelete(id, hasChild) {
    // Deleting an Item-Not-Received ticket that already has a loss claim removes
    // both (child cascades) — spell that out so it isn't a surprise.
    const msg = hasChild
        ? 'Request deletion of this Item-Not-Received ticket?\n\nThis also removes the loss claim opened on it. A DM or CEO must approve before anything is removed.'
        : 'Request deletion of this claim?\n\nA DM or CEO must approve it before the claim is removed.';
    if (!confirm(msg)) return;
    try {
        const res = await fetch(CLAIMS_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'request_delete', id, requested_by: sessionStorage.getItem('speeksUserName') || null }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Request failed');
        alert('Delete request sent. A DM or CEO will review it.');
        fetchMyClaims();
    } catch (e) {
        alert('Could not send the request: ' + (e.message || e));
    }
}

// DM/CEO-side: approve a pending delete request → permanently removes the claim.
async function approveClaimDelete(id) {
    const kids = (_oversightAll || []).filter(r => r.parent_id === id).length;
    const msg = kids
        ? `Approve deletion? This permanently removes the ticket AND the ${kids} loss claim${kids === 1 ? '' : 's'} opened on it. This cannot be undone.`
        : 'Approve deletion? This permanently removes the claim and cannot be undone.';
    if (!confirm(msg)) return;
    try {
        const res = await fetch(CLAIMS_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete_claim', id }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Delete failed');
        fetchAllClaims();
    } catch (e) {
        alert('Could not delete: ' + (e.message || e));
    }
}

// DM/CEO-side: deny a pending delete request → keeps the claim, clears the flag.
async function denyClaimDelete(id) {
    try {
        const res = await fetch(CLAIMS_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'deny_delete', id }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || 'Failed');
        fetchAllClaims();
    } catch (e) {
        alert('Could not deny: ' + (e.message || e));
    }
}

// --- AGING-CLAIM RED ALERT BUBBLE ---
// Nudges managers to revisit any case still "In Progress" after 7 days. For an
// Item-Not-Received case that old, the buyer was likely already refunded and the
// item is probably truly lost — so we recommend opening a Damage/Loss claim.
const CLAIM_AGE_DAYS = 7;

// A case "ages" from when it was last checked on (last_checked_at) or, if never
// checked, from when it was opened (created_at). Acking via "Still in progress"
// resets this clock.
function _claimEffectiveDate(r) {
    return new Date(r.last_checked_at || r.created_at).getTime();
}
function _claimDaysOpen(r) {
    const t = _claimEffectiveDate(r);
    return isNaN(t) ? '?' : Math.floor((Date.now() - t) / 86400000);
}
function _isClaimAging(r) {
    if (!r || r.status !== 'in_progress') return false;
    const t = _claimEffectiveDate(r);
    return !isNaN(t) && t < Date.now() - CLAIM_AGE_DAYS * 86400000;
}

function _seenAgingClaims() {
    try { return new Set(JSON.parse(sessionStorage.getItem('speeksSeenAgingClaims') || '[]')); }
    catch (e) { return new Set(); }
}
function _saveSeenAgingClaims(keys) {
    sessionStorage.setItem('speeksSeenAgingClaims', JSON.stringify([...keys]));
}

// True while a DM/CEO-pushed reminder currently owns the shared red bubble, so the
// generic aging alert won't overwrite it (avoids the login flicker of two firing).
let _reminderBubbleActive = false;
window.closeClaimAlertBubble = function () {
    const b = document.getElementById('claimAlertBubble');
    if (b) b.style.display = 'none';
    _reminderBubbleActive = false; // free the bubble for a later aging alert
};

// --- DM/CEO-pushed review reminders (delivered to the manager as the same RED bubble) ---
function _seenReminders() {
    try { return new Set(JSON.parse(sessionStorage.getItem('speeksSeenClaimReminders') || '[]')); }
    catch (e) { return new Set(); }
}
function _saveSeenReminders(keys) {
    sessionStorage.setItem('speeksSeenClaimReminders', JSON.stringify([...keys]));
}

async function checkClaimReminders() {
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase();
    if (!_CLAIM_ALERT_ROLES.has(role)) return;
    const stores = (typeof _claimStores === 'function') ? _claimStores() : [];
    if (!stores.length) return;
    try {
        const res = await fetch(`${CLAIMS_URL}?reminders=1&stores=${encodeURIComponent(stores.join(','))}&v=${Date.now()}`);
        const json = await res.json();
        if (!json.success) return;
        const seen = _seenReminders();
        const fresh = (json.data || []).filter(r => !seen.has(r.id)); // newest first from API
        if (!fresh.length) return;
        fresh.forEach(r => seen.add(r.id));
        _saveSeenReminders(seen);

        // Compute the manager's CURRENT open / over-7-day counts so the reminder
        // reflects what actually still needs review (not a stale number).
        let openCount = 0, agingCount = 0;
        try {
            const cRes = await fetch(`${CLAIMS_URL}?stores=${encodeURIComponent(stores.join(','))}&v=${Date.now()}`);
            const cj = await cRes.json();
            if (cj.success) {
                const sup = new Set((cj.data || []).filter(r => r.parent_id).map(r => r.parent_id));
                const op = (cj.data || []).filter(r => r.status === 'in_progress' && !sup.has(r.id));
                openCount = op.length;
                agingCount = op.filter(_isClaimAging).length;
            }
        } catch (e) { /* counts stay 0 */ }
        _showClaimReminder(fresh[0], openCount, agingCount);
    } catch (e) { /* silent */ }
}

function _showClaimReminder(rem, openCount, agingCount) {
    const from = rem.from_name ? escapeHtml(rem.from_name) : 'Leadership';
    let body;
    if (agingCount) {
        body = agingCount === 1
            ? '1 claim has been open over 7 days. Please review it.'
            : `${agingCount} claims have been open over 7 days. Please review them.`;
    } else if (openCount) {
        body = "You're all caught up on aging claims.";
    } else {
        body = 'All your claims are resolved — nice work!';
    }
    _reminderBubbleActive = true; // claims the shared bubble so the aging alert won't clobber it
    _renderClaimBubble('🛟', `${from} — Claims Review`, body);
}

let _claimAlertPollStarted = false;
const _CLAIM_ALERT_ROLES = new Set(['manager', 'owner (manager)', 'owner manager']);
async function checkAgingClaims() {
    // Same audience as the Insurance Claims tool: managers, owner-managers, MSM
    // (MSM logs in as role 'manager'). ASMs/employees never file claims.
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase();
    if (!_CLAIM_ALERT_ROLES.has(role)) return;
    const stores = (typeof _claimStores === 'function') ? _claimStores() : [];
    if (!stores.length) return; // no store scope → nothing to check

    if (!_claimAlertPollStarted) {
        _claimAlertPollStarted = true;
        setInterval(checkAgingClaims, 10 * 60 * 1000);
    }

    try {
        const res = await fetch(`${CLAIMS_URL}?stores=${encodeURIComponent(stores.join(','))}&v=${Date.now()}`);
        const json = await res.json();
        if (!json.success) return;
        const data = json.data || [];
        const sup = new Set(data.filter(r => r.parent_id).map(r => r.parent_id)); // exclude escalated INRs
        const aging = data.filter(r => !sup.has(r.id) && _isClaimAging(r));
        if (!aging.length) return;

        // A DM/CEO reminder already owns the bubble — don't clobber it (it already
        // conveys the aging count). The aging alert can show once that's dismissed.
        const bubble = document.getElementById('claimAlertBubble');
        const bubbleVisible = bubble && getComputedStyle(bubble).display !== 'none';
        if (_reminderBubbleActive && bubbleVisible) return;

        // Only auto-pop when there's an aging case we haven't surfaced this session.
        const seen = _seenAgingClaims();
        if (!aging.some(r => !seen.has(r.id))) return;
        aging.forEach(r => seen.add(r.id));
        _saveSeenAgingClaims(seen);

        _showClaimAlert(aging.length);
    } catch (e) {
        console.error('Aging claim check failed:', e);
    }
}

// Keep the claim alert stacked UNDER the green store-comment bubble whenever that
// one is showing; otherwise sit at the normal top spot. Called both when the alert
// appears and when the comment bubble shows/hides, so order of arrival doesn't matter.
function _positionClaimAlert() {
    const bubble = document.getElementById('claimAlertBubble');
    if (!bubble) return;
    const daily = document.getElementById('dailyMessageBubble');
    const dailyVisible = daily && getComputedStyle(daily).display !== 'none' && daily.offsetHeight > 0;
    bubble.style.top = dailyVisible ? (daily.getBoundingClientRect().bottom + 12) + 'px' : '116px';
}

// A general red reminder — it does NOT name specific cases; the My Cases tab
// highlights the actual aging case(s) in red. A button jumps straight there.
// Shared red-bubble renderer (same size/format as the green store-comment bubble:
// emoji in the icon slot, title + body in the text slot), with a Review button.
function _renderClaimBubble(icon, titleHtml, bodyHtml) {
    const bubble = document.getElementById('claimAlertBubble');
    const textEl = document.getElementById('claimAlertBubbleText');
    const iconEl = document.getElementById('claimAlertBubbleIcon');
    if (!bubble || !textEl) return;
    if (iconEl) { iconEl.textContent = icon; iconEl.style.display = ''; }
    textEl.style.display = 'flex';
    textEl.style.flexDirection = 'column';
    textEl.style.gap = '7px';
    textEl.innerHTML = `
        <div style="line-height:1.4;"><strong>${titleHtml}</strong></div>
        <div style="line-height:1.4; opacity:0.96;">${bodyHtml}</div>
        <button onclick="closeClaimAlertBubble(); openClaimsModal(); switchClaimsTab('view');"
            style="align-self:flex-start; background:rgba(255,255,255,0.18); border:1px solid rgba(255,255,255,0.5); color:#fff; font-weight:800; font-size:12px; border-radius:8px; padding:6px 12px; cursor:pointer;"
            onmouseover="this.style.background='rgba(255,255,255,0.3)';" onmouseout="this.style.background='rgba(255,255,255,0.18)';">Review claims</button>`;
    bubble.style.display = 'flex';
    _positionClaimAlert();
    bubble.animate([
        { transform: 'scale(0.95) translateX(10px)', opacity: 0 },
        { transform: 'scale(1) translateX(0)', opacity: 1 }
    ], { duration: 400, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });
}

function _showClaimAlert(count) {
    const body = count === 1
        ? '1 claim has been open over 7 days. Please review it.'
        : `${count} claims have been open over 7 days. Please review them.`;
    _renderClaimBubble('⚠️', 'Claims Review', body);
}

// Console preview of the red aging-claim bubble (no need to wait 7 days):
// open DevTools → console and run:  _previewClaimAlert()
window._previewClaimAlert = function () { _showClaimAlert(2); };

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
    setInterval(() => { fetchAndDisplayStoreComment(); checkClaimReminders(); }, 30 * 1000);
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
        await postWrite(STORE_COMMENT_URL, payload);

        alert("Success! The message is live for " + store);
        closeAllModals();
    } catch (e) {
        alert("Failed to send the message: " + (e.message || e));
    } finally {
        btn.innerText = "Send Message";
        btn.style.opacity = "1";
    }
}

// Helper to close the bubble (comments already marked seen when bubble was shown)
window.closeDailyCommentBubble = function() {
    const bubble = document.getElementById('dailyMessageBubble');
    if (bubble) bubble.style.display = 'none';
    if (typeof _positionClaimAlert === 'function') _positionClaimAlert(); // claim alert moves back up
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
                    if (typeof _positionClaimAlert === 'function') _positionClaimAlert(); // push the red claim alert below this
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

        // 4. FETCH BUYERS — ranks by the Buyer Champion Final Score from the old
        // Team Member KPIs "Weekly Scores" tab, computed from each store's weekly entries:
        //   Final = (ConvScore + MarginScore) × (BuyValue + 1.2 × #Converted) / 100
        try {
            const buyerFetches = stores.map(s => fetch(`${WEEKLY_KPI_URL}?store=${s}&v=${Date.now()}`).then(r => r.json()));
            const buyerResults = await Promise.all(buyerFetches);
            buyerResults.forEach((d, storeIdx) => {
                (d.employees || []).forEach(e => {
                    const bv  = parseNum(e.buying_value);
                    const bc  = parseNum(e.buying_cost);
                    const tc  = parseNum(e.transaction_count);
                    const tco = parseNum(e.transaction_converted);
                    if (bv <= 0) return;
                    const conv = tc > 0 ? tco / tc : 0;
                    const gm   = 1 - bc / bv;
                    const convScore = conv >= 0.95 ? 100 : conv >= 0.9 ? 400 * conv - 280 : conv >= 0.8 ? 600 * conv - 460 : conv >= 0.7 ? 200 * conv - 140 : 0;
                    const mgnScore  = gm >= 0.6 ? 100 : gm >= 0.5 ? 800 * gm - 380 : gm >= 0.45 ? 400 * gm - 180 : 0;
                    const score = ((convScore + mgnScore) * (bv + tco * 1.2)) / 100;
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
                
                // Render the inner number/label block for Lister, Review, and Buyer podiums.
                // Buyer raw score scales with dollars (tens of thousands), so show a
                // compact, absolute "points" figure: the raw score / 100, rounded. This
                // preserves the exact ranking while staying small and readable.
                let blockContent = '';
                if (type === 'lister' || type === 'review' || type === 'buyer') {
                    const val = type === 'lister' ? emp.listed
                              : type === 'review' ? emp.reviews
                              : Math.round(emp.score / 100);
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
// Tracks optimistic toggle state for up to 20 seconds so a slow backend response
// can't overwrite a locally-checked item before Apps Script persists it.
const _pendingToggles = new Map(); // id -> { checked, expiresAt }

function _applyPendingToggles() {
    const now = Date.now();
    for (const [id, { checked, expiresAt }] of _pendingToggles) {
        if (now > expiresAt) { _pendingToggles.delete(id); continue; }
        for (const tab of Object.keys(checklistDataCache)) {
            const item = checklistDataCache[tab].find(i => i.id === id);
            if (item) item.checked = checked;
        }
    }
}

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
    // Only run when the panel is actually opening — not on close.
    // Without this guard, the GET races against the in-flight toggle POST and
    // overwrites the cache with stale (unchecked) data before the backend saves.
    const panel = document.getElementById('checklistSidePanel');
    if (!panel?.classList.contains('open')) return;

    const container = document.getElementById('checklistContent');
    const userName = getChecklistUser();
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';

    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase();
    const isASM = role === 'assistant manager';

    // ASMs see Daily and Weekly; Monthly and Quarterly remain hidden for them
    const weeklyTab = document.getElementById('cl-tab-weekly');
    const monthlyTab = document.getElementById('cl-tab-monthly');
    if (weeklyTab) weeklyTab.style.display = '';
    if (monthlyTab) monthlyTab.style.display = isASM ? 'none' : '';
    if (isASM && currentChecklistTab !== 'daily' && currentChecklistTab !== 'weekly') switchChecklistTab('daily');

    // Only show Quarterly tab for CORP/ALL stores (never for ASMs)
    const qTab = document.getElementById('cl-tab-quarterly');
    if (qTab) {
        if (!isASM && (store === 'CORP' || store === 'ALL')) {
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
        _applyPendingToggles();
        renderChecklist();
    } catch (e) {
        console.error("Checklist Fetch Error", e);
        container.innerHTML = '<div class="status-message" style="color: var(--red-alert);">Failed to load checklist.</div>';
    }
}

function renderChecklist() {
    const container = document.getElementById('checklistContent');
    const rawItems = checklistDataCache[currentChecklistTab] || [];

    // Collapse duplicate GLOBAL/required tasks (same text) that a manager can't
    // delete themselves — e.g. LEE daily had "Live Product Category Check" twice.
    // Personal items are left alone (those have their own delete button).
    const seenGlobal = new Set();
    const items = rawItems.filter(it => {
        if (it.isGlobal) {
            const key = String(it.text || '').trim().toLowerCase();
            if (seenGlobal.has(key)) return false;
            seenGlobal.add(key);
        }
        return true;
    });

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
    // Protect this optimistic state for 20s so a slow server response can't overwrite it
    _pendingToggles.set(id, { checked: isChecked, expiresAt: Date.now() + 20000 });
    renderChecklist();

    postWrite(CHECKLIST_URL, { action: 'toggle', id: id, checked: isChecked, tab: currentChecklistTab, user: userName, store: store })
        .catch(err => {
            // Write failed — revert the optimistic toggle so the UI matches the server.
            const it = checklistDataCache[currentChecklistTab].find(i => i.id === id);
            if (it) it.checked = !isChecked;
            _pendingToggles.delete(id);
            renderChecklist();
            alert('Could not save that change: ' + err.message);
        });
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
        const out = await postWrite(CHECKLIST_URL, payload);

        // Add to local cache so they see it instantly (use the server id when returned)
        checklistDataCache[currentChecklistTab].push({ id: out.id || tempId, text: text, isGlobal: false, checked: false });
        renderChecklist();
    } catch (e) {
        alert("Failed to add task: " + (e.message || e));
    } finally {
        input.value = '';
        input.disabled = false;
        input.focus();
    }
}

async function deleteChecklistItem(id) {
    const userName = getChecklistUser();
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';

    const removed = checklistDataCache[currentChecklistTab].find(i => i.id === id);
    checklistDataCache[currentChecklistTab] = checklistDataCache[currentChecklistTab].filter(i => i.id !== id);
    renderChecklist();

    postWrite(CHECKLIST_URL, { action: 'delete', id: id, tab: currentChecklistTab, user: userName, store: store })
        .catch(err => {
            // Restore the item if the server rejected the delete.
            if (removed) { checklistDataCache[currentChecklistTab].push(removed); renderChecklist(); }
            alert('Could not delete task: ' + err.message);
        });
}

function clearChecklistTab() {
    const items = checklistDataCache[currentChecklistTab] || [];
    const checkedItems = items.filter(i => i.checked);
    if (checkedItems.length === 0) return;

    const userName = getChecklistUser();
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';

    items.forEach(i => i.checked = false);
    renderChecklist();

    Promise.allSettled(checkedItems.map(item =>
        postWrite(CHECKLIST_URL, { action: 'toggle', id: item.id, checked: false, tab: currentChecklistTab, user: userName, store: store })
            .then(() => ({ ok: true }))
            .catch(() => ({ ok: false, item }))
    )).then(results => {
        const failed = results.filter(r => r.value && !r.value.ok).map(r => r.value.item);
        if (failed.length) {
            // Re-check the ones the server didn't accept so the UI stays truthful.
            failed.forEach(it => {
                const c = checklistDataCache[currentChecklistTab].find(i => i.id === it.id);
                if (c) c.checked = true;
            });
            renderChecklist();
            alert('Some items could not be cleared — please try again.');
        }
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

// Fetches checklist data at startup to populate the progress chip without opening the panel.
// Uses a separate path from loadChecklist() so the panel-open guard doesn't suppress it.
async function _prefetchChecklistForChip() {
    const userName = getChecklistUser();
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';
    try {
        const res = await fetch(`${CHECKLIST_URL}?user=${encodeURIComponent(userName)}&store=${store}&v=${Date.now()}`);
        checklistDataCache = await res.json();
        _applyPendingToggles();
        updateChecklistChip();
    } catch (_) {}
}

// --- BULLETPROOF TOGGLE & CLICK-AWAY LOGIC ---
let _clSyncInterval = null;

function _startChecklistSync() {
    if (_clSyncInterval) return;
    _clSyncInterval = setInterval(async () => {
        const panel = document.getElementById('checklistSidePanel');
        if (!panel?.classList.contains('open')) return;
        const userName = getChecklistUser();
        const store = sessionStorage.getItem('speeksUserStore') || 'OVL';
        try {
            const res = await fetch(`${CHECKLIST_URL}?user=${encodeURIComponent(userName)}&store=${store}&v=${Date.now()}`);
            checklistDataCache = await res.json();
            _applyPendingToggles();
            renderChecklist();
        } catch (_) {}
    }, 30000);
}

function _stopChecklistSync() {
    if (_clSyncInterval) { clearInterval(_clSyncInterval); _clSyncInterval = null; }
}

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
        document.getElementById('auditSidePanel')?.classList.remove('open');
        document.querySelector('.audit-nav-toggle')?.classList.remove('panel-active');
        _stopAuditSync?.();
        _resetToCurrentMonth?.();
        _startChecklistSync();
    } else {
        _stopChecklistSync();
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
            _stopChecklistSync();
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

    const auditPanel = document.getElementById('auditSidePanel');
    const auditToggle = document.querySelector('.audit-nav-toggle');
    if (auditPanel && auditPanel.classList.contains('open')) {
        if (!auditPanel.contains(e.target) && !auditToggle?.contains(e.target)) {
            auditPanel.classList.remove('open');
            auditToggle?.classList.remove('panel-active');
            _stopAuditSync();
        }
    }
});

// =============================================================================
// STORE AUDIT CHECKLIST — PayMore audit-readiness, shared per store.
// Two tabs: Daily (resets each day) and Weekly (resets each Monday). Reads a
// fixed admin-defined list (store-audit fn); completions are shared per store.
// =============================================================================
let auditDataCache = { daily: { items: [], total: 0, completed: 0 }, weekly: { items: [], total: 0, completed: 0 } };
let currentAuditTab = 'daily';
let _auditSyncInterval = null;

function _auditTab(tab) { return auditDataCache[tab] || { items: [], total: 0, completed: 0 }; }

function switchAuditTab(tab) {
    currentAuditTab = tab;
    document.getElementById('audit-tab-daily')?.classList.toggle('active', tab === 'daily');
    document.getElementById('audit-tab-weekly')?.classList.toggle('active', tab === 'weekly');
    renderAudit();
}

async function loadAudit() {
    const panel = document.getElementById('auditSidePanel');
    if (!panel?.classList.contains('open')) return;   // only fetch when opening
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';
    const container = document.getElementById('auditContent');
    if (container) container.innerHTML = '<div class="status-message">Syncing Audit...</div>';
    try {
        const res = await fetch(`${STORE_AUDIT_URL}?store=${store}&v=${Date.now()}`);
        auditDataCache = await res.json();
        renderAudit();
    } catch (e) {
        console.error('Audit Fetch Error', e);
        if (container) container.innerHTML = '<div class="status-message" style="color: var(--red-alert);">Failed to load audit checklist.</div>';
    }
}

function renderAudit() {
    const container = document.getElementById('auditContent');
    if (!container) return;
    const data = _auditTab(currentAuditTab);
    const items = data.items || [];

    const label = document.getElementById('audit-week-label');
    if (label) {
        label.textContent = items.length
            ? `${data.completed || 0}/${data.total || items.length} complete ${currentAuditTab === 'daily' ? 'today' : 'this week'}`
            : '';
    }

    if (items.length === 0) {
        container.innerHTML = `<div style="text-align: center; padding: 30px; color: #888; font-weight: 600; font-size: 13px;">No ${currentAuditTab} audit items have been set up yet.</div>`;
        updateAuditChip();
        return;
    }

    let html = '';
    let lastSection = null;
    items.forEach(item => {
        if (item.section !== lastSection) {
            html += `<div style="font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px; color: #94a3b8; margin: 14px 4px 6px;">${escapeHtml(item.section)}</div>`;
            lastSection = item.section;
        }
        const completedClass = item.checked ? 'completed' : '';
        html += `
        <div class="cl-item ${completedClass}">
            <input type="checkbox" class="cl-checkbox" ${item.checked ? 'checked' : ''} onchange="toggleAuditState('${item.id}', this.checked)">
            <div class="cl-content-wrapper" style="justify-content: center;">
                <span class="cl-text">${escapeHtml(item.text)}</span>
            </div>
        </div>`;
    });
    container.innerHTML = html;
    updateAuditChip();
}

async function toggleAuditState(id, isChecked) {
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';
    const userName = sessionStorage.getItem('speeksUserName') || 'Unknown';
    const tab = currentAuditTab;
    const data = _auditTab(tab);

    const item = (data.items || []).find(i => i.id === id);
    if (item) item.checked = isChecked;
    data.completed = (data.items || []).filter(i => i.checked).length;
    renderAudit();

    postWrite(STORE_AUDIT_URL, { action: 'toggle', id: id, checked: isChecked, store: store, user: userName, period: tab })
        .catch(err => {
            if (item) item.checked = !isChecked;
            data.completed = (data.items || []).filter(i => i.checked).length;
            renderAudit();
            alert('Could not save that change: ' + err.message);
        });
}

function updateAuditChip() {
    const chip = document.getElementById('audit-progress-chip');
    const btn = document.querySelector('.audit-nav-toggle');
    if (!chip || !btn) return;

    // Chip reflects the DAILY list (the everyday cadence).
    const daily = _auditTab('daily');
    const total = daily.total || (daily.items || []).length;
    if (total === 0) {
        chip.textContent = '';
        btn.classList.remove('cl-needs-attention');
        return;
    }
    const done = (daily.completed != null) ? daily.completed : (daily.items || []).filter(i => i.checked).length;
    chip.textContent = done === total ? '✓ All done' : `${done}/${total} today`;

    const panel = document.getElementById('auditSidePanel');
    const isOpen = panel && panel.classList.contains('open');
    btn.classList.toggle('cl-needs-attention', done < total && !isOpen);
}

async function _prefetchAuditForChip() {
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';
    try {
        const res = await fetch(`${STORE_AUDIT_URL}?store=${store}&v=${Date.now()}`);
        auditDataCache = await res.json();
        updateAuditChip();
    } catch (_) {}
}

function _startAuditSync() {
    if (_auditSyncInterval) return;
    _auditSyncInterval = setInterval(async () => {
        const panel = document.getElementById('auditSidePanel');
        if (!panel?.classList.contains('open')) return;
        const store = sessionStorage.getItem('speeksUserStore') || 'OVL';
        try {
            const res = await fetch(`${STORE_AUDIT_URL}?store=${store}&v=${Date.now()}`);
            auditDataCache = await res.json();
            renderAudit();
        } catch (_) {}
    }, 30000);
}

function _stopAuditSync() {
    if (_auditSyncInterval) { clearInterval(_auditSyncInterval); _auditSyncInterval = null; }
}

window.toggleAuditPanel = function(event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('auditSidePanel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    const toggle = document.querySelector('.audit-nav-toggle');
    if (toggle) {
        toggle.classList.toggle('panel-active', isOpen);
        if (isOpen) toggle.classList.remove('cl-needs-attention');
    }
    if (isOpen) {
        // mutually exclusive with the other side panels
        document.getElementById('checklistSidePanel')?.classList.remove('open');
        document.querySelector('.cl-nav-toggle')?.classList.remove('panel-active');
        _stopChecklistSync?.();
        document.getElementById('goalsSidePanel')?.classList.remove('open');
        document.querySelector('.gi-nav-toggle')?.classList.remove('panel-active');
        _startAuditSync();
    } else {
        _stopAuditSync();
    }
};

// --- ROLE SELECTION LOGIC ---
// Per-role capacity: most roles are 1-per-store, but a store can run TWO listers.
const ROLE_CAP = { B1: 1, B2: 1, L1: 1, L2: 1 };

window.updateRoleLocks = function() {
    // Count how many people currently hold each role.
    const counts = {};
    document.querySelectorAll('.role-dot.active').forEach(btn => {
        const r = btn.innerText;
        counts[r] = (counts[r] || 0) + 1;
    });

    document.querySelectorAll('.role-dot').forEach(btn => {
        if (btn.classList.contains('active')) {
            // Active buttons always look fully visible.
            if (!btn.hasAttribute('disabled')) { btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }
            return;
        }
        const role = btn.innerText;
        const cap = ROLE_CAP[role] || 1;
        const isFull = (counts[role] || 0) >= cap;
        if (isFull) {
            // At capacity for this role. (L1 still allows a deliberate swap — see selectRole.)
            btn.style.opacity = '0.3';
            btn.style.cursor = 'not-allowed';
            btn.dataset.roleTaken = 'true';
        } else if (!btn.hasAttribute('disabled')) {
            // Only restore if it isn't locked by the 10:30am cutoff.
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.dataset.roleTaken = 'false';
        }
    });
};

window.selectRole = function(clickedBtn, emp, role) {
    if (clickedBtn.hasAttribute('disabled')) return;

    const isAlreadyActive = clickedBtn.classList.contains('active');

    // 1. If clicking the already active role, toggle it off and free it up.
    if (isAlreadyActive) {
        clickedBtn.classList.remove('active');
        updateRoleLocks();
        recomputeGoalDisplays();
        scheduleGoalsAutosave();
        return;
    }

    // 2. Role already taken by someone else? One person per role.
    if (clickedBtn.dataset.roleTaken === 'true') {
        alert(`The role ${role} is already assigned to another team member. Please deselect it from them first.`);
        return;
    }

    // 3. Remove ALL roles from the CURRENT employee (only 1 role per person).
    const parentRow = clickedBtn.closest('.goals-edit-roles');
    if (parentRow) {
        parentRow.querySelectorAll('.role-dot').forEach(btn => btn.classList.remove('active'));
    }

    // 4. Activate the clicked button.
    clickedBtn.classList.add('active');

    updateRoleLocks();
    recomputeGoalDisplays();
    scheduleGoalsAutosave();
};

// Recompute every visible auto-goal from the currently selected roles.
window.recomputeGoalDisplays = function() {
    if (!document.getElementById('goal-display-0') && !document.querySelector('.goal-auto-display')) return;
    let staffedCount = 0;
    goalsRoster.forEach((emp, idx) => {
        const group = document.getElementById(`roles-${idx}`);
        if (group && group.querySelector('.role-dot.active')) staffedCount++;
    });
    const rosterSize = effectiveTeamSize(goalsTargetStore);
    const dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });

    let todayTotal = 0;
    let weekTotal = 0;
    goalsRoster.forEach((emp, idx) => {
        const group = document.getElementById(`roles-${idx}`);
        const activeBtn = group?.querySelector('.role-dot.active');
        const role = activeBtn ? activeBtn.innerText : '-';
        const todayGoal = role !== '-' ? ListingGoalsEngine.goalFor(role, dateStr, rosterSize, staffedCount) : 0;

        const disp = document.getElementById(`goal-display-${idx}`);
        if (disp) {
            disp.innerText = role === '-' ? '–' : todayGoal;
            disp.classList.toggle('goal-auto-set', role !== '-');
        }
        todayTotal += todayGoal;

        const weekVal = (_priorWeekGoals[idx] || 0) + todayGoal;
        const wkEl = document.getElementById(`week-display-${idx}`);
        if (wkEl) wkEl.innerText = weekVal || '–';
        weekTotal += weekVal;
    });

    const todayEl = document.getElementById('goals-total-target');
    if (todayEl) todayEl.innerText = todayTotal;
    const weekEl = document.getElementById('goals-total-actual');
    if (weekEl) weekEl.innerText = weekTotal;
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
        await postWrite(PATCH_NOTES_URL, { action: 'addEntries', title, date, items });
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

    list.innerHTML = sorted.map((group, gi) => {
        const vLabel = group.title;
        const safeTitle = group.title.replace(/"/g, '&quot;');
        return `
            <div class="pne-group" id="pne-group-${gi}" data-title="${safeTitle}" data-date="${group.date}">
                <div class="pne-group-header">
                    <div class="pne-group-view">
                        <span class="pne-group-title">${vLabel}</span>
                        <span class="pne-group-date">${formatPatchDate(group.date)}</span>
                        <button class="pne-btn pne-group-edit-btn" onclick="startEditPatchGroup(${gi})">Edit Version</button>
                    </div>
                </div>
                ${group.items.map(item => `
                    <div class="pne-item" id="pne-item-${item.id}"
                         data-id="${item.id}"
                         data-category="${item.category}"
                         data-summary="${item.summary.replace(/"/g, '&quot;').replace(/\n/g, '&#10;')}"
                         data-title="${group.title}"
                         data-date="${group.date}">
                        <div class="pne-item-view">
                            <span class="pn-badge ${catBadge[item.category] || ''}">${item.category}</span>
                            <span class="pne-item-summary">${item.summary.replace(/\n/g, ' ')}</span>
                            <div class="pne-item-actions">
                                <button class="pne-btn" onclick="startEditPatchItem('${item.id}')">Edit</button>
                                <button class="pne-btn pne-btn-delete" onclick="promptDeletePatchItem('${item.id}')">Delete</button>
                            </div>
                        </div>
                    </div>`).join('')}
            </div>`;
    }).join('');
}

// --- Edit a whole version's title + date (applies to all its items) ---
function startEditPatchGroup(gi) {
    const el = document.getElementById(`pne-group-${gi}`);
    if (!el) return;
    const title = el.dataset.title || '';
    const date  = el.dataset.date  || '';
    const header = el.querySelector('.pne-group-header');
    const view   = el.querySelector('.pne-group-view');
    if (view) view.style.display = 'none';

    const editDiv = document.createElement('div');
    editDiv.className = 'pne-group-edit';
    editDiv.innerHTML = `
        <input type="text" class="form-input-lg pne-edit-gtitle" value="${title.replace(/"/g, '&quot;')}" placeholder="Version title">
        <input type="date" class="form-input-lg pne-edit-gdate" value="${date}">
        <div class="pne-edit-actions">
            <button class="btn-primary" onclick="saveEditPatchGroup(${gi})">Save</button>
            <button class="pne-btn" onclick="cancelEditPatchGroup(${gi})">Cancel</button>
        </div>`;
    if (header) header.appendChild(editDiv);
}

function cancelEditPatchGroup(gi) {
    const el = document.getElementById(`pne-group-${gi}`);
    if (!el) return;
    const view    = el.querySelector('.pne-group-view');
    const editDiv = el.querySelector('.pne-group-edit');
    if (view) view.style.display = '';
    if (editDiv) editDiv.remove();
}

async function saveEditPatchGroup(gi) {
    const el = document.getElementById(`pne-group-${gi}`);
    if (!el) return;
    const oldTitle = el.dataset.title;
    const oldDate  = el.dataset.date;
    const title    = el.querySelector('.pne-edit-gtitle').value.trim();
    const dateRaw  = el.querySelector('.pne-edit-gdate').value; // YYYY-MM-DD
    if (!title || !dateRaw) return;

    const saveBtn = el.querySelector('.btn-primary');
    if (saveBtn) { saveBtn.textContent = 'Saving...'; saveBtn.disabled = true; }

    try {
        await postWrite(PATCH_NOTES_URL, { action: 'editGroup', oldTitle, oldDate, title, date: dateRaw });
        loadPatchNotesEditor();
    } catch (e) {
        if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        alert('Failed to save changes: ' + (e.message || e));
    }
}

function startEditPatchItem(id) {
    const el = document.getElementById(`pne-item-${id}`);
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
            <button class="btn-primary" onclick="saveEditPatchItem('${id}')">Save Changes</button>
            <button class="pne-btn" onclick="cancelEditPatchItem('${id}')">Cancel</button>
        </div>`;
    el.appendChild(editDiv);
}

function cancelEditPatchItem(id) {
    const el = document.getElementById(`pne-item-${id}`);
    if (!el) return;
    const viewDiv = el.querySelector('.pne-item-view');
    const editDiv = el.querySelector('.pne-item-edit');
    if (viewDiv) viewDiv.style.display = '';
    if (editDiv) editDiv.remove();
}

async function saveEditPatchItem(id) {
    const el       = document.getElementById(`pne-item-${id}`);
    if (!el) return;
    const category = el.querySelector('.pne-edit-cat').value;
    const summary  = el.querySelector('.pne-edit-sum').value.trim();
    const { title, date } = el.dataset;
    if (!category || !summary) return;

    const saveBtn = el.querySelector('.btn-primary');
    if (saveBtn) saveBtn.textContent = 'Saving...';
    if (saveBtn) saveBtn.disabled = true;

    try {
        await postWrite(PATCH_NOTES_URL, { action: 'editEntry', id, title, date, category, summary });
        loadPatchNotesEditor();
    } catch (e) {
        if (saveBtn) { saveBtn.textContent = 'Save Changes'; saveBtn.disabled = false; }
        alert('Failed to save changes: ' + (e.message || e));
    }
}

function promptDeletePatchItem(id) {
    const el = document.getElementById(`pne-item-${id}`);
    if (!el) return;
    const actions = el.querySelector('.pne-item-actions');
    if (!actions) return;
    actions.innerHTML = `
        <span class="pne-confirm-label">Delete this item?</span>
        <button class="pne-btn pne-btn-confirm-delete" onclick="confirmDeletePatchItem('${id}')">Yes, Delete</button>
        <button class="pne-btn" onclick="loadPatchNotesEditor()">Cancel</button>`;
}

async function confirmDeletePatchItem(id) {
    const btn = document.querySelector(`#pne-item-${id} .pne-btn-confirm-delete`);
    if (btn) { btn.textContent = 'Deleting...'; btn.disabled = true; }
    try {
        await postWrite(PATCH_NOTES_URL, { action: 'deleteEntry', id });
    } catch (e) {
        alert('Delete failed: ' + (e.message || e));
    }
    loadPatchNotesEditor();
}

// ============================================================
// BOX ORDER TOOL
// ============================================================

const BOX_STORE_NAMES = {
    'OVL': 'Overland Park',
    'LEE': "Lee's Summit",
    'WSP': 'Westport',
    'MPL': 'Maplewood',
    'BAL': 'Ballwin'
};

// Maps each store to the supplier email its box orders should be sent to.
const BOX_ORDER_STORE_EMAILS = {
    'OVL': 'doug@crosscorpusa.com',
    'LEE': 'doug@crosscorpusa.com',
    'WSP': 'doug@crosscorpusa.com',
    'MPL': 'jordan@cleancarton.com',
    'BAL': 'jordan@cleancarton.com'
};

function _boxOrderGetStoreCode() {
    const selectorEl = document.getElementById('boxOrderStoreSelector');
    const corpVisible = selectorEl && selectorEl.style.display !== 'none';
    const sel = document.getElementById('boxOrderStoreSelect');
    return (corpVisible && sel && sel.value) ? sel.value : (sessionStorage.getItem('speeksUserStore') || '');
}

function _boxOrderGetStore() {
    const code = _boxOrderGetStoreCode();
    return BOX_STORE_NAMES[code] || code || 'Store';
}

// Resolves the destination email from the selected store, falling back to the
// configured primary email (and finally a placeholder) when no store maps.
function _boxOrderGetEmail() {
    const code = _boxOrderGetStoreCode();
    return BOX_ORDER_STORE_EMAILS[code] || _boxOrderEmails.primary || 'orders@placeholder.com';
}

let _boxOrderEmails = { primary: '', secondary: '' };
// Full box-order catalog (all store variants), kept so the vendor email can resolve
// the correct per-store spec for products that differ by store (e.g. Packing Paper).
let _boxOrderAllItems = [];

// For a selected line, return the vendor spec (order_name) that matches the chosen
// store — preferring a store-specific variant of the same product. Falls back to
// whatever spec the selected row carried (or '' for plain items).
function _resolveOrderName(o) {
    const code = (_boxOrderGetStoreCode() || '').toUpperCase();
    if (code && Array.isArray(_boxOrderAllItems)) {
        const match = _boxOrderAllItems.find(it =>
            it.order_name && it.name === o.name && it.category === o.category &&
            (it.stores || '').split(',').map(s => s.trim().toUpperCase()).includes(code));
        if (match) return match.order_name;
    }
    return o.orderName || '';
}

async function toggleBoxOrder() {
    closeAllModals();
    const modal = document.getElementById('boxOrderModal');
    if (!modal) return;
    // Always start on page 1
    document.getElementById('boxOrderPage1').style.display    = '';
    document.getElementById('boxOrderFooter1').style.display  = '';
    document.getElementById('boxOrderPage2').style.display    = 'none';
    document.getElementById('boxOrderFooter2').style.display  = 'none';
    const searchEl = document.getElementById('boxOrderSearch');
    if (searchEl) searchEl.value = '';
    modal.classList.add('show');
    lockAndBlurScreen();
    await _loadBoxOrderData();
}

async function _loadBoxOrderData() {
    const container = document.getElementById('boxOrderItemsContainer');
    if (!container) return;
    container.innerHTML = '<div style="color:#a0aab2;font-size:13px;padding:12px 0;">Loading items...</div>';
    const h = { 'apikey': _SUPABASE_ANON_KEY, 'Authorization': `Bearer ${_SUPABASE_ANON_KEY}` };
    try {
        const [iRes, cRes] = await Promise.all([
            fetch(BOX_ITEMS_URL, { headers: h }),
            fetch(BOX_CONFIG_URL, { headers: h })
        ]);
        const items  = await iRes.json();
        const config = await cRes.json();
        if (Array.isArray(config)) {
            config.forEach(c => {
                if (c.key === 'email_primary')   _boxOrderEmails.primary   = c.value;
                if (c.key === 'email_secondary')  _boxOrderEmails.secondary = c.value;
            });
        }
        _renderBoxOrderItems(container, Array.isArray(items) ? items : []);
    } catch (e) {
        container.innerHTML = '<div style="color:#ef4444;font-size:13px;">Failed to load items. Please try again.</div>';
    }
}

function _renderBoxOrderItems(container, items) {
    // Keep the full catalog (every store variant) so the email can resolve the right
    // per-store spec later — even for rows corp collapses into one line.
    _boxOrderAllItems = Array.isArray(items) ? items.slice() : [];
    // Some items are store-specific (e.g. MPL/BAL use a different supplier than the
    // other stores). Show an item only if it has no store restriction, or the
    // current store is in its list. Corp roles (CEO/DM) choose the store on the
    // next page, so they see every item here.
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const isCorp = role === 'ceo' || role === 'district manager';
    const storeCode = (sessionStorage.getItem('speeksUserStore') || '').toUpperCase();
    items = (items || []).filter(it => {
        const s = (it.stores || '').trim();
        if (!s) return true;        // no restriction → all stores
        if (isCorp) return true;    // corp picks the store later → show it
        return s.split(',').map(x => x.trim().toUpperCase()).includes(storeCode);
    });
    // Collapse per-store variants that share a name (e.g. "Packing Paper" differs by
    // supplier) into ONE row. Corp then sees a single line and the vendor email
    // resolves the correct spec from the store they pick on the next page. Managers
    // only ever have their own store's variant here, so this is a no-op for them.
    const seenVariant = new Set();
    items = items.filter(it => {
        if (!(it.stores || '').trim()) return true;   // non-scoped items never collapse
        const k = `${it.category}|${it.name}`;
        if (seenVariant.has(k)) return false;
        seenVariant.add(k);
        return true;
    });
    const BUCKETS = [
        { key: 'Common Box',       label: 'Common Boxes' },
        { key: 'Rare Box',         label: 'Rare Boxes' },
        { key: 'Very Rare Box',    label: 'Very Rare Boxes' },
        { key: 'Shipping Supplies',  label: 'Shipping Supplies' },
        { key: 'White Storage Box', label: 'White Storage Boxes' },
        { key: 'Bubble Mailer',     label: 'Bubble Mailers' },
    ];
    let html = '';

    const buildSection = (label, group, includeHdWarning) => {
        let itemsHtml = '';
        group.forEach(item => {
            itemsHtml += _buildBoxRow(item);
            if (includeHdWarning && item.is_heavy_duty) {
                itemsHtml += '<div class="box-order-warning">⚠ HD boxes are significantly more expensive per unit. Only order what is truly needed.</div>';
            }
        });
        return `<div class="box-order-section">
  <div class="box-order-section-label box-order-collapsible" onclick="boxOrderToggleSection(this)">
    <span>${label}</span><span class="box-order-chevron" style="transform:rotate(-90deg)">▾</span>
  </div>
  <div class="box-order-section-items" style="display:none">${itemsHtml}</div>
</div>`;
    };

    BUCKETS.forEach(({ key, label }) => {
        const group = items.filter(i => i.category === key);
        if (group.length) html += buildSection(label, group, key === 'Rare Box');
    });

    container.innerHTML = html || '<div style="color:#a0aab2;font-size:13px;">No items found.</div>';
}

// Live search over the box-order items. Matches name / category / dimensions
// (× and x treated the same). Matching sections expand; the rest collapse.
// Clearing the box restores the default collapsed accordion.
function filterBoxOrderItems() {
    const input = document.getElementById('boxOrderSearch');
    const container = document.getElementById('boxOrderItemsContainer');
    if (!input || !container) return;
    const norm = s => (s || '').toLowerCase().replace(/×/g, 'x');
    const q = norm(input.value.trim());
    container.querySelectorAll('.box-order-section').forEach(section => {
        const itemsEl = section.querySelector('.box-order-section-items');
        const chevron = section.querySelector('.box-order-chevron');
        let anyMatch = false;
        section.querySelectorAll('.box-order-row').forEach(row => {
            if (!q) { row.style.display = ''; return; }
            const hay = norm((row.dataset.name || '') + ' ' + (row.dataset.category || '') + ' ' +
                (row.querySelector('.box-order-subtype')?.textContent || ''));
            const match = hay.includes(q);
            row.style.display = match ? '' : 'none';
            if (match) anyMatch = true;
        });
        // Heavy-duty warnings are advisory — hide them while searching.
        section.querySelectorAll('.box-order-warning').forEach(w => { w.style.display = q ? 'none' : ''; });
        if (!q) {
            section.style.display = '';
            if (itemsEl) itemsEl.style.display = 'none';
            if (chevron) chevron.style.transform = 'rotate(-90deg)';
        } else {
            section.style.display = anyMatch ? '' : 'none';
            if (itemsEl) itemsEl.style.display = anyMatch ? '' : 'none';
            if (chevron) chevron.style.transform = anyMatch ? '' : 'rotate(-90deg)';
        }
    });
}

function boxOrderToggleSection(labelEl) {
    const section = labelEl.closest('.box-order-section');
    const itemsEl = section.querySelector('.box-order-section-items');
    const chevron = labelEl.querySelector('.box-order-chevron');
    const willOpen = itemsEl.style.display === 'none';
    // Accordion: close every section first, then open the clicked one (if it was
    // closed) — so only one section is ever open at a time.
    const container = section.parentElement;
    if (container) {
        container.querySelectorAll('.box-order-section').forEach(s => {
            const it = s.querySelector('.box-order-section-items');
            const ch = s.querySelector('.box-order-chevron');
            if (it) it.style.display = 'none';
            if (ch) ch.style.transform = 'rotate(-90deg)';
        });
    }
    if (willOpen) {
        itemsEl.style.display = '';
        chevron.style.transform = '';
    }
}

function _buildBoxRow(item) {
    const displayCat = item.category.replace(/^(?:Common |Rare |Very Rare )/, '');
    const label      = escapeHtml(`${item.name} ${displayCat}`);
    const nameHtml   = escapeHtml(item.name);
    const catHtml    = escapeHtml(item.category || '');
    const bundleSize = Math.max(1, parseInt(item.bundle_size) || 1);
    // The stepper counts individual units; clicking +/- jumps by one bundle so a
    // manager always sees the true unit count. Surface the bundle size so it's
    // clear why the number jumps the way it does.
    const subParts   = [item.dimensions, displayCat].filter(Boolean);
    if (bundleSize > 1) subParts.push(`${bundleSize}/bundle`);
    const subHtml    = escapeHtml(subParts.join(' · '));
    const orderNameHtml = escapeHtml(item.order_name || '');
    return `<div class="box-order-row" data-item="${label}" data-name="${nameHtml}" data-order-name="${orderNameHtml}" data-category="${catHtml}" data-bundle="${bundleSize}">
  <div class="box-order-info">
    <span class="box-order-name">${nameHtml}</span>
    <span class="box-order-subtype">${subHtml}</span>
  </div>
  <div class="box-order-stepper">
    <button class="box-stepper-btn" onclick="boxStepperChange(this,-1)">−</button>
    <span class="box-stepper-qty">0</span>
    <button class="box-stepper-btn" onclick="boxStepperChange(this,1)">+</button>
  </div>
</div>`;
}

function boxStepperChange(btn, delta) {
    const qtyEl  = btn.closest('.box-order-stepper').querySelector('.box-stepper-qty');
    const row    = btn.closest('.box-order-row');
    // Step by the bundle size so the displayed quantity is the actual unit count.
    const bundle = Math.max(1, parseInt(row.dataset.bundle) || 1);
    const next   = Math.max(0, (parseInt(qtyEl.textContent) || 0) + delta * bundle);
    qtyEl.textContent = next;
    qtyEl.classList.toggle('box-stepper-active', next > 0);
    row.classList.toggle('box-row-selected', next > 0);
}

let _boxOrderSelected = [];

function boxOrderNextPage() {
    const rows = document.querySelectorAll('#boxOrderItemsContainer .box-order-row');
    _boxOrderSelected = [];
    rows.forEach(row => {
        const qty = parseInt(row.querySelector('.box-stepper-qty')?.textContent) || 0;
        const bundle = Math.max(1, parseInt(row.dataset.bundle) || 1);
        if (qty > 0) _boxOrderSelected.push({ item: row.dataset.item, name: row.dataset.name, orderName: row.dataset.orderName, category: row.dataset.category, qty, bundle });
    });
    if (!_boxOrderSelected.length) {
        alert('Please add at least one item before continuing.');
        return;
    }
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const isCorpRole = role === 'ceo' || role === 'district manager';
    const selectorEl = document.getElementById('boxOrderStoreSelector');
    if (selectorEl) {
        selectorEl.style.display = isCorpRole ? '' : 'none';
        const sel = document.getElementById('boxOrderStoreSelect');
        // Corp picks a store here; default it to OVL so the preview is populated
        // right away (they can switch stores from the dropdown).
        if (sel) sel.value = isCorpRole ? 'OVL' : '';
    }
    const notesEl = document.getElementById('boxOrderNotes');
    if (notesEl) notesEl.value = '';
    boxOrderUpdatePreview();
    document.getElementById('boxOrderPage1').style.display    = 'none';
    document.getElementById('boxOrderFooter1').style.display  = 'none';
    document.getElementById('boxOrderPage2').style.display    = '';
    document.getElementById('boxOrderFooter2').style.display  = '';
}

function boxOrderBackPage() {
    document.getElementById('boxOrderPage2').style.display    = 'none';
    document.getElementById('boxOrderFooter2').style.display  = 'none';
    document.getElementById('boxOrderPage1').style.display    = '';
    document.getElementById('boxOrderFooter1').style.display  = '';
}

// Format one selected item for the order: drop the word "Box" from box sizes
// and "Shipping Supplies" from supplies, and pick the unit per item type
// (Peanuts → Bag(s), Gum Tape → Box(es), everything else → Bundle(s)).
// The stepper tracks individual units; convert back to bundle count here so the
// vendor email keeps reading in bundles (qty ÷ bundle size).
function _boxOrderLine(o) {
    const displayCat = (o.category || '')
        .replace(/^(?:Common |Rare |Very Rare )/, '')
        .replace(/\bShipping Supplies\b/i, '')
        .replace(/\bBox(?:es)?\b/i, '')
        .replace(/\s+/g, ' ').trim();
    // A store-facing UI name can differ from the full spec the vendor needs on the
    // order — order_name (when set) is what goes on the email; UI keeps the short name.
    // For per-store products (e.g. Packing Paper) resolve the spec from the chosen store.
    const orderName = _resolveOrderName(o);
    const display = orderName
        ? orderName
        : `${o.name || o.item || ''} ${displayCat}`.replace(/\s+/g, ' ').trim();
    const n = (o.name || '').toLowerCase();
    let one = 'Bundle', many = 'Bundles';
    if (n.includes('peanut'))        { one = 'Bag'; many = 'Bags'; }
    else if (n.includes('gum tape')) { one = 'Box'; many = 'Boxes'; }
    else if (n.includes('paper'))    { one = 'Roll'; many = 'Rolls'; }
    const bundle  = Math.max(1, parseInt(o.bundle) || 1);
    const bundles = Math.max(1, Math.round((o.qty || 0) / bundle));
    return `${display}: ${bundles} ${bundles === 1 ? one : many}`;
}

function boxOrderUpdatePreview() {
    const preview  = document.getElementById('boxOrderEmailPreview');
    if (!preview) return;
    const store    = _boxOrderGetStore();
    const userName = sessionStorage.getItem('speeksUserName')  || '';
    const notes    = document.getElementById('boxOrderNotes')?.value.trim() || '';
    const to       = _boxOrderGetEmail();
    const lines    = _boxOrderSelected.map(o => `  • ${_boxOrderLine(o)}`).join('\n');
    const noteBlock = notes ? `\n\n${notes}` : '';
    preview.textContent =
        `To: ${to}\nSubject: PayMore ${store} Location\n\n` +
        `Hi,\n\nPlease process the following order for ${store}:\n\n${lines}${noteBlock}\n\n` +
        `Thank you,\n${userName}`;
}

// Corp roles (CEO/DM) must pick a store first; managers default to their own.
function _boxOrderEnsureStore() {
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const isCorpRole = role === 'ceo' || role === 'district manager';
    const sel = document.getElementById('boxOrderStoreSelect');
    if (isCorpRole && (!sel || !sel.value)) {
        alert('Please select a store before sending.');
        return false;
    }
    return true;
}

// Build the order as plain text (real newlines) — shared by the email and the
// copy failsafe so both always say exactly the same thing.
function _boxOrderCompose() {
    const store    = _boxOrderGetStore();
    const userName = sessionStorage.getItem('speeksUserName') || '';
    const notes    = document.getElementById('boxOrderNotes')?.value.trim() || '';
    const lines    = _boxOrderSelected.map(o => `  • ${_boxOrderLine(o)}`).join('\n');
    const noteBlock = notes ? `\n\n${notes}` : '';
    const body = `Hi,\n\nPlease process the following order for ${store}:\n\n${lines}${noteBlock}\n\nThank you,\n${userName}`;
    return { email: _boxOrderGetEmail(), subject: `PayMore ${store} Location`, body };
}

function sendBoxOrder() {
    if (!_boxOrderEnsureStore()) return;
    const { email, subject, body } = _boxOrderCompose();
    window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Failsafe for machines with no default mail client: copy the full order
// (recipient, subject, body) to the clipboard to paste into any email.
function copyBoxOrder(button) {
    if (!_boxOrderEnsureStore()) return;
    const { email, subject, body } = _boxOrderCompose();
    const text = `To: ${email}\nSubject: ${subject}\n\n${body}`;
    navigator.clipboard.writeText(text).then(() => {
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
        }, 2000);
    }).catch(() => alert('Could not copy automatically. Please select and copy the order manually.'));
}

// ============================================================
// RECYCLE INVENTORY TOOL
// ============================================================
// Stores submit these when an item needs to be recycled out of inventory.
// Mirrors the Box Order flow (two-page form → mailto + copy failsafe) but is a
// free-text request that always routes to a single SPEEKS inbox.

const RECYCLE_INV_EMAIL = 'ethan.kushnir@speekstechnology.com';

// Corp roles (CEO/DM) pick a store; managers/ASM default to their own.
function _recycleInvGetStoreCode() {
    const selectorEl = document.getElementById('recycleInvStoreSelector');
    const corpVisible = selectorEl && selectorEl.style.display !== 'none';
    const sel = document.getElementById('recycleInvStoreSelect');
    return (corpVisible && sel && sel.value) ? sel.value : (sessionStorage.getItem('speeksUserStore') || '');
}

function _recycleInvGetStore() {
    const code = _recycleInvGetStoreCode();
    return BOX_STORE_NAMES[code] || code || 'Store';
}

// Keep money fields numeric: strip anything that isn't a digit or a decimal
// point (so a typed "$" simply vanishes) and allow only one decimal point.
function recycleInvSanitizeMoney(input) {
    let v = (input.value || '').replace(/[^\d.]/g, '');
    const firstDot = v.indexOf('.');
    if (firstDot !== -1) {
        v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
    }
    input.value = v;
}

// Normalize a money field for the email: exactly one leading "$" plus thousands
// separators ("12345" → "$12,345", "$25" → "$25", "1234.5" → "$1,234.5").
// Decimals are kept only if typed, capped at two places. Empty stays empty.
function _recycleInvFormatMoney(raw) {
    const v = String(raw || '').replace(/[^\d.]/g, '');
    if (!v) return '';
    const firstDot = v.indexOf('.');
    let intPart = firstDot === -1 ? v : v.slice(0, firstDot);
    let decPart = firstDot === -1 ? '' : v.slice(firstDot + 1).replace(/\./g, '').slice(0, 2);
    intPart = intPart.replace(/^0+(?=\d)/, '') || '0';   // trim leading zeros, keep one digit
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return decPart !== '' ? `$${grouped}.${decPart}` : `$${grouped}`;
}

function toggleRecycleInventory() {
    closeAllModals();
    const modal = document.getElementById('recycleInvModal');
    if (!modal) return;
    // Reset to a blank page 1 every time.
    ['recycleInvSku', 'recycleInvDescription', 'recycleInvValue', 'recycleInvCost'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const isCorpRole = role === 'ceo' || role === 'district manager';
    const selectorEl = document.getElementById('recycleInvStoreSelector');
    if (selectorEl) {
        selectorEl.style.display = isCorpRole ? '' : 'none';
        const sel = document.getElementById('recycleInvStoreSelect');
        if (sel) sel.value = '';
    }
    document.getElementById('recycleInvPage1').style.display   = '';
    document.getElementById('recycleInvFooter1').style.display = '';
    document.getElementById('recycleInvPage2').style.display   = 'none';
    document.getElementById('recycleInvFooter2').style.display = 'none';
    modal.classList.add('show');
    lockAndBlurScreen();
}

// Validate page 1: every field is required; corp roles must also pick a store.
function _recycleInvEnsureValid() {
    const role = (sessionStorage.getItem('speeksUserRole') || '').toLowerCase().trim();
    const isCorpRole = role === 'ceo' || role === 'district manager';
    const sel = document.getElementById('recycleInvStoreSelect');
    if (isCorpRole && (!sel || !sel.value)) {
        alert('Please select a store first.');
        return false;
    }
    const sku  = document.getElementById('recycleInvSku')?.value.trim();
    const desc = document.getElementById('recycleInvDescription')?.value.trim();
    const val  = document.getElementById('recycleInvValue')?.value.trim();
    const cost = document.getElementById('recycleInvCost')?.value.trim();
    if (!sku || !desc || !val || !cost) {
        alert('Please fill in the SKU, description, value, and cost before continuing.');
        return false;
    }
    return true;
}

function recycleInvNextPage() {
    if (!_recycleInvEnsureValid()) return;
    recycleInvUpdatePreview();
    document.getElementById('recycleInvPage1').style.display   = 'none';
    document.getElementById('recycleInvFooter1').style.display = 'none';
    document.getElementById('recycleInvPage2').style.display   = '';
    document.getElementById('recycleInvFooter2').style.display = '';
}

function recycleInvBackPage() {
    document.getElementById('recycleInvPage2').style.display   = 'none';
    document.getElementById('recycleInvFooter2').style.display = 'none';
    document.getElementById('recycleInvPage1').style.display   = '';
    document.getElementById('recycleInvFooter1').style.display = '';
}

// Build the request as plain text (real newlines) — shared by the email and the
// copy failsafe so both always say exactly the same thing.
function _recycleInvCompose() {
    const store    = _recycleInvGetStore();
    const userName = sessionStorage.getItem('speeksUserName') || '';
    const sku  = document.getElementById('recycleInvSku')?.value.trim()         || '';
    const desc = document.getElementById('recycleInvDescription')?.value.trim() || '';
    const val  = _recycleInvFormatMoney(document.getElementById('recycleInvValue')?.value);
    const cost = _recycleInvFormatMoney(document.getElementById('recycleInvCost')?.value);
    const body =
        `Hi,\n\nThe following item needs to be recycled out of inventory for ${store}:\n\n` +
        `SKU: ${sku}\n` +
        `Description: ${desc}\n` +
        `Value: ${val}\n` +
        `Cost: ${cost}\n\n` +
        `Thank you,\n${userName}`;
    return { email: RECYCLE_INV_EMAIL, subject: `${sku} - Recycle`, body };
}

function recycleInvUpdatePreview() {
    const preview = document.getElementById('recycleInvEmailPreview');
    if (!preview) return;
    const { email, subject, body } = _recycleInvCompose();
    preview.textContent = `To: ${email}\nSubject: ${subject}\n\n${body}`;
}

function sendRecycleInventory() {
    if (!_recycleInvEnsureValid()) return;
    const { email, subject, body } = _recycleInvCompose();
    window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Failsafe for machines with no default mail client: copy the full request
// (recipient, subject, body) to the clipboard to paste into any email.
function copyRecycleInventory(button) {
    if (!_recycleInvEnsureValid()) return;
    const { email, subject, body } = _recycleInvCompose();
    const text = `To: ${email}\nSubject: ${subject}\n\n${body}`;
    navigator.clipboard.writeText(text).then(() => {
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
        }, 2000);
    }).catch(() => alert('Could not copy automatically. Please select and copy the request manually.'));
}
