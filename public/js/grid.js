// Free-form dashboard grid.
//
// Widgets are absolutely positioned on a column grid: `x` is the column, `w` the
// column span, `y` a vertical offset (snapped to STEP). Heights are measured from
// the DOM, and a light "gravity" pass packs widgets upward and pushes them out of
// the way while dragging, so everything can be moved anywhere and the rest of the
// board reflows around it.

const STEP = 8;                 // vertical snap in px
const MIN_H = 140;              // smallest useful widget height
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const effH = (it) => it.h || it.mh || 0;

export function createDashGrid(container, opts = {}) {
  const {
    getCols = () => 4,
    getGap = () => 16,
    isEditable = () => false,
    onChange = () => {},
  } = opts;

  let items = [];
  let cols = 4;
  let gap = 16;
  let drag = null;
  let ro = null;
  let relayoutTimer = 0;
  let destroyed = false;

  const nodes = new Map();
  const byId = (id) => items.find((i) => i.id === id);
  // Lay out everything that is actually in the DOM (in arrange mode that includes
  // hidden widgets, which need a slot too).
  const live = () => items.filter((i) => nodes.has(i.id));

  function syncNodes() {
    nodes.clear();
    for (const el of container.querySelectorAll('[data-widget]')) nodes.set(el.dataset.widget, el);
  }

  // Resolve the usable column count + column width for the current viewport.
  function metrics() {
    const W = container.clientWidth;
    gap = getGap();
    let c = getCols();
    if (W < 560) c = 1;
    else if (W < 900) c = Math.min(c, 2);
    else if (W < 1240) c = Math.min(c, 3);
    cols = Math.max(1, c);
    const colW = Math.max(0, (W - (cols - 1) * gap) / cols);
    return { W, colW };
  }

  const colLeft = (x, colW) => Math.round(x * (colW + gap));
  const colWidth = (w, colW) => Math.round(w * colW + (w - 1) * gap);

  function measure() {
    for (const it of items) {
      const el = nodes.get(it.id);
      if (el) it.mh = it.h || el.offsetHeight;
    }
  }

  function collides(a, y, placed) {
    for (const p of placed) {
      if (a.x < p.x + p.w && p.x < a.x + a.w) {
        if (y < p.y + p.h + gap && p.y < y + a.h + gap) return true;
      }
    }
    return false;
  }

  // Gravitate every widget upward (in input order), except the one being dragged,
  // which stays put and pushes the others down.
  function resolve(fixedId) {
    const list = live().map((i) => {
      const w = clamp(i.w || 1, 1, cols);
      return { id: i.id, x: clamp(i.x || 0, 0, cols - w), y: Math.max(0, i.y || 0), w, h: effH(i) };
    });
    const placed = [];
    const fixed = fixedId ? list.find((i) => i.id === fixedId) : null;
    if (fixed) placed.push(fixed);
    const rest = list.filter((i) => i.id !== fixedId).sort((a, b) => (a.y - b.y) || (a.x - b.x));
    for (const it of rest) {
      let y = it.y;
      while (y - STEP >= 0 && !collides(it, y - STEP, placed)) y -= STEP;
      let guard = 0;
      while (collides(it, y, placed) && guard++ < 4000) y += STEP;
      it.y = y;
      placed.push(it);
    }
    for (const p of placed) {
      const it = byId(p.id);
      if (it) { it.x = p.x; it.y = p.y; it.w = p.w; }
    }
  }

  function apply() {
    const { colW } = metrics();
    let maxBottom = 0;
    for (const it of live()) {
      const el = nodes.get(it.id);
      if (!el) continue;
      if (it.h) el.style.height = it.h + 'px';
      else el.style.height = '';
      el.classList.toggle('has-fixed-height', !!it.h);
      el.style.left = colLeft(it.x, colW) + 'px';
      el.style.top = it.y + 'px';
      el.style.width = colWidth(it.w, colW) + 'px';
      maxBottom = Math.max(maxBottom, it.y + effH(it));
    }
    container.style.height = maxBottom + 'px';
  }

  function relayout(fixedId) {
    if (destroyed || !container.isConnected || !container.clientWidth) return;
    syncNodes();
    const { colW } = metrics();
    for (const it of live()) {
      const el = nodes.get(it.id);
      if (el) el.style.width = colWidth(clamp(it.w || 1, 1, cols), colW) + 'px';
    }
    measure();
    resolve(fixedId);
    apply();
    observe();
  }

  function schedule() {
    if (destroyed) return;
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => relayout(), 120);
  }

  function snapshot() {
    return items.map(({ id, enabled, x, y, w, h }) => ({ id, enabled, x, y, w, ...(h ? { h } : {}) }));
  }

  // ---------------------------------------------------------------- drag
  function onPointerDown(e) {
    if (!isEditable() || drag || e.button > 0) return;
    const host = e.target.closest?.('[data-widget]');
    if (!host) return;
    const resizeHandle = e.target.closest('.widget-resize');
    const head = e.target.closest('.widget-head');
    if (!resizeHandle && !head) return;
    if (!resizeHandle && e.target.closest('button, a, input, select')) return;
    const it = byId(host.dataset.widget);
    if (!it) return;
    const rect = host.getBoundingClientRect();
    drag = {
      id: it.id, mode: resizeHandle ? 'resize' : 'move', el: host,
      offX: e.clientX - rect.left, offY: e.clientY - rect.top,
      startX: e.clientX, startY: e.clientY, startH: effH(it),
      pointerId: e.pointerId, active: false,
    };
    e.preventDefault();
  }

  function activate() {
    drag.active = true;
    drag.el.classList.add('dragging');
    document.body.classList.add('grid-dragging');
    try { drag.el.setPointerCapture(drag.pointerId); } catch { /* ignore */ }
    measure();
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.startX) < 4 && Math.abs(e.clientY - drag.startY) < 4) return;
      activate();
    }
    const it = byId(drag.id);
    if (!it) return;
    const { colW } = metrics();
    const cr = container.getBoundingClientRect();
    if (drag.mode === 'move') {
      const px = e.clientX - cr.left - drag.offX;
      it.x = clamp(Math.round(px / (colW + gap)), 0, cols - it.w);
      const py = e.clientY - cr.top - drag.offY;
      it.y = Math.max(0, Math.round(py / STEP) * STEP);
      resolve(drag.id);
      apply();
    } else {
      const px = e.clientX - cr.left;
      const w = clamp(Math.round((px + gap) / (colW + gap)), 1, cols - it.x);
      if (w !== it.w) it.w = w;
      // Only take on an explicit height once the pointer really moves vertically,
      // so a pure width drag keeps the automatic content height.
      const dh = e.clientY - drag.startY;
      if (Math.abs(dh) >= 6) it.h = clamp(Math.round((drag.startH + dh) / STEP) * STEP, MIN_H, 4000);
      apply();
      measure();
      resolve(drag.id);
      apply();
    }
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasActive = drag.active;
    if (wasActive) {
      drag.el.classList.remove('dragging');
      document.body.classList.remove('grid-dragging');
    }
    drag = null;
    if (!wasActive) return;
    relayout();
    onChange(snapshot());
  }

  // Keyboard: focus a widget in arrange mode and move it with the arrow keys
  // (Shift + arrows resizes the width).
  function onKeyDown(e) {
    if (!isEditable()) return;
    const host = e.target.closest?.('[data-widget]');
    if (!host || (e.target !== host && !host.contains(e.target) && !host.contains(document.activeElement))) return;
    const it = byId(host.dataset.widget);
    if (!it) return;
    let handled = true;
    if (e.key === 'ArrowLeft') { if (e.shiftKey) it.w = clamp(it.w - 1, 1, cols); else it.x = clamp(it.x - 1, 0, cols - it.w); }
    else if (e.key === 'ArrowRight') { if (e.shiftKey) it.w = clamp(it.w + 1, 1, cols); else it.x = clamp(it.x + 1, 0, cols - it.w); }
    else if (e.key === 'ArrowUp') { if (e.altKey) it.h = clamp(effH(it) - 24, MIN_H, 4000); else it.y = Math.max(0, it.y - 24); }
    else if (e.key === 'ArrowDown') { if (e.altKey) it.h = clamp(effH(it) + 24, MIN_H, 4000); else it.y = it.y + 24; }
    else handled = false;
    if (!handled) return;
    e.preventDefault();
    measure();
    resolve(it.id);
    apply();
    onChange(snapshot());
  }

  function onResize() { schedule(); }

  // Double-click the grip to drop an explicit height and return to auto height.
  function onDblClick(e) {
    if (!isEditable()) return;
    const handle = e.target.closest?.('.widget-resize');
    if (!handle) return;
    const host = e.target.closest('[data-widget]');
    const it = byId(host?.dataset.widget);
    if (!it) return;
    e.preventDefault();
    it.h = undefined;
    relayout();
    onChange(snapshot());
  }

  function observe() {
    if (!('ResizeObserver' in window)) return;
    if (!ro) ro = new ResizeObserver(() => { if (!drag) schedule(); });
    for (const el of nodes.values()) {
      if (el.dataset.gridObserved) continue;
      el.dataset.gridObserved = '1';
      ro.observe(el);
    }
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);
  container.addEventListener('dblclick', onDblClick);
  container.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);

  return {
    setItems(list) {
      items = (list || []).map((i) => {
        const h = Number(i.h);
        return { ...i, h: Number.isFinite(h) && h >= MIN_H ? Math.round(h) : undefined };
      });
      relayout();
    },
    relayout,
    destroy() {
      destroyed = true;
      clearTimeout(relayoutTimer);
      ro?.disconnect();
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
      container.removeEventListener('dblclick', onDblClick);
      container.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    },
  };
}
