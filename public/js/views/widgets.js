import { esc, fmtNum, fmtBytes, fmtDuration, donut, multiDonut, areaChart, barsChart, sparkline } from '../charts.js';
import { icon, serviceIcon, statusDot, statChip, wireIcons, greeting, h, toast } from '../ui.js';
import { state } from '../state.js';
import { API } from '../api.js';
import { serviceUrl, isExternal, probeService } from '../net.js';

// Stable per-session clocks so the "now playing" time keeps ticking between
// polls even if a client only reports its position once per track.
const playbackClocks = new Map();

// Widget registry. render(bodyEl, ctx) fills the body; ctx = { services, weather, filter }.

// WMO weather codes → [label, icon, colour tone].
const WMO = {
  0: ['Clear sky', 'sun', 'sun'],
  1: ['Mainly clear', 'sun', 'sun'],
  2: ['Partly cloudy', 'partly', 'partly'],
  3: ['Overcast', 'cloud', 'cloud'],
  45: ['Fog', 'fog', 'fog'],
  48: ['Icy fog', 'fog', 'fog'],
  51: ['Light drizzle', 'drizzle', 'rain'],
  53: ['Drizzle', 'drizzle', 'rain'],
  55: ['Heavy drizzle', 'rain', 'rain'],
  56: ['Freezing drizzle', 'drizzle', 'snow'],
  57: ['Freezing drizzle', 'rain', 'snow'],
  61: ['Light rain', 'rain', 'rain'],
  63: ['Rain', 'rain', 'rain'],
  65: ['Heavy rain', 'rain', 'rain'],
  66: ['Freezing rain', 'rain', 'snow'],
  67: ['Freezing rain', 'rain', 'snow'],
  71: ['Light snow', 'snow', 'snow'],
  73: ['Snow', 'snow', 'snow'],
  75: ['Heavy snow', 'snow', 'snow'],
  77: ['Snow grains', 'snow', 'snow'],
  80: ['Light showers', 'rain', 'rain'],
  81: ['Showers', 'rain', 'rain'],
  82: ['Violent showers', 'rain', 'rain'],
  85: ['Snow showers', 'snow', 'snow'],
  86: ['Snow showers', 'snow', 'snow'],
  95: ['Thunderstorm', 'storm', 'storm'],
  96: ['Thunder + hail', 'storm', 'storm'],
  99: ['Thunder + hail', 'storm', 'storm'],
};
function wmo(code, isDay = 1) {
  const [label, iconName, tone] = WMO[code] || ['—', 'cloud', 'cloud'];
  if (!Number(isDay) && (iconName === 'sun' || iconName === 'partly')) return { label, icon: 'moon', tone: 'night' };
  return { label, icon: iconName, tone };
}

export const WIDGETS = [
  { id: 'services', title: 'Services', icon: 'menu', defaultSpan: 4, fixed: true, defaultOn: true, desc: 'Grid of all your services with live status' },
  { id: 'nowPlaying', title: 'Now Playing', icon: 'play', defaultSpan: 2, defaultOn: true, desc: 'Live streams from Jellyfin, Audiobookshelf & Navidrome' },
  { id: 'requests', title: 'Requests', icon: 'film', defaultSpan: 2, defaultOn: true, desc: 'Seerr requests — pending, approved, available and latest posters' },
  { id: 'downloads', title: 'Downloads', icon: 'download', defaultSpan: 2, defaultOn: true, desc: 'SABnzbd queue and *arr activity with speed graph' },
  { id: 'calendar', title: 'Media Calendar', icon: 'calendar', defaultSpan: 2, defaultOn: true, desc: 'Upcoming episodes, movies and albums (next 7 days)' },
  { id: 'pihole', title: 'DNS / Ad Blocking', icon: 'shield', defaultSpan: 2, defaultOn: true, desc: 'Pi-hole stats and 24h query graph' },
  { id: 'docker', title: 'Docker', icon: 'cube', defaultSpan: 2, defaultOn: true, desc: 'Container states with WebUI links, updates and health' },
  { id: 'host', title: 'Host System', icon: 'chart', defaultSpan: 2, defaultOn: true, desc: 'CPU, RAM, swap, temperature, network and uptime from /proc and /sys' },
  { id: 'history', title: 'History', icon: 'chart', defaultSpan: 2, defaultOn: true, desc: '24h / 7d / 30d trends for host, Pi-hole and downloads' },
  { id: 'uptime', title: 'Uptime & SSL', icon: 'shield', defaultSpan: 2, defaultOn: true, desc: 'Uptime percentages, outage timeline and TLS certificate expiry' },
  { id: 'unraid', title: 'Unraid System', icon: 'cube', defaultSpan: 2, defaultOn: true, desc: 'CPU, uptime, array, parity and disk temperatures' },
  { id: 'nextcloud', title: 'Nextcloud', icon: 'cloud', defaultSpan: 2, defaultOn: true, desc: 'Storage, files, users, shares and server load' },
  { id: 'disks', title: 'Disk Space', icon: 'chart', defaultSpan: 2, desc: 'Disk usage from *arr apps and Nextcloud' },
  { id: 'indexers', title: 'Indexers', icon: 'search', defaultSpan: 2, desc: 'Prowlarr & NZBHydra query/grab stats' },
  { id: 'health', title: 'Service Health', icon: 'zap', defaultSpan: 2, desc: 'Online/offline strip for all services' },
  { id: 'weather', title: 'Weather', icon: 'sun', defaultSpan: 2, desc: 'Multi-city current conditions + 5-day forecast' },
  { id: 'clock', title: 'Clock', icon: 'clock', defaultSpan: 2, desc: 'Large clock with greeting' },
];

// ---------------------------------------------------------------- helpers
function servicesWithData(ctx, pred) {
  return ctx.services.filter(pred);
}
function statValue(svc, label) {
  const s = (svc.stats || []).find((x) => String(x.label).toLowerCase() === label.toLowerCase());
  return s ? s.value : null;
}
function proxyArt(svc, art) {
  if (!art) return '';
  if (art.startsWith('data:')) return art;
  if (/^(https?:)?\/\//i.test(art)) {
    // Absolute URL: if it points at the service itself, route it through the proxy
    // too (avoids mixed-content blocks and keeps auth server-side). External art
    // (TheTVDB/TMDB) is loaded directly.
    try {
      const a = new URL(art, location.origin);
      const b = new URL(svc.url || location.origin, location.origin);
      if (a.host && a.host === b.host) return `/api/proxy/${svc.id}${a.pathname}${a.search}`;
    } catch { /* fall through */ }
    return art;
  }
  return `/api/proxy/${svc.id}${art.startsWith('/') ? art : '/' + art}`;
}
// Volumes arrive as GB. Storage vendors and Unraid use decimal units, so format
// with 1000-based steps → a 16 TB disk reads "16.0 TB", not the binary 14.6 TiB.
const fmtVol = (gb) => {
  const n = Number(gb);
  if (!Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n * 1e9, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
};
function updatedTag(svc) {
  if (!svc?.fetchedAt) return '';
  const t = new Date(svc.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<div class="widget-updated" title="Last updated">Updated ${esc(t)}</div>`;
}

// ---------------------------------------------------------------- clock widget
export function renderClock(body) {
  const draw = () => {
    const now = new Date();
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;justify-content:center;min-height:86px">
        <div style="font-size:40px;font-weight:750;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.05">${esc(time)}</div>
        <div style="color:var(--muted);margin-top:2px">${esc(greeting())} · ${esc(date)}</div>
      </div>`;
  };
  draw();
  const t = setInterval(draw, 1000);
  return () => clearInterval(t);
}

// ---------------------------------------------------------------- weather widget
export function renderWeather(body, ctx) {
  const normalize = (w) => {
    if (!w) return [];
    if (Array.isArray(w.locations) && w.locations.length) return w.locations;
    if (w.temp != null || w.code != null || w.label) return [{ ...w, id: w.id || 'default' }];
    return [];
  };

  const draw = (w) => {
    const locations = normalize(w);
    if (!locations.length) {
      body.innerHTML = `<div class="empty">${icon('cloud')} Weather not configured.<br><span style="font-size:11.5px">Settings → Administration → General → Weather locations</span></div>`;
      return;
    }
    const preferred = state.user?.prefs?.weatherCity;
    const selected = locations.find((l) => l.id === preferred)
      || locations.find((l) => l.temp != null)
      || locations[0];
    const chipHtml = locations.length > 1
      ? `<div class="wx-locations">${locations.map((l) => `
          <button class="wx-loc-chip${l.id === selected.id ? ' active' : ''}" data-wx-loc="${esc(l.id)}"
            title="${esc(l.label || 'Location')}${l.error ? ' — ' + esc(l.error) : ''}">${esc(l.label || 'Location')}</button>`).join('')}</div>`
      : '';
    const choose = async (id) => {
      if (state.user) state.user.prefs = { ...(state.user.prefs || {}), weatherCity: id };
      try { if (ctx.savePrefs) await ctx.savePrefs({ weatherCity: id }); } catch { /* still switch locally */ }
      draw(w);
    };
    const wire = () => {
      body.querySelectorAll('[data-wx-loc]').forEach((btn) => btn.addEventListener('click', () => choose(btn.dataset.wxLoc)));
      const btn = body.querySelector('.wx-refresh');
      if (btn) btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.classList.add('loading');
        try {
          const res = await API.refreshWeather();
          draw(res.weather || state.weather);
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
          btn.classList.remove('loading');
        }
      });
    };

    if (selected.temp == null) {
      body.innerHTML = `${chipHtml}
        <div class="empty">${icon('cloud')} ${esc(selected.label || 'Weather')}<br><span style="font-size:11px">${esc(selected.error || 'No data available')}</span></div>
        <div class="wx-actions" style="margin:6px auto 0"><button class="icon-btn wx-refresh" title="Refresh weather" aria-label="Refresh weather">${icon('refresh')}</button></div>`;
      wire();
      return;
    }

    const cur = wmo(selected.code, selected.isDay);
    const stamp = selected.updatedAt ? new Date(selected.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const days = (selected.daily || []).slice(0, 5);
    const unit = (selected.unit || w.unit) === 'f' ? 'f' : 'c';
    const conv = (c) => (c == null ? null : unit === 'f' ? (c * 9) / 5 + 32 : c);
    const showTemp = (c) => (c == null ? '–' : `${Math.round(conv(c))}°`);
    const unitLabel = unit === 'f' ? '°F' : '°C';
    const windVal = selected.wind == null ? null : (unit === 'f' ? selected.wind * 0.621371 : selected.wind);
    const windUnit = unit === 'f' ? 'mph' : 'km/h';
    const forecast = days.length ? `
      <div class="wx-forecast">
        ${days.map((d) => {
          const x = wmo(d.code, 1);
          const dow = d.date ? new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' }) : '';
          const tip = [x.label, d.precip != null ? `${d.precip}% rain` : ''].filter(Boolean).join(' · ');
          return `<div class="wx-day" title="${esc(tip)}">
            <span class="wx-dow">${esc(dow)}</span>
            <span class="wx-sym wx-${x.tone}">${icon(x.icon)}</span>
            <span class="wx-max">${esc(showTemp(d.max))}</span>
            <span class="wx-min">${esc(showTemp(d.min))}</span>
          </div>`;
        }).join('')}
      </div>` : '';

    body.innerHTML = `${chipHtml}
      <div class="weather-now">
        <div class="weather-ic wx-${cur.tone}">${icon(cur.icon)}</div>
        <div style="min-width:0;flex:1">
          <div class="weather-temp">${esc(Math.round(conv(selected.temp)))}${unitLabel}</div>
          <div class="weather-desc">${selected.label ? esc(selected.label) + ' · ' : ''}${esc(cur.label)}</div>
          <div class="weather-extra">
            ${selected.max != null && selected.min != null ? `<span>↑ <b>${esc(showTemp(selected.max))}</b></span><span>↓ <b>${esc(showTemp(selected.min))}</b></span>` : ''}
            ${windVal != null ? `<span>${icon('wind')} <b>${esc(Math.round(windVal))} ${windUnit}</b></span>` : ''}
          </div>
        </div>
        <div class="wx-actions">
          ${stamp ? `<span class="wx-updated" title="Last updated">${esc(stamp)}</span>` : ''}
          <button class="icon-btn wx-refresh" title="Refresh weather" aria-label="Refresh weather">${icon('refresh')}</button>
        </div>
      </div>
      ${forecast}`;
    wire();
  };
  draw(ctx.weather || state.weather);
  return (w) => draw(w);
}

