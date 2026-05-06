/* =========================================================
   SPEEKSNET | UNIVERSAL APP JAVASCRIPT
   ========================================================= */

// --- 1. API URLS ---
const CMS_URL = 'https://script.google.com/macros/s/AKfycbxZviJiiQKcQYyp3SK4tcNBHrHXkID7cmwwuONStVPE9DHCSAMappqAs9dBns7ufECI/exec';
const HOTKEYS_URL = 'https://script.google.com/macros/s/AKfycbyLburcVWM8xAKwDt2RHAQhZBLb_rJjb2__EzhoAKx1KgkNFi-BchVetgaTKvwCwqZiRw/exec';
const DOCS_URL = 'https://script.google.com/macros/s/AKfycbyRLeIuWH3v2lMeFmoWcCohDz_YB-AFOnG_QgPckjiYnjni1dUKm0jRqaXeJGAViSYkQg/exec';
const MONTHLY_KPI_URL = 'https://script.google.com/macros/s/AKfycby0ihq9A4yUQvdZdeAF9euC5jih24hP2XGG-J_balNtxop2RHBuIuigw_mH3XTeCkkhow/exec';
const VARIANCE_API_URL = 'https://script.google.com/macros/s/AKfycbxFO_W-PW4ZT4e5mXlQOhlYl2ccpZ9by8MZ6rF-RJ6x3lryCjbi5XxY7c57vLgfx7k/exec';
const HUB_URL = 'https://script.google.com/macros/s/AKfycbw3Ms5nc2bhbrjVW-da3xbZ3vKhyBx2TpeR-eSd1L05ZhV-h2Yh0yLmIV_E7TWDmwM69A/exec';
const WEEKLY_KPI_URL = 'https://script.google.com/macros/s/AKfycbyVBos-uJuhaqfLMBqoz9byNkvUG06igl4RX2_cs8hH15rbp7K4uFFEN-wpQgS2ChAU/exec';
const AUTH_URL = 'https://script.google.com/macros/s/AKfycbza40UZxFtBWwtm3Z52MqAaBtxRfilN7flkMIuE-ylco-VFli38_nK9avh4gDioHNZjKg/exec';
const RECORDS_URL = 'https://script.google.com/macros/s/AKfycbwPMcs33YfH84ewJyg3ikqIKZtOJByEI9X2PD3cONtavJk7oJCUnGYbP6sESBE6-j2RSA/exec';
const QUICK_MSG_URL = 'https://script.google.com/macros/s/AKfycbxpPxDhcyS5gJ90plzsW_I1zkiC9bCZ6WA3Pl22XJL3NLg6K8L5QfeYX6VNN5bECstIeg/exec';
const GOALS_API_URL = 'https://script.google.com/macros/s/AKfycbw_eV-2Nxizf85J8atBJ6Muyq0aOAjZAsSLwlx9abPjNKJub_RlzrMBKkQuTbcRTbF2/exec';
const SCORECARD_URL = 'https://script.google.com/macros/s/AKfycbwvelWpXnlXCJZQGagZX5llMCN1k6CjronBpIcenNVDTjUdPISjF0mYhHYy2ry0Vdg0_Q/exec';
const EBAY_ALERTS_URL = 'https://script.google.com/macros/s/AKfycbxap-4Jgdn5-ntkv_X-vFZLTWlTB29_bDLdwcFxhWd2su3ZQJ0ZS7UpUgZAK08lOIV6/exec';
const STORE_COMMENT_URL = 'https://script.google.com/macros/s/AKfycbzoqWLZz07niO-dVqDpQS7I-bDvUgLjHT4CYGiqb--yAQYQPkFCUi9EXoi5Wsz-V0Ne/exec';
const CHECKLIST_URL = 'https://script.google.com/macros/s/AKfycbxr4ZEoSKeF4BZ1H2-tcmc6Gy30-le5Gdm3CSdee6XxOhZFes3-5SF_PNcWR4OLEGN2hQ/exec';
const TUTORIAL_URL = 'https://script.google.com/macros/s/AKfycbySrXu6IW3S39GKiEsXkJwd4s75aO0uG-BTTg_swxEx3BMG_W7qqZBwHKnuEm_k_Agh/exec';

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

