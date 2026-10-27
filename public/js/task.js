import { esc } from './charts.js';
import { icon } from './ui.js';

// Long-running actions (container updates) show an indeterminate task card with
// an elapsed timer, then a clear success/failure state. The Docker/Unraid APIs
// do not expose pull percentages, so the progress is intentionally indeterminate.
let active = null;

export function showTask({ title, detail = '', doneTitle = 'Update complete', failTitle = 'Update failed' } = {}) {
  if (active) active.close();

  const layer = document.createElement('div');
  layer.className = 'task-layer';
  layer.setAttribute('role', 'status');
  layer.setAttribute('aria-live', 'polite');
  layer.innerHTML = `
    <div class="task-card">
      <div class="task-ring" aria-hidden="true"></div>
      <div class="task-main">
        <div class="task-title">${esc(title || 'Working…')}</div>
        <div class="task-detail">${esc(detail)}</div>
        <div class="task-track" aria-hidden="true"><div class="task-fill"></div></div>
        <div class="task-elapsed">0:00</div>
      </div>
      <div class="task-state" aria-hidden="true"></div>
    </div>`;
  document.body.appendChild(layer);
  // Force a style flush so the fade-in transition still runs; avoids relying
  // on requestAnimationFrame, which can be suspended in background tabs.
  void layer.offsetWidth;
  layer.classList.add('is-open');

  const titleEl = layer.querySelector('.task-title');
  const detailEl = layer.querySelector('.task-detail');
  const elapsedEl = layer.querySelector('.task-elapsed');
  const stateEl = layer.querySelector('.task-state');
  const started = Date.now();
  let finished = false;

  const paintElapsed = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    elapsedEl.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  paintElapsed();
  const timer = setInterval(paintElapsed, 500);

  let closeTimer = null;
  const close = () => {
    if (closeTimer) clearTimeout(closeTimer);
    clearInterval(timer);
    layer.classList.remove('is-open');
    setTimeout(() => layer.remove(), 240);
    if (active === api) active = null;
  };
  const finish = (state, message) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    paintElapsed();
    layer.classList.add('is-done', `is-${state}`);
    titleEl.textContent = state === 'ok' ? doneTitle : failTitle;
    detailEl.textContent = message || (state === 'ok' ? 'The container is ready.' : 'The server returned an error.');
    stateEl.innerHTML = icon(state === 'ok' ? 'check' : 'x');
    closeTimer = setTimeout(close, state === 'ok' ? 2200 : 6000);
  };

  const api = {
    done: (message) => finish('ok', message),
    fail: (message) => finish('error', message),
    update: (message) => { if (!finished) detailEl.textContent = message; },
    close,
  };
  active = api;
  return api;
}
