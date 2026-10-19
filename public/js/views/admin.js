import { icon } from '../icons.js';
import { esc, h, toast, modal, confirmModal, wireIcons } from '../ui.js';
import { state } from '../state.js';
import { API } from '../api.js';
import { appearanceEditor } from './appearance.js';
import { WIDGETS } from './widgets.js';

let services = [];
let REGISTRY = [];

async function fetchRegistry() {
  if (REGISTRY.length) return REGISTRY;
  try { REGISTRY = await fetch('/api/registry').then((r) => r.json()); } catch { REGISTRY = []; }
  return REGISTRY;
}
function regOf(type) { return REGISTRY.find((r) => r.type === type); }
function labelOfType(type) { return regOf(type)?.label || type; }
function colorOfType(type) { return regOf(type)?.color || 'var(--accent)'; }

export const ADMIN_TAB_IDS = ['services', 'users', 'groups', 'appearance', 'widgets', 'sso', 'general', 'audit'];

export async function renderAdmin(root, { navigate, tab: initialTab = 'services', embedded = false, isActive = () => true } = {}) {
  if (state.user.role !== 'admin') { navigate('#/'); return; }

  let main;
  let tab = ADMIN_TAB_IDS.includes(initialTab) ? initialTab : 'services';

  if (embedded) {
    main = root;
    main.innerHTML = '<div class="empty">Loading…</div>';
  } else {
    document.title = 'Admin — HomeDeck';
    root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/"><span class="brand-logo"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 17V9.5L12 6l5 3.5V17h-3.4v-4h-3.2v4z"/></svg></span><span>${esc(state.settings.general?.title || 'HomeDeck')}</span></a>
      <div class="topbar-spacer"></div>
      <a class="icon-btn" href="#/" title="Dashboard">${icon('menu')}</a>
      <a class="icon-btn" href="#/settings" title="Settings">${icon('settings')}</a>
      <button class="icon-btn" id="btn-logout" title="Sign out">${icon('logout')}</button>
    </header>
    <div class="page">
      <nav class="page-nav">
        <button class="nav-item active" data-tab="services">${icon('plug')} Services</button>
        <button class="nav-item" data-tab="users">${icon('users')} Users</button>
        <button class="nav-item" data-tab="groups">${icon('shield')} Groups</button>
        <button class="nav-item" data-tab="appearance">${icon('palette')} Appearance</button>
        <button class="nav-item" data-tab="widgets">${icon('chart')} Widgets</button>
        <button class="nav-item" data-tab="sso">${icon('lock')} Single Sign-On</button>
        <button class="nav-item" data-tab="general">${icon('settings')} General</button>
        <button class="nav-item" data-tab="audit">${icon('shield')} Audit log</button>
      </nav>
      <div class="page-main" id="admin-main"></div>
    </div>`;

    main = root.querySelector('#admin-main');
    root.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
      btn.addEventListener('click', () => {
        root.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        tab = btn.dataset.tab;
        draw();
      });
    });
  }
  await fetchRegistry();
  if (!isActive()) return;

  function draw() {
    ({ services: drawServices, users: drawUsers, groups: drawGroups, appearance: drawAppearance, widgets: drawWidgets, sso: drawSso, general: drawGeneral, audit: drawAudit })[tab]();
  }

  // =================================================================
  // SERVICES
  // =================================================================
  async function drawServices() {
    main.innerHTML = `<div class="panel"><h2>Services</h2><p class="panel-sub">Connect to your self-hosted apps. Credentials are stored encrypted and never sent to the browser.</p>
      <div style="display:flex;gap:9px;margin-bottom:14px"><button class="btn btn-primary" id="add-svc">${icon('plus')} Add service</button></div>
      <div id="svc-list">Loading…</div></div>`;
    main.querySelector('#add-svc').addEventListener('click', openGallery);
    await loadServices();
  }

  async function loadServices() {
    try {
      services = (await API.services()).services;
    } catch (err) { toast(err.message, 'error'); services = []; }
    const list = main.querySelector('#svc-list');
    if (!list) return;
    if (!services.length) {
      list.innerHTML = `<div class="empty">No services yet — click “Add service”.</div>`;
      return;
    }
    list.innerHTML = `<table class="table"><thead><tr>
        <th style="width:26px"></th><th>Service</th><th>Type</th><th>Category</th><th>Access</th><th style="width:44px">On</th><th style="width:170px"></th>
      </tr></thead><tbody>
      ${services.map((s) => `<tr draggable="true" data-id="${s.id}">
        <td><span class="row-drag">${icon('drag')}</span></td>
        <td><b>${esc(s.name)}</b><br><span style="color:var(--faint);font-size:12px">${esc(s.url)}${s.fallback_url ? `<br>${icon('globe')} ${esc(s.fallback_url)}` : ''}</span></td>
        <td><span class="type-badge"><i style="--dot:${colorOfType(s.type)}"></i>${esc(labelOfType(s.type))}</span></td>
        <td>${esc(s.category)}</td>
        <td>${s.allowed_groups.length ? esc(s.allowed_groups.join(', ')) : '<span style="color:var(--faint)">everyone</span>'}</td>
        <td><label class="switch"><input type="checkbox" data-toggle="${s.id}" ${s.enabled ? 'checked' : ''}><span class="knob"></span></label></td>
        <td style="text-align:right;white-space:nowrap">
          <button class="icon-btn" data-test="${s.id}" title="Test connection">${icon('zap')}</button>
          <button class="icon-btn" data-edit="${s.id}" title="Edit">${icon('edit')}</button>
          <button class="icon-btn" data-del="${s.id}" title="Delete">${icon('trash')}</button>
        </td></tr>`).join('')}</tbody></table>`;
    wireIcons(list);

    list.querySelectorAll('[data-toggle]').forEach((sw) => sw.addEventListener('change', async (e) => {
      const svc = services.find((x) => x.id === Number(sw.dataset.toggle));
      try { await API.updateService(svc.id, { enabled: e.target.checked }); toast(`${svc.name} ${e.target.checked ? 'enabled' : 'disabled'}`, 'success'); }
      catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
    }));
    list.querySelectorAll('[data-test]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.innerHTML = icon('refresh'); btn.style.color = 'var(--accent)';
      try {
        const r = await API.testService(Number(btn.dataset.test));
        toast(r.ok ? `${services.find((s) => s.id === Number(btn.dataset.test)).name}: ${r.message}` : `Test failed: ${r.message}`, r.ok ? 'success' : 'error');
      } catch (err) { toast(err.message, 'error'); }
      btn.innerHTML = icon('zap'); btn.style.color = '';
    }));
    list.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openServiceEditor(services.find((s) => s.id === Number(btn.dataset.edit)))));
    list.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
      const svc = services.find((s) => s.id === Number(btn.dataset.del));
      if (!(await confirmModal(`Delete service "${svc.name}"? Its stats will disappear from the dashboard.`, { danger: true, okLabel: 'Delete' }))) return;
      try { await API.deleteService(svc.id); toast('Service deleted', 'success'); await loadServices(); }
      catch (err) { toast(err.message, 'error'); }
    }));

    // drag reorder
    let dragging = null;
    list.querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('dragstart', () => { dragging = tr; });
      tr.addEventListener('dragend', async () => {
        dragging = null;
        const ids = [...list.querySelectorAll('tbody tr')].map((r) => Number(r.dataset.id));
        try { await API.reorderServices(ids); } catch (err) { toast(err.message, 'error'); }
      });
      tr.addEventListener('dragover', (e) => { e.preventDefault(); if (dragging && dragging !== tr) tr.classList.add('drag-over'); });
      tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
      tr.addEventListener('drop', (e) => {
        e.preventDefault(); tr.classList.remove('drag-over');
        if (dragging && dragging !== tr) tr.parentElement.insertBefore(dragging, tr);
      });
    });
  }

  function openGallery() {
    const body = h(`<div class="gallery">${REGISTRY.map((r) => `
      <div class="gallery-item" data-type="${esc(r.type)}">
        <span class="svc-ic${r.icon ? ' has-img' : ''}" style="--tile:${esc(r.color)}">
          <span class="svc-glyph-wrap">${icon(r.glyph)}</span>
          ${r.icon ? `<img class="svc-img" src="${esc(r.icon)}" alt="" loading="lazy">` : ''}
        </span>
        <span><span class="g-name">${esc(r.label)}</span><br><span class="g-blurb">${esc(r.blurb)}</span></span>
      </div>`).join('')}</div>`);
    wireIcons(body);
    const m = modal({ title: 'Add a service', body, wide: true });
    body.querySelectorAll('.gallery-item').forEach((item) => {
      item.addEventListener('click', () => { m.close(); openServiceEditor(null, item.dataset.type); });
    });
  }

  function openServiceEditor(svc, presetType) {
    const isNew = !svc;
    const reg = regOf(svc?.type || presetType) || {};
    const catOptions = [...new Set([reg.category, 'Automation', 'Media', 'Downloads', 'Reading', 'Cloud & Files', 'Network', 'Photos', 'Security', 'System', 'Other', ...services.map((s) => s.category)])].filter(Boolean);

    const extraFields = (reg.fields || []).filter((f) => f.key.startsWith('extra.'))
      .map((f) => `<label class="field"><span>${esc(f.label)}</span><input class="input" data-extra="${esc(f.key)}" value="${esc((svc?.extra || {})[f.key.slice(6)] ?? '')}" placeholder="${esc(f.placeholder || '')}">${f.help ? `<div class="hint">${esc(f.help)}</div>` : ''}</label>`)
      .join('');
    const needApiKey = (reg.fields || []).some((f) => f.key === 'api_key');
    const needUser = (reg.fields || []).some((f) => f.key === 'username');
    const needPass = (reg.fields || []).some((f) => f.key === 'password');

    const body = h(`<div>
      <label class="field"><span>Name</span><input class="input" id="e-name" value="${esc(svc?.name || reg.label || '')}"></label>
      <label class="field"><span>URL</span><input class="input" id="e-url" value="${esc(svc?.url || '')}" placeholder="http://192.168.1.10:8989"></label>
      <label class="field"><span>Public / fallback URL (optional)</span>
        <input class="input" id="e-fallback" value="${esc(svc?.fallback_url || '')}" placeholder="https://sonarr.example.com">
        <div class="hint">When you open HomeDeck outside your LAN, the browser checks the local URL and automatically links to this public URL when it is unreachable.</div>
      </label>
      <label class="field" style="display:flex;align-items:center;gap:10px">
        <span class="switch"><input type="checkbox" id="e-autoswitch" ${svc?.auto_switch !== false ? 'checked' : ''}><span class="knob"></span></span>
        <span>Switch automatically when the local URL is unreachable</span>
      </label>
      ${needApiKey ? `<label class="field"><span>API key ${svc?.has_api_key ? `<span style="color:var(--faint)">(saved: ${esc(svc.api_key_mask)})</span>` : ''}</span>
        <input class="input" id="e-apikey" type="password" placeholder="${svc?.has_api_key ? 'unchanged' : ''}" autocomplete="off">${(reg.fields || []).find((f) => f.key === 'api_key')?.help ? `<div class="hint">${esc((reg.fields || []).find((f) => f.key === 'api_key').help)}</div>` : ''}</label>` : ''}
      ${needUser ? `<label class="field"><span>${esc((reg.fields || []).find((f) => f.key === 'username')?.label || 'Username')}</span><input class="input" id="e-user" value="${esc(svc?.username || '')}"></label>` : ''}
      ${needPass ? `<label class="field"><span>${esc((reg.fields || []).find((f) => f.key === 'password')?.label || 'Password')} ${svc?.has_password ? `<span style="color:var(--faint)">(saved: ${esc(svc.password_mask)})</span>` : ''}</span>
        <input class="input" id="e-pass" type="password" placeholder="${svc?.has_password ? 'unchanged' : ''}" autocomplete="off"></label>` : ''}
      ${extraFields}
      <div class="field-row">
        <label class="field"><span>Category</span><input class="input" id="e-cat" list="cat-list" value="${esc(svc?.category || reg.category || 'Other')}">
          <datalist id="cat-list">${catOptions.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        </label>
        <label class="field"><span>Poll interval (ms, optional)</span><input class="input" id="e-poll" type="number" min="2000" step="500" value="${svc?.extra?.pollMs ?? ''}" placeholder="${esc(String(reg.pollMs || 30000))}"></label>
      </div>
      <label class="field"><span>Icon URL (optional)</span><input class="input" id="e-icon" value="${esc(svc?.icon_url || '')}" placeholder="https://…/icon.png"></label>
      <label class="field"><span>Restrict to groups (comma separated, empty = everyone)</span><input class="input" id="e-groups" value="${esc((svc?.allowed_groups || []).join(', '))}" placeholder="family, admins"></label>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <button class="btn" id="e-test">${icon('zap')} Test connection</button>
        <span id="e-test-out"></span>
      </div>
    </div>`);

    const saveBtn = h(`<button class="btn btn-primary">${icon('check')} ${isNew ? 'Add service' : 'Save changes'}</button>`);
    const m = modal({ title: isNew ? `Add ${esc(reg.label || 'service')}` : `Edit ${esc(svc.name)}`, body, footer: [saveBtn], wide: true });

    const collect = () => ({
      type: svc?.type || presetType,
      name: body.querySelector('#e-name').value.trim(),
      url: body.querySelector('#e-url').value.trim(),
      fallback_url: body.querySelector('#e-fallback').value.trim(),
      auto_switch: body.querySelector('#e-autoswitch').checked,
      api_key: body.querySelector('#e-apikey') ? body.querySelector('#e-apikey').value : undefined,
      username: body.querySelector('#e-user') ? body.querySelector('#e-user').value.trim() : undefined,
      password: body.querySelector('#e-pass') ? body.querySelector('#e-pass').value : undefined,
      category: body.querySelector('#e-cat').value.trim(),
      icon_url: body.querySelector('#e-icon').value.trim(),
      allowed_groups: body.querySelector('#e-groups').value.split(',').map((g) => g.trim()).filter(Boolean),
      poll_interval: body.querySelector('#e-poll').value ? Number(body.querySelector('#e-poll').value) : null,
      extra: Object.fromEntries([...body.querySelectorAll('[data-extra]')].map((inp) => [inp.dataset.extra.slice(6), inp.value.trim()]).filter(([, v]) => v !== '')),
    });

    body.querySelector('#e-test').addEventListener('click', async () => {
      const out = body.querySelector('#e-test-out');
      out.innerHTML = '<span class="hint">Testing…</span>';
      try {
        const payload = collect();
        const r = isNew ? await API.testService(0, payload).catch((e) => ({ ok: false, message: e.message }))
          : await API.testService(svc.id, payload);
        out.innerHTML = `<span class="test-result ${r.ok ? 'test-ok' : 'test-fail'}">${r.ok ? icon('check') : icon('x')} ${esc(r.message)}</span>`;
      } catch (err) {
        out.innerHTML = `<span class="test-result test-fail">${icon('x')} ${esc(err.message)}</span>`;
      }
    });

    saveBtn.addEventListener('click', async () => {
      const payload = collect();
      if (!payload.name) return toast('Name is required', 'error');
      try {
        if (isNew) await API.createService(payload);
        else await API.updateService(svc.id, payload);
        toast(isNew ? 'Service added' : 'Service saved', 'success');
        m.close();
        await loadServices();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // =================================================================
  // USERS
  // =================================================================
  async function drawUsers() {
    main.innerHTML = `<div class="panel"><h2>Users</h2><p class="panel-sub">Manage dashboard accounts, roles and groups. Groups are used to restrict which services a user sees.</p>
      <div style="margin-bottom:14px"><button class="btn btn-primary" id="add-user">${icon('plus')} Add user</button></div>
      <div id="user-list">Loading…</div></div>`;
    main.querySelector('#add-user').addEventListener('click', () => openUserEditor(null));
    await loadUsers();
  }

  async function loadUsers() {
    let users = [];
    try { users = (await API.users()).users; } catch (err) { toast(err.message, 'error'); }
    const list = main.querySelector('#user-list');
    if (!list) return;
    list.innerHTML = `<table class="table"><thead><tr><th>User</th><th>Role</th><th>Group</th><th>2FA</th><th style="width:150px"></th></tr></thead><tbody>
      ${users.map((u) => `<tr>
        <td><b>${esc(u.displayName)}</b> <span style="color:var(--faint)">@${esc(u.username)}</span></td>
        <td><span class="type-badge"><i style="--dot:${u.role === 'admin' ? 'var(--accent)' : 'var(--faint)'}"></i>${u.role}</span></td>
        <td>${u.groupName ? esc(u.groupName) : '<span style="color:var(--faint)">—</span>'}</td>
        <td>${u.totpEnabled ? '<span style="color:var(--ok)">on</span>' : '<span style="color:var(--faint)">off</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="icon-btn" data-uedit="${u.id}" title="Edit">${icon('edit')}</button>
          <button class="icon-btn" data-upass="${u.id}" title="Reset password">${icon('key')}</button>
          <button class="icon-btn" data-udel="${u.id}" title="Delete">${icon('trash')}</button>
        </td></tr>`).join('')}</tbody></table>`;

    list.querySelectorAll('[data-uedit]').forEach((btn) => btn.addEventListener('click', () => openUserEditor(users.find((u) => u.id === Number(btn.dataset.uedit)))));
    list.querySelectorAll('[data-upass]').forEach((btn) => btn.addEventListener('click', () => {
      const u = users.find((x) => x.id === Number(btn.dataset.upass));
      const body = h(`<div><label class="field"><span>New password for ${esc(u.username)}</span><input class="input" id="up-pass" type="password" autocomplete="new-password"></label>
        <p class="hint">All their sessions will be signed out.</p></div>`);
      const ok = h('<button class="btn btn-primary">Reset password</button>');
      const m = modal({ title: 'Reset password', body, footer: [ok] });
      ok.addEventListener('click', async () => {
        try { await API.resetUserPassword(u.id, { password: body.querySelector('#up-pass').value }); toast('Password reset', 'success'); m.close(); }
        catch (err) { toast(err.message, 'error'); }
      });
    }));
    list.querySelectorAll('[data-udel]').forEach((btn) => btn.addEventListener('click', async () => {
      const u = users.find((x) => x.id === Number(btn.dataset.udel));
      if (!(await confirmModal(`Delete user "${u.username}"?`, { danger: true, okLabel: 'Delete' }))) return;
      try { await API.deleteUser(u.id); toast('User deleted', 'success'); await loadUsers(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  }

  function openUserEditor(u) {
    const isNew = !u;
    const body = h(`<div>
      <label class="field"><span>Username</span><input class="input" id="u-name" value="${esc(u?.username || '')}" ${isNew ? '' : ''}></label>
      <label class="field"><span>Display name</span><input class="input" id="u-display" value="${esc(u?.displayName || '')}"></label>
      <div class="field-row">
        <label class="field"><span>Role</span><select class="input" id="u-role">
          <option value="user" ${u?.role !== 'admin' ? 'selected' : ''}>User</option>
          <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Administrator</option>
        </select></label>
        <label class="field"><span>Group (for service access)</span><input class="input" id="u-group" value="${esc(u?.groupName || '')}" placeholder="e.g. family"></label>
      </div>
      ${isNew ? `<label class="field"><span>Password</span><input class="input" id="u-pass" type="password" autocomplete="new-password"></label>` : ''}
    </div>`);
    const ok = h(`<button class="btn btn-primary">${icon('check')} ${isNew ? 'Create user' : 'Save'}</button>`);
    const m = modal({ title: isNew ? 'Add user' : `Edit ${u.username}`, body, footer: [ok] });
    ok.addEventListener('click', async () => {
      const payload = {
        username: body.querySelector('#u-name').value.trim(),
        displayName: body.querySelector('#u-display').value.trim(),
        role: body.querySelector('#u-role').value,
        groupName: body.querySelector('#u-group').value.trim(),
      };
      try {
        if (isNew) {
          await API.createUser({ ...payload, password: body.querySelector('#u-pass').value });
        } else {
          await API.updateUser(u.id, payload);
        }
        toast(isNew ? 'User created' : 'User saved', 'success');
        m.close();
        await loadUsers();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // =================================================================
  // GROUPS
  // =================================================================
  async function drawGroups() {
    main.innerHTML = `<div class="panel">
      <h2>Groups</h2>
      <p class="panel-sub">Groups restrict which services a user can see. Renaming updates users and service access.</p>
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <input class="input" id="grp-name" placeholder="New group name…" style="flex:1;min-width:200px">
        <button class="btn btn-primary" id="grp-add">${icon('plus')} Add group</button>
      </div>
      <div id="grp-list">Loading…</div>
    </div>`;
    const list = main.querySelector('#grp-list');
    const load = async () => {
      let groups = [];
      try { groups = (await API.groups()).groups; } catch (err) { toast(err.message, 'error'); }
      if (!groups.length) { list.innerHTML = '<div class="empty">No groups yet</div>'; return; }
      list.innerHTML = `<table class="table"><thead><tr><th>Group</th><th>Users</th><th>Services</th><th></th></tr></thead><tbody>
        ${groups.map((g) => `<tr>
          <td><b>${esc(g.name)}</b></td>
          <td>${g.users}</td>
          <td>${g.services}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="icon-btn" data-gren="${esc(g.name)}" title="Rename" aria-label="Rename group">${icon('edit')}</button>
            <button class="icon-btn" data-grdel="${esc(g.name)}" title="Delete" aria-label="Delete group">${icon('trash')}</button>
          </td>
        </tr>`).join('')}</tbody></table>`;
      list.querySelectorAll('[data-gren]').forEach((btn) => btn.addEventListener('click', () => {
        const from = btn.dataset.gren;
        const body = h(`<label class="field"><span>New name</span><input class="input" id="grp-ren" value="${esc(from)}"></label>`);
        const ok = h(`<button class="btn btn-primary">${icon('check')} Rename</button>`);
        const m = modal({ title: `Rename “${from}”`, body, footer: [ok] });
        ok.addEventListener('click', async () => {
          const to = body.querySelector('#grp-ren').value.trim();
          if (!to || to === from) return;
          ok.disabled = true;
          try { await API.renameGroup({ from, to }); m.close(); toast('Group renamed', 'success'); await load(); }
          catch (err) { toast(err.message, 'error'); ok.disabled = false; }
        });
      }));
      list.querySelectorAll('[data-grdel]').forEach((btn) => btn.addEventListener('click', async () => {
        const name = btn.dataset.grdel;
        if (!(await confirmModal(`Delete group “${name}”? Users keep their accounts; service access becomes “everyone”.`, { danger: true, okLabel: 'Delete' }))) return;
        try { await API.deleteGroup(name); toast('Group deleted', 'success'); await load(); }
        catch (err) { toast(err.message, 'error'); }
      }));
    };
    main.querySelector('#grp-add').addEventListener('click', async () => {
      const name = main.querySelector('#grp-name').value.trim();
      if (!name) return toast('Enter a group name', 'error');
      try {
        await API.createGroup({ name });
        main.querySelector('#grp-name').value = '';
        toast('Group added', 'success');
        await load();
      } catch (err) { toast(err.message, 'error'); }
    });
    await load();
  }

  // =================================================================
  // APPEARANCE
  // =================================================================
  function drawAppearance() {
    main.innerHTML = `<div class="panel"><h2>Global appearance</h2>
      <p class="panel-sub">This is the default look for every user. Users can override it under “My settings → My appearance”. Changes preview live; press Save to persist.</p>
      <div id="ap-host"></div></div>`;
    const host = main.querySelector('#ap-host');
    let working = { ...(state.settings.appearance || {}) };
    appearanceEditor(host, {
      get: () => ({ ...state.settings.appearance, ...working }),
      save: (patch) => { working = { ...working, ...patch }; },
      commit: async () => {
        const res = await API.saveSettings('appearance', working);
        state.settings.appearance = res.appearance;
      },
      onCommitted: () => { toast('Global appearance saved', 'success'); drawAppearance(); },
    });
  }

  // =================================================================
  // WIDGETS
  // =================================================================
  function drawWidgets() {
    const gl = state.settings.widgets?.layout || [];
    const conf = Object.fromEntries(gl.map((x) => [x.id, x]));
    const isEnabledByDefault = (w) => conf[w.id]?.enabled ?? (w.defaultOn === true);
    main.innerHTML = `<div class="panel"><h2>Default widgets</h2>
      <p class="panel-sub">Default widget set and widths for new users and users without a personal layout. Everyone can rearrange their own dashboard with the arrange button.</p>
      <table class="table"><thead><tr><th>Widget</th><th>Enabled by default</th><th>Default width</th></tr></thead><tbody>
      ${WIDGETS.map((w, idx) => `<tr>
        <td><b>${esc(w.title)}</b><br><span style="color:var(--faint);font-size:12px">${esc(w.desc || '')}</span></td>
        <td><label class="switch"><input type="checkbox" data-w="${w.id}" ${isEnabledByDefault(w) ? 'checked' : ''}><span class="knob"></span></label></td>
        <td><select class="input" data-span="${w.id}" style="width:80px">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${(conf[w.id]?.w || conf[w.id]?.span || w.defaultSpan) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      </tr>`).join('')}</tbody></table>
      <div style="margin-top:14px;text-align:right"><button class="btn btn-primary" id="w-save">${icon('check')} Save defaults</button></div></div>`;

    main.querySelector('#w-save').addEventListener('click', async () => {
      const layout = WIDGETS.map((w) => {
        const prev = conf[w.id] || {};
        const item = {
          id: w.id,
          enabled: main.querySelector(`[data-w="${w.id}"]`).checked,
          w: Number(main.querySelector(`[data-span="${w.id}"]`).value),
        };
        // keep any positions an admin already arranged, so saving widths doesn't reset them
        if (Number.isFinite(prev.x) && Number.isFinite(prev.y)) { item.x = prev.x; item.y = prev.y; }
        return item;
      });
      try {
        const res = await API.saveSettings('widgets', { layout });
        state.settings.widgets = res.widgets;
        toast('Widget defaults saved', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // =================================================================
  // SSO
  // =================================================================
  function drawSso() {
    const s = state.settings.sso || {};
    main.innerHTML = `<div class="panel"><h2>Single Sign-On (OAuth2 / OIDC)</h2>
      <p class="panel-sub">Works with Authentik, Authelia, Keycloak, Pocket ID, Auth0, Google, GitHub (via generic OIDC) and any standard OAuth2 provider. Users log in with their provider account; the dashboard username must match (or auto-provisioning creates it).</p>
      <div class="panel-grid">
        <div>
          <label class="field" style="display:flex;align-items:center;gap:10px"><span class="switch"><input type="checkbox" id="o-enabled" ${s.enabled ? 'checked' : ''}><span class="knob"></span></span><span>Enable SSO login</span></label>
          <label class="field"><span>Button label</span><input class="input" id="o-label" value="${esc(s.label || 'Single Sign-On')}"></label>
          <label class="field"><span>Client ID</span><input class="input" id="o-cid" value="${esc(s.clientId || '')}"></label>
          <label class="field"><span>Client secret</span><input class="input" id="o-csec" type="password" value="${esc(s.clientSecret || '')}" autocomplete="off"></label>
        </div>
        <div>
          <label class="field"><span>Authorization URL</span><input class="input" id="o-auth" value="${esc(s.authUrl || '')}" placeholder="https://sso.example.com/application/o/homedeck/authorize"></label>
          <label class="field"><span>Token URL</span><input class="input" id="o-token" value="${esc(s.tokenUrl || '')}" placeholder="https://sso.example.com/application/o/homedeck/token"></label>
          <label class="field"><span>Userinfo URL (optional)</span><input class="input" id="o-userinfo" value="${esc(s.userInfoUrl || '')}" placeholder="https://…/userinfo"></label>
          <label class="field"><span>Scopes</span><input class="input" id="o-scopes" value="${esc(s.scopes || 'openid profile email')}"></label>
          <label class="field"><span>Username claim</span><input class="input" id="o-unf" value="${esc(s.usernameField || 'preferred_username')}"></label>
          <label class="field" style="display:flex;align-items:center;gap:10px"><span class="switch"><input type="checkbox" id="o-autocreate" ${s.autoCreate !== false ? 'checked' : ''}><span class="knob"></span></span><span>Auto-create users on first login</span></label>
        </div>
      </div>
      <div style="text-align:right"><button class="btn btn-primary" id="o-save">${icon('check')} Save SSO settings</button></div></div>`;

    main.querySelector('#o-save').addEventListener('click', async () => {
      try {
        const res = await API.saveSettings('sso', {
          enabled: main.querySelector('#o-enabled').checked,
          label: main.querySelector('#o-label').value,
          clientId: main.querySelector('#o-cid').value,
          clientSecret: main.querySelector('#o-csec').value,
          authUrl: main.querySelector('#o-auth').value,
          tokenUrl: main.querySelector('#o-token').value,
          userInfoUrl: main.querySelector('#o-userinfo').value,
          scopes: main.querySelector('#o-scopes').value,
          usernameField: main.querySelector('#o-unf').value,
          autoCreate: main.querySelector('#o-autocreate').checked,
        });
        state.settings.sso = res.sso;
        toast('SSO settings saved', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // =================================================================
  // AUDIT LOG
  // =================================================================
  async function drawAudit() {
    main.innerHTML = `<div class="panel">
      <h2>Audit log</h2>
      <p class="panel-sub">Sign-ins, user/service changes, settings edits and backups. Newest first.</p>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <input class="input" id="audit-q" placeholder="Filter by user, action, detail or IP…">
        <button class="btn" id="audit-reload">${icon('refresh')} Refresh</button>
      </div>
      <div id="audit-list">Loading…</div>
    </div>`;
    const list = main.querySelector('#audit-list');
    const load = async () => {
      try {
        const entries = (await API.audit(main.querySelector('#audit-q').value.trim())).entries;
        list.innerHTML = entries.length
          ? `<table class="table"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead><tbody>
              ${entries.map((e) => `<tr>
                <td style="white-space:nowrap">${new Date(e.ts).toLocaleString()}</td>
                <td>${esc(e.username || '—')}</td>
                <td><b>${esc(e.action)}</b></td>
                <td>${esc(e.detail || '')}</td>
                <td>${esc(e.ip || '')}</td>
              </tr>`).join('')}
            </tbody></table>`
          : '<div class="empty">No audit entries</div>';
      } catch (err) { list.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
    };
    main.querySelector('#audit-reload').addEventListener('click', load);
    main.querySelector('#audit-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    await load();
  }

  // =================================================================
  // GENERAL
  // =================================================================
  function drawGeneral() {
    const g = state.settings.general || {};
    const w = g.weather || {};
    const al = state.settings.alerts || {};
    let weatherLocations = Array.isArray(w.locations)
      ? w.locations.map((loc, i) => ({
          id: String(loc.id || `loc-${i}`),
          label: String(loc.label || loc.name || ''),
          lat: Number(loc.lat),
          lon: Number(loc.lon),
          country: String(loc.country || '').toUpperCase(),
          admin1: String(loc.admin1 || ''),
          postcode: String(loc.postcode || ''),
        })).filter((loc) => Number.isFinite(loc.lat) && Number.isFinite(loc.lon))
      : (w.lat != null && w.lon != null
          ? [{ id: 'default', label: w.label || '', lat: Number(w.lat), lon: Number(w.lon), country: '', admin1: '', postcode: '' }]
          : []);
    let lastWeatherSearch = [];
    const localeRegion = (navigator.language?.split('-')[1] || '').toUpperCase();
    const defaultCountry = weatherLocations[0]?.country || (localeRegion.length === 2 ? localeRegion : 'DE');

    main.innerHTML = `<div class="panel"><h2>General</h2>
      <div class="panel-grid">
        <div>
          <label class="field"><span>Site title</span><input class="input" id="g-title" value="${esc(g.title || 'HomeDeck')}"></label>
          <div class="field-label" style="margin-top:14px">Weather locations</div>
          <div class="wx-list" id="wx-locations"></div>
          <div class="wx-search">
            <input class="input" id="wx-q" placeholder="City or postal code">
            <input class="input" id="wx-country" maxlength="2" value="${esc(defaultCountry)}" placeholder="DE" aria-label="Country code">
            <button class="btn" id="wx-search">${icon('search')} Search</button>
          </div>
          <div class="wx-results" id="wx-results"></div>
          <label class="field" style="margin-top:12px"><span>Weather units</span>
            <select class="input" id="g-wunit">
              <option value="c" ${(w.unit || 'c') === 'c' ? 'selected' : ''}>Celsius (°C)</option>
              <option value="f" ${w.unit === 'f' ? 'selected' : ''}>Fahrenheit (°F)</option>
            </select>
          </label>
          <p class="hint">Search by city name or postal code (e.g. 78713 + country DE). Forecasts come from open-meteo.com; no API key needed.</p>
        </div>
        <div>
          <div class="field-label">Configuration</div>
          <p class="hint" style="margin-bottom:10px">Export your services & settings as JSON (secrets are NOT included). Import re-creates services without keys — paste them afterwards.</p>
          <div style="display:flex;gap:9px;flex-wrap:wrap">
            <button class="btn" id="g-export">${icon('copy')} Export config</button>
            <label class="btn" style="cursor:pointer">${icon('download')} Import config
              <input type="file" id="g-import" accept="application/json" style="display:none">
            </label>
            <button class="btn" id="g-backup">${icon('lock')} Encrypted backup</button>
            <label class="btn" style="cursor:pointer">${icon('refresh')} Restore backup
              <input type="file" id="g-restore" accept="application/json" style="display:none">
            </label>
          </div>
        </div>
      </div>
      <div class="field-label" style="margin-top:18px">Alerts (webhook)</div>
      <div class="panel-grid">
        <div>
          <label class="field" style="display:flex;align-items:center;gap:10px">
            <span class="switch"><input type="checkbox" id="g-alert-enabled" ${al.enabled ? 'checked' : ''}><span class="knob"></span></span>
            <span>Enable webhook alerts</span>
          </label>
          <label class="field"><span>Webhook URL (ntfy, Discord, generic JSON)</span>
            <input class="input" id="g-alert-url" value="${esc(al.url || '')}" placeholder="https://ntfy.sh/my-topic">
          </label>
          <label class="field"><span>Disk warning threshold (%)</span>
            <input class="input" id="g-alert-pct" type="number" min="50" max="100" value="${esc(al.diskPct ?? 90)}">
          </label>
        </div>
        <div>
          <label class="field" style="display:flex;align-items:center;gap:10px"><span class="switch"><input type="checkbox" id="g-alert-down" ${al.onDown !== false ? 'checked' : ''}><span class="knob"></span></span><span>Service goes offline</span></label>
          <label class="field" style="display:flex;align-items:center;gap:10px"><span class="switch"><input type="checkbox" id="g-alert-up" ${al.onUp !== false ? 'checked' : ''}><span class="knob"></span></span><span>Service comes back online</span></label>
          <label class="field" style="display:flex;align-items:center;gap:10px"><span class="switch"><input type="checkbox" id="g-alert-disk" ${al.onDisk !== false ? 'checked' : ''}><span class="knob"></span></span><span>Disk usage above threshold</span></label>
          <button class="btn" id="g-alert-test">${icon('zap')} Send test alert</button>
          <p class="hint">Posts JSON <code>{app, event, ts, …}</code>. Save before testing.</p>
        </div>
      </div>
      <div style="margin-top:16px;text-align:right"><button class="btn btn-primary" id="g-save">${icon('check')} Save general</button></div>
      <p class="hint" style="text-align:right;margin-top:10px">HomeDeck v${esc(state.meta?.version || '')}</p></div>`;

    const drawWeatherLocations = () => {
      const list = main.querySelector('#wx-locations');
      if (!list) return;
      if (!weatherLocations.length) {
        list.innerHTML = '<div class="hint" style="margin:0 0 8px">No locations yet — search below.</div>';
        return;
      }
      list.innerHTML = weatherLocations.map((loc, i) => `
        <div class="wx-loc-row">
          <span class="wx-loc-ic">${icon('globe')}</span>
          <div style="flex:1;min-width:0">
            <b>${esc(loc.label || `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`)}</b>
            <div class="hint" style="margin:0">${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}${loc.admin1 ? ` · ${esc(loc.admin1)}` : ''}${loc.postcode ? ` · ${esc(loc.postcode)}` : ''}${loc.country ? ` · ${esc(loc.country)}` : ''}</div>
          </div>
          <button class="icon-btn" data-wx-remove="${i}" title="Remove location">${icon('trash')}</button>
        </div>`).join('');
      list.querySelectorAll('[data-wx-remove]').forEach((btn) => btn.addEventListener('click', () => {
        weatherLocations.splice(Number(btn.dataset.wxRemove), 1);
        drawWeatherLocations();
      }));
    };
    drawWeatherLocations();

    const weatherResults = main.querySelector('#wx-results');
    const addWeatherLocation = (r) => {
      if (weatherLocations.some((l) => Math.abs(l.lat - r.lat) < 0.01 && Math.abs(l.lon - r.lon) < 0.01)) {
        toast('This location is already in the list', 'info');
        return;
      }
      weatherLocations.push({
        id: r.id || `${r.lat},${r.lon}`,
        label: r.name || '',
        lat: r.lat,
        lon: r.lon,
        country: r.country || '',
        admin1: r.admin1 || '',
        postcode: r.postcode || '',
      });
      drawWeatherLocations();
      weatherResults.innerHTML = '';
      lastWeatherSearch = [];
    };
    const drawWeatherResults = () => {
      if (!lastWeatherSearch.length) { weatherResults.innerHTML = ''; return; }
      weatherResults.innerHTML = lastWeatherSearch.map((r, i) => `
        <button class="wx-result" data-wx-result="${i}">
          <span class="wx-result-main">${esc(r.name)}</span>
          <span class="wx-result-sub">${esc([r.admin1, r.country, r.postcode].filter(Boolean).join(' · '))}</span>
          <span class="wx-result-add">+ Add</span>
        </button>`).join('');
      weatherResults.querySelectorAll('[data-wx-result]').forEach((btn) => btn.addEventListener('click', () => {
        const result = lastWeatherSearch[Number(btn.dataset.wxResult)];
        if (result) addWeatherLocation(result);
      }));
    };
    const runWeatherSearch = async () => {
      const q = main.querySelector('#wx-q').value.trim();
      const country = main.querySelector('#wx-country').value.trim().toUpperCase();
      if (q.length < 2) return toast('Enter at least 2 characters', 'error');
      const btn = main.querySelector('#wx-search');
      btn.disabled = true;
      weatherResults.innerHTML = '<div class="hint" style="margin-top:6px">Searching…</div>';
      try {
        const res = await API.weatherSearch(q, country);
        lastWeatherSearch = res.results || [];
        if (!lastWeatherSearch.length) {
          weatherResults.innerHTML = '<div class="hint" style="margin-top:6px">No matches found.</div>';
        } else {
          drawWeatherResults();
        }
      } catch (err) {
        weatherResults.innerHTML = `<div class="hint" style="margin-top:6px;color:var(--bad)">${esc(err.message)}</div>`;
      } finally {
        btn.disabled = false;
      }
    };
    main.querySelector('#wx-search').addEventListener('click', runWeatherSearch);
    main.querySelector('#wx-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runWeatherSearch(); }
    });

    main.querySelector('#g-save').addEventListener('click', async () => {
      try {
        const locations = weatherLocations.map(({ id, label, lat, lon, country, admin1, postcode }) => ({
          id, label, lat, lon, country, admin1, postcode,
        }));
        const res = await API.saveSettings('general', {
          title: main.querySelector('#g-title').value.trim() || 'HomeDeck',
          weather: locations.length ? { unit: main.querySelector('#g-wunit').value, locations } : null,
        });
        state.settings.general = res.general;
        const alertsRes = await API.saveSettings('alerts', {
          enabled: main.querySelector('#g-alert-enabled').checked,
          url: main.querySelector('#g-alert-url').value.trim(),
          diskPct: Number(main.querySelector('#g-alert-pct').value) || 90,
          onDown: main.querySelector('#g-alert-down').checked,
          onUp: main.querySelector('#g-alert-up').checked,
          onDisk: main.querySelector('#g-alert-disk').checked,
        });
        state.settings.alerts = alertsRes.alerts;
        document.title = res.general.title || 'HomeDeck';
        if (locations.length) API.refreshWeather().catch(() => {});
        toast('General settings saved', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });

    main.querySelector('#g-alert-test').addEventListener('click', async () => {
      try { await API.testAlert(); toast('Test alert sent', 'success'); }
      catch (err) { toast(err.message, 'error'); }
    });

    main.querySelector('#g-export').addEventListener('click', async () => {
      try {
        const data = await API.exportConfig();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = h(`<a href="${URL.createObjectURL(blob)}" download="homedeck-config.json"></a>`);
        document.body.appendChild(a); a.click(); a.remove();
      } catch (err) { toast(err.message, 'error'); }
    });

    main.querySelector('#g-import').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!(await confirmModal('Import this configuration? Missing services will be added (without secrets).'))) return;
      try {
        const text = await file.text();
        const res = await API.importConfig(JSON.parse(text));
        toast(`Imported ${res.created} services`, 'success');
      } catch (err) { toast(err.message, 'error'); }
    });

    main.querySelector('#g-backup').addEventListener('click', () => {
      const body = h(`<div>
        <label class="field"><span>Passphrase (min. 8 characters)</span><input class="input" id="bk-pass" type="password" autocomplete="new-password"></label>
        <p class="hint">Includes service credentials, encrypted with this passphrase. Keep it safe — it cannot be recovered.</p>
      </div>`);
      const ok = h(`<button class="btn btn-primary">${icon('lock')} Download backup</button>`);
      const m = modal({ title: 'Encrypted backup', body, footer: [ok] });
      ok.addEventListener('click', async () => {
        const pass = body.querySelector('#bk-pass').value;
        if (pass.length < 8) return toast('Passphrase must be at least 8 characters', 'error');
        ok.disabled = true;
        try {
          const backup = await API.backup({ passphrase: pass });
          const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
          const a = h(`<a href="${URL.createObjectURL(blob)}" download="homedeck-backup-${new Date().toISOString().slice(0, 10)}.json"></a>`);
          document.body.appendChild(a); a.click(); a.remove();
          m.close();
          toast('Encrypted backup downloaded', 'success');
        } catch (err) { toast(err.message, 'error'); ok.disabled = false; }
      });
    });

    main.querySelector('#g-restore').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      let backup;
      try { backup = JSON.parse(await file.text()); }
      catch { return toast('Not a valid JSON file', 'error'); }
      const body = h(`<div>
        <label class="field"><span>Passphrase</span><input class="input" id="rs-pass" type="password" autocomplete="current-password"></label>
        <p class="hint">This <b>replaces all services and settings</b> in this instance.</p>
      </div>`);
      const ok = h(`<button class="btn btn-danger">${icon('refresh')} Restore</button>`);
      const m = modal({ title: 'Restore backup', body, footer: [ok] });
      ok.addEventListener('click', async () => {
        ok.disabled = true;
        try {
          const res = await API.restore({ passphrase: body.querySelector('#rs-pass').value, backup });
          m.close();
          toast(`Restored ${res.services} services`, 'success');
          setTimeout(() => location.reload(), 800);
        } catch (err) { toast(err.message, 'error'); ok.disabled = false; }
      });
    });
  }

  if (!embedded) {
    root.querySelector('#btn-logout').addEventListener('click', async () => {
      try { await API.logout(); } catch { /* ignore */ }
      state.user = null;
      location.hash = '#/login';
      location.reload();
    });
  }

  if (!isActive()) return;
  draw();

  // deep-link: open a service editor when arriving from dashboard context menu
  const editId = Number(sessionStorage.getItem('hd-edit-service') || 0);
  if (editId) {
    sessionStorage.removeItem('hd-edit-service');
    try {
      const all = await API.services();
      const svc = all.services.find((s) => s.id === editId);
      if (svc) openServiceEditor(svc);
    } catch { /* ignore */ }
  }
}