// --- 3. GLOBAL UI, MODALS & TABS ---
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
        
        if (badgeId === 'notifBadge') {
            const badge = document.getElementById(badgeId);
            const userName = sessionStorage.getItem('speeksUserName'); 
            
            if (badge && badge.classList.contains('active') && userName) {
                badge.classList.remove('active');
                badge.style.display = 'none';
                
                localStorage.removeItem('speeksUnreadAnnouncements_' + userName);
                
                const unreadEls = document.querySelectorAll('.notif-item[data-unread-id]');
                const unreadIds = Array.from(unreadEls).map(el => parseInt(el.getAttribute('data-unread-id')));
                
                if (unreadIds.length > 0) {
                    setTimeout(() => {
                        fetch(CMS_URL, {
                            method: 'POST', mode: 'no-cors',
                            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                            body: JSON.stringify({ type: 'mark_read', user: userName, rowIds: unreadIds })
                        }).catch(() => {});
                    }, 2500);
                    
                    unreadEls.forEach(el => el.removeAttribute('data-unread-id'));
                }
            }
        }
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

            if (data.announcements && data.announcements.length > 0) {
                const sortedAnns = [...data.announcements].reverse();
                const now = new Date();

                sortedAnns.forEach((item, index) => {
                    let displayDate = "";
                    let isArchived = false;
                    let unreadHtmlAttr = "";

                    if (item.date) {
                        const annDate = new Date(item.date);
                        if (!isNaN(annDate.getTime())) {
                            displayDate = annDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
                            const diffHours = (now - annDate) / (1000 * 60 * 60);

                            if (diffHours > 48) {
                                isArchived = true;
                            } else {
                                if (cleanUser) {
                                    const isUnread = !item.readBy || !item.readBy.some(u => String(u).trim().toLowerCase() === cleanUser);
                                    if (isUnread) {
                                        showBadge = true;
                                        unreadHtmlAttr = `data-unread-id="${item.rowId}"`; 
                                    }
                                }
                            }
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
                        let disabledAttr = isArchived ? 'disabled style="cursor: default;"' : `onclick="toggleReaction('${annId}', '${emoji}')"`;
                        let tooltipText = usersList.length > 0 ? `title="Reacted by: ${usersList.join(', ')}"` : '';
                        
                        reactionsHtml += `<button class="reaction-btn ${activeClass}" id="btn_${annId}_${eIdx}" data-emoji="${emoji}" style="display: ${displayStyle};" ${disabledAttr} ${tooltipText}><span style="pointer-events: none;">${emoji}</span> <span class="count" style="pointer-events: none;">${count}</span></button>`;
                    });

                    if (!isArchived) {
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
                    }
                    reactionsHtml += `</div>`;

                    const html = `
                        <div class="notif-item" ${unreadHtmlAttr}>
                            <div class="ann-header">
                                <span class="ann-author">${item.author || 'Announcement'}</span>
                                ${displayDate ? `<small class="ann-date">${displayDate}</small>` : ''}
                            </div>
                            <hr />
                            <div class="ann-text">${item.text || ''}</div>
                            ${reactionsHtml}
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
            } else {
                recentHtml = archiveHtml = '<div style="padding: 20px; color:#999; text-align:center;">No announcements</div>';
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
                    badge.style.display = 'none';
                    badge.classList.remove('active');
                }
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
    }
}

function toggleNotifs() { toggleModal('notifDropdown', 'notifBadge'); }
function toggleCalendar() { toggleModal('calendarDropdown'); }
function toggleIdeaModal() { toggleModal('ideaModal'); }

function switchAnnTab(tab) {
    const isRecent = tab === 'recent';
    
    const annC = document.getElementById('ann-container');
    if (annC) {
        annC.style.display = isRecent ? 'block' : 'none';
        annC.classList.remove('hidden'); // Fixes the !important CSS override
    }
    
    const archC = document.getElementById('archive-container');
    if (archC) {
        archC.style.display = isRecent ? 'none' : 'block';
        archC.classList.remove('hidden'); // Fixes the !important CSS override
    }
    
    document.getElementById('tab-recent').classList.toggle('active', isRecent);
    document.getElementById('tab-archive').classList.toggle('active', !isRecent);
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
    const roles = ['CEO', 'District Manager', 'Manager', 'Employee', 'Training', 'TOM'];

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
        "Buying Metrics": [], 
        "Inventory": [], 
        "Gross Sales": [], 
        "Net Sales & Margins": [], 
        "Sales Channels": [], 
        "Shipping Costs": [], 
        "eBay Performance": [], 
        "Rankings & Reviews": [], 
        "Recycled & Confiscated": [], 
        "Other Metrics": [] 
    };
    
    const ignore = ['ebay rank', 'top rated', 'cases closed'];
    let all = [];
    
    if (Array.isArray(data)) {
        data.forEach(item => {
            if (item.metrics) {
                all.push(...item.metrics);
            } else if (item.name) {
                all.push(item);
            }
        });
    }
    
    all.forEach(m => {
        if (!m?.name) return;
        let n = m.name.toLowerCase().replace(/\s+/g, ' ').trim();
        if (ignore.some(iw => n.includes(iw))) return; 
        
        if (n.match(/buying|buy vs|close rate|# of customers|buy value|# of items|returning|avg trans/)) cats["Buying Metrics"].push(m);
        else if (n.match(/inventory cost|% of inventory over/)) cats["Inventory"].push(m);
        else if (n.match(/gross sales|discount|refund|return/)) cats["Gross Sales"].push(m);
        else if (n.match(/net sales|cogs|gross profit/)) cats["Net Sales & Margins"].push(m);
        else if (n.match(/draft order|pos|online|non ebay/)) cats["Sales Channels"].push(m);
        else if (n.includes("shipping")) cats["Shipping Costs"].push(m);
        else if (n.match(/defect rate|late shipment|case with no resolution|case w\/no resolution|tracking uploaded/)) cats["eBay Performance"].push(m);
        else if (n.match(/paymore|google/)) cats["Rankings & Reviews"].push(m);
        else if (n.match(/recycled|confiscation/)) cats["Recycled & Confiscated"].push(m);
        else cats["Other Metrics"].push(m);
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

    // Use cached data if available for instant loading
    if (monthlyKpiCache[store]) {
        dynamicMonths = monthlyKpiCache[store].months; 
        rawKPIData = monthlyKpiCache[store].data;
        setDD(document.getElementById('primaryMonthSelect'), document.getElementById('compareMonthSelect'), dynamicMonths);
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
        renderKPIDashboard();
    } catch (e) { 
        console.error("Monthly KPI fetch failed:", e); 
    }
}

function renderKPIDashboard() {
    const store = document.getElementById('kpiStoreSelect').value;
    const pIdx = document.getElementById('primaryMonthSelect').value;
    const cIdx = document.getElementById('compareMonthSelect').value;
    const cont = document.getElementById('kpiDashboardContainer');
    
    document.getElementById('header-primary-label').innerText = dynamicMonths[pIdx]; 
    document.getElementById('header-compare-label').innerText = dynamicMonths[cIdx];
    
    const vId = `kpi-view-${store}-${pIdx}-${cIdx}`;
    
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

// --- 10. MODULE: LIVE VARIANCE REPORTS ---
function formatVariancePct(num) { 
    return Math.abs(num) < 0.001 ? '0.00%' : `${num < 0 ? '-' : '+'}${Math.abs(num).toFixed(2)}%`; 
}

function createVarianceStoreCard(sKey) {
    if (sKey === "NONE" || !liveVarianceDataCache[sKey]?.employees) return '';
    
    const d = liveVarianceDataCache[sKey];
    const isNew = d.fileDate && (Date.now() - d.fileDate) < 604800000;
    
    const totalColorClass = d.total < 0 ? 'delta-neg' : (d.total > 0 ? 'delta-pos' : 'delta-neutral');
    const badgeHtml = isNew ? `<div class="notif-dot active" style="display:block; position:relative; margin-left: 10px; width: 10px; height: 10px; border-width: 2px;" title="New Report Added This Week"></div>` : '';

    let html = `
    <div style="border: 1px solid #eee; border-radius: 12px; background: white; overflow: hidden;">
        <div style="background: #f9fafb; padding: 15px 20px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: flex-start;">
            <div style="display: flex; flex-direction: column; gap: 8px;">
                <div style="display: flex; align-items: center;">
                    <span style="font-size: 16px; font-weight: 900; color: var(--slate-charcoal); text-transform: uppercase;">${sKey} TOTAL</span>
                    ${badgeHtml}
                </div>
            </div>
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
        
        if (d.fileName) {
            pTxt = d.fileName
                .replace(new RegExp(`${p}\\s*`, 'i'), '')
                .trim()
                .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/ig, m => {
                    const fullMonths = {"Jan":"January","Feb":"February","Mar":"March","Apr":"April","May":"May","Jun":"June","Jul":"July","Aug":"August","Sep":"September","Oct":"October","Nov":"November","Dec":"December"};
                    return fullMonths[m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()] || m;
                });
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
    const cont = document.getElementById('weeklyKpiContainer');
    const store = document.getElementById('weeklyKpiStoreSelect')?.value;
    const pB = document.getElementById('weeklyKpiPeriod');
    
    if(!cont || !store) return;
    
    // Clean up the parent container to prevent grid-in-grid conflicts
    cont.style.display = 'block'; 
    cont.classList.remove('weekly-kpi-grid');
    
    const vId = `weekly-view-${store}`; 
    Array.from(cont.children).forEach(c => c.style.display = 'none');
    
    if (document.getElementById(vId)) {
        document.getElementById(vId).style.display = 'grid'; 
        if (weeklyKpiCache[store]?.periodText) { 
            pB.innerText = weeklyKpiCache[store].periodText; 
            pB.style.display = "inline-block"; 
        } else {
            pB.style.display = "none";
        }
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
        const response = await fetch(`${WEEKLY_KPI_URL}?store=${store}&time=4-Week&v=${Date.now()}`);
        const d = await response.json();
        
        let sAvg = {};
        let emps = [];
        let fIdx = -1;
        const _kpiStoreLabels = ["store", "store total", "ovl", "lee", "wsp", "mpl", "bal"];
        let sIdx = d.findLastIndex(r => String(r[0]).trim().toLowerCase() === "store" || String(r[0]).trim().toLowerCase() === "store total");

        if (sIdx !== -1) {
            let st = d[sIdx];
            sAvg = { buyVal: st[2], buyMargin: st[5], customers: st[6], conversion: st[8], time: formatTime(st[12]), noDeals: st[14], listed: st[20] };

            for (let i = Math.max(0, sIdx - 6); i <= Math.min(d.length - 1, sIdx + 6); i++) {
                if (i === sIdx) continue;
                let n = String(d[i][0]).trim();
                let lN = n.toLowerCase();

                if (n && !_kpiStoreLabels.includes(lN) && !lN.includes("average") && !lN.includes("week")) {
                    if (String(d[i][2]).trim() !== "" || String(d[i][20]).trim() !== "") {
                        if (fIdx === -1) fIdx = i; 
                        emps.push({ name: n, buyVal: d[i][2], buyMargin: d[i][5], customers: d[i][6], conversion: d[i][8], time: formatTime(d[i][12]), noDeals: d[i][14], listed: d[i][20] });
                    }
                }
            }
        }

        let pTxt = "";
        if (fIdx !== -1) {
            let hR = d[fIdx - 3] || d[fIdx - 2];
            if (hR && hR[2] && hR[4] && hR[6]) {
                const getOrdinal = (n) => {
                    let val = parseInt(String(n).replace(/\D/g, ''));
                    if (isNaN(val)) return n;
                    let s = ["th", "st", "nd", "rd"], v = val % 100;
                    return val + (s[(v - 20) % 10] || s[v] || s[0]);
                };
                
                const monthNames = {"Jan":"January","Feb":"February","Mar":"March","Apr":"April","May":"May","Jun":"June","Jul":"July","Aug":"August","Sep":"September","Oct":"October","Nov":"November","Dec":"December"};
                let monthName = String(hR[2]).replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/ig, m => monthNames[m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()] || m);
                
                let startDay = getOrdinal(hR[4]);
                let endDay = getOrdinal(hR[6]);
                
                pTxt = `${monthName} ${startDay} - ${endDay}`;
            }
        }
        
        weeklyKpiCache[store] = { periodText: pTxt }; 
        pB.innerText = pTxt; 
        pB.style.display = pTxt ? "inline-block" : "none";

        if (!emps.length) { 
            msg.innerText = 'No employee data.'; 
            msg.style.color = '#dc2626'; 
            return; 
        }

        msg.style.display = 'none'; 
        const nV = document.createElement('div'); 
        nV.id = vId; 
        
        // BULLETPROOF GRID OVERRIDE
        nV.className = 'weekly-kpi-grid';
        nV.style.display = 'grid';
        nV.style.gap = '20px';
        nV.style.alignItems = 'start';
        
        // This ensures the columns auto-stack if you look at it on a phone vs a desktop!
        const applyGridColumns = () => {
            if (window.innerWidth > 1100) nV.style.gridTemplateColumns = 'repeat(5, 1fr)';
            else if (window.innerWidth > 768) nV.style.gridTemplateColumns = 'repeat(2, 1fr)';
            else nV.style.gridTemplateColumns = '1fr';
        };
        applyGridColumns();
        window.addEventListener('resize', applyGridColumns);

        // HTML Column Builder Helper
        const buildColHtml = (title, storeVal, storeBadgeVal, empKey, empBadgeKey, ruleName, isPercentBadge) => {
            let html = `
            <div style="border: 1px solid #eee; border-radius: 12px; background: white; overflow: hidden; display: flex; flex-direction: column;">
                <div style="background: #f9fafb; padding: 15px; border-bottom: 1px solid #eee; text-align: center;">
                    <h4 style="font-size: 12px; font-weight: 800; color: var(--slate-charcoal); text-transform: uppercase; margin-bottom: 10px; letter-spacing: 0.5px; white-space: nowrap;">${title}</h4>
                    <div style="display: grid; grid-template-columns: 1fr 75px 55px; align-items: center; background: white; padding: 0 12px; height: 40px; border-radius: 8px; border: 1px solid #eee; gap: 8px;">
                        <span style="font-size: 11px; font-weight: 800; color: #888; text-align: left;">STORE TOTAL</span>
                        <span style="font-size: 13px; font-weight: 800; text-align: right; white-space: nowrap; ${checkRule(ruleName, storeVal) ? 'color: var(--red-alert);' : 'color: var(--slate-charcoal);'}">${storeVal || ''}</span>`;
                        
            if (empBadgeKey && storeBadgeVal) {
                html += `<span style="display: flex; justify-content: flex-end;"><span class="delta-badge ${checkRule(ruleName, storeBadgeVal) ? 'delta-neg' : 'delta-neutral'}">${storeBadgeVal}${isPercentBadge && !String(storeBadgeVal).includes('%') ? '%' : ''}</span></span>`;
            } else {
                html += `<span></span>`;
            }
            
            html += `</div></div><div style="display: flex; flex-direction: column;">`;
            
            emps.forEach(e => {
                html += `
                <div class="kpi-row" style="display: grid; grid-template-columns: 1fr 75px 55px; align-items: center; padding: 0 15px; height: 48px; border-top: 1px solid #f5f5f5; border-radius: 0; background: white; margin: 0; border-left: none; border-right: none; gap: 8px;">
                    <span class="kpi-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${e.name}</span>
                    <span style="text-align: right; font-size: 12px; font-weight: ${checkRule(ruleName, e[empKey]) ? '900' : '700'}; color: ${checkRule(ruleName, e[empKey]) ? 'var(--red-alert)' : '#555'}; white-space: nowrap;">${e[empKey] || ''}</span>`;
                    
                if (empBadgeKey && e[empBadgeKey]) {
                    html += `<span style="display: flex; justify-content: flex-end;"><span class="delta-badge ${checkRule(ruleName, e[empBadgeKey]) ? 'delta-neg' : 'delta-neutral'}">${e[empBadgeKey]}${isPercentBadge && !String(e[empBadgeKey]).includes('%') ? '%' : ''}</span></span>`;
                } else {
                    html += `<span></span>`;
                }
                html += `</div>`;
            });
            
            html += `</div></div>`;
            return html;
        };
        
        // Assemble the 5 Columns perfectly!
        nV.innerHTML = 
            buildColHtml('Buying Performance', sAvg.buyVal, sAvg.buyMargin, 'buyVal', 'buyMargin', 'margin', true) + 
            buildColHtml('Customer Conversion', sAvg.customers, sAvg.conversion, 'customers', 'conversion', 'conversion', true) + 
            buildColHtml('No Deals', '', sAvg.noDeals, '', 'noDeals', 'nodeals', false) + 
            buildColHtml('Avg Trans. Time', '', sAvg.time, '', 'time', 'time', false) + 
            buildColHtml('Processed / Listed', sAvg.listed, '', 'listed', '', null, false);
            
        cont.appendChild(nV);
        
    } catch (e) { 
        msg.innerText = 'Failed to load Weekly KPI.'; 
        msg.style.color = '#dc2626'; 
    }
}

// --- 12. MODULE: HUB DATA & LIVE DASHBOARDS ---

async function fetchHubData() {
    try {
        const response = await fetch(`${HUB_URL}?v=${Date.now()}`);
        const freshData = await response.json();

        // Track per-store last-updated timestamps based on actual data changes
        const _bsStores = ['ovl', 'lee', 'wsp', 'mpl', 'bal'];
        const _bsFields = s => [`${s}BuyVal`,`${s}BuyProj`,`${s}BuyMargin`,`${s}Pct`,`${s}Goal`,`${s}TrackGP`,`${s}GP`,`${s}Rev`,`${s}SellMargin`];
        const _bsPrev = JSON.parse(localStorage.getItem('bsPrevHubCache') || '{}');
        const _bsTs = JSON.parse(localStorage.getItem('bsStoreTimestamps') || '{}');
        _bsStores.forEach(s => { if (_bsTs[s]) _bsTs[s] = _bsTs[s].replace(/\s+\d{1,2}:\d{2}\s*(AM|PM)/i, ''); });
        const _bsNow = new Date();
        const _bsLabel = _bsNow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        _bsStores.forEach(s => {
            if (_bsFields(s).some(f => freshData[f] !== _bsPrev[f])) _bsTs[s] = _bsLabel;
        });
        localStorage.setItem('bsStoreTimestamps', JSON.stringify(_bsTs));
        localStorage.setItem('bsPrevHubCache', JSON.stringify(freshData));

        hubDataCache = freshData;

        if (document.getElementById('bs-buy-val')) renderBuyingSales();
        
        // Render Live Data globally (Fixes CEO Rings)
        renderLiveData(hubDataCache);
        
        // Let the Hub power the Leaderboard automatically!
        if (document.getElementById('lb-wrapper')) {
            if (hubDataCache.leaderboard) {
                cachedLeaderboardData = hubDataCache.leaderboard;
                drawLeaderboard();
            } else {
                document.getElementById('lb-wrapper').innerHTML = '<div class="status-message" style="color:var(--red-alert);">Please Deploy "New Version" of Hub App Script!</div>';
            }
        }
    } catch(e) {
        console.error("Hub Sync Failed", e);
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

    const bsDateEl = document.getElementById('bs-last-updated');
    if (bsDateEl) {
        const _bsTs = JSON.parse(localStorage.getItem('bsStoreTimestamps') || '{}');
        bsDateEl.innerText = _bsTs[store] || '—';
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
let kpiChartCache = JSON.parse(localStorage.getItem('speeksKpiChartCache')) || { '4-Week': null, 'Monthly': null };

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
    
    const m = mSelect.value;
    const loader = document.getElementById('chartLoading');
    
    if (loader) {
        loader.style.display = 'flex';
        loader.innerHTML = '<div class="status-message">Syncing Live Data...</div>';
    }
    
    // Always fetch fresh data from the server, bypassing the stale local cache
    fetchChartData(currentTimeframe); 
}

async function fetchChartData(tf) {
    const loader = document.getElementById('chartLoading');
    if (loader) {
        loader.style.display = 'flex';
        loader.innerHTML = '<div class="status-message">Syncing Data...</div>';
    }
    
    try {
        const d = await Promise.all([
            fetch(`${WEEKLY_KPI_URL}?store=OVL&time=${tf}`).then(r => r.json()), 
            fetch(`${WEEKLY_KPI_URL}?store=LEE&time=${tf}`).then(r => r.json()), 
            fetch(`${WEEKLY_KPI_URL}?store=WSP&time=${tf}`).then(r => r.json()),
            fetch(`${WEEKLY_KPI_URL}?store=MPL&time=${tf}`).then(r => r.json()),
            fetch(`${WEEKLY_KPI_URL}?store=BAL&time=${tf}`).then(r => r.json())
        ]);
        
        kpiChartCache[tf] = d; 
        try { localStorage.setItem('speeksKpiChartCache', JSON.stringify(kpiChartCache)); } catch(e) {}
        
        if (currentTimeframe === tf) {
            const mSelect = document.getElementById('metricSelector');
            if (mSelect) renderKpiChart(d, mSelect.value);
        }
    } catch (e) {
        console.error("fetchChartData error:", e);
        if (loader) loader.innerHTML = '<div class="status-message" style="color:var(--red-alert);">Failed to load chart data.</div>';
    } 
}

function syncAllData() { 
    try {
        const mSelect = document.getElementById('metricSelector');
        if (typeof kpiChartCache !== 'undefined' && kpiChartCache && kpiChartCache[currentTimeframe] && mSelect) {
            renderKpiChart(kpiChartCache[currentTimeframe], mSelect.value); 
        }
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

// --- 15. MODULE: QUICK MESSAGES ---
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
    
    // Remove the comment tracker for today so it pops up again when testing
    const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    sessionStorage.removeItem(`speeksCommentSeen_${todayStr}`);
    
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
        const rawDate = storeData.date || 'Recent';

        let displayDate = rawDate;
        const parsedDate = new Date(rawDate);
        if (!isNaN(parsedDate.getTime())) {
            const day = parsedDate.getUTCDay(); 
            const diffToMonday = day === 0 ? -6 : 1 - day; 
            const mondayDate = new Date(parsedDate);
            mondayDate.setUTCDate(parsedDate.getUTCDate() + diffToMonday);
            displayDate = "Week of " + mondayDate.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
        }

        const isTenPointScale = latestScore > 5;
        let scoreColor = 'var(--red-alert)';
        if (isTenPointScale) {
            if (latestScore > 8) scoreColor = 'var(--sage-professional)';  
            else if (latestScore >= 6) scoreColor = 'var(--idea-gold)';
        } else {
            if (latestScore >= 4) scoreColor = 'var(--sage-professional)';
            else if (latestScore >= 3) scoreColor = 'var(--idea-gold)';
        }

        const pulse = (isTenPointScale ? latestScore < 6 : latestScore < 3) 
            ? `<div class="notif-dot active" style="display:block; position:absolute; top:-2px; right:-14px; width:12px; height:12px;"></div>` 
            : '';

        let breakdownHtml = '';
        if (storeData.breakdown && storeData.breakdown.length > 0) {
            breakdownHtml = `<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; max-height: 280px; overflow-y: auto; padding-right: 4px; margin-top: 15px; border-top: 1px solid #f0f0f0; padding-top: 15px;" class="kpi-scroll-area">`;
            
            storeData.breakdown.forEach(cat => {
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
                
                breakdownHtml += `
                <div style="display: flex; justify-content: space-between; align-items: center; background: #fff; border: 1px solid #e2e8f0; padding: 8px; border-radius: 8px; gap: 6px;">
                    <span style="font-size: 9px; font-weight: 800; color: var(--slate-charcoal); text-transform: uppercase; line-height: 1.3;">${cat.name}</span>
                    <span style="font-size: 11px; font-weight: 900; background: ${bg}; color: ${color}; padding: 2px 6px; border-radius: 6px; flex-shrink: 0;">${displayVal}</span>
                </div>`;
            });
            breakdownHtml += `</div>`;
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
                        ${latestScore.toFixed(1)}
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
            if (!val || String(val).trim() === '') return '';
            let str = String(val).trim();
            if (str.endsWith('%')) return str;
            let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
            if (isNaN(num)) return str; 
            return (num * 100).toFixed(2) + '%';
        };

        // NEW: Dynamic Severity Calculator for eBay Top Rated Thresholds
        const getSeverity = (type, rawVal) => {
            if (!rawVal || String(rawVal).trim() === '') return 'clear';
            let str = String(rawVal).trim();
            
            let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
            if (isNaN(num)) return 'clear';

            // Convert raw sheet decimal to percentage for accurate logic comparison
            let valToCheck = str.endsWith('%') ? num : num * 100;

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
            
            if (rawValue !== '') {
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
                districtKpiCache.stores[res.store] = { months: res.data.months || [], data: res.data.data };
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

            // 1. SCORECARD & HEADER
            const sScore = scoreData.data?.find(s => s.store.toUpperCase() === store) || {};
            const scoreNum = parseFloat(sScore.score) || 0;
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
                if (!val || String(val).trim() === '') return '';
                let str = String(val).trim();
                if (str.endsWith('%')) return str;
                let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
                if (isNaN(num)) return str; 
                return (num * 100).toFixed(2) + '%';
            };

            const getSev = (type, rawVal) => {
                if (!rawVal || String(rawVal).trim() === '') return 'clear';
                let str = String(rawVal).trim();
                let num = parseFloat(str.replace(/[^0-9.-]/g, ''));
                if (isNaN(num)) return 'clear';
                let valToCheck = str.endsWith('%') ? num : num * 100;

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
                        <div class="master-section-title">Buying & Selling Snapshot</div>
                        <div class="master-stat-box">
                            <div class="master-stat-row"><span class="master-stat-label">Sales vs Goal</span><span class="master-stat-val" style="color: ${pctColor}; background: ${pctBg};">${salesPct}%</span></div>
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
            const d = await fetch(`${WEEKLY_KPI_URL}?store=${store}&time=4-Week&v=${Date.now()}`).then(r => r.json());
            let sAvg = {};
            let sIdx = d.findLastIndex(r => String(r[0]).trim().toLowerCase() === "store" || String(r[0]).trim().toLowerCase() === "store total");
            if (sIdx !== -1) {
                let st = d[sIdx];
                sAvg = { buyMargin: st[5], conversion: st[8], time: formatTime(st[12]), noDeals: st[14], listed: st[20] };
            }
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
                .filter(u => u.store === goalsTargetStore && !_excluded.includes((u.role || '').toLowerCase()))
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
                empGoal += rG;
                empResult += rR;
                
                const dayIdx = (recDate.getDay() + 6) % 7; 
                dailyStats[daysOfWeek[dayIdx]] = { goal: rG, result: rR };
            }
        });

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

        storeData.forEach(r => {
            const recDate = new Date(r.date);
            const isToday = r.date === todayStr;
            const isThisWeek = recDate >= startOfWeek;

            if ((currentDmGoalView === 'daily' && isToday) || (currentDmGoalView === 'weekly' && isThisWeek)) {
                tGoal += parseInt(r.goal) || 0;
                tResult += parseInt(r.result) || 0;
                activeEmps.add(r.employee);
            }
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

            empRecords.forEach(r => {
                const recDate = new Date(r.date);
                if ((currentDmGoalView === 'daily' && r.date === todayStr) || (currentDmGoalView === 'weekly' && recDate >= startOfWeek)) {
                    const rG = parseInt(r.goal) || 0;
                    const rR = parseInt(r.result) || 0;
                    eG += rG;
                    eR += rR;
                    
                    if (currentDmGoalView === 'weekly') {
                        const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                        const dayIdx = (recDate.getDay() + 6) % 7; 
                        dailyStats[daysOfWeek[dayIdx]] = { goal: rG, result: rR };
                    }
                }
            });

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
        const response = await fetch(`${WEEKLY_KPI_URL}?store=${store}&time=4-Week&v=${Date.now()}`);
        const d = await response.json();
        
        let sAvg = {};
        let myData = {};
        let sIdx = d.findLastIndex(r => String(r[0]).trim().toLowerCase() === "store" || String(r[0]).trim().toLowerCase() === "store total");
        
        if (sIdx !== -1) {
            let st = d[sIdx];
            sAvg = { buyVal: st[2], buyMargin: st[5], customers: st[6], conversion: st[8], time: formatTime(st[12]), noDeals: st[14], listed: st[20] };
            
            const sessionName = String(userName).trim().toLowerCase();
            const sessionFirstName = sessionName.split(' ')[0];

            for (let i = Math.max(0, sIdx - 6); i <= Math.min(d.length - 1, sIdx + 6); i++) {
                if (i === sIdx) continue;
                let n = String(d[i][0]).trim();
                let dbName = n.toLowerCase();
                
                if (n && !["name", "employee", "store", "store total", "ovl", "lee", "wsp", "mpl", "bal"].includes(dbName) && !dbName.includes("average") && !dbName.includes("week")) {
                    
                    let isMatch = false;
                    if (dbName === sessionName) {
                        isMatch = true;
                    } else {
                        const dbFirstName = dbName.split(' ')[0];
                        if (dbFirstName.length > 2 && sessionFirstName.length > 2) {
                            if (dbFirstName.startsWith(sessionFirstName) || sessionFirstName.startsWith(dbFirstName)) {
                                isMatch = true;
                            }
                        }
                    }

                    if (isMatch) {
                        myData = { buyVal: d[i][2], buyMargin: d[i][5], customers: d[i][6], conversion: d[i][8], time: formatTime(d[i][12]), noDeals: d[i][14], listed: d[i][20] };
                        break; 
                    }
                }
            }
        }

        let pTxt = "";
        if (sIdx !== -1) {
            let firstEmpIdx = -1;
            for (let i = Math.max(0, sIdx - 6); i <= Math.min(d.length - 1, sIdx + 6); i++) {
                let n = String(d[i][0]).trim(), lN = n.toLowerCase();
                if (n && !["name", "employee", "store", "store total", "ovl", "lee", "wsp", "mpl", "bal"].includes(lN) && !lN.includes("average") && !lN.includes("week")) {
                    if (String(d[i][2]).trim() !== "" || String(d[i][20]).trim() !== "") {
                        firstEmpIdx = i;
                        break; 
                    }
                }
            }

            if (firstEmpIdx !== -1) {
                let hR = d[firstEmpIdx - 3] || d[firstEmpIdx - 2];
                if (hR && hR[2] && hR[4] && hR[6]) {
                    const getOrdinal = (n) => {
                        let val = parseInt(String(n).replace(/\D/g, ''));
                        if (isNaN(val)) return n;
                        let s = ["th", "st", "nd", "rd"], v = val % 100;
                        return val + (s[(v - 20) % 10] || s[v] || s[0]);
                    };
                    
                    const monthNames = {"Jan":"January","Feb":"February","Mar":"March","Apr":"April","May":"May","Jun":"June","Jul":"July","Aug":"August","Sep":"September","Oct":"October","Nov":"November","Dec":"December"};
                    let monthName = String(hR[2]).replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/ig, m => monthNames[m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()] || m);
                    
                    let startDay = getOrdinal(hR[4]);
                    let endDay = getOrdinal(hR[6]);
                    
                    pTxt = `${monthName} ${startDay} - ${endDay}`;
                }
            }
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

    const userRoleClass = `role-${userRole.toLowerCase().replace(/\s+/g, '-')}`; 
    const userStoreClass = `store-${userStore.toLowerCase()}`;

    document.querySelectorAll('.dynamic-module-flex, .dynamic-module-block, .dynamic-module').forEach(module => {
        const classes = Array.from(module.classList);
        const requiredRoles = classes.filter(c => c.startsWith('role-'));
        const requiredStores = classes.filter(c => c.startsWith('store-'));

        const passesRole = requiredRoles.length === 0 || requiredRoles.includes(userRoleClass);
        const passesStore = requiredStores.length === 0 || requiredStores.includes(userStoreClass);

        if (passesRole && passesStore) {
            let displayType = module.classList.contains('dynamic-module-flex') ? 'flex' : 'block';
            module.style.setProperty('display', displayType, 'important');
        } else {
            module.style.setProperty('display', 'none', 'important');
        }
    });

    if (userRole === 'employee') {
        document.querySelectorAll('.manager-only').forEach(el => el.style.setProperty('display', 'none', 'important'));
    }

    if (userStore !== 'ALL') {
        ['kpiStoreSelect', 'weeklyKpiStoreSelect', 'bsStoreSelect', 'vw-primary', 'dmChartStoreSelector'].forEach(id => {
            const dropdown = document.getElementById(id);
            if (dropdown && Array.from(dropdown.options).some(opt => opt.value === userStore)) {
                dropdown.value = userStore;
            }
        });
    }
}

function checkInstantNotifCache() {
    const currentUser = sessionStorage.getItem('speeksUserName');
    if (!currentUser) return; // Don't fire if they aren't logged in yet
    
    if (localStorage.getItem('speeksUnreadAnnouncements_' + currentUser) === 'true') {
        const badge = document.getElementById('notifBadge');
        if (badge) {
            badge.style.display = 'block';
            badge.classList.add('active');
        }
    }
}

function initDashboardData() { 
    // 1. Instantly check memory for the red dot before any servers are contacted
    checkInstantNotifCache();

    const runInit = () => {
        if (typeof initChecklists === 'function') initChecklists(); 
        
        // Re-sync announcements immediately after login so it knows who you are!
        setTimeout(loadCMS, 50);
        setTimeout(startReactionPolling, 3000);

        setTimeout(fetchHubData, 100); 
        setTimeout(fetchVarianceData, 300); 
        setTimeout(fetchWeeklyKPIs, 500); 
        
        // --- ADD THESE MISSING DASHBOARD WIDGETS ---
        setTimeout(fetchScorecardData, 600);
        setTimeout(fetchAlertsData, 650);
        setTimeout(fetchMasterDistrictDashboard, 680);
        // -------------------------------------------

        setTimeout(fetchKPIData, 700); 
        setTimeout(fetchRecordsData, 800);
        setTimeout(fetchChampions, 850);
        setTimeout(fetchDmGoalsData, 1000);
        setTimeout(fetchAndRenderEmployeeGoals, 1100);
        setTimeout(fetchAndRenderEmployeeKPIs, 1200);
        
        // --- ADD THE COMMENT POPUP CHECK HERE TOO ---
        setTimeout(fetchAndDisplayStoreComment, 1500);
        // --------------------------------------------

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
    
    ['kpiStoreSelect', 'weeklyKpiStoreSelect', 'vw-primary', 'vw-compare'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            if (id === 'kpiStoreSelect') fetchKPIData(false);
            else if (id === 'weeklyKpiStoreSelect') fetchWeeklyKPIs();
            else renderVariance();
        });
    });
    
    if (document.getElementById('mainKpiChart') && typeof syncAllData === 'function') syncAllData();

    if (typeof fetchScorecardData === 'function') fetchScorecardData();
    if (typeof fetchAlertsData === 'function') fetchAlertsData();
    if (typeof fetchMasterDistrictDashboard === 'function') fetchMasterDistrictDashboard();
    if (typeof fetchDistrictMonthlyKPIs === 'function') fetchDistrictMonthlyKPIs();
});

// ============================================================================
// 23. CUSTOM TOOLTIP LOGIC
// ============================================================================
const customTooltip = document.createElement('div');
customTooltip.className = 'speeks-tooltip';
document.body.appendChild(customTooltip);

document.addEventListener('mouseover', function(e) {
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
    if (e.target.closest('.doc-card')) {
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
                    if (typeof fetchScorecardData === 'function') fetchScorecardData();
                    if (typeof fetchAlertsData === 'function') fetchAlertsData();
                    if (typeof fetchMasterDistrictDashboard === 'function') fetchMasterDistrictDashboard();
                    if (typeof fetchDistrictMonthlyKPIs === 'function') fetchDistrictMonthlyKPIs();
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
function renderKpiChart(allData, metric) {
    if(!document.getElementById('mainKpiChart')) return;

    if (typeof Chart === 'undefined') { 
        const loader = document.getElementById('chartLoading');
        if (loader) { 
            loader.innerHTML = '<div class="status-message" style="color:var(--red-alert);">Chart.js Library Missing!</div>'; 
            loader.style.display = 'flex'; 
        } 
        return; 
    }

    const t = { 'conversion': 'Customer Conversion %', 'margin': 'Buying Margin %', 'nodeals': 'Total No Deals', 'time': 'Transaction Time' }[metric];
    const unit = metric === 'time' ? '' : (metric === 'nodeals' ? '' : '%'); 
    const isPct = metric === 'conversion' || metric === 'margin';
    
    const strs = [ 
        { key: 'OVL', color: '#a855f7', label: 'OVL' }, 
        { key: 'LEE', color: '#3b82f6', label: 'LEE' }, 
        { key: 'WSP', color: '#22c55e', label: 'WSP' },
        { key: 'MPL', color: '#f97316', label: 'MPL' },
        { key: 'BAL', color: '#ef4444', label: 'BAL' } 
    ];
    
    let lbls = [], fData = [], nums = [];

    const parseChartVal = (v) => {
        if (v === undefined || v === null) return null;
        
        // Convert to string and lowercase to catch everything safely
        let strVal = String(v).trim().toLowerCase();
        
        // 1. Catch completely empty cells or Google Sheets errors
        if (strVal === "" || strVal === "-" || strVal === "#div/0!" || strVal === "#n/a" || strVal === "null") {
            return null;
        }

        // 2. Catch literal zeros. This forces closed stores/employees to be completely blank instead of flatlining at 0.
        if (strVal === "0" || strVal === "0%" || strVal === "0.00%" || strVal === "0.0%" || strVal === "0:00") {
            return null;
        }

        if (metric === 'time') {
            if (strVal.includes(':')) {
                let parts = strVal.split(':');
                return parseInt(parts[0] || 0) + (parseInt(parts[1] || 0) / 60);
            }
            if (strVal.includes('.')) {
                let parts = strVal.split('.');
                let mins = parseInt(parts[0] || 0);
                let secsStr = parts[1] || '0';
                if (secsStr.length === 1) secsStr += '0'; 
                let secs = parseInt(secsStr.substring(0,2)) || 0;
                return mins + (secs / 60);
            }
            
            let p = parseFloat(strVal.replace(/[^0-9.-]/g, ''));
            if (!isNaN(p)) {
                if (p > 30) return p / 60;
                return p;
            }
            return null;
        }
        
        let p = parseNum(v);
        if (p === 0) return null; // Final failsafe for any parsed zero
        
        return (isPct && p <= 1.5 && p >= -1.5) ? p * 100 : p;
    };

    const dmDropdown = document.getElementById('dmChartStoreSelector');
    if (dmDropdown) dmDropdown.style.display = currentChartMode === 'averages' ? 'none' : 'block';

    if (currentChartMode === 'averages') {
        allData.forEach((d, idx) => {
            if (!d || !Array.isArray(d)) return;
            let sData = [], sr=-1, sc=-1;
            
            for(let i=0; i<d.length; i++) { 
                if (!Array.isArray(d[i])) continue;
                for(let j=0; j<d[i].length; j++) if(d[i][j] && String(d[i][j]).trim() === t) { sr=i; sc=j; break; } 
                if(sr!==-1) break; 
            } 
            if(sr === -1 || !Array.isArray(d[sr+1])) return;
            
            let monthCol = Math.max(0, sc - 1);
            let sCol = -1;
            
            for(let c = sc; c < d[sr+1].length; c++) {
                let val = String(d[sr+1][c] || '').trim().toLowerCase();
                if (val === 'store' || val === 'store total') { sCol = c; break; }
            }
            if(sCol === -1) sCol = d[sr+1].length - 1; 
            
            if(!lbls.length) { 
                for (let i = sr + 2; i < d.length; i++) { 
                    if (!Array.isArray(d[i])) continue;
                    let l = String(d[i][monthCol] || '').trim(); 
                    if (!l || l.includes('Store') || l.includes('%')) break; 
                    lbls.push(l); 
                } 
            }
            
            lbls.forEach((_, i) => { 
                let row = d[sr+2+i];
                if (!Array.isArray(row)) {
                    sData.push(null);
                    return;
                }
                
                let v = (metric === 'time' && currentTimeframe === '4-Week') ? row[5] : row[sCol];
                let parsed = parseChartVal(v);

                sData.push(parsed);
                if (parsed !== null) nums.push(parsed);
            });
            
            // FIX: Only push to the chart if there is at least one valid data point
            if (idx < strs.length && sData.some(val => val !== null)) {
                fData.push({ label: '   ' + strs[idx].label + '   ', data: sData, borderColor: strs[idx].color, backgroundColor: strs[idx].color, tension: 0.4, pointRadius: 5, spanGaps: true });
            }
        });
    } else {
        let userStore = dmDropdown ? dmDropdown.value : (sessionStorage.getItem('speeksUserStore') || 'OVL');
        if (userStore === 'ALL' || userStore === 'CORP') userStore = 'OVL';
        let storeIdx = strs.findIndex(s => s.key === userStore);
        if (storeIdx === -1) storeIdx = 0;
        
        let d = allData[storeIdx];
        if (d && Array.isArray(d)) {
            let sr=-1, sc=-1;
            for(let i=0; i<d.length; i++) { 
                if (!Array.isArray(d[i])) continue;
                for(let j=0; j<d[i].length; j++) if(d[i][j] && String(d[i][j]).trim() === t) { sr=i; sc=j; break; } 
                if(sr!==-1) break; 
            }
            if(sr !== -1 && Array.isArray(d[sr+1])) {
                let monthCol = Math.max(0, sc - 1);
                let sCol = -1;
                
                for(let c = sc; c < d[sr+1].length; c++) {
                    let val = String(d[sr+1][c] || '').trim().toLowerCase();
                    if (val === 'store' || val === 'store total') { sCol = c; break; }
                }
                if (sCol === -1) sCol = d[sr+1].length - 1;

                if(!lbls.length) { 
                    for (let i = sr + 2; i < d.length; i++) { 
                        if (!Array.isArray(d[i])) continue;
                        let l = String(d[i][monthCol] || '').trim(); 
                        if (!l || l.includes('Store') || l.includes('%')) break; 
                        lbls.push(l); 
                    } 
                }

                let empCols = [];
                for(let c = sc; c < sCol; c++) {
                    let colName = String(d[sr+1][c] || '').trim();
                    if (!colName) continue; 
                    let lowerName = colName.toLowerCase();
                    if(!lowerName.includes('average') && lowerName !== 'store' && lowerName !== 'store total' && lowerName !== t.toLowerCase() && !strs.some(s => s.key.toLowerCase() === lowerName)) {
                        if (!empCols.some(e => e.name === colName)) empCols.push({ name: colName, idx: c });
                    }
                }

                const empColors = ['#a855f7', '#3b82f6', '#22c55e', '#f97316', '#ef4444', '#14b8a6', '#eab308', '#ec4899'];
                
                empCols.forEach((emp, eIdx) => {
                    let sData = [];
                    lbls.forEach((_, i) => { 
                        let rowIdx = sr+2+i;
                        if (rowIdx < d.length && Array.isArray(d[rowIdx])) {
                            let parsed = parseChartVal(d[rowIdx][emp.idx]);
                            sData.push(parsed);
                            if (parsed !== null) nums.push(parsed);
                        } else { sData.push(null); }
                    });
                    
                    if (sData.some(val => val !== null)) {
                        let color = empColors[eIdx % empColors.length];
                        fData.push({ label: '   ' + emp.name + '   ', data: sData, borderColor: color, backgroundColor: color, tension: 0.4, pointRadius: 5, spanGaps: true });
                    }
                });
            }
        }
    }

    let yMin = 0, yMax = 100; 
    if (nums.length) { 
        let mx = Math.max(...nums), mn = Math.min(...nums); 
        if (isPct) {
            yMin = Math.max(0, Math.floor(mn/10)*10 - 10); 
            yMax = Math.min(100, Math.ceil(mx/10)*10 + 10);
        } else if (metric === 'time') {
            yMin = Math.max(0, Math.floor(mn) - 1);
            yMax = Math.ceil(mx) + 1;
        } else {
            yMin = 0; 
            yMax = Math.ceil(mx * 1.2);
        }
    }

    const formatTimeStr = (v) => {
        let mins = Math.floor(v);
        let secs = Math.round((v - mins) * 60);
        if (secs === 60) { mins++; secs = 0; }
        return mins + ':' + (secs < 10 ? '0' : '') + secs;
    };

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
                legend: { 
                    position: 'bottom', 
                    labels: { font: { size: 13, family: "'Inter', sans-serif", weight: 'bold' }, usePointStyle: true, boxWidth: 8, padding: 20 }
                }, 
                datalabels: { 
                    align: 'top', 
                    anchor: 'end', 
                    formatter: v => {
                        if (v === null) return '';
                        return metric === 'time' ? formatTimeStr(v) : (Math.round(v*10)/10 + unit);
                    },
                    font: { size: 11, weight: 'bold' },
                    color: '#666',
                    offset: 4
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label.trim() || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                label += metric === 'time' ? formatTimeStr(context.parsed.y) : (Math.round(context.parsed.y*10)/10 + unit);
                            }
                            return label;
                        }
                    }
                }
            }, 
            scales: { 
                y: { min: yMin, max: yMax, ticks: { callback: v => metric === 'time' ? formatTimeStr(v) : (v + unit) } }, 
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
        date: new Date().toLocaleDateString('en-US'), 
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
    "Online Store Pictures", 
    "Staff Goals Readiness", 
    "5 Facebook Listings", 
    "2 Social Media Posts"
];

function openScorecardModal() {
    // 1. Let your native portal handle the animations and overlays!
    toggleModal('scorecardSubmitModal');
    
    // 2. Auto-fill today's date
    const dateInput = document.getElementById('dm-score-date');
    if (dateInput) dateInput.valueAsDate = new Date();
    
    // 3. Generate the inputs
    const container = document.getElementById('dm-category-inputs');
    if (container) {
        container.innerHTML = SCORECARD_CATEGORIES.map((cat, i) => `
            <div style="display: flex; flex-direction: column;">
                <label class="form-label-caps">${cat}</label>
                <select id="score-input-${i}" class="form-input-lg" style="margin-top: 0; padding: 10px; font-size: 14px;">
                    <option value="">--</option>
                    <option value="5">5</option>
                    <option value="4">4</option>
                    <option value="3">3</option>
                    <option value="2">2</option>
                    <option value="1">1</option>
                    <option value="0">0</option>
                </select>
            </div>
        `).join('');
    }
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
    
    // Gather all the scores from the dropdowns
    let scores = [];
    let isComplete = true;
    for (let i = 0; i < SCORECARD_CATEGORIES.length; i++) {
        let val = document.getElementById(`score-input-${i}`).value;
        if (val === "") isComplete = false;
        scores.push(val);
    }

    if (!isComplete) {
        alert("Please fill out all categories before submitting.");
        return;
    }

    btn.innerText = "Saving...";
    btn.style.opacity = "0.7";
    btn.disabled = true;

    const payload = {
        action: 'submit_scorecard',
        store: store,
        date: date,
        scores: scores
    };

    // Fire the data to Apps Script!
    fetch(SCORECARD_URL, {
        method: 'POST', 
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
    }).then(() => {
        btn.innerText = "Saved Successfully!";
        btn.style.background = "var(--sage-professional)";
        
        // Refresh the widget if they are looking at it, then close modal
        setTimeout(() => {
            if (typeof fetchScorecardData === 'function') fetchScorecardData();
            closeScorecardModal();
            btn.innerText = "Save Scorecard";
            btn.style.background = "";
            btn.disabled = false;
        }, 1500);
    }).catch(err => {
        alert("Error saving scorecard.");
        btn.innerText = "Save Scorecard";
        btn.disabled = false;
    });
}

// --- STORE COMMENTS LOGIC ---

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

// Helper to close the bubble and mark it as seen
window.closeDailyCommentBubble = function() {
    const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    sessionStorage.setItem(`speeksCommentSeen_${todayStr}`, 'true');
    const bubble = document.getElementById('dailyMessageBubble');
    if (bubble) bubble.style.display = 'none';
};

async function fetchAndDisplayStoreComment() {
    const userStore = String(sessionStorage.getItem('speeksUserStore') || 'OVL').trim().toUpperCase();
    const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    const sessionKey = `speeksCommentSeen_${todayStr}`;

    if (sessionStorage.getItem(sessionKey)) {
        return;
    }

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

        if (todayComments.length > 0) {
            const bubble = document.getElementById('dailyMessageBubble');
            const textEl = document.getElementById('dailyMessageBubbleText');
            const iconEl = document.getElementById('dailyMessageBubbleIcon');
            
            if (bubble && textEl && iconEl) {
                // Hide the single main icon since we will put specific icons on each message line
                iconEl.style.display = 'none';
                
                // Reformat the text container to allow stacking and text-wrapping
                textEl.style.whiteSpace = 'normal';
                textEl.style.display = 'flex';
                textEl.style.flexDirection = 'column';
                textEl.style.gap = '8px'; // Space between multiple messages
                textEl.style.padding = '4px 0';
                textEl.style.maxHeight = '150px'; // Prevent it from taking over the screen if there are 10 messages
                textEl.style.overflowY = 'auto'; // Add a scrollbar inside the bubble if needed
                
                // Align the bubble items to the top so the "X" button stays neatly at the top right
                bubble.style.alignItems = 'flex-start';
                const closeBtn = bubble.querySelector('button');
                if (closeBtn) closeBtn.style.marginTop = '4px';

                // Build the HTML for ALL messages today
                let messagesHtml = '';
                todayComments.forEach(msg => {
                    const authorName = msg.author || 'Executive Team';
                    
                    const emoji = '📣';
                    
                    messagesHtml += `
                        <div style="display: flex; align-items: flex-start; gap: 8px; line-height: 1.4;">
                            <span style="font-size: 15px; flex-shrink: 0; margin-top: -2px;">${emoji}</span>
                            <span><strong style="color: #fef3c7;">${authorName}:</strong> <span style="opacity: 0.95;">${msg.message}</span></span>
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
    const lDate = document.getElementById('lister-champions-date');
    const bDate = document.getElementById('buyer-champions-date');
    if (!listerBody || !buyerBody) return;

    try {
        const stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
        let allListers = [];
        let allBuyers = [];

        // 1. Calculate "Week Of" based on the previous Monday
        const now = new Date();
        const day = now.getDay();
        const diffToMonday = day === 0 ? -6 : 1 - day;
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() + diffToMonday);
        const weekText = "Week of " + startOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        
        if (lDate) lDate.innerText = weekText;
        if (bDate) bDate.innerText = weekText;

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
        const listerFetches = stores.map(s => fetch(`${WEEKLY_KPI_URL}?store=${s}&time=4-Week&v=${Date.now()}`).then(r => r.json()));
        const listerResults = await Promise.all(listerFetches);

        listerResults.forEach((d, storeIdx) => {
            let sIdx = d.findLastIndex(r => String(r[0]).trim().toLowerCase() === "store" || String(r[0]).trim().toLowerCase() === "store total");
            if (sIdx !== -1) {
                for (let i = Math.max(0, sIdx - 6); i <= Math.min(d.length - 1, sIdx + 6); i++) {
                    if (i === sIdx) continue;
                    let n = String(d[i][0]).trim();
                    let lN = n.toLowerCase();
                    if (n && !["name", "employee", "store", "store total", "ovl", "lee", "wsp", "mpl", "bal"].includes(lN) && !lN.includes("average") && !lN.includes("week")) {
                        let listed = parseNum(d[i][20]); 
                        if (listed > 0) {
                            allListers.push({ name: getFullName(n), store: stores[storeIdx], listed: listed });
                        }
                    }
                }
            }
        });

        // 4. FETCH BUYERS
        try {
            const buyerData = await fetch(`${WEEKLY_KPI_URL}?store=Weekly&time=Scores&v=${Date.now()}`).then(r => r.json());
            let currentStore = "Store";
            
            buyerData.forEach((row, index) => {
                let colA = String(row[0] || "").trim(); // Column A
                let colB = String(row[1] || "").trim(); // Column B
                let colC = String(row[2] || "").trim(); // Column C
                
                // Track which store's section we are in
                if (colA.toUpperCase().includes("TEAM")) currentStore = colA.split(' ')[0]; 
                if (colB.toUpperCase().includes("TEAM")) currentStore = colB.split(' ')[0]; 

                let empName = colC; 
                if (!empName) empName = colB; // Fallback to col B just in case

                // parseNum automatically strips commas. If undefined, defaults to 0.
                let finalScore = parseNum(row[7]) || 0; // Column H (Index 7)

                let isWeek4 = colA.toLowerCase().replace(/\s/g, '') === "week4" || colB.toLowerCase().replace(/\s/g, '') === "week4";
                
                // Hardcoded row fallback (1-indexed for human readability)
                let rowIndex = index + 1;
                let isHardcodedWeek4Row = 
                    (rowIndex >= 19 && rowIndex <= 22) || // OVL
                    (rowIndex >= 38 && rowIndex <= 40) || // LEE
                    (rowIndex >= 59 && rowIndex <= 62) || // WSP
                    (rowIndex >= 78 && rowIndex <= 80) || // MPL
                    (rowIndex >= 96 && rowIndex <= 98);   // BAL
                
                if (isWeek4 || isHardcodedWeek4Row) {
                    let cleanName = empName.toLowerCase();
                    if (cleanName && cleanName !== "employee" && cleanName !== "name" && !cleanName.includes("week") && !cleanName.includes("team")) {
                        allBuyers.push({
                            name: getFullName(empName),
                            store: currentStore,
                            score: finalScore
                        });
                    }
                }
            });
        } catch (buyerErr) {
            console.error("Failed to fetch Weekly Scores:", buyerErr);
        }

        // 5. BUILDER HELPER
        const buildPodiumHtml = (dataArray, sortBy, labelText, type) => {
            const merged = {};
            dataArray.forEach(emp => {
                if (!merged[emp.name]) merged[emp.name] = { ...emp };
                else {
                    if (type === 'lister') merged[emp.name].listed += emp.listed; 
                    if (type === 'buyer') merged[emp.name].score = Math.max(merged[emp.name].score, emp.score);
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
                
                // Only render the inner score/items text block if it is the Lister podium
                let blockContent = '';
                if (type === 'lister') {
                    blockContent = `
                        <div style="z-index: 2; display: flex; flex-direction: column; align-items: center;">
                            <span style="font-size: ${isFirst ? '32px' : '26px'}; font-weight: 900; color: var(--slate-charcoal); line-height: 1;">${emp.listed}</span>
                            <span style="font-size: 9px; font-weight: 900; color: #64748b; text-transform: uppercase; margin-top: 4px;">${labelText}</span>
                        </div>`;
                }

                html += `
                <div style="display: flex; flex-direction: column; align-items: center; width: 130px; margin: 0 5px;">
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

        listerBody.innerHTML = buildPodiumHtml(allListers, 'listed', 'Items', 'lister');
        buyerBody.innerHTML = buildPodiumHtml(allBuyers, 'score', 'Score', 'buyer');

    } catch (e) {
        listerBody.innerHTML = '<div style="color: var(--red-alert); font-weight: bold;">Failed to load Champions.</div>';
        buyerBody.innerHTML = '<div style="color: var(--red-alert); font-weight: bold;">Failed to load Champions.</div>';
    }
}

// ============================================================================
// MANAGER CHECKLIST MODULE
// ============================================================================
let currentChecklistTab = 'daily';
let checklistDataCache = { daily: [], weekly: [], monthly: [], quarterly: [] };

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
    const userName = sessionStorage.getItem('speeksUserName') || 'Unknown';
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL';

    // NEW LOGIC: Only show the Quarterly tab if the user is CORP
    const qTab = document.getElementById('cl-tab-quarterly');
    if (qTab) {
        if (store === 'CORP' || store === 'ALL') {
            qTab.style.display = 'inline-flex';
        } else {
            qTab.style.display = 'none';
            // Failsafe: if a retail manager somehow gets stuck on Quarterly, move them to Daily
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
}

// --- API ACTIONS (POST to Apps Script) ---
async function toggleChecklistState(id, isChecked) {
    const userName = sessionStorage.getItem('speeksUserName');
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL'; // <--- Added this
    
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

    const userName = sessionStorage.getItem('speeksUserName');
    const store = sessionStorage.getItem('speeksUserStore');
    const tempId = 'temp_' + Date.now(); // Temp ID until server refreshes

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
    const userName = sessionStorage.getItem('speeksUserName');
    const store = sessionStorage.getItem('speeksUserStore') || 'OVL'; // <--- Added this

    checklistDataCache[currentChecklistTab] = checklistDataCache[currentChecklistTab].filter(i => i.id !== id);
    renderChecklist();

    fetch(CHECKLIST_URL, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'delete', id: id, user: userName, store: store }) // <--- Added store here
    }).catch(() => {});
}

function clearChecklistTab() {
    const items = checklistDataCache[currentChecklistTab] || [];
    const checkedItems = items.filter(i => i.checked);
    if (checkedItems.length === 0) return;

    const userName = sessionStorage.getItem('speeksUserName');
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

// --- BULLETPROOF TOGGLE & CLICK-AWAY LOGIC ---
window.toggleChecklistPanel = function(event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('checklistSidePanel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    const toggle = document.querySelector('.cl-nav-toggle');
    if (toggle) toggle.classList.toggle('panel-active', isOpen);
};

// Closes the panel if you click outside of it
document.addEventListener('click', function(e) {
    // CRITICAL FIX: If the clicked element was just removed from the DOM (like deleting a task), ignore the click!
    if (!document.body.contains(e.target)) return;

    const panel = document.getElementById('checklistSidePanel');
    
    if (panel && panel.classList.contains('open')) {
        // Because the tab is now attached TO the panel, we only need to check if the click was inside the panel
        if (!panel.contains(e.target)) {
            panel.classList.remove('open');
        }
    }
});

// Run this on the 1st of EVERY month using the Monthly Time-Driven Trigger
function resetQuarterlyTasks() {
  const today = new Date();
  
  // In Javascript, months are 0-indexed (Jan = 0, Feb = 1... Apr = 3, Jul = 6, Oct = 9).
  // If the month number divided by 3 does NOT have a remainder of 0, it is NOT the start of a quarter.
  if (today.getMonth() % 3 !== 0) {
    return; // Stop the script immediately. Do nothing.
  }
  
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Tasks');
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).toLowerCase() === 'quarterly') {
      // Uncheck OVL through CORP
      sheet.getRange(i + 1, 7, 1, 6).setValue(false); 
    }
  }
}

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