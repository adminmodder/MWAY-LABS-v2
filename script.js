/* ---- Cloudflare Worker bridge (worker.js) ----
   Paste your Worker URL here (https://xxx.workers.dev) or enter it in Admin > Steam API Provisioning.
   The Admin value wins when both are set. Leave both empty to keep using the public CORS proxies. */
const BRIDGE_CONFIG = { url: 'https://mway-bridge.venovfx.workers.dev' };

(() => {
  'use strict';

  /* =====================================================================
     1. STORE: constants, defaults, persistence
     ===================================================================== */
  const MASTER = 'user';
  const VAULT_CODE = '1337';
  /* Steam accounts with full admin rights (the Worker recognises the same IDs, see ADMIN_STEAM_IDS in worker.js). */
  const ADMIN_STEAM_IDS = ['76561199124341488', '76561198769479051'];
  const load = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
  /* Global site state (settings) is mirrored to the Worker so visitors on any device see it. See "12g. GLOBAL SYNC". */
  const GLOBAL_KEYS = ['mway_settings'];
  const GS = { timer: 0, busy: false, again: false, pending: false, pulling: null, rev: 0, msg: '', bad: false, polled: 0 };
  const save = (k, v) => {
    let ok = true;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { ok = false; toast('Storage full - change kept for this session only'); }
    if (GLOBAL_KEYS.includes(k)) gsQueue();
    return ok;
  };

  const DEFAULT_ABOUT = 'Security researcher and developer exploring open-source intelligence, tooling and automation. This node hosts my projects, utilities and public profiles.';
  /* FACEIT Data API key pre-configured for the Admin panel (seeded once into an empty field, see renderAdmin). Visitors never
     use this copy: lookups for them go through the Worker, which holds the key (PUT /admin/keys). Rotate the key in the FACEIT
     developer portal if this file is ever published somewhere you do not control. */
  const FACEIT_DEFAULT = { name: 'Key_SdwTkNnNaR', key: '48d21ef0-2c3c-42ac-82ef-6f0a427d8987' };
  const DISCORD_URL = 'https://discord.gg/uMDagqPnUx';
  const DS = {
    discord: DISCORD_URL,
    subtitle: '// secure research & development node',
    subStyle: { color: '', size: 'm' },
    aboutText: '',
    heroTag: 'ENCRYPTED CHANNEL // NODE',
    steam: true,
    cvVisible: true,
    aboutVisible: true,
    aboutTitle: 'About Me',
    steamTitle: 'My Steam Accounts',
    tabs: { roadmap: true, tab3: true },
    pinnedVisible: true,
    pinnedLabel: 'Newest CS2 Tools',
    pinned: { account: true, crosshair: true, utilities: true, leaderboard: false },
    roadmapVisible: true,
    navLabels: { roadmap: 'ROADMAP', tab3: 'CS2' },
    steamCfg: {
      key: '', proxy: '', bridge: '', bridgeOnly: true, last: '', cache: {}, floatKey: '', hltvKey: '', hltvUrl: '', leetifyKey: '', faceitKey: '', faceitKeyName: '', faceitSeeded: false,
      accounts: 'https://steamcommunity.com/id/mboz\nhttps://steamcommunity.com/id/mz5001'
    }
  };
  const RM_STATUS = { planned: 'Planned', active: 'In progress', done: 'Reached' };
  const DEFAULT_ROADMAP = [
    { id: 'm1', name: 'Foundation', desc: 'Core node, secure vault login and admin console online.', status: 'done' },
    { id: 'm2', name: 'Tool Suite', desc: 'Publish the first OSINT utilities with versioned downloads.', status: 'active' },
    { id: 'm3', name: 'Bot Network', desc: 'Launch the Discord bot catalog and community hub.', status: 'planned' },
    { id: 'm4', name: 'Public Release', desc: 'Open the platform to the public with full documentation.', status: 'planned' }
  ];
  function normRoadmap(list) {
    return (Array.isArray(list) ? list : []).map((m, i) => ({
      id: String(m.id || 'm' + Date.now() + i), name: String(m.name || '').slice(0, 40),
      desc: String(m.desc || '').slice(0, 140), status: RM_STATUS[m.status] ? m.status : 'planned'
    })).filter(m => m.name);
  }

  function buildSettings(saved) {
    saved = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const st = Object.assign({}, DS, saved);
    ['tabs', 'navLabels', 'pinned', 'subStyle', 'steamCfg'].forEach(k => { st[k] = Object.assign({}, DS[k], saved[k]); });
    ['tools', 'bots', 'phone', 'tab4'].forEach(k => { delete st.tabs[k]; delete st.navLabels[k]; });
    ['featured', 'featuredVisible', 'quick'].forEach(k => { delete st[k]; });
    if (!String(st.steamTitle || '').trim()) st.steamTitle = DS.steamTitle;
    if (!String(st.pinnedLabel || '').trim()) st.pinnedLabel = DS.pinnedLabel;
    if (!st.steamCfg.cache || typeof st.steamCfg.cache !== 'object') st.steamCfg.cache = {};
    st.cvVisible = saved.cvVisible !== false;
    return st;
  }
  let about = load('mway_about', DEFAULT_ABOUT);
  let settings = buildSettings(load('mway_settings', {}));
  let roadmap = normRoadmap(load('mway_roadmap', DEFAULT_ROADMAP));
  let mailing = load('mway_mailing', []);
  let users = load('mway_users', []);
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem('mway_session')); } catch { session = null; }
  if (session && session.steam && ADMIN_STEAM_IDS.includes(session.id)) { session.role = 'admin'; session.admin = true; }
  let unlocked = sessionStorage.getItem('mway_unlocked') === '1' || (!!session && !session.steam); // Steam sessions never unlock the local login

  const isAdmin = () => !!session && (session.master || session.role === 'admin');

  /* =====================================================================
     2. HELPERS & UI primitives
     ===================================================================== */
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rnd = n => Math.floor(Math.random() * n);
  const fmtTime = iso => iso.replace('T', ' ').slice(0, 19) + ' UTC';
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2800);
  }
  function openModal(html, { dismissible = true, wide = false } = {}) {
    const ov = $('#modalOverlay'), m = $('#modal');
    m.innerHTML = html; m.classList.toggle('wide', wide);
    ov.classList.remove('hidden'); ov.dataset.dismissible = dismissible ? '1' : '0';
    const first = m.querySelector('input:not([type=color]):not([type=file]):not([type=checkbox]):not(:disabled), textarea'); if (first) first.focus();
  }
  function closeModal() { $('#modalOverlay').classList.add('hidden'); $('#modal').innerHTML = ''; }
  $('#modalOverlay').addEventListener('mousedown', e => {
    if (e.target.id === 'modalOverlay' && e.currentTarget.dataset.dismissible === '1') closeModal();
  });
  function alertModal(title, msg) {
    openModal(`<h3>${esc(title)}</h3><p>${esc(msg)}</p><div class="row"><button class="btn btn-primary btn-small" id="okBtn">OK</button></div>`);
    $('#okBtn').onclick = closeModal;
  }

  async function hash(pw, salt) {
    const s = salt + pw;
    try {
      const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
    } catch {
      let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
      return 'x' + h.toString(16);
    }
  }
  const makeSalt = () => Array.from({ length: 10 }, () => rnd(36).toString(36)).join('');
  const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
  function genPassword(len = 16) {
    const out = [], limit = 4294967296 - (4294967296 % PW_CHARS.length);
    try {
      while (out.length < len) {
        const buf = crypto.getRandomValues(new Uint32Array(len));
        for (const n of buf) { if (n < limit && out.length < len) out.push(PW_CHARS[n % PW_CHARS.length]); } // rejection sampling: no modulo bias
      }
    } catch { while (out.length < len) out.push(PW_CHARS[rnd(PW_CHARS.length)]); }
    return out.join('');
  }
  async function copyText(s) {
    try { await navigator.clipboard.writeText(s); return true; } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-100px;opacity:0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch { return false; }
    }
  }

  /* ---------- Diagnostics core: ring buffer + secret redaction (the UI lives in section 12f) ---------- */
  const DIAG_MAX = 400;
  let diagLog = (() => { const v = load('mway_diag', []); return Array.isArray(v) ? v.filter(e => e && e.t && e.lv && e.msg != null).slice(-150) : []; })();
  let diagLevel = 'all', diagCat = 'all', diagText = '', diagPaused = false, diagRaf = 0, diagChecks = [], diagSaveT = 0;
  const redact = s => String(s == null ? '' : s)
    .replace(/((?:[?&]|%26|%3F)(?:key|apikey|api_key|token|access_token)(?:=|%3D))[^&\s"'%]+/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
    .replace(/(openid\.(?:sig|assoc_handle|response_nonce)(?:=|%3D))[^&\s"']+/gi, '$1[redacted]')
    .replace(/\b[0-9a-fA-F]{32}\b/g, '[key]');
  const shortUrl = u => { try { const x = new URL(u); return x.hostname + x.pathname.slice(0, 70); } catch { return redact(String(u)).slice(0, 80); } };
  /* lv: ok | info | warn | error. `key` merges consecutive identical successes into one line with a counter. */
  function diag(lv, cat, msg, ms, key) {
    const last = diagLog[diagLog.length - 1];
    if (key && last && last.key === key && last.lv === lv) {
      last.n = (last.n || 1) + 1; last.t = new Date().toISOString(); if (ms != null) last.ms = Math.round(ms);
    } else {
      const e = { t: new Date().toISOString(), lv, cat, msg: redact(msg).slice(0, 400) };
      if (ms != null) e.ms = Math.round(ms);
      if (key) e.key = key;
      diagLog.push(e); if (diagLog.length > DIAG_MAX) diagLog.splice(0, diagLog.length - DIAG_MAX);
    }
    clearTimeout(diagSaveT);
    diagSaveT = setTimeout(() => { try { localStorage.setItem('mway_diag', JSON.stringify(diagLog.slice(-150))); } catch { /* storage full or blocked: keep the in-memory log only */ } }, 800);
    diagRender();
  }

  const opts = (map, cur, pick) => Object.keys(map).map(k => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(pick ? pick(map[k]) : map[k])}</option>`).join('');

  /* =====================================================================
     3. NAVIGATION: tabs, labels, settings application
     ===================================================================== */
  /* Hash routing (works on any static host, no server rewrite needed): #/roadmap, #/gaming, #/admin. Back / forward and pasted links all work. */
  const TAB_SLUG = { home: 'home', roadmap: 'roadmap', tab3: 'gaming', admin: 'admin' };
  const SLUG_TAB = Object.fromEntries(Object.entries(TAB_SLUG).map(([k, v]) => [v, k]));
  function tabAllowed(name) {
    const pg = document.getElementById(name);
    if (!pg || !pg.classList.contains('page')) return false;
    if (name === 'home') return true;
    if (name === 'admin') return isAdmin();
    // While the published settings are still loading, do not bounce a deep link just because the local copy is stale.
    return isAdmin() || GS.pending || settings.tabs[name] !== false;
  }
  function parseHash() {
    const m = location.hash.replace(/^#\/?/, '').split('/'), tab = SLUG_TAB[(m[0] || '').toLowerCase()];
    if (!tab) return null;
    let id = ''; try { id = m[1] ? decodeURIComponent(m[1]) : ''; } catch { id = ''; }
    return { tab, id };
  }
  function setHash(name, id, replace) {
    const h = name === 'home' ? '' : '#/' + TAB_SLUG[name] + (id ? '/' + encodeURIComponent(id) : '');
    if (location.hash === h || (!h && !location.hash)) return;
    try { history[replace ? 'replaceState' : 'pushState'](null, '', location.pathname + h); } catch { location.hash = h; }
  }
  /* CS2 tab: dropdown with sub pages: #/gaming/account (player lookup + Steam IDs converter), #/gaming/crosshair, #/gaming/utilities and #/gaming/leaderboard. */
  let tab3Sub = 'account';
  function setSub(sub) {
    if (['account', 'crosshair', 'utilities', 'leaderboard'].includes(sub)) tab3Sub = sub;
    $$('[data-subpage]').forEach(el => el.classList.toggle('sub-off', el.dataset.subpage !== tab3Sub));
    $$('#tab3Menu [data-sub]').forEach(b => { const on = b.dataset.sub === tab3Sub; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'true' : 'false'); });
    if (tab3Sub === 'utilities') utEnter();
    if (tab3Sub === 'leaderboard') lbEnter();
  }
  function ddOpen(open) {
    const m = $('#tab3Menu'), b = $('#tab3Btn'); if (!m || !b) return;
    m.classList.toggle('hidden', !open); b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function activateTab(name, sub) {
    if (name !== 'admin') wipeOtp();
    if (name === 'tab3') setSub(sub);
    ddOpen(false);
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.page').forEach(p => p.classList.toggle('active', p.id === name));
    window.scrollTo({ top: 0 });
    decryptTitles(name);
    document.title = name === 'home' ? 'MWAY LABS' : 'MWAY LABS | ' + (settings.navLabels[name] || name.toUpperCase());
  }
  function showTab(name, o = {}) {
    if (!tabAllowed(name)) name = 'home';
    if (name === 'tab3' && !o.id) o = Object.assign({}, o, { id: tab3Sub });
    activateTab(name, o.id);
    if (!o.noHash) setHash(name, o.id, o.replace);
  }
  function routeFromHash() {
    const r = parseHash(), act = $('.page.active');
    if (!r) { if (act && act.id !== 'home') activateTab('home'); return; }
    if (!tabAllowed(r.tab)) { if (!act || act.id !== 'home') activateTab('home'); if (location.hash && !GS.pending) setHash('home', '', true); return; }
    if (!act || act.id !== r.tab) activateTab(r.tab, r.id); else if (r.tab === 'tab3') setSub(r.id);
  }
  $$('.tab:not(#tab3Btn)').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#tab3Btn').addEventListener('click', e => { e.stopPropagation(); ddOpen($('#tab3Menu').classList.contains('hidden')); });
  $$('#tab3Menu [data-sub]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); showTab('tab3', { id: b.dataset.sub }); ddOpen(false); }));
  document.addEventListener('click', e => { if (!e.target.closest('#tab3Dd')) ddOpen(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { const m = $('#tab3Menu'); if (m && !m.classList.contains('hidden')) { ddOpen(false); $('#tab3Btn').focus(); } } });
  setSub('account');
  window.addEventListener('hashchange', routeFromHash);
  window.addEventListener('popstate', routeFromHash);

  function applySettings() {
    const a = isAdmin();
    if (!settings.discord || settings.discord === 'https://discord.com') settings.discord = DISCORD_URL;   // old default -> the MWAY LABS invite
    if (!settings.navLabels.tab3 || /^(gaming|cs2w)$/i.test(settings.navLabels.tab3)) settings.navLabels.tab3 = 'CS2';   // the Gaming icon tab is now the text tab "CS2W" (same capitalisation as HOME / TOOLS)
    $('#discordBtn').href = settings.discord;
    $('#subText').textContent = settings.subtitle;
    { const ss = settings.subStyle || {}, el = $('#subText'); el.style.color = /^#[0-9a-f]{6}$/i.test(ss.color || '') ? ss.color : ''; el.style.fontSize = { s: '.85em', l: '1.2em', xl: '1.45em' }[ss.size] || ''; }
    $('#heroTagText').textContent = settings.heroTag;
    $$('[data-lbl]').forEach(el => { el.textContent = settings.navLabels[el.dataset.lbl]; });
    { const b = $('#tab3Btn'); b.title = settings.navLabels.tab3; b.setAttribute('aria-label', settings.navLabels.tab3); }
    ['roadmap', 'tab3'].forEach(k => {
      const b0 = $(`.tab[data-tab="${k}"]`), b = b0.closest('.tab-dd') || b0, off = !settings.tabs[k];
      b.classList.toggle('hidden', off && !a); b0.classList.toggle('off', off);
    });
    const cvp = $('#cvPanel'), cvOn = settings.cvVisible !== false;
    cvp.classList.toggle('hidden', !cvOn && !a); cvp.classList.toggle('faded', !cvOn);
    $('#cvToggle').checked = cvOn;
    const st = $('#steamSection');
    st.classList.toggle('hidden', !settings.steam && !a);
    st.classList.toggle('faded', !settings.steam);
    $('#steamToggle').checked = settings.steam;
    renderAbout(); renderPinned(); renderRoadmap(); renderSteam();
    const act = $('.page.active');
    if (act && ((act.id === 'admin' && !a) || (settings.tabs[act.id] === false && !a))) showTab('home', { replace: true });
  }

  function applyAuth() {
    $('#loginBtn').textContent = session && !session.steam ? (session.master ? 'Admin' : session.u) + ' (Logged In)' : 'Log In';
    $('#steamLoginBtn').classList.toggle('on', !!(session && session.steam));
    $('#steamLoginBtn .sl-text').textContent = session && session.steam ? (session.name || session.id) + (session.admin ? ' (Steam Admin)' : ' (Steam)') : 'Log in with Steam';
    $$('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
    if (!isAdmin()) { cancelAboutEdit(); cancelSteamEdit(); wipeOtp(); }
    applySettings(); renderAdmin(); renderXhSaved(); cvSyncMine(); utRefresh();
  }

  /* =====================================================================
     4. GATEKEEPER: vault case + 4-digit keypad
     ===================================================================== */
  const kp = { buf: '', busy: false };

  function applyGate(animate) {
    const v = $('#vaultBtn'), l = $('#loginBtn');
    if (!unlocked) { v.classList.remove('hidden', 'dissolve'); l.classList.add('hidden'); return; }
    if (!animate) { v.classList.add('hidden'); l.classList.remove('hidden'); return; }
    v.classList.add('dissolve');
    setTimeout(() => {
      v.classList.add('hidden'); l.classList.remove('hidden'); l.classList.add('reveal');
      setTimeout(() => l.classList.remove('reveal'), 900);
    }, reducedMotion() ? 0 : 700);
  }
  function kpRender() { $$('#kpDots i').forEach((d, i) => d.classList.toggle('on', i < kp.buf.length)); }
  function kpMsg(text, cls) { const m = $('#kpMsg'); m.textContent = text; m.className = 'kp-msg' + (cls ? ' ' + cls : ''); }
  const kpVisible = () => !$('#keypadOverlay').classList.contains('hidden');
  function kpOpen() {
    kp.buf = ''; kp.busy = false; kpRender(); kpMsg('Enter 4-digit code');
    $('#keypad').classList.remove('shake', 'ok');
    $('#keypadOverlay').classList.remove('hidden');
    const first = $('#kpGrid button'); if (first) first.focus();
  }
  function kpClose() { $('#keypadOverlay').classList.add('hidden'); if (!unlocked) $('#vaultBtn').focus(); }
  function kpPress(d) {
    if (kp.busy || kp.buf.length >= 4) return;
    kp.buf += d; kpRender();
    if (kp.buf.length === 4) { kp.busy = true; setTimeout(kpCheck, 220); }
  }
  function kpCheck() {
    const box = $('#keypad');
    if (kp.buf === VAULT_CODE) {
      box.classList.add('ok'); kpMsg('Access granted', 'good');
      setTimeout(() => {
        unlocked = true; sessionStorage.setItem('mway_unlocked', '1');
        kpClose(); applyGate(true);
      }, 450);
    } else {
      box.classList.add('shake'); kpMsg('Access denied', 'bad');
      setTimeout(() => { box.classList.remove('shake'); kp.buf = ''; kpRender(); kpMsg('Enter 4-digit code'); kp.busy = false; }, 650);
    }
  }
  function buildKeypad() {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CLR', '0', 'DEL'];
    $('#kpGrid').innerHTML = keys.map(k => `<button type="button" class="kp-key${/\d/.test(k) ? '' : ' fn'}" data-k="${k}" aria-label="${k}">${k}</button>`).join('');
  }
  $('#vaultBtn').addEventListener('click', kpOpen);
  $('#kpClose').addEventListener('click', kpClose);
  $('#keypadOverlay').addEventListener('mousedown', e => { if (e.target.id === 'keypadOverlay') kpClose(); });
  $('#kpGrid').addEventListener('click', e => {
    const b = e.target.closest('[data-k]'); if (!b || kp.busy) return;
    const k = b.dataset.k;
    if (k === 'CLR') { kp.buf = ''; kpRender(); } else if (k === 'DEL') { kp.buf = kp.buf.slice(0, -1); kpRender(); } else kpPress(k);
  });
  document.addEventListener('keydown', e => {
    if (!kpVisible()) return;
    if (e.key === 'Escape') return kpClose();
    if (/^\d$/.test(e.key)) { e.preventDefault(); kpPress(e.key); }
    else if (e.key === 'Backspace' && !kp.busy) { kp.buf = kp.buf.slice(0, -1); kpRender(); }
  });

  /* =====================================================================
     5. AUTH: login, forced password change, logout
     ===================================================================== */
  function passwordChangeModal(intro, apply, rejectDefault) {
    openModal(`
      <h3>Change Password</h3><p>${esc(intro)}</p>
      <input id="nPw" type="password" placeholder="New password" autocomplete="new-password">
      <input id="nPw2" type="password" placeholder="Confirm new password" autocomplete="new-password">
      <div class="error" id="nErr"></div>
      <div class="row"><button class="btn btn-primary btn-small" id="nGo">Update Password</button></div>`, { dismissible: false });
    const go = async () => {
      const a = $('#nPw').value, b = $('#nPw2').value;
      if (a.length < 6) return $('#nErr').textContent = 'Password must be at least 6 characters.';
      if (rejectDefault && a === 'pw') return $('#nErr').textContent = 'New password must differ from the default.';
      if (a !== b) return $('#nErr').textContent = 'Passwords do not match.';
      await apply(a);
      closeModal(); toast('Password updated.');
    };
    $('#nGo').onclick = go; $('#nPw2').addEventListener('keydown', e => e.key === 'Enter' && go());
  }
  function forceMasterPasswordChange() {
    passwordChangeModal('Set a new master password before continuing (min. 6 characters, different from the default).',
      async pw => { const s = makeSalt(); save('mway_master', { s, h: await hash(pw, s) }); }, true);
  }
  function forceUserPasswordChange(uname) {
    passwordChangeModal('You signed in with a one-time password. Set your own password to continue (min. 6 characters).',
      async pw => {
        const acc = users.find(x => x.u === uname); if (!acc) return;
        acc.s = makeSalt(); acc.h = await hash(pw, acc.s); acc.otp = false; delete acc.resetAt;
        save('mway_users', users);
        if (session && session.u === uname) { session.otp = false; sessionStorage.setItem('mway_session', JSON.stringify(session)); }
        renderUsers();
      }, false);
  }

  function showLogin() {
    openModal(`
      <h3>Secure Login</h3><p>Authenticate to access your account.</p>
      <input id="lUser" placeholder="Username" autocomplete="username">
      <input id="lPw" type="password" placeholder="Password" autocomplete="current-password">
      <div class="error" id="lErr"></div>
      <div class="row"><button class="btn btn-small" id="lCancel">Cancel</button><button class="btn btn-primary btn-small" id="lGo">Log In</button></div>`);
    const go = async () => {
      const u = $('#lUser').value.trim(), p = $('#lPw').value;
      const m = load('mway_master', null);
      let sess = null;
      if (u === MASTER) {
        const ok = m ? (await hash(p, m.s)) === m.h : p === 'pw';
        if (ok) sess = { u, master: true, role: 'admin' };
      } else {
        const acc = users.find(x => x.u === u);
        if (acc && acc.h && (await hash(p, acc.s)) === acc.h) sess = { u, master: false, role: acc.role, otp: !!acc.otp };
      }
      if (!sess) { $('#lErr').textContent = 'Invalid credentials.'; return; }
      session = sess; sessionStorage.setItem('mway_session', JSON.stringify(sess));
      closeModal(); applyAuth();
      if (sess.master && !m) forceMasterPasswordChange();
      else if (sess.otp) forceUserPasswordChange(sess.u);
    };
    $('#lGo').onclick = go; $('#lCancel').onclick = closeModal;
    $('#lPw').addEventListener('keydown', e => e.key === 'Enter' && go());
  }

  function logout() {
    session = null; sessionStorage.removeItem('mway_session'); wipeOtp(); closeModal(); applyAuth(); toast('Logged out.');
  }
  $('#loginBtn').addEventListener('click', () => {
    if (!session || session.steam) return showLogin();
    openModal(`<h3>Session</h3><p>Signed in as ${esc(session.u)} (${esc(session.role)}). Log out?</p>
      <div class="row"><button class="btn btn-small" id="stay">Stay</button><button class="btn btn-primary btn-small" id="out">Log Out</button></div>`);
    $('#stay').onclick = closeModal;
    $('#out').onclick = logout;
  });

  /* ---------- Steam OpenID login (not gated by the vault keypad) ----------
     Flow: redirect to Steam -> Steam returns signed openid.* parameters -> we ask Steam to confirm them
     (check_authentication) through the proxy chain -> a viewer-level session is created.
     Steam sessions never get admin rights; they can save crosshairs (keyed by SteamID) and rate items. */
  const STEAM_OP = 'https://steamcommunity.com/openid/login';
  const pageBase = () => location.href.split('#')[0].split('?')[0];
  const randHex = n => { try { return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join(''); } catch { return Array.from({ length: n }, () => rnd(256).toString(16).padStart(2, '0')).join(''); } };

  function steamLoginStart() {
    if (!/^https?:$/.test(location.protocol)) {
      return alertModal('Steam login unavailable', 'Steam can only redirect back to an http(s) address. Open the site from your hosted domain (or a local web server) instead of a file:// path.');
    }
    if (session && !session.steam) return toast('Log out of your local account first.');
    const state = randHex(12);
    sessionStorage.setItem('mway_steam_state', state);
    const p = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'checkid_setup',
      'openid.return_to': pageBase() + '?steam_cb=' + state, 'openid.realm': location.origin,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select', 'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
    });
    diag('info', 'openid', 'login started, redirecting to Steam (return_to ' + pageBase() + ')');
    location.href = STEAM_OP + '?' + p;
  }

  /* Ask Steam to confirm the assertion. With a bridge configured the Worker does it server-side
     (POST /openid/verify). Without one (or when bridge-only is off) every proxy route (proxy x GET/POST)
     is raced with a stagger as before. */
  async function steamVerify(a) {
    const b = bridgeUrl(), useLegacy = !b || !settings.steamCfg.bridgeOnly;
    const body = new URLSearchParams(a); body.set('openid.mode', 'check_authentication');
    const qs = body.toString(), getUrl = STEAM_OP + '?' + qs;
    const post = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs };
    const claimed = String(a['openid.claimed_id'] || '').replace(/^.*\//, '');
    const routes = [];
    if (b) routes.push({ bridge: true }, { bridge: true });
    if (useLegacy) {
      legacyList().forEach(p => { if (p.post) routes.push({ p, m: 'POST' }); routes.push({ p, m: 'GET' }); });
      routes.push({ p: null, m: 'POST' }); // direct (works only if Steam ever allows CORS)
    }
    const name = rt => rt.bridge ? 'bridge' : rt.p ? routeName(rt.p) + ' ' + rt.m : 'direct';
    const run0 = async (rt, sig) => {
      if (rt.bridge) {
        let res;
        try {
          res = await fetchText(b + '/openid/verify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(a).toString() }, 10000, sig);
        } catch (e) { throw netErr('NET', e && e.name === 'AbortError' ? 'bridge timed out' : 'bridge unreachable (wrong URL, Worker not deployed, or this origin is not in ALLOWED_ORIGINS)'); }
        let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
        if (!j) throw netErr('NET', 'bridge returned an unreadable answer (HTTP ' + res.status + ')');
        if (j.valid === true) {
          if (j.steamid === claimed) { steamTok = String(j.token || ''); return true; }
          throw netErr('INVALID', 'The bridge confirmed a different SteamID than the one in the login.');
        }
        if (res.status === 200 || res.status === 400) throw netErr('INVALID', j.error || 'Steam did not confirm this login.');
        throw netErr('NET', 'Worker refused the request: ' + (j.error || 'HTTP ' + res.status));
      }
      let res;
      try {
        res = await fetchText(rt.p ? routeUrl(rt.p, rt.m === 'GET' ? getUrl : STEAM_OP) : STEAM_OP, rt.m === 'GET' ? {} : post, 8000, sig);
      } catch (e) { throw netErr('NET', e && e.name === 'AbortError' ? 'timed out' : 'network error'); }
      let text = res.text;
      if (rt.p && rt.p.wrap) { try { text = String(JSON.parse(text).contents || ''); } catch { throw netErr('NET', 'bad wrapper'); } }
      if (/is_valid\s*:\s*true/i.test(text)) return true;
      if (/is_valid\s*:\s*false/i.test(text)) throw netErr('INVALID', 'Steam reports this login as invalid.');
      throw netErr('NET', 'unusable response (HTTP ' + res.status + ')');
    };
    const run = async (rt, sig) => {
      const t0 = performance.now();
      try {
        const r = await run0(rt, sig);
        diag('ok', 'openid', 'Steam confirmed the login via ' + name(rt), performance.now() - t0);
        return r;
      } catch (e) {
        if (!sig.aborted) diag(e.code === 'INVALID' ? 'error' : 'warn', 'openid', name(rt) + ': ' + e.message, performance.now() - t0);
        throw e;
      }
    };
    try { return await raceRoutes(routes, run, { stagger: 3000, total: 26000 }); }
    catch (errs) {
      if ((errs || []).some(e => e && e.code === 'INVALID')) throw netErr('INVALID', 'Steam did not accept this login. Start the login again.');
      const ref = (errs || []).find(e => e && /^Worker refused/.test(e.message || ''));
      if (ref) throw netErr('NET', ref.message + '. The site owner should check ALLOWED_ORIGINS on the Worker (Admin > Server Error & API Log shows the blocked origin).');
      throw netErr('NET', b && !useLegacy
        ? 'Could not confirm the login through the bridge. Check the bridge URL and ALLOWED_ORIGINS (Admin > Diagnostics Logger).'
        : 'Could not reach Steam to confirm the login. Every route failed or timed out.');
    }
  }

  async function adminCheck(quiet) {
    if (!session || !session.admin) return;
    const b = bridgeUrl(), el = $('#adminSrv'), set = (t, bad) => { if (el) { el.textContent = t; el.style.color = bad ? 'var(--danger)' : ''; } if (bad && !quiet) toast(t); };
    if (!b) return set('Steam admin: set the Worker bridge URL (Admin > Steam API Provisioning) so admin actions reach the server.', true);
    if (!session.tok) return set('Steam admin: this login got no server token. Deploy the newest worker.js (its ADMIN_TOKEN secret must be set), then log in with Steam again.', true);
    try {
      const r = JSON.parse((await fetchText(b + '/whoami', { headers: { Authorization: 'Bearer ' + session.tok } }, 10000)).text);
      if (r && r.admin) set('Steam admin: server access confirmed (changes are published to every visitor).');
      else set(r && r.secret === false ? 'Steam admin: the Worker has no ADMIN_TOKEN secret, so it cannot issue admin tokens. Set it in the Worker settings.' : 'Steam admin: the Worker did not accept this login as admin. Deploy the newest worker.js and log in again.', true);
    } catch { set('Steam admin: could not reach the Worker to confirm access (an older worker.js has no /whoami).', true); }
  }
  let steamTok = '';
  function finishSteamLogin(id) {
    const adm = ADMIN_STEAM_IDS.includes(id);
    session = { u: 'steam:' + id, id, name: id, steam: true, master: false, role: adm ? 'admin' : 'steam', admin: adm, tok: steamTok };
    steamTok = '';
    sessionStorage.setItem('mway_session', JSON.stringify(session));
    applyAuth(); toast(adm ? 'Logged in with Steam as admin.' : 'Logged in with Steam.'); if (adm) adminCheck();
    if (settings.tabs.tab3 !== false) {
      showTab('tab3', { id: 'account' });
      $('#lkIn').value = id;
      lkSearch(true);   // auto-load the player's own data
    }
  }

  async function handleSteamReturn() {
    if (!/[?&]openid\.mode=/.test(location.search)) return;
    const here = pageBase(), sp = new URLSearchParams(location.search), a = {};
    sp.forEach((v, k) => { if (k.startsWith('openid.')) a[k] = v; });
    const cb = sp.get('steam_cb'), expect = sessionStorage.getItem('mway_steam_state');
    history.replaceState(null, '', location.pathname + location.hash);
    diag('info', 'openid', 'returned from Steam, mode=' + (a['openid.mode'] || 'unknown'));
    if (a['openid.mode'] === 'cancel') return toast('Steam login cancelled.');
    const m = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(a['openid.claimed_id'] || '');
    const nonce = String(a['openid.response_nonce'] || ''), t = Date.parse(nonce.slice(0, 20));
    const used = (() => { try { return JSON.parse(sessionStorage.getItem('mway_steam_used') || '[]'); } catch { return []; } })();
    const why = [];
    if (!m) why.push('claimed_id is not a Steam profile address');
    if (a['openid.mode'] !== 'id_res') why.push('unexpected mode "' + (a['openid.mode'] || '') + '"');
    if (a['openid.op_endpoint'] !== STEAM_OP) why.push('unexpected op_endpoint');
    if (!expect) why.push('no login state in this tab (started in another tab or browser, or session storage is blocked)');
    else if (cb !== expect) why.push('login state does not match');
    if (expect && a['openid.return_to'] !== here + '?steam_cb=' + expect) why.push('return_to does not match this page address');
    if (a['openid.identity'] !== a['openid.claimed_id']) why.push('identity differs from claimed_id');
    if (!nonce) why.push('missing nonce');
    else if (used.includes(nonce)) why.push('nonce was already used');
    else if (!isNaN(t) && Math.abs(Date.now() - t) > 15 * 60 * 1000) why.push('assertion is older than 15 minutes');
    if (why.length) {
      diag('error', 'openid', 'assertion rejected: ' + why.join('; '));
      return alertModal('Steam login failed', 'The login response was invalid, expired or did not start on this page. Please try again. (' + why[0] + ')');
    }
    const id = m[1];
    const attempt = async () => {
      openModal('<h3>Steam Login</h3><p>Confirming your login with Steam&hellip;</p><div class="lk-spin" aria-hidden="true"></div>', { dismissible: false });
      try {
        await steamVerify(a);
        used.push(nonce); sessionStorage.setItem('mway_steam_used', JSON.stringify(used.slice(-10)));
        sessionStorage.removeItem('mway_steam_state');
        diag('ok', 'openid', 'login confirmed for SteamID ' + id);
        closeModal(); finishSteamLogin(id);
      } catch (e) {
        diag('error', 'openid', 'confirmation failed [' + (e.code || 'ERR') + ']: ' + e.message);
        const retry = e.code !== 'INVALID';
        openModal(`<h3>Steam login failed</h3><p>${esc(e.message)}${retry ? ' Your Steam sign-in itself went through; only the confirmation request failed. You can retry without signing in again.' : ''}</p>
          <div class="row"><button class="btn btn-small" id="slClose">Close</button>${retry ? '<button class="btn btn-primary btn-small" id="slRetry">Retry</button>' : ''}</div>`);
        $('#slClose').onclick = closeModal;
        if (retry) $('#slRetry').onclick = attempt;
      }
    };
    attempt();
  }

  $('#steamLoginBtn').addEventListener('click', () => {
    if (session && session.steam) {
      openModal(`<h3>Steam Session</h3><p>Signed in as ${esc(session.name || session.id)} (SteamID ${esc(session.id)}). Log out?</p>
        <div class="row"><button class="btn btn-small" id="stay">Stay</button><button class="btn btn-primary btn-small" id="out">Log Out</button></div>`);
      $('#stay').onclick = closeModal; $('#out').onclick = logout;
    } else steamLoginStart();
  });

  /* =====================================================================
     6. HOME: subtitle, About Me, pinned tools, steam accounts
     ===================================================================== */
  function renderAbout() {
    $('#aboutTitle').textContent = settings.aboutTitle;
    $('#aboutText').textContent = about;
    $('#aboutToggle').checked = settings.aboutVisible;
    const sec = $('#aboutSection');
    sec.classList.toggle('hidden', !settings.aboutVisible && !isAdmin());
    sec.classList.toggle('faded', !settings.aboutVisible);
  }
  function cancelAboutEdit() { $('#aboutEdit').classList.add('hidden'); $('#aboutText').classList.remove('hidden'); }
  $('#editAboutBtn').addEventListener('click', () => {
    $('#aboutTitleInput').value = settings.aboutTitle; $('#aboutInput').value = about;
    $('#aboutText').classList.add('hidden'); $('#aboutEdit').classList.remove('hidden');
  });
  $('#cancelAbout').addEventListener('click', cancelAboutEdit);
  $('#saveAbout').addEventListener('click', () => {
    const title = $('#aboutTitleInput').value.trim(), v = $('#aboutInput').value.trim();
    if (!title) return toast('Title cannot be empty.');
    if (!v) return toast('Description cannot be empty.');
    about = v; settings.aboutTitle = title; settings.aboutText = v;
    save('mway_about', about); save('mway_settings', settings);
    renderAbout(); cancelAboutEdit(); toast('About section updated.');
  });
  $('#aboutToggle').addEventListener('change', e => { settings.aboutVisible = e.target.checked; save('mway_settings', settings); renderAbout(); });

  $('#editSubBtn').addEventListener('click', () => {
    const ss = settings.subStyle || {};
    openModal(`<h3>Edit Subtitle</h3><p>Text and look of the line beneath the main title. Saved for every visitor.</p>
      <input id="subInput" value="${esc(settings.subtitle)}" maxlength="120">
      <div class="row"><label class="flabel">Colour <input id="subColor" type="color" value="${/^#[0-9a-f]{6}$/i.test(ss.color || '') ? ss.color : '#8793a5'}"></label>
      <label class="flabel">Size <select id="subSize">${[['s', 'Small'], ['m', 'Normal'], ['l', 'Large'], ['xl', 'Extra large']].map(([k, n]) => `<option value="${k}"${(ss.size || 'm') === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="btn btn-small" id="subReset" type="button">Reset look</button></div>
      <div class="row"><button class="btn btn-small" id="sc">Cancel</button><button class="btn btn-primary btn-small" id="ss">Save</button></div>`);
    let reset = !ss.color;
    $('#subColor').oninput = () => { reset = false; };
    $('#subReset').onclick = () => { reset = true; $('#subSize').value = 'm'; toast('Look reset: press Save to apply.'); };
    $('#sc').onclick = closeModal;
    $('#ss').onclick = () => {
      const v = $('#subInput').value.trim(); if (!v) return toast('Subtitle cannot be empty.');
      settings.subtitle = v; settings.subStyle = { color: reset ? '' : $('#subColor').value, size: $('#subSize').value };
      save('mway_settings', settings); closeModal(); applySettings(); toast('Subtitle updated.');
    };
  });
  $('#editTagBtn').addEventListener('click', () => {
    openModal(`<h3>Edit Hero Tag</h3><p>Text shown above the main title.</p>
      <input id="tagInput" value="${esc(settings.heroTag)}" maxlength="60">
      <div class="row"><button class="btn btn-small" id="tc">Cancel</button><button class="btn btn-primary btn-small" id="ts">Save</button></div>`);
    $('#tc').onclick = closeModal;
    $('#ts').onclick = () => {
      const v = $('#tagInput').value.trim(); if (!v) return toast('Text cannot be empty.');
      settings.heroTag = v; save('mway_settings', settings); closeModal(); applySettings();
    };
  });
  $('#steamToggle').addEventListener('change', e => { settings.steam = e.target.checked; save('mway_settings', settings); applySettings(); });

  /* Pinned CS2 tools: admins choose which new tools are highlighted on the Home page; a click opens the tool's page. */
  const PIN_TOOLS = {
    account: { title: 'Account Search', badge: 'V1', hue: '#5b8def', desc: 'Look up any Steam / CS2 profile: Premier and FACEIT ranks, Leetify stats, inventory value, bans and more.', tags: ['Profile', 'Ranks', 'Inventory'], icon: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>' },
    crosshair: { title: 'Crosshair Generator', badge: 'V1', hue: '#c58bff', desc: 'Design, preview on official map screenshots and import CS2 crosshair share codes.', tags: ['Preview', 'Import', 'Share code'], icon: '<circle cx="12" cy="12" r="3"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>' },
    utilities: { title: 'Utilities', badge: 'BETA', hue: '#ffb454', desc: 'Lineup maps on Valve\'s official radars. Drop smokes, flashes and mollies with YouTube or Discord videos.', tags: ['Official radars', 'Lineups', 'Video'], icon: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>' },
    leaderboard: { title: 'Leaderboard', badge: 'NEW', hue: '#4fd6a0', desc: 'Top 100 Premier and FACEIT players, one click away from their full profile.', tags: ['Premier', 'FACEIT', 'Top 100'], icon: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>' }
  };
  function renderPinned() {
    const sec = $('#pinnedSection'), on = settings.pinnedVisible !== false, keys = Object.keys(PIN_TOOLS).filter(k => settings.pinned[k]);
    $('#pinnedTitle').textContent = settings.pinnedLabel;
    $('#pinnedToggle').checked = on;
    sec.classList.toggle('hidden', (!on || !keys.length) && !isAdmin());
    sec.classList.toggle('faded', !on);
    $('#pinnedBody').innerHTML = keys.length ? keys.map((k, i) => { const p = PIN_TOOLS[k]; return `<div class="card pin-card" style="--pc:${p.hue};--i:${i}" role="link" tabindex="0" data-pin="${k}" aria-label="Open ${esc(p.title)}">
        <span class="pin-glow" aria-hidden="true"></span>
        <div class="pin-head"><span class="pin-ico"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p.icon}</svg></span><span class="pin-badge">${esc(p.badge)}</span></div>
        <h3 class="pin-title">${esc(p.title)}</h3><p class="pin-desc">${esc(p.desc)}</p>
        <div class="pin-tags">${p.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>
        <div class="pin-go">OPEN TOOL <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div></div>`; }).join('')
      : '<div class="panel"><p class="muted">No tools pinned. Use Edit Section to pin one.</p></div>';
  }
  function openPinned(k) {
    if (!PIN_TOOLS[k]) return;
    if (!isAdmin() && settings.tabs.tab3 === false) return toast('That section is currently unavailable.');
    showTab('tab3', { id: k });
  }
  $('#pinnedBody').addEventListener('click', e => { const c = e.target.closest('[data-pin]'); if (c) openPinned(c.dataset.pin); });
  $('#pinnedBody').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const c = e.target.closest('[data-pin]'); if (c) { e.preventDefault(); openPinned(c.dataset.pin); }
  });
  $('#pinnedToggle').addEventListener('change', e => { settings.pinnedVisible = e.target.checked; save('mway_settings', settings); renderPinned(); });
  $('#editPinnedBtn').addEventListener('click', () => {
    openModal(`<h3>Edit Pinned Tools</h3><p>Choose the section name and which CS2 tools are pinned on the Home page.</p>
      <input id="pLabel" value="${esc(settings.pinnedLabel)}" maxlength="40" placeholder="Newest CS2 Tools">
      ${Object.keys(PIN_TOOLS).map(k => `<label class="toggle"><input type="checkbox" data-pk="${k}" ${settings.pinned[k] ? 'checked' : ''}> ${esc(PIN_TOOLS[k].title)}</label>`).join('')}
      <div class="row"><button class="btn btn-small" id="pc">Cancel</button><button class="btn btn-primary btn-small" id="ps">Save</button></div>`);
    $('#pc').onclick = closeModal;
    $('#ps').onclick = () => {
      const l = $('#pLabel').value.trim(); if (!l) return toast('Section name is required.');
      settings.pinnedLabel = l;
      $$('#modal [data-pk]').forEach(c => { settings.pinned[c.dataset.pk] = c.checked; });
      save('mway_settings', settings); closeModal(); renderPinned(); toast('Pinned tools updated.');
    };
  });

  /* ---------- Steam: rendering + provisioning ---------- */
  function parseSteamEntries(text) {
    const seen = new Set(), out = [];
    String(text || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean).forEach(raw => {
      let m, e = null;
      if ((m = raw.match(/steamcommunity\.com\/profiles\/(\d{17})/i)) || (m = raw.match(/^(\d{17})$/))) e = { key: 'i:' + m[1], id: m[1], label: m[1] };
      else if ((m = raw.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,32})/i)) || (m = raw.match(/^([A-Za-z0-9_-]{2,32})$/))) e = { key: 'v:' + m[1].toLowerCase(), vanity: m[1], label: m[1] };
      if (e && !seen.has(e.key)) { seen.add(e.key); out.push(e); }
    });
    return out;
  }
  const steamFallbackUrl = e => e.id ? `https://steamcommunity.com/profiles/${e.id}` : `https://steamcommunity.com/id/${e.vanity}`;

  function renderSteam() {
    $('#steamTitle').textContent = settings.steamTitle;
    const cfg = settings.steamCfg, entries = parseSteamEntries(cfg.accounts), grid = $('#steamGrid');
    if (!entries.length) { grid.innerHTML = '<div class="panel"><p class="muted">No Steam accounts configured.</p></div>'; return; }
    grid.innerHTML = entries.map(e => {
      const c = cfg.cache[e.key] || {};
      const name = c.name || e.label, initial = (name[0] || '?').toUpperCase();
      const url = /^https:\/\/steamcommunity\.com\//i.test(c.url || '') ? c.url : steamFallbackUrl(e);
      const avatar = /^https:\/\//i.test(c.avatar || '')
        ? `<img class="avatar-img" src="${esc(c.avatar)}" alt="" referrerpolicy="no-referrer" loading="lazy" data-fb="${esc(initial)}">`
        : `<div class="avatar">${esc(initial)}</div>`;
      return `<div class="card steam-card">${avatar}<div class="steam-name">${esc(name)}</div>
        <div class="muted">${esc(url.replace(/^https?:\/\//, ''))}</div>
        <a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noopener">View Profile</a></div>`;
    }).join('');
  }
  function cancelSteamEdit() { $('#steamEdit').classList.add('hidden'); }
  $('#editSteamBtn').addEventListener('click', () => {
    $('#steamTitleInput').value = settings.steamTitle; $('#steamEdit').classList.remove('hidden'); $('#steamTitleInput').focus();
  });
  $('#cancelSteam').addEventListener('click', cancelSteamEdit);
  $('#saveSteam').addEventListener('click', () => {
    if (!isAdmin()) return;
    const title = $('#steamTitleInput').value.trim();
    if (!title) return toast('Title cannot be empty.');
    settings.steamTitle = title; save('mway_settings', settings);
    renderSteam(); cancelSteamEdit(); toast('Steam section updated.');
  });
  $('#steamGrid').addEventListener('error', e => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.dataset.fb) {
      const d = document.createElement('div'); d.className = 'avatar'; d.textContent = img.dataset.fb; img.replaceWith(d);
    }
  }, true);

  /* ---------- Network layer: staggered proxy race, hard timeouts, caching ----------
     Browsers cannot call Steam directly (CORS), so every request goes through public CORS proxies.
     Instead of trying proxies one after another (which caused 20 s hangs), a request starts on the
     last proxy that worked and, if it has not answered after a short stagger, the next proxy joins in.
     The first good answer wins and the rest are aborted. The full URL (including the Steam key) is
     always percent-encoded into the proxy URL, so proxies cannot strip it. */
  const PROXIES = [
    { u: 'https://corsproxy.io/?url={url}', post: true },
    { u: 'https://api.allorigins.win/raw?url={url}' },
    { u: 'https://api.codetabs.com/v1/proxy?quest={url}' },
    { u: 'https://api.allorigins.win/get?url={url}', wrap: true },
    { u: 'https://thingproxy.freeboard.io/fetch/{raw}', post: true }
  ];
  let proxyPref = 0; const rlMap = {};
  const netErr = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

  /* Cloudflare Worker bridge (worker.js). Hosts the Worker will forward (mirrors UPSTREAM_ALLOW in worker.js). */
  const BRIDGE_HOSTS = ['api.steampowered.com', 'steamcommunity.com', 'api-public.cs-prod.leetify.com', 'csfloat.com', 'api.csgofloat.com', 'prices.csgotrader.app', 'open.faceit.com'];
  const normBridge = raw => {
    let u = String(raw || '').trim().replace(/^["'<\s]+|["'>\s]+$/g, '');
    if (!u) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u) ? 'http://' : 'https://') + u.replace(/^\/+/, '');
    u = u.replace(/^(https?:\/\/[^\/?#\s]+).*$/i, '$1').replace(/\/+$/, '');
    return /^https:\/\/[^\s/]+\.[^\s/]+$/i.test(u) || /^https:\/\/localhost(:\d+)?$/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(u) ? u : '';
  };
  const bridgeUrl = () => normBridge(settings.steamCfg && settings.steamCfg.bridge) || normBridge(BRIDGE_CONFIG.url);
  const bridgeCan = url => { if (!bridgeUrl()) return false; try { const u = new URL(url); return u.protocol === 'https:' && BRIDGE_HOSTS.includes(u.hostname); } catch { return false; } };
  let bridgeCaps = null, bridgeErr = '', bridgeProbeP = null, bridgeProbeAt = 0;
  const bridgeHoldsKey = () => !!(bridgeCaps && bridgeCaps.steamKey && bridgeCaps.url === bridgeUrl());
  const routeName = p => {
    if (p.bridge) return 'bridge'; if (p.direct) return 'direct';
    try { return new URL(String(p.u).replace('{url}', 'x').replace('{raw}', 'x')).hostname; } catch { return 'proxy'; }
  };

  /* GET /health on the Worker: learns whether it holds STEAM_API_KEY / KV. Cached; a failed check is retried after 60 s. */
  function probeBridge(force) {
    const b = bridgeUrl();
    if (!b) { bridgeCaps = null; bridgeErr = ''; bridgeProbeP = null; diagBadge(); return Promise.resolve(null); }
    if (!force && bridgeProbeP && bridgeProbeP.b === b && (bridgeCaps || Date.now() - bridgeProbeAt < 60000)) return bridgeProbeP;
    const t0 = performance.now(); bridgeProbeAt = Date.now();
    const p = fetchText(b + '/health', {}, 8000).then(res => {
      let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
      if (res.status === 200 && j && j.ok) {
        bridgeCaps = { url: b, steamKey: !!j.steamKey, csfloatKey: !!j.csfloatKey, csfloatPrices: !!j.csfloatPrices, csfloatPricesAt: Number(j.csfloatPricesAt) || 0, leetifyKey: !!j.leetifyKey, faceitKey: !!j.faceitKey, kv: !!j.kv, adminToken: !!j.adminToken, v: j.v || 1, colo: j.colo || '' };
        bridgeErr = '';
        diag('ok', 'bridge', 'health OK (v' + bridgeCaps.v + ', Steam key on bridge: ' + (bridgeCaps.steamKey ? 'yes' : 'no') + ', KV: ' + (bridgeCaps.kv ? 'yes' : 'no') + ')', performance.now() - t0);
        diagBadge(); return bridgeCaps;
      }
      throw new Error(res.status === 403 ? 'the Worker refused this origin (add it to ALLOWED_ORIGINS)' : 'unexpected answer from ' + shortUrl(b) + ' (HTTP ' + res.status + '). Is this the Worker URL?');
    }).catch(e => {
      bridgeCaps = null;
      bridgeErr = e && e.name === 'AbortError' ? 'timed out after 8 s'
        : e instanceof TypeError ? 'could not reach the bridge (wrong URL, Worker not deployed, or this site origin is missing from ALLOWED_ORIGINS)'
        : (e && e.message) || 'unknown error';
      diag('error', 'bridge', 'health failed: ' + bridgeErr, performance.now() - t0);
      diagBadge(); throw new Error(bridgeErr);
    });
    p.b = b; bridgeProbeP = p; p.catch(() => {});
    return p;
  }

  /* Routes without the bridge: the custom proxy if set, otherwise the built-in public proxies. */
  const legacyList = () => {
    const c = settings.steamCfg.proxy;
    if (c) return [{ u: c, post: true }];
    return PROXIES.map((_, i) => PROXIES[(i + proxyPref) % PROXIES.length]);
  };
  /* Routes for a request: the bridge first (when configured and it forwards that host), public proxies only if bridge-only is off. */
  const proxyList = url => {
    const b = bridgeUrl();
    if (!b || (url && !bridgeCan(url))) return legacyList();
    const out = [{ u: b + '/fetch?url={url}', post: true, bridge: true }];
    if (!settings.steamCfg.bridgeOnly) out.push(...legacyList());
    return out;
  };
  const routeUrl = (p, url) => {
    const t = p.u;
    return t.includes('{raw}') ? t.replace('{raw}', url) : t.includes('{url}') ? t.replace('{url}', encodeURIComponent(url)) : t + encodeURIComponent(url);
  };
  const AUTH_MSG = 'Steam rejected the request (HTTP 401/403). Check the Steam Web API key saved in Admin. A proxy that blocks the call looks the same, so try again or enter your own proxy.';

  async function fetchText(url, opts, ms, outer) {
    const ac = new AbortController(), kill = () => ac.abort(), to = setTimeout(kill, ms);
    if (outer) { if (outer.aborted) kill(); else outer.addEventListener('abort', kill, { once: true }); }
    try {
      const r = await fetch(url, Object.assign({ cache: 'no-store', signal: ac.signal }, opts));
      return { status: r.status, text: await r.text(), upstream: r.headers.get('X-Upstream-Status'), retryAfter: r.headers.get('Retry-After'), stale: r.headers.get('X-Mway-Stale') === '1', cachedAt: r.headers.get('X-Mway-Cached-At') };
    } finally { clearTimeout(to); if (outer) outer.removeEventListener('abort', kill); }
  }

  /* Run `run(route, signal)` over routes with a stagger; resolves with the first success, rejects with an array of errors. */
  function raceRoutes(routes, run, o = {}) {
    const stagger = o.stagger || 2200, total = o.total || 12000;
    return new Promise((resolve, reject) => {
      const ac = new AbortController(), errs = [];
      let started = 0, settled = 0, done = false, st = null;
      const end = (ok, v) => { if (done) return; done = true; clearTimeout(st); clearTimeout(tt); ac.abort(); ok ? resolve(v) : reject(v); };
      const tt = setTimeout(() => end(false, errs.concat(netErr('NET', 'timed out'))), total);
      const next = () => {
        clearTimeout(st);
        if (done || started >= routes.length) return;
        const rt = routes[started++];
        Promise.resolve().then(() => run(rt, ac.signal)).then(v => end(true, v), e => {
          errs.push(e); settled++;
          if (settled >= routes.length) end(false, errs); else next();
        });
        st = setTimeout(next, stagger);
      };
      if (!routes.length) return end(false, [netErr('NET', 'no route available')]);
      next();
    });
  }
  function summarize(errs, authMsg) {
    errs = (Array.isArray(errs) ? errs : [errs]).filter(Boolean);
    if (errs.some(e => e.code === 'RATE')) {
      const ra = Math.max(0, ...errs.filter(e => e.code === 'RATE').map(e => e.retryAfter || 0));
      return netErr('RATE', 'Steam is rate limiting this connection. Wait about ' + (ra || 30) + ' seconds and try again.', { retryAfter: ra });
    }
    if (errs.some(e => e.code === 'AUTH')) return netErr('AUTH', authMsg || AUTH_MSG);   // at least one route got a 401/403 answer and none succeeded
    return netErr('NET', bridgeUrl() ? 'The bridge did not answer. Check the bridge URL in Admin and run the Diagnostics Logger.' : 'Every proxy timed out or was unreachable. Try again in a moment, or enter your own proxy in Admin.');
  }

  const memCache = new Map(), inFlight = new Map();
  /* GET (or POST) through the proxy chain. Options: json, ttl, direct (try without proxy first), headers, method, body,
     timeout, total, definitive(status, text) -> accept this non-2xx answer as final, check(json), authMsg, steamApi. */
  function proxyReq(url, o = {}) {
    const ttl = o.ttl || 0, plain = !o.method || o.method === 'GET';
    const ck = plain ? url + (o.headers ? '|' + JSON.stringify(o.headers) : '') : '';
    if (ck && ttl) { const h = memCache.get(ck); if (h && Date.now() - h.t < ttl) return Promise.resolve(h.v); }
    if (ck && inFlight.has(ck)) return inFlight.get(ck);
    const defin = o.definitive || (s => s === 404);
    const run0 = async (rt, sig) => {
      let res;
      try {
        res = await fetchText(rt.direct ? url : routeUrl(rt, url), { method: o.method, headers: o.headers, body: o.body }, o.timeout || 8000, sig);
      } catch (e) { throw e && e.code ? e : netErr('NET', e && e.name === 'AbortError' ? 'timed out' : 'network error'); }
      let { status, text } = res;
      if (rt.bridge && !res.upstream && status >= 400) {   // the Worker itself answered (not Steam): a configuration problem, not an upstream answer
        let m = ''; try { m = JSON.parse(text).error || ''; } catch { /* not JSON */ }
        throw netErr('NET', 'Worker refused the request: ' + (m || 'HTTP ' + status), { status });
      }
      if (rt.wrap) {
        try { const w = JSON.parse(text); status = (w.status && w.status.http_code) || status; text = typeof w.contents === 'string' ? w.contents : ''; }
        catch { throw netErr('NET', 'unreadable proxy wrapper'); }
      }
      if (!defin(status, text)) {
        if (status === 401 || status === 403) throw netErr('AUTH', 'HTTP ' + status, { status });
        if (status === 429) throw netErr('RATE', 'HTTP 429', { status, retryAfter: parseInt(res.retryAfter, 10) || 0 });
        if (status < 200 || status >= 300) throw netErr('NET', 'HTTP ' + status, { status });
      }
      let json = null;
      if (o.json && status >= 200 && status < 300) {
        try { json = JSON.parse(text); } catch { throw netErr('NET', 'unreadable response'); }
        if (o.check && !o.check(json)) throw netErr('NET', 'unexpected response');
      }
      return { status, text, json, via: rt, stale: res.stale ? (Number(res.cachedAt) || Date.now()) : 0 };
    };
    const run = async (rt, sig) => {
      const t0 = performance.now(), nm = routeName(rt), cat = rt.bridge ? 'bridge' : 'proxy';
      try {
        const r = await run0(rt, sig);
        diag('ok', cat, nm + ' -> ' + shortUrl(url) + ' HTTP ' + r.status, performance.now() - t0, 'ok|' + nm + '|' + shortUrl(url));
        return r;
      } catch (e) {
        if (!sig.aborted) diag('warn', cat, nm + ' -> ' + shortUrl(url) + ' failed: ' + e.message, performance.now() - t0);
        throw e;
      }
    };
    const p = (async () => {
      const rlk = o.steamApi ? (o.rl || 'api') : '';
      if (rlk && Date.now() < (rlMap[rlk] || 0)) { const left = Math.ceil((rlMap[rlk] - Date.now()) / 1000); throw netErr('RATE', 'Steam is rate limiting this connection. Wait about ' + left + ' seconds and try again.', { retryAfter: left }); }
      const routes = (o.direct ? [{ direct: true }] : []).concat(o.legacy ? legacyList() : proxyList(url));
      try {
        const r = await raceRoutes(routes, run, { stagger: o.stagger || 2200, total: o.total || 12000 });
        if (r.via && !r.via.direct && !settings.steamCfg.proxy) { const i = PROXIES.indexOf(r.via); if (i >= 0) proxyPref = i; }
        if (plain && ttl) memCache.set(ck, { t: Date.now(), v: r });
        return r;
      } catch (errs) {
        const e = summarize(errs, o.authMsg);
        diag('error', 'net', 'all routes failed for ' + shortUrl(url) + ' [' + e.code + '] ' + e.message);
        if (e.code === 'RATE' && o.steamApi) rlMap[o.rl || 'api'] = Date.now() + Math.min(90000, Math.max(30000, (e.retryAfter || 0) * 1000));
        throw e;
      }
    })();
    if (ck) { inFlight.set(ck, p); p.finally(() => inFlight.delete(ck)).catch(() => {}); }
    return p;
  }

  async function steamApi(path, params, o = {}) {
    const cfg = settings.steamCfg;
    if (bridgeUrl() && !bridgeCaps) { try { await probeBridge(); } catch { /* offline bridge: fall back to the local key check below */ } }
    const local = /^[A-Fa-f0-9]{32}$/.test(cfg.key || '');
    if (!local && !bridgeHoldsKey()) throw netErr('KEY', 'No valid Steam Web API key is saved in Admin (and the bridge does not hold one).');
    const q = new URLSearchParams(params || {});
    if (local && !bridgeHoldsKey()) q.append('key', cfg.key);   // when the bridge holds STEAM_API_KEY the browser key is never sent
    const r = await proxyReq(`https://api.steampowered.com/${path}/?${q}`, {
      json: true, steamApi: true, ttl: o.ttl == null ? 120000 : o.ttl, timeout: 7000, total: 11000,
      definitive: o.definitive,
      check: j => !!j && typeof j === 'object'
    });
    return r.json;
  }
  /* Admin > CSFloat "Re-test key": saves what is in the form, clears every cached CSFloat price, validates the key against CSFloat, and re-prices an open inventory. */
  async function csfloatTest() {
    const out = $('#stFloatStatus'), btn = $('#stFloatTest');
    const say = (m, bad) => { out.textContent = m; out.style.color = bad ? 'var(--danger)' : ''; };
    readSteamInputs();
    if (bridgeUrl() && !bridgeCaps) { try { await probeBridge(); } catch { /* offline bridge: reported below if it matters */ } }
    const k = floatKey();
    if (!k && !hasFloat()) return say('Enter a CSFloat API key first (or set CSFLOAT_API_KEY on the Worker).', true);
    btn.disabled = true; say('Testing the CSFloat key...');
    csfBulkData = null; csfBulkAt = 0;
    [...memCache.keys()].forEach(x => { if (x.includes('csfloat.com')) memCache.delete(x); });
    Object.keys(px).forEach(n => { const c = pxNorm(px[n]); delete c.csf; delete c.tc; px[n] = c; });
    pxSave();
    const t0 = performance.now();
    try {
      let r = await floatReq('https://csfloat.com/api/v1/me', { ttl: 0, timeout: 9000, total: 12000 });
      if (r.status === 404) r = await floatReq('https://csfloat.com/api/v1/listings?limit=1', { ttl: 0, timeout: 9000, total: 12000 });
      const u = r.json && (r.json.user || r.json), name = u && typeof u === 'object' && !Array.isArray(u) ? (u.username || u.steam_id || '') : '';
      diag('ok', 'app', 'CSFloat key test passed', performance.now() - t0);
      say('CSFloat key is valid' + (name ? ' (account: ' + name + ')' : '') + (k ? '' : ' (using the key stored on the Worker)') + '. Cached CSFloat prices were cleared; the next price load uses this key.');
      toast('CSFloat key works.');
      if (lkv && lkv.inv && lkv.inv.state === 'ok' && !lkv.inv.pricing) { lkv.inv.pricing = true; lkv.inv.partial = false; updInv(); invPrice(lkv).catch(() => {}); }
    } catch (e) {
      diag('error', 'app', 'CSFloat key test failed [' + (e.code || 'ERR') + ']: ' + e.message, performance.now() - t0);
      say(e.code === 'AUTH' ? 'CSFloat rejected this key (HTTP 401/403). Copy a fresh key from your CSFloat profile (Developers tab) and test again.'
        : e.code === 'RATE' ? 'CSFloat is rate limiting requests. Wait a minute and test again.'
        : 'Could not reach CSFloat: ' + e.message + (bridgeUrl() ? ' Run the Diagnostics Logger to check the bridge.' : ''), true);
    } finally { btn.disabled = false; }
  }
  const faceitKey = () => (settings.steamCfg.faceitKey || '').trim();
  const faceitOnBridge = () => !!(bridgeCaps && bridgeCaps.faceitKey && bridgeCaps.url === bridgeUrl());
  /* Admin > FACEIT "Test FACEIT Key": saves the form, then calls GET open.faceit.com/data/v4/players?game=cs2&game_player_id=<id>.
     200 = key works and the player has a FACEIT profile; 404 = key accepted but this Steam account has no FACEIT profile; 401/403 = key rejected. */
  async function faceitTest() {
    const out = $('#stFaceitStatus'), btn = $('#stFaceitTest');
    const say = (m, bad) => { out.textContent = m; out.style.color = bad ? 'var(--danger)' : ''; };
    readSteamInputs();
    if (bridgeUrl() && !bridgeCaps) { try { await probeBridge(); } catch { /* offline bridge: reported below if it matters */ } }
    const k = faceitKey(), nm = (settings.steamCfg.faceitKeyName || '').trim();
    if (!k && !faceitOnBridge()) return say('Enter a FACEIT API key first (or set FACEIT_API_KEY on the Worker).', true);
    btn.disabled = true; say('Testing the FACEIT key...');
    const t0 = performance.now(), label = nm ? 'FACEIT key "' + nm + '"' : 'FACEIT key';
    try {
      const r = await proxyReq('https://open.faceit.com/data/v4/players?game=cs2&game_player_id=' + ADMIN_STEAM_IDS[0], {
        json: true, direct: !!k, headers: k ? { Authorization: 'Bearer ' + k } : undefined, ttl: 0, timeout: 9000, total: 13000
      });
      const g = r.json && r.json.games && (r.json.games.cs2 || r.json.games.csgo);
      diag('ok', 'app', 'FACEIT key test passed (HTTP ' + r.status + ')', performance.now() - t0);
      say(label + ' works: FACEIT API reachable (HTTP ' + r.status + ')' + (r.status === 404 ? ', the test Steam account simply has no FACEIT profile' : g && g.skill_level ? ', test player ' + (r.json.nickname || '') + ' is level ' + g.skill_level + (g.faceit_elo ? ' / ' + g.faceit_elo + ' ELO' : '') : '') + (k ? '' : ' (using the key stored on the Worker)') + '.');
      toast('FACEIT key works.');
      if (lkv) { Object.keys(lkCache).forEach(x => delete lkCache[x]); }   // the next lookup re-reads FACEIT with this key
    } catch (e) {
      diag('error', 'app', 'FACEIT key test failed [' + (e.code || 'ERR') + ']: ' + e.message, performance.now() - t0);
      say(e.code === 'AUTH' ? 'FACEIT rejected this key (HTTP 401/403). Create a server-side key in the FACEIT developer portal (Data API) and test again.'
        : e.code === 'RATE' ? 'FACEIT is rate limiting requests. Wait a minute and test again.'
        : 'Could not reach FACEIT: ' + e.message + (bridgeUrl() ? ' Run the Diagnostics Logger to check the bridge.' : ''), true);
    } finally { btn.disabled = false; }
  }
  function readSteamInputs() {
    const cfg = settings.steamCfg;
    const keysBefore = { steam: cfg.key, csfloat: cfg.floatKey, leetify: cfg.leetifyKey, faceit: cfg.faceitKey};
    cfg.key = $('#stKey').value.trim(); cfg.proxy = $('#stProxy').value.trim(); cfg.accounts = $('#stIds').value;
    cfg.bridge = normBridge($('#stBridge').value) || $('#stBridge').value.trim().replace(/\/+$/, ''); cfg.bridgeOnly = $('#stBridgeOnly').checked;
    cfg.faceitKey = $('#stFaceit').value.trim();
    if ($('#stFaceitName')) cfg.faceitKeyName = $('#stFaceitName').value.trim();
    cfg.floatKey = $('#stFloat').value.trim(); cfg.hltvKey = $('#stHltvKey').value.trim(); cfg.hltvUrl = $('#stHltvUrl').value.trim(); cfg.leetifyKey = $('#stLeetify').value.trim();
    save('mway_settings', settings);
    keysAfterRead(keysBefore);
  }
  const stStatus = (msg, bad) => { const s = $('#stStatus'); s.textContent = msg; s.style.color = bad ? 'var(--danger)' : ''; };

  async function syncSteam() {
    readSteamInputs();
    const cfg = settings.steamCfg, entries = parseSteamEntries(cfg.accounts);
    if (bridgeUrl() && !bridgeCaps) { try { await probeBridge(); } catch { /* reported by the key check below */ } }
    if (!/^[A-Fa-f0-9]{32}$/.test(cfg.key) && !bridgeHoldsKey()) return stStatus('Enter a valid 32-character Steam Web API key, or point the bridge URL at a Worker that holds STEAM_API_KEY.', true);
    if (!entries.length) return stStatus('Add at least one SteamID64, vanity name or profile URL.', true);
    if (cfg.proxy && !/^https:\/\//i.test(cfg.proxy)) return stStatus('The proxy must start with https://', true);
    const btn = $('#stSync'); btn.disabled = true; stStatus('Syncing profiles...');
    try {
      const idByKey = {}, failed = [];
      for (const e of entries) {
        if (e.id) { idByKey[e.key] = e.id; continue; }
        const r = await steamApi('ISteamUser/ResolveVanityURL/v1', { vanityurl: e.vanity });
        if (r.response && r.response.success === 1) idByKey[e.key] = r.response.steamid; else failed.push(e.label);
      }
      const ids = [...new Set(Object.values(idByKey))];
      if (!ids.length) throw new Error('None of the entries could be resolved to a SteamID.');
      const out = await steamApi('ISteamUser/GetPlayerSummaries/v2', { steamids: ids.join(',') });
      const byId = {}; ((out.response && out.response.players) || []).forEach(p => { byId[p.steamid] = p; });
      const now = new Date().toISOString();
      let ok = 0;
      entries.forEach(e => {
        const p = byId[idByKey[e.key]];
        if (p) { cfg.cache[e.key] = { id: p.steamid, name: p.personaname, avatar: p.avatarfull || p.avatarmedium || p.avatar || '', url: p.profileurl, ts: now }; ok++; }
        else failed.push(e.label);
      });
      cfg.last = now; save('mway_settings', settings); renderSteam();
      stStatus(`Synced ${ok} of ${entries.length} profile(s) at ${fmtTime(now)}.` + (failed.length ? ` Not found: ${[...new Set(failed)].join(', ')}.` : ''), ok === 0);
      if (ok) toast('Steam profiles updated.');
    } catch (err) {
      stStatus(err instanceof TypeError
        ? 'Every CORS proxy failed or the network is unreachable. Try again shortly, or enter your own proxy.'
        : err.message, true);
    } finally { btn.disabled = false; }
  }
  /* After saving: validate the bridge URL and ask the Worker what it can do. */
  function bridgeAfterSave() {
    const cfg = settings.steamCfg;
    if (cfg.bridge && !bridgeUrl()) { diagBadge(); return stStatus('Saved, but the bridge URL must start with https://', true); }
    if (!bridgeUrl()) { bridgeCaps = null; bridgeErr = ''; diagBadge(); return; }
    stStatus('Settings saved. Checking the bridge...');
    return probeBridge(true).then(
      c => stStatus('Settings saved. Bridge online' + (c.steamKey ? ' and holds the Steam API key.' : ' (no STEAM_API_KEY on the bridge, the key saved here is used).')),
      () => stStatus('Settings saved, but the bridge check failed: ' + bridgeErr, true));
  }
  $('#stSave').addEventListener('click', () => { readSteamInputs(); renderSteam(); stStatus('Settings saved.'); bridgeAfterSave(); });
  $('#stFloatTest').addEventListener('click', csfloatTest);
  $('#stFaceitTest').addEventListener('click', faceitTest);
  $('#stBridgeTest').addEventListener('click', () => { readSteamInputs(); bridgeAfterSave(); });
  $('#stSync').addEventListener('click', syncSteam);
  $('#stKeyShow').addEventListener('click', e => {
    const i = $('#stKey'), show = i.type === 'password'; i.type = show ? 'text' : 'password'; e.currentTarget.textContent = show ? 'Hide' : 'Show';
  });
  $$('[data-reveal]').forEach(b => b.addEventListener('click', () => {
    const i = $(b.dataset.reveal), show = i.type === 'password'; i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show';
  }));

  /* =====================================================================
     9. ADMIN TAB: users, one-time passwords, nav labels
     ===================================================================== */
  function renderUsers() {
    $('#umBody').innerHTML = [`<tr><td>${MASTER}</td><td>master</td><td class="mono">(protected)</td><td class="mono">-</td><td></td></tr>`].concat(users.map(u =>
      `<tr><td>${esc(u.u)}</td><td>${esc(u.role)}${u.otp ? ' <span class="badge">TEMP PW</span>' : ''}</td>
      <td class="mono" title="${esc(u.h)}">${esc((u.h || '').slice(0, 20))}...</td><td class="mono">${esc(u.created.slice(0, 10))}</td>
      <td class="act"><button class="btn btn-small" data-reset="${esc(u.u)}">Reset Password</button><button class="btn btn-small btn-danger" data-del="${esc(u.u)}">Delete</button></td></tr>`)).join('');
  }

  /* One-time read vault: the secret lives only in this closure variable and one DOM node */
  let otpSecret = null;
  function wipeOtp(msg) {
    otpSecret = null;
    const s = $('#otpSecret'), u = $('#otpUser'), box = $('#otpVault');
    if (s) s.textContent = ''; if (u) u.textContent = ''; if (box) box.classList.add('hidden');
    if (msg) toast(msg);
  }
  function confirmReset(uname) {
    openModal(`<h3>Reset Password</h3><p>Reset the password for "${esc(uname)}"? Their current password stops working immediately and the new one-time password will be shown once.</p>
      <div class="row"><button class="btn btn-small" id="rc">Cancel</button><button class="btn btn-small btn-danger" id="rg">Reset</button></div>`);
    $('#rc').onclick = closeModal;
    $('#rg').onclick = async () => { closeModal(); await resetPassword(uname); };
  }
  async function resetPassword(uname) {
    const acc = users.find(x => x.u === uname); if (!acc) return;
    wipeOtp();
    acc.h = '';                       // clear the current hash first
    const pw = genPassword(20);
    acc.s = makeSalt(); acc.h = await hash(pw, acc.s);
    acc.otp = true; acc.resetAt = new Date().toISOString();
    save('mway_users', users); renderUsers();
    otpSecret = pw;
    $('#otpUser').textContent = 'Account: ' + acc.u;
    $('#otpSecret').textContent = pw;
    const box = $('#otpVault'); box.classList.remove('hidden');
    box.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    toast('Password cleared. Copy the one-time password now.');
  }
  $('#otpCopy').addEventListener('click', async () => {
    if (!otpSecret) return;
    if (await copyText(otpSecret)) wipeOtp('Copied. The secret has been wiped from the screen.');
    else toast('Copy failed. Select the text manually, then dismiss.');
  });
  $('#otpDismiss').addEventListener('click', () => wipeOtp('Secret wiped.'));
  window.addEventListener('pagehide', () => wipeOtp());

  /* Navigation renaming center (HOME is hard-locked and never touched) */
  const NAV_INPUTS = { roadmap: '#nlRoadmap', tab3: '#nlTab3' };
  function renderNavInputs() { Object.keys(NAV_INPUTS).forEach(k => { $(NAV_INPUTS[k]).value = settings.navLabels[k]; }); }
  $('#saveNav').addEventListener('click', () => {
    const vals = {}; Object.keys(NAV_INPUTS).forEach(k => { vals[k] = $(NAV_INPUTS[k]).value.trim(); });
    if (Object.values(vals).some(v => !v || v.length > 20)) return toast('Each label must be 1-20 characters.');
    settings.navLabels = vals; save('mway_settings', settings); applySettings(); toast('Navigation labels updated.');
  });
  $('#resetNav').addEventListener('click', () => {
    settings.navLabels = Object.assign({}, DS.navLabels); save('mway_settings', settings); renderNavInputs(); applySettings(); toast('Navigation labels restored.');
  });

  function renderAdmin() {
    $('#discordInput').value = settings.discord;
    $$('[data-tabkey]').forEach(c => c.checked = settings.tabs[c.dataset.tabkey]);
    renderNavInputs();
    $('#stKey').value = settings.steamCfg.key; $('#stProxy').value = settings.steamCfg.proxy; $('#stIds').value = settings.steamCfg.accounts;
    $('#stBridge').value = normBridge(settings.steamCfg.bridge) || settings.steamCfg.bridge || ''; $('#stBridgeOnly').checked = settings.steamCfg.bridgeOnly !== false;
    const fcg = settings.steamCfg;
    if (isAdmin() && !fcg.faceitSeeded) {   // one-time pre-configuration of the FACEIT key (an admin who clears the field later keeps it empty)
      if (!fcg.faceitKeyName) fcg.faceitKeyName = FACEIT_DEFAULT.name;
      if (!fcg.faceitKey) fcg.faceitKey = FACEIT_DEFAULT.key;
      fcg.faceitSeeded = true; save('mway_settings', settings); keysAfterRead({ faceit: '' });
    }
    if ($('#stFaceitName')) $('#stFaceitName').value = fcg.faceitKeyName || FACEIT_DEFAULT.name;
    $('#stFaceit').value = fcg.faceitKey || ''; $('#gsToken').value = gsStored(); gsStatus(GS.msg || gsIdleMsg(), GS.bad);
    $('#stFloat').value = settings.steamCfg.floatKey || ''; $('#stHltvKey').value = settings.steamCfg.hltvKey || ''; $('#stHltvUrl').value = settings.steamCfg.hltvUrl || ''; $('#stLeetify').value = settings.steamCfg.leetifyKey || '';
    stStatus(settings.steamCfg.last ? 'Last sync: ' + fmtTime(settings.steamCfg.last) : 'Not synced yet. Showing profile links only.');
    renderUsers(); renderMailing(); renderRmRows(); diagBadge();
  }

  $('#saveDiscord').addEventListener('click', () => {
    const v = $('#discordInput').value.trim();
    if (!/^https?:\/\/\S+$/i.test(v)) return toast('Enter a valid http(s) URL.');
    settings.discord = v; save('mway_settings', settings); applySettings(); toast('Discord link updated.');
  });
  $('#cvToggle').addEventListener('change', e => { if (!isAdmin()) return; settings.cvVisible = e.target.checked; save('mway_settings', settings); applySettings(); });
  $$('[data-tabkey]').forEach(c => c.addEventListener('change', () => {
    settings.tabs[c.dataset.tabkey] = c.checked; save('mway_settings', settings); applySettings();
  }));

  $('#umGen').addEventListener('click', () => { $('#umPw').value = genPassword(); });
  $('#umCreate').addEventListener('click', async () => {
    const u = $('#umName').value.trim(), p = $('#umPw').value, err = $('#umErr');
    err.textContent = '';
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(u)) return err.textContent = 'Username: 3-24 chars (letters, numbers, _ . -).';
    if (u.toLowerCase() === MASTER || users.some(x => x.u.toLowerCase() === u.toLowerCase())) return err.textContent = 'Username already exists.';
    if (p.length < 6) return err.textContent = 'Password must be at least 6 characters.';
    const s = makeSalt();
    users.push({ u, s, h: await hash(p, s), role: $('#umRole').value, created: new Date().toISOString() });
    save('mway_users', users); renderUsers();
    $('#umName').value = ''; $('#umPw').value = '';
    alertModal('Account Created', `User "${u}" created. Password (shown once, not stored in plain text): ${p}`);
  });
  $('#umBody').addEventListener('click', e => {
    const r = e.target.closest('[data-reset]');
    if (r) return confirmReset(r.dataset.reset);
    const b = e.target.closest('[data-del]'); if (!b) return;
    users = users.filter(x => x.u !== b.dataset.del); save('mway_users', users); wipeOtp(); renderUsers(); toast('Account deleted.');
  });

  /* =====================================================================
     10. ROADMAP: full page, home widget, admin editor
     ===================================================================== */
  function rmStats() {
    const n = roadmap.length, done = roadmap.filter(m => m.status === 'done').length, act = roadmap.filter(m => m.status === 'active').length;
    return { n, done, pct: n ? Math.round(Math.min(n, done + act * 0.5) / n * 100) : 0 };
  }
  function rmTrackHTML(mini) {
    return `<div class="rm-track${mini ? ' mini' : ''}" style="--n:${roadmap.length}">${roadmap.map((m, i) => `
      <div class="rm-item ${m.status}">
        <div class="rm-node">${m.status === 'done' ? '&#10003;' : mini ? '' : i + 1}</div>
        <div class="rm-name">${esc(m.name)}</div>
        ${mini ? '' : `<div class="rm-status">${RM_STATUS[m.status]}</div><div class="rm-desc">${esc(m.desc)}</div>`}
      </div>`).join('')}</div>`;
  }
  let rmFilter = 'all';
  function rmPageHTML() {
    const s = rmStats(), act = roadmap.find(m => m.status === 'active'), C = 2 * Math.PI * 52, cnt = k => roadmap.filter(m => m.status === k).length;
    const heroT = act ? 'Now building: ' + act.name : s.done === s.n ? 'Every milestone reached' : 'Up next', heroD = act ? act.desc : (roadmap.find(m => m.status === 'planned') || {}).desc || 'The roadmap is complete.';
    const rows = roadmap.map((m, i) => ({ m, i })).filter(x => rmFilter === 'all' || x.m.status === rmFilter);
    return `<div class="rmx-hero">
        <div class="rmx-ringwrap"><svg viewBox="0 0 120 120" class="rmx-ring" aria-hidden="true"><circle cx="60" cy="60" r="52" class="t"/><circle cx="60" cy="60" r="52" class="f" style="stroke-dasharray:${(C * s.pct / 100).toFixed(1)} ${C.toFixed(1)}"/></svg><div class="rmx-pct"><b>${s.pct}</b><span>%</span></div></div>
        <div class="rmx-hinfo"><span class="rmx-eyebrow">MISSION PROGRESS</span><h3>${esc(heroT)}</h3><p class="muted">${esc(heroD)}</p>
          <div class="rmx-stats"><span class="done"><b>${cnt('done')}</b> reached</span><span class="active"><b>${cnt('active')}</b> in progress</span><span class="planned"><b>${cnt('planned')}</b> planned</span></div></div>
      </div>
      <div class="rmx-filter" role="group" aria-label="Filter milestones">${[['all', 'All'], ['done', 'Reached'], ['active', 'In progress'], ['planned', 'Planned']].map(([k, n]) => `<button type="button" class="rmx-chip${rmFilter === k ? ' on' : ''}" data-rmf="${k}" aria-pressed="${rmFilter === k}">${n}</button>`).join('')}</div>
      <ol class="rmx-tl">${rows.length ? rows.map(({ m, i }, k) => `<li class="rmx-step ${m.status} ${k % 2 ? 'r' : 'l'}" style="--d:${k * 80}ms">
        <span class="rmx-node" aria-hidden="true">${m.status === 'done' ? '&#10003;' : m.status === 'active' ? '&#9889;' : i + 1}</span>
        <div class="rmx-card"><div class="rmx-top"><span class="rmx-no">PHASE ${String(i + 1).padStart(2, '0')}</span><span class="rmx-pill">${RM_STATUS[m.status]}</span></div>
          <h4>${esc(m.name)}</h4>${m.desc ? `<p>${esc(m.desc)}</p>` : ''}<div class="rmx-meter"><i></i></div></div></li>`).join('') : '<li class="muted rmx-empty">Nothing in this filter yet.</li>'}</ol>`;
  }
  $('#rmMain').addEventListener('click', e => { const b = e.target.closest('[data-rmf]'); if (b) { rmFilter = b.dataset.rmf; renderRoadmap(); } });
  function renderRoadmap() {
    const a = isAdmin(), s = rmStats(), on = settings.roadmapVisible;
    const head = `<div class="rm-summary"><span class="rm-pct">${s.pct}%</span><span class="muted">${s.done} of ${s.n} milestones reached</span></div>
      <div class="rm-bar" role="progressbar" aria-label="Roadmap progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s.pct}"><div class="rm-fill" style="width:${s.pct}%"></div></div>`;
    $('#rmMain').innerHTML = s.n ? rmPageHTML() : '<div class="panel"><p class="muted">No milestones yet.</p></div>';
    $('#roadmapWidget').innerHTML = s.n ? head + rmTrackHTML(true) + '<div class="rm-link">VIEW FULL ROADMAP &rarr;</div>' : '<p class="muted">No milestones yet.</p>';
    const sec = $('#roadmapSection');
    sec.classList.toggle('hidden', !on && !a); sec.classList.toggle('faded', !on);
    $('#roadmapToggle').checked = on;
  }
  function openRoadmap() {
    if (!isAdmin() && !settings.tabs.roadmap) return toast('The roadmap is currently unavailable.');
    showTab('roadmap');
  }
  $('#roadmapWidget').addEventListener('click', openRoadmap);
  $('#roadmapWidget').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRoadmap(); } });
  $('#roadmapToggle').addEventListener('change', e => { settings.roadmapVisible = e.target.checked; save('mway_settings', settings); renderRoadmap(); });

  function renderRmRows() {
    $('#rmRows').innerHTML = roadmap.length ? roadmap.map((m, i) => `
      <div class="rm-row" data-i="${i}">
        <input class="rm-in-name" value="${esc(m.name)}" maxlength="40" aria-label="Milestone name">
        <input class="rm-in-desc" value="${esc(m.desc)}" maxlength="140" placeholder="Description" aria-label="Milestone description">
        <select class="rm-in-status" aria-label="Milestone status">${opts(RM_STATUS, m.status)}</select>
        <div class="rm-ctl">
          <button type="button" class="btn btn-small" data-rmup ${i === 0 ? 'disabled' : ''} aria-label="Move up">&uarr;</button>
          <button type="button" class="btn btn-small" data-rmdn ${i === roadmap.length - 1 ? 'disabled' : ''} aria-label="Move down">&darr;</button>
          <button type="button" class="btn btn-small btn-danger" data-rmdel aria-label="Remove milestone">&times;</button>
        </div>
      </div>`).join('') : '<p class="muted">No milestones. Add one below.</p>';
  }
  const rmSave = () => { save('mway_roadmap', roadmap); renderRoadmap(); };
  $('#rmRows').addEventListener('change', e => {
    const row = e.target.closest('.rm-row'); if (!row || !isAdmin()) return;
    const m = roadmap[+row.dataset.i]; if (!m) return;
    if (e.target.classList.contains('rm-in-name')) {
      const v = e.target.value.trim(); if (!v) { e.target.value = m.name; return toast('Milestone name is required.'); }
      m.name = v;
    } else if (e.target.classList.contains('rm-in-desc')) m.desc = e.target.value.trim();
    else if (e.target.classList.contains('rm-in-status')) m.status = e.target.value;
    rmSave();
  });
  $('#rmRows').addEventListener('click', e => {
    const row = e.target.closest('.rm-row'); if (!row || !isAdmin()) return;
    const i = +row.dataset.i;
    if (e.target.closest('[data-rmdel]')) roadmap.splice(i, 1);
    else if (e.target.closest('[data-rmup]') && i > 0) roadmap.splice(i - 1, 0, roadmap.splice(i, 1)[0]);
    else if (e.target.closest('[data-rmdn]') && i < roadmap.length - 1) roadmap.splice(i + 1, 0, roadmap.splice(i, 1)[0]);
    else return;
    rmSave(); renderRmRows();
  });
  $('#rmAdd').addEventListener('click', () => {
    const name = $('#rmNewName').value.trim();
    if (!name) return toast('Milestone name is required.');
    if (roadmap.length >= 12) return toast('A roadmap can hold up to 12 milestones.');
    roadmap.push({ id: 'm' + Date.now(), name, desc: $('#rmNewDesc').value.trim(), status: $('#rmNewStatus').value });
    $('#rmNewName').value = ''; $('#rmNewDesc').value = '';
    rmSave(); renderRmRows(); toast('Milestone added.');
  });

  /* =====================================================================
     11. MAILING LIST: join modal, admin viewer, CSV export
     ===================================================================== */
  const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
  function mailModal() {
    openModal(`<h3>Join Mailing List</h3><p>Get notified about new tools and releases. No spam.</p>
      <input id="mlEmail" type="email" placeholder="you@example.com" autocomplete="email" maxlength="120" aria-label="Email address">
      <div class="error" id="mlErr"></div>
      <div class="row"><button class="btn btn-small" id="mlCancel">Cancel</button><button class="btn btn-primary btn-small" id="mlGo">Subscribe</button></div>`);
    const go = () => {
      const v = $('#mlEmail').value.trim();
      if (!EMAIL_RE.test(v) || v.length > 120) return $('#mlErr').textContent = 'Enter a valid email address.';
      if (mailing.some(m => m.email.toLowerCase() === v.toLowerCase())) { closeModal(); return toast('You are already on the list.'); }
      mailing.unshift({ email: v, t: new Date().toISOString() });
      save('mway_mailing', mailing); closeModal(); renderMailing(); toast('Subscribed. Thanks for joining!');
    };
    $('#mlGo').onclick = go; $('#mlCancel').onclick = closeModal;
    $('#mlEmail').addEventListener('keydown', e => e.key === 'Enter' && go());
  }
  { const mb = $('#mailBtn'); if (mb) mb.addEventListener('click', mailModal); }   // the header button is now the Steam Group link

  function renderMailing() {
    $('#mlCount').textContent = mailing.length + (mailing.length === 1 ? ' SUBSCRIBER' : ' SUBSCRIBERS');
    $('#mlBody').innerHTML = mailing.length ? mailing.map((m, i) =>
      `<tr><td class="mono">${esc(m.email)}</td><td class="mono">${esc(fmtTime(m.t))}</td><td class="act"><button class="btn btn-small btn-danger" data-mdel="${i}">Remove</button></td></tr>`).join('')
      : '<tr><td colspan="3" class="muted">No sign-ups yet.</td></tr>';
  }
  const csvCell = s => { s = String(s); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }; // neutralise spreadsheet formulas
  $('#mlExport').addEventListener('click', () => {
    if (!isAdmin()) return;
    if (!mailing.length) return toast('The mailing list is empty.');
    const csv = ['email,subscribed_at'].concat(mailing.map(m => csvCell(m.email) + ',' + csvCell(m.t))).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a');
    a.href = url; a.download = `mway-labs-mailing-list-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${mailing.length} address(es).`);
  });
  $('#mlBody').addEventListener('click', e => {
    const b = e.target.closest('[data-mdel]'); if (!b || !isAdmin()) return;
    mailing.splice(+b.dataset.mdel, 1); save('mway_mailing', mailing); renderMailing(); toast('Address removed.');
  });
  $('#mlClear').addEventListener('click', () => {
    if (!mailing.length) return toast('The mailing list is already empty.');
    openModal(`<h3>Clear Mailing List</h3><p>Delete all ${mailing.length} saved address(es)? Export first if you need a copy.</p>
      <div class="row"><button class="btn btn-small" id="mc">Cancel</button><button class="btn btn-small btn-danger" id="my">Clear</button></div>`);
    $('#mc').onclick = closeModal;
    $('#my').onclick = () => { mailing = []; save('mway_mailing', mailing); closeModal(); renderMailing(); toast('Mailing list cleared.'); };
  });

  /* =====================================================================
     12. ATMOSPHERE: cipher decode text, hex ticker, cipher rain
     ===================================================================== */
  const GLYPHS = '01ABCDEF<>/\\|[]{}#$%&*+=?';
  const HEX = '0123456789abcdef';
  const homeActive = () => $('#home').classList.contains('active') && !document.hidden;

  function decode(el, final, ms = 900, done) {
    if (!el) return;
    if (reducedMotion()) { el.textContent = final; return done && done(); }
    const n = final.length, lock = Array.from({ length: n }, (_, i) => 0.12 + 0.78 * (i / n) + Math.random() * 0.1);
    const t0 = performance.now(); let last = 0;
    (function step(now) {
      const p = Math.min(1, (now - t0) / ms);
      if (now - last > 40 || p >= 1) {
        last = now;
        let out = '';
        for (let i = 0; i < n; i++) out += (final[i] === ' ' || p >= lock[i]) ? final[i] : GLYPHS[rnd(GLYPHS.length)];
        el.textContent = p >= 1 ? final : out;
      }
      if (p < 1) requestAnimationFrame(step); else if (done) done();
    })(t0);
  }
  function decryptTitles(pageId) {
    $$('#' + pageId + ' .section-title').forEach(el => { if (el.offsetParent && el.textContent.trim()) decode(el, el.textContent, 650); });
  }
  function introDecode() {
    const h = $('.glitch'); if (!h) return;
    h.classList.add('decoding');
    decode(h, h.dataset.text, 1100, () => h.classList.remove('decoding'));
    decode($('#subText'), settings.subtitle, 1400);
    decryptTitles('home');
  }
  function startAtmosphere() {
    if (reducedMotion()) return;

    // occasional glitch burst on the title
    setInterval(() => {
      const h = $('.glitch'); if (!h || !homeActive() || h.classList.contains('decoding')) return;
      const f = h.dataset.text, idx = [rnd(f.length), rnd(f.length)]; let k = 0;
      const iv = setInterval(() => {
        h.textContent = k++ < 5 ? [...f].map((c, i) => idx.includes(i) && c !== ' ' ? GLYPHS[rnd(GLYPHS.length)] : c).join('') : f;
        if (k > 5) clearInterval(iv);
      }, 55);
    }, 8000);

    // faint falling hex characters behind the hero
    const cv = $('#cipherRain'), ctx = cv.getContext('2d'), fs = 14; let cols = [];
    const size = () => {
      cv.width = Math.max(1, cv.parentElement.clientWidth); cv.height = Math.max(1, cv.parentElement.clientHeight);
      cols = Array.from({ length: Math.ceil(cv.width / fs) }, () => rnd(Math.ceil(cv.height / fs)));
    };
    size();
    setInterval(() => {
      if (!homeActive()) return;
      if (Math.abs(cv.width - cv.parentElement.clientWidth) > 1 || Math.abs(cv.height - cv.parentElement.clientHeight) > 1) size();
      ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,.14)'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#5b8def'; ctx.font = fs + 'px monospace';
      cols.forEach((y, i) => {
        ctx.fillText(HEX[rnd(16)].toUpperCase(), i * fs, y * fs);
        cols[i] = (y * fs > cv.height && Math.random() > 0.975) ? 0 : y + 1;
      });
    }, 70);
  }

  /* =====================================================================
     12c. CS2 CROSSHAIR GENERATOR   (v5: September 2026 "Rush Hour" pixel engine, build 1.41.8.8+)
     - Length / thickness / gap are INTEGER pixels at the 1280x720 reference. The engine scales them linearly with the chosen
       reference height (2 px at 720p = 4 px at 1440p), which mimics CS2's own proportional scaling. At 1280x720 one slider
       step is exactly one pixel on the preview canvas.
     - Console output uses the renamed variables (cl_crosshair_length / _thickness / _gap, cl_crosshaircolor_a,
       cl_crosshair_drawoutline 0/1/2, cl_crosshairoutline_r/g/b/a). The share code is kept, but Valve changed its format again
       on 30 Sep (scope dot values), so treat the console commands as the authoritative output.
     ===================================================================== */
  const XD = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
  const XSTY = ['Dynamic Cross', 'Dynamic Circle', 'Dynamic Cross (Classic)', 'Static Circle', 'Static Cross', 'Dynamic Cross (Shot Feedback)', 'Dot Only', 'Dynamic Quadrant', 'Static Square', 'Static Quadrant'];
  const XLIM = { len: [0, 255], th: [0, 31], gap: [-128, 128] };          // change here if Valve moves a limit (e.g. thickness 32)
  const XRES = [[720, '1280x720'], [1080, '1920x1080'], [1440, '2560x1440'], [2160, '3840x2160']];
  const XBASE = { style: 4, col: '#32fa32', alpha: 1, len: 6, th: 1, gap: 2, ol: 1, olc: '#000000', ola: 1, olw: 1, dot: 0, t: 0, rec: 0, quad: 0.5, res: 720, sh: 1080 };
  const XDEF = [
    { n: 'Classic Green', c: {} },
    { n: 'Cyan Dot Cross', c: { col: '#00ffff', len: 4, gap: 2, ol: 0, dot: 1 } },
    { n: 'Hairline White', c: { col: '#ffffff', len: 3, gap: 0, ol: 2, th: 1, style: 2 } },
    { n: 'Static Quadrant', c: { style: 9, col: '#ffffff', len: 5, gap: 3, th: 2, quad: 0.5 } }
  ];
  const XR = [['len', 'Length (px)', XLIM.len[0], XLIM.len[1], 1], ['th', 'Thickness (px)', XLIM.th[0], XLIM.th[1], 1], ['gap', 'Gap (px)', XLIM.gap[0], XLIM.gap[1], 1]];
  const XFLT = new Set(['alpha', 'ola', 'olw', 'quad']);                    // 0.00 - 1.00 sliders, step 0.01
  let xh = Object.assign({}, XBASE), xhStore = load('mway_xh', {});
  const hx = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) || 0;
  const xi = (v, lo, hi, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const xf = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v * 100) / 100)) : d; };
  /* Clamp to the pixel engine's integer limits and migrate older saved crosshairs (alpha 0-255 -> 0.00-1.00, new fields). */
  function xhNorm(c) {
    const o = Object.assign({}, XBASE, c);
    o.style = xi(o.style, 0, 9, XBASE.style);
    o.len = xi(o.len, XLIM.len[0], XLIM.len[1], XBASE.len); o.th = xi(o.th, XLIM.th[0], XLIM.th[1], XBASE.th); o.gap = xi(o.gap, XLIM.gap[0], XLIM.gap[1], XBASE.gap);
    let a = Number(o.alpha); if (a > 1) a /= 255;
    o.alpha = xf(a, 0, 1, 1); o.ola = xf(o.ola, 0, 1, 1); o.olw = xf(o.olw, 0, 1, 1); o.quad = xf(o.quad, 0, 1, 0.5);
    o.ol = xi(o.ol, 0, 2, 1); o.dot = o.dot ? 1 : 0; o.t = o.t ? 1 : 0; o.rec = o.rec ? 1 : 0;
    o.col = /^#[0-9a-f]{6}$/i.test(o.col) ? o.col : XBASE.col; o.olc = /^#[0-9a-f]{6}$/i.test(o.olc) ? o.olc : XBASE.olc;
    o.res = XRES.some(r => r[0] === Number(o.res)) ? Number(o.res) : 720; o.sh = xi(o.sh, 0, 65535, 1080);
    return o;
  }
  const xhMk = c => xhNorm(Object.assign({}, XBASE, c));
  function xhCode(c) {
    const b = new Array(32).fill(0), cl = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
    b[1] = 1; b[2] = c.sh & 255; b[3] = c.sh >> 8;
    b[4] = c.style | c.rec << 4 | c.dot << 6 | c.t << 7;
    for (let i = 0; i < 3; i++) { b[5 + i] = hx(c.col, i); b[9 + i] = hx(c.olc, i); }
    b[8] = cl(c.alpha * 255, 0, 255); b[12] = 255; b[13] = cl(c.th, 0, 255); b[14] = c.ol;
    b[15] = cl(c.gap, -128, 127) & 255; b[16] = cl(c.len, 0, 255); b[17] = c.spread == null ? 181 : c.spread;
    const f = (c.split == null ? 3 : c.split) | 100 << 7 | 5 << 14;  // split distance, inner alpha 1.0, outer alpha 0.35, size ratio 0
    b[18] = f & 255; b[19] = f >>> 8 & 255; b[20] = f >>> 16 & 255; b[21] = f >>> 24 & 255;
    b[22] = 90;                                                       // scope dot scale 1.0
    b[0] = b.slice(1).reduce((s, x) => s + x, 0) % 256;
    let n = b.reduce((a, x) => a * 256n + BigInt(x), 0n), out = '';
    for (let i = 0; i < 44; i++) { out += XD[Number(n % 57n)]; n /= 57n; }
    return 'CS' + out;
  }
  /* Legacy (pre-22 Sep) variable names -> current ones. null = removed by Valve, no replacement. */
  const XLEG = {
    cl_crosshairsize: 'cl_crosshair_length', cl_crosshairthickness: 'cl_crosshair_thickness', cl_crosshairgap: 'cl_crosshair_gap', cl_crosshairalpha: 'cl_crosshaircolor_a',
    cl_crosshair_outlinecolor_r: 'cl_crosshairoutline_r', cl_crosshair_outlinecolor_g: 'cl_crosshairoutline_g', cl_crosshair_outlinecolor_b: 'cl_crosshairoutline_b', cl_crosshair_outlinecolor_a: 'cl_crosshairoutline_a',
    cl_crosshair_outline_r: 'cl_crosshairoutline_r', cl_crosshair_outline_g: 'cl_crosshairoutline_g', cl_crosshair_outline_b: 'cl_crosshairoutline_b', cl_crosshair_outline_a: 'cl_crosshairoutline_a',
    cl_crosshairoutlinecolor_r: 'cl_crosshairoutline_r', cl_crosshairoutlinecolor_g: 'cl_crosshairoutline_g', cl_crosshairoutlinecolor_b: 'cl_crosshairoutline_b', cl_crosshairoutlinecolor_a: 'cl_crosshairoutline_a',
    cl_crosshair_outlinethickness: null, cl_crosshaircolor: null, cl_crosshairusealpha: null, cl_crosshairgap_useweaponvalue: null, cl_fixedcrosshairgap: null
  };
  const XPIX = new Set(['cl_crosshairsize', 'cl_crosshairthickness', 'cl_crosshairgap']);
  function xhLegacy(text) {
    const lines = [], dropped = []; let rescale = false;
    String(text || '').split(/[\n;]+/).forEach(raw => {
      const m = /^\s*([A-Za-z0-9_]+)\s+"?(-?[\d.]+)"?\s*$/.exec(raw.replace(/\/\/.*$/, '')); if (!m) return;
      const k = m[1].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(XLEG, k)) {
        if (XLEG[k] === null) { dropped.push(k); return; }
        if (XPIX.has(k)) rescale = true;
        lines.push(XLEG[k] + ' ' + m[2]);
      } else lines.push(k + ' ' + m[2]);                                   // unchanged names pass through
    });
    return { lines, dropped, rescale };
  }
  function xhFromCmds(text) {
    const o = Object.assign({}, xh), chan = (hex, i, v) => { const c = [hx(hex, 0), hx(hex, 1), hx(hex, 2)]; c[i] = Math.max(0, Math.min(255, Math.round(v) || 0)); return '#' + c.map(n => n.toString(16).padStart(2, '0')).join(''); };
    let n = 0;
    String(text || '').split(/[\n;]+/).forEach(raw => {
      const m = /^\s*([A-Za-z0-9_]+)\s+"?(-?[\d.]+)"?\s*$/.exec(raw.replace(/\/\/.*$/, '')); if (!m) return;
      const k = m[1].toLowerCase(), v = Number(m[2]); n++;
      if (k === 'cl_crosshairstyle' || k === 'cl_crosshair_style') o.style = v;
      else if (k === 'cl_crosshair_length') o.len = v; else if (k === 'cl_crosshair_thickness') o.th = v; else if (k === 'cl_crosshair_gap') o.gap = v;
      else if (k === 'cl_crosshairdot') o.dot = v; else if (k === 'cl_crosshair_t') o.t = v; else if (k === 'cl_crosshair_recoil') o.rec = v;
      else if (k === 'cl_crosshair_drawoutline') o.ol = v; else if (k === 'cl_crosshair_dynamic_maxdist_splitratio') o.quad = v;
      else if (k === 'cl_crosshaircolor_a') o.alpha = v / 255; else if (k === 'cl_crosshairoutline_a') o.ola = v / 255;
      else if (/^cl_crosshaircolor_[rgb]$/.test(k)) o.col = chan(o.col, 'rgb'.indexOf(k.slice(-1)), v);
      else if (/^cl_crosshairoutline_[rgb]$/.test(k)) o.olc = chan(o.olc, 'rgb'.indexOf(k.slice(-1)), v);
      else n--;
    });
    return { c: xhNorm(o), n };
  }
  const XCLASSIC_PX = 1.3, XPAL = [[250, 50, 50], [50, 250, 50], [250, 250, 50], [50, 50, 250], [50, 250, 250]], XCSTY = [0, 4, 2, 2, 4, 4];
  const xhHex = a => '#' + a.map(n => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0')).join('');
  const xhBytes = (n, len) => { const h = n.toString(16).padStart(len * 2, '0'); return h.length > len * 2 ? null : h.match(/../g).map(x => parseInt(x, 16)); };
  const xhI8 = v => (v > 127 ? v - 256 : v);
  function xhDecode(raw) {
    const s = String(raw || '').trim().replace(/[\s-]+/g, '');
    if (!s) return { err: 'Paste a crosshair share code first.' };
    const up = s.slice(0, 4).toUpperCase(), body = up === 'CSGO' ? s.slice(4) : s.slice(2);
    const isOwn = /^CS/i.test(s) && s.length === 46, isClassic = up === 'CSGO' && s.length === 29;
    if (!isOwn && !isClassic) return { err: 'Not a recognised share code. Expected CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx (29 characters without dashes) or a CS code from this generator (46 characters).' };
    for (const ch of body) if (!XD.includes(ch)) return { err: `The code contains "${ch}", which never appears in a share code. Check for typos (0/O, 1/l/I).` };
    if (isOwn) {
      let n = 0n; for (let i = body.length - 1; i >= 0; i--) n = n * 57n + BigInt(XD.indexOf(body[i]));
      const b = xhBytes(n, 32); if (!b) return { err: 'That code is too large to be valid.' };
      if (b[1] !== 1 || b[0] !== b.slice(1).reduce((a, x) => a + x, 0) % 256) return { err: 'The code failed its checksum. A character is probably missing or wrong.' };
      const f = (b[18] | b[19] << 8 | b[20] << 16 | b[21] * 16777216) >>> 0;
      const c = { style: b[4] & 15, rec: b[4] >> 4 & 1, dot: b[4] >> 6 & 1, t: b[4] >> 7 & 1, col: xhHex([b[5], b[6], b[7]]), alpha: b[8] / 255, olc: xhHex([b[9], b[10], b[11]]),
        th: b[13], ol: b[14], gap: xhI8(b[15]), len: b[16], sh: b[2] | b[3] << 8, split: f & 127, spread: b[17] };
      return { c: xhNorm(c), note: 'Imported (this generator\'s format).' };
    }
    let n = 0n; for (const ch of body.split('').reverse()) n = n * 57n + BigInt(XD.indexOf(ch));
    const b = xhBytes(n, 18); if (!b) return { err: 'That code is too large to be valid.' };
    if (b[1] !== 1 || b[0] !== b.slice(1).reduce((a, x) => a + x, 0) % 256) return { err: 'The code failed its checksum. A character is probably missing or wrong.' };
    const px = v => Math.round(v * XCLASSIC_PX), ci = b[10] & 7;
    const c = {
      style: XCSTY[Math.min(5, (b[13] & 0xe) >> 1)], gap: px(xhI8(b[2]) / 16), th: Math.max(b[12] > 0 ? 1 : 0, px(b[12] / 10)), len: px(((b[15] & 0x1f) << 8 | b[14]) / 10),
      col: xhHex(ci < 5 ? XPAL[ci] : [b[4], b[5], b[6]]), alpha: (b[13] >> 6 & 1) ? b[7] / 255 : 1, dot: b[13] >> 4 & 1, t: b[13] >> 7 & 1, rec: b[8] >> 7 & 1,
      ol: (b[10] & 8) ? 1 : 0, olc: '#000000'
    };
    return { c: xhNorm(c), classic: true, note: 'Imported a classic code. Length, thickness and gap were converted from the old scale to pixels (approximate): fine-tune them with the sliders, and check the result in game.' };
  }

  /* Backdrops: official in-game CS2 map screenshots (from Valve's game files), bundled as img/maps/<map>_<0-2>.jpg with the same
     pictures on GitHub as a fallback. Clicking the same map button again shows its next screenshot. */
  const XMAPS = { dust2: 'Dust II', mirage: 'Mirage', inferno: 'Inferno', nuke: 'Nuke', overpass: 'Overpass', ancient: 'Ancient', anubis: 'Anubis', vertigo: 'Vertigo', train: 'Train' };
  const XH_VIEWS = 3;
  const xhViews = () => XH_VIEWS;
  const xhPics = (k, v) => ['img/maps/' + k + '_' + v + '.jpg', 'https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_' + k + (v ? '_' + v : '') + '_png.png', 'https://cdn.jsdelivr.net/gh/MurkyYT/cs2-map-icons@main/images/thumbs/de_' + k + (v ? '_' + v : '') + '_png.png'];
  let xhBg = { k: 'dust2', v: 0 };
  function xhApplyBg() {
    const cv = $('#xhCv'), lbl = $('#xhBgLbl'), k = xhBg.k, v = xhBg.v, say = t => { if (lbl) lbl.textContent = t; };
    $$('#xhBgs button').forEach(b => { const on = k ? b.dataset.map === k : !!b.dataset.bg; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    cv.classList.remove('xh-steam'); cv.style.background = '#161b24';
    if (!k) return say('');
    say(`${XMAPS[k]} - official screenshot ${v + 1} of ${XH_VIEWS} (click ${XMAPS[k].toUpperCase()} again for the next view)`);
    const srcs = xhPics(k, v), load = i => {
      if (i >= srcs.length) return say(`${XMAPS[k]}: the screenshot could not be loaded.`);
      const im = new Image();
      im.onload = () => { if (xhBg.k === k && xhBg.v === v) { cv.classList.add('xh-steam'); cv.style.background = `#161b24 url("${srcs[i]}") center / cover no-repeat`; }
      };
      im.onerror = () => load(i + 1); im.src = srcs[i];
    };
    load(0);
  }
  function xhImport() {
    const msg = $('#xhImpMsg'), r = xhDecode($('#xhImp').value);
    msg.classList.toggle('bad', !!r.err); msg.textContent = r.err || r.note;
    if (r.err) return false;
    xh = r.c; xhSync(); return true;
  }
  /* Pixel renderer. `fit` is only for the small thumbnails (shrinks the picture to fit); the main preview is always 1:1. */
  function xhDraw(cv, c, fit) {
    const x = cv.getContext('2d'), W = cv.width, H = cv.height, s = c.res / 720, S = v => Math.round(v * s);
    const L = S(c.len), T = S(c.th), G = S(c.gap), ring = [1, 3, 8].includes(c.style), quad = c.style === 7 || c.style === 9;
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, W, H); x.imageSmoothingEnabled = false;
    const z = fit ? Math.min(1, W * .42 / Math.max(6, Math.abs(G) + L + T)) : 1;
    x.save(); x.translate(Math.round(W / 2), Math.round(H / 2)); x.scale(z, z);
    const half = Math.floor(T / 2), r = [], R = (p, q, w, h) => { if (w > 0 && h > 0) r.push([p, q, w, h]); };
    if (c.style !== 6 && quad) {
      const d = G + Math.round(L * c.quad);
      [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sy]) => {
        R(Math.min(sx * d, sx * (d + L)), sy * d - half, L, T);             // horizontal arm of this corner bracket
        R(sx * d - half, Math.min(sy * d, sy * (d + L)), T, L);             // vertical arm
      });
    } else if (c.style !== 6 && !ring) {
      R(G, -half, L, T); R(-G - L, -half, L, T); R(-half, G, T, L); if (!c.t) R(-half, -G - L, T, L);
    }
    if (c.dot || c.style === 6) R(-half, -half, T, T);
    const rr = Math.max(1, G + L), ringPath = part => {
      x.beginPath();
      if (c.style === 8) { if (part) { x.moveTo(-rr, rr); x.lineTo(-rr, -rr); x.lineTo(rr, -rr); } else x.rect(-rr, -rr, 2 * rr, 2 * rr); }
      else x.arc(0, 0, rr, part ? Math.PI : 0, part ? Math.PI * 1.5 : 7);
    };
    const o = c.ol && c.olw > 0 ? Math.max(1, Math.round(s * c.olw)) : 0;   // outline weight is a preview-only control (the game dropped outline thickness)
    if (o) {
      x.globalAlpha = c.ola; x.fillStyle = c.olc;
      r.forEach(([p, q, w, h]) => { if (c.ol === 1) x.fillRect(p - o, q - o, w + 2 * o, h + 2 * o); else { x.fillRect(p - o, q - o, w + o, o); x.fillRect(p - o, q - o, o, h + o); } });   // half = top and left edges only
      if (ring && T > 0) { x.strokeStyle = c.olc; x.lineWidth = T + 2 * o; ringPath(c.ol === 2); x.stroke(); }
    }
    x.globalAlpha = c.alpha; x.fillStyle = x.strokeStyle = c.col; r.forEach(a => x.fillRect(...a));
    if (ring && T > 0) { x.lineWidth = T; ringPath(false); x.stroke(); }
    x.restore();
  }
  function xhSync() {
    $$('#xhCtl [data-xh]').forEach(el => {
      const k = el.dataset.xh;
      if (el.type === 'checkbox') el.checked = k === 'of' ? xh.ol === 1 : k === 'oh' ? xh.ol === 2 : !!xh[k];
      else el.value = xh[k];
      const v = $('#xv-' + k); if (v) v.textContent = XFLT.has(k) ? xh[k].toFixed(2) : xh[k];
      if (k === 'ola' || k === 'olw' || k === 'olc') el.disabled = !xh.ol;
    });
    const qw = $('#xhQuadWrap'); if (qw) qw.classList.toggle('hidden', xh.style !== 2 && xh.style !== 9);
    xhDraw($('#xhCv'), xh); $('#xhOut').value = xhCode(xh);
    const rs = XRES.find(q => q[0] === xh.res) || XRES[0], s = xh.res / 720, S = v => Math.round(v * s);
    $('#xhPx').textContent = `Preview at ${rs[1]} (x${+s.toFixed(2)}): length ${S(xh.len)} px, thickness ${S(xh.th)} px, gap ${S(xh.gap)} px. 1 slider step = 1 px at 1280x720; sizes scale linearly with the resolution height.`;
  }
  function xhThumbs(box, list, html) {
    box.innerHTML = list.map(html).join(''); $$('#' + box.id + ' canvas').forEach((cv, i) => xhDraw(cv, list[i].c, true));
  }
  function renderXhSaved() {
    const li = !!session, list = li ? (xhStore[session.u] || []) : [];
    $('#xhSave').classList.toggle('hidden', !li); $('#xhPublish').classList.toggle('hidden', !(session && session.steam)); $('#xhHint').classList.toggle('hidden', li);
    $('#xhSavedWrap').classList.toggle('hidden', !li || !list.length);
    xhThumbs($('#xhSaved'), list.map(s => Object.assign({}, s, { c: xhMk(s.c) })), s => `<div class="xh-def" data-id="${esc(s.id)}"><canvas width="72" height="72"></canvas><span>${esc(s.n)}</span><div class="row"><button class="btn btn-small" data-xa="load">Load</button><button class="btn btn-small" data-xa="copy">Copy</button><button class="btn btn-small btn-danger" data-xa="del">Del</button></div></div>`);
  }
  function xhInit() {
    const rng = (k, l, a, b, st) => `<div><span class="flabel">${l} <b id="xv-${k}"></b></span><input type="range" data-xh="${k}" min="${a}" max="${b}" step="${st}"></div>`;
    $('#xhCtl').innerHTML = `<div><span class="flabel">Style</span><select data-xh="style">${XSTY.map((s, i) => `<option value="${i}">${s}</option>`).join('')}</select></div>
      <div><span class="flabel">Reference resolution</span><select data-xh="res">${XRES.map(r => `<option value="${r[0]}">${r[1]}</option>`).join('')}</select></div>
      <div><span class="flabel">Color</span><input type="color" data-xh="col"></div>
      ${XR.map(([k, l, a, b, st]) => rng(k, l, a, b, st)).join('')}
      ${rng('alpha', 'Alpha', 0, 1, 0.01)}
      <div id="xhQuadWrap">${rng('quad', 'Quadrant size', 0, 1, 0.01)}</div>
      <label class="toggle"><input type="checkbox" data-xh="oh"> Half-outline</label>
      <label class="toggle"><input type="checkbox" data-xh="of"> Full outline</label>
      <div><span class="flabel">Outline color</span><input type="color" data-xh="olc"></div>
      ${rng('ola', 'Outline alpha', 0, 1, 0.01)}
      ${rng('olw', 'Outline weight (preview only)', 0, 1, 0.01)}
      ${[['dot', 'Center dot'], ['t', 'T-style'], ['rec', 'Follow recoil']].map(([k, l]) => `<label class="toggle"><input type="checkbox" data-xh="${k}"> ${l}</label>`).join('')}`;
    xhThumbs($('#xhDefs'), XDEF.map(d => ({ n: d.n, c: xhMk(d.c) })), (d, i) => `<button type="button" class="xh-def" data-d="${i}"><canvas width="72" height="72"></canvas>${esc(d.n)}</button>`);
    $('#xhDefs').addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (b) { xh = xhMk(XDEF[+b.dataset.d].c); xhSync(); } });
    $('#xhCtl').addEventListener('input', e => {
      const el = e.target, k = el.dataset.xh; if (!k) return;
      if (k === 'of') xh.ol = el.checked ? 1 : 0;                                // full / half outline are mutually exclusive (cl_crosshair_drawoutline 0/1/2)
      else if (k === 'oh') xh.ol = el.checked ? 2 : 0;
      else xh[k] = el.type === 'checkbox' ? +el.checked : el.type === 'color' ? el.value : +el.value;
      xh = xhNorm(xh); xhSync();
    });
    $('#xhBgs').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.bg) xhBg = { k: '', v: 0 };
      else if (b.dataset.map) xhBg = { k: b.dataset.map, v: xhBg.k === b.dataset.map ? (xhBg.v + 1) % xhViews(b.dataset.map) : 0 };   // same button again = next view of that map
      else return;
      xhApplyBg();
    });
    xhApplyBg();
    let impT = 0;
    $('#xhImpGo').addEventListener('click', () => { if (!$('#xhImp').value.trim()) { const m = $('#xhImpMsg'); m.classList.add('bad'); m.textContent = 'Paste a crosshair share code first.'; return; } if (xhImport()) toast('Crosshair imported.'); });
    $('#xhImp').addEventListener('keydown', e => { if (e.key === 'Enter') $('#xhImpGo').click(); });
    $('#xhImp').addEventListener('input', () => {              // importing as soon as a full code is pasted
      clearTimeout(impT); const n = $('#xhImp').value.replace(/[\s-]+/g, '').length;
      if (n === 29 || n === 46) impT = setTimeout(xhImport, 200); else if (!n) { $('#xhImpMsg').textContent = ''; $('#xhImpMsg').classList.remove('bad'); }
    });
    $('#xhCopy').addEventListener('click', async () => toast(await copyText($('#xhOut').value) ? 'Crosshair code copied.' : 'Copy failed. Select the code manually.'));
    $('#xhLegGo').addEventListener('click', () => {
      const r = xhLegacy($('#xhLegIn').value); $('#xhLegOut').value = r.lines.join('\n');
      $('#xhLegNote').textContent = !r.lines.length && !r.dropped.length ? 'No console commands found.'
        : (r.dropped.length ? 'Removed by Valve, no replacement: ' + r.dropped.join(', ') + '. ' : '') + (r.rescale ? 'Old size, thickness and gap values were on the old arbitrary scale, not pixels: re-tune them with the sliders.' : '');
    });
    $('#xhLegApply').addEventListener('click', () => {
      const r = xhFromCmds($('#xhLegOut').value || xhLegacy($('#xhLegIn').value).lines.join('\n'));
      if (!r.n) return toast('Nothing to apply. Convert some commands first.');
      xh = r.c; xhSync(); toast('Applied ' + r.n + ' command(s) to the generator.');
    });
    $('#xhPublish').addEventListener('click', async () => {
      const code = (($('#xhOut').value || '').match(XH_RE) || [''])[0];
      if (!code) return toast('There is no share code to publish yet.');
      try { await xhRemote('PUT', session.id, code); toast('Published: anyone who looks you up now sees this crosshair.'); } catch (e) { toast('Could not publish: ' + e.message); }
    });
    $('#xhSave').addEventListener('click', () => {
      if (!session) return;
      openModal(`<h3>Save Crosshair</h3><input id="xhName" maxlength="30" placeholder="Name"><div class="row"><button class="btn btn-small" id="xn">Cancel</button><button class="btn btn-primary btn-small" id="xs">Save</button></div>`);
      $('#xn').onclick = closeModal;
      $('#xs').onclick = () => {
        const n = $('#xhName').value.trim(), list = xhStore[session.u] || [];
        if (!n) return toast('Enter a name.'); if (list.length >= 20) return toast('You can save up to 20 crosshairs.');
        xhStore[session.u] = list.concat({ id: 'x' + Date.now(), n, c: Object.assign({}, xh) });
        save('mway_xh', xhStore); closeModal(); renderXhSaved(); toast('Crosshair saved.');
      };
    });
    $('#xhSaved').addEventListener('click', e => {
      const b = e.target.closest('[data-xa]'); if (!b || !session) return;
      const list = xhStore[session.u] || [], s = list.find(x => x.id === b.closest('[data-id]').dataset.id); if (!s) return;
      if (b.dataset.xa === 'load') { xh = xhMk(s.c); xhSync(); }
      else if (b.dataset.xa === 'copy') copyText(xhCode(xhMk(s.c))).then(ok => toast(ok ? 'Code copied.' : 'Copy failed.'));
      else { xhStore[session.u] = list.filter(x => x !== s); save('mway_xh', xhStore); renderXhSaved(); }
    });
    xhSync(); renderXhSaved();
  }

  /* =====================================================================
     12d. STEAM / CS2 PLAYER LOOKUP
     Data: Steam Web API (via the saved key), public profile XML fallback, Leetify, optional HLTV endpoint,
     Steam inventory + Steam Market / CSFloat prices, Steam profile comments.
     ===================================================================== */
  const S64 = 76561197960265728n;
  const COMP = ['Unranked', 'Silver I', 'Silver II', 'Silver III', 'Silver IV', 'Silver Elite', 'Silver Elite Master', 'Gold Nova I', 'Gold Nova II', 'Gold Nova III', 'Gold Nova Master',
    'Master Guardian I', 'Master Guardian II', 'Master Guardian Elite', 'Distinguished Master Guardian', 'Legendary Eagle', 'Legendary Eagle Master', 'Supreme Master First Class', 'The Global Elite'];
  const PREM = [[30000, '#e4ae39'], [25000, '#eb4b4b'], [20000, '#d32ce6'], [15000, '#8847ff'], [10000, '#4b69ff'], [5000, '#5e98d9'], [0, '#b0c3d9']];
  const premCol = n => (PREM.find(p => n >= p[0]) || PREM[PREM.length - 1])[1];
  /* Official CS2 rank artwork. {n} = 0-18. Point this at your own copy (e.g. 'img/ranks/skillgroup{n}.svg') if you want to self-host. */
  const RANK_IMG = 'https://raw.githubusercontent.com/Juknum/counter-strike-icons/main/cs2/panorama/images/icons/skillgroups/skillgroup{n}.svg';

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const svgUid = (() => { let n = 0; return () => 'u' + (++n); })();
  const hexA = (h, a) => { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
  /* ---- Display currency ----
     Market prices are fetched in USD and converted for display. `rate` = units of that currency per 1 USD (static, standard
     multipliers). To change one without editing code, set settings.steamCfg.fx, e.g. { "GBP": 0.74 }. Default: GBP. */
  const CUR = {
    GBP: { sym: '\u00a3', pick: '\u00a3', rate: 0.78, name: 'British Pound' }, USD: { sym: '$', pick: '$', rate: 1, name: 'US Dollar' },
    EUR: { sym: '\u20ac', pick: '\u20ac', rate: 0.92, name: 'Euro' }, CAD: { sym: 'CA$', pick: '$', rate: 1.36, name: 'Canadian Dollar' }, AUD: { sym: 'A$', pick: '$', rate: 1.52, name: 'Australian Dollar' }
  };
  let curCode = (() => { const c = load('mway_cur', 'GBP'); return CUR[c] ? c : 'GBP'; })();
  const curRate = code => { const o = settings && settings.steamCfg && settings.steamCfg.fx ? Number(settings.steamCfg.fx[code]) : 0; return o > 0 ? o : CUR[code].rate; };
  const fmtMoney = usd => CUR[curCode].sym + Number((usd || 0) * curRate(curCode)).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function setCur(code) {
    if (!CUR[code]) return;
    curCode = code; save('mway_cur', code);
    updInv(); updGrid(); $$('[data-usd]').forEach(el => { el.textContent = fmtMoney(Number(el.dataset.usd)); });   // totals, top item, grid cards and an open item modal, no reload
  }
  const curSelect = () => `<label class="inv-cur"><span class="flabel">Currency</span><select id="invCur" aria-label="Display currency">${Object.keys(CUR).map(k => `<option value="${k}"${k === curCode ? ' selected' : ''}>${k} (${CUR[k].pick})</option>`).join('')}</select></label>`;
  const mapName = m => { const s = String(m || '').replace(/^(de|cs|ar)_/, ''); return s ? s[0].toUpperCase() + s.slice(1) : '?'; };
  const agoText = sec => {
    sec = Math.max(0, sec);
    for (const [s, l] of [[31557600, 'y'], [2629800, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']]) if (sec >= s) return Math.floor(sec / s) + l + ' ago';
    return 'just now';
  };

  /* ---- Faceit level icon: segmented ring (one segment per level) + level number, official level colours ---- */
  const FC_COL = [null, '#eeeeee', '#1ce400', '#1ce400', '#ffc800', '#ffc800', '#ffc800', '#ffc800', '#ff6309', '#ff6309', '#fe1f00'];
  function faceitIcon(l, px = 58) {
    l = Math.max(1, Math.min(10, Math.round(+l) || 1)); const c = FC_COL[l], R = 27;
    let segs = '';
    for (let i = 0; i < 10; i++) {
      const a0 = (-90 + i * 36 + 4) * Math.PI / 180, a1 = (-90 + (i + 1) * 36 - 4) * Math.PI / 180;
      segs += `<path d="M${(32 + R * Math.cos(a0)).toFixed(2)} ${(32 + R * Math.sin(a0)).toFixed(2)}A${R} ${R} 0 0 1 ${(32 + R * Math.cos(a1)).toFixed(2)} ${(32 + R * Math.sin(a1)).toFixed(2)}" stroke="${i < l ? c : '#34343a'}" stroke-width="5" fill="none"/>`;
    }
    return `<svg class="fc-ico" viewBox="0 0 64 64" width="${px}" height="${px}" role="img" aria-label="Faceit level ${l}"><circle cx="32" cy="32" r="31" fill="#1f1f22"/><circle cx="32" cy="32" r="22.5" fill="#161618"/>${segs}<text x="32" y="${l === 10 ? 39.5 : 40.5}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-weight="800" font-size="${l === 10 ? 20 : 24}" fill="${c}">${l}</text></svg>`;
  }

  /* Official FACEIT skill-level artwork (SVG from FACEIT's own CDN). If it cannot load (CDN path changed, blocked, offline) the
     image is swapped for the inline ring above by the shared image-error handler (data-fc). */
  const FC_CDN = [
    'https://cdn-frontend.faceit.com/web/960/src/app/assets/images-compress/skill-icons/skill_level_{n}_svg.svg',
    'https://cdn-frontend.faceit.com/web/965/src/static/media/skill-level-{n}.svg'
  ];
  const fcSrcs = l => (bridgeUrl() ? [bridgeUrl() + '/faceit/icon/' + l] : []).concat(FC_CDN.map(u => u.replace('{n}', l)));
  function faceitBadge(l, px = 60) {
    l = Math.max(1, Math.min(10, Math.round(+l) || 1));
    return `<img class="fc-ico fc-img" src="${esc(fcSrcs(l)[0])}" width="${px}" height="${px}" alt="FACEIT level ${l}" title="FACEIT level ${l}" decoding="async" referrerpolicy="no-referrer" data-fc="${l}" data-px="${px}" data-fci="0">`;
  }
  function faceitTile(d, rk) {
    const fc = d.fc || {};
    if (rk.faceit) {
      const nick = fc.nick || (d.lf && d.lf.faceit_nickname) || '';
      return `<div class="fc-wrap">${faceitBadge(rk.faceit, 60)}<span class="fc-lvl">Level ${rk.faceit} / 10</span>${rk.faceit_elo ? `<span class="fc-elo"><b>${esc(Number(rk.faceit_elo).toLocaleString('en-US'))}</b> ELO</span>` : ''}${nick ? `<span class="fc-nick" title="${esc(nick)}">${esc(nick)}</span>` : ''}</div>`;
    }
    const msg = fc.state === 'none' ? 'No FACEIT Profile' : fc.state === 'nokey' ? 'FACEIT Not Set Up' : fc.state === 'auth' ? 'FACEIT Key Rejected' : fc.state === 'rate' ? 'FACEIT Busy' : fc.state === 'err' ? 'FACEIT Unreachable'
      : (d.lfState === 'ok' || d.lfState === 'none' ? 'No Rank' : 'No Data');
    const sub = fc.state === 'none' ? 'No FACEIT account is linked to this Steam ID.' : fc.state === 'auth' ? 'The admin needs to replace the FACEIT API key.' : fc.state === 'rate' || fc.state === 'err' ? 'Try the lookup again shortly.' : '';
    return `<div class="fc-wrap"><div class="lk-na lk-na-box">${msg}</div>${sub ? `<span class="fc-sub">${sub}</span>` : ''}</div>`;
  }

  /* ---- CS2 competitive rank emblems: Valve's own artwork (skillgroup 1-18, 0 = unranked) from the counter-strike-icons repo.
     The SVGs are 32:13 plates, so size is given as a width. If an image cannot load, a plain text label is shown instead. ---- */
  const rankIcon = (r, w = 96) => {
    r = Math.max(0, Math.min(18, r | 0));
    return `<img class="rk-ico" src="${esc(RANK_IMG.replace('{n}', r))}" width="${w}" height="${Math.round(w * 13 / 32)}" alt="${esc(COMP[r])}" title="${esc(COMP[r])}" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-rk="${r}">`;
  };

  /* ---- CS2 Premier badge: slanted in-game style plate, tier colours unchanged ---- */
  function premHTML(n) {
    const c = premCol(n), parts = Number(n).toLocaleString('en-US').split(',');
    const num = parts.map((p, i) => (i ? '<em>,</em>' : '') + `<b>${esc(p)}</b>`).join('');
    return `<div class="pm" style="--c:${c};--cg:${hexA(c, .5)};--cs:${hexA(c, .16)}" role="img" aria-label="Premier rating ${esc(n)}"><span class="pm-bars" aria-hidden="true"><i></i><i></i><i></i></span><span class="pm-num">${num}</span><span class="pm-tag">PREMIER</span></div>`;
  }

  /* ---- Steam account level badge (colour per ten levels, square frame from level 100, "+" pip for x5-x9) ---- */
  const LV_COL = ['#9b9b9b', '#c02942', '#d95b43', '#fecc23', '#467a3c', '#4e8ddb', '#7652c9', '#c252c9', '#542437', '#997c52'];
  function levelBadge(l, px = 46) {
    l = Math.max(0, l | 0); const col = LV_COL[Math.floor(l / 10) % 10], h = Math.floor(l / 100), u = l % 10;
    const frame = h
      ? `<rect x="5" y="5" width="54" height="54" rx="${h > 1 ? 13 : 19}" fill="#13171e" stroke="${col}" stroke-width="5"/>${h > 1 ? `<rect x="11" y="11" width="42" height="42" rx="9" fill="none" stroke="${col}" stroke-opacity=".45" stroke-width="2"/>` : ''}`
      : `<circle cx="32" cy="32" r="28" fill="#13171e" stroke="${col}" stroke-width="5"/>`;
    const pip = u >= 5 ? `<rect x="24" y="57.5" width="16" height="5" rx="2.5" fill="${col}"/>` : '';
    return `<svg class="lv-ico" viewBox="0 0 64 64" width="${px}" height="${px}" role="img" aria-label="Steam level ${l}">${frame}${pip}<text x="32" y="${String(l).length > 2 ? 39 : 41}" text-anchor="middle" font-family="'Motiva Sans','Segoe UI',Arial,sans-serif" font-weight="700" font-size="${String(l).length > 2 ? 20 : String(l).length > 1 ? 25 : 30}" fill="#fff">${l}</text></svg>`;
  }
  function yearSVG(y, px = 46) {
    const id = svgUid();
    return `<svg class="yr-ico" viewBox="0 0 64 64" width="${px}" height="${px}" role="img" aria-label="${y} years of service"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a5f88"/><stop offset="1" stop-color="#1c2638"/></linearGradient></defs><path d="M32 3l25 14v30L32 61 7 47V17z" fill="url(#${id})" stroke="#8fb2ff" stroke-width="2"/><text x="32" y="37" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-weight="800" font-size="${y > 9 ? 21 : 26}" fill="#fff">${y}</text><text x="32" y="50" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-weight="700" font-size="8" letter-spacing="1" fill="#8fb2ff">YEARS</text></svg>`;
  }
  const yearBadge = (y, px = 46) => `<img class="yr-img" src="https://community.cloudflare.steamstatic.com/public/images/badges/02_years/steamyears${Math.min(y, 20)}_54.png" width="${px}" height="${px}" alt="${y} years of service" title="${y} year${y > 1 ? 's' : ''} of service" referrerpolicy="no-referrer" data-yfb="${y}" data-px="${px}">`;

  /* ---- Steam "Game Collector" badge (community badge 13, the official games-owned badge). The badge level is the number of games
     that count towards it; the artwork tier is the highest Valve milestone reached: 1, 5, 10, 25, 50, 100, 250, 500, then every 1000.
     Official art from Steam's CDN, inline fallback if it cannot load (data-gfb). ---- */
  const GC_TIERS = [1, 5, 10, 25, 50, 100, 250, 500];
  const gcTier = n => n >= 1000 ? Math.min(Math.floor(n / 1000) * 1000, 100000) : GC_TIERS.filter(t => t <= n).pop() || 1;
  function gcSVG(n, px = 46) {
    const t = n >= 1000 ? Math.floor(n / 1000) + 'K' : String(n);
    return `<svg class="gc-ico" viewBox="0 0 64 64" width="${px}" height="${px}" role="img" aria-label="Game Collector ${n}"><rect x="6" y="14" width="52" height="36" rx="6" fill="#1c2638" stroke="#8fb2ff" stroke-width="2"/><rect x="12" y="8" width="40" height="6" rx="2" fill="#4a5f88"/><text x="32" y="38" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-weight="800" font-size="${t.length > 3 ? 14 : 18}" fill="#fff">${esc(t)}</text></svg>`;
  }
  const gameBadge = (n, px = 46) => `<img class="gc-ico" src="https://community.fastly.steamstatic.com/public/images/badges/13_gamecollector/${gcTier(n)}_80.png" width="${px}" height="${px}" alt="Game Collector: ${n} games" title="Game Collector: ${n.toLocaleString('en-US')} games owned" referrerpolicy="no-referrer" data-gfb="${n}" data-px="${px}">`;

  /* ---- Parsing ---- */
  function lkAcct(n) { return n > 0n && n <= 4294967295n ? { id: String(S64 + n) } : { err: 'That account ID is out of range.' }; }
  function lkParse(raw) {
    raw = String(raw || '').trim(); if (!raw) return null;
    let m;
    if ((m = raw.match(/7656119\d{10}/))) return { id: m[0] };                                   // SteamID64 anywhere (also profile / stats-site URLs)
    if ((m = raw.match(/^STEAM_[0-5]:([01]):(\d{1,10})$/i))) return lkAcct(BigInt(m[2]) * 2n + BigInt(m[1]));
    if ((m = raw.match(/^\[?U:1:(\d{1,10})\]?$/i))) return lkAcct(BigInt(m[1]));
    if ((m = raw.match(/^\d{1,10}$/))) return lkAcct(BigInt(m[0]));
    if ((m = raw.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,32})/i))) return { vanity: m[1] };
    if ((m = raw.match(/\/(?:id|lookup|user|profile|player)\/([A-Za-z0-9_-]{2,32})(?:[/?#]|$)/i))) return { vanity: m[1] };
    if ((m = raw.match(/^[A-Za-z0-9_-]{2,32}$/))) return { vanity: m[0] };
    return { err: 'Could not recognise that. Use a Steam profile link, SteamID64, SteamID2/3, account ID or custom name.' };
  }
  function lkIds(id, profileUrl) {
    const a = BigInt(id) - S64, y = a % 2n, z = a / 2n;
    const rows = [['SteamID64', id], ['SteamID3', `[U:1:${a}]`], ['SteamID2', `STEAM_1:${y}:${z}`], ['SteamID2 (legacy)', `STEAM_0:${y}:${z}`], ['Account ID', String(a)], ['FiveM Hex', 'steam:' + BigInt(id).toString(16)], ['Profile URL', `https://steamcommunity.com/profiles/${id}`]];
    const v = String(profileUrl || '').match(/steamcommunity\.com\/id\/([^/?#]+)/i);
    if (v) rows.push(['Custom URL', `https://steamcommunity.com/id/${v[1]}`]);
    return rows;
  }

  /* ---- Steam data ---- */
  const hasSteamKey = () => /^[A-Fa-f0-9]{32}$/.test(settings.steamCfg.key || '') || bridgeHoldsKey();
  const xmlTxt = (doc, tag) => { const n = doc.getElementsByTagName(tag)[0]; return n ? (n.textContent || '').trim() : ''; };

  /* Keyless fallback: the public profile XML (no Web API key, no level / playtime / bans detail). */
  async function lkXml(idOrVanity, isVanity) {
    const url = isVanity ? `https://steamcommunity.com/id/${idOrVanity}/?xml=1` : `https://steamcommunity.com/profiles/${idOrVanity}/?xml=1`;
    const r = await proxyReq(url, { ttl: 120000, timeout: 8000, total: 11000, check: null });
    const doc = new DOMParser().parseFromString(r.text || '', 'text/xml');
    if (doc.getElementsByTagName('parsererror').length || doc.getElementsByTagName('error').length || !xmlTxt(doc, 'steamID64')) return null;
    const id = xmlTxt(doc, 'steamID64'), on = xmlTxt(doc, 'onlineState').toLowerCase(), cu = xmlTxt(doc, 'customURL');
    const ms = xmlTxt(doc, 'memberSince'), created = ms ? Math.floor(Date.parse(ms + ' UTC') / 1000) || Math.floor(Date.parse(ms) / 1000) || 0 : 0;
    const vac = xmlTxt(doc, 'vacBanned') === '1', tb = xmlTxt(doc, 'tradeBanState');
    return {
      id, src: 'xml', name: xmlTxt(doc, 'steamID'), avatar: xmlTxt(doc, 'avatarFull'),
      url: cu ? `https://steamcommunity.com/id/${cu}` : `https://steamcommunity.com/profiles/${id}`,
      created, pub: xmlTxt(doc, 'privacyState').toLowerCase() === 'public',
      persona: { state: on === 'offline' ? 0 : 1, lastlogoff: 0, lastText: on === 'offline' ? xmlTxt(doc, 'stateMessage').replace(/^Last Online\s*/i, '') : '', game: on === 'in-game' ? xmlTxt(doc, 'stateMessage').replace(/^In-Game<br\s*\/?>/i, '').trim() : '' },
      bans: (vac || (tb && tb.toLowerCase() !== 'none')) ? { VACBanned: vac, NumberOfVACBans: vac ? 1 : 0, EconomyBan: tb || 'none' } : null
    };
  }
  async function lkResolve(vanity) {
    if (hasSteamKey()) {
      try {
        const r = await steamApi('ISteamUser/ResolveVanityURL/v1', { vanityurl: vanity }, { ttl: 3600000 });
        if (r.response && r.response.success === 1) return r.response.steamid;
        if (r.response && r.response.success === 42) return null;
      } catch (e) { /* fall through to the keyless route */ }
    }
    const x = await lkXml(vanity, true);
    return x ? x.id : null;
  }
  /* Phase 1: identity. Web API first, public XML as fallback. */
  async function lkProfile(id) {
    let apiErr = null;
    if (hasSteamKey()) {
      try {
        const sm = await steamApi('ISteamUser/GetPlayerSummaries/v2', { steamids: id });
        const p = ((sm.response || {}).players || [])[0];
        if (!p) return { missing: true };
        return {
          src: 'api', id, name: p.personaname, avatar: p.avatarfull || p.avatarmedium || p.avatar || '', url: p.profileurl, created: p.timecreated || 0,
          pub: p.communityvisibilitystate === 3, persona: { state: p.personastate || 0, lastlogoff: p.lastlogoff || 0, game: p.gameextrainfo || '' }
        };
      } catch (e) { apiErr = e; }
    }
    try {
      const x = await lkXml(id, false);
      if (x) { x.apiErr = apiErr; return x; }
    } catch (e) { if (!apiErr) apiErr = e; }
    return { missing: !apiErr, apiErr };
  }

  /* Leetify: direct request first, then the bridge / proxy chain, with retries. 404 on every route = no profile; auth / rate / network problems are reported as such.
     Transient failures (timeouts, 5xx, unreadable bodies) are retried twice with a short back-off before the lookup gives up. */
  const toNum = v => { const n = typeof v === 'object' && v ? parseFloat(v.rating != null ? v.rating : v.level != null ? v.level : v.value) : parseFloat(v); return Number.isFinite(n) ? n : 0; };
  function lkNormLeetify(j) {
    if (j && typeof j === 'object' && !j.ranks && !j.steam64_id && j.data && typeof j.data === 'object') j = j.data;   // some gateways wrap the payload
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    if (!(j.ranks || j.steam64_id || j.name || j.id)) return null;
    const rk = Object.assign({}, j.ranks && typeof j.ranks === 'object' ? j.ranks : {});
    if (rk.faceit && typeof rk.faceit === 'object') { rk.faceit_elo = rk.faceit_elo || rk.faceit.elo || rk.faceit.faceit_elo; rk.faceit = rk.faceit.level || rk.faceit.skill_level; }
    rk.faceit = Math.max(0, Math.min(10, Math.round(toNum(rk.faceit)))) || 0;
    rk.faceit_elo = toNum(rk.faceit_elo) || 0;
    rk.premier = toNum(rk.premier) || 0;
    rk.competitive = Array.isArray(rk.competitive) ? rk.competitive.filter(c => c && typeof c === 'object') : [];
    return Object.assign({}, j, { ranks: rk });
  }
  async function lkLeetify(id) {
    const k = (settings.steamCfg.leetifyKey || '').trim();
    const headers = k ? { Authorization: 'Bearer ' + k, _leetify_key: k } : undefined;
    const url = 'https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=' + id;
    let state = 'err';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await proxyReq(url, {
          json: true, direct: true, headers, ttl: 300000, timeout: 8000, total: 11000,
          authMsg: 'Leetify rejected the request (HTTP 401/403). Add a Leetify API key in Admin (or the LEETIFY_API_KEY secret on the Worker) if one is required.'
        });
        if (r.status === 404) return { state: 'none' };
        const j = lkNormLeetify(r.json);
        if (!j) { state = 'err'; diag('warn', 'app', 'Leetify returned HTTP ' + r.status + ' without a usable profile (attempt ' + (attempt + 1) + ')'); }
        else return { state: 'ok', data: j };
      } catch (e) {
        if (e.code === 'AUTH') return { state: 'auth' };
        state = e.code === 'RATE' ? 'rate' : 'err';
        if (e.code === 'RATE' && attempt >= 1) break;   // one patient retry is enough for rate limits
      }
      if (attempt < 2) await sleep(attempt ? 1800 : 700);
    }
    return { state };
  }
  /* FACEIT Data API v4 (official source for the FACEIT level + ELO): GET /players?game=cs2&game_player_id=<steamid64>.
     Never throws. Result states: ok (level, elo, nick, ...), none (no FACEIT profile / no CS2 level), nokey, auth (key rejected),
     rate, err. The key comes from the Admin field (direct call) or from the Worker (FACEIT_API_KEY / Admin push). */
  async function lkFaceit(id) {
    const k = faceitKey();
    if (bridgeUrl() && !bridgeCaps) { try { await probeBridge(); } catch { /* offline bridge */ } }
    if (!k && !faceitOnBridge()) return { state: 'nokey' };
    try {
      const r = await proxyReq('https://open.faceit.com/data/v4/players?game=cs2&game_player_id=' + encodeURIComponent(id), {
        json: true, direct: !!k, headers: k ? { Authorization: 'Bearer ' + k } : undefined, ttl: 300000, timeout: 8000, total: 11000
      });
      if (r.status === 404 || !r.json) return { state: 'none' };
      const j = r.json, g = j.games && (j.games.cs2 || j.games.csgo), lvl = g ? Math.max(0, Math.min(10, Math.round(+g.skill_level || 0))) : 0;
      if (!lvl) return { state: 'none', nick: j.nickname || '' };
      let url = String(j.faceit_url || '').replace('{lang}', 'en');
      if (!/^https:\/\/(www\.)?faceit\.com\//i.test(url)) url = j.nickname ? 'https://www.faceit.com/en/players/' + encodeURIComponent(j.nickname) : '';
      return { state: 'ok', level: lvl, elo: Math.round(+g.faceit_elo) || 0, nick: j.nickname || '', country: String(j.country || '').toUpperCase(), region: g.region || '', url };
    } catch (e) { return { state: e && e.code === 'AUTH' ? 'auth' : e && e.code === 'RATE' ? 'rate' : 'err' }; }
  }

  /* HLTV has no public API. This calls an endpoint you configure in Admin (your own scraper / service).
     {steamid} and {name} are replaced in the URL; the key is sent as a Bearer token and x-api-key header.
     The response may be a number or JSON containing rating / hltv_rating / data.rating. */
  async function lkHltv(d) {
    const c = settings.steamCfg;
    if (!c.hltvUrl) return null;
    const url = c.hltvUrl.replace('{steamid}', encodeURIComponent(d.id)).replace('{name}', encodeURIComponent(d.name || ''));
    if (!/^https:\/\//i.test(url)) return null;
    const headers = c.hltvKey ? { Authorization: 'Bearer ' + c.hltvKey, 'x-api-key': c.hltvKey } : undefined;
    try {
      const r = await proxyReq(url, { json: true, direct: true, headers, ttl: 600000, timeout: 8000, total: 11000 });
      const j = r.json, v = typeof j === 'number' ? j : j && (j.rating != null ? j.rating : j.hltv_rating != null ? j.hltv_rating : j.hltvRating != null ? j.hltvRating : j.data && j.data.rating);
      const n = parseFloat(v);
      return n > 0 && n < 5 ? n : null;
    } catch { return null; }
  }

  /* Top maps: comp ranks per map, ordered by how often the map shows up in the player's recent matches. */
  function topMaps(lf) {
    const rm = {}, cnt = {};
    ((lf && lf.ranks && lf.ranks.competitive) || []).forEach(c => { if (c && c.map_name && c.rank > 0) rm[c.map_name] = c.rank; });
    ((lf && lf.recent_matches) || []).forEach(m => { if (m && m.map_name) cnt[m.map_name] = (cnt[m.map_name] || 0) + 1; });
    return Object.keys(rm).sort((a, b) => (cnt[b] || 0) - (cnt[a] || 0) || rm[b] - rm[a]).slice(0, 5).map(n => ({ map: n, rank: rm[n], played: cnt[n] || 0 }));
  }

  function mapRecords(lf) {
    const r = {};
    ((lf && lf.recent_matches) || []).forEach(m => {
      if (!m || !m.map_name) return;
      const o = r[m.map_name] || (r[m.map_name] = { w: 0, l: 0, t: 0 }), oc = String(m.outcome || '').toLowerCase();
      if (oc === 'win') o.w++; else if (oc === 'loss') o.l++; else if (oc === 'tie' || oc === 'draw') o.t++;
    });
    return r;
  }
  function wrHTML(rec) {
    const n = rec ? rec.w + rec.l + rec.t : 0;
    if (!n) return '<div class="lk-wr none" title="No recent Leetify matches on this map">No recent games</div>';
    const pct = Math.round(rec.w / n * 100), cls = pct >= 55 ? 'good' : pct >= 45 ? 'mid' : 'bad';
    return `<div class="lk-wr ${cls}" title="${pct}% win rate over ${n} recent game${n > 1 ? 's' : ''}"><b>${pct}% Win Rate</b>${rec.w}W - ${rec.l}L${rec.t ? ' - ' + rec.t + 'T' : ''}</div>`;
  }

  const LK_ICO = {
    steam: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z"/></svg>',
    faceit: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.999 2.705a.167.167 0 00-.312-.1 1141.27 1141.27 0 00-6.053 9.375H.218c-.221 0-.301.282-.11.352 7.227 2.73 17.667 6.836 23.5 9.134.15.06.39-.08.39-.18z"/></svg>',
    leetify: '<img src="https://www.google.com/s2/favicons?domain=leetify.com&sz=128" alt="" width="24" height="24" decoding="async" referrerpolicy="no-referrer" data-lkfb="leetify">',
    csstats: '<img src="https://www.google.com/s2/favicons?domain=csstats.gg&sz=128" alt="" width="24" height="24" decoding="async" referrerpolicy="no-referrer" data-lkfb="csstats">'
  };
  const LK_ICO_FB = {
    leetify: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#f84982"/><path fill="#fff" d="M8 6h3.2v8.4H16V17H8z"/><circle cx="16.4" cy="7.6" r="1.5" fill="#fff"/></svg>',
    csstats: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="#4ea1ff" stroke-width="1.8"/><circle cx="12" cy="12" r="4.8" fill="none" stroke="#4ea1ff" stroke-width="1.8"/><circle cx="12" cy="12" r="1.5" fill="#ff9a3c"/></svg>'
  };
  const lkIcon = (k, href, label) => `<a class="lk-ico ${k}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(label)}" aria-label="${esc(label)}">${LK_ICO[k]}</a>`;

  const XH_RE = /CSGO(?:-[A-Za-z0-9]{5}){5}/, XH_ABC = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
  function xhFind(o, depth) {   // look for a CS2 crosshair share code anywhere inside a (Leetify) object
    depth = depth || 0;
    if (o == null || depth > 5) return '';
    if (typeof o === 'string') { const m = XH_RE.exec(o); return m ? m[0] : ''; }
    if (typeof o !== 'object') return '';
    for (const k of Object.keys(o)) { const r = xhFind(o[k], depth + 1); if (r) return r; }
    return '';
  }
  function xhDecode(code) {   // best-effort decode of the share code, only used to DRAW the small preview; the copied code is always the original
    try {
      const s2 = String(code).replace(/^CSGO/, '').replace(/-/g, '');
      let n = 0n;
      for (let i = s2.length - 1; i >= 0; i--) { const x = XH_ABC.indexOf(s2[i]); if (x < 0) return null; n = n * 57n + BigInt(x); }
      const b = []; for (let i = 0; i < 18; i++) { b.unshift(Number(n & 255n)); n >>= 8n; }
      if (b.slice(1).reduce((a, c) => a + c, 0) % 256 !== b[0]) return null;
      const i8 = x => x > 127 ? x - 256 : x, ci = b[10] & 7, pal = [[250, 42, 42], [50, 250, 50], [250, 250, 50], [50, 50, 250], [50, 250, 250]];
      const len = ((b[15] << 8) | b[14]) / 10, th = (((b[13] & 15) << 8) | b[12]) / 10, gap = i8(b[2]) / 10, al = b[7] / 255;
      return { rgb: ci < 5 ? pal[ci] : [b[4], b[5], b[6]], a: al < 0.25 ? 1 : al, gap: gap >= -10 && gap <= 10 ? gap : -2, len: len > 0 && len <= 20 ? len : 5, thick: th > 0 && th <= 6 ? th : 1, dot: !!(b[13] & 16), outline: !!(b[10] & 8) };
    } catch (e) { return null; }
  }
  function xhSvg(x) {
    x = x || { rgb: [80, 250, 80], a: 1, gap: -2, len: 5, thick: 1, dot: false, outline: false };
    const T = Math.max(1.3, x.thick * 1.5), L = Math.min(13, Math.max(2.5, x.len * 1.5)), G = Math.max(1, 3 + x.gap * 1.5), h = T / 2;
    const r = (X, Y, W, H) => `<rect x="${X.toFixed(1)}" y="${Y.toFixed(1)}" width="${W.toFixed(1)}" height="${H.toFixed(1)}"/>`;
    return `<svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true"><g fill="rgb(${x.rgb.join(',')})" opacity="${x.a.toFixed(2)}" stroke="${x.outline ? '#000' : 'none'}" stroke-width="${x.outline ? 0.8 : 0}">${r(20 - G - L, 20 - h, L, T)}${r(20 + G, 20 - h, L, T)}${r(20 - h, 20 - G - L, T, L)}${r(20 - h, 20 + G, T, L)}${x.dot ? r(20 - h, 20 - h, T, T) : ''}</g></svg>`;
  }
  const mPlayers = m => { const a = m && (Array.isArray(m.stats) ? m.stats : Array.isArray(m.players) ? m.players : Array.isArray(m.lobby) ? m.lobby : null); return a ? a.filter(x => x && typeof x === 'object') : []; };
  const pidOf = x => String((x && (x.steam64_id || x.steamid || x.steam_id || x.steam64 || x.player_steam64_id)) || '');
  const teamOf = x => { const t = x && (x.initial_team_number != null ? x.initial_team_number : x.team_number != null ? x.team_number : x.team != null ? x.team : null); return t == null ? null : String(t); };
  const mOwn = (m, id) => { const a = mPlayers(m); return a.length ? (a.find(x => pidOf(x) === id) || null) : (m || null); };
  function mOutcome(m, id) {   // 'win' | 'loss' | 'tie' | '' for one Leetify match (any source: premier, competitive, faceit ...)
    if (!m) return '';
    const me = mOwn(m, id) || {}, r = String(m.outcome || me.outcome || m.result || '').toLowerCase();
    if (/^(win|won|victory)/.test(r)) return 'win';
    if (/^(los|defeat)/.test(r)) return 'loss';
    if (/^(tie|draw)/.test(r)) return 'tie';
    if (Array.isArray(m.team_scores) && me.initial_team_number != null) {
      const mine = m.team_scores.find(t => Number(t.team_number) === Number(me.initial_team_number)), other = m.team_scores.find(t => Number(t.team_number) !== Number(me.initial_team_number));
      if (mine && other) return mine.score > other.score ? 'win' : mine.score < other.score ? 'loss' : 'tie';
    }
    return '';
  }
  async function loadMatches(v, d) {   // one shared Leetify match-history load per lookup (teammates, K/D, form and crosshair all use it)
    if (v._mp) return v._mp;
    v._mp = (async () => {
      const lf = d.lf || {}, base = Array.isArray(lf.recent_matches) ? lf.recent_matches : [];
      let full = base.some(m => m && Array.isArray(m.stats) && m.stats.length) ? base : null;
      if (!full) {
        const k = (settings.steamCfg.leetifyKey || '').trim(), headers = k ? { Authorization: 'Bearer ' + k, _leetify_key: k } : undefined;
        try {
          const r = await proxyReq('https://api-public.cs-prod.leetify.com/v3/profile/matches?steam64_id=' + v.id, { json: true, direct: true, headers, ttl: 300000, timeout: 9000, total: 14000 });
          const j = r.json;
          full = Array.isArray(j) ? j : j && (Array.isArray(j.matches) ? j.matches : Array.isArray(j.data) ? j.data : Array.isArray(j.results) ? j.results : null);
          diag('info', 'app', 'matches: ' + (Array.isArray(full) ? full.length : 0) + ' match(es) with lobby data from Leetify');
        } catch (e) { diag('warn', 'app', 'matches: match history unavailable (' + (e.message || e.code) + ')'); }
      }
      return { full: Array.isArray(full) && full.length ? full : null, base };
    })();
    return v._mp;
  }
  function kdCalc(list, id) {
    let k = 0, de = 0, n = 0, sum = 0, nr = 0;
    list.forEach(m => {
      const o = mOwn(m, id) || {}, kk = Number(o.total_kills != null ? o.total_kills : o.kills), dd = Number(o.total_deaths != null ? o.total_deaths : o.deaths);
      if (Number.isFinite(kk) && Number.isFinite(dd) && (kk || dd)) { k += kk; de += dd; n++; }
      else { const q = Number(o.kd_ratio); if (Number.isFinite(q) && q > 0) { sum += q; nr++; } }
    });
    if (n) return { kd: de ? k / de : k, k, d: de, n };
    if (nr) return { kd: sum / nr, n: nr, avg: true };
    return null;
  }
  async function statsStart(v, d) {
    v.form = { state: 'loading' }; v.perf = { state: 'loading' }; updPerf();
    if (d.lfState !== 'ok') { v.form = { state: 'na', list: [] }; v.perf = { state: 'na' }; updPerf(); return; }
    let mp; try { mp = await loadMatches(v, d); } catch (e) { mp = { full: null, base: (d.lf && d.lf.recent_matches) || [] }; }
    if (lkv !== v) return;
    const src = (mp.full || mp.base || []).filter(m => m && typeof m === 'object');
    const ts = m => { const t = Date.parse(m.finished_at || m.started_at || ''); return Number.isFinite(t) ? t : 0; };
    const sorted = src.slice().sort((a, b) => ts(b) - ts(a));
    v.form = { state: 'ok', list: sorted.map(m => mOutcome(m, v.id)).filter(Boolean).slice(0, 5) };
    const aim = Number(d.lf && d.lf.rating && d.lf.rating.aim);
    v.perf = { state: 'ok', kd: kdCalc(sorted, v.id), aim: Number.isFinite(aim) ? Math.max(0, Math.min(100, aim)) : null };
    updPerf();
  }
  const XH_MINE = 'mway_myxh';
  const xhOwn = id => !!(session && session.steam && session.id === id);
  async function xhStart(v, d) {
    v.xh = { state: 'loading' }; updPerf();
    let code = '', src = '';
    const b = bridgeUrl();
    if (b) {
      try {
        const r = await fetchText(b + '/crosshair?id=' + v.id, {}, 6000);
        const j = r.status === 200 ? JSON.parse(r.text) : null;
        if (j && XH_RE.test(j.code || '')) { code = String(j.code).match(XH_RE)[0]; src = 'MWAY LABS'; }
      } catch (e) { /* old Worker (no /crosshair route) or offline: other sources below */ }
    }
    if (!code) { const mine = load(XH_MINE, {}) || {}; if (XH_RE.test(mine[v.id] || '')) { code = String(mine[v.id]).match(XH_RE)[0]; src = 'saved in this browser'; } }
    if (!code && d.lfState === 'ok') {
      let mp = null; try { mp = await loadMatches(v, d); } catch (e) { /* no match history */ }
      const rest = Object.assign({}, d.lf); delete rest.recent_matches; delete rest.recent_teammates;
      code = xhFind(rest); if (code) src = 'Leetify';
      const list = ((mp && (mp.full || mp.base)) || []).filter(m => m && typeof m === 'object');
      for (let i = 0; !code && i < list.length; i++) { const o = mOwn(list[i], v.id); if (o) code = xhFind(o); if (code) src = 'Leetify'; }
    }
    if (lkv !== v) return;
    diag('info', 'app', 'crosshair: ' + (code ? 'share code found (' + src + ')' : 'no share code available for this player (Steam and Leetify do not publish one)'));
    v.xh = code ? { state: 'ok', code, dec: xhDecode(code), src } : { state: 'na', canSet: isAdmin() || xhOwn(v.id) };
    updPerf();
  }
  async function xhRemote(method, id, code) {   // store on the Worker so every visitor sees it: the owner (Steam login) or an admin
    const b = bridgeUrl(), tok = (session && session.tok) || gsToken();
    if (!b || !tok) throw new Error('log in with Steam again (and make sure the Worker bridge is set).');
    const res = await fetchText(b + '/crosshair?id=' + id, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: method === 'PUT' ? JSON.stringify({ code }) : undefined }, 15000);
    if (res.status === 401) throw new Error('the Worker rejected this login (log in with Steam again)');
    if (res.status === 404) throw new Error('the Worker is still the old version: deploy the new worker.js');
    let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
    if (res.status !== 200 || !j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + res.status);
  }
  function xhSetModal(v) {
    if (!v || !(isAdmin() || xhOwn(v.id))) return;
    openModal(`<h3>Set crosshair</h3><p class="muted">Paste the CS2 share code for ${esc(v.name || v.id)} (in CS2: Settings &gt; Game &gt; Crosshair &gt; Share or Import Crosshair).</p>
      <input id="xhSetIn" placeholder="CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx" autocomplete="off" spellcheck="false" aria-label="CS2 crosshair share code"><p id="xhSetMsg" class="muted"></p>
      <div class="row"><button class="btn btn-small" id="xhSetNo">Cancel</button><button class="btn btn-small" id="xhSetDel">Remove</button><button class="btn btn-primary btn-small" id="xhSetOk">Save</button></div>`);
    const msg = t => { const m = $('#xhSetMsg'); if (m) m.textContent = t; };
    $('#xhSetNo').onclick = closeModal;
    const apply = code => { if (lkv !== v) return; v.xh = code ? { state: 'ok', code, dec: xhDecode(code), src: 'saved' } : { state: 'na', canSet: true }; updPerf(); };
    const put = (method, code) => xhRemote(method, v.id, code);
    $('#xhSetOk').onclick = async () => {
      const code = (($('#xhSetIn').value || '').match(XH_RE) || [''])[0];
      if (!code) return msg('That is not a CS2 share code (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx).');
      try {
        try { await put('PUT', code); toast('Crosshair published on the profile.'); }
        catch (e) { if (isAdmin()) throw e; const mine = load(XH_MINE, {}) || {}; mine[v.id] = code; save(XH_MINE, mine); toast('Saved on this device only (' + e.message + ').'); }
        apply(code); closeModal();
      } catch (e) { msg('Could not save: ' + e.message); }
    };
    const del = $('#xhSetDel');
    if (del) del.onclick = async () => { try { await put('DELETE'); apply(''); closeModal(); toast('Crosshair removed.'); } catch (e) { msg('Could not remove: ' + e.message); } };
  }
  function gaugeHTML(cls, label, text, pct, color, info) {
    return `<div class="lk-tile lk-gauge ${cls}"><span class="flabel">${label}</span><div class="lk-g-row"><div class="lk-ring" style="--c:${color}"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="rg-dec" cx="60" cy="60" r="57"/><circle class="rg-track" cx="60" cy="60" r="48"/><circle class="rg-val" cx="60" cy="60" r="48" pathLength="100" style="--p:${pct.toFixed(1)}"/></svg><b>${text}</b></div><div class="lk-g-info">${info}</div></div></div>`;
  }
  function updPerf() {
    const v = lkv; if (!v) return;
    const box = $('#lkPerf'), p = v.perf;
    if (box && p) {
      if (p.state === 'loading') box.innerHTML = `<div class="lk-tile lk-gauge"><p class="muted">${invSpin} Loading K/D and aim rating&hellip;</p></div>`;
      else if (p.state !== 'ok') box.innerHTML = '<div class="lk-tile lk-gauge"><span class="flabel">K/D</span><div class="lk-na lk-na-box">No Data</div></div><div class="lk-tile lk-gauge"><span class="flabel">Aim rating</span><div class="lk-na lk-na-box">No Data</div></div>';
      else {
        const kd = p.kd, kc = !kd ? '#8793a5' : kd.kd >= 1.2 ? '#4fb286' : kd.kd >= 1 ? '#5b8def' : kd.kd >= 0.85 ? '#d1a455' : '#d1556a';
        const kdInfo = kd ? `<span class="lk-g-t">Kill / Death ratio</span><span class="muted">${kd.avg ? 'average of ' : ''}${kd.n} recent match${kd.n > 1 ? 'es' : ''}</span>${kd.k != null ? `<span class="lk-kdbar" title="${kd.k} kills / ${kd.d} deaths"><i style="width:${Math.round(kd.k / Math.max(1, kd.k + kd.d) * 100)}%"></i></span><span class="lk-g-kd"><em>${kd.k.toLocaleString('en-US')}</em> kills &middot; <u>${kd.d.toLocaleString('en-US')}</u> deaths</span>` : ''}` : '<span class="muted">Kills and deaths are not in the match data Leetify returned.</span>';
        const aim = p.aim, ac = aim == null ? '#8793a5' : aim >= 75 ? '#4fb286' : aim >= 60 ? '#5b8def' : aim >= 45 ? '#d1a455' : '#d1556a';
        const tier = aim == null ? '' : aim >= 85 ? 'Elite' : aim >= 70 ? 'Strong' : aim >= 55 ? 'Solid' : aim >= 40 ? 'Average' : 'Developing';
        box.innerHTML = gaugeHTML('lk-kd', 'K/D ratio', kd ? kd.kd.toFixed(2) : '--', kd ? Math.min(100, kd.kd / 2 * 100) : 0, kc, kdInfo)
          + gaugeHTML('lk-aim', 'Aim rating', aim == null ? '--' : String(Math.round(aim)), aim == null ? 0 : aim, ac, aim == null ? '<span class="muted">Leetify has no aim rating for this player.</span>' : `<span class="lk-g-t">${tier}</span><span class="muted">overall aim score out of 100</span><span class="lk-kdbar aim"><i style="width:${aim.toFixed(0)}%"></i></span>`);
      }
    }
    const fm = $('#lkForm');
    if (fm && v.form) {
      const L = { win: ['W', 'w'], loss: ['L', 'l'], tie: ['T', 't'] }, f = v.form;
      fm.innerHTML = f.state === 'loading' ? '<span class="lk-fm-l">Last 5</span><span class="lk-fm-r muted">&hellip;</span>'
        : f.list && f.list.length ? `<span class="lk-fm-l">Last 5</span><span class="lk-fm-r">${f.list.map(o => `<b class="${L[o][1]}">${L[o][0]}</b>`).join('<s>-</s>')}</span>`
        : '<span class="lk-fm-l">Last 5</span><span class="lk-fm-r muted">n/a</span>';
      fm.title = 'Most recent match first (premier, competitive and faceit combined)';
    }
    const xb = $('#lkXh');
    if (xb && v.xh) {
      const x = v.xh;
      const canSet = x.state === 'na' && x.canSet;
      xb.className = 'lk-xh' + (x.state === 'ok' ? '' : x.state === 'loading' ? ' loading' : canSet ? ' na set' : ' na');
      xb.disabled = x.state === 'loading'; xb.innerHTML = xhSvg(x.state === 'ok' ? x.dec : null);
      delete xb.dataset.xh; delete xb.dataset.xhset; delete xb.dataset.xhna;
      if (x.state === 'ok') { xb.dataset.xh = x.code; xb.title = 'Click to copy this crosshair code, then import it in CS2 (Settings > Game > Crosshair > Import)' + (x.src ? ' (source: ' + x.src + ')' : ''); xb.setAttribute('aria-label', 'Copy crosshair code'); }
      else if (canSet) { xb.dataset.xhset = '1'; xb.title = 'No crosshair is published for you yet. Click to paste your share code and publish it on your profile.'; xb.setAttribute('aria-label', 'Add crosshair code'); }
      else { if (x.state === 'na') xb.dataset.xhna = '1'; xb.title = x.state === 'loading' ? 'Loading crosshair...' : 'No crosshair has been published for this player yet.'; }
    }
  }
  /* banned friends: friend list (needs a public list + Steam key) -> GetPlayerBans in chunks of 100 */
  async function frStart(v, d) {
    v.fr = { state: 'loading' }; updFr();
    if (!hasSteamKey()) { v.fr = { state: 'nokey' }; updFr(); return; }
    let ids = [];
    try {
      const r = await steamApi('ISteamUser/GetFriendList/v1', { steamid: v.id, relationship: 'friend' }, { ttl: 300000, definitive: s => s === 401 || s === 403 || s === 404 });
      ids = (((r || {}).friendslist || {}).friends || []).map(f => String(f.steamid)).filter(x => /^\d{17}$/.test(x));
    } catch (e) {
      if (lkv !== v) return;
      if (e && (e.code === 'AUTH' || e.code === 'KEY')) { diag('info', 'app', 'friends: list is private or Steam refused it (HTTP 401/403), this is not an API key problem'); v.fr = e.code === 'KEY' ? { state: 'nokey' } : { state: 'private' }; }
      else v.fr = { state: 'err' };
      updFr(); return;
    }
    if (lkv !== v) return;
    if (!ids.length) { diag('info', 'app', 'friends: list is private or empty'); v.fr = { state: 'private' }; updFr(); return; }
    const capped = ids.slice(0, 1500), chunks = []; for (let i = 0; i < capped.length; i += 100) chunks.push(capped.slice(i, i + 100));
    const acc = { checked: 0, total: ids.length, any: 0, vac: 0, game: 0, trade: 0, comm: 0, failed: 0 };
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const c = chunks[next++];
        try {
          const j = await steamApi('ISteamUser/GetPlayerBans/v1', { steamids: c.join(',') }, { ttl: 600000 });
          ((j || {}).players || []).forEach(p => {
            acc.checked++;
            const vac = !!(p.VACBanned || p.NumberOfVACBans), game = (p.NumberOfGameBans || 0) > 0, trade = !!p.EconomyBan && p.EconomyBan !== 'none', comm = !!p.CommunityBanned;
            if (vac) acc.vac++; if (game) acc.game++; if (trade) acc.trade++; if (comm) acc.comm++;
            if (vac || game || trade || comm) acc.any++;
          });
        } catch (e) { acc.failed += c.length; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (lkv !== v) return;
    v.fr = acc.checked ? Object.assign({ state: 'ok' }, acc) : { state: 'err' };
    diag('info', 'app', 'friends: ' + acc.checked + ' of ' + ids.length + ' checked, ' + acc.any + ' with bans');
    updFr();
  }
  function updFr() {
    const box = $('#lkFr'), f = lkv && lkv.fr; if (!box || !f) return;
    if (f.state === 'loading') { box.innerHTML = `<p class="muted">${invSpin} Checking friends for bans&hellip;</p>`; return; }
    if (f.state === 'nokey') { box.innerHTML = '<p class="muted">A Steam Web API key is needed to read the friends list.</p>'; return; }
    if (f.state === 'private') { box.innerHTML = '<p class="muted">This player\'s friends list is private (or empty), so friends cannot be checked.</p>'; return; }
    if (f.state === 'err') { box.innerHTML = '<p class="muted">Friend bans could not be loaded right now.</p>'; return; }
    const chips = [['VAC', f.vac], ['Game ban', f.game], ['Trade ban', f.trade], ['Community', f.comm]].filter(x => x[1] > 0).map(x => `<span class="fr-chip"><b>${x[1]}</b>${x[0]}</span>`).join('');
    box.innerHTML = `<div class="fr-card ${f.any ? 'bad' : 'clean'}"><div class="fr-num"><b>${f.any}</b></div><div class="fr-b"><span class="fr-t">${f.any ? (f.any === 1 ? 'friend with a ban' : 'friends with bans') : 'No banned friends'}</span><span class="muted">${f.any ? `out of ${f.checked.toLocaleString('en-US')} friends checked` : `${f.checked.toLocaleString('en-US')} friends checked, none flagged`}${f.failed || f.total > f.checked + f.failed ? ' (partial: some batches failed or the list is very large)' : ''}</span>${chips ? `<span class="fr-chips">${chips}</span>` : ''}</div></div>`;
  }

  async function tmStart(v, d) {
    const lf = d.lf || {};
    v.tm = { state: 'loading', list: [] }; updTm();
    if (d.lfState !== 'ok') { v.tm = { state: 'none', list: [] }; updTm(); return; }
    try {
      const matches = (await loadMatches(v, d)).full;
      if (lkv !== v) return;
      const agg = {};
      (Array.isArray(matches) ? matches : []).forEach(m => {
        const st = mPlayers(m), me = st.find(x => pidOf(x) === v.id);
        if (!me) return;
        const team = teamOf(me); if (team == null) return;
        const res = mOutcome(m, v.id);   // tolerant outcome (win/victory/loss/defeat, or the team scores)
        st.forEach(x => {
          const sid = pidOf(x); if (!sid || sid === v.id || teamOf(x) !== team) return;
          const a = agg[sid] || (agg[sid] = { id: sid, name: x.name || x.nickname || '', n: 0, w: 0, l: 0, k: 0 });
          a.n++; if (res === 'win') { a.w++; a.k++; } else if (res === 'loss') { a.l++; a.k++; } else if (res === 'tie') a.k++;
          if (!a.name && (x.name || x.nickname)) a.name = x.name || x.nickname;
        });
      });
      let list = Object.values(agg), counts = false;
      if (list.length < 6) {
        const have = new Set(list.map(t => t.id));
        (Array.isArray(lf.recent_teammates) ? lf.recent_teammates : []).forEach(t => {
          const sid = String((t && t.steam64_id) || ''); if (!/^\d{17}$/.test(sid) || sid === v.id || have.has(sid)) return;
          have.add(sid);
          const n = Number(t.recent_matches_count != null ? t.recent_matches_count : t.recent_matches != null ? t.recent_matches : t.matches_count != null ? t.matches_count : t.count) || 1;
          list.push({ id: sid, name: '', n, w: Number(t.wins) || 0, l: Number(t.losses) || 0, k: (Number(t.wins) || 0) + (Number(t.losses) || 0) });
        });
        counts = !!list.length && !list.some(t => t.k);
      }
      diag('info', 'app', 'teammates: ' + Object.keys(agg).length + ' from ' + (Array.isArray(matches) ? matches.length : 0) + ' match(es), ' + list.length + ' after top-up');
      list = list.sort((a, b) => b.n - a.n || (b.k ? b.w / b.k : 0) - (a.k ? a.w / a.k : 0)).slice(0, 6);   // repeat teammates first, then the rest, 6 in total
      if (list.length && hasSteamKey()) {                      // avatars + persona names, one request
        try {
          const sm = await steamApi('ISteamUser/GetPlayerSummaries/v2', { steamids: list.map(t => t.id).join(',') });
          if (lkv !== v) return;
          ((sm.response || {}).players || []).forEach(p => { const t = list.find(x => x.id === p.steamid); if (t) { t.name = p.personaname || t.name; t.avatar = p.avatarfull || p.avatarmedium || p.avatar || ''; } });
        } catch (e) { /* names from Leetify, no avatars */ }
      }
      v.tm = { state: list.length ? 'ok' : 'empty', list, counts };
    } catch (e) { if (lkv !== v) return; v.tm = { state: 'err', list: [] }; }
    updTm();
  }
  function updTm() {
    const box = $('#lkTm'), t = lkv && lkv.tm; if (!box || !t) return;
    if (t.state === 'loading') { box.innerHTML = `<p class="muted">${invSpin} Loading teammates&hellip;</p>`; return; }
    if (t.state === 'none') { box.innerHTML = '<p class="muted">Teammate stats need Leetify match data, which is not available for this player.</p>'; return; }
    if (t.state === 'err') { box.innerHTML = '<p class="muted">Teammates could not be loaded right now.</p>'; return; }
    if (t.state === 'empty') { box.innerHTML = '<p class="muted">No teammates found in this player\'s recent Leetify matches.</p>'; return; }
    box.innerHTML = `<div class="tm-list">${t.list.map((m, i) => {
      const wr = m.k ? Math.round(m.w / m.k * 100) : null, nm = m.name || ('Player ' + m.id.slice(-6)), ini = esc((nm[0] || '?').toUpperCase());
      return `<button type="button" class="tm" data-tm-look="${esc(m.id)}" title="Look up ${esc(nm)}">
        <span class="tm-av">${m.avatar && /^https:\/\//i.test(m.avatar) ? `<img src="${esc(m.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ifb="1">` : `<span class="avatar">${ini}</span>`}</span>
        <span class="tm-b"><span class="tm-n">${esc(nm)}</span><span class="tm-s"><span>${m.n} matches together</span><span>${wr == null ? 'WR n/a' : 'WR ' + wr + '% (' + m.w + 'W - ' + m.l + 'L)'}</span></span>${wr == null ? '' : `<span class="tm-bar"><i style="width:${wr}%"></i></span>`}</span>
        <span class="tm-rank">#${i + 1}</span></button>`;
    }).join('')}</div><p class="muted">Counted from the recent matches Leetify returns${t.counts ? ' (match details were unavailable, so win rates are not shown)' : ''}. Click a teammate to look them up.</p>`;
  }

  const MSG_TS = /^\s*(?:\d{1,4}[\/.-]\d{1,2}(?:[\/.-]\d{1,4})?\s*[-,]?\s*)?(?:\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*[-:]?\s*)?/;
  const MSG_TAG = /^(?:\[(?:all|team|ct|t|spec|dead|all\s*\(dead\))\]|\((?:terrorist|counter-terrorist|spectator)\))\s*(.+?)(?:\s*[\ufe6b@]\s*[^:]{1,40})?\s*:\s+(.+)$/i;
  function msgAnalyze(text, nameFilter) {
    const lines = String(text || '').split(/\r?\n/), chat = [];
    lines.forEach(raw => { const m = MSG_TAG.exec(raw.replace(MSG_TS, '').trim()); if (m) chat.push({ who: m[1].trim(), msg: m[2].trim() }); });
    const mode = chat.length ? 'chat' : 'plain';
    let msgs = mode === 'chat' ? chat : lines.map(l => ({ who: '', msg: l.trim() })).filter(x => x.msg);
    if (nameFilter && mode === 'chat') msgs = msgs.filter(x => x.who.toLowerCase().includes(nameFilter));
    const map = new Map();
    msgs.forEach(x => {
      const key = x.msg.toLowerCase().replace(/\s+/g, ' ').trim(); if (!key) return;
      const e = map.get(key) || { t: x.msg.replace(/\s+/g, ' '), n: 0 }; e.n++; map.set(key, e);
    });
    const rows = [...map.values()].sort((a, b) => b.n - a.n).slice(0, 10);
    return { mode, total: msgs.length, unique: map.size, rows, filtered: !!(nameFilter && mode === 'chat'), lines: lines.length };
  }
  function msgRender(v) {
    const box = $('#msgRes'), r = v && v.msg; if (!box) return;
    if (!r) { box.innerHTML = ''; return; }
    if (!r.total) { box.innerHTML = `<p class="muted">${r.lines ? (r.filtered ? 'No chat lines from that player were found. Clear the name filter or check the spelling.' : 'No messages found.') : 'Paste some text or choose a file first.'}</p>`; return; }
    const max = r.rows[0].n;
    box.innerHTML = `<p class="muted">Analysed <b>${r.total.toLocaleString()}</b> message${r.total > 1 ? 's' : ''} (${r.unique.toLocaleString()} unique)${r.mode === 'chat' ? ' from console chat lines' : ' - one message per line'}${r.filtered ? ' - filtered by player' : ''}.</p>`
      + r.rows.map((x, i) => `<div class="msg-r"><i style="width:${Math.max(4, Math.round(x.n / max * 100))}%"></i><span class="msg-n">#${i + 1}</span><span>${esc(x.t.length > 160 ? x.t.slice(0, 157) + '...' : x.t)}</span><em>&times;${x.n.toLocaleString()}</em></div>`).join('');
  }
  const msgFromApi = lf => {                    // only used if a data source ever returns raw chat (none of the current ones do)
    const a = lf && (lf.chat_messages || lf.chat); if (!Array.isArray(a) || !a.length) return '';
    return a.map(x => typeof x === 'string' ? x : x && (x.message || x.text) || '').filter(Boolean).join('\n');
  };

  /* Valve's real Trust Factor is hidden, so this is an estimate from public signals only.
     Gentler than before: logarithmic / square-root curves so ordinary accounts are not punished, bans scale with recency. */
  function lkTrust(d) {
    if (flOf(d.id)) return { score: 0, known: 3, f: [{ label: 'Flagged as a cheater by MWAY LABS', good: false, p: -100 }], tier: 'Cheater', col: '#d1556a' };
    const f = []; let s = 42, known = 0, capped = false;
    const add = (p, label, good) => { s += p; known++; f.push({ label, good, p }); };
    if (d.created) { const y = (Date.now() / 1000 - d.created) / 31557600, p = Math.min(20, Math.round(6 * Math.sqrt(Math.max(0, y)))); add(p, `Account age ${y.toFixed(1)}y`, p >= 8); }
    if (d.level != null) { const p = Math.min(10, Math.round(2.2 * Math.log2(d.level + 1))); add(p, `Steam level ${d.level}`, p >= 5); }
    if (d.hours != null) { const p = Math.min(15, Math.round(4.1 * Math.log10(1 + d.hours))); add(p, `${d.hours.toLocaleString()}h in CS2`, p >= 8); }
    if (d.pub === true) add(4, 'Public profile', true); else if (d.pub === false) add(-2, 'Private profile', false);
    const lf = d.lf || {}, rk = lf.ranks || {};
    if (rk.premier) add(4, 'Premier rated', true);
    if (rk.faceit) add(rk.faceit >= 5 ? 6 : 4, 'Faceit account', true);
    const tm = Number(lf.total_matches) || 0;
    if (tm) add(Math.min(6, Math.round(2.5 * Math.log10(1 + tm))), `${tm.toLocaleString()} tracked matches`, tm >= 50);
    if (d.hltv > 0) add(d.hltv >= 1.1 ? 4 : d.hltv >= 1 ? 2 : d.hltv >= 0.85 ? 0 : -2, `HLTV ${d.hltv.toFixed(2)}`, d.hltv >= 0.95);
    const b = d.bans;
    if (b) {
      const old = (b.DaysSinceLastBan || 0) > 730;
      if (b.VACBanned || b.NumberOfVACBans) { add(old ? -28 : -45, 'VAC ban' + (b.NumberOfVACBans > 1 ? 's' : ''), false); capped = true; }
      if (b.NumberOfGameBans) { add(old ? -22 : -30, 'Game ban', false); capped = true; }
      if (b.CommunityBanned) add(-6, 'Community ban', false);
      if (b.EconomyBan && b.EconomyBan !== 'none') add(/ban/i.test(b.EconomyBan) ? -8 : -3, /ban/i.test(b.EconomyBan) ? 'Trade ban' : 'Trade probation', false);
    }
    const pb = Array.isArray(lf.bans) ? lf.bans.length : 0;
    if (pb) { add(-Math.min(25, pb * 12), `${pb} platform ban${pb > 1 ? 's' : ''}`, false); capped = true; }
    let score = Math.max(0, Math.min(100, Math.round(s)));
    if (capped) score = Math.min(score, 45);
    const tiers = [[80, 'Excellent', '#5b8def'], [62, 'High', '#4fb286'], [42, 'Moderate', '#d1a455'], [25, 'Low', '#d98c4a'], [0, 'Very low', '#d1556a']];
    const t = tiers.find(x => score >= x[0]);
    return { score, known, f, tier: t[1], col: t[2] };
  }

  /* ---- Inventory: Steam inventory + prices (CSFloat when a key is saved, otherwise Steam Market) ---- */
  const PX_TTL = 6 * 3600 * 1000;
  let px = load('mway_px', {}), pxTimer = 0, bulkData = null, bulkP = null;
  const pxSave = () => {
    clearTimeout(pxTimer);
    pxTimer = setTimeout(() => {
      const k = Object.keys(px);
      if (k.length > 800) k.sort((a, b) => px[a].t - px[b].t).slice(0, k.length - 800).forEach(n => delete px[n]);
      try { localStorage.setItem('mway_px', JSON.stringify(px)); } catch { /* storage full: prices stay in memory */ }
    }, 1500);
  };
  const itemImg = i => i.icon ? `https://community.cloudflare.steamstatic.com/economy/image/${i.icon}/128fx128f` : '';

  const INV_GAP_MS = 2000, INV_WAITS = [6, 12, 20, 30, 45, 60], INV_LOCAL_KEY = 'mway_invc2';
  const INV_LOCAL_FRESH = 5 * 60 * 1000, INV_LOCAL_KEEP = 7 * 24 * 3600 * 1000;
  let invQueue = Promise.resolve(), invNextAt = 0, invLegacyOff = 0;
  const invSlot = fn => {
    const run = invQueue.then(async () => { const w = invNextAt - Date.now(); if (w > 0) await sleep(w); try { return await fn(); } finally { invNextAt = Date.now() + INV_GAP_MS; } });
    invQueue = run.catch(() => {}); return run;
  };
  /* One inventory page: through the bridge first; if Steam is limiting the Worker's IP, once through the public proxies. */
  async function invReq(url, defin, alive) {
    if (alive && !alive()) throw netErr('CANCEL', 'cancelled');
    const base = { json: true, ttl: 180000, timeout: 14000, total: 20000, definitive: defin };
    try { return await invSlot(() => proxyReq(url, base)); }
    catch (e) {
      if (e.code !== 'RATE' || !bridgeUrl() || (alive && !alive()) || Date.now() < invLegacyOff) throw e;
      try { return await invSlot(() => proxyReq(url, Object.assign({}, base, { legacy: true, ttl: 0, timeout: 9000, total: 12000 }))); }
      catch (e2) { invLegacyOff = Date.now() + 120000; throw e; }   // keep the Worker's Retry-After; skip the public proxies for 2 min
    }
  }
  /* Saved copy of the last good inventory per SteamID (3 newest, only if small enough for localStorage; ignored after 7 days). */
  const invLocalGet = id => { const all = load(INV_LOCAL_KEY, {}); const e = all && all[id]; return e && Array.isArray(e.items) && Date.now() - e.t < INV_LOCAL_KEEP ? e : null; };
  function invLocalPut(id, items) {
    try {
      const all = load(INV_LOCAL_KEY, {}) || {}; all[id] = { t: Date.now(), items };
      Object.keys(all).sort((x, y) => all[y].t - all[x].t).slice(3).forEach(k => delete all[k]);
      const txt = JSON.stringify(all); if (txt.length < 1500000) localStorage.setItem(INV_LOCAL_KEY, txt);
    } catch { /* storage full or blocked: no saved copy */ }
  }
  const invSig = items => (items || []).map(i => i.name + ':' + i.qty).sort().join('|');
  async function invFetchLive(id, alive) {
    const defin = (s, t) => s === 404 || ((s === 403 || s === 500) && /^\s*(null|\{)/.test(t || ''));
    let staleAt = 0;
    const assets = [], descs = {}, props = {}; let start = '', pages = 0;
    do {
      const url = `https://steamcommunity.com/inventory/${id}/730/2?l=english&count=1000` + (start ? '&start_assetid=' + start : '');
      let r;
      try { r = await invReq(url, defin, alive); } catch (e) { if (pages && e.code === 'RATE') break; throw e; }
      if (r.stale) staleAt = r.stale;   // the Worker served a saved copy
      if (r.status !== 200 || !r.json) { if (!pages) return null; break; }
      const j = r.json;
      if (j.success === false || j.success === 0) { if (!pages) return null; break; }
      (j.assets || []).forEach(a => assets.push(a));
      (j.asset_properties || []).forEach(e => {
        if (!e || e.assetid == null) return;
        const o = {};
        (e.asset_properties || []).forEach(p => {
          if (!p) return;
          const pid = +p.propertyid, nm = String(p.name || '').toLowerCase();
          if (pid === 2 || /wear|float/.test(nm)) { const f = parseFloat(p.float_value != null ? p.float_value : p.string_value); if (Number.isFinite(f) && f >= 0 && f <= 1) o.f = f; }
          else if (pid === 1 || /pattern/.test(nm)) { const n = parseInt(p.int_value != null ? p.int_value : p.string_value, 10); if (Number.isFinite(n)) o.s = n; }
          else if (pid === 6 || /certificate|inspect/.test(nm)) { if (p.string_value) o.c = String(p.string_value); }
        });
        props[String(e.assetid)] = o;
      });
      (j.descriptions || []).forEach(x => { descs[x.classid + '_' + x.instanceid] = x; });
      start = j.more_items ? String(j.last_assetid || '') : ''; pages++;
      if (start && pages < 3) await sleep(900);
    } while (start && pages < 3);
    const g = new Map();
    assets.forEach(a => {
      const x = descs[a.classid + '_' + a.instanceid] || descs[a.classid + '_0']; if (!x) return;
      const nm = x.market_hash_name || x.name; let it = g.get(nm);
      if (!it) {
        const rar = (x.tags || []).find(t => t.category === 'Rarity');
        const col = /^[0-9a-f]{6}$/i.test(x.name_color || '') ? '#' + x.name_color : rar && /^[0-9a-f]{6}$/i.test(rar.color || '') ? '#' + rar.color : '';
        it = { name: nm, disp: x.name || nm, icon: x.icon_url || '', color: col, marketable: !!x.marketable, type: x.type || '', qty: 0, ids: [], links: [], pr: [], link: (x.actions && x.actions[0] && x.actions[0].link) || '' };
        g.set(nm, it);
      }
      it.qty += Number(a.amount) || 1; it.ids.push(a.assetid);
      { const p = props[String(a.assetid)]; it.pr.push(p && (p.f != null || p.s != null || p.c) ? (p.f != null ? { f: p.f, s: p.s } : { s: p.s, c: p.c }) : null); }
      it.links.push((x.actions && x.actions[0] && x.actions[0].link) || it.link || '');   // each asset keeps the link of ITS description (the D code differs between stickered / patterned copies)
    });
    const out = [...g.values()]; if (staleAt) out.staleAt = staleAt;
    return out;
  }

  const bulkPrice = (b, n) => {
    const e = b && b[n]; if (e == null) return null;
    if (typeof e === 'number') return e > 0 ? e : null;
    const s = e.steam || e, v = s.last_24h != null ? s.last_24h : s.last_7d != null ? s.last_7d : s.last_30d != null ? s.last_30d : s.last_90d;
    return typeof v === 'number' && v > 0 ? v : null;
  };
  /* Community mirror of Steam Market prices: one request instead of one per item (Steam limits per-item lookups to ~20/min). */
  function pxBulk() {
    if (bulkData) return Promise.resolve(bulkData);
    if (!bulkP) bulkP = proxyReq('https://prices.csgotrader.app/latest/steam.json', { json: true, ttl: 6 * 3600 * 1000, timeout: 25000, total: 30000, stagger: 6000 })
      .then(r => (bulkData = r.json)).catch(() => { bulkP = null; return null; });
    return bulkP;
  }
  async function pxSteam(n) {
    const r = await proxyReq(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodeURIComponent(n)}`, { json: true, timeout: 8000, total: 12000, steamApi: true, rl: 'market', definitive: s => s === 404 });
    const j = r.json, s = j && (j.lowest_price || j.median_price);
    const v = s ? parseFloat(String(s).replace(/[^0-9.]/g, '')) : 0;
    return { p: v > 0 ? v : 0, s: 'steam' };
  }
  /* ---- CSFloat ---- */
  let csfPub = null, csfPushedAt = 0;
  const floatKey = () => (settings.steamCfg.floatKey || '').trim();
  const hasFloat = () => !!floatKey() || !!(bridgeCaps && bridgeCaps.url === bridgeUrl() && (bridgeCaps.csfloatKey || bridgeCaps.csfloatPrices)) || !!(csfPub && csfPub.ok);
  /* Stored key goes out as the Authorization header (direct first, then through the bridge, which forwards it).
     With no key stored in this browser the request skips the direct route and the Worker adds its CSFLOAT_API_KEY secret. */
  const floatReq = (url, o = {}) => { const k = floatKey(); return proxyReq(url, Object.assign({ json: true, direct: !!k, headers: k ? { Authorization: k } : undefined, timeout: 8000, total: 11000 }, o)); };
  let csfBulkData = null, csfBulkAt = 0;
  const csfToUsd = cents => { const m = {}; for (const n in cents) if (cents[n] > 0) m[n] = cents[n] / 100; return m; };
  /* Everybody: the Worker's shared price snapshot (GET /csfloat/prices). No CSFloat key is needed in the visitor's browser. */
  async function csfViaWorker() {
    const b = bridgeUrl(); if (!b) throw netErr('NOKEY', 'no bridge configured');
    const r = await fetchText(b + '/csfloat/prices', {}, 25000);
    let j = null; try { j = JSON.parse(r.text); } catch { /* not JSON */ }
    if (r.status === 200 && j && j.ok && j.prices && Object.keys(j.prices).length) { csfPub = { ok: true, t: j.t, n: j.n }; return j.prices; }
    csfPub = { ok: false };
    throw netErr(r.status === 404 || r.status === 403 ? 'NOKEY' : 'NET', (j && j.error) || 'HTTP ' + r.status);
  }
  /* A key in this browser (admin), or one the Worker adds itself: the CSFloat price list in cents. */
  async function csfViaApi() {
    if (!floatKey() && !(bridgeCaps && bridgeCaps.csfloatKey)) throw netErr('NOKEY', 'no CSFloat key anywhere');
    const r = await floatReq('https://csfloat.com/api/v1/listings/price-list', { ttl: PX_TTL, timeout: 20000, total: 26000, stagger: 5000 });
    const arr = Array.isArray(r.json) ? r.json : r.json && (r.json.data || r.json.prices || r.json.listings);
    if (!Array.isArray(arr)) throw netErr('NET', 'CSFloat price list unavailable');
    const m = {};
    arr.forEach(e => { const n = e && e.market_hash_name, c = e && (e.min_price != null ? e.min_price : e.price); if (n && c > 0) m[n] = Math.round(c); });   // CSFloat prices are in cents
    if (!Object.keys(m).length) throw netErr('NET', 'CSFloat price list was empty');
    return m;
  }
  /* Admin with a key: share the list with the Worker so visitors get prices even before the key itself reached the Worker. */
  async function csfPushSnapshot(cents) {
    const b = bridgeUrl(), tok = gsToken();
    if (!isAdmin() || !floatKey() || !b || !tok || Date.now() - csfPushedAt < 45 * 60e3) return;
    if (bridgeCaps && bridgeCaps.csfloatPricesAt && Date.now() - bridgeCaps.csfloatPricesAt < 45 * 60e3) return;
    csfPushedAt = Date.now();
    try {
      const res = await fetchText(b + '/admin/csfloat-prices', { method: 'PUT', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ prices: cents }) }, 40000);
      diag(res.status === 200 ? 'ok' : 'warn', 'state', 'CSFloat price snapshot shared with the bridge: HTTP ' + res.status);
      if (res.status === 200) probeBridge(true).catch(() => {});
    } catch { csfPushedAt = 0; }
  }
  async function csfBulk() {
    if (csfBulkData && Date.now() - csfBulkAt < PX_TTL) return csfBulkData;
    const local = !!floatKey(), order = local ? [csfViaApi, csfViaWorker] : [csfViaWorker, csfViaApi], errs = [];
    let cents = null, viaApi = false;
    for (const f of order) { try { cents = await f(); viaApi = f === csfViaApi; break; } catch (e) { errs.push(e); } }
    if (!cents) throw errs.find(e => e.code === 'AUTH' && local) || errs.find(e => e.code === 'NOKEY') || errs[errs.length - 1] || netErr('NET', 'CSFloat price list unavailable');
    csfBulkData = csfToUsd(cents); csfBulkAt = Date.now();
    if (viaApi) csfPushSnapshot(cents).catch(() => {});
    return csfBulkData;
  }
  async function pxCsfloat(n) {
    const r = await floatReq(`https://csfloat.com/api/v1/listings?market_hash_name=${encodeURIComponent(n)}&sort_by=lowest_price&limit=1&type=buy_now`, { ttl: 600000 });
    const arr = Array.isArray(r.json) ? r.json : r.json && r.json.data, l = arr && arr[0];
    return l && l.price > 0 ? l.price / 100 : 0;
  }

  /* Cached prices keep both sources: { steam, t, csf, tc }. Older single-price entries { p, s, t } are migrated on read. */
  const pxNorm = c => !c ? {} : c.p != null ? (c.s === 'csfloat' ? { csf: c.p, tc: c.t } : { steam: c.p, t: c.t }) : c;
  const pxFresh = t => !!t && Date.now() - t < PX_TTL;
  const unitPx = p => (p && (p.steam || (hasFloat() && p.csf))) || 0;   // value used for sorting and the "top item"

  function invTotals(v) {
    const F = hasFloat();
    let steam = 0, csf = 0, ps = 0, pc = 0, unique = 0, top = null;
    v.inv.items.forEach(i => {
      if (!i.marketable) return; unique++;
      const p = v.price[i.name]; if (!p) return;
      if (p.steam > 0) { ps++; steam += p.steam * i.qty; }
      if (F && p.csf > 0) { pc++; csf += p.csf * i.qty; }
      const u = unitPx(p); if (u && (!top || u > top.p)) top = { name: i.disp, p: u };
    });
    return { steam, csf, ps, pc, unique, top };
  }
  async function invPrice(v) {
    v.inv.partial = false; v.inv.stNote = '';
    const names = v.inv.items.filter(i => i.marketable).map(i => i.name);
    const F = hasFloat();
    const give = (n, patch) => { px[n] = Object.assign(pxNorm(px[n]), patch); v.price[n] = Object.assign({}, px[n]); pxSave(); };
    names.forEach(n => {                      // seed from the local cache (fresh fields only)
      const c = pxNorm(px[n]), e = {};
      if (c.steam > 0 && pxFresh(c.t)) { e.steam = c.steam; e.t = c.t; }
      if (c.csf > 0 && pxFresh(c.tc)) { e.csf = c.csf; e.tc = c.tc; }
      if (e.steam || e.csf) v.price[n] = e;
    });
    v.inv.csfNote = '';
    updInv(); updGrid();

    /* Steam Market: community price list in one request, then per-item lookups for whatever is still missing. */
    const steamStage = async () => {
      let todo = names.filter(n => !(v.price[n] && v.price[n].steam > 0));
      if (!todo.length) return;
      v.inv.msg = 'Loading Steam Market price list...'; updInv();
      const b = await Promise.race([pxBulk(), sleep(10000).then(() => null)]);
      if (lkv !== v) return;
      v.inv.msg = '';
      if (b) { todo.forEach(n => { const p = bulkPrice(b, n); if (p) give(n, { steam: p, t: Date.now() }); }); todo = todo.filter(n => !(v.price[n] && v.price[n].steam > 0)); }
      updInv(); updGrid();
      if (!todo.length) return;
      /* Per-item fallback: one lookup at a time, ~3 s apart (Steam allows ~20 a minute), capped. On a 429 it waits 15 / 30 / 45 s
         with a live countdown and retries; only after that does it stop and offer a "Retry prices" button. Comments and the
         inventory are untouched by this (it has its own 'market' rate-limit scope). */
      const CAP = 30, WAITS = [15, 30, 45];
      todo.sort((x, y) => (v.inv.items.find(i => i.name === y) || { qty: 0 }).qty - (v.inv.items.find(i => i.name === x) || { qty: 0 }).qty);
      if (todo.length > CAP) { v.inv.stNote = `Steam Market priced the ${CAP} most common items only (${todo.length - CAP} more are unpriced). CSFloat prices are unaffected.`; todo = todo.slice(0, CAP); }
      for (let i = 0; i < todo.length && lkv === v; i++) {
        let got = null;
        for (let a = 0; a <= WAITS.length && lkv === v; a++) {
          try { got = await pxSteam(todo[i]); break; }
          catch (e) {
            if (e.code !== 'RATE') break;                          // any other failure: skip this item
            if (a === WAITS.length) { v.inv.partial = true; v.inv.msg = ''; updInv(); return; }
            const w = Math.max(WAITS[a], Math.min(90, e.retryAfter || 0));
            for (let t = w; t > 0 && lkv === v; t--) { v.inv.msg = `Steam is limiting market price lookups - retrying in ${t}s...`; updInv(); await sleep(1000); }
          }
        }
        if (got && got.p > 0) give(todo[i], { steam: got.p, t: Date.now() });
        v.inv.msg = ''; updInv(); updGrid();
        await sleep(3200);
      }
    };

    /* CSFloat: the whole price list in one request; if that is unavailable, the most valuable items are priced one by one. */
    const csfStage = async () => {
      if (!F) return;
      const todo = names.filter(n => !(v.price[n] && v.price[n].csf > 0));
      if (!todo.length) return;
      v.inv.cmsg = 'Loading CSFloat prices...'; updInv();
      let list = null, err = null;
      try { list = await csfBulk(); } catch (e) { err = e; }
      if (lkv !== v) return;
      if (list) todo.forEach(n => { if (list[n] > 0) give(n, { csf: list[n], tc: Date.now() }); });
      else if (err && err.code === 'AUTH') v.inv.csfNote = isAdmin() ? 'CSFloat rejected the API key. Use "Re-test key" in Admin > Steam API Provisioning.' : 'CSFloat prices are not available right now.';
      else if (err && err.code === 'NOKEY') v.inv.csfNote = isAdmin() ? 'The Worker has no CSFloat prices yet: save your CSFloat key in Admin so it is sent to the Worker (visitors then get prices automatically).' : 'CSFloat prices are not available right now.';
      else {
        const order = todo.slice().sort((x, y) => ((v.price[y] && v.price[y].steam) || 0) - ((v.price[x] && v.price[x].steam) || 0)).slice(0, 80);
        let idx = 0, halt = false;
        const worker = async () => {
          while (!halt && idx < order.length && lkv === v) {
            const n = order[idx++];
            try { const c = await pxCsfloat(n); if (c > 0) give(n, { csf: c, tc: Date.now() }); }
            catch (e) { halt = true; v.inv.csfNote = e.code === 'AUTH' ? (isAdmin() ? 'CSFloat rejected the API key. Use "Re-test key" in Admin > Steam API Provisioning.' : 'CSFloat prices are not available right now.') : e.code === 'RATE' ? 'CSFloat rate limit reached: some items have no CSFloat price yet.' : 'CSFloat could not be reached: some items have no CSFloat price.'; }
            updInv(); if (idx % 4 === 0) updGrid();
            await sleep(500);
          }
        };
        await Promise.all([worker(), worker()]);
        if (!halt && todo.length > order.length) v.inv.csfNote = `CSFloat priced the ${order.length} most valuable items only (its price list was unavailable).`;
      }
      v.inv.cmsg = '';
    };
    await Promise.all([steamStage(), csfStage().catch(() => { v.inv.cmsg = ''; })]);
    if (lkv !== v) return;
    v.inv.pricing = false; v.inv.msg = ''; v.inv.cmsg = ''; updInv(); updGrid();
  }
  async function invStart(v) {
    const run = v.invRun = (v.invRun || 0) + 1, alive = () => lkv === v && v.invRun === run;
    const saved = invLocalGet(v.id);
    v.inv = { state: 'loading', items: [], msg: '', wait: '', pricing: false, partial: false };
    if (!saved) { updInv(); return invRefresh(v, false, alive); }
    const young = Date.now() - saved.t < INV_LOCAL_FRESH;
    v.inv.items = saved.items; v.inv.state = 'ok'; v.inv.pricing = true;
    v.inv.staleNote = young ? '' : 'Showing a saved copy from ' + fmtTime(new Date(saved.t).toISOString()) + ' while a fresh one is requested from Steam.';
    updInv(); updGrid();
    const priced = invPrice(v).catch(() => {});
    if (!young) invRefresh(v, true, alive);
    await priced;
  }
  /* Background refresh: one attempt per cycle, a short countdown between cycles, never blocks anything else. */
  async function invRefresh(v, haveSaved, alive) {
    const say = txt => {   // updates one text node; rebuilds the box only when the note does not exist yet
      if (!alive()) return;
      if (v.inv.state === 'ok') v.inv.staleNote = txt; else v.inv.wait = txt;
      const n = $('#invNote'); if (n) n.textContent = txt; else updInv();
    };
    const savedAt = () => { const e = invLocalGet(v.id); return e ? fmtTime(new Date(e.t).toISOString()) : ''; };
    for (let a = 0; alive(); a++) {
      let items = null, err = null;
      try { items = await invFetchLive(v.id, alive); } catch (e) { err = e; }
      if (!alive()) return;
      if (!err) {
        if (!items) { v.inv.state = 'private'; v.inv.pricing = false; v.inv.staleNote = ''; updInv(); return; }
        const staleAt = items.staleAt || 0;                       // the Worker answered with a saved copy because Steam is limiting
        if (!staleAt) invLocalPut(v.id, items);
        const changed = v.inv.state !== 'ok' || invSig(items) !== invSig(v.inv.items);
        if (changed) { v.inv.items = items; v.inv.state = 'ok'; v.inv.pricing = true; v.inv.wait = ''; }
        v.inv.staleNote = staleAt ? 'Showing a saved copy from ' + fmtTime(new Date(staleAt).toISOString()) + '. Steam is limiting the server, a fresh copy is requested automatically.' : '';
        haveSaved = true; updInv();
        if (changed) { updGrid(); invPrice(v).catch(() => {}); }
        if (!staleAt) return;
        err = netErr('RATE', 'saved copy served', { retryAfter: 0 });   // keep polling quietly until a live copy arrives
      }
      if (err.code === 'CANCEL') return;
      if (err.code !== 'RATE') {
        if (v.inv.state === 'ok') { v.inv.staleNote = 'Could not refresh from Steam (' + err.message + '). Showing the saved copy.'; updInv(); }
        else { v.inv.state = 'err'; v.inv.pricing = false; v.inv.msg = err.message; updInv(); }
        return;
      }
      const wait = Math.min(120, Math.max(err.retryAfter || 0, INV_WAITS[Math.min(a, INV_WAITS.length - 1)]) + Math.floor(Math.random() * 3));
      diag('warn', 'net', `inventory rate limited, retrying in ${wait}s (attempt ${a + 1} of ${INV_WAITS.length})`);
      if (a >= INV_WAITS.length - 1) {
        if (v.inv.state === 'ok') { v.inv.staleNote = 'Showing a saved copy from ' + (savedAt() || 'earlier') + '. Steam is still rate limiting inventory requests; search again in a few minutes for fresh data.'; updInv(); }
        else { v.inv.state = 'err'; v.inv.pricing = false; v.inv.msg = 'Steam is still limiting inventory requests. Profile data and comments are not affected, press Retry in a minute.'; updInv(); }
        return;
      }
      for (let t = wait; t > 0; t--) {
        if (!alive()) return;
        if (v.inv.state === 'ok') say('Showing a saved copy from ' + (savedAt() || 'earlier') + '. Steam is limiting lookups, asking again in ' + t + 's.');
        else { if (v.inv.state !== 'wait') { v.inv.state = 'wait'; updInv(); } say('Retrying automatically in ' + t + 's (attempt ' + (a + 2) + ' of ' + INV_WAITS.length + ').'); }
        await sleep(1000);
      }
    }
  }

  /* ---- Steam profile comments (own request path, paginated 10 at a time, retries on its own, never waits for the inventory) ---- */
  const COM_PAGE = 10;
  function comParse(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    return [...doc.querySelectorAll('.commentthread_comment')].map(c => {
      const ts = c.querySelector('.commentthread_comment_timestamp'), av = c.querySelector('.playerAvatar img, .commentthread_comment_avatar img');
      const a = c.querySelector('.commentthread_author_link'), src = av ? av.getAttribute('src') || '' : '';
      const m = {
        key: c.id || '',
        name: ((c.querySelector('.commentthread_comment_author bdi') || a || {}).textContent || 'Unknown').trim(),
        time: ts ? (ts.getAttribute('title') || ts.textContent || '').trim() : '',
        text: ((c.querySelector('.commentthread_comment_text') || {}).textContent || '').trim(),
        avatar: /^https:\/\/[^/]*steamstatic\.com\//i.test(src) || /^https:\/\/avatars\./i.test(src) ? src : '',
        link: a && /^https:\/\/steamcommunity\.com\//i.test(a.getAttribute('href') || '') ? a.getAttribute('href') : ''
      };
      if (!m.key) m.key = m.name + '|' + m.time + '|' + m.text.slice(0, 40);
      return m;
    }).filter(c => c.text);
  }
  async function comPage(v, start) {
    let last;
    for (let a = 0; a < 3; a++) {
      try {
        const r = await proxyReq(`https://steamcommunity.com/comment/Profile/render/${v.id}/-1/?start=${start}&count=${COM_PAGE}`, { json: true, ttl: 120000, timeout: 9000, total: 14000, check: j => !!j && typeof j === 'object' });
        return r.json;
      } catch (e) {
        last = e; if (lkv !== v || e.code === 'AUTH' || a === 2) break;
        const w = e.code === 'RATE' ? Math.min(20, Math.max(e.retryAfter || 0, 4 * (a + 1))) : 1.5 * (a + 1);
        if (v.com && v.com.state === 'loading') { v.com.note = e.code === 'RATE' ? `Steam is limiting comment requests, retrying in ${Math.ceil(w)}s\u2026` : 'Retrying comments\u2026'; updTabs(); }
        await sleep(w * 1000);
      }
    }
    throw last;
  }
  async function comStart(v) {
    v.com = { state: 'loading', list: [], total: 0, next: 0, busy: false, err: '', note: '' }; updTabs();
    try {
      const j = await comPage(v, 0);
      if (lkv !== v) return;
      if (!j.success && !j.comments_html) { v.com.state = 'closed'; updTabs(); return; }
      v.com.list = comParse(j.comments_html);
      v.com.total = Number(j.total_count) || v.com.list.length;
      v.com.next = (Number(j.start) || 0) + (Number(j.pagesize) || COM_PAGE);
      v.com.state = v.com.list.length ? 'ok' : 'empty';
    } catch (e) { if (lkv !== v) return; v.com.state = 'err'; v.com.msg = e.message; }
    updTabs();
  }
  async function comMore(v) {
    const c = v.com; if (!c || c.busy || c.state !== 'ok') return;
    c.busy = true; c.err = ''; updTabs();
    try {
      const j = await comPage(v, c.next); if (lkv !== v) return;
      const add = comParse(j.comments_html), seen = new Set(c.list.map(m => m.key));
      add.forEach(m => { if (!seen.has(m.key)) { seen.add(m.key); c.list.push(m); } });
      c.total = Number(j.total_count) || c.total;
      c.next += Number(j.pagesize) || COM_PAGE;
      if (!add.length) c.next = c.total;           // nothing more to fetch: hide the button
    } catch (e) { if (lkv !== v) return; c.err = e.code === 'RATE' ? 'Steam is limiting comment requests. Try again in a few seconds.' : 'Could not load more comments. Try again.'; }
    c.busy = false; updTabs();
  }

  /* ---- Inventory / comments UI (updated in place; `lkv` is the view of the currently shown player) ---- */
  let lkv = null;
  const invSpin = '<span class="lk-spin" aria-hidden="true"></span>';
  function updInv() {
    const box = $('#lkInv'); if (!box || !lkv) return;
    const v = lkv, i = v.inv;
    if (!i || i.state === 'loading') { box.innerHTML = `<div class="inv-sum">${invSpin}<span class="muted">${i && i.msg ? esc(i.msg) : 'Loading inventory&hellip;'}</span></div>`; return; }
    if (i.state === 'wait') { box.innerHTML = `<div class="inv-sum"><span class="lk-na">Steam is limiting inventory lookups right now.</span><span class="muted" id="invNote">${esc(i.wait || '')}</span><button type="button" class="btn btn-small" data-inv-retry>Retry now</button></div>`; return; }
    if (i.state === 'private') { box.innerHTML = '<div class="inv-sum"><span class="lk-na">Inventory is private or hidden by the player.</span></div>'; return; }
    if (i.state === 'err') { box.innerHTML = `<div class="inv-sum"><span class="lk-na">Inventory could not be loaded.</span><span class="muted">${esc(i.msg || '')}</span><button type="button" class="btn btn-small" data-inv-retry>Retry</button></div>`; return; }
    if (document.activeElement && document.activeElement.id === 'invCur') return;   // do not close the open currency dropdown while prices stream in
    const t = invTotals(v), F = hasFloat(), pct = t.unique ? Math.round(Math.max(t.ps, F ? t.pc : 0) / t.unique * 100) : 100;
    const n = i.items.reduce((s, x) => s + x.qty, 0);
    box.innerHTML = `<div class="inv-sum">
      <div class="inv-head"><span class="flabel">Inventory valuation</span>${curSelect()}</div>
      ${curCode !== 'USD' ? `<small class="muted inv-fx">Market prices are fetched in USD and shown in ${curCode} at 1 USD = ${curRate(curCode)} ${curCode}.</small>` : ''}
      <div class="inv-vals">
        <div class="inv-val"><span class="flabel">Steam Market value</span><b>${t.ps ? fmtMoney(t.steam) : '--'}</b><small class="muted">${t.ps} / ${t.unique} priced</small></div>
        <div class="inv-val inv-val-csf"><span class="flabel">CSFloat value</span><b>${F ? (t.pc ? fmtMoney(t.csf) : '--') : 'n/a'}</b><small class="muted">${F ? `${t.pc} / ${t.unique} priced` : (isAdmin() ? 'no CSFloat key: add one in Admin' : 'CSFloat prices not provided yet')}</small></div>
      </div>
      <div class="inv-stats"><span><b>${n.toLocaleString()}</b> items</span><span><b>${t.unique}</b> marketable types</span>${t.top ? `<span>Top: <b>${esc(t.top.name)}</b> ${fmtMoney(t.top.p)}</span>` : ''}</div>
      ${i.pricing ? `<div class="inv-prog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div><span class="muted">${invSpin} ${esc(i.msg || i.cmsg || `Pricing ${Math.max(t.ps, F ? t.pc : 0)} / ${t.unique}`)}</span>` : (i.partial ? '<span class="muted">Steam is limiting Steam Market price lookups right now, so some items are unpriced (everything priced so far is saved).<button type="button" class="btn btn-small inv-retry" data-px-retry>Retry prices</button></span>' : '')}
      ${i.staleNote ? `<span class="muted inv-note" id="invNote">${esc(i.staleNote)}</span>` : ''}
      ${i.stNote ? `<span class="muted inv-note">${esc(i.stNote)}</span>` : ''}
      ${i.csfNote ? `<span class="muted inv-note">${esc(i.csfNote)}</span>` : ''}
    </div>`;
  }
  function invSorted(v) {
    const q = (v.q || '').toLowerCase(), pr = n => unitPx(v.price[n]);
    const list = v.inv.items.filter(i => !q || i.disp.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
    if (v.sort === 'name') list.sort((a, b) => a.disp.localeCompare(b.disp));
    else if (v.sort === 'qty') list.sort((a, b) => b.qty - a.qty || pr(b.name) - pr(a.name));
    else list.sort((a, b) => pr(b.name) * b.qty - pr(a.name) * a.qty);
    return list;
  }
  function updGrid() {
    const g = $('#invGrid'); if (!g || !lkv || lkv.tab !== 'inv') return;
    const v = lkv, list = invSorted(v), shown = list.slice(0, v.limit);
    g.innerHTML = shown.length ? shown.map(it => {
      const p = v.price[it.name], img = itemImg(it);
      return `<button type="button" class="inv-it" data-ai="${esc(it.name)}" style="--rc:${esc(it.color || '#5b6577')}" title="${esc(it.disp)}">
        ${it.qty > 1 ? `<span class="inv-qty">x${it.qty}</span>` : ''}
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ifb="1">` : '<span class="inv-noimg"></span>'}
        <span class="inv-nm">${esc(it.disp)}</span>
        <span class="inv-px">${!it.marketable ? '<em>not marketable</em>' : p && (p.steam || (hasFloat() && p.csf)) ? `<span class="px-s" title="Steam Market">${p.steam ? fmtMoney(p.steam) : '--'}</span>${hasFloat() ? `<span class="px-f" title="CSFloat">${p.csf ? fmtMoney(p.csf) : '--'}</span>` : ''}` : (v.inv.pricing ? '&hellip;' : '<em>no price</em>')}</span></button>`;
    }).join('') + (list.length > shown.length ? `<button type="button" class="btn btn-small inv-more" data-inv-more>Show more (${list.length - shown.length})</button>` : '')
      : '<p class="muted">No items match.</p>';
  }
  function updTabs() {
    const v = lkv, box = $('#lkTabs'); if (!box || !v) return;
    const cn = v.com && v.com.state === 'ok' ? ` (${v.com.total})` : '';
    box.innerHTML = [['inv', 'Open Inventory'], ['com', 'Profile Comments' + cn], ['ids', 'Steam IDs'], ['msg', 'Top Messages']]
      .map(([k, l]) => k === 'msg'
        ? `<button type="button" class="lk-tab lk-tab-soon" data-lt="msg" role="tab" aria-selected="false" aria-disabled="true" disabled tabindex="-1" title="Top Messages is coming soon">${l}<span class="lk-soon">coming soon</span></button>`
        : `<button type="button" class="lk-tab${v.tab === k ? ' on' : ''}" data-lt="${k}" role="tab" aria-selected="${v.tab === k}">${l}</button>`).join('');
    const body = $('#lkTabBody'); body.classList.toggle('hidden', !v.tab);
    if (v.tab !== 'msg') body.dataset.built = '';
    if (v.tab === 'inv') {
      const i = v.inv || {};
      if (i.state === 'ok') {
        if (!$('#invGrid')) body.innerHTML = `<div class="inv-ctl"><input id="invQ" placeholder="Filter items" aria-label="Filter inventory" value="${esc(v.q || '')}"><select id="invSort" aria-label="Sort inventory"><option value="price">Highest value</option><option value="qty">Quantity</option><option value="name">Name</option></select></div><div id="invGrid" class="inv-grid"></div><p class="muted">Images from Steam. Prices: Steam Market${hasFloat() ? ' and CSFloat lowest listing' : ''}. Click an item for its float.</p>`;
        $('#invSort').value = v.sort; updGrid();
      } else body.innerHTML = i.state === 'private' ? '<p class="muted">This inventory is not public.</p>' : i.state === 'err' ? '<p class="muted">Inventory unavailable right now.</p>' : i.state === 'wait' ? '<p class="muted">Steam is limiting inventory lookups; retrying automatically.</p>' : `<p class="muted">${invSpin} Loading inventory&hellip;</p>`;
    } else if (v.tab === 'com') {
      const c = v.com || {}, prev = body.querySelector('.cm-list'), keep = prev ? prev.scrollTop : 0;
      const more = c.state === 'ok' && c.next < c.total
        ? `<div class="cm-more"><button type="button" class="btn btn-small btn-primary" data-com-more${c.busy ? ' disabled' : ''}>${c.busy ? 'Loading&hellip;' : 'Load More Comments (+' + COM_PAGE + ')'}</button>${c.err ? `<span class="muted">${esc(c.err)}</span>` : ''}</div>` : '';
      body.innerHTML = c.state === 'loading' ? `<p class="muted">${invSpin} ${esc(c.note || 'Loading comments\u2026')}</p>`
        : c.state === 'ok' ? `<div class="cm-list">${c.list.map(m => `<div class="cm"><div class="cm-av">${m.avatar ? `<img src="${esc(m.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ifb="1">` : ''}</div><div class="cm-b"><div class="cm-h">${m.link ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">${esc(m.name)}</a>` : `<b>${esc(m.name)}</b>`}<span class="muted">${esc(m.time)}</span></div><p>${esc(m.text)}</p></div></div>`).join('')}</div><p class="muted">Showing the latest ${c.list.length} of ${c.total.toLocaleString()} comments.</p>${more}`
        : c.state === 'empty' ? '<p class="muted">No comments on this profile.</p>'
        : c.state === 'closed' ? '<p class="muted">Comments are not public on this profile.</p>'
        : `<p class="muted">Comments could not be loaded${c.msg ? ' (' + esc(c.msg) + ')' : ''}. <button type="button" class="btn btn-small" data-com-retry>Retry</button></p>`;
      const nl = body.querySelector('.cm-list'); if (nl && keep) nl.scrollTop = keep;
    } else if (v.tab === 'ids') {
      body.innerHTML = `<div class="lk-ids-bar"><span class="muted">Every ID format for this account.</span><button type="button" class="btn btn-primary btn-small" data-cp-all>Copy All</button></div>
        <div class="lk-ids">${(v.ids || []).map(([l, x]) => `<div class="lk-id"><span class="flabel">${esc(l)}</span><code>${esc(x)}</code><button type="button" class="btn btn-small" data-cp="${esc(x)}">Copy</button></div>`).join('')}</div>`;
    } else if (v.tab === 'msg') {
      if (body.dataset.built !== 'msg') {
        body.dataset.built = 'msg';
        body.innerHTML = `<div class="msg-tool">
          <div class="msg-note"><b>Why this can't be fetched automatically:</b> Valve's Steam Web API does not expose CS2 match chat or profile chat history (it is private by design), and Leetify's public data contains no chat logs either. So a lookup can't see what another player typed in game.</div>
          <span class="flabel">Simulated / Local Chat Analysis</span>
          <p class="muted">Upload or paste your own CS2 <code>console.log</code> (start the game with the <code>-condebug</code> launch option) or a demo chat extract. It is analysed in this browser only; nothing is uploaded.</p>
          <textarea id="msgIn" spellcheck="false" aria-label="Chat log text" placeholder="[ALL] PlayerName: gg&#10;[TEAM] PlayerName: rush B&#10;&#10;...or paste one message per line"></textarea>
          <div class="row"><input type="file" id="msgFile" accept=".log,.txt,.csv,text/plain" aria-label="Upload console.log or a chat extract"><input type="text" id="msgName" maxlength="40" autocomplete="off" aria-label="Only count messages from this player" placeholder="Only this player (optional)${v.name ? ', e.g. ' + esc(v.name) : ''}"></div>
          <div class="row"><button type="button" class="btn btn-primary btn-small" data-msg-go>Analyse top 10</button><button type="button" class="btn btn-small" data-msg-clear>Clear</button></div>
          <div id="msgRes" class="msg-res" role="status"></div></div>`;
        $('#msgIn').value = v.msgText || ''; msgRender(v);
      }
    }
  }
  /* ---- Float lookup ---------------------------------------------------------------------------------------------
     1. Since March 2026 CS2 inspect links can carry the item data themselves (a hex protobuf): those are decoded right here,
        no service involved. The checksum is verified; if it does not match, the remote services are tried first.
     2. Old-style links (S..A..D..) need Steam's game coordinator, so they go to the Worker's /inspect route (provider chain,
        retry and circuit breaker). If the Worker is old or unreachable, api.csgofloat.com is asked directly.
     3. If everything is down the modal says so, offers Retry and an "Inspect in game" link instead of a dead end. */
  const WEAR_CUTS = [[0.07, 'Factory New'], [0.15, 'Minimal Wear'], [0.38, 'Field-Tested'], [0.45, 'Well-Worn'], [1.01, 'Battle-Scarred']];
  const wearOf = f => (WEAR_CUTS.find(w => f < w[0]) || WEAR_CUTS[4])[1];
  /* Inspect link sanitiser. Steam's inventory JSON ships links such as
       steam://run/730//+csgo_econ_action_preview%20S%owner_steamid%A%assetid%D1234567890
     whose placeholders must be filled in by the page. Placeholder spellings handled: %owner_steamid%, %owner_id%, %5Bowner_id%5D,
     [owner_id] and %assetid%, %5Bassetid%5D, [assetid] (any case, every occurrence). The result is always
       steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S{steamid64}A{assetid}D{d}
     (market M...A...D... and self-encoded hex links keep their payload). Returns '' when no valid link can be built. */
  const INSPECT_PREFIX = 'steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20';
  function inspectLink(raw, steamId, assetId, pr) {
    let s = String(raw || '').trim(); if (!s) return '';
    s = s.replace(/(?:%25|%)propid(?::|%3A)(\d+)(?:%25|%)/gi, (all, n) => (+n === 6 && pr && pr.c) ? pr.c : all);
    const owner = String(steamId || '').replace(/\D/g, ''), asset = String(assetId || '').replace(/\D/g, '');
    s = s.replace(/(?:%5B|\[|%)\s*(?:owner_steamid|owner_id|ownerid|owner)\s*(?:%5D|\]|%)/gi, owner)
         .replace(/(?:%5B|\[|%)\s*(?:asset_id|assetid)\s*(?:%5D|\]|%)/gi, asset);
    const m = /csgo_econ_action_preview(?:%20|\s|\+)*(\S+)\s*$/i.exec(s); if (!m) return '';
    let p = m[1];
    if (/%/.test(p)) return '';                                   // an unknown placeholder is still in there
    const inv = /^S(\d*)A(\d*)D(\d{1,22})$/i.exec(p);
    if (inv) {
      const o = owner || inv[1], a = asset || inv[2];
      if (!/^\d{17}$/.test(o) || !/^\d{1,20}$/.test(a)) return '';
      p = 'S' + o + 'A' + a + 'D' + inv[3];
    } else if (!/^(?:[SM]\d+A\d+D\d+|[0-9A-Fa-f]{16,})$/.test(p)) return '';
    return INSPECT_PREFIX + p;
  }
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = bytes => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function pbParse(buf) {                       // minimal protobuf reader -> [[field, wireType, value], ...]
    let i = 0; const out = [];
    const vi = () => { let r = 0, m = 1, b; do { if (i >= buf.length) throw new Error('eof'); b = buf[i++]; r += (b & 127) * m; m *= 128; } while (b & 128); return r; };
    while (i < buf.length) {
      const tag = vi(), f = Math.floor(tag / 8), w = tag & 7; let v = null;
      if (w === 0) v = vi();
      else if (w === 5) { if (i + 4 > buf.length) throw new Error('eof'); v = buf[i] | buf[i + 1] << 8 | buf[i + 2] << 16 | buf[i + 3] << 24; i += 4; }
      else if (w === 1) { if (i + 8 > buf.length) throw new Error('eof'); i += 8; }
      else if (w === 2) { const n = vi(); if (i + n > buf.length) throw new Error('eof'); v = buf.slice(i, i + n); i += n; }
      else throw new Error('wire type');
      out.push([f, w, v]);
    }
    return out;
  }
  function inspLocal(link) {
    const m = /csgo_econ_action_preview(?:%20|\s|\+)*([0-9A-Fa-f]{16,})\s*$/.exec(String(link || ''));
    if (!m || m[1].length % 2) return null;
    try {
      const raw = m[1].match(/../g).map(h => parseInt(h, 16)), key = raw[0], dec = raw.map(b => b ^ key);
      if (dec.length < 8) return null;
      const proto = dec.slice(1, -4), tail = dec.slice(-4), crc = crc32([0].concat(proto)), xc = ((crc & 0xffff) ^ (proto.length * crc)) >>> 0;
      const verified = tail[0] === (xc >>> 24 & 255) && tail[1] === (xc >>> 16 & 255) && tail[2] === (xc >>> 8 & 255) && tail[3] === (xc & 255);
      let wear = null, seed = null, stickers = 0;
      pbParse(proto).forEach(([n, w, v]) => { if (n === 7 && w === 0) wear = v; else if (n === 8 && w === 0) seed = v; else if ((n === 12 || n === 20) && w === 2) stickers++; });
      if (wear == null) return null;
      const dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, wear >>> 0); const fl = dv.getFloat32(0);
      if (!(fl >= 0 && fl <= 1)) return null;
      return { floatvalue: fl, paintseed: seed, wear_name: wearOf(fl), stickerNames: [], stickerCount: stickers, verified, via: 'decoded from the inspect link' };
    } catch { return null; }
  }
  const inspNorm = (x, via) => ({ floatvalue: x.floatvalue, paintseed: x.paintseed != null ? x.paintseed : null, wear_name: x.wear_name || wearOf(x.floatvalue),
    stickerNames: Array.isArray(x.stickers) ? x.stickers.map(s => s && s.name).filter(Boolean) : [], stickerCount: Array.isArray(x.stickers) ? x.stickers.length : 0, verified: true, via });
  async function inspFloat(link) {
    const loc = inspLocal(link);
    if (loc && loc.verified) return loc;
    const b = bridgeUrl(); let why = '', retry = 0, down = false, bad = false;
    if (b) {
      try {
        const r = await fetchText(b + '/inspect?url=' + encodeURIComponent(link), {}, 22000);
        let j = null; try { j = JSON.parse(r.text); } catch { /* not JSON */ }
        if (r.status === 200 && j && j.ok && j.iteminfo && typeof j.iteminfo.floatvalue === 'number') return inspNorm(j.iteminfo, (j.via || 'bridge') + (j.cached ? ' (cached)' : ''));
        if (r.status === 400) { bad = true; why = (j && j.error) || 'not a valid CS2 inspect link'; }
        else if (j && j.ok === false) { down = true; retry = Number(j.retryAfter) || 45; why = Array.isArray(j.tried) && j.tried.length ? j.tried.map(t => t.host + ' ' + t.why).join('; ') : (j.error || ''); }
        else if (r.status === 404) why = 'the Worker is still the old version (deploy the new worker.js)';
      } catch { why = 'the bridge did not answer'; }
    }
    if (!down && !bad) {                         // no bridge, old Worker or bridge unreachable: ask the public service directly
      try {
        const r = await proxyReq('https://api.csgofloat.com/?url=' + encodeURIComponent(link), { json: true, direct: true, ttl: 3600000, timeout: 9000, total: 14000 });
        const x = r.json && r.json.iteminfo;
        if (x && typeof x.floatvalue === 'number') return inspNorm(x, 'api.csgofloat.com');
        why = why || 'the service returned no float';
      } catch (e) { why = why || e.message; }
    }
    if (loc) return Object.assign(loc, { via: 'decoded from the inspect link (checksum not verified)' });
    throw netErr('INSPECT', why || 'service unreachable', { retryAfter: retry, bad });
  }
  async function itemModal(name) {
    const v = lkv, it = v && v.inv.items.find(x => x.name === name); if (!it) return;
    const p = v.price[it.name], money = usd => `<b data-usd="${usd}">${fmtMoney(usd)}</b>`;
    const prOf = i => (it.pr && it.pr[i]) || null, rawOf = i => (it.links && it.links[i]) || it.link || '';
    const linkOf = i => inspectLink(rawOf(i), v.id, it.ids[i], prOf(i));
    const hasF = i => { const q = prOf(i); return !!q && Number.isFinite(q.f); };
    const hasAct = !!(it.link || (it.links || []).some(Boolean)), floaty = hasAct || it.ids.some((_, i) => hasF(i));
    const sel = floaty && it.ids.length > 1 ? `<div class="inv-row"><span class="flabel">Copy</span><select id="imSel" aria-label="Choose which copy to inspect">${it.ids.slice(0, 60).map((_, i) => `<option value="${i}">#${i + 1}${hasF(i) ? ' \u00b7 ' + prOf(i).f.toFixed(4) : ''}</option>`).join('')}</select></div>` : '';
    openModal(`<h3 style="color:${esc(it.color || 'inherit')}">${esc(it.disp)}</h3>
      <div class="inv-md">${itemImg(it) ? `<img src="${esc(itemImg(it))}" alt="" referrerpolicy="no-referrer" data-ifb="1">` : ''}<div>
        <div class="muted">${esc(it.type)}</div>
        <div class="inv-row"><span class="flabel">Quantity</span><b>${it.qty}</b></div>
        <div class="inv-row"><span class="flabel">Steam Market</span>${it.marketable ? (p && p.steam ? money(p.steam) : '<b>unavailable</b>') : '<b>not marketable</b>'}</div>
        <div class="inv-row"><span class="flabel">CSFloat</span>${it.marketable ? (hasFloat() ? (p && p.csf ? money(p.csf) : '<b>unavailable</b>') : `<b>${isAdmin() ? 'no key: add one in Admin' : 'not provided yet'}</b>`) : '<b>not marketable</b>'}</div>
        ${sel}
        <div class="inv-row"><span class="flabel">Float</span><b id="imFloat">${floaty ? 'loading&hellip;' : 'n/a'}</b></div>
        ${floaty ? `<div class="inv-row"><span class="flabel">Wear</span><b id="imWear">&hellip;</b></div>
        <div class="inv-row"><span class="flabel">Paint seed</span><b id="imSeed">&hellip;</b></div>` : ''}
        <div id="imExtra" class="muted">${floaty ? '' : 'This item type (case, sticker, key, agent ...) has no float value.'}</div></div></div>
      <div class="inv-actions"><button class="btn btn-primary btn-small" id="imOk">Close</button>${floaty ? '<a class="btn btn-small hidden" id="imInspect" href="#">Inspect in Game</a><button type="button" class="btn btn-small hidden" id="imCopy">Copy inspect link</button>' : ''}</div>`);
    $('#imOk').onclick = closeModal;
    if (!floaty) return;
    const idx = () => +(($('#imSel') || {}).value) || 0;
    const cp = $('#imCopy'); if (cp) cp.onclick = async () => toast(await copyText(linkOf(idx())) ? 'Inspect link copied.' : 'Copy failed.');
    const set = (id, t) => { const el = $(id); if (el) el.textContent = t; };
    const run = async () => {
      const el = $('#imFloat'); if (!el) return;
      const i = idx(), link = linkOf(i), q = prOf(i), a = $('#imInspect'), cb = $('#imCopy');
      if (a) { a.href = link || '#'; a.classList.toggle('hidden', !link); }
      if (cb) cb.classList.toggle('hidden', !link);
      el.textContent = 'loading\u2026'; set('#imWear', '\u2026'); set('#imSeed', '\u2026'); const ex0 = $('#imExtra'); if (ex0) ex0.textContent = '';
      try {
        let x;
        if (q && Number.isFinite(q.f)) x = { floatvalue: q.f, paintseed: q.s != null ? q.s : null, wear_name: wearOf(q.f), stickerNames: [], stickerCount: 0, via: 'Steam inventory data' };
        else if (link) x = await inspFloat(link);
        else throw Object.assign(netErr('INSPECT', 'Steam sent no float data for this copy'), { nodata: true });
        const el2 = $('#imFloat'); if (!el2) return;
        el2.textContent = x.floatvalue.toFixed(8);
        set('#imWear', x.wear_name || wearOf(x.floatvalue)); set('#imSeed', x.paintseed != null ? String(x.paintseed) : 'n/a');
        const ex = $('#imExtra'); if (ex) ex.textContent = [x.stickerNames.length ? 'Stickers: ' + x.stickerNames.join(', ') : x.stickerCount ? x.stickerCount + ' sticker/keychain slot(s)' : '', 'Source: ' + x.via].filter(Boolean).join(' \u00b7 ');
      } catch (e) {
        const el2 = $('#imFloat'), ex = $('#imExtra'); if (!el2 || !ex) return;
        el2.textContent = 'unavailable'; set('#imWear', 'unavailable'); set('#imSeed', 'unavailable');
        ex.innerHTML = e.nodata ? '<div>Steam did not send float data for this copy (the item may be new, untradable or not a weapon skin).</div>'
          : e.bad ? `<div>This item's inspect link could not be used${e.message ? ' (' + esc(e.message) + ')' : ''}. You can still open it with Inspect in Game.</div>`
          : `<div>The float service is not answering${e.message ? ' (' + esc(e.message) + ')' : ''}.${e.retryAfter ? ' Try again in about ' + e.retryAfter + ' s.' : ''}</div><div class="row"><button type="button" class="btn btn-small" id="imRetry">Retry</button></div>`;
        const rb = $('#imRetry'); if (rb) rb.onclick = run;
      }
    };
    const ss = $('#imSel'); if (ss) ss.onchange = run;
    run();
  }

  /* ---- Rendering ---- */
  const lkMsg = (t, bad) => { const m = $('#lkMsg'); m.textContent = t || ''; m.style.color = bad ? 'var(--danger)' : ''; };
  let lkTok = 0, lkLastQ = { k: '', t: 0 }; const lkCache = {};
  const PERSONA = ['Offline', 'Online', 'Busy', 'Away', 'Snooze', 'Looking to trade', 'Looking to play'];

  function statusHTML(d) {
    if (d.pub !== true || !d.persona) return d.pub === false ? '<div class="lk-status"><span class="lk-on off"><i></i>Private profile</span></div>' : '';
    const p = d.persona;
    if (p.state > 0) return `<div class="lk-status"><span class="lk-on on"><i></i>Online</span>${p.game ? `<span class="muted">Playing ${esc(p.game)}</span>` : (p.state > 1 ? `<span class="muted">${esc(PERSONA[p.state] || '')}</span>` : '')}</div>`;
    const last = p.lastlogoff ? `Last online ${new Date(p.lastlogoff * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${agoText(Date.now() / 1000 - p.lastlogoff)})` : p.lastText ? `Last online ${p.lastText}` : '';
    return `<div class="lk-status"><span class="lk-on off"><i></i>Offline</span>${last ? `<span class="muted">${esc(last)}</span>` : ''}</div>`;
  }
  /* Admin badge: shown next to the display name for the admin SteamID64s (icon: mnobk.png) */
  const cheaterBadge = id => { const f = flOf(id); return f ? `<span class="lk-cheater" title="${esc(f.note || 'Flagged as a cheater by MWAY LABS')}"><b>CHEATER</b></span>` : ''; };
  const adminBadge = id => ADMIN_STEAM_IDS.includes(String(id || '')) ? '<span class="lk-admin" title="MWAY LABS admin"><img src="mnobk.png" alt="" width="18" height="18" decoding="async"><b>ADMIN</b></span>' : '';

  function trustHTML(tr) {
    if (tr.known < 2) return '<div class="tf tf-empty"><div class="lk-na lk-na-box">No Trust Data</div><span class="muted">Not enough public data for a trust estimate. Add a Steam API key in Admin for fuller results.</span></div>';
    const N = 24, lit = Math.round(tr.score / 100 * N);
    const segs = Array.from({ length: N }, (_, i) => `<span class="tf-seg${i < lit ? ' lit' : ''}" style="--i:${i};--o:${(0.35 + 0.65 * i / (N - 1)).toFixed(2)}"></span>`).join('');
    return `<div class="tf" style="--tc:${tr.col};--s:${tr.score}">
      <div class="tf-ring"><svg viewBox="0 0 56 56" aria-hidden="true"><circle class="tf-trk" cx="28" cy="28" r="23" pathLength="100"/><circle class="tf-val" cx="28" cy="28" r="23" pathLength="100"/></svg><b>${tr.score}</b></div>
      <div class="tf-main">
        <div class="tf-top"><span class="tf-name">TRUST_FACTOR<small>// estimate</small></span><span class="tf-tier">${esc(tr.tier)}</span></div>
        <div class="tf-segs" role="img" aria-label="Estimated trust ${tr.score} out of 100">${segs}</div>
        <div class="tf-chips">${tr.f.map(x => `<span class="tf-chip ${x.good ? 'good' : x.p < 0 ? 'bad' : ''}"><i>${x.p > 0 ? '+' + x.p : x.p}</i>${esc(x.label)}</span>`).join('')}</div>
      </div></div>`;
  }

  function lkRender(d) {
    const lf = d.lf || {}, rk = lf.ranks || {}, tr = lkTrust(d);
    const ini = esc((d.name || '?')[0].toUpperCase());
    const avatar = /^https:\/\//i.test(d.avatar || '') ? `<img class="avatar-img" src="${esc(d.avatar)}" alt="" referrerpolicy="no-referrer" data-fb="${ini}">` : `<div class="avatar">${ini}</div>`;
    const url = /^https:\/\/steamcommunity\.com\//i.test(d.url || '') ? d.url : 'https://steamcommunity.com/profiles/' + d.id;
    const years = d.created ? Math.floor((Date.now() / 1000 - d.created) / 31557600) : 0;
    const badges = (d.level != null || years >= 1 || d.games) ? `<div class="lk-badges">${d.level != null ? `<div class="lk-badge">${levelBadge(d.level)}<span>Level ${d.level}</span></div>` : ''}${d.games ? `<div class="lk-badge">${gameBadge(d.games)}<span>${d.games.toLocaleString('en-US')} game${d.games > 1 ? 's' : ''}</span></div>` : ''}${years >= 1 ? `<div class="lk-badge">${yearBadge(years)}<span>${years} year${years > 1 ? 's' : ''}</span></div>` : ''}</div>` : '';
    const meta = [];
    if (d.created) meta.push(`Created ${new Date(d.created * 1000).toISOString().slice(0, 10)}`);
    if (d.hours != null) meta.push(`${d.hours.toLocaleString()} h CS2`);
    const bn = d.bans, flags = [];
    if (bn) {
      if (bn.NumberOfVACBans || bn.VACBanned) flags.push('VAC BAN');
      if (bn.NumberOfGameBans) flags.push('GAME BAN');
      if (bn.CommunityBanned) flags.push('COMMUNITY BAN');
      if (bn.EconomyBan && bn.EconomyBan !== 'none') flags.push('TRADE BAN');
    }
    const comp = Array.isArray(rk.competitive) ? rk.competitive.filter(c => c && c.rank > 0).sort((a, b) => b.rank - a.rank)[0] : null;
    const tm = topMaps(lf), fcNick = lf.faceit_nickname || rk.faceit_nickname || '';
    const faceitUrl = (d.fc && d.fc.url) || (fcNick ? `https://www.faceit.com/en/players/${encodeURIComponent(fcNick)}` : `https://faceitfinder.com/profile/${d.id}`);
    const rec = mapRecords(lf);
    const links = `<div class="lk-links"><button type="button" id="lkXh" class="lk-xh loading" disabled aria-label="Player crosshair"></button>${[lkIcon('steam', url, 'Steam Profile'),
      rk.faceit || fcNick ? lkIcon('faceit', faceitUrl, 'Faceit Profile') : '',
      lkIcon('leetify', 'https://leetify.com/app/profile/' + d.id, 'Leetify Profile'),
      lkIcon('csstats', 'https://csstats.gg/player/' + d.id, 'CSStats Profile')].join('')}<div id="lkForm" class="lk-form" role="img" aria-label="Results of the last 5 matches"></div></div>`;
    const hc = d.hltv >= 1.1 ? '#4fb286' : d.hltv >= 1 ? '#5b8def' : d.hltv >= 0.9 ? '#d1a455' : '#d1556a';
    const cs2 = `<div class="lk-toprow">
        <div class="lk-tile lk-tile-fc"><span class="flabel">FACEIT level</span>${faceitTile(d, rk)}</div>
        <div class="lk-tile lk-tile-pm"><span class="flabel">Premier rating</span>${rk.premier ? premHTML(rk.premier) : `<div class="lk-na lk-na-box">${d.lfState === 'ok' || d.lfState === 'none' ? 'Unranked' : 'No Data'}</div>`}</div>
        <div class="lk-tile lk-tile-tf">${trustHTML(tr)}</div>
      </div>
      <div class="lk-tiles">
        ${d.hltv ? `<div class="lk-tile lk-tile-hltv"><span class="flabel">HLTV rating</span><div class="lk-hltv" style="--c:${hc}"><b>${d.hltv.toFixed(2)}</b></div></div>` : ''}
        <div class="lk-tile wide"><span class="flabel">Highest competitive rank</span><div class="lk-comp-row">
          ${comp ? `<div class="lk-rank main">${rankIcon(comp.rank, 120)}<span>${esc(mapName(comp.map_name))}</span>${wrHTML(rec[comp.map_name])}</div>` : '<div class="lk-na lk-na-box">Unranked</div>'}
          ${tm.length ? `<div class="lk-maps-wrap"><span class="flabel">Top ${tm.length} played map${tm.length > 1 ? 's' : ''}</span><div class="lk-maps">${tm.map(m => `<div class="lk-rank" title="${esc(COMP[m.rank] || '')}">${rankIcon(m.rank, 76)}<span>${esc(mapName(m.map))}</span>${wrHTML(rec[m.map])}</div>`).join('')}</div></div>` : ''}
        </div></div></div>
      <div id="lkPerf" class="lk-perf"></div>
      ${d.lfState === 'ok' ? ''
        : d.lfState === 'none' ? '<p class="muted">No Leetify profile exists for this player (or it is set to private), so CS2 rank data is unavailable.</p>'
        : d.lfState === 'auth' ? '<p class="muted">Leetify asked for authentication. Add a Leetify API key in Admin to load CS2 rank data.</p>'
        : d.lfState === 'rate' ? `<p class="muted">Leetify is rate limiting requests right now. <button type="button" class="btn btn-small" data-lk-retry="${esc(d.id)}">Retry</button></p>`
        : rk.faceit ? '<p class="muted">No Leetify profile data for this player; the Faceit level above comes from the Faceit API.</p>'
        : `<p class="muted">Leetify could not be reached after several attempts, so CS2 rank data is unavailable. <button type="button" class="btn btn-small" data-lk-retry="${esc(d.id)}">Retry</button></p>`}`;

    $('#lkOut').innerHTML = `<div class="lk-card">
      <div class="lk-head">${avatar}<div class="lk-who"><div class="lk-namerow"><div class="steam-name">${esc(d.name || 'Unknown player')}</div>${adminBadge(d.id)}${cheaterBadge(d.id)}</div>
        ${statusHTML(d)}
        <div class="muted">${esc(meta.join(' · '))}</div>
        ${flags.length ? `<div class="lk-flags">${flags.map(x => `<span class="lk-flag">${x}</span>`).join('')}</div>` : ''}
        ${links}</div>${badges}</div>
      ${d.steamNote ? `<p class="muted">${esc(d.steamNote)}</p>` : ''}
      <span class="flabel mt-s">CS2 player data</span>${cs2}
      <span class="flabel mt-s">Top 6 Teammates</span><div id="lkTm" class="lk-tm"></div>
      <span class="flabel mt-s">Banned friends</span><div id="lkFr" class="lk-fr"></div>
      <span class="flabel mt-s">Inventory value</span><div id="lkInv" class="lk-inv"></div>
      <div id="lkTabs" class="lk-tabs" role="tablist"></div><div id="lkTabBody" class="lk-tabbody hidden"></div>
    </div>`;

    // Steam-session users: keep the nav button label in sync with the real persona name.
    if (session && session.steam && session.id === d.id && d.name && session.name !== d.name) {
      session.name = d.name; sessionStorage.setItem('mway_session', JSON.stringify(session)); applyAuth();
    }
    const v = lkv = { id: d.id, name: d.name || '', tab: '', q: '', sort: 'price', limit: 60, price: {}, inv: { state: 'loading', items: [] }, com: { state: 'loading', list: [] }, ids: lkIds(d.id, d.url), tm: { state: 'loading', list: [] }, msg: null, msgText: msgFromApi(lf) };
    if (v.msgText) v.msg = msgAnalyze(v.msgText, '');
    updTabs();
    if (d.pub === false) {
      v.inv = { state: 'private', items: [] }; v.com = { state: 'closed', list: [] }; updInv(); updTabs();
    } else { invStart(v); comStart(v); }
    tmStart(v, d); statsStart(v, d); xhStart(v, d); frStart(v, d);
  }

  async function lkSearch(force) {
    flLoad();
    const q = lkParse($('#lkIn').value), tok = ++lkTok, btn = $('#lkGo');
    $('#lkOut').innerHTML = ''; lkv = null;
    if (!q) return lkMsg('Enter a Steam profile link, SteamID64, SteamID2/3, account ID or custom name.', true);
    if (q.err) return lkMsg(q.err, true);
    const dk = q.id || 'v:' + q.vanity.toLowerCase(), now = Date.now();
    if (force !== true && lkLastQ.k === dk && now - lkLastQ.t < 1500) return;   // debounce double clicks / key repeat
    lkLastQ = { k: dk, t: now };
    btn.disabled = true; lkMsg('Looking up player...');
    try {
      let id = q.id;
      if (!id) {
        id = await lkResolve(q.vanity);
        if (!id) return lkMsg('No Steam profile found for that name.', true);
      }
      if (tok !== lkTok) return;
      const hit = lkCache[id];
      if (hit && Date.now() - hit.t < 300000) { lkRender(hit.d); lkMsg(''); return; }
      const lfP = lkLeetify(id);
      const pr = await lkProfile(id);
      if (tok !== lkTok) return;
      if (pr.missing) return lkMsg('No Steam profile found for that ID.', true);
      const d = { games: null, id, name: pr.name || '', avatar: pr.avatar || '', url: pr.url || '', created: pr.created || 0, pub: pr.pub != null ? pr.pub : null, persona: pr.persona || null, level: null, hours: null, bans: pr.bans || null, hltv: null, lf: null, lfState: 'err', steamNote: '' };
      if (pr.src === 'api') {
        const [bn, lv, og, bg] = await Promise.allSettled([
          steamApi('ISteamUser/GetPlayerBans/v1', { steamids: id }),
          steamApi('IPlayerService/GetSteamLevel/v1', { steamid: id }),
          steamApi('IPlayerService/GetOwnedGames/v1', { steamid: id, include_played_free_games: 1, 'appids_filter[0]': 730 }),
          steamApi('IPlayerService/GetBadges/v1', { steamid: id })
        ]);
        if (bn.status === 'fulfilled') d.bans = ((bn.value || {}).players || [])[0] || null;
        if (lv.status === 'fulfilled') { const l = (lv.value.response || {}).player_level; if (typeof l === 'number') d.level = l; }
        if (bg.status === 'fulfilled') { const gb = (((bg.value || {}).response || {}).badges || []).find(x => x && +x.badgeid === 13 && !x.appid); if (gb && +gb.level > 0) d.games = +gb.level; }   // Game Collector badge level = games counted
        if (og.status === 'fulfilled') { const g = ((og.value.response || {}).games || [])[0]; if (g) d.hours = Math.round((g.playtime_forever || 0) / 60); }
      } else if (pr.apiErr && pr.apiErr.code !== 'KEY') d.steamNote = `Steam Web API unavailable (${pr.apiErr.message}). Showing public profile data only: level, playtime and detailed bans are missing.`;
      else d.steamNote = 'No Steam API key saved, so level, playtime and detailed bans are missing. Add the key in Admin for the full profile.';
      const [lf, hltv, fc] = await Promise.all([lfP, lkHltv(d), lkFaceit(id)]);
      if (tok !== lkTok) return;
      d.lf = lf.data || null; d.lfState = lf.state; d.hltv = hltv;
      d.fc = fc;
      if (fc && fc.state === 'ok') {   // the FACEIT API is the official source: it wins over Leetify's copy of the level / ELO
        d.lf = Object.assign({}, d.lf, { ranks: Object.assign({}, d.lf && d.lf.ranks, { faceit: fc.level, faceit_elo: fc.elo }), faceit_nickname: fc.nick });
      }
      if (!d.name && d.lf && d.lf.name) d.name = d.lf.name;
      if (!d.name && !d.lf) return lkMsg('Nothing found for that player.', true);
      if (d.lfState === 'ok' || d.lfState === 'none') lkCache[id] = { t: Date.now(), d };   // never cache a failed Leetify lookup
      lkRender(d); lkMsg('');
    } catch (err) {
      if (tok === lkTok) lkMsg(err instanceof TypeError ? 'Every proxy failed or the network is unreachable. Try again shortly.' : err.message, true);
    } finally { if (tok === lkTok) btn.disabled = false; }
  }

  function msgRun(v) {
    const a = $('#msgIn'), nm = (($('#msgName') || {}).value || '').trim().toLowerCase(), txt = v.msgFull || (a ? a.value : v.msgText) || '';
    v.msgText = a ? a.value : v.msgText; v.msg = msgAnalyze(txt, nm); msgRender(v);
  }
  async function msgFile(f, v) {
    if (!f) return;
    if (f.size > 8e6) { const b = $('#msgRes'); if (b) b.innerHTML = '<p class="muted">That file is larger than 8 MB. Cut it down to the chat section first.</p>'; return; }
    let txt = ''; try { txt = await f.text(); } catch { const b = $('#msgRes'); if (b) b.innerHTML = '<p class="muted">That file could not be read.</p>'; return; }
    if (lkv !== v) return;
    v.msgFull = txt; v.msgText = txt.length > 2e5 ? txt.slice(0, 2e5) : txt;
    const a = $('#msgIn'); if (a) a.value = v.msgText; msgRun(v);
  }
  function lkInit() {
    $('#lkGo').addEventListener('click', () => lkSearch());
    $('#lkIn').addEventListener('keydown', e => { if (e.key === 'Enter') lkSearch(); });
    const out = $('#lkOut');
    out.addEventListener('click', async e => {
      const t = e.target, cp = t.closest('[data-cp]');
      if (cp) return toast(await copyText(cp.dataset.cp) ? 'Copied.' : 'Copy failed.');
      const xhs = t.closest('[data-xhset]'); if (xhs) return xhSetModal(lkv);
      if (t.closest('[data-xhna]')) return toast('No crosshair is published for this player yet. Steam does not expose crosshair settings: players publish theirs after logging in with Steam (their own profile page, or the Crosshair Generator).');
      const xhb = t.closest('[data-xh]'); if (xhb) return toast(await copyText(xhb.dataset.xh) ? 'Crosshair code copied. In CS2: Settings > Game > Crosshair > Import.' : 'Copy failed.');
      if (t.closest('[data-cp-all]') && lkv) return toast(await copyText((lkv.ids || []).map(([l, x]) => l + ': ' + x).join('\n')) ? 'All IDs copied.' : 'Copy failed.');
      if (t.closest('[data-com-more]') && lkv) return comMore(lkv);
      if (t.closest('[data-com-retry]') && lkv) return comStart(lkv);
      if (t.closest('[data-px-retry]') && lkv) { const v = lkv; if (v.inv && v.inv.state === 'ok' && !v.inv.pricing) { rlMap.market = 0; v.inv.pricing = true; v.inv.msg = ''; updInv(); invPrice(v); } return; }
      const tl = t.closest('[data-tm-look]'); if (tl) { $('#lkIn').value = tl.dataset.tmLook; window.scrollTo({ top: $('#lkPanel').offsetTop - 70, behavior: 'smooth' }); return lkSearch(true); }
      if (t.closest('[data-msg-go]') && lkv) return msgRun(lkv);
      if (t.closest('[data-msg-clear]') && lkv) { lkv.msgText = ''; lkv.msgFull = ''; lkv.msg = null; const a = $('#msgIn'); if (a) a.value = ''; const f = $('#msgFile'); if (f) f.value = ''; return msgRender(lkv); }
      const tab = t.closest('[data-lt]');
      if (tab && tab.dataset.lt === 'msg') return;   // Top Messages is disabled (coming soon)
      if (tab && lkv) { lkv.tab = lkv.tab === tab.dataset.lt ? '' : tab.dataset.lt; const g = $('#invGrid'); if (g && lkv.tab !== 'inv') $('#lkTabBody').innerHTML = ''; return updTabs(); }
      if (t.closest('[data-inv-more]') && lkv) { lkv.limit += 60; return updGrid(); }
      if (t.closest('[data-inv-retry]') && lkv) return invStart(lkv);
      const lr = t.closest('[data-lk-retry]'); if (lr) { delete lkCache[lr.dataset.lkRetry]; $('#lkIn').value = lr.dataset.lkRetry; return lkSearch(true); }
      const it = t.closest('[data-ai]'); if (it) itemModal(it.dataset.ai);
    });
    out.addEventListener('error', e => {
      const img = e.target;
      if (img && img.tagName === 'IMG' && img.dataset.lkfb && LK_ICO_FB[img.dataset.lkfb]) { const w = document.createElement('span'); w.innerHTML = LK_ICO_FB[img.dataset.lkfb]; img.replaceWith(w.firstChild); }
    }, true);
    out.addEventListener('input', e => {
      if (e.target.id === 'invQ' && lkv) { lkv.q = e.target.value; lkv.limit = 60; updGrid(); }
      else if (e.target.id === 'msgIn' && lkv) { lkv.msgText = e.target.value; lkv.msgFull = ''; }
    });
    out.addEventListener('change', e => { if (e.target.id === 'msgFile' && lkv) msgFile(e.target.files && e.target.files[0], lkv); });
    out.addEventListener('change', e => {
      if (e.target.id === 'invSort' && lkv) { lkv.sort = e.target.value; updGrid(); }
      else if (e.target.id === 'invCur') { setCur(e.target.value); e.target.blur(); updInv(); updGrid(); }
    });
    out.addEventListener('focusout', e => { if (e.target && e.target.id === 'invCur' && lkv) { updInv(); updGrid(); } });
    const imgFail = e => {
      const img = e.target; if (!img || img.tagName !== 'IMG') return;
      if (img.dataset.fb) { const d = document.createElement('div'); d.className = 'avatar'; d.textContent = img.dataset.fb; img.replaceWith(d); }
      else if (img.dataset.yfb) { const w = document.createElement('span'); w.innerHTML = yearSVG(+img.dataset.yfb, +img.dataset.px || 46); img.replaceWith(w.firstChild); }
      else if (img.dataset.rk) { const w = document.createElement('span'); w.className = 'rk-txt'; w.textContent = COMP[+img.dataset.rk] || 'Rank'; img.replaceWith(w); }
      else if (img.dataset.gfb) { const w = document.createElement('span'); w.innerHTML = gcSVG(+img.dataset.gfb, +img.dataset.px || 46); img.replaceWith(w.firstChild); }
      else if (img.dataset.fc) {
        const srcs = fcSrcs(+img.dataset.fc), i = (+img.dataset.fci || 0) + 1;
        if (i < srcs.length) { img.dataset.fci = String(i); img.src = srcs[i]; }
        else { const w = document.createElement('span'); w.innerHTML = faceitIcon(+img.dataset.fc, +img.dataset.px || 60); img.replaceWith(w.firstChild); }
      }
      else if (img.dataset.ifb) img.style.visibility = 'hidden';
    };
    out.addEventListener('error', imgFail, true);
    $('#modal').addEventListener('error', imgFail, true);
  }

    /* =====================================================================
     12e. STEAM IDs CONVERTER (dropdown panel in the Gaming tab)
     Accepts SteamID64, SteamID2 (STEAM_0/1), SteamID3, account ID, profile links and custom names.
     ===================================================================== */
  const cvMsg = (t, bad) => { const m = $('#cvMsg'); m.textContent = t || ''; m.style.color = bad ? 'var(--danger)' : ''; };
  let cvTok = 0, cvLiveT = 0;

  function cvFormats(id) {
    const n = BigInt(id), a = n - S64, y = a % 2n, z = a / 2n;
    return [
      ['SteamID64', id], ['SteamID3', `[U:1:${a}]`], ['SteamID2', `STEAM_1:${y}:${z}`], ['SteamID2 (legacy STEAM_0)', `STEAM_0:${y}:${z}`],
      ['Account ID (32-bit)', String(a)], ['Steam hex (FiveM)', 'steam:' + n.toString(16)], ['Profile URL', `https://steamcommunity.com/profiles/${id}`]
    ];
  }
  function cvCard(c) {
    if (c.err) return `<div class="cv-card cv-bad"><div class="cv-head"><code>${esc(c.input)}</code><span class="muted">${esc(c.err)}</span></div></div>`;
    return `<div class="cv-card"><div class="cv-head"><code>${esc(c.input)}</code>${c.via ? `<span class="muted">resolved from ${esc(c.via)}</span>` : ''}</div>
      <div class="lk-ids">${cvFormats(c.id).map(([l, v]) => `<div class="lk-id"><span class="flabel">${esc(l)}</span><code>${esc(v)}</code><button type="button" class="btn btn-small" data-cp="${esc(v)}">Copy</button></div>`).join('')}</div>
      <div class="row"><button type="button" class="btn btn-small" data-cv-look="${esc(c.id)}">Look up player</button><button type="button" class="btn btn-small" data-cv-all="${esc(c.id)}">Copy all</button></div></div>`;
  }
  async function cvConvert() {
    const raw = $('#cvIn').value.trim(), tok = ++cvTok, out = $('#cvOut'), btn = $('#cvGo');
    out.innerHTML = '';
    if (!raw) return cvMsg('Paste one or more Steam IDs, profile links or custom names.', true);
    const parts = [...new Set(raw.split(/[\s,;]+/).filter(Boolean))], list = parts.slice(0, 12), cards = [];
    btn.disabled = true; cvMsg('Converting...');
    try {
      for (const p of list) {
        if (tok !== cvTok) return;
        const q = lkParse(p);
        if (!q || q.err) { cards.push({ input: p, err: (q && q.err) || 'Not recognised.' }); continue; }
        if (q.id) { cards.push({ input: p, id: q.id }); continue; }
        cvMsg('Resolving "' + p + '"...');
        let id = null, failed = '';
        try { id = await lkResolve(q.vanity); } catch (e) { failed = e && e.message ? e.message : 'Lookup failed.'; }
        cards.push(id ? { input: p, id, via: 'custom URL "' + q.vanity + '"' } : { input: p, err: failed || 'No Steam profile found for that custom name.' });
      }
      if (tok !== cvTok) return;
      out.innerHTML = cards.map(cvCard).join('');
      const bad = cards.filter(c => c.err).length;
      cvMsg('Converted ' + (cards.length - bad) + ' of ' + cards.length + (cards.length === 1 ? ' entry.' : ' entries.')
        + (parts.length > list.length ? ' Only the first ' + list.length + ' of ' + parts.length + ' were converted.' : ''), bad === cards.length);
    } finally { if (tok === cvTok) btn.disabled = false; }
  }
  function cvSyncMine() { const b = $('#cvMine'); if (b) b.classList.toggle('hidden', !(session && session.steam)); }
  function cvInit() {
    $('#cvGo').addEventListener('click', cvConvert);
    $('#cvClear').addEventListener('click', () => { cvTok++; $('#cvGo').disabled = false; $('#cvIn').value = ''; $('#cvOut').innerHTML = ''; cvMsg(''); $('#cvIn').focus(); });
    $('#cvMine').addEventListener('click', () => { if (session && session.steam) { $('#cvIn').value = session.id; cvConvert(); } });
    $('#cvIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cvConvert(); } });
    /* Live conversion while typing, but only when every entry converts offline (no custom names to resolve). */
    $('#cvIn').addEventListener('input', () => {
      clearTimeout(cvLiveT);
      cvLiveT = setTimeout(() => {
        const parts = $('#cvIn').value.split(/[\s,;]+/).filter(Boolean);
        if (!parts.length) { cvTok++; $('#cvOut').innerHTML = ''; cvMsg(''); return; }
        if (parts.every(p => { const q = lkParse(p); return q && q.id; })) cvConvert();
      }, 450);
    });
    $('#cvOut').addEventListener('click', async e => {
      const cp = e.target.closest('[data-cp]');
      if (cp) return toast(await copyText(cp.dataset.cp) ? 'Copied.' : 'Copy failed.');
      const all = e.target.closest('[data-cv-all]');
      if (all) return toast(await copyText(cvFormats(all.dataset.cvAll).map(([l, v]) => l + ': ' + v).join('\n')) ? 'All formats copied.' : 'Copy failed.');
      const look = e.target.closest('[data-cv-look]');
      if (look) {
        $('#lkIn').value = look.dataset.cvLook; lkSearch(true);
        $('#lkPanel').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      }
    });
  }

  /* =====================================================================
     12f. DIAGNOSTICS LOGGER UI (Admin tab)
     ===================================================================== */
  const DG_LV = { ok: 'OK', info: 'INFO', warn: 'WARN', error: 'ERR' };
  const DG_ST = { ok: 'OK', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };
  const DG_API = 'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/';
  const DG_XML = 'https://steamcommunity.com/profiles/76561197960287930/?xml=1';

  function diagBadge() {
    const el = $('#dgBadge'); if (!el) return;
    const b = bridgeUrl(); let t = 'BRIDGE: NOT SET', c = '';
    if (b) {
      if (bridgeCaps && bridgeCaps.url === b) { t = 'BRIDGE: ONLINE'; c = 'ok'; }
      else if (bridgeErr) { t = 'BRIDGE: OFFLINE'; c = 'bad'; }
      else t = 'BRIDGE: UNCHECKED';
    }
    el.textContent = t; el.className = 'badge' + (c ? ' ' + c : '');
  }
  function diagRender() {
    if (diagRaf) return;
    diagRaf = requestAnimationFrame(() => { diagRaf = 0; diagDraw(); });
  }
  function diagDraw() {
    const box = $('#dgTerm'); if (!box || diagPaused) return;
    const q = diagText.trim().toLowerCase();
    const rows = diagLog.filter(e => (diagLevel === 'all' || e.lv === diagLevel) && (diagCat === 'all' || e.cat === diagCat) && (!q || (e.cat + ' ' + e.msg).toLowerCase().includes(q)));
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = rows.length
      ? rows.slice(-250).map(e => `<div class="ln dg-${esc(e.lv)}"><span class="ts">[${esc(String(e.t).slice(11, 19))}]</span> <span class="dg-lv">${esc(DG_LV[e.lv] || e.lv)}</span> <span class="dg-cat">${esc(e.cat)}</span> ${esc(e.msg)}${e.n > 1 ? ` <span class="ts">x${e.n}</span>` : ''}${e.ms != null ? ` <span class="ts">${esc(e.ms)}ms</span>` : ''}</div>`).join('')
      : '<div class="empty">$ no events match. Use a Steam feature or press "Run diagnostics".</div>';
    if (stick) box.scrollTop = box.scrollHeight;
    const c = $('#dgCount'); if (c) c.textContent = rows.length + ' of ' + diagLog.length + ' events shown (times in UTC)';
  }
  function diagDrawChecks() {
    const box = $('#dgChecks'); if (!box) return;
    box.innerHTML = diagChecks.map(c => `<div class="dg-chk ${esc(c.st)}"><span class="dg-ic">${esc(DG_ST[c.st] || c.st)}</span><div><b>${esc(c.name)}</b><span>${esc(c.detail)}</span></div><em>${c.ms != null ? Math.round(c.ms) + ' ms' : ''}</em></div>`).join('');
  }

  /* Raw request used by the checks (no race, no cache): resolves with a result object, never throws. */
  async function diagFetch(url, init, ms) {
    const t0 = performance.now();
    try {
      const res = await fetchText(url, init || {}, ms || 8000);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, text: res.text, up: res.upstream, ms: performance.now() - t0 };
    } catch (e) {
      return { ok: false, status: 0, text: '', ms: performance.now() - t0, err: e && e.name === 'AbortError' ? 'timed out' : 'network or CORS error (nothing reached the page)' };
    }
  }
  async function diagProbe(rt, url, init, ms) {
    const r = await diagFetch(rt.direct ? url : routeUrl(rt, url), init, ms);
    if (rt.wrap && r.status) {
      try { const w = JSON.parse(r.text); r.status = (w.status && w.status.http_code) || r.status; r.text = typeof w.contents === 'string' ? w.contents : ''; r.ok = r.status >= 200 && r.status < 300; }
      catch { r.ok = false; r.err = 'unreadable proxy wrapper'; }
    }
    return r;
  }

  async function diagRun() {
    const btn = $('#dgRun'); if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Running...';
    diagChecks = []; diagDrawChecks();
    diag('info', 'diag', '--- diagnostics run started ---');
    const add = (st, name, detail, ms) => {
      diagChecks.push({ st, name, detail, ms });
      diag(st === 'ok' ? 'ok' : st === 'fail' ? 'error' : st === 'warn' ? 'warn' : 'info', 'diag', name + ': ' + detail, ms);
      diagDrawChecks();
    };
    /* Judge an answer that came through the Worker's /fetch route. */
    const via = (name, r, test, okMsg) => {
      if (r.ok && test(r.text)) return add('ok', name, okMsg(r), r.ms);
      let why = r.err || (r.ok ? 'unexpected response body' : 'HTTP ' + r.status);
      if (!r.err && r.status >= 400 && !r.up) { let m = ''; try { m = JSON.parse(r.text).error || ''; } catch { /* not JSON */ } why = 'the Worker refused the request: ' + (m || 'HTTP ' + r.status); }
      else if (r.up && !r.ok) why = 'Steam answered HTTP ' + r.up + ' to the Worker';
      add('fail', name, why, r.ms);
    };
    try {
      const b = bridgeUrl(), cfg = settings.steamCfg;

      /* 1. page address + storage */
      const proto = location.protocol;
      if (!/^https?:$/.test(proto)) add('fail', 'Page address', 'Opened from ' + proto + ' . Steam login and the bridge need http(s): host the site or use a local web server.');
      else if (proto === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) add('warn', 'Page address', location.origin + ' is not HTTPS. Add exactly this origin to the Worker ALLOWED_ORIGINS.');
      else add('ok', 'Page address', location.origin + ' (this exact origin must be listed in the Worker ALLOWED_ORIGINS unless it is "*")');
      const store = st => { try { const k = '__mway_t'; st.setItem(k, '1'); st.removeItem(k); return true; } catch { return false; } };
      const ss = store(sessionStorage), ls = store(localStorage);
      add(ss ? 'ok' : 'fail', 'Session storage', ss ? 'Available (holds the Steam login state).' : 'Blocked. The Steam login cannot complete without it (private mode or blocked site data?).');
      add(ls ? 'ok' : 'warn', 'Local storage', ls ? 'Available (settings and this log are saved).' : 'Blocked. Settings and logs only last for this page view.');

      /* 2. bridge */
      if (!b) {
        add(cfg.bridge ? 'fail' : 'warn', 'Bridge', cfg.bridge
          ? 'The saved bridge URL is not valid. It must start with https://'
          : 'No bridge URL set (Admin > Steam API Provisioning, or BRIDGE_CONFIG.url in script.js). Public proxies are used, and Steam often blocks them.');
      } else {
        const t0 = performance.now(); let caps = null;
        try {
          caps = await probeBridge(true);
          add('ok', 'Bridge /health', 'Online at ' + shortUrl(b) + '. Steam key on bridge: ' + (caps.steamKey ? 'yes' : 'no') + ', KV bound: ' + (caps.kv ? 'yes' : 'no') + (caps.colo ? ', edge ' + caps.colo : '') + '.', performance.now() - t0);
        } catch (e) { add('fail', 'Bridge /health', bridgeErr || e.message, performance.now() - t0); }
        if (caps) {
          const rt = { u: b + '/fetch?url={url}', bridge: true };
          via('Bridge to Steam Web API', await diagProbe(rt, DG_API), t => /servertime/i.test(t), r => 'Steam API reachable through the bridge (HTTP ' + r.status + ').');
          via('Bridge to Steam Community', await diagProbe(rt, DG_XML), t => /<steamID64>/i.test(t), r => 'Public profile XML reachable through the bridge (HTTP ' + r.status + ').');
          const o = await diagFetch(b + '/openid/verify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'openid.mode=id_res&openid.ns=diagnostic-probe' }, 8000);
          let oj = null; try { oj = JSON.parse(o.text); } catch { /* not JSON */ }
          if (oj && oj.valid === false && o.status === 400) add('ok', 'Bridge /openid/verify', 'Route is live and rejects a forged login, as it should.', o.ms);
          else add('fail', 'Bridge /openid/verify', o.err || 'Unexpected answer (HTTP ' + o.status + ').', o.ms);
          const w = await diagFetch(b + '/diag', {}, 12000);
          let wj = null; try { wj = JSON.parse(w.text); } catch { /* not JSON */ }
          if (wj && Array.isArray(wj.checks)) {
            wj.checks.forEach(c => {
              const st = c.status >= 200 && c.status < 400 ? 'ok' : (c.status === 403 || c.status === 429) ? 'warn' : c.status > 0 && c.status < 500 ? 'ok' : 'fail';
              add(st, 'Worker to ' + c.name, c.status ? 'Steam answered HTTP ' + c.status + (st === 'warn' ? ' (Steam may be blocking or rate limiting the Worker).' : '.') : (c.error || 'unreachable'), c.ms);
            });
          } else if (w.status === 404 || (w.ok && !wj)) add('warn', 'Worker to Steam', 'This Worker has no /diag route. Redeploy the updated worker.js to enable this check.', w.ms);
          else add('fail', 'Worker to Steam', w.err || 'HTTP ' + w.status, w.ms);
        }
      }

      /* 3. Steam Web API key */
      if (/^[A-Fa-f0-9]{32}$/.test(cfg.key || '') || bridgeHoldsKey()) {
        const t0 = performance.now();
        try {
          const r = await steamApi('ISteamUser/GetPlayerSummaries/v2', { steamids: '76561197960287930' }, { ttl: 0 });
          const n = ((r.response || {}).players || []).length;
          add(n ? 'ok' : 'warn', 'Steam Web API key', n ? 'Accepted' + (bridgeHoldsKey() ? ' (key held by the bridge).' : '.') : 'The call worked but returned no player.', performance.now() - t0);
        } catch (e) { add('fail', 'Steam Web API key', e.code === 'AUTH' ? 'Rejected (HTTP 401/403): the key is wrong or revoked, or the route blocked the call.' : e.message, performance.now() - t0); }
      } else add('warn', 'Steam Web API key', 'No key saved here and none on the bridge. Level, playtime and detailed bans are unavailable.');

      /* 4. public proxies */
      if (b && cfg.bridgeOnly) add('skip', 'Public proxies', 'Not tested: bridge-only mode is on.');
      else {
        const list = cfg.proxy ? [{ u: cfg.proxy, post: true }] : PROXIES;
        const res = await Promise.all(list.map(p => diagProbe(p, DG_API, {}, 7000)));
        res.forEach((r, i) => {
          const nm = 'Proxy ' + routeName(list[i]);
          if (r.ok && /servertime/i.test(r.text)) add('ok', nm, 'Reached the Steam API (HTTP ' + r.status + ').', r.ms);
          else add('fail', nm, r.err || ('HTTP ' + r.status + (r.status === 403 || r.status === 429 ? ' (blocked or rate limited)' : '')), r.ms);
        });
      }
      const f = diagChecks.filter(c => c.st === 'fail').length, w = diagChecks.filter(c => c.st === 'warn').length;
      diag(f ? 'error' : w ? 'warn' : 'ok', 'diag', 'summary: ' + f + ' failed, ' + w + ' warning(s), ' + diagChecks.filter(c => c.st === 'ok').length + ' ok');
      toast(f ? f + ' check(s) failed. See the list and the log.' : 'Diagnostics finished: no failures.');
    } catch (e) {
      add('fail', 'Diagnostics runner', (e && e.message) || 'unexpected error');
    } finally {
      diag('info', 'diag', '--- diagnostics run finished ---');
      diagBadge(); btn.disabled = false; btn.textContent = 'Run diagnostics';
    }
  }

  function diagReport() {
    const b = bridgeUrl(), cfg = settings.steamCfg, L = [];
    L.push('MWAY LABS diagnostics report', 'Generated: ' + new Date().toISOString(), 'Page: ' + location.origin + location.pathname, 'User agent: ' + navigator.userAgent);
    L.push('Bridge: ' + (b || 'not set') + (b ? (bridgeCaps && bridgeCaps.url === b ? ' (online, steam key on bridge: ' + bridgeCaps.steamKey + ', kv: ' + bridgeCaps.kv + ')' : bridgeErr ? ' (offline: ' + bridgeErr + ')' : ' (unchecked)') : ''));
    L.push('Bridge only: ' + (cfg.bridgeOnly !== false), 'Custom proxy: ' + (cfg.proxy ? 'set' : 'none'), 'Steam key saved in this browser: ' + (/^[A-Fa-f0-9]{32}$/.test(cfg.key || '') ? 'yes' : 'no'), '');
    if (diagChecks.length) {
      L.push('Checks:');
      diagChecks.forEach(c => L.push('  [' + (DG_ST[c.st] || c.st) + '] ' + c.name + ': ' + c.detail + (c.ms != null ? ' (' + Math.round(c.ms) + ' ms)' : '')));
      L.push('');
    }
    L.push('Log (UTC, oldest first, last 150 events):');
    diagLog.slice(-150).forEach(e => L.push(String(e.t).slice(11, 19) + ' ' + String(DG_LV[e.lv] || e.lv).padEnd(4) + ' ' + String(e.cat).padEnd(6) + ' ' + e.msg + (e.n > 1 ? ' x' + e.n : '') + (e.ms != null ? ' ' + e.ms + 'ms' : '')));
    return redact(L.join('\n'));
  }
  function diagExport() {
    try {
      const url = URL.createObjectURL(new Blob([diagReport()], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = 'mway-diagnostics-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { toast('Export failed.'); }
  }
  function diagInit() {
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
    on('#dgRun', 'click', diagRun);
    on('#dgCopy', 'click', async () => toast(await copyText(diagReport()) ? 'Report copied (secrets removed).' : 'Copy failed.'));
    on('#dgExport', 'click', diagExport);
    on('#dgClear', 'click', () => {
      diagLog = []; diagChecks = []; try { localStorage.removeItem('mway_diag'); } catch { /* ignore */ }
      diagDrawChecks(); diagDraw(); toast('Diagnostics cleared.');
    });
    $$('#dgLevels [data-dgl]').forEach(btn => btn.addEventListener('click', () => {
      diagLevel = btn.dataset.dgl;
      $$('#dgLevels [data-dgl]').forEach(x => x.setAttribute('aria-pressed', String(x === btn)));
      diagDraw();
    }));
    on('#dgCat', 'change', e => { diagCat = e.target.value; diagDraw(); });
    on('#dgSearch', 'input', e => { diagText = e.target.value; diagDraw(); });
    on('#dgPause', 'change', e => { diagPaused = e.target.checked; if (!diagPaused) diagDraw(); });
    window.addEventListener('error', e => diag('error', 'js', (e.message || 'script error') + (e.filename ? ' @ ' + shortUrl(e.filename) + ':' + e.lineno : '')));
    window.addEventListener('unhandledrejection', e => diag('error', 'js', 'unhandled promise rejection: ' + ((e.reason && e.reason.message) || e.reason)));
    diag('info', 'app', 'page loaded on ' + location.origin + ', bridge ' + (bridgeUrl() ? 'configured' : 'not set'));
    diagBadge(); diagDraw(); diagDrawChecks();
  }

  const KP = { timer: 0, busy: false, again: false, cleared: new Set() };
  const KEY_LABEL = { steam: 'Steam', csfloat: 'CSFloat', leetify: 'Leetify', faceit: 'Faceit' };
  function keysAfterRead(before) {
    const c = settings.steamCfg, now = { steam: c.key, csfloat: c.floatKey, leetify: c.leetifyKey, faceit: c.faceitKey };
    Object.keys(now).forEach(k => { if (before[k] && !now[k]) KP.cleared.add(k); else if (now[k]) KP.cleared.delete(k); });
    if (!isAdmin()) return;
    clearTimeout(KP.timer); KP.timer = setTimeout(() => keysPush(false), 700);
  }
  const keyVerdict = ks => Object.keys(KEY_LABEL).filter(k => ks[k] && ks[k].set).map(k => KEY_LABEL[k] + ' ' + ks[k].status + (ks[k].status === 'failing' && ks[k].detail ? ' (' + ks[k].detail + ')' : '')).join(', ') || 'no keys set';
  async function keysPush(manual) {
    if (!isAdmin()) return false;
    const b = bridgeUrl(), tok = gsToken();
    if (!b || !tok) { if (manual) stStatus('Keys are saved in this browser only. Set the bridge URL and the ADMIN_TOKEN (Global Sync) to send them to the server.', true); return false; }
    if (KP.busy) { KP.again = true; return false; }
    KP.busy = true; const t0 = performance.now(), c = settings.steamCfg, auth = { Authorization: 'Bearer ' + tok };
    const cur = { steam: c.key || '', csfloat: c.floatKey || '', leetify: c.leetifyKey || '', faceit: c.faceitKey || '' };
    try {
      const g = await fetchText(b + '/admin/keys', { headers: auth }, 10000);
      let gj = null; try { gj = JSON.parse(g.text); } catch { /* not JSON */ }
      if (g.status === 401) throw new Error('the Worker rejected the ADMIN_TOKEN');
      if (g.status === 404) throw new Error('the Worker is still the old version: deploy the new worker.js');
      if (g.status !== 200 || !gj || !gj.ok) throw new Error((gj && gj.error) || 'HTTP ' + g.status);
      const server = gj.keys || {}, body = {};
      Object.keys(cur).forEach(k => {
        const s = server[k] || {};
        if (cur[k]) { if (manual || !s.set || s.source !== 'admin' || s.last4 !== cur[k].slice(-4)) body[k] = cur[k]; }   // missing or different on the server
        else if (KP.cleared.has(k) && s.set && s.source === 'admin') body[k] = '';                                        // explicitly cleared here
      });
      if (!Object.keys(body).length) { if (manual) stStatus('The server already has these keys: ' + keyVerdict(server)); return true; }
      const res = await fetchText(b + '/admin/keys', { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify(body) }, 25000);
      let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
      if (res.status !== 200 || !j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + res.status);
      KP.cleared.clear();
      const bad = Object.keys(j.rejected || {}), failing = Object.values(j.keys).some(k => k.status === 'failing');
      diag(failing ? 'warn' : 'ok', 'state', 'API keys sent to the bridge (' + (j.changed || []).join(', ') + '): ' + keyVerdict(j.keys), performance.now() - t0);
      stStatus('Keys are live on the server now: ' + keyVerdict(j.keys) + (bad.length ? '. Not accepted: ' + bad.map(k => KEY_LABEL[k] + ' - ' + j.rejected[k]).join('; ') : '') + '.', failing || bad.length > 0);
      if (manual) toast('Keys sent to the server.');
      probeBridge(true).catch(() => {});     // refresh "key on bridge" so the browser stops sending its own copy
      SL.keys = j.keys; slDraw();
      return true;
    } catch (e) {
      const why = e instanceof TypeError ? 'could not reach the bridge' : e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'unknown error';
      diag('error', 'state', 'sending API keys failed: ' + why, performance.now() - t0);
      stStatus('Keys saved in this browser, but could not be sent to the server: ' + why + '.', true);
      return false;
    } finally { KP.busy = false; if (KP.again) { KP.again = false; setTimeout(() => keysPush(false), 300); } }
  }

  const SL = { entries: [], keys: null, info: null, at: 0, busy: false };
  async function slReq(path, init) {
    const b = bridgeUrl(), tok = gsToken();
    if (!b || !tok) throw new Error('Set the bridge URL and the ADMIN_TOKEN (Global Sync) first.');
    const res = await fetchText(b + path, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + tok }, (init && init.headers) || {}) }), 20000);
    if (res.status === 401) throw new Error('the Worker rejected the ADMIN_TOKEN');
    if (res.status === 404) throw new Error('the Worker is still the old version: deploy the new worker.js');
    return res;
  }
  function slDraw() {
    const kb = $('#slKeys'), box = $('#slTerm'); if (!kb || !box) return;
    const cls = { working: 'ok', failing: 'fail', unknown: 'warn', unset: 'skip' }, txt = { working: 'WORKING', failing: 'FAILING', unknown: 'UNKNOWN', unset: 'NOT SET' };
    kb.innerHTML = SL.keys ? Object.keys(KEY_LABEL).map(k => {
      const x = SL.keys[k] || { status: 'unset' };
      return `<div class="dg-chk ${cls[x.status] || 'skip'}"><span class="dg-ic">${esc(txt[x.status] || x.status)}</span><div><b>${esc(KEY_LABEL[k])} key</b><span>${x.set ? esc('stored on the server (' + (x.source === 'admin' ? 'from Admin' : 'Cloudflare secret') + ', ends ...' + x.last4 + ')') + (x.detail ? ' - ' + esc(x.detail) : '') : 'no key on the server'}</span></div><em>${x.checked ? esc(String(x.checked).slice(11, 19)) + ' UTC' : ''}</em></div>`;
    }).join('') : '';
    const errOnly = $('#slErrOnly') && $('#slErrOnly').checked, rows = SL.entries.filter(e => !errOnly || e.lv === 'error' || e.lv === 'warn');
    box.innerHTML = rows.length
      ? rows.slice(-300).map(e => `<div class="ln dg-${esc(e.lv)}"><span class="ts">[${esc(String(e.t).slice(5, 19).replace('T', ' '))}]</span> <span class="dg-lv">${esc(DG_LV[e.lv] || e.lv)}</span> <span class="dg-cat">${esc(e.cat)}</span> ${esc(e.msg)}${e.n > 1 ? ` <span class="ts">x${e.n}</span>` : ''}</div>`).join('')
      : '<div class="empty">$ no server events yet. Press "Refresh" after using the site.</div>';
    const i = SL.info, c = $('#slCount');
    if (c) c.textContent = SL.at ? rows.length + ' server events (UTC)' + (i ? ' | Worker v' + i.version + (i.inventoryCooldownSeconds ? ' | inventory cooldown ' + i.inventoryCooldownSeconds + ' s' : ' | inventory OK') : '') : 'Not loaded yet.';
  }
  async function slLoad(quiet) {
    if (!isAdmin() || SL.busy) return;
    SL.busy = true;
    try {
      const res = await slReq('/admin/log'); let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
      if (res.status !== 200 || !j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + res.status);
      SL.entries = j.entries || []; SL.keys = j.keys; SL.info = j.info; SL.at = Date.now(); slDraw();
    } catch (e) { if (!quiet) toast('Server log: ' + ((e && e.message) || 'could not load')); const c = $('#slCount'); if (c) c.textContent = 'Could not load the server log: ' + ((e && e.message) || 'unknown error'); }
    finally { SL.busy = false; }
  }
  async function slDownload() {
    try {
      const res = await slReq('/admin/log?format=text');
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      const url = URL.createObjectURL(new Blob([res.text], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a');
      a.href = url; a.download = 'mway-server-log-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast('Download failed: ' + ((e && e.message) || 'unknown error')); }
  }
  async function slTest() {
    const btn = $('#slTest'); btn.disabled = true;
    try {
      const res = await slReq('/admin/keys/test', { method: 'POST' }); let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
      if (res.status !== 200 || !j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + res.status);
      SL.keys = j.keys; slDraw(); toast('Keys tested: ' + keyVerdict(j.keys)); slLoad(true);
    } catch (e) { toast('Key test failed: ' + ((e && e.message) || 'unknown error')); } finally { btn.disabled = false; }
  }
  async function slClear() {
    try { const res = await slReq('/admin/log', { method: 'DELETE' }); if (res.status !== 200) throw new Error('HTTP ' + res.status); SL.entries = []; slDraw(); toast('Server log cleared.'); }
    catch (e) { toast('Clear failed: ' + ((e && e.message) || 'unknown error')); }
  }
  function slInit() {
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
    on('#slRefresh', 'click', () => slLoad(false)); on('#slDownload', 'click', slDownload); on('#slTest', 'click', slTest); on('#slClear', 'click', slClear);
    on('#slErrOnly', 'change', slDraw); on('#stKeysPush', 'click', () => { readSteamInputs(); keysPush(true); });
    // keys take effect while typing/pasting: save + send ~1 s after the last keystroke
    let kt = 0; ['#stKey', '#stFloat', '#stFaceit', '#stFaceitName', '#stLeetify'].forEach(sel => on(sel, 'input', () => { clearTimeout(kt); kt = setTimeout(readSteamInputs, 900); }));
    // while the Admin page is open, refresh the server log every 20 s
    setInterval(() => { const pg = $('#admin'); if (!document.hidden && isAdmin() && pg && pg.classList.contains('active') && Date.now() - SL.at > 20000) slLoad(true); }, 5000);
    slDraw();
  }

  /* =====================================================================
     12g. GLOBAL SYNC: settings are shared through the Worker (GET/PUT /state, backed by KV)
     Visitors load the published copy on every page view (and re-check while the page stays open). The Admin's saves are
     PUT to the Worker with the ADMIN_TOKEN. Secrets (Steam / CSFloat / Leetify / Faceit / HLTV keys, proxy, bridge URL)
     are never published: they stay in the Admin's own browser (and as Worker secrets).
     ===================================================================== */
  const GS_TOKEN_KEY = 'mway_admin_token', GS_DIRTY_KEY = 'mway_gs_dirty', GS_REV_KEY = 'mway_gs_rev';
  const GS_PRIVATE = ['key', 'proxy', 'bridge', 'floatKey', 'hltvKey', 'leetifyKey', 'faceitKey'];
  const gsStored = () => { try { return (localStorage.getItem(GS_TOKEN_KEY) || '').trim(); } catch { return ''; } };
  const gsToken = () => gsStored() || (session && session.admin && session.tok) || '';
  const gsDirty = () => { try { return localStorage.getItem(GS_DIRTY_KEY) === '1'; } catch { return false; } };
  const gsSetDirty = on => { try { if (on) localStorage.setItem(GS_DIRTY_KEY, '1'); else localStorage.removeItem(GS_DIRTY_KEY); } catch { /* storage blocked */ } };
  const lsPut = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full: the in-memory copy still works */ } };
  function gsIdleMsg() {
    if (!bridgeUrl()) return 'Set the Worker bridge URL above first: global sync runs through your Worker.';
    if (!gsToken()) return 'Enter the Worker ADMIN_TOKEN and press "Save token & publish now" to share changes with every visitor.';
    return gsDirty() ? 'There are local changes that are not published yet.' : 'Ready. Changes you save are published to visitors automatically.';
  }
  function gsStatus(msg, bad) {
    GS.msg = msg; GS.bad = !!bad;
    const el = $('#gsStatus'); if (el) { el.textContent = msg; el.style.color = bad ? 'var(--danger)' : ''; }
  }
  function gsPublicSettings() {
    const st = JSON.parse(JSON.stringify(settings)), c = st.steamCfg || {};
    st.aboutText = about;
    // The HLTV endpoint is called from every visitor's browser, so it is public by nature; skip it if it looks like it carries a credential.
    const hltvUrl = /[?&](key|token|apikey|api_key|access_token)=/i.test(c.hltvUrl || '') ? '' : (c.hltvUrl || '');
    st.steamCfg = { accounts: c.accounts, last: c.last, cache: c.cache || {}, hltvUrl, bridgeOnly: c.bridgeOnly !== false };
    return st;
  }
  const gsPayload = () => ({ mway_settings: gsPublicSettings() });

  /* Admin side: debounce, then PUT. */
  function gsQueue() {
    if (!isAdmin()) return;
    gsSetDirty(true);
    clearTimeout(GS.timer);
    const warn = () => { if (!GS.warned) { GS.warned = true; toast('Saved on this device only. Your change is NOT published to visitors yet: see Admin > Global Sync.'); } };
    if (!bridgeUrl()) { warn(); return gsStatus('Saved in this browser only. Set the Worker bridge URL to publish changes to visitors.', true); }
    if (!gsToken()) { warn(); return gsStatus('Saved in this browser only. Enter the Worker ADMIN_TOKEN (Admin > Global Sync) to publish changes to visitors.', true); }
    GS.timer = setTimeout(() => { gsPush(false); }, 600);
  }
  async function gsPush(manual, force) {
    const b = bridgeUrl(), tok = gsToken();
    if (!isAdmin() || !b || !tok) { if (manual) gsStatus(gsIdleMsg(), true); return false; }
    if (GS.pulling) { try { await GS.pulling; } catch { /* handled in gsPull */ } }
    if (!GS.synced && !manual) { gsStatus('Not published: the current server copy could not be loaded first, so it was not overwritten. Press "Publish now" to force it.', true); return false; }
    if (GS.busy) { GS.again = true; return false; }
    GS.busy = true; gsStatus('Publishing to visitors...');
    const t0 = performance.now();
    try {
      const res = await fetchText(b + '/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(force ? Object.assign(gsPayload(), { force: true }) : gsPayload()) }, 30000);
      let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
      if (res.status === 200 && j && j.ok) {
        GS.rev = j.rev || GS.rev; GS.synced = true; try { localStorage.setItem(GS_REV_KEY, String(GS.rev)); } catch { /* ignore */ }
        gsSetDirty(false);
        diag('ok', 'state', 'published to visitors (rev ' + GS.rev + ')', performance.now() - t0);
        gsStatus('Published to all visitors (revision ' + GS.rev + ') at ' + fmtTime(new Date().toISOString()) + '.');
        return true;
      }
      throw new Error(res.status === 401 ? 'the Worker rejected the ADMIN_TOKEN (wrong value, or no ADMIN_TOKEN secret set on the Worker)'
        : res.status === 501 ? 'the Worker has no KV namespace bound as MWAY_KV'
        : res.status === 413 ? ((j && j.error) || 'the state is too large')
        : res.status === 403 ? 'the Worker refused this origin (add it to ALLOWED_ORIGINS)'
        : ((j && j.error) || 'HTTP ' + res.status));
    } catch (e) {
      const why = e instanceof TypeError ? 'could not reach the bridge' : e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'unknown error';
      diag('error', 'state', 'publish failed: ' + why, performance.now() - t0);
      gsStatus('Publish failed: ' + why + '. Your changes are saved in this browser and will be retried on the next save.', true);
      if (manual || !GS.failToast) toast('Publish failed: ' + why); GS.failToast = true;
      return false;
    } finally { GS.busy = false; if (GS.again) { GS.again = false; gsQueue(); } }
  }

  /* Visitor side (and the Admin on page load): apply the published copy. */
  function gsApply(j) {
    const keep = settings.steamCfg || {};
    if (j.mway_settings) {
      const ns = buildSettings(j.mway_settings);
      GS_PRIVATE.forEach(k => { ns.steamCfg[k] = keep[k] !== undefined ? keep[k] : DS.steamCfg[k]; });
      if (!ns.steamCfg.hltvUrl) ns.steamCfg.hltvUrl = keep.hltvUrl || '';
      settings = ns; lsPut('mway_settings', settings);
      if (typeof ns.aboutText === 'string' && ns.aboutText) { about = ns.aboutText; lsPut('mway_about', about); }
    }
    GS.rev = j.rev || 0; try { localStorage.setItem(GS_REV_KEY, String(GS.rev)); } catch { /* ignore */ }
    applyAuth();
  }
  function gsPull(o = {}) {
    const b = bridgeUrl();
    if (!b) { GS.pending = false; return Promise.resolve(false); }
    if (GS.pulling) return GS.pulling;
    let haveLocal = false; try { haveLocal = localStorage.getItem('mway_settings') !== null; } catch { /* ignore */ }
    const q = !o.force && haveLocal && GS.rev ? '?rev=' + GS.rev : '';
    const t0 = performance.now();
    GS.pulling = (async () => {
      try {
        const res = await fetchText(b + '/state' + q, {}, 10000);
        let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
        if (res.status === 501) { diag('info', 'state', 'Worker has no KV: global sync inactive'); if (isAdmin()) gsStatus('The Worker has no KV namespace bound as MWAY_KV, so changes cannot be shared with visitors yet.', true); return false; }
        if (res.status !== 200 || !j || !j.ok) throw new Error(res.status === 403 ? 'the Worker refused this origin' : 'HTTP ' + res.status);
        GS.synced = true;
        diag('ok', 'state', 'global state loaded (rev ' + j.rev + (j.unchanged ? ', unchanged' : '') + ')', performance.now() - t0, 'ok|state');
        if (j.unchanged) return true;
        if (!j.mway_settings) { if (isAdmin()) gsStatus('Nothing is published yet. Save any change, or press "Publish now", to share your current setup with visitors.'); return true; }
        if (isAdmin() && gsDirty() && !o.force) { gsStatus('This browser has local changes that are not published. The server copy was NOT applied. Press "Publish now" to overwrite it, or "Reload from server" to discard your local changes.', true); return true; }
        gsApply(j); gsSetDirty(false);
        if (isAdmin()) gsStatus('Loaded the published version (revision ' + j.rev + ').');
        return true;
      } catch (e) {
        const why = e instanceof TypeError ? 'could not reach the bridge' : e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'unknown error';
        diag('warn', 'state', 'global state unavailable: ' + why + ' (showing the last copy stored in this browser)', performance.now() - t0);
        if (isAdmin()) gsStatus('Could not load the published version: ' + why + '.', true);
        return false;
      } finally { GS.pulling = null; GS.pending = false; GS.polled = Date.now(); }
    })();
    return GS.pulling;
  }
  async function gsForce() {
    if (!isAdmin()) return;
    const b = bridgeUrl(), tok = gsToken();
    if (!b || !tok) return gsStatus(gsIdleMsg(), true);
    const btn = $('#gsForce'); btn.disabled = true; gsStatus('Forcing update on the server...');
    try {
      while (GS.busy) await sleep(200);
      if (!(await gsPush(true, true))) return;
      await keysPush(false);
      const res = await fetchText(b + '/state?v=' + Date.now(), {}, 10000);
      let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
      const srv = j && j.mway_settings && j.mway_settings.tabs, same = !!srv && JSON.stringify(srv) === JSON.stringify(gsPublicSettings().tabs);
      gsStatus('Server updated (revision ' + (j && j.rev) + ', tab visibility ' + (same ? 'verified' : 'NOT matching yet, press the button again') + '). Open pages apply it on their next check, normally within ~10-15 s; Cloudflare KV can take up to a minute to reach other regions.', !same);
      toast(same ? 'Server refreshed. Visitors update within seconds.' : 'Pushed, but the server copy does not match yet.');
    } catch (e) { gsStatus('Force update failed: ' + ((e && e.message) || 'unknown error'), true); }
    finally { btn.disabled = false; }
  }
  function gsInit() {
    try { GS.rev = parseInt(localStorage.getItem(GS_REV_KEY), 10) || 0; } catch { GS.rev = 0; }
    $('#gsPublish').addEventListener('click', async () => {
      const v = $('#gsToken').value.trim();
      try { if (v) localStorage.setItem(GS_TOKEN_KEY, v); else localStorage.removeItem(GS_TOKEN_KEY); } catch { /* storage blocked */ }
      if (!isAdmin()) return;
      if (!bridgeUrl() || !gsToken()) return gsStatus(gsIdleMsg(), true);
      const ok = await gsPush(true);
      if (ok) { toast('Published to all visitors.'); keysPush(false); }
    });
    $('#gsPull').addEventListener('click', () => {
      if (!bridgeUrl()) return gsStatus(gsIdleMsg(), true);
      openModal(`<h3>Reload from server</h3><p>Replace this browser's settings with the published version? Unpublished local changes are lost.</p>
        <div class="row"><button class="btn btn-small" id="gpNo">Cancel</button><button class="btn btn-primary btn-small" id="gpYes">Reload</button></div>`);
      $('#gpNo').onclick = closeModal;
      $('#gpYes').onclick = async () => { closeModal(); gsStatus('Loading the published version...'); const ok = await gsPull({ force: true }); if (ok) toast('Reloaded from the server.'); };
    });
    // Visitors: pick up newly published changes without a manual refresh.
    // runs about every 10 s while the tab is visible, and immediately when the tab regains focus.
    const poll = () => { if (!document.hidden && !isAdmin() && bridgeUrl() && Date.now() - GS.polled > 9000) gsPull(); };
    setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    window.addEventListener('focus', poll);
    $('#gsForce').addEventListener('click', gsForce);
  }

  /* =====================================================================
     12h. CS2 UTILITIES (beta): lineup map on Valve's official radar overviews.
     Everyone can browse public lineups. Steam-logged-in users can add lineups (Discord or YouTube video), choose pin colour / pin size /
     landing circle / throw position, post them globally or keep them private, invite collaborators and rate other people's lineups.
     Admins can remove any lineup. Shared data lives on the Worker (/markers); without a reachable Worker lineups stay in this browser.
     Radars: maps/<map>[_lower].png, with the same official files on GitHub as fallback.
     ===================================================================== */
  const UT_MAPS = [['mirage', 'Mirage'], ['inferno', 'Inferno'], ['dust2', 'Dust II'], ['nuke', 'Nuke'], ['overpass', 'Overpass'], ['ancient', 'Ancient'], ['anubis', 'Anubis'], ['vertigo', 'Vertigo'], ['train', 'Train']];
  const UT_LOWER = ['nuke', 'vertigo', 'train'];
  const UT_TYPES = { smoke: ['Smoke', '#9db4d6'], flash: ['Flash', '#f2d65b'], molly: ['Molotov', '#ff7a45'], he: ['HE', '#7ddf8a'], other: ['Other', '#c58bff'] };
  const UT_SIDES = [['both', 'Both sides'], ['t', 'T side'], ['ct', 'CT side']];
  const UT_TECH = [['stand', 'Standing'], ['jump', 'Jump throw'], ['run', 'Running'], ['runjump', 'Run + jump'], ['walk', 'Walking']];
  const UT_COLORS = ['#9db4d6', '#f2d65b', '#ff7a45', '#7ddf8a', '#c58bff', '#ff5c8a', '#4fd6e0', '#ffffff'];
  const UT_HOST = /^(cdn\.discordapp\.com|media\.discordapp\.net|(www\.)?discord(app)?\.com|discord\.gg|(www\.|m\.)?youtube\.com|youtu\.be)$/i;
  const UT_LOCAL = 'mway_markers';
  const UT = { seq: 0, pend: {}, gone: {}, login: false, map: 'mirage', lvl: 0, type: 'all', side: 'all', sort: 'top', mine: false, data: load(UT_LOCAL, {}), sel: '', draft: null, place: false, from: false, remote: false, ready: false, loading: false, at: 0 };
  const utCan = () => !!(session && session.steam);
  const utMember = m => !!(session && session.steam && (m.by === session.id || (m.collab || []).includes(session.id)));
  const utName = id => (UT_MAPS.find(m => m[0] === id) || [id, id])[1];
  const utCol = m => /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : (UT_TYPES[m.type] || UT_TYPES.other)[1];
  const utSeen = () => utCan() || isAdmin();   // community lineups (global ones too) are only shown to Steam-logged-in users and admins
  function utList() {
    if (!utSeen()) return [];
    const l = (UT.data[UT.map] || []).filter(m => (m.lvl || 0) === UT.lvl && (UT.type === 'all' || m.type === UT.type) && (UT.side === 'all' || (m.side || 'both') === UT.side || (m.side || 'both') === 'both') && (!UT.mine || utMember(m)));
    return l.sort(UT.sort === 'new' ? (a, b) => b.ts - a.ts : (a, b) => (b.avg || 0) - (a.avg || 0) || (b.n || 0) - (a.n || 0) || b.ts - a.ts);
  }
  function utUrl(raw) {
    try { const u = new URL(String(raw || '').trim()); return u.protocol === 'https:' && UT_HOST.test(u.hostname) ? u.href : ''; } catch { return ''; }
  }
  function utMedia(u) {
    try {
      const p = new URL(u), h = p.hostname.replace(/^(www\.|m\.)/i, '').toLowerCase(); let id = '';
      if (h === 'youtu.be') id = p.pathname.slice(1).split('/')[0];
      else if (h === 'youtube.com') id = p.searchParams.get('v') || (p.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1] || '';
      if (/^[\w-]{11}$/.test(id)) return { yt: id };
      if (/^(cdn\.discordapp\.com|media\.discordapp\.net)$/.test(h) && /\.(mp4|webm|mov)$/i.test(p.pathname)) return { video: true };
    } catch { /* invalid */ }
    return {};
  }
  const utStars = (avg, n) => n ? `<span class="ut-stars" title="${avg.toFixed(1)} of 5 from ${n} rating${n === 1 ? '' : 's'}">&#9733; ${avg.toFixed(1)} <small>(${n})</small></span>` : '<span class="ut-stars none">unrated</span>';
  function utSay(msg, bad) { const el = $('#utMsg'); if (el) { el.textContent = msg || ''; el.style.color = bad ? 'var(--danger)' : ''; } }
  async function utApi(body) {
    const b = bridgeUrl(); if (!b) throw new Error('no bridge');
    const tok = (session && session.tok) || (isAdmin() ? gsToken() : '');
    const res = await fetchText(b + '/markers', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) }, 12000);
    let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
    if (res.status === 200 && j && j.ok) return j;
    const e = new Error((j && j.error) || 'HTTP ' + res.status); e.status = res.status; throw e;
  }
  function utMerge(server) {   // server copy + my own writes from the last 3 minutes (the shared store can lag behind a fresh save)
    const now = Date.now(), out = {};
    Object.keys(server || {}).forEach(k => { out[k] = (server[k] || []).filter(m => !(UT.gone[m.id] && now - UT.gone[m.id] < 180000)); });
    Object.keys(UT.pend).forEach(id => {
      const p = UT.pend[id]; if (now - p.t > 180000) { delete UT.pend[id]; return; }
      const list = out[p.m.map] = out[p.m.map] || [], i = list.findIndex(x => x.id === id);
      if (i >= 0) list[i] = Object.assign({}, list[i], p.m); else list.push(p.m);
    });
    Object.keys(UT.gone).forEach(id => { if (now - UT.gone[id] > 180000) delete UT.gone[id]; });
    return out;
  }
  async function utLoad() {
    if (UT.loading) return; UT.loading = true; const my = ++UT.seq;
    try {
      const b = bridgeUrl(); if (!b) throw new Error('no bridge');
      const tok = (session && session.tok) || (isAdmin() ? gsToken() : ''), res = await fetchText(b + '/markers', tok ? { headers: { Authorization: 'Bearer ' + tok } } : {}, 10000), j = JSON.parse(res.text);
      if (res.status !== 200 || !j || !j.ok || typeof j.markers !== 'object') throw new Error('unavailable');
      if (my < UT.seq) return;   // a newer save happened while this was loading: its data would be older
      UT.login = !!j.login; UT.data = UT.login ? {} : utMerge(j.markers); UT.remote = true; lsPut(UT_LOCAL, UT.login ? {} : UT.data); utSay('');
    } catch { UT.remote = false; UT.login = false; utSay('Shared lineups are offline (Worker not reachable or not updated). Showing and saving lineups on this device only.'); }
    finally { UT.loading = false; UT.ready = true; UT.at = Date.now(); if (!UT.draft) utDraw(); }
  }
  function utEnter() { utDraw(); if (!UT.ready || Date.now() - UT.at > 20000) utLoad(); }
  function utRefresh() { if (tab3Sub === 'utilities' && $('#tab3').classList.contains('active')) { UT.ready = false; utEnter(); } else utToolbar(); }
  function utToolbar() {
    const can = utCan(), pl = $('#utPlace');
    pl.disabled = !can; pl.classList.toggle('on', UT.place && can); pl.setAttribute('aria-pressed', String(UT.place && can));
    pl.textContent = UT.place && can ? 'Click the map...' : '+ Add lineup';
    pl.title = can ? 'Press, then click the landing spot on the map' : 'Log in with Steam to add lineups';
    $('#utRefresh').classList.toggle('hidden', !utSeen());
    $('#utIntro').textContent = !utSeen() ? 'Log in with Steam to see the community lineups, rate them and add your own. The maps are free to browse.' : can ? 'Press Add lineup, click where the grenade lands, then set colour, size, throw position and a Discord or YouTube video. Post it globally or keep it private.'
      : 'Official CS2 radar maps with community lineups. Log in with Steam to add your own and rate other players\' lineups.';
    $('#utBoard').classList.toggle('placing', (UT.place || UT.from) && can);
    $('#utMine').classList.toggle('hidden', !can); $('#utMine').classList.toggle('on', UT.mine);
  }
  function utImg() {
    const img = $('#utImg'), key = UT.map + ':' + UT.lvl;
    if (img.dataset.key === key) return;
    img.dataset.key = key; img.dataset.n = '0'; img.classList.add('hidden'); $('#utFallback').classList.remove('hidden');
    const low = UT.lvl ? '_lower' : '', srcs = ['maps/' + UT.map + low + '.png', 'https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_' + UT.map + low + '_radar_psd.png'];
    img.onload = () => { img.classList.remove('hidden'); $('#utFallback').classList.add('hidden'); };
    img.onerror = () => { const n = +img.dataset.n + 1; img.dataset.n = String(n); if (n < srcs.length) img.src = srcs[n]; else { img.classList.add('hidden'); $('#utFallback').classList.remove('hidden'); } };
    img.src = srcs[0];
  }
  function utPins() {
    const list = utList(), d = UT.draft, sel = (UT.data[UT.map] || []).find(x => x.id === UT.sel);
    const pct = v => (v * 100).toFixed(2) + '%', area = m => m.area > 0 ? `<span class="ut-area" style="left:${pct(m.x)};top:${pct(m.y)};width:${m.area * 2}%;height:${m.area * 2}%;--c:${utCol(m)}"></span>` : '';
    const lineOf = m => m.fx != null ? `<line x1="${m.fx * 100}" y1="${m.fy * 100}" x2="${m.x * 100}" y2="${m.y * 100}" stroke="${utCol(m)}" stroke-width=".5" stroke-dasharray="1.6 1.2"/>` : '';
    const fromOf = m => m.fx != null ? `<span class="ut-from" style="left:${pct(m.fx)};top:${pct(m.fy)};--c:${utCol(m)}" title="Throw from here"></span>` : '';
    const shown = d ? [d] : sel && list.includes(sel) ? [sel] : [];
    $('#utLines').innerHTML = shown.map(lineOf).join('');
    $('#utPins').innerHTML = list.filter(m => !d || m.id !== d.id).map(area).join('') + (d ? area(d) : '')
      + shown.map(fromOf).join('')
      + list.filter(m => !d || m.id !== d.id).map((m, i) => `<button type="button" class="ut-pin${m.id === UT.sel ? ' sel' : ''}${m.vis === 'private' ? ' priv' : ''}" data-id="${esc(m.id)}" style="left:${pct(m.x)};top:${pct(m.y)};--c:${utCol(m)};--s:${m.size || 26}px" aria-label="${esc(m.title)}"><span>${i + 1}</span></button>`).join('')
      + (d ? `<span class="ut-pin draft" style="left:${pct(d.x)};top:${pct(d.y)};--c:${d.color};--s:${d.size}px"><span>+</span></span>` : '');
    $('#utCount').textContent = list.length + ' lineup' + (list.length === 1 ? '' : 's') + ' on ' + utName(UT.map);
  }
  function utDraw() {
    $('#utMaps').innerHTML = UT_MAPS.map(([id, n]) => `<button type="button" class="ut-map${id === UT.map ? ' on' : ''}" role="tab" aria-selected="${id === UT.map}" data-map="${id}">${esc(n)}<i>${utSeen() ? (UT.data[id] || []).length || '' : ''}</i></button>`).join('');
    const chip = (k, v, n, c, on) => `<button type="button" class="ut-chip${on ? ' on' : ''}" data-${k}="${v}" style="--c:${c}" aria-pressed="${on}">${esc(n)}</button>`;
    $('#utTypes').innerHTML = chip('type', 'all', 'All', '#8fb2ff', UT.type === 'all') + Object.entries(UT_TYPES).map(([k, v]) => chip('type', k, v[0], v[1], UT.type === k)).join('')
      + '<span class="ut-sep"></span>' + [['all', 'Any side']].concat(UT_SIDES.slice(1)).map(([k, n]) => chip('side', k, n, '#8fb2ff', UT.side === k)).join('');
    $('#utSort').value = UT.sort;
    const hasLow = UT_LOWER.includes(UT.map); if (!hasLow) UT.lvl = 0;
    const lv = $('#utLvl'); lv.classList.toggle('hidden', !hasLow);
    lv.innerHTML = hasLow ? [[0, 'Upper'], [1, 'Lower']].map(([k, n]) => chip('lvl', k, n, '#8fb2ff', UT.lvl === k)).join('') : '';
    utImg(); $('#utFbName').textContent = utName(UT.map).toUpperCase(); $('#utFbHint').textContent = 'Radar image could not be loaded';
    utPins(); utToolbar(); utSide();
  }
  const utSel = (arr, cur) => arr.map(([k, n]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
  const utChips = d => (d.collab || []).map(id => `<span class="ut-cchip">${esc(id)}<button type="button" data-cdel="${esc(id)}" aria-label="Remove collaborator">&times;</button></span>`).join('') || '<span class="muted">No collaborators yet.</span>';
  function utForm() {
    const d = UT.draft, owner = !d.id || d.by === session.id, shared = UT.remote;
    return `<h3>${d.id ? 'Edit lineup' : 'New lineup'}</h3>
      <span class="flabel">Title</span><input data-f="title" maxlength="40" value="${esc(d.title)}" placeholder="e.g. A site smoke from T spawn" autocomplete="off">
      <div class="ut-two"><div><span class="flabel">Type</span><select data-f="type">${utSel(Object.entries(UT_TYPES).map(([k, v]) => [k, v[0]]), d.type)}</select></div><div><span class="flabel">Side</span><select data-f="side">${utSel(UT_SIDES, d.side)}</select></div></div>
      <span class="flabel">Technique</span><select data-f="tech">${utSel(UT_TECH, d.tech)}</select>
      <span class="flabel">Pin colour</span><div class="ut-sw">${UT_COLORS.map(c => `<button type="button" class="ut-swb${d.color === c ? ' on' : ''}" data-col="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('')}<input type="color" data-f="color" value="${d.color}" aria-label="Custom colour"></div>
      <span class="flabel">Pin size <b id="utVSize">${d.size}px</b></span><input type="range" data-f="size" min="14" max="44" value="${d.size}">
      <span class="flabel">Landing circle <b id="utVArea">${d.area ? d.area + '%' : 'off'}</b></span><input type="range" data-f="area" min="0" max="12" step="0.5" value="${d.area}">
      <div class="row"><button id="utFromBtn" type="button" class="btn btn-small${UT.from ? ' on' : ''}">${d.fx != null ? 'Move throw position' : 'Set throw position'}</button>${d.fx != null ? '<button id="utFromClr" type="button" class="btn btn-small">Clear</button>' : ''}</div>
      <span class="flabel">Video link (Discord or YouTube)</span><input data-f="url" value="${esc(d.url)}" placeholder="https://youtu.be/... or https://cdn.discordapp.com/..." autocomplete="off" spellcheck="false">
      <span class="flabel">Note (optional)</span><textarea data-f="note" rows="2" maxlength="140" placeholder="Where to stand, which jump or click">${esc(d.note)}</textarea>
      <span class="flabel">Who can see it</span>
      <div class="ut-vis"><label><input type="radio" name="utvis" data-f="vis" value="public"${d.vis === 'public' ? ' checked' : ''}> <b>Global</b> everyone on the site</label>
      <label><input type="radio" name="utvis" data-f="vis" value="private"${d.vis === 'private' ? ' checked' : ''}> <b>Private</b> only you${shared ? ' and your collaborators' : ''}</label></div>
      ${shared && owner ? `<span class="flabel">Collaborators (max 5)</span><div id="utColl" class="ut-cl">${utChips(d)}</div><div class="row"><input id="utCollIn" placeholder="Steam profile URL or SteamID64" autocomplete="off"><button id="utCollAdd" type="button" class="btn btn-small">Add</button></div>
      <p class="muted">Collaborators can edit this lineup and switch it between private and global.</p>` : ''}
      ${!shared ? '<p class="muted">Offline mode: this lineup is saved on this device only (no collaborators or ratings).</p>' : ''}
      <div class="row"><button id="utSave" type="button" class="btn btn-primary btn-small">${d.id ? 'Save changes' : 'Save lineup'}</button><button id="utCancel" type="button" class="btn btn-small">Cancel</button></div>`;
  }
  function utSide() {
    const el = $('#utSide'), m = utSeen() ? (UT.data[UT.map] || []).find(x => x.id === UT.sel) : null;
    if (!utSeen()) { el.innerHTML = '<h3>Community lineups</h3><p>Global lineups, ratings and collaborations are for players logged in with Steam.</p><p class="muted">Use the Steam button at the top of the page, then come back here.</p>'; return; }
    if (UT.draft && utCan()) { if (!el.querySelector('[data-f="title"]')) el.innerHTML = utForm(); return; }
    if (m) {
      const t = UT_TYPES[m.type] || UT_TYPES.other, v = utUrl(m.url), md = v ? utMedia(v) : {}, mem = utMember(m), own = utCan() && session.id === m.by, adm = isAdmin();
      const side = (UT_SIDES.find(x => x[0] === (m.side || 'both')) || [, 'Both sides'])[1], tech = (UT_TECH.find(x => x[0] === (m.tech || 'stand')) || [, 'Standing'])[1];
      const rate = UT.remote && utCan() && !mem ? `<div class="ut-rate" role="group" aria-label="Rate this lineup"><span class="muted">Your rating</span>${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= (m.mine || 0) ? 'on' : ''}" data-rate="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">&#9733;</button>`).join('')}${m.mine ? '<button type="button" class="ut-rclr" data-rate="0">clear</button>' : ''}</div>`
        : UT.remote && !utCan() ? '<p class="muted">Log in with Steam to rate this lineup.</p>' : '';
      el.innerHTML = `<button id="utBack" type="button" class="btn btn-small">&larr; All lineups</button>
        <h3>${esc(m.title)}</h3><div class="ut-meta"><span class="ut-tag" style="--c:${t[1]}">${esc(t[0])}</span><span class="ut-tag" style="--c:#8fb2ff">${esc(side)}</span><span class="ut-tag" style="--c:#8fb2ff">${esc(tech)}</span>${m.vis === 'private' ? '<span class="ut-tag" style="--c:#ffb454">PRIVATE</span>' : ''}</div>
        <div class="ut-meta">${utStars(m.avg || 0, m.n || 0)}<span class="muted">by ${esc(m.name || m.by)} &middot; ${esc(new Date(m.ts).toISOString().slice(0, 10))}</span></div>
        ${(m.collab || []).length ? `<p class="muted">With ${(m.collab || []).map(c => `<a href="#/gaming/account" data-lk="${esc(c)}">${esc(c)}</a>`).join(', ')}</p>` : ''}
        ${m.note ? `<p>${esc(m.note)}</p>` : ''}
        ${md.yt ? `<iframe class="ut-video" src="https://www.youtube-nocookie.com/embed/${esc(md.yt)}" title="Lineup video" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>` : ''}
        ${md.video ? `<video class="ut-video" controls preload="metadata" src="${esc(v)}"></video>` : ''}
        ${v ? `<a class="btn btn-primary btn-small" href="${esc(v)}" target="_blank" rel="noopener noreferrer">Open video in a new tab</a>` : '<p class="muted">No valid video link.</p>'}
        ${rate}
        <div class="row">${mem ? '<button id="utEdit" type="button" class="btn btn-small">Edit</button>' : ''}${mem ? `<button id="utVis" type="button" class="btn btn-small">${m.vis === 'private' ? 'Make global' : 'Make private'}</button>` : ''}
        ${utCan() && !own && mem ? '<button id="utLeave" type="button" class="btn btn-small">Leave collab</button>' : ''}
        ${own || adm ? `<button id="utDel" type="button" class="btn btn-small btn-danger">${own ? 'Delete' : 'Remove (admin)'}</button>` : ''}</div>`;
      return;
    }
    const list = utList();
    el.innerHTML = `<h3>${esc(utName(UT.map))} lineups</h3>` + (list.length ? `<ul class="ut-list">${list.map((x, i) => `<li><button type="button" data-id="${esc(x.id)}"><b style="--c:${utCol(x)}">${i + 1}</b><span class="ut-lt">${esc(x.title)}${x.vis === 'private' ? ' <em>private</em>' : ''}</span>${x.n ? `<small>&#9733; ${x.avg.toFixed(1)}</small>` : ''}</button></li>`).join('')}</ul>`
      : '<p class="muted">No lineups here yet.' + (utCan() ? ' Press Add lineup to create the first one.' : ' Log in with Steam to add one.') + '</p>');
  }
  const utBlank = (x, y) => ({ x, y, fx: null, fy: null, type: 'smoke', side: 'both', tech: 'stand', color: UT_TYPES.smoke[1], size: 26, area: 0, title: '', url: '', note: '', vis: 'public', collab: [], lvl: UT.lvl });
  function utStore(map, list) { UT.data[map] = list; UT.seq++; lsPut(UT_LOCAL, UT.data); }
  const utKeep = m => { UT.pend[m.id] = { m, t: Date.now() }; delete UT.gone[m.id]; };
  async function utSave() {
    const d = UT.draft; if (!utCan() || !d) return;
    d.url = utUrl(d.url) || d.url; const title = String(d.title || '').trim();
    if (!title) return toast('Give the lineup a title.');
    if (!utUrl(d.url)) return toast('Use an https video link from YouTube or Discord.');
    const payload = Object.assign({}, d, { title, map: UT.map, name: String(session.name || session.id).slice(0, 32) });
    $('#utSave').disabled = true;
    try {
      let m;
      if (UT.remote) m = (await utApi(d.id ? { op: 'edit', id: d.id, marker: payload } : { op: 'add', marker: payload })).marker;
      else m = d.id ? Object.assign({}, d, payload, { upd: Date.now() }) : Object.assign({}, payload, { id: 'l' + Date.now().toString(36), by: session.id, ts: Date.now(), avg: 0, n: 0 });
      const list = (UT.data[UT.map] || []).filter(x => x.id !== m.id); utStore(UT.map, list.concat(m)); utKeep(m); UT.sel = m.id; UT.type = 'all'; UT.side = 'all'; UT.mine = false; UT.lvl = m.lvl || 0;
      toast(d.id ? 'Lineup updated.' : UT.remote ? (m.vis === 'private' ? 'Saved privately.' : 'Lineup posted globally.') : 'Lineup saved on this device only.');
      UT.draft = null; UT.place = false; UT.from = false; $('#utSide').innerHTML = '';
    } catch (e) { toast(e.status === 401 ? 'Your Steam session has no write permission. Log out and log in with Steam again.' : 'Could not save: ' + e.message); $('#utSave') && ($('#utSave').disabled = false); return; }
    utDraw();
  }
  async function utAct(op, extra, okMsg) {
    const m = (UT.data[UT.map] || []).find(x => x.id === UT.sel); if (!m) return;
    try {
      if (UT.remote && m.id[0] !== 'l') {
        const j = await utApi(Object.assign({ op, id: m.id }, extra || {}));
        if (j.marker) { utStore(UT.map, (UT.data[UT.map] || []).map(x => x.id === m.id ? j.marker : x)); utKeep(j.marker); }
        else { utStore(UT.map, (UT.data[UT.map] || []).filter(x => x.id !== m.id)); UT.gone[m.id] = Date.now(); delete UT.pend[m.id]; }
      } else if (op === 'del') { utStore(UT.map, (UT.data[UT.map] || []).filter(x => x.id !== m.id)); UT.gone[m.id] = Date.now(); }
      else if (op === 'edit') utStore(UT.map, (UT.data[UT.map] || []).map(x => x.id === m.id ? Object.assign({}, x, extra.marker) : x));
      if (op === 'del' || op === 'leave') UT.sel = '';
      if (okMsg) toast(okMsg);
    } catch (e) { toast('Could not do that: ' + e.message); }
    utDraw();
  }
  function utDraftSet(el) {
    const f = el.dataset.f, d = UT.draft; if (!f || !d) return;
    d[f] = el.type === 'range' ? +el.value : el.value;
    if (f === 'size') $('#utVSize').textContent = d.size + 'px';
    if (f === 'area') $('#utVArea').textContent = d.area ? d.area + '%' : 'off';
    if (f === 'color') $$('#utSide .ut-swb').forEach(b => b.classList.toggle('on', b.dataset.col === d.color));
    if (['size', 'area', 'color'].includes(f)) utPins();
  }
  async function utAddCollab() {
    const d = UT.draft, inp = $('#utCollIn'); if (!d || !inp.value.trim()) return;
    if ((d.collab || []).length >= 5) return toast('Up to 5 collaborators.');
    try {
      const p = lkParse(inp.value); if (!p || p.err) throw new Error('not a Steam profile or ID');
      const id = p.id || await lkResolve(p.vanity); if (!id) throw new Error('profile not found');
      if (id === session.id) throw new Error('that is you');
      d.collab = [...new Set((d.collab || []).concat(id))]; inp.value = ''; $('#utColl').innerHTML = utChips(d);
    } catch (e) { toast('Could not add collaborator: ' + e.message); }
  }
  function utInit() {
    $('#utMaps').addEventListener('click', e => { const b = e.target.closest('[data-map]'); if (!b || UT.draft) return; UT.map = b.dataset.map; UT.lvl = 0; UT.sel = ''; utDraw(); });
    $('#utTypes').addEventListener('click', e => { const t = e.target.closest('[data-type]'), s = e.target.closest('[data-side]'); if (t) UT.type = t.dataset.type; else if (s) UT.side = s.dataset.side; else return; UT.sel = ''; utDraw(); });
    $('#utLvl').addEventListener('click', e => { const b = e.target.closest('[data-lvl]'); if (!b || UT.draft) return; UT.lvl = +b.dataset.lvl; UT.sel = ''; utDraw(); });
    $('#utSort').addEventListener('change', e => { UT.sort = e.target.value; utDraw(); });
    $('#utRefresh').addEventListener('click', () => { UT.ready = false; utLoad(); toast('Refreshing lineups...'); });
    $('#utMine').addEventListener('click', () => { UT.mine = !UT.mine; UT.sel = ''; utDraw(); });
    $('#utPlace').addEventListener('click', () => {
      if (!utCan()) return toast('Log in with Steam to add lineups.');
      UT.place = !UT.place; UT.draft = null; UT.sel = ''; UT.from = false; $('#utSide').innerHTML = ''; utDraw();
    });
    $('#utBoard').addEventListener('click', e => {
      const pin = e.target.closest('.ut-pin[data-id]');
      if (pin && !UT.draft) { UT.sel = pin.dataset.id; UT.place = false; return utDraw(); }
      if (!utCan()) return;
      const r = $('#utBoard').getBoundingClientRect(), x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      if (UT.from && UT.draft) { UT.draft.fx = +x.toFixed(4); UT.draft.fy = +y.toFixed(4); UT.from = false; $('#utSide').innerHTML = ''; return utDraw(); }
      if (UT.draft && UT.draft.id) return;
      if (UT.place) { UT.draft = Object.assign(UT.draft || utBlank(0, 0), { x: +x.toFixed(4), y: +y.toFixed(4) }); UT.sel = ''; utDraw(); const t = $('#utSide [data-f="title"]'); if (t) t.focus(); }
    });
    $('#utSide').addEventListener('input', e => utDraftSet(e.target));
    $('#utSide').addEventListener('change', e => utDraftSet(e.target));
    $('#utSide').addEventListener('click', async e => {
      const t = e.target, q = s => t.closest(s);
      if (q('[data-col]')) { const c = q('[data-col]').dataset.col; UT.draft.color = c; const ci = $('#utSide [data-f="color"]'); if (ci) ci.value = c; $$('#utSide .ut-swb').forEach(x => x.classList.toggle('on', x.dataset.col === c)); return utPins(); }
      if (q('#utSave')) return utSave();
      if (q('#utCancel')) { UT.draft = null; UT.place = false; UT.from = false; $('#utSide').innerHTML = ''; return utDraw(); }
      if (q('#utFromBtn')) { UT.from = !UT.from; $('#utFromBtn').classList.toggle('on', UT.from); toast(UT.from ? 'Click the map where the player stands to throw.' : 'Cancelled.'); return utToolbar(); }
      if (q('#utFromClr')) { UT.draft.fx = UT.draft.fy = null; $('#utSide').innerHTML = ''; return utDraw(); }
      if (q('#utCollAdd')) return utAddCollab();
      if (q('[data-cdel]')) { UT.draft.collab = UT.draft.collab.filter(c => c !== q('[data-cdel]').dataset.cdel); $('#utColl').innerHTML = utChips(UT.draft); return; }
      if (q('#utBack')) { UT.sel = ''; return utDraw(); }
      if (q('#utEdit')) { const m = (UT.data[UT.map] || []).find(x => x.id === UT.sel); if (m) { UT.draft = Object.assign(utBlank(0, 0), m, { collab: (m.collab || []).slice() }); UT.place = false; $('#utSide').innerHTML = ''; utDraw(); } return; }
      if (q('#utVis')) { const m = (UT.data[UT.map] || []).find(x => x.id === UT.sel); return utAct('edit', { marker: { vis: m.vis === 'private' ? 'public' : 'private' } }, m.vis === 'private' ? 'Now visible to everyone.' : 'Now private.'); }
      if (q('#utLeave')) return utAct('leave', {}, 'You left this collaboration.');
      if (q('#utDel')) { const m = (UT.data[UT.map] || []).find(x => x.id === UT.sel); if (!confirm('Permanently remove "' + m.title + '" for everyone?')) return; return utAct('del', {}, 'Lineup removed.'); }
      if (q('[data-rate]')) return utAct('rate', { v: +q('[data-rate]').dataset.rate }, 'Thanks for rating.');
      if (q('[data-lk]')) { e.preventDefault(); showTab('tab3', { id: 'account' }); $('#lkIn').value = q('[data-lk]').dataset.lk; return lkSearch(true); }
      const li = q('[data-id]'); if (li && !UT.draft) { UT.sel = li.dataset.id; utDraw(); }
    });
    setInterval(() => { if (tab3Sub === 'utilities' && $('#tab3').classList.contains('active') && !UT.draft && !document.hidden) utLoad(); }, 30000);   // ratings and new lineups of other users appear without a reload
  }

  /* =====================================================================
     12i. CS2 LEADERBOARD: top 100 Premier (Valve's official board) and FACEIT, 20 rows at a time. A row opens the player lookup.
     ===================================================================== */
  const LB_PREM = [['global', 'World'], ['europe', 'Europe'], ['northamerica', 'North America'], ['southamerica', 'South America'], ['asia', 'Asia'], ['australia', 'Australia'], ['africa', 'Africa'], ['china', 'China']];
  const LB_FACE = [['EU', 'Europe'], ['NA', 'North America'], ['SEA', 'South-East Asia'], ['OCE', 'Oceania'], ['SA', 'South America']];
  const LB = { av: load('mway_lbav', {}), type: 'premier', region: { premier: 'global', faceit: 'EU' }, data: {}, shown: 20, busy: false, err: '' };
  const lbKey = () => LB.type + ':' + LB.region[LB.type];
  const lbFlag = cc => /^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0))) : '';
  async function lbLoad(force) {
    const key = lbKey(), have = LB.data[key];
    if (LB.busy || (have && !force && Date.now() - have.at < 300000)) return lbDraw();
    const b = bridgeUrl(); if (!b) { LB.err = 'The leaderboard needs the Worker bridge (Admin > Steam API Provisioning).'; return lbDraw(); }
    LB.busy = true; LB.err = ''; lbDraw();
    try {
      const res = await fetchText(b + '/leaderboard?type=' + LB.type + '&region=' + encodeURIComponent(LB.region[LB.type]), {}, 25000);
      let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
      if (res.status === 404 && !j) throw new Error('the Worker is the old version: deploy the new worker.js');
      if (!j || !j.ok) throw new Error(((j && j.error) || 'HTTP ' + res.status) + (j && j.detail ? ' [' + j.detail + ']' : ''));
      LB.data[key] = { entries: j.entries || [], season: j.season, total: j.total, stale: !!j.stale, at: Date.now() }; LB.shown = 20;
    } catch (e) { LB.err = 'Could not load the leaderboard: ' + ((e && e.message) || 'network error'); }
    finally { LB.busy = false; lbDraw(); }
  }
  function lbDraw() {
    const prem = LB.type === 'premier', sel = $('#lbRegion'), opts2 = prem ? LB_PREM : LB_FACE;
    $$('#lbTabs [data-lb]').forEach(b => { const on = b.dataset.lb === LB.type; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    sel.innerHTML = opts2.map(([k, n]) => `<option value="${k}"${k === LB.region[LB.type] ? ' selected' : ''}>${esc(n)}</option>`).join('');
    const d = LB.data[lbKey()], list = $('#lbList');
    $('#lbMsg').textContent = LB.busy ? 'Loading leaderboard...' : LB.err; $('#lbMsg').style.color = LB.err && !LB.busy ? 'var(--danger)' : '';
    $('#lbInfo').textContent = d ? (prem ? 'Season ' + d.season + ' - official Valve Premier leaderboard' + (d.stale ? ' (saved copy: Valve is not answering right now)' : '') + (d.total ? ' - ' + Number(d.total).toLocaleString('en-US') + ' ranked players' : '') + '. Valve publishes names without SteamIDs, so a row searches that name.' : 'FACEIT CS2 ranking - official FACEIT Data API. A row opens the linked Steam account.') : '';
    if (!d) { list.innerHTML = LB.busy ? Array.from({ length: 8 }, () => '<div class="lb-row sk"></div>').join('') : ''; $('#lbMore').classList.add('hidden'); $('#lbCount').textContent = ''; return; }
    const rows = d.entries.slice(0, LB.shown), avOf = e => (e.pid && LB.av['f' + e.pid]) || (e.steamid && LB.av['s' + e.steamid]) || '';
    list.innerHTML = rows.map((e, i) => { const nm = e.priv || !e.name ? 'Private profile' : e.name, av = avOf(e); return `<button type="button" class="lb-row${e.rank <= 3 ? ' top' + e.rank : ''}${e.priv ? ' priv' : ''}" data-i="${i}" style="--i:${i % 20}"${e.priv ? ' disabled' : ''}>
      <span class="lb-rank">${e.rank}</span><span class="lb-av">${av ? `<img src="${esc(av)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(e.priv ? '?' : [...nm][0] || '?')}</span>
      <span class="lb-name">${prem ? '' : lbFlag(e.country) + ' '}${esc(nm)}</span>
      <span class="lb-val">${prem ? `<b class="lb-rating" style="color:${premCol(e.rating)}">${Number(e.rating).toLocaleString('en-US')}</b>` : `${e.level ? faceitBadge(e.level, 26) : ''}<b>${Number(e.elo).toLocaleString('en-US')}</b><small>ELO</small>`}</span><span class="lb-go" aria-hidden="true">&rsaquo;</span></button>`; }).join('')
      || '<p class="muted">No entries.</p>';
    lbAvatars(rows);
    const more = d.entries.length > LB.shown;
    $('#lbMore').classList.toggle('hidden', !more);
    $('#lbMore').textContent = 'Load ' + Math.min(20, d.entries.length - LB.shown) + ' more';
    $('#lbCount').textContent = 'Showing ' + rows.length + ' of ' + d.entries.length;
  }
  let lbAvBusy = false;
  async function lbAvatars(rows) {   // profile pictures: FACEIT avatars, or Steam avatars when a row carries a SteamID
    const f = rows.filter(e => e.pid && !LB.av['f' + e.pid]).map(e => e.pid).slice(0, 20), st = rows.filter(e => e.steamid && !LB.av['s' + e.steamid]).map(e => e.steamid).slice(0, 20);
    const b = bridgeUrl(); if (!b || lbAvBusy || !(f.length || st.length)) return;
    lbAvBusy = true;
    try {
      const j = JSON.parse((await fetchText(b + '/leaderboard?type=avatars&faceit=' + f.join(',') + '&steam=' + st.join(','), {}, 25000)).text);
      if (j && j.ok) {
        Object.entries(j.faceit || {}).forEach(([id, v]) => { if (v && v.avatar) LB.av['f' + id] = v.avatar; });
        Object.entries(j.steam || {}).forEach(([id, v]) => { if (v) LB.av['s' + id] = v; });
        lsPut('mway_lbav', LB.av);
      }
    } catch { /* pictures are optional */ }
    finally { lbAvBusy = false; }
    $$('#lbList .lb-row').forEach(r => { const e = rows[+r.dataset.i], av = e && ((e.pid && LB.av['f' + e.pid]) || (e.steamid && LB.av['s' + e.steamid])), box = r.querySelector('.lb-av'); if (av && box && !box.querySelector('img')) box.innerHTML = `<img src="${esc(av)}" alt="" loading="lazy" referrerpolicy="no-referrer">`; });
  }
  async function lbOpen(i) {
    const d = LB.data[lbKey()], e = d && d.entries[i]; if (!e) return;
    let target = e.steamid || '';
    if (!target && LB.type === 'faceit' && e.pid) {
      toast('Opening ' + e.name + '...');
      try {
        const r = JSON.parse((await fetchText(bridgeUrl() + '/leaderboard?type=faceit&resolve=' + encodeURIComponent(e.pid), {}, 15000)).text);
        if (!r.ok) throw new Error(r.error || 'not found'); target = r.steamid;
      } catch (err) { return toast('Could not open this player: ' + ((err && err.message) || 'error')); }
    }
    if (!target) target = e.name;
    showTab('tab3', { id: 'account' });
    $('#lkIn').value = target; lkSearch(true);
  }
  function lbEnter() { lbDraw(); lbLoad(); }
  function lbInit() {
    $('#lbTabs').addEventListener('click', e => { const b = e.target.closest('[data-lb]'); if (!b) return; LB.type = b.dataset.lb; LB.shown = 20; LB.err = ''; lbEnter(); });
    $('#lbRegion').addEventListener('change', e => { LB.region[LB.type] = e.target.value; LB.shown = 20; LB.err = ''; lbEnter(); });
    $('#lbMore').addEventListener('click', () => { LB.shown = Math.min(100, LB.shown + 20); lbDraw(); });
    $('#lbList').addEventListener('click', e => { const r = e.target.closest('[data-i]'); if (r) lbOpen(+r.dataset.i); });
  }

    /* =====================================================================
     12j. CHEATER FLAGS: admins flag a Steam account; Account Search then shows a red CHEATER tag and a 0% trust factor.
     Stored on the Worker (/flags, public read, admin write) so every visitor sees it.
     ===================================================================== */
  const FL = { map: load('mway_flags', {}), at: 0 };
  const flOf = id => FL.map && FL.map[String(id || '')];
  async function flLoad(force) {
    const b = bridgeUrl(); if (!b || (!force && Date.now() - FL.at < 300000)) return; FL.at = Date.now();
    try { const j = JSON.parse((await fetchText(b + '/flags', {}, 10000)).text); if (j && j.ok && j.flags) { FL.map = j.flags; lsPut('mway_flags', FL.map); flRender(); } } catch { /* offline: keep the cached copy */ }
  }
  function flSay(t, bad) { const el = $('#flMsg'); el.textContent = t || ''; el.style.color = bad ? 'var(--danger)' : ''; }
  function flRender() {
    const ids = Object.keys(FL.map || {}).sort((a, b) => (FL.map[b].t || 0) - (FL.map[a].t || 0));
    $('#flList').innerHTML = ids.length ? ids.map(id => `<div class="fl-row"><a href="https://steamcommunity.com/profiles/${esc(id)}" target="_blank" rel="noopener noreferrer">${esc(id)}</a><span class="muted">${esc(FL.map[id].note || '')}</span><span class="muted">${esc(new Date(FL.map[id].t || 0).toISOString().slice(0, 10))}</span><button type="button" class="btn btn-small" data-flview="${esc(id)}">Lookup</button><button type="button" class="btn btn-small btn-danger" data-fldel="${esc(id)}">Remove</button></div>`).join('') : '<p class="muted">No flagged accounts.</p>';
  }
  async function flCall(method, id, note) {
    const b = bridgeUrl(), tok = gsToken(); if (!b || !tok) throw new Error('Set the Worker bridge URL and token (or log in with an admin Steam account) first.');
    const res = await fetchText(b + '/flags' + (method === 'DELETE' ? '?id=' + id : ''), { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ id, note }) : undefined }, 12000);
    let j = null; try { j = JSON.parse(res.text); } catch { /* not JSON */ }
    if (res.status === 404 && !j) throw new Error('the Worker is the old version: deploy the new worker.js');
    if (res.status === 401) throw new Error('the Worker rejected the admin token');
    if (!j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + res.status);
    FL.map = j.flags || FL.map; lsPut('mway_flags', FL.map);
  }
  async function flAdd() {
    if (!isAdmin()) return;
    const raw = $('#flIn').value.trim(); if (!raw) return flSay('Paste a Steam profile link first.', true);
    flSay('Resolving profile...');
    try {
      const p = lkParse(raw); if (!p || p.err) throw new Error('could not recognise that link');
      const id = p.id || await lkResolve(p.vanity); if (!id) throw new Error('profile not found');
      if (ADMIN_STEAM_IDS.includes(id)) throw new Error('admin accounts cannot be flagged');
      await flCall('POST', id, $('#flNote').value.trim());
      $('#flIn').value = ''; $('#flNote').value = ''; flSay('Flagged ' + id + '. Everyone now sees the CHEATER tag on this account.'); flRender();
    } catch (e) { flSay('Could not flag: ' + e.message, true); }
  }
  $('#flAdd').addEventListener('click', flAdd);
  $('#flIn').addEventListener('keydown', e => { if (e.key === 'Enter') flAdd(); });
  $('#flList').addEventListener('click', async e => {
    const d = e.target.closest('[data-fldel]'), v = e.target.closest('[data-flview]');
    if (v) { showTab('tab3', { id: 'account' }); $('#lkIn').value = v.dataset.flview; return lkSearch(true); }
    if (!d || !isAdmin()) return;
    try { await flCall('DELETE', d.dataset.fldel); flRender(); flSay('Flag removed.'); } catch (err) { flSay('Could not remove: ' + err.message, true); }
  });

  /* =====================================================================
     13. INIT
     ===================================================================== */
  GS.pending = !!bridgeUrl();
  gsInit();
  buildKeypad();
  applyGate(false);
  applyAuth();
  routeFromHash();
  startAtmosphere();
  introDecode();
  xhInit();
  utInit();
  flRender(); flLoad(); adminCheck(true);
  lbInit();
  lkInit();
  cvInit();
  diagInit();
  slInit();
  if (bridgeUrl()) { probeBridge().catch(() => {}); gsPull().then(() => { routeFromHash(); if (isAdmin()) { keysPush(false); slLoad(true); } }); }
  handleSteamReturn();
})();