// ---------------------------------------------------------------- services widget
function svcCardHtml(svc, ctx) {
  const hidden = (state.user?.prefs?.hiddenServices || []).includes(svc.id);
  const stats = (svc.stats || []).filter((s) => typeof s.value === 'number' || typeof s.value === 'string').slice(0, 3);
  const size = (svc.stats || []).find((s) => s.label === 'On disk');
  const primary = stats[0] ? `${stats[0].label}: ${stats[0].value}` : (svc.online ? 'Online' : '');
  const statLine = size ? `${primary} · ${size.value}` : primary;
  const act = (svc.activity || []).slice(0, 2);
  const href = serviceUrl(svc);
  const external = isExternal(svc);
  const remoteTitle = external ? `Using the public address (local unreachable): ${svc.fallbackUrl}` : '';
  return `
  <a class="svc-card ${hidden ? 'hidden-dim' : ''}${external ? ' is-remote' : ''}" href="${href ? esc(href) : '#'}" target="_blank" rel="noopener noreferrer"${external ? ` title="${esc(remoteTitle)}"` : ''}
     data-svc="${svc.id}" data-state="${svc.online ? (svc.stale ? 'stale' : 'ok') : 'off'}" draggable="${ctx.editMode && ctx.isAdmin ? 'true' : 'false'}">
    ${serviceIcon(svc)}
    <span class="svc-main">
      <span class="svc-name">${statusDot(svc.online, svc.stale ? 'dot-warn' : '')} ${esc(svc.name)}${external ? `<span class="svc-remote" title="${esc(remoteTitle)}">${icon('globe')}</span>` : ''}</span>
      ${svc.online
        ? `<span class="svc-stat"${size ? ` title="On disk: ${esc(size.value)}"` : ''}>${esc(statLine)}</span>`
        : `<span class="svc-stat svc-error" title="${esc(svc.error)}">${svc.error === 'disabled' ? 'Disabled' : 'Offline'}</span>`}
      ${act.length ? `<span class="svc-mini">${act.map((a) => `
        <span class="progress-line"><span class="progress-fill" style="width:${esc(a.progress)}%;display:block"></span></span>`).join('')}</span>` : ''}
    </span>
    <button class="icon-btn svc-menu-btn" data-menu="${svc.id}" title="Options" aria-label="Options for ${esc(svc.name)}">${icon('menu')}</button>
  </a>`;
}

function wireServiceCards(container, ctx, rerender) {
  wireIcons(container);
  container.querySelectorAll('.svc-menu-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openServiceMenu(Number(btn.dataset.menu), ctx, rerender);
    });
  });
  if (ctx.editMode) {
    let dragged = null;
    container.querySelectorAll('.svc-card').forEach((card) => {
      card.addEventListener('dragstart', (e) => { dragged = card; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      card.addEventListener('dragend', () => { card.classList.remove('dragging'); });
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.style.borderTop = '2px solid var(--accent)'; });
      card.addEventListener('dragleave', () => { card.style.borderTop = ''; });
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.style.borderTop = '';
        if (!dragged || dragged === card) return;
        card.parentElement.insertBefore(dragged, card);
        const ids = [...container.querySelectorAll('.svc-card')].map((c) => Number(c.dataset.svc));
        try { await ctx.savePrefs({ serviceOrder: ids }); } catch (err) { ctx.toast(err.message, 'error'); }
        dragged = null;
      });
    });
  }
}

async function openServiceMenu(id, ctx, rerender) {
  const svc = state.services.get(id);
  if (!svc) return;
  const hidden = (state.user?.prefs?.hiddenServices || []).includes(id);
  const actions = [];
  const toggleHide = h(`<button class="btn btn-sm btn-block">${icon('eye')} ${hidden ? 'Show on dashboard' : 'Hide for me'}</button>`);
  toggleHide.addEventListener('click', async () => {
    const cur = new Set(state.user?.prefs?.hiddenServices || []);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    await ctx.savePrefs({ hiddenServices: [...cur] });
    m.close();
    rerender();
  });
  actions.push(toggleHide);
  const effective = serviceUrl(svc);
  if (effective) {
    const copy = h(`<button class="btn btn-sm btn-block">${icon('copy')} Copy URL${isExternal(svc) ? ' (public)' : ''}</button>`);
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(effective); toast('URL copied', 'success'); } catch { toast('Could not copy', 'error'); }
      m.close();
    });
    actions.push(copy);
  }
  if (svc.fallbackUrl) {
    const ext = isExternal(svc);
    actions.unshift(h(`<div class="hint" style="margin:0 0 2px">Local: ${esc(svc.url || '—')}<br>Public: ${esc(svc.fallbackUrl)}${svc.autoSwitch !== false ? ' · auto-switch on' : ' · auto-switch off'}</div>`));
    actions.push(h(`<a class="btn btn-sm btn-block" href="${esc(serviceUrl(svc))}" target="_blank" rel="noopener noreferrer">${icon('globe')} Open ${ext ? 'public' : 'local'} address</a>`));
    const recheck = h(`<button class="btn btn-sm btn-block">${icon('refresh')} Recheck connection</button>`);
    recheck.addEventListener('click', async () => {
      recheck.disabled = true;
      const local = await probeService(svc, { force: true });
      m.close();
      if (local === null) toast('Fallback is not active for this service', 'info');
      else toast(local ? 'Local address is reachable' : 'Local address unreachable — using the public address', local ? 'success' : 'info');
    });
    actions.push(recheck);
  }
  const arrLabel = { sonarr: 'episodes', radarr: 'movies', lidarr: 'albums' }[svc.type];
  if (ctx.runServiceAction && arrLabel) {
    const search = h(`<button class="btn btn-sm btn-block">${icon('search')} Search missing ${arrLabel}</button>`);
    search.addEventListener('click', async () => {
      m.close();
      await ctx.runServiceAction(id, { action: 'missing_search' }, {
        progress: {
          title: `Searching missing ${arrLabel}`,
          detail: 'Asking the service to search for monitored media that is still missing.',
          doneTitle: 'Search started',
          failTitle: 'Search failed',
        },
      });
    });
    actions.push(search);
    const refresh = h(`<button class="btn btn-sm btn-block">${icon('refresh')} Refresh library</button>`);
    refresh.addEventListener('click', async () => {
      m.close();
      await ctx.runServiceAction(id, { action: 'refresh' }, {
        progress: {
          title: 'Refreshing library',
          detail: 'Asking the service to refresh its metadata.',
          doneTitle: 'Refresh started',
          failTitle: 'Refresh failed',
        },
      });
    });
    actions.push(refresh);
  }
  if (ctx.runServiceAction && svc.type === 'wol') {
    const wake = h(`<button class="btn btn-sm btn-block">${icon('zap')} Wake this host</button>`);
    wake.addEventListener('click', async () => {
      m.close();
      await ctx.runServiceAction(id, { action: 'wake' }, {
        progress: {
          title: `Waking ${svc.name}`,
          detail: 'Sending a Wake-on-LAN magic packet.',
          doneTitle: 'Magic packet sent',
          failTitle: 'Wake failed',
        },
      });
    });
    actions.push(wake);
  }
  if (ctx.isAdmin) {
    const edit = h(`<button class="btn btn-sm btn-block">${icon('edit')} Edit service…</button>`);
    edit.addEventListener('click', () => { m.close(); ctx.openAdminServiceEdit(id); });
    actions.push(edit);
  }
  const { modal } = ctx.ui;
  const m = modal({ title: svc.name, body: `<div style="display:flex;flex-direction:column;gap:8px"></div>`, footer: [] });
  const box = m.body.firstElementChild;
  actions.forEach((a) => box.appendChild(a));
}

