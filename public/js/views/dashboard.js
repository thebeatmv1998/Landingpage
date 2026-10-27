import { state, savePrefs, effectiveAppearance } from '../state.js';
import { API } from '../api.js';
import { esc, h, icon, toast, modal, confirmModal, debounce } from '../ui.js';
import { showTask } from '../task.js';
import { createDashGrid } from '../grid.js';
import { WIDGETS, renderClock, renderWeather, renderServices, renderNowPlaying, renderRequests, renderDownloads, renderPihole, renderDisks, renderIndexers, renderDocker, renderHost, renderHealth, renderCalendar, renderUnraid, renderNextcloud } from './widgets.js';
import { probeService, probeServices, onReachability } from '../net.js';

const RENDERERS = {
  clock: renderClock, weather: renderWeather, services: renderServices, nowPlaying: renderNowPlaying,
  requests: renderRequests,
  downloads: renderDownloads, pihole: renderPihole, disks: renderDisks, indexers: renderIndexers,
  docker: renderDocker, host: renderHost, health: renderHealth, calendar: renderCalendar, unraid: renderUnraid,
  nextcloud: renderNextcloud,
};

let editMode = false;

export async function renderDashboard(root, { navigate }) {
  const isAdmin = state.user.role === 'admin';
  const appearance = effectiveAppearance();

  // ---- layout: global defaults, overridden per user (missing user entries fall back to global).
  // Each entry is { id, enabled, x, y, w } — a column position, vertical offset and column span.
  const cols = Math.max(1, Math.min(6, Number(appearance.cols) || 4));
  const defaultsLayout = WIDGETS.map((w) => ({ id: w.id, enabled: w.defaultOn === true, w: w.defaultSpan }));
  const globalLayout = (state.settings.widgets?.layout?.length ? state.settings.widgets.layout : defaultsLayout);
  const userLayout = state.user.prefs?.layout?.length ? state.user.prefs.layout : null;
  const globalMap = new Map(globalLayout.map((x) => [x.id, x]));
  const userMap = userLayout ? new Map(userLayout.map((x) => [x.id, x])) : null;
  const layout = [];
  {
    let cursor = 0, row = 0;
    for (const w of WIDGETS) {
      const g = globalMap.get(w.id) || defaultsLayout.find((d) => d.id === w.id) || { w: w.defaultSpan };
      const u = userMap?.get(w.id);
      const src = u ? { ...g, ...u } : g;
      const srcH = Math.round(Number(src.h));
      const ww = Math.max(1, Math.min(cols, Math.round(Number(src.w) || Number(src.span) || w.defaultSpan || 2)));
      const enabled = u ? u.enabled !== false : (g.enabled !== false);
      let x, y;
      if (Number.isFinite(src.x) && Number.isFinite(src.y)) {
        x = Math.max(0, Math.min(cols - ww, Math.round(src.x)));
        y = Math.max(0, Math.round(src.y));
      } else {
        if (cursor + ww > cols) { cursor = 0; row += 1; }
        x = cursor; y = row * 40;
        cursor += ww;
        if (cursor >= cols) { cursor = 0; row += 1; }
      }
      layout.push({ id: w.id, enabled, x, y, w: ww, ...(Number.isFinite(srcH) && srcH >= 140 ? { h: srcH } : {}) });
    }
  }

  let filter = '';

  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/">
        <span class="brand-logo"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 17V9.5L12 6l5 3.5V17h-3.4v-4h-3.2v4z"/></svg></span>
        <span>${esc(state.settings.general?.title || 'HomeDeck')}</span>
      </a>
      <label class="topbar-search">${icon('search')}<input id="svc-filter" placeholder="Filter services…" value="${esc(filter)}"></label>
      <div class="topbar-spacer"></div>
      <div class="deck-status" id="deck-status" title="Services online"></div>
      <div class="clockbox"><div class="clock-time" id="tb-clock"></div><div class="clock-date" id="tb-date"></div></div>
      <button class="icon-btn${editMode ? ' active' : ''}" id="btn-edit" title="${editMode ? 'Done arranging' : 'Arrange widgets'}" aria-label="${editMode ? 'Done arranging' : 'Arrange widgets'}">${icon('edit')}</button>
      <a class="icon-btn" href="#/settings" title="Settings" aria-label="Settings">${icon('settings')}</a>
      <button class="icon-btn" id="btn-logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>
    </header>
    ${editMode ? `<div class="arrange-hint">${icon('drag')} Drag a widget by its title to move it anywhere · drag the corner to resize width &amp; height · double-click the corner for auto height</div>` : ''}
    <main class="dashboard-wrap"><div class="dashboard${editMode ? ' editing' : ''}" id="dash"></div></main>
  `;

  const disposeFns = [];
  const tick = () => {
    const now = new Date();
    const c = root.querySelector('#tb-clock'), d = root.querySelector('#tb-date');
    if (c) c.textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (d) d.textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };
  tick();
  const clockTimer = setInterval(tick, 1000);
  disposeFns.push(() => clearInterval(clockTimer));

  const updateDeckStatus = () => {
    const el = root.querySelector('#deck-status');
    if (!el) return;
    const all = [...state.services.values()].filter((s) => s.enabled !== false);
    const online = all.filter((s) => s.online).length;
    const down = all.length - online;
    el.innerHTML = `<span class="dot ${down ? 'dot-bad' : 'dot-ok'}"></span><b>${online}</b><span class="deck-status-of">/ ${all.length}</span><span class="deck-status-label">online</span>`;
    el.title = down ? `${down} service${down === 1 ? '' : 's'} offline` : 'All services online';
  };
  updateDeckStatus();

  const dash = root.querySelector('#dash');
  const instances = new Map(); // widgetId -> { el, update }

  // Free-form layout engine: drag/resize widgets anywhere on the column grid.
  const grid = createDashGrid(dash, {
    getCols: () => cols,
    getGap: () => (appearance.compact ? 10 : 16),
    isEditable: () => editMode,
    onChange: (snap) => {
      // The engine lays out its own copies; write the settled positions back into
      // the layout we persist so drags/resizes actually stick.
      for (const s of snap) {
        const l = layout.find((x) => x.id === s.id);
        if (l) {
          l.x = s.x; l.y = s.y; l.w = s.w; l.enabled = s.enabled;
          if (s.h) l.h = s.h; else delete l.h;
        }
      }
      persistLayout();
    },
  });
  disposeFns.push(() => grid.destroy());

  function widgetCtx() {
    return {
      services: [...state.services.values()].filter((s) => s.enabled !== false),
      weather: state.weather,
      filter,
      appearance,
      editMode,
      isAdmin,
      ui: { modal },
      confirm: confirmModal,
      toast,
      savePrefs,
      rerenderWidget: refreshWidget,
      onReorderServices: async (ids) => {
        await API.reorderServices(ids);
        for (let i = 0; i < ids.length; i++) {
          const s = state.services.get(ids[i]);
          if (s) s.sort_order = i;
        }
      },
      openAdminServiceEdit: (id) => { navigate('#/settings?tab=services'); try { sessionStorage.setItem('hd-edit-service', String(id)); } catch { /* private mode */ } },
      runServiceAction: async (serviceId, payload, options = {}) => {
        const task = options.progress ? showTask(options.progress) : null;
        try {
          const res = await API.serviceAction(serviceId, payload);
          if (res?.ok) {
            if (task) task.done(res.message);
            else if (res.message) toast(res.message, 'success');
          } else {
            const message = res?.message || 'Action failed';
            if (task) task.fail(message);
            else toast(message, 'error');
          }
          return res;
        } catch (err) {
          if (task) task.fail(err.message);
          else toast(err.message, 'error');
          return { ok: false, message: err.message };
        }
      },
    };
  }

  function persistLayout() {
    savePrefs({ layout: layout.map(({ id, enabled, x, y, w, h }) => ({ id, enabled, x, y, w, h })) })
      .catch((err) => toast(err.message, 'error'));
  }

  function buildWidgetEl(w, conf, index = 0) {
    const el = h(`<section class="widget" data-widget="${w.id}" style="--i:${index}" tabindex="${editMode ? '0' : '-1'}">
      <div class="widget-head">
        <h3>${icon(w.icon)} ${esc(w.title)}</h3>
        <div class="widget-tools">
          ${conf.enabled
            ? `<button class="icon-btn" data-act="span" title="Cycle width">${icon('arrow')}</button>
               <button class="icon-btn" data-act="hide" title="Remove widget">${icon('x')}</button>`
            : `<button class="icon-btn" data-act="restore" title="Add widget back">${icon('plus')}</button>`}
        </div>
      </div>
      <div class="widget-body">${conf.enabled ? '' : '<div class="empty">Widget removed — use + to restore</div>'}</div>
      ${editMode && conf.enabled ? '<span class="widget-resize" title="Drag to resize · double-click to reset height"></span>' : ''}
    </section>`);
    el.classList.toggle('editing', editMode);
    el.classList.toggle('widget-disabled', !conf.enabled);
    const spanBtn = el.querySelector('[data-act="span"]');
    if (spanBtn) spanBtn.addEventListener('click', () => {
      conf.w = (conf.w || w.defaultSpan) >= cols ? 1 : (conf.w || w.defaultSpan) + 1;
      conf.x = Math.min(conf.x, Math.max(0, cols - conf.w));
      grid.relayout();
      persistLayout();
    });
    const hideBtn = el.querySelector('[data-act="hide"]');
    if (hideBtn) hideBtn.addEventListener('click', () => {
      conf.enabled = false;
      persistLayout();
      renderGrid();
    });
    const restoreBtn = el.querySelector('[data-act="restore"]');
    if (restoreBtn) restoreBtn.addEventListener('click', () => {
      conf.enabled = true;
      persistLayout();
      renderGrid();
    });
    return el;
  }

  function renderGrid() {
    for (const { el } of instances.values()) el.remove();
    instances.clear();
    const ctx = widgetCtx();
    const visible = editMode ? layout : layout.filter((x) => x.enabled);
    let index = 0;
    for (const conf of visible) {
      const w = WIDGETS.find((x) => x.id === conf.id);
      if (!w) continue;
      const renderer = RENDERERS[w.id];
      if (!renderer) continue;
      const el = buildWidgetEl(w, conf, index++);
      let update = null;
      if (conf.enabled) {
        const bodyEl = el.querySelector('.widget-body');
        try { update = renderer(bodyEl, ctx); } catch (err) { bodyEl.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
      }
      instances.set(w.id, { el, update });
      dash.appendChild(el);
    }
    grid.setItems(layout);
    requestAnimationFrame(() => grid.relayout());
  }

  // ---- live updates
  const refreshWidget = (id) => {
    const inst = instances.get(id);
    if (!inst || !inst.el.querySelector('.widget-body')) return;
    const bodyEl = inst.el.querySelector('.widget-body');
    const w = WIDGETS.find((x) => x.id === id);
    try {
      const upd = RENDERERS[id]?.(bodyEl, widgetCtx());
      if (typeof upd === 'function' && id === 'clock') disposeFns.push(upd);
    } catch { /* keep previous content */ }
  };

  const NOW_PLAYING_TYPES = ['jellyfin', 'audiobookshelf', 'navidrome'];
  const DOWNLOAD_TYPES = ['sabnzbd', 'sonarr', 'radarr', 'lidarr'];
  const refreshServices = debounce(() => refreshWidget('services'), 200);
  const refreshNow = debounce(() => refreshWidget('nowPlaying'), 200);
  const refreshDl = debounce(() => refreshWidget('downloads'), 200);

  // A probe result changed which address a service links to: re-render the
  // widgets that contain service links.
  const offReach = onReachability(() => {
    refreshWidget('services');
    refreshWidget('health');
    refreshWidget('calendar');
  });
  disposeFns.push(offReach);

  const lastSnapshots = new Map(); // serviceId -> last rendered JSON (skip redundant renders)
  const onServiceUpdate = (snap) => {
    if (snap.fallbackUrl) probeService(snap);
    const sig = JSON.stringify(snap);
    if (lastSnapshots.get(snap.id) === sig) return;
    lastSnapshots.set(snap.id, sig);
    refreshServices();
    if (NOW_PLAYING_TYPES.includes(snap.type)) refreshNow();
    if (DOWNLOAD_TYPES.includes(snap.type)) refreshDl();
    if (snap.type === 'pihole') refreshWidget('pihole');
    if (snap.charts?.disks) refreshWidget('disks');
    if (snap.type === 'unraid') refreshWidget('unraid');
    if (snap.type === 'prowlarr' || snap.type === 'nzbhydra') refreshWidget('indexers');
    if (snap.type === 'docker') refreshWidget('docker');
    if (snap.type === 'nextcloud') refreshWidget('nextcloud');
    refreshWidget('health');
    if (snap.calendar?.length) refreshWidget('calendar');
    updateDeckStatus();
  };
  const onWeatherUpdate = () => refreshWidget('weather');
  const onSummaryLoaded = () => {
    updateDeckStatus();
    // Fill the widgets from the initial summary too, so the dashboard is complete
    // even before (or without) the SSE stream — e.g. behind a buffering proxy.
    for (const id of Object.keys(RENDERERS)) if (id !== 'clock') refreshWidget(id);
    probeServices([...state.services.values()]);
  };
  window.addEventListener('service-update', (e) => onServiceUpdate(e.detail));
  window.addEventListener('weather-update', onWeatherUpdate);
  window.addEventListener('summary-loaded', onSummaryLoaded);
  // Coming back online or returning to the tab is a good moment to re-check
  // whether the LAN address works again.
  const reprobe = () => probeServices([...state.services.values()], { force: true });
  const onVisible = () => { if (!document.hidden) probeServices([...state.services.values()]); };
  window.addEventListener('online', reprobe);
  document.addEventListener('visibilitychange', onVisible);
  disposeFns.push(() => {
    window.removeEventListener('service-update', onServiceUpdate);
    window.removeEventListener('weather-update', onWeatherUpdate);
    window.removeEventListener('summary-loaded', onSummaryLoaded);
    window.removeEventListener('online', reprobe);
    document.removeEventListener('visibilitychange', onVisible);
  });

  // ---- search filter
  root.querySelector('#svc-filter').addEventListener('input', debounce((e) => {
    filter = e.target.value;
    refreshWidget('services');
  }, 150));

  // ---- arrange mode toggle (available to everyone — it's their own layout)
  const btnEdit = root.querySelector('#btn-edit');
  if (btnEdit) {
    btnEdit.addEventListener('click', () => { editMode = !editMode; if (editMode) toast('Arrange mode — drag widgets anywhere', 'info'); renderDashboard(root, { navigate }); });
  }

  // ---- logout
  root.querySelector('#btn-logout').addEventListener('click', async () => {
    try { await API.logout(); } catch { /* ignore */ }
    state.user = null;
    location.hash = '#/login';
    location.reload();
  });

  renderGrid();
  probeServices([...state.services.values()]);

  // dispose timers/listeners when this view is replaced
  const observer = new MutationObserver(() => {
    if (!document.body.contains(dash)) {
      for (const fn of disposeFns) { try { fn(); } catch { /* ignore */ } }
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
