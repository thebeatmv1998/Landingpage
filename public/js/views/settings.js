import { icon } from '../icons.js';
import { esc, toast, applyTheme, greeting, debounce, modal, h } from '../ui.js';
import { state, savePrefs, effectiveAppearance, defaults } from '../state.js';
import { API } from '../api.js';
import { appearanceEditor } from './appearance.js';
import { renderAdmin, ADMIN_TAB_IDS } from './admin.js';

export async function renderSettings(root, { navigate, tab: initialTab = 'profile' } = {}) {
  document.title = 'Settings — HomeDeck';
  const user = state.user;
  const USER_NAV = [
    { id: 'profile', icon: 'users', label: 'Profile' },
    { id: 'security', icon: 'lock', label: 'Password & 2FA' },
    { id: 'sessions', icon: 'globe', label: 'Sessions' },
    { id: 'mobile', icon: 'phone', label: 'Mobile app' },
    { id: 'look', icon: 'palette', label: 'My appearance' },
  ];
  const ADMIN_NAV = user.role === 'admin' ? [
    { id: 'services', icon: 'plug', label: 'Services' },
    { id: 'users', icon: 'users', label: 'Users' },
    { id: 'groups', icon: 'shield', label: 'Groups' },
    { id: 'appearance', icon: 'palette', label: 'Global appearance' },
    { id: 'widgets', icon: 'chart', label: 'Widgets' },
    { id: 'sso', icon: 'lock', label: 'Single sign-on' },
    { id: 'general', icon: 'settings', label: 'General' },
    { id: 'audit', icon: 'shield', label: 'Audit log' },
  ] : [];

  const hash = location.hash || '';
  const queryIndex = hash.indexOf('?');
  const queryTab = queryIndex >= 0 ? new URLSearchParams(hash.slice(queryIndex + 1)).get('tab') : '';
  const requested = queryTab || initialTab;
  let tab = [...USER_NAV, ...ADMIN_NAV].some((t) => t.id === requested) ? requested : 'profile';
  const navBtn = (t) => `<button class="nav-item${t.id === tab ? ' active' : ''}" data-tab="${t.id}">${icon(t.icon)} ${t.label}</button>`;

  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/"><span class="brand-logo"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 17V9.5L12 6l5 3.5V17h-3.4v-4h-3.2v4z"/></svg></span><span>${esc(state.settings.general?.title || 'HomeDeck')}</span></a>
      <div class="topbar-spacer"></div>
      <a class="icon-btn" href="#/" title="Dashboard">${icon('menu')}</a>
      <button class="icon-btn" id="btn-logout" title="Sign out">${icon('logout')}</button>
    </header>
    <div class="page">
      <nav class="page-nav">
        ${USER_NAV.map(navBtn).join('')}
        ${ADMIN_NAV.length ? `<div class="nav-group-label">Administration</div>${ADMIN_NAV.map(navBtn).join('')}` : ''}
      </nav>
      <div class="page-main" id="settings-main"></div>
    </div>
  `;

  const main = root.querySelector('#settings-main');
  let mobileTimer = null;
  const clearMobileTimer = () => { if (mobileTimer) { clearInterval(mobileTimer); mobileTimer = null; } };

  function draw() {
    clearMobileTimer();
    if (ADMIN_TAB_IDS.includes(tab)) {
      const requestedTab = tab;
      renderAdmin(main, { navigate, tab, embedded: true, isActive: () => tab === requestedTab });
      return;
    }
    if (tab === 'profile') drawProfile();
    else if (tab === 'security') drawSecurity();
    else if (tab === 'sessions') drawSessions();
    else if (tab === 'mobile') drawMobile();
    else drawLook();
  }

  root.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      tab = btn.dataset.tab;
      history.replaceState(null, '', `#/settings${tab === 'profile' ? '' : `?tab=${encodeURIComponent(tab)}`}`);
      draw();
    });
  });

  function drawProfile() {
    main.innerHTML = `
      <div class="panel">
        <h2>Profile</h2>
        <p class="panel-sub">${greeting()}, ${esc(user.displayName)}. Signed in as <b>${esc(user.username)}</b> (${esc(user.role)}${user.groupName ? ', group ' + esc(user.groupName) : ''}).</p>
        <div class="panel-grid">
          <div>
            <label class="field"><span>Display name</span>
              <input class="input" id="p-display" value="${esc(user.displayName)}" maxlength="60">
            </label>
            <button class="btn btn-primary" id="p-save">${icon('check')} Save</button>
          </div>
        </div>
        <p class="hint" style="margin-top:16px">HomeDeck v${esc(state.meta?.version || '')}</p>
      </div>`;
    main.querySelector('#p-save').addEventListener('click', async () => {
      try {
        const res = await API.saveProfile({ displayName: main.querySelector('#p-display').value });
        state.user = { ...state.user, ...res.user };
        toast('Profile saved', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  function drawSecurity() {
    main.innerHTML = `
      <div class="panel">
        <h2>Change password</h2>
        <p class="panel-sub">${user.hasPassword ? '' : 'You signed in via SSO — set a password to enable local login too.'}</p>
        <div class="panel-grid">
          <div>
            ${user.hasPassword ? `<label class="field"><span>Current password</span><input class="input" id="s-cur" type="password" autocomplete="current-password"></label>` : ''}
            <label class="field"><span>New password</span><input class="input" id="s-new" type="password" autocomplete="new-password"></label>
            <label class="field"><span>Repeat new password</span><input class="input" id="s-new2" type="password" autocomplete="new-password"></label>
            <button class="btn btn-primary" id="s-save">${icon('check')} Update password</button>
          </div>
        </div>
      </div>
      <div class="panel">
        <h2>Two-factor authentication (TOTP)</h2>
        <p class="panel-sub" id="t-status"></p>
        <div id="t-body"></div>
      </div>
      <div class="panel">
        <h2>Recovery codes</h2>
        <p class="panel-sub" id="rec-status"></p>
        <div id="rec-body"></div>
      </div>`;
    main.querySelector('#s-save').addEventListener('click', async () => {
      const next = main.querySelector('#s-new').value;
      if (next !== main.querySelector('#s-new2').value) return toast('New passwords do not match', 'error');
      try {
        await API.changePassword({ current: main.querySelector('#s-cur')?.value || '', next });
        toast('Password updated. Other sessions were signed out.', 'success');
        main.querySelector('#s-new').value = '';
        main.querySelector('#s-new2').value = '';
        if (main.querySelector('#s-cur')) main.querySelector('#s-cur').value = '';
      } catch (err) { toast(err.message, 'error'); }
    });

    drawTotp();
    drawRecovery();
  }

  function drawTotp() {
    const status = main.querySelector('#t-status');
    const body = main.querySelector('#t-body');
    if (user.totpEnabled) {
      status.textContent = 'Two-factor authentication is ENABLED on your account.';
      body.innerHTML = `
        <div class="field-row" style="max-width:420px">
          <label class="field"><span>Password${user.hasPassword ? '' : ' (not required for SSO-only accounts)'} </span><input class="input" id="t-pass" type="password" autocomplete="current-password"></label>
          <label class="field"><span>Current code</span><input class="input otp-input" id="t-code" maxlength="6" inputmode="numeric" style="letter-spacing:.3em;font-size:15px"></label>
        </div>
        <button class="btn btn-danger" id="t-disable">${icon('x')} Disable 2FA</button>`;
      body.querySelector('#t-disable').addEventListener('click', async () => {
        try {
          await API.totpDisable({ password: body.querySelector('#t-pass').value, code: body.querySelector('#t-code').value.trim() });
          user.totpEnabled = false;
          toast('2FA disabled', 'success');
          drawTotp();
        } catch (err) { toast(err.message, 'error'); }
      });
    } else {
      status.textContent = 'Add a second factor using any TOTP authenticator app (Aegis, Google Authenticator, 1Password…).';
      body.innerHTML = `
        ${user.hasPassword ? `<label class="field" style="max-width:300px"><span>Confirm your password to begin</span><input class="input" id="t-pass" type="password" autocomplete="current-password"></label>` : ''}
        <button class="btn btn-primary" id="t-start">${icon('key')} Set up 2FA</button>
        <div id="t-setup"></div>`;
      body.querySelector('#t-start').addEventListener('click', async () => {
        try {
          const setup = await API.totpSetup({ password: body.querySelector('#t-pass')?.value || '' });
          const box = body.querySelector('#t-setup');
          box.innerHTML = `
            <div class="qr-box"><img src="${setup.qr}" alt="TOTP QR code" width="200" height="200"></div>
            <p class="hint" style="text-align:center">Or enter this secret manually:</p>
            <div class="secret-code">${esc(setup.secret)}</div>
            <label class="field" style="max-width:300px;margin:0 auto"><span>Enter the 6-digit code to confirm</span>
              <input class="input otp-input" id="t-code2" maxlength="6" inputmode="numeric">
            </label>
            <button class="btn btn-primary" id="t-enable" style="margin-top:10px">${icon('check')} Enable 2FA</button>`;
          box.querySelector('#t-enable').addEventListener('click', async () => {
            try {
              const res = await API.totpEnable({ code: box.querySelector('#t-code2').value.trim() });
              user.totpEnabled = true;
              if (res?.recoveryCodes?.length) showRecoveryCodes(res.recoveryCodes);
              toast('2FA enabled — you will be asked for a code at next login', 'success');
              drawTotp();
              drawRecovery();
            } catch (err) { toast(err.message, 'error'); }
          });
        } catch (err) { toast(err.message, 'error'); }
      });
    }
  }

  async function drawRecovery() {
    const status = main.querySelector('#rec-status');
    const body = main.querySelector('#rec-body');
    if (!status || !body) return;
    if (!user.totpEnabled) {
      status.textContent = 'Enable two-factor authentication first — recovery codes are your fallback if you lose the authenticator.';
      body.innerHTML = '';
      return;
    }
    let remaining = 0;
    try { remaining = (await API.recoveryStatus()).remaining; } catch { /* ignore */ }
    status.textContent = `${remaining} unused code${remaining === 1 ? '' : 's'} left. Each code works once.`;
    body.innerHTML = `<button class="btn btn-primary" id="rec-gen">${icon('refresh')} Generate new codes</button>`;
    body.querySelector('#rec-gen').addEventListener('click', openRecoveryRegen);
  }

  function openRecoveryRegen() {
    const body = h(`<div>
      ${user.hasPassword ? '<label class="field"><span>Confirm your password</span><input class="input" id="rec-pass" type="password" autocomplete="current-password"></label>' : ''}
      <p class="hint">Existing recovery codes will stop working.</p>
    </div>`);
    const ok = h(`<button class="btn btn-primary">${icon('refresh')} Generate</button>`);
    const m = modal({ title: 'New recovery codes', body, footer: [ok] });
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try {
        const res = await API.regenerateRecovery({ password: body.querySelector('#rec-pass')?.value || '' });
        m.close();
        showRecoveryCodes(res.codes);
        drawRecovery();
      } catch (err) { toast(err.message, 'error'); ok.disabled = false; }
    });
  }

  function showRecoveryCodes(codes) {
    const body = h(`<div>
      <p class="panel-sub" style="margin-bottom:10px">Store these somewhere safe — they are shown only once.</p>
      <div class="recovery-codes">${codes.map((c) => `<code>${esc(c)}</code>`).join('')}</div>
      <button class="btn btn-block" id="rec-copy">${icon('copy')} Copy all</button>
    </div>`);
    modal({ title: 'Recovery codes', body });
    body.querySelector('#rec-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(codes.join('\n')); toast('Recovery codes copied', 'success'); }
      catch { toast('Could not copy — select the codes manually', 'error'); }
    });
  }

  async function drawSessions() {
    main.innerHTML = `<div class="panel">
      <h2>Sessions</h2>
      <p class="panel-sub">Devices signed in to your account. Revoke anything you don't recognise.</p>
      <div id="sess-list">Loading…</div>
      <div style="margin-top:14px;display:flex;justify-content:flex-end">
        <button class="btn btn-danger" id="sess-others">${icon('logout')} Sign out other sessions</button>
      </div>
    </div>`;
    const list = main.querySelector('#sess-list');
    const load = async () => {
      let sessions = [];
      try { sessions = (await API.sessions()).sessions; } catch (err) { toast(err.message, 'error'); }
      if (!sessions.length) { list.innerHTML = '<div class="empty">No sessions</div>'; return; }
      list.innerHTML = `<table class="table"><thead><tr><th>Device</th><th>Signed in</th><th>Expires</th><th></th></tr></thead><tbody>
        ${sessions.map((s) => `<tr>
          <td>${s.current ? '<b>This device</b><br>' : ''}<span style="color:var(--muted);font-size:12px">${esc(s.userAgent || 'Unknown client')}</span></td>
          <td style="white-space:nowrap">${new Date(s.createdAt).toLocaleString()}</td>
          <td style="white-space:nowrap">${new Date(s.expiresAt).toLocaleString()}</td>
          <td style="text-align:right">${s.current ? '<span class="row-sub">current</span>' : `<button class="btn btn-sm btn-danger" data-revoke="${esc(s.id)}">Revoke</button>`}</td>
        </tr>`).join('')}</tbody></table>`;
      list.querySelectorAll('[data-revoke]').forEach((btn) => btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await API.revokeSession(btn.dataset.revoke); toast('Session revoked', 'success'); await load(); }
        catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      }));
    };
    main.querySelector('#sess-others').addEventListener('click', async () => {
      try { await API.revokeOtherSessions(); toast('Other sessions signed out', 'success'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
    await load();
  }

  function drawMobile() {
    const defaultUrl = state.meta?.publicUrl || location.origin;
    const apk = state.meta?.androidApk || {};
    const apkAvailable = apk.available === true;
    const apkVersion = apk.version || '1.0.0';
    main.innerHTML = `
      <div class="panel">
        <h2>HomeDeck for Android</h2>
        <p class="panel-sub">Pair your phone by scanning a one-time QR code. The app receives its own revocable token — your password is never stored on the phone.</p>
        <div class="panel-grid" style="align-items:start">
          <div>
            <label class="field"><span>Server address for the app</span>
              <input class="input" id="pair-url" value="${esc(defaultUrl)}" placeholder="https://deck.example.com">
              <div class="hint">Use the address your phone can reach. Outside your LAN this should be your public HTTPS domain. A path prefix is fine, a trailing slash is not needed.</div>
            </label>
            <button class="btn btn-primary" id="pair-start">${icon('phone')} Show pairing QR</button>
            <p class="hint" style="margin-top:12px">The QR contains a one-time code valid for <b>5 minutes</b>. Anyone who scans it while it is valid gets access to your account — keep it private. Generating a new code invalidates the previous one.</p>
          </div>
          <div id="pair-qr" class="pair-qr"><div class="pair-placeholder">${icon('phone')}<span>No QR generated yet</span></div></div>
        </div>
      </div>
      <div class="panel">
        <h2>Paired devices</h2>
        <p class="panel-sub">Phones with an app token. Revoking signs that app out immediately.</p>
        <div id="device-list">Loading…</div>
      </div>
      <div class="panel">
        <h2>Install the app</h2>
        <p class="panel-sub">Install the Android app or build it from source in the <code>android/</code> folder.</p>
        ${apkAvailable ? `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:14px 0 10px">
          <a class="btn btn-primary" href="/download/homedeck.apk" download="HomeDeck-${esc(apkVersion)}.apk">${icon('download')} Download APK · 3.9 MB</a>
          <span class="hint">v${esc(apkVersion)} · Android 8.0+ · debug-signed for sideloading</span>
        </div>` : `<p class="hint" style="margin:12px 0">The APK is included in the release tarball / GitHub Release. For a source build, place it in <code>public/download/homedeck.apk</code> or build it from <code>android/</code>.</p>`}
        <p class="hint">Enable “Install unknown apps” for your browser when prompted. The app is also buildable with Android Studio or <code>./gradlew assembleDebug</code> (JDK 17+; a GitHub Actions workflow is included at <code>.github/workflows/android.yml</code>). For public distribution, sign a release build with your own keystore.</p>
      </div>`;

    const startBtn = main.querySelector('#pair-start');
    const qrBox = main.querySelector('#pair-qr');
    let payload = '';
    let expiresAt = 0;

    const countdown = () => {
      if (!qrBox.isConnected) {
        clearMobileTimer();
        return;
      }
      const left = Math.max(0, expiresAt - Date.now());
      const el = qrBox.querySelector('#pair-left');
      if (el) {
        const secs = Math.ceil(left / 1000);
        el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      }
      if (left <= 0) {
        clearMobileTimer();
        qrBox.classList.add('expired');
      }
    };

    const showPairing = (res) => {
      payload = res.payload;
      expiresAt = res.expiresAt;
      qrBox.classList.remove('expired');
      qrBox.innerHTML = `
        <div class="qr-box"><img src="${res.qr}" alt="Pairing QR code" width="236" height="236"></div>
        <div class="pair-meta">
          <span class="chip"><span class="chip-l">Expires in</span><span class="chip-v" id="pair-left">5:00</span></span>
        </div>
        <div class="pair-actions">
          <button class="btn btn-sm" id="pair-copy">${icon('copy')} Copy pairing link</button>
        </div>
        <div class="hint" style="text-align:center;word-break:break-all">${esc(res.serverUrl)}</div>`;
      qrBox.querySelector('#pair-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(payload); toast('Pairing link copied', 'success'); }
        catch { toast('Could not copy', 'error'); }
      });
      clearMobileTimer();
      countdown();
      mobileTimer = setInterval(countdown, 1000);
    };

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        const res = await API.pairingStart({ serverUrl: main.querySelector('#pair-url').value.trim() });
        showPairing(res);
        toast('Pairing QR created — valid for 5 minutes', 'success');
      } catch (err) { toast(err.message, 'error'); }
      finally { startBtn.disabled = false; }
    });

    const list = main.querySelector('#device-list');
    const loadDevices = async () => {
      try {
        const { devices } = await API.pairingDevices();
        if (!devices.length) { list.innerHTML = '<div class="empty">No paired devices yet.</div>'; return; }
        list.innerHTML = `<table class="table"><thead><tr><th>Device</th><th>Last used</th><th>Paired</th><th></th></tr></thead><tbody>
          ${devices.map((d) => `<tr>
            <td><b>${esc(d.name)}</b>${d.lastIp ? `<br><span class="row-sub">${esc(d.lastIp)}</span>` : ''}</td>
            <td style="white-space:nowrap">${d.lastUsedAt ? new Date(d.lastUsedAt).toLocaleString() : 'never'}</td>
            <td style="white-space:nowrap">${new Date(d.createdAt).toLocaleString()}</td>
            <td style="text-align:right"><button class="btn btn-sm btn-danger" data-device="${d.id}">Revoke</button></td>
          </tr>`).join('')}</tbody></table>`;
        list.querySelectorAll('[data-device]').forEach((btn) => btn.addEventListener('click', async () => {
          btn.disabled = true;
          try { await API.revokeDevice(btn.dataset.device); toast('Device revoked', 'success'); await loadDevices(); }
          catch (err) { toast(err.message, 'error'); btn.disabled = false; }
        }));
      } catch (err) {
        list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      }
    };
    loadDevices();
  }

  function drawLook() {
    const mode = user.prefs?.appearanceMode || 'global';
    main.innerHTML = `
      <div class="panel">
        <h2>My appearance</h2>
        <p class="panel-sub">Override the global theme with your own look. Changes preview live.</p>
        <div style="display:flex;gap:8px;margin-bottom:14px">
          <button class="btn ${mode === 'global' ? 'btn-primary' : ''}" id="m-global">Use global appearance</button>
          <button class="btn ${mode === 'custom' ? 'btn-primary' : ''}" id="m-custom">Customize</button>
        </div>
        <div id="look-editor" style="${mode === 'custom' ? '' : 'opacity:.5;pointer-events:none'}"></div>
      </div>`;

    const editor = main.querySelector('#look-editor');
    const getWorking = () => ({ ...defaults(), ...(state.settings.appearance || {}), ...(user.prefs?.appearance || {}) });
    const persistOverride = debounce(() => savePrefs({ appearance: user.prefs?.appearance || {} }).catch(() => {}), 400);
    const saveLocal = (patch) => {
      user.prefs = { ...(user.prefs || {}), appearance: { ...(user.prefs?.appearance || {}), ...patch } };
      persistOverride();
    };

    main.querySelector('#m-global').addEventListener('click', async () => {
      await savePrefs({ appearanceMode: 'global' });
      applyTheme(effectiveAppearance());
      renderSettings(root, { navigate, tab: 'look' });
    });
    main.querySelector('#m-custom').addEventListener('click', async () => {
      await savePrefs({ appearanceMode: 'custom', appearance: user.prefs?.appearance || { accent: effectiveAppearance().accent } });
      applyTheme(effectiveAppearance());
      renderSettings(root, { navigate, tab: 'look' });
    });

    if (mode === 'custom') {
      appearanceEditor(editor, {
        get: getWorking,
        save: async (patch) => { saveLocal(patch); applyTheme(effectiveAppearance()); },
      });
    }
  }

  root.querySelector('#btn-logout').addEventListener('click', async () => {
    try { await API.logout(); } catch { /* ignore */ }
    state.user = null;
    location.hash = '#/login';
    location.reload();
  });

  draw();
}