export function renderServices(body, ctx) {
  const all = ctx.services;
  const prefsHidden = new Set(state.user?.prefs?.hiddenServices || []);
  const shown = all.filter((s) => !prefsHidden.has(s.id));
  const filter = (ctx.filter || '').toLowerCase();
  const order = state.user?.prefs?.serviceOrder || [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const filtered = (filter
    ? shown.filter((s) => s.name.toLowerCase().includes(filter) || (s.url || '').toLowerCase().includes(filter))
    : shown)
    .slice()
    .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9) || a.id - b.id);
  const hiddenCount = all.length - shown.length;

  if (!filtered.length) {
    body.innerHTML = all.length === 0
      ? `<div class="empty">${icon('plug')} No services configured yet.<br>${ctx.isAdmin
        ? '<a class="btn btn-sm" style="margin-top:10px" href="#/settings?tab=services">Add your first service</a>'
        : 'Ask an administrator to add services.'}</div>`
      : `<div class="empty">No services match your search.</div>`;
    return;
  }

  const group = ctx.appearance.groupByCategory !== false && !filter;
  let html = '';
  if (group) {
    const byCat = new Map();
    for (const s of filtered) {
      const cat = s.category || 'Other';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(s);
    }
    for (const [cat, list] of byCat) {
      html += `<div class="section-title">${esc(cat)} <span style="color:var(--faint)">${list.length}</span></div>`;
      html += `<div class="svc-grid">${list.map((s) => svcCardHtml(s, ctx)).join('')}</div>`;
    }
  } else {
    html = `<div class="svc-grid">${filtered.map((s) => svcCardHtml(s, ctx)).join('')}</div>`;
  }
  if (hiddenCount > 0) html += `<div class="section-title" style="margin-top:2px">${hiddenCount} hidden for you</div>`;
  body.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px">${html}</div>`;
  wireServiceCards(body, ctx, () => ctx.rerenderWidget('services'));
}

// ---------------------------------------------------------------- now playing
export function renderNowPlaying(body, ctx) {
  clearInterval(body._npTimer);
  body._npTimer = null;
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [key, clock] of playbackClocks) {
    if (clock.at < cutoff) playbackClocks.delete(key);
  }
  const items = [];
  for (const svc of ctx.services) {
    for (const np of svc.nowPlaying || []) items.push({ svc, np });
  }
  if (!items.length) {
    body.innerHTML = `<div class="empty">${icon('play')} Nothing is playing right now</div>`;
    return;
  }
  const hasUnsupported = items.some(({ svc, np }) => {
    const list = Array.isArray(np.controls) ? np.controls : (svc.type === 'jellyfin' ? ['pause', 'resume', 'stop'] : []);
    return !list.length;
  });
  body.innerHTML = `<div class="rowlist">${items.slice(0, 8).map(({ svc, np }) => {
    const reportedMs = Number.isFinite(Number(np.positionMs)) ? Number(np.positionMs) : (Number(np.position) || 0) * 1000;
    const durMs = (Number(np.duration) || 0) * 1000;
    const reportedAt = Number(np.positionAt) || Number(svc.fetchedAt) || Date.now();
    const reportedRate = Number(np.playbackRate);
    const reportedPaused = !!np.paused || (Number.isFinite(reportedRate) && reportedRate === 0);
    const rate = Number.isFinite(reportedRate) && reportedRate > 0 ? reportedRate : 1;
    const clockKey = `${svc.id}:${np.id || np.title}:${np.title}:${np.duration}`;
    const now = Date.now();
    let clock = playbackClocks.get(clockKey);
    if (!clock) {
      clock = { position: reportedMs, at: reportedAt, paused: reportedPaused, rate, lastReported: reportedMs };
      playbackClocks.set(clockKey, clock);
    } else {
      const estimate = clock.position + (clock.paused ? 0 : Math.max(0, now - clock.at) * clock.rate);
      const changed = Math.abs(reportedMs - (clock.lastReported ?? reportedMs)) > 3000;
      if (reportedPaused) {
        // Freeze at the last trusted position when the client pauses.
        clock.position = reportedMs > 0 ? reportedMs : estimate;
        clock.at = reportedAt;
        clock.paused = true;
        clock.rate = rate;
      } else {
        const wasPaused = clock.paused;
        clock.paused = false;
        clock.rate = rate;
        if (reportedMs > estimate + 1500 || wasPaused || (changed && reportedMs < estimate - 5000)) {
          // The client caught up, resumed, or seeked — trust its position.
          clock.position = reportedMs;
          clock.at = reportedAt;
        }
        // Otherwise a lower report is typically a stale polling value; keep
        // the monotonic estimate so the clock doesn't jump backwards every poll.
      }
      clock.lastReported = reportedMs;
    }
    const paused = clock.paused;
    const liveNow = clock.position + (paused ? 0 : Math.max(0, now - clock.at) * clock.rate);
    const initialShown = durMs > 0 ? Math.min(liveNow, durMs) : liveNow;
    const initialPct = durMs > 0 ? Math.min(100, (initialShown / durMs) * 100) : 0;
    let transcode = '';
    if (np.transcoding) {
      const isDirect = np.transcoding.video === 'direct' && np.transcoding.audio === 'direct';
      const bits = [];
      if (!isDirect) {
        bits.push(`Video: ${esc(np.transcoding.video)}`);
        bits.push(`Audio: ${esc(np.transcoding.audio)}`);
      }
      if (np.transcoding.bitrate) bits.push(`${(np.transcoding.bitrate / 1_000_000).toFixed(1)} Mbit/s`);
      transcode = `<div class="np-transcode ${isDirect ? 'np-direct' : 'np-trans'}">${icon('zap')} ${isDirect ? 'Direct Play' : bits.join(' · ')}</div>`;
    }
    const controlList = Array.isArray(np.controls)
      ? np.controls
      : (svc.type === 'jellyfin' ? ['pause', 'resume', 'stop'] : []);
    const canControl = controlList.length > 0 && np.id && ctx.runServiceAction;
    const controlButtons = [];
    if (canControl) {
      const action = np.paused ? 'resume' : 'pause';
      if (controlList.includes(action)) {
        controlButtons.push(`<button class="icon-btn" data-np="${action}" data-svc="${svc.id}" data-session="${esc(np.id)}" title="${np.paused ? 'Resume' : 'Pause'}" aria-label="${np.paused ? 'Resume' : 'Pause'}">${icon(np.paused ? 'play' : 'pause')}</button>`);
      }
      if (controlList.includes('stop')) {
        controlButtons.push(`<button class="icon-btn" data-np="stop" data-svc="${svc.id}" data-session="${esc(np.id)}" title="Stop playback" aria-label="Stop playback">${icon('x')}</button>`);
      }
    }
    const playerUrl = serviceUrl(svc);
    if (playerUrl) {
      controlButtons.push(`<a class="icon-btn" href="${esc(playerUrl)}" target="_blank" rel="noopener noreferrer" title="${canControl ? 'Open player' : 'Open player — this service does not expose remote playback control'}" aria-label="Open player">${icon('arrow')}</a>`);
    }
    const controls = controlButtons.length ? `<span class="np-ctl">${controlButtons.join('')}</span>` : '';
    return `
    <div class="rowitem np-row" data-np-pos="${clock.position}" data-np-duration="${durMs}" data-np-fetched="${clock.at}" data-np-rate="${clock.rate}" data-np-paused="${paused ? 1 : 0}">
      ${np.art ? `<img class="np-art" src="${esc(proxyArt(svc, np.art))}" alt="">` : `<span class="np-art"></span>`}
      <div class="row-main">
        <div class="row-title">${esc(np.title)}</div>
        <div class="row-sub">${esc(np.subtitle || '')}</div>
        <div class="progress-line" style="margin-top:5px"><div class="progress-fill" style="width:${initialPct.toFixed(2)}%"></div></div>
        ${transcode}
      </div>
      <div style="flex:none;text-align:right;display:flex;flex-direction:column;gap:3px;align-items:flex-end">
        ${controls}
        <span class="np-user">${icon('users')} ${esc(np.user)}${np.device ? ` · ${esc(np.device)}` : ''}</span>
        ${paused ? '<span class="row-badge" style="color:var(--warn)">paused</span>' : ''}
        <span class="row-badge np-time">${durMs > 0 ? `${fmtDuration(initialShown / 1000)} / ${fmtDuration(durMs / 1000)}` : fmtDuration(initialShown / 1000)}</span>
      </div>
    </div>`;
  }).join('')}</div>${hasUnsupported ? '<div class="hint" style="margin-top:8px">Remote play/pause is only available where the player exposes a control API (currently Jellyfin). Use the arrow to open the other players.</div>' : ''}`;
  wireIcons(body);
  body.querySelectorAll('[data-np]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    const res = await ctx.runServiceAction(Number(btn.dataset.svc), { action: btn.dataset.np, value: btn.dataset.session });
    if (res?.ok) setTimeout(() => ctx.rerenderWidget('nowPlaying'), 600);
    else btn.disabled = false;
  }));

  // Live playback clock: the API snapshot is polled every ~15 s; extrapolate
  // the position locally so the current time ticks every second.
  const tick = () => {
    if (!body.isConnected) {
      clearInterval(body._npTimer);
      body._npTimer = null;
      return;
    }
    if (document.hidden) return;
    const now = Date.now();
    body.querySelectorAll('.np-row').forEach((row) => {
      const pos = Number(row.dataset.npPos) || 0;
      const dur = Number(row.dataset.npDuration) || 0;
      const fetched = Number(row.dataset.npFetched) || now;
      const rate = Number(row.dataset.npRate) || 1;
      const paused = row.dataset.npPaused === '1';
      const elapsed = paused ? pos : pos + Math.max(0, now - fetched) * rate;
      const shown = dur > 0 ? Math.min(elapsed, dur) : elapsed;
      const time = row.querySelector('.np-time');
      if (time) {
        time.textContent = dur > 0
          ? `${fmtDuration(shown / 1000)} / ${fmtDuration(dur / 1000)}`
          : fmtDuration(shown / 1000);
      }
      const fill = row.querySelector('.progress-fill');
      if (fill && dur > 0) fill.style.width = `${Math.min(100, (shown / dur) * 100)}%`;
    });
  };
  tick();
  body._npTimer = setInterval(tick, 1000);
}

