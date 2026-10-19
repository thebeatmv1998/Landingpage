// Hand-rolled SVG charts — no external libraries, fully offline.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fmtBytes(bytes, digits = 1) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 10_000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return v.toLocaleString('en-US');
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- donut
export function donut({ value = 0, size = 96, thickness = 10, color = 'var(--accent)', track = 'var(--track)', label = '', sub = '' }) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const dash = (v / 100) * c;
  return `<div class="donut-wrap" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${thickness}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}"
        stroke-linecap="round" stroke-dasharray="${dash} ${c - dash}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    </svg>
    <div class="donut-center"><div class="donut-label">${esc(label)}</div>${sub ? `<div class="donut-sub">${esc(sub)}</div>` : ''}</div>
  </div>`;
}

export function multiDonut({ segments = [], size = 96, thickness = 10, label = '', sub = '' }) {
  const total = segments.reduce((a, s) => a + Number(s.value || 0), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  let arcs = '';
  for (const s of segments) {
    const frac = total > 0 ? (Number(s.value || 0) / total) : 0;
    const dash = frac * c;
    if (dash > 0) {
      arcs += `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}"
        stroke-dasharray="${Math.max(0, dash - 1.5)} ${c - Math.max(0, dash - 1.5)}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
      offset += dash;
    }
  }
  return `<div class="donut-wrap" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">${arcs}</svg>
    <div class="donut-center"><div class="donut-label">${esc(label)}</div>${sub ? `<div class="donut-sub">${esc(sub)}</div>` : ''}</div>
  </div>`;
}

// ---------------------------------------------------------------- area chart
// series: [{points:[y...], color, label?}] ; points share the x axis
export function areaChart({ series = [], width = 460, height = 120, yMax = null, gridLines = 3, labels = [] }) {
  if (!series.length) return `<div class="chart-empty">No data yet</div>`;
  const all = series.flatMap((s) => s.points.map(Number).filter((n) => Number.isFinite(n)));
  if (!all.length) return `<div class="chart-empty">No data yet</div>`;
  const max = yMax ?? (Math.max(...all) * 1.15 || 1);
  const n = Math.max(...series.map((s) => s.points.length));
  if (n < 2) return `<div class="chart-empty">Collecting data…</div>`;
  const px = (i) => (i / (n - 1)) * width;
  const py = (v) => height - (Math.max(0, Math.min(v, max)) / max) * (height - 6) - 3;

  let defs = '', paths = '', grid = '';
  series.forEach((s, si) => {
    const pts = s.points;
    let d = '';
    for (let i = 0; i < n; i++) {
      const v = Number(pts[i] ?? pts[pts.length - 1] ?? 0) || 0;
      d += (i === 0 ? 'M' : 'L') + px(i).toFixed(1) + ' ' + py(v).toFixed(1);
    }
    const id = `ag${si}${Math.floor(Math.random() * 1e6)}`;
    defs += `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${s.color}" stop-opacity=".35"/>
      <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/>
    </linearGradient>`;
    paths += `<path d="${d} L ${width} ${height} L 0 ${height} Z" fill="url(#${id})" stroke="none"/>`;
    paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  for (let g = 1; g <= gridLines; g++) {
    const y = (height / (gridLines + 1)) * g;
    grid += `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="currentColor" stroke-opacity=".08" stroke-width="1"/>`;
  }
  const legend = series.filter((s) => s.label).map((s) =>
    `<span class="chart-legend-item"><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('');
  const labelHtml = labels.length
    ? `<div class="chart-labels"><span>${esc(labels[0])}</span><span>${esc(labels[labels.length - 1])}</span></div>` : '';
  return `<div class="chart">${legend ? `<div class="chart-legend">${legend}</div>` : ''}
    <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
      <defs>${defs}</defs>${grid}${paths}
    </svg>${labelHtml}</div>`;
}

// ---------------------------------------------------------------- bars
export function barsChart({ items = [], color = 'var(--accent)', max = null }) {
  if (!items.length) return `<div class="chart-empty">No data</div>`;
  const m = max ?? (Math.max(...items.map((i) => Number(i.value) || 0)) || 1);
  return `<div class="bars">${items.map((it) => `
    <div class="bar-row">
      <div class="bar-label" title="${esc(it.label)}">${esc(it.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (Number(it.value) || 0) / m * 100)}%;background:${it.color || color}"></div></div>
      <div class="bar-value">${esc(it.sub ?? fmtNum(it.value))}</div>
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------- sparkline
export function sparkline({ values = [], width = 120, height = 32, color = 'var(--accent)' }) {
  const vals = values.map(Number).filter(Number.isFinite);
  if (vals.length < 2) return '';
  const max = Math.max(...vals) || 1;
  const px = (i) => (i / (vals.length - 1)) * width;
  const py = (v) => height - (v / max) * (height - 4) - 2;
  let d = '';
  vals.forEach((v, i) => { d += (i === 0 ? 'M' : 'L') + px(i).toFixed(1) + ' ' + py(v).toFixed(1); });
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <path d="${d} L ${width} ${height} L 0 ${height} Z" fill="${color}" fill-opacity=".15" stroke="none"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