// ---------------------------------------------------------------- requests
function requestsPageUrl(svc, filter = 'all') {
  const base = serviceUrl(svc);
  if (!base) return '';
  const suffix = filter && filter !== 'all' ? `?filter=${encodeURIComponent(filter)}` : '';
  return `${base.replace(/\/+$/, '')}/requests${suffix}`;
}

function requestTone(status) {
  if (status === 'available') return 'ok';
  if (status === 'approved') return 'ok';
  if (status === 'pending' || status === 'processing') return 'warn';
  if (status === 'declined' || status === 'failed') return 'bad';
  return '';
}

export function renderRequests(body, ctx) {
  const services = (ctx.services || []).filter((s) => s.type === 'seerr' || s.type === 'overseerr' || s.type === 'jellyseerr');
  if (!services.length) {
    body.innerHTML = emptyWidget('Requests', 'requests');
    return;
  }

  const sections = services.map((svc) => {
    if (!svc.online) return offlineHtml(svc, true);
    const counts = svc.requestCounts || {};
    const open = Number(counts.open) || 0;
    const approved = Number(counts.approved) || 0;
    const available = Number(counts.available) || 0;
    const requests = Array.isArray(svc.requests) ? svc.requests.slice(0, 6) : [];
    const chips = [
      ['pending', 'Open', open],
      ['approved', 'Approved', approved],
      ['available', 'Available', available],
    ].map(([key, label, value]) => `
      <a class="chip" href="${esc(requestsPageUrl(svc, key))}" target="_blank" rel="noopener noreferrer"
         title="Open ${esc(label.toLowerCase())} requests in ${esc(svc.name)}">
        <span class="chip-l">${esc(label)}</span><span class="chip-v">${value}</span>
      </a>`).join('');

    const rows = requests.map((r) => {
      const status = String(r.status || 'unknown');
      const tone = requestTone(status);
      const poster = r.poster ? proxyArt(svc, r.poster) : '';
      const link = requestsPageUrl(svc, r.filter || 'all');
      const actions = ctx.isAdmin && ctx.runServiceAction && status === 'pending'
        ? `<button class="icon-btn" data-req-action="approve_request" data-req-id="${esc(r.id)}"
             data-req-svc="${svc.id}" title="Approve request" aria-label="Approve request">${icon('check')}</button>
           <button class="icon-btn" data-req-action="decline_request" data-req-id="${esc(r.id)}"
             data-req-svc="${svc.id}" title="Decline request" aria-label="Decline request">${icon('x')}</button>`
        : '';
      return `
        <div class="rowitem req-row">
          ${poster
            ? `<img class="req-poster" src="${esc(poster)}" alt="" loading="lazy">`
            : `<span class="req-poster req-poster-empty">${icon('film')}</span>`}
          <div class="row-main">
            <div class="row-title">${esc(r.title)} <span class="row-badge req-status req-status-${esc(tone)}">${esc(r.statusLabel || status)}</span></div>
            <div class="row-sub">${esc(r.user || 'Unknown user')}${r.subtitle ? ' · ' + esc(r.subtitle) : ''}</div>
          </div>
          <div class="req-actions">
            ${actions}
            ${link ? `<a class="icon-btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer"
              title="Open request in ${esc(svc.name)}" aria-label="Open request in ${esc(svc.name)}">${icon('arrow')}</a>` : ''}
          </div>
        </div>`;
    }).join('');

    return `<div class="req-section">
      <div class="rowitem" style="margin-bottom:7px">
        <span class="row-title">${statusDot(true)} ${esc(svc.name)}</span>
        <a class="btn btn-sm btn-ghost" href="${esc(requestsPageUrl(svc, 'all'))}" target="_blank" rel="noopener noreferrer">
          ${icon('arrow')} Requests
        </a>
      </div>
      <div class="chips req-counts">${chips}</div>
      <div class="rowlist">${rows || '<div class="row-sub" style="padding:3px 0">No requests</div>'}</div>
      ${updatedTag(svc)}
    </div>`;
  }).join('');

  body.innerHTML = sections;
  body.querySelectorAll('[data-req-action]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    const res = await ctx.runServiceAction(Number(btn.dataset.reqSvc), {
      action: btn.dataset.reqAction,
      value: btn.dataset.reqId,
    });
    if (res?.ok) setTimeout(() => ctx.rerenderWidget('requests'), 600);
    else btn.disabled = false;
  }));
}

// ---------------------------------------------------------------- downloads
const speedHistory = new Map(); // svcId -> number[]

function sabControls(svc, ctx, paused) {
  const act = (action, label, ic) => `<button class="icon-btn" data-sab="${action}" data-svc="${svc.id}" title="${label}">${icon(ic)}</button>`;
  return `<span class="sab-ctl" style="display:inline-flex;gap:2px;margin-left:8px">
    ${paused
      ? act('resume', 'Resume queue', 'play')
      : act('pause', 'Pause queue', 'pause')}
  </span>`;
}

export function renderDownloads(body, ctx) {
  const dlServices = ctx.services.filter((s) => (s.activity || []).length || s.charts?.downloads || s.history?.length);
  if (!dlServices.length) {
    body.innerHTML = `<div class="empty">No active downloads</div>`;
    return;
  }
  let html = '<div class="rowlist">';
  for (const svc of dlServices) {
    const d = svc.charts?.downloads;
    const paused = !!d?.paused;
    html += `<div class="section-title" style="margin:2px 0 0">${statusDot(true)} ${esc(svc.name)}
      ${svc.type === 'sabnzbd' && ctx.runServiceAction ? sabControls(svc, ctx, paused) : ''}
      ${d ? `<span style="letter-spacing:0;text-transform:none;color:var(--accent);font-weight:650">${d.paused ? 'paused' : fmtBytes(d.speedBps) + '/s'}</span>` : ''}
      ${d && !d.paused ? sparkHtml(svc, d) : ''}</div>`;
    const items = [...(svc.activity || [])].slice(0, 6);
    if (d && svc.history?.length) html += histRow(svc);
    for (const a of items) {
      const slotCtl = svc.type === 'sabnzbd' && a.id && ctx.runServiceAction
        ? `<button class="icon-btn slot-ctl" data-slot="${a.paused ? 'slot_resume' : 'slot_pause'}" data-svc="${svc.id}" data-nzo="${esc(a.id)}" title="${a.paused ? 'Resume download' : 'Pause download'}">${icon(a.paused ? 'play' : 'pause')}</button>`
        : '';
      html += `<div class="rowitem">
        <div class="row-main">
          <div class="row-title" title="${esc(a.title)}">${esc(a.title)}</div>
          <div class="row-sub">${esc(a.subtitle || '')}${a.meta ? ' · ' + esc(a.meta) : ''}</div>
          <div class="progress-line" style="margin-top:4px"><div class="progress-fill" style="width:${esc(a.progress || 0)}%"></div></div>
        </div>
        ${slotCtl}
        <span class="row-badge">${esc(a.progress ?? 0)}%</span>
      </div>`;
    }
    if (!items.length && !svc.history?.length) html += `<div class="row-sub" style="padding:2px 0 4px">Queue is empty</div>`;
  }
  body.innerHTML = html + '</div>';

  body.querySelectorAll('[data-sab], [data-slot]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const svcId = Number(btn.dataset.svc);
      const action = btn.dataset.sab || btn.dataset.slot;
      const value = btn.dataset.nzo;
      btn.disabled = true;
      const res = await ctx.runServiceAction(svcId, { action, value });
      if (res?.ok) {
        // the action triggers an immediate re-poll → SSE refreshes this widget
        setTimeout(() => ctx.rerenderWidget('downloads'), 600);
      }
    });
  });
}

function sparkHtml(svc, d) {
  const arr = speedHistory.get(svc.id) || [];
  arr.push(d.speedBps);
  if (arr.length > 60) arr.shift();
  speedHistory.set(svc.id, arr);
  return `<span style="margin-left:auto">${sparkline({ values: arr, width: 90, height: 22, color: 'var(--accent)' })}</span>`;
}

function histRow(svc) {
  const done = (svc.history || []).filter((x) => x.state === 'done').length;
  const failed = (svc.history || []).filter((x) => x.state === 'failed').length;
  return `<div class="row-sub" style="margin:-2px 0 2px">Recent: ${done} completed${failed ? `, <span style="color:var(--bad)">${failed} failed</span>` : ''}</div>`;
}

// ---------------------------------------------------------------- pihole
export function renderPihole(body, ctx) {
  const svc = ctx.services.find((s) => s.type === 'pihole');
  if (!svc) { body.innerHTML = emptyWidget('Pi-hole', 'pihole'); return; }
  if (!svc.online) { body.innerHTML = offlineHtml(svc); return; }
  const get = (label) => statValue(svc, label);
  const blockedPct = parseFloat(get('Blocked %')) || 0;
  const series = (svc.charts?.pihole?.series || []);
  const points = series.map((p) => p.queries);
  const blockedPts = series.map((p) => p.blocked);
  const labels = series.length ? [
    new Date(series[0].t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    new Date(series[series.length - 1].t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  ] : [];
  body.innerHTML = `
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      ${donut({ value: blockedPct, size: 96, thickness: 11, label: blockedPct.toFixed(1) + '%', sub: 'blocked' })}
      <div class="stat-tiles" style="flex:1;min-width:170px">
        <div class="stat-tile"><div class="v">${fmtNum(get('Queries today'))}</div><div class="l">Queries</div></div>
        <div class="stat-tile"><div class="v" style="color:var(--bad)">${fmtNum(get('Blocked'))}</div><div class="l">Blocked</div></div>
        <div class="stat-tile"><div class="v">${fmtNum(get('Clients'))}</div><div class="l">Clients</div></div>
        <div class="stat-tile"><div class="v">${fmtNum(get('Blocklist'))}</div><div class="l">Domains</div></div>
      </div>
    </div>
    ${points.length ? `<div class="pihole-chart" tabindex="0" role="group" aria-label="Pi-hole query graph. Use the arrow keys to inspect values." title="Hover, tap or use arrow keys for exact values">${areaChart({
      width: 460, height: 90,
      series: [
        { points, color: 'var(--accent)', label: 'Queries' },
        { points: blockedPts, color: 'var(--bad)', label: 'Blocked' },
      ],
      labels,
    })}<div class="chart-crosshair" hidden></div><div class="chart-tip" hidden></div></div>` : ''}`;

  const chartBox = body.querySelector('.pihole-chart');
  if (!chartBox) return;
  const svg = chartBox.querySelector('svg');
  const tip = chartBox.querySelector('.chart-tip');
  const cross = chartBox.querySelector('.chart-crosshair');
  if (!svg || !tip || !cross) return;

  let keyIndex = 0;
  const hide = () => { tip.hidden = true; cross.hidden = true; };
  const showAt = (clientX, clientY) => {
    const chartRect = chartBox.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    if (!svgRect.width || !series.length) return;
    const frac = Math.min(1, Math.max(0, (clientX - svgRect.left) / svgRect.width));
    const index = Math.round(frac * Math.max(0, series.length - 1));
    keyIndex = index;
    const p = series[index];
    if (!p) return;
    const time = p.t ? new Date(p.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    tip.innerHTML = `${time ? `<div class="ct-time">${esc(time)}</div>` : ''}
      <div class="ct-row"><i style="background:var(--accent)"></i>Queries <b>${esc(fmtNum(p.queries))}</b></div>
      <div class="ct-row"><i style="background:var(--bad)"></i>Blocked <b>${esc(fmtNum(p.blocked))}</b></div>`;
    tip.hidden = false;
    cross.hidden = false;
    const tipWidth = tip.offsetWidth || 150;
    const tipHeight = tip.offsetHeight || 54;
    cross.style.left = `${clientX - chartRect.left}px`;
    cross.style.top = `${svgRect.top - chartRect.top}px`;
    cross.style.height = `${svgRect.height}px`;
    tip.style.left = `${Math.min(chartRect.width - tipWidth - 4, Math.max(4, clientX - chartRect.left + 14))}px`;
    tip.style.top = `${Math.min(chartRect.height - tipHeight - 4, Math.max(4, clientY - chartRect.top - 46))}px`;
  };

  let hideTimer = null;
  svg.addEventListener('pointermove', (e) => { clearTimeout(hideTimer); showAt(e.clientX, e.clientY); });
  svg.addEventListener('pointerdown', (e) => { clearTimeout(hideTimer); showAt(e.clientX, e.clientY); });
  svg.addEventListener('pointerup', () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 2500); });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('pointercancel', hide);
  chartBox.addEventListener('blur', hide);
  chartBox.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !series.length) return;
    e.preventDefault();
    const last = series.length - 1;
    if (e.key === 'ArrowLeft') keyIndex = Math.max(0, keyIndex - 1);
    else if (e.key === 'ArrowRight') keyIndex = Math.min(last, keyIndex + 1);
    else keyIndex = e.key === 'Home' ? 0 : last;
    const rect = svg.getBoundingClientRect();
    showAt(rect.left + (last ? keyIndex / last : 0) * rect.width, rect.top + rect.height / 2);
  });
}

// ---------------------------------------------------------------- host system
export function renderHost(body, ctx) {
  const svc = ctx.services.find((s) => s.type === 'host');
  if (!svc) { body.innerHTML = emptyWidget('Host system', 'chart'); return; }
  if (!svc.online) { body.innerHTML = offlineHtml(svc); return; }
  const get = (label) => statValue(svc, label);
  const charts = svc.charts?.host || {};
  const tile = (label, value) => `<div class="stat-tile"><div class="v">${esc(value ?? 'n/a')}</div><div class="l">${esc(label)}</div></div>`;
  const spark = (label, values, color) => {
    const svg = sparkline({ values: (values || []).slice(-32), width: 190, height: 36, color });
    return `<div style="min-width:0"><div class="row-sub">${esc(label)}</div>${svg || '<div class="chart-empty" style="padding:8px 0">Collecting…</div>'}</div>`;
  };
  const hints = Array.isArray(svc.hints) ? svc.hints : [];
  body.innerHTML = `
    <div class="stat-tiles">
      ${tile('CPU', get('CPU'))}
      ${tile('RAM', get('RAM'))}
      ${get('Swap') ? tile('Swap', get('Swap')) : ''}
      ${tile('Temp', get('Temp'))}
    </div>
    <div class="rowlist" style="margin-top:8px">
      <div class="rowitem"><span class="row-sub" style="flex:1">Uptime</span><b>${esc(get('Uptime') || 'n/a')}</b></div>
      <div class="rowitem"><span class="row-sub" style="flex:1">Load</span><b>${esc(get('Load') || 'n/a')}</b></div>
      <div class="rowitem"><span class="row-sub" style="flex:1">Network</span><b>↓ ${esc(get('Net down') || '0')} · ↑ ${esc(get('Net up') || '0')}</b></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px">
      ${spark('CPU %', charts.cpu, 'var(--accent)')}
      ${spark('RAM %', charts.mem, 'var(--ok)')}
      ${spark('Net down', charts.netRx, 'var(--accent2, var(--accent))')}
      ${spark('Net up', charts.netTx, 'var(--bad)')}
    </div>
    ${hints.map((hint) => `<div class="hint" style="margin-top:8px">${icon('zap')} ${esc(hint)}</div>`).join('')}`;
}

// ---------------------------------------------------------------- history
const HISTORY_RANGES = ['24h', '7d', '30d'];

function historyRangeButtons(active) {
  return `<span class="range-btns">${HISTORY_RANGES.map((range) => `<button class="btn btn-sm ${range === active ? 'btn-primary' : ''}" data-range="${range}">${range}</button>`).join('')}</span>`;
}

function historyTime(ts) {
  try {
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' });
  } catch {
    return '';
  }
}

export function renderHistory(body, ctx) {
  const targets = [];
  const host = ctx.services.find((s) => s.type === 'host');
  const pihole = ctx.services.find((s) => s.type === 'pihole');
  const sab = ctx.services.find((s) => s.type === 'sabnzbd');
  if (host) {
    targets.push({ svc: host, metric: 'cpu', label: 'Host CPU %' });
    targets.push({ svc: host, metric: 'ram', label: 'Host RAM %' });
  }
  if (pihole) targets.push({ svc: pihole, metric: 'pihole_rate', label: 'Pi-hole blocked %' });
  if (sab) targets.push({ svc: sab, metric: 'download_speed', label: 'Download speed' });
  if (!targets.length) { body.innerHTML = emptyWidget('Long-term history', 'chart'); return; }

  let range = '24h';
  body.innerHTML = `
    <div class="rowitem" style="margin-bottom:8px"><span class="row-sub" style="flex:1">Range</span>${historyRangeButtons(range)}</div>
    <div class="history-grid">
      ${targets.map((target, i) => `<div class="history-cell">
        <div class="row-sub">${esc(target.label)}</div>
        <div data-hist="${i}"><div class="chart-empty">Loading…</div></div>
      </div>`).join('')}
    </div>`;

  const paint = async () => {
    body.querySelectorAll('[data-range]').forEach((btn) => {
      btn.classList.toggle('btn-primary', btn.dataset.range === range);
    });
    await Promise.all(targets.map(async (target, i) => {
      const cell = body.querySelector(`[data-hist="${i}"]`);
      try {
        const res = await API.history(target.svc.id, target.metric, range);
        const points = res?.points || [];
        if (!cell) return;
        if (points.length < 2) {
          cell.innerHTML = '<div class="chart-empty">Collecting history…</div>';
          return;
        }
        cell.innerHTML = areaChart({
          width: 460,
          height: 78,
          series: [{ points: points.map((p) => p.v), color: 'var(--accent)' }],
          labels: [historyTime(points[0].t), historyTime(points[points.length - 1].t)],
        });
      } catch (err) {
        if (cell) cell.innerHTML = `<div class="chart-empty">${esc(err.message)}</div>`;
      }
    }));
  };
  body.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => { range = btn.dataset.range; paint(); });
  });
  paint();
}

// ---------------------------------------------------------------- uptime + SSL
export function renderUptime(body, ctx) {
  if (!ctx.services.length) { body.innerHTML = emptyWidget('Uptime & SSL', 'shield'); return; }
  let range = '24h';
  body.innerHTML = `
    <div class="rowitem" style="margin-bottom:8px"><span class="row-sub" style="flex:1">Range</span>${historyRangeButtons(range)}</div>
    <div data-uptime-list class="rowlist"><div class="chart-empty">Loading…</div></div>`;

  const paint = async () => {
    body.querySelectorAll('[data-range]').forEach((btn) => {
      btn.classList.toggle('btn-primary', btn.dataset.range === range);
    });
    try {
      const res = await API.uptime(range);
      const byId = new Map((res?.services || []).map((entry) => [entry.id, entry]));
      const list = body.querySelector('[data-uptime-list]');
      if (!list) return;
      list.innerHTML = ctx.services.map((svc) => {
        const entry = byId.get(svc.id) || {};
        const pct = entry.pct == null ? null : Number(entry.pct);
        const pctLabel = pct == null ? '–' : `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`;
        const tone = pct == null ? 'var(--faint)' : pct >= 99 ? 'var(--ok)' : pct >= 95 ? 'var(--warn)' : 'var(--bad)';
        const ssl = svc.ssl;
        const sslLabel = ssl ? (ssl.error ? 'SSL error' : ssl.daysLeft != null ? `SSL ${ssl.daysLeft}d` : 'SSL –') : '';
        const sslTone = !ssl ? 'var(--faint)'
          : ssl.error ? 'var(--bad)'
            : ssl.daysLeft == null ? 'var(--faint)'
              : ssl.daysLeft <= 7 ? 'var(--bad)' : ssl.daysLeft <= 30 ? 'var(--warn)' : 'var(--ok)';
        const bars = (entry.timeline || []).map((point) => {
          const color = point.pct == null ? 'var(--line)' : point.pct >= 99 ? 'var(--ok)' : point.pct >= 95 ? 'var(--warn)' : 'var(--bad)';
          return `<i style="background:${color}"></i>`;
        }).join('') || '<i style="background:var(--line)"></i>';
        return `<div class="uptime-row">
          <div class="rowitem">
            <span class="row-sub" style="flex:1">${esc(svc.name)}</span>
            ${sslLabel ? `<span class="row-badge" style="color:${sslTone}" title="${esc(ssl.host || '')}">${esc(sslLabel)}</span>` : ''}
            <b style="color:${tone};font-variant-numeric:tabular-nums">${esc(pctLabel)}</b>
          </div>
          <div class="uptime-bar" title="${range}">${bars}</div>
        </div>`;
      }).join('');
    } catch (err) {
      const list = body.querySelector('[data-uptime-list]');
      if (list) list.innerHTML = `<div class="chart-empty">${esc(err.message)}</div>`;
    }
  };
  body.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => { range = btn.dataset.range; paint(); });
  });
  paint();
}

// ---------------------------------------------------------------- disks
export function renderDisks(body, ctx) {
  // several *arr apps often share the same physical disks — show each mount once
  const seen = new Set();
  const disks = [];
  for (const svc of ctx.services) {
    for (const d of svc.charts?.disks || []) {
      const key = `${d.label}|${d.totalGB}`;
      if (seen.has(key)) continue;
      seen.add(key);
      disks.push({ ...d, svc });
    }
  }
  if (!disks.length) { body.innerHTML = emptyWidget('Disk space', 'disks'); return; }
  body.innerHTML = `<div class="rowlist">${disks.map((d) => {
    const p = d.totalGB > 0 ? Math.round((d.usedGB / d.totalGB) * 100) : 0;
    const freeGB = d.freeGB != null ? d.freeGB : Math.max(0, (d.totalGB || 0) - (d.usedGB || 0));
    const tone = p > 90 ? 'var(--bad)' : p > 75 ? 'var(--warn)' : 'var(--ok)';
    return `<div>
      <div class="rowitem" style="margin-bottom:4px">
        <span class="row-sub" style="flex:1" title="${esc(d.label)}">${esc(d.label)}</span>
        <span class="row-sub">${fmtVol(d.usedGB)} / ${fmtVol(d.totalGB)} · <b style="color:${tone}">${p}%</b></span>
      </div>
      <div class="progress-line" style="height:8px"><div class="progress-fill ${p > 90 ? 'failed' : ''}" style="width:${p}%"></div></div>
      <div class="row-sub" style="margin-top:4px">${fmtVol(freeGB)} free</div>
    </div>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------- indexers
export function renderIndexers(body, ctx) {
  const prow = ctx.services.filter((s) => s.type === 'prowlarr' || s.type === 'nzbhydra');
  const active = prow.filter((s) => s.online);
  if (!prow.length) { body.innerHTML = emptyWidget('Prowlarr / NZBHydra', 'indexers'); return; }
  body.innerHTML = active.map((svc) => {
    const bars = (svc.charts?.bars || []);
    return `<div style="margin-bottom:${bars.length ? 14 : 6}px">
      <div class="rowitem" style="margin-bottom:6px"><span class="row-title">${statusDot(true)} ${esc(svc.name)}</span></div>
      <div class="chips">${(svc.stats || []).map(statChip).join('')}</div>
      ${bars.length ? `<div style="margin-top:10px">${barsChart({ items: bars })}</div>` : ''}
    </div>`;
  }).join('') + prow.filter((s) => !s.online).map((s) => offlineHtml(s, true)).join('');
}

// ---------------------------------------------------------------- docker
export function renderDocker(body, ctx) {
  let svc = ctx.services.find((s) => s.type === 'docker');
  // no socket-based docker service (or it's down)? fall back to the Unraid API
  if ((!svc || !svc.online) && !(svc?.containers?.length)) {
    const unraid = ctx.services.find((s) => s.type === 'unraid' && s.containers?.length);
    if (unraid) svc = unraid;
  }
  if (!svc) { body.innerHTML = emptyWidget('Docker socket', 'docker'); return; }
  if (!svc.online) { body.innerHTML = offlineHtml(svc); return; }
  const d = svc.charts?.docker || {};
  const base = svc.containers || [];
  // Unraid is the source of WebUI links and update info (containers matched by name).
  const unraid = ctx.services.find((s) => s.type === 'unraid' && s.online && (s.containers || []).length);
  const meta = unraid ? new Map(unraid.containers.map((c) => [c.name, c])) : null;
  let containers = base;
  if (meta && svc.type !== 'unraid') {
    containers = base.map((c) => {
      const m = meta.get(c.name);
      if (!m) return c;
      return {
        ...c,
        url: c.url || m.url || '',
        id: c.id || m.id || '',
        update: !!(c.update || m.update),
        icon: c.icon || m.icon || '',
        actionServiceId: unraid.id,
      };
    });
  }
  const updateSvc = svc.type === 'unraid' ? svc : unraid;
  const updateCount = containers.filter((c) => c.update).length;
  const runningCount = d.running ?? containers.filter((c) => c.state === 'running').length;
  const stoppedCount = d.stopped ?? containers.filter((c) => c.state !== 'running').length;
  const unhealthy = containers.filter((c) => c.state === 'unhealthy' || /unhealthy/i.test(c.status || '')).length;

  const containerHtml = (c) => {
    const running = c.state === 'running';
    const state = running ? 'dot-ok' : c.state === 'unhealthy' ? 'dot-warn' : 'dot-bad';
    const stateKey = running ? 'ok' : c.state === 'unhealthy' ? 'warn' : 'off';
    const metaText = [c.image, c.status || c.state].filter(Boolean).join(' · ');
    const title = [metaText, c.url ? 'open WebUI' : '', c.update ? 'update available' : ''].filter(Boolean).join(' — ') || c.name;
    const name = c.url
      ? `<a class="dc-name" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.name)}</a>`
      : `<span class="dc-name">${esc(c.name)}</span>`;
    const actionSvc = c.actionServiceId || updateSvc?.id;
    const iconSrc = c.icon || '';
    const iconFallback = c.iconFallback || '';
    const tile = `<span class="ci-icon${iconSrc ? ' has-img' : ''}">
      <span class="ci-glyph">${icon('cube')}</span>
      ${iconSrc ? `<img class="ci-img" src="${esc(iconSrc)}"${iconFallback ? ` data-fallback="${esc(iconFallback)}"` : ''} alt="" loading="lazy">` : ''}
    </span>`;
    const actions = [
      c.update && c.id && actionSvc
        ? `<button class="btn btn-sm btn-primary" data-update="${esc(c.id)}" data-svc="${actionSvc}" title="Update ${esc(c.name)}">${icon('download')} Update</button>`
        : '',
      c.id && running
        ? `<button class="btn btn-sm" data-docker="restart" data-id="${esc(c.id)}" data-svc="${svc.id}" title="Restart ${esc(c.name)}">${icon('refresh')} Restart</button>`
        : '',
      c.id && !running
        ? `<button class="btn btn-sm" data-docker="start" data-id="${esc(c.id)}" data-svc="${svc.id}" title="Start ${esc(c.name)}">${icon('play')} Start</button>`
        : '',
      c.id && running
        ? `<button class="btn btn-sm btn-danger" data-docker="stop" data-id="${esc(c.id)}" data-svc="${svc.id}" title="Stop ${esc(c.name)}">${icon('x')} Stop</button>`
        : '',
      c.url
        ? `<a class="btn btn-sm btn-ghost" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(c.name)} WebUI">${icon('arrow')} Open</a>`
        : '',
    ].filter(Boolean).join('');
    return `<div class="docker-card" data-state="${stateKey}" title="${esc(title)}">
      <div class="dc-top">
        ${tile}
        <div class="dc-main">
          <div class="dc-title">${name}<span class="dot ${state}"></span></div>
          <div class="dc-meta">${esc(metaText || c.state || '')}</div>
        </div>
      </div>
      <div class="dc-actions">${actions}</div>
    </div>`;
  };

  body.innerHTML = `
    ${svc.stale ? `<div class="np-transcode np-trans" style="margin-bottom:8px">${icon('zap')} Verbindungsproblem — Daten evtl. veraltet</div>` : ''}
    <div class="docker-summary" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      ${multiDonut({
        size: 96, thickness: 11,
        segments: [
          { value: runningCount || 0, color: 'var(--ok)' },
          { value: unhealthy || 0, color: 'var(--warn)' },
          { value: Math.max(0, stoppedCount - unhealthy) || 0, color: 'var(--faint)' },
        ],
        label: String(runningCount || 0), sub: 'running',
      })}
      <div class="chips">
        <span class="chip chip-em"><span class="chip-l">Containers</span><span class="chip-v">${esc(containers.length)}</span></span>
        <span class="chip chip-ok"><span class="chip-l">Running</span><span class="chip-v">${esc(runningCount)}</span></span>
        ${stoppedCount ? `<span class="chip chip-bad"><span class="chip-l">Stopped</span><span class="chip-v">${esc(stoppedCount)}</span></span>` : ''}
      </div>
    </div>
    ${updateCount && updateSvc ? `<div class="docker-update-bar">
      <span>${icon('refresh')} ${updateCount} update${updateCount === 1 ? '' : 's'} available</span>
      <button class="btn btn-primary btn-sm" data-update-all="${updateSvc.id}">${icon('refresh')} Update all</button>
    </div>` : ''}
    <div class="container-scroll">
      <div class="health-grid docker-grid">${containers.map(containerHtml).join('')}</div>
    </div>
    ${updatedTag(svc)}`;

  wireIcons(body);
  body.querySelectorAll('[data-update]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    btn.classList.add('loading');
    const card = btn.closest('.docker-card');
    const name = card?.querySelector('.dc-name')?.textContent?.trim() || 'container';
    card?.classList.add('busy');
    if (card) card.dataset.busyLabel = 'UPDATING';
    const res = await ctx.runServiceAction(
      Number(btn.dataset.svc),
      { action: 'update', value: btn.dataset.update },
      {
        progress: {
          title: `Updating ${name}`,
          detail: 'Pulling the image and recreating the container. This can take a few minutes — keep this tab open.',
          doneTitle: 'Update complete',
          failTitle: 'Update failed',
        },
      },
    );
    card?.classList.remove('busy');
    if (!res?.ok) {
      btn.disabled = false;
      btn.classList.remove('loading');
      if (card) {
        card.dataset.busyLabel = '';
        card.classList.add('is-failed');
        setTimeout(() => card.classList.remove('is-failed'), 3200);
      }
    } else {
      if (card) card.dataset.doneLabel = 'UPDATED';
      card?.classList.add('is-updated');
      setTimeout(() => card?.classList.remove('is-updated'), 2600);
      setTimeout(() => ctx.rerenderWidget('docker'), 900);
    }
  }));
  const allBtn = body.querySelector('[data-update-all]');
  if (allBtn) allBtn.addEventListener('click', async () => {
    allBtn.disabled = true;
    const res = await ctx.runServiceAction(
      Number(allBtn.dataset.updateAll),
      { action: 'update-all' },
      {
        progress: {
          title: 'Updating all containers',
          detail: 'Unraid is pulling images and recreating containers. This can take several minutes — keep this tab open.',
          doneTitle: 'All containers updated',
          failTitle: 'Update all failed',
        },
      },
    );
    if (!res?.ok) allBtn.disabled = false;
  });
  body.querySelectorAll('[data-docker]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const action = btn.dataset.docker;
    const card = btn.closest('.docker-card');
    const name = card?.querySelector('.dc-name')?.textContent || 'container';
    if (action === 'stop' && ctx.confirm && !(await ctx.confirm(`Stop “${name}”? The container will be shut down.`, { danger: true, okLabel: 'Stop' }))) return;
    const buttons = card ? [...card.querySelectorAll('button')] : [btn];
    buttons.forEach((b) => { b.disabled = true; });
    card?.classList.add('busy');
    const verb = {
      restart: ['Restarting', 'Restart complete'],
      stop: ['Stopping', 'Stopped'],
      start: ['Starting', 'Started'],
    }[action] || ['Working', 'Done'];
    if (card) card.dataset.busyLabel = verb[0].toUpperCase();
    const res = await ctx.runServiceAction(
      Number(btn.dataset.svc),
      { action, value: btn.dataset.id },
      {
        progress: {
          title: `${verb[0]} ${name}`,
          detail: action === 'restart'
            ? 'Stopping and starting the container…'
            : action === 'stop'
              ? 'Shutting down the container…'
              : 'Starting the container…',
          doneTitle: verb[1],
          failTitle: `${verb[0]} failed`,
        },
      },
    );
    card?.classList.remove('busy');
    if (!res?.ok) {
      buttons.forEach((b) => { b.disabled = false; });
      if (card) {
        card.dataset.busyLabel = '';
        card.classList.add('is-failed');
        setTimeout(() => card.classList.remove('is-failed'), 3200);
      }
    } else {
      if (card) card.dataset.doneLabel = action === 'restart' ? 'RESTARTED' : verb[1].toUpperCase();
      card?.classList.add('is-updated');
      setTimeout(() => card?.classList.remove('is-updated'), 2600);
      setTimeout(() => ctx.rerenderWidget('docker'), 900);
    }
  }));
}

// ---------------------------------------------------------------- nextcloud
export function renderNextcloud(body, ctx) {
  const svc = ctx.services.find((s) => s.type === 'nextcloud');
  if (!svc) { body.innerHTML = emptyWidget('Nextcloud', 'nextcloud'); return; }
  if (!svc.online) { body.innerHTML = offlineHtml(svc); return; }
  const get = (label) => statValue(svc, label);
  const fmtStat = (v) => (v == null ? '–' : fmtNum(v));
  const cap = (svc.charts?.disks || [])[0];
  const pct = cap && cap.totalGB > 0 ? Math.round((cap.usedGB / cap.totalGB) * 100) : 0;
  const free = cap ? (cap.freeGB != null ? cap.freeGB : Math.max(0, cap.totalGB - cap.usedGB)) : null;
  const tone = pct > 90 ? 'var(--bad)' : pct > 75 ? 'var(--warn)' : 'var(--ok)';
  const cpu = get('CPU load') ?? get('CPU');
  const ram = get('RAM');
  const freeSpace = get('Free space');
  body.innerHTML = `
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      ${cap ? donut({ value: pct, size: 96, thickness: 11, color: pct > 90 ? 'var(--bad)' : 'var(--accent)', label: pct + '%', sub: 'used' }) : ''}
      <div class="stat-tiles" style="flex:1;min-width:170px">
        <div class="stat-tile"><div class="v">${esc(fmtStat(get('Files')))}</div><div class="l">Files</div></div>
        <div class="stat-tile"><div class="v">${esc(fmtStat(get('Users')))}</div><div class="l">Users</div></div>
        <div class="stat-tile"><div class="v">${esc(fmtStat(get('Shares')))}</div><div class="l">Shares</div></div>
        <div class="stat-tile"><div class="v">${esc(cpu ?? '–')}</div><div class="l">CPU load</div></div>
      </div>
    </div>
    ${cap ? `<div style="margin-top:12px">
      <div class="rowitem" style="margin-bottom:4px">
        <span class="row-sub" style="flex:1">Storage</span>
        <span class="row-sub">${fmtVol(cap.usedGB)} / ${fmtVol(cap.totalGB)} · <b style="color:${tone}">${pct}%</b></span>
      </div>
      <div class="progress-line" style="height:8px"><div class="progress-fill ${pct > 90 ? 'failed' : ''}" style="width:${pct}%"></div></div>
      <div class="row-sub" style="margin-top:4px">${fmtVol(free)} free</div>
    </div>` : ''}
    ${(ram != null || freeSpace) ? `<div class="chips" style="margin-top:10px">
      ${ram != null ? `<span class="chip"><span class="chip-l">RAM</span><span class="chip-v">${esc(ram)}</span></span>` : ''}
      ${freeSpace ? `<span class="chip"><span class="chip-l">Free space</span><span class="chip-v">${esc(freeSpace)}</span></span>` : ''}
    </div>` : ''}
    ${updatedTag(svc)}`;
}

// ---------------------------------------------------------------- health
export function renderHealth(body, ctx) {
  if (!ctx.services.length) { body.innerHTML = `<div class="empty">No services</div>`; return; }
  body.innerHTML = `<div class="health-grid">${ctx.services.map((s) => {
    const external = isExternal(s);
    const remote = external ? ' · public address' : '';
    return `
    <a class="health-item${external ? ' is-remote' : ''}" href="${serviceUrl(s) ? esc(serviceUrl(s)) : '#'}" target="_blank" rel="noopener noreferrer" title="${s.stale ? 'Daten veraltet: ' + esc(s.error || '') : s.online ? `Updated ${new Date(s.fetchedAt || 0).toLocaleTimeString()}` : esc(s.error || 'Offline')}${remote}">
      ${statusDot(s.online, s.stale ? 'dot-warn' : '')}<span>${esc(s.name)}</span>${external ? `<span class="svc-remote">${icon('globe')}</span>` : ''}
    </a>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------- calendar
export function renderCalendar(body, ctx) {
  const items = [];
  for (const svc of ctx.services) {
    for (const ev of svc.calendar || []) items.push({ svc, ev });
  }
  items.sort((a, b) => new Date(a.ev.date || 0) - new Date(b.ev.date || 0));
  if (!items.length) { body.innerHTML = emptyWidget('Sonarr / Radarr / Lidarr', 'calendar'); return; }
  const byDay = new Map();
  for (const it of items) {
    const day = it.ev.date ? new Date(it.ev.date) : null;
    const key = day ? day.toDateString() : 'unknown';
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(it);
  }
  let html = '<div class="rowlist">';
  const today = new Date().toDateString();
  for (const [day, list] of byDay) {
    const d = new Date(day);
    const dayLabel = day === 'unknown' ? 'Unknown'
      : d.toDateString() === today ? 'Today'
      : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    html += `<div class="section-title" style="margin:2px 0 0">${esc(dayLabel)}</div>`;
    for (const { svc, ev } of list) {
      const ic = ev.type === 'series' ? 'tv' : ev.type === 'movie' ? 'film' : 'music';
      const src = ev.image ? proxyArt(svc, ev.image) : '';
      const art = src
        ? `<span class="svc-ic" style="--tile:var(--accent);width:34px;height:34px;border-radius:8px">
             <span class="svc-glyph-wrap">${icon(ic)}</span>
             <img class="svc-img cal-img" src="${esc(src)}" alt="" loading="lazy">
           </span>`
        : `<span class="svc-ic" style="--tile:var(--accent);width:28px;height:28px;border-radius:8px">${icon(ic)}</span>`;
      const tag = svc.url ? 'a' : 'div';
      const linkAttrs = svc.url ? ` href="${esc(serviceUrl(svc))}" target="_blank" rel="noopener noreferrer"` : '';
      html += `<${tag} class="rowitem cal-row"${linkAttrs}>
        ${art}
        <div class="row-main">
          <div class="row-title" style="font-size:12.5px">${esc(ev.title)} ${ev.hasFile ? '<span style="color:var(--ok)">✓</span>' : ev.grabbed ? '<span style="color:var(--warn)">⇣</span>' : ''}</div>
          <div class="row-sub">${esc(ev.subtitle || '')}</div>
        </div>
        ${ev.date ? `<span class="row-badge">${new Date(ev.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : ''}
      </${tag}>`;
    }
  }
  body.innerHTML = html + '</div>';
  wireIcons(body);
}

// ---------------------------------------------------------------- unraid
export function renderUnraid(body, ctx) {
  const svc = ctx.services.find((s) => s.type === 'unraid');
  if (!svc) { body.innerHTML = emptyWidget('Unraid server', 'unraid'); return; }
  if (!svc.online) { body.innerHTML = offlineHtml(svc); return; }

  const stat = (label) => { const s = (svc.stats || []).find((x) => x.label === label); return s ? s.value : null; };
  const disks = svc.disks || [];
  const cap = (svc.charts?.disks || [])[0];

  const diskRows = disks.slice(0, 24).map((d) => {
    const hot = d.temp != null && d.temp >= 50;
    const detail = (d.used && d.free) ? `${d.used} used · ${d.free} free` : (d.size || '–');
    const tip = [d.label, d.size ? `size ${d.size}` : '', d.pct != null ? `${d.pct}% used` : '', d.status].filter(Boolean).join(' · ');
    return `<div class="rowitem" style="padding:2px 0" title="${esc(tip)}">
      <span class="dot ${/STARTED|ACTIVE|DISK_OK/i.test(d.status) ? 'dot-ok' : /STANDBY/i.test(d.status) ? 'dot-warn' : 'dot-bad'}" title="${esc(d.status)}"></span>
      <span class="row-sub" style="flex:1;min-width:0" title="${esc(d.label)}">${esc(d.label)}</span>
      <span class="row-sub" style="flex:none;font-variant-numeric:tabular-nums">${esc(detail)}</span>
      ${d.temp != null ? `<span class="row-badge" style="${hot ? 'color:var(--bad)' : ''}" title="Temperature">${esc(d.temp)}°C</span>` : ''}
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="chips" style="margin-bottom:10px">
      ${(svc.stats || []).map(statChip).join('')}
    </div>
    ${cap ? (() => {
      const used = Number(cap.usedGB) || 0;
      const total = Number(cap.totalGB) || 0;
      const freeGB = cap.freeGB != null ? Number(cap.freeGB) : Math.max(0, total - used);
      const p = total > 0 ? Math.round((used / total) * 100) : 0;
      const tone = p > 90 ? 'var(--bad)' : p > 75 ? 'var(--warn)' : 'var(--ok)';
      return `<div>
        <div class="rowitem" style="margin-bottom:4px">
          <span class="row-sub" style="flex:1">Array capacity</span>
          <span class="row-sub">${fmtVol(used)} / ${fmtVol(total)} · <b style="color:${tone}">${p}%</b></span>
        </div>
        <div class="progress-line" style="height:8px"><div class="progress-fill ${p > 90 ? 'failed' : ''}" style="width:${p}%"></div></div>
        <div class="row-sub" style="margin-top:5px">${fmtVol(freeGB)} free of ${fmtVol(total)}</div>
      </div>`;
    })() : ''}
    ${diskRows ? `<div class="container-scroll" style="margin-top:10px">${diskRows}</div>` : ''}
    ${!cap && !diskRows ? `<div class="empty">No array data</div>` : ''}
    ${updatedTag(svc)}
  `;
}

// ---------------------------------------------------------------- shared bits
function emptyWidget(hint, widgetId) {
  return `<div class="empty">${icon('plug')} No ${esc(hint)} service configured.<br>
    <span style="font-size:11.5px">Admin → Services → Add service → ${esc(widgetId === 'disks' ? 'Sonarr/Radarr or Nextcloud' : widgetId)}</span></div>`;
}

function offlineHtml(svc, compact = false) {
  return `<div class="empty" style="padding:${compact ? 8 : 14}px">
    ${statusDot(false)} ${esc(svc.name)} offline
    ${svc.error && !compact ? `<br><span style="font-size:11.5px">${esc(svc.error)}</span>` : ''}
  </div>`;
}
