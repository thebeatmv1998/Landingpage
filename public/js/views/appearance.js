import { icon } from '../icons.js';
import { esc, toast, applyTheme, debounce, BG_PRESETS } from '../ui.js';
import { effectiveAppearance, defaults } from '../state.js';
import { API } from '../api.js';

const ACCENTS = ['#c9963f', '#e0a359', '#e2795c', '#d76a86', '#9d7bd8', '#6d8dff', '#48b0d8', '#3fb594', '#8a9aa3'];

// Reusable appearance editor.
//   get() -> current working appearance object
//   save(patch) -> called live while the user drags/changes controls
//   commit(patchAll) -> optional; when provided, a Save button calls it (admin mode)
//   onCommitted() -> optional callback after commit succeeds
export function appearanceEditor(container, { get, save, commit, onCommitted }) {
  function renderEditor() {
    const app = { ...defaults(), ...get() };

    const row = (name, input, id) =>
      `<div class="range-row"><span class="range-name">${esc(name)}</span>${input}<output id="${id}"></output></div>`;
    const range = (id, min, max, val) => `<input type="range" id="${id}" min="${min}" max="${max}" value="${val}">`;

    container.innerHTML = `
    <div class="panel-grid">
      <div>
        <div class="field-label">Theme</div>
        <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
          <button class="btn btn-sm ${app.theme === 'dark' ? 'btn-primary' : ''}" data-set="theme" data-val="dark">${icon('moon')} Dark</button>
          <button class="btn btn-sm ${app.theme === 'light' ? 'btn-primary' : ''}" data-set="theme" data-val="light">${icon('sun')} Light</button>
          <button class="btn btn-sm ${app.theme === 'auto' ? 'btn-primary' : ''}" data-set="theme" data-val="auto">${icon('palette')} Auto</button>
        </div>

        <div class="field-label">Accent color</div>
        <div class="swatches">${ACCENTS.map((c) => `<span class="swatch ${app.accent === c ? 'active' : ''}" data-set="accent" data-val="${c}" style="background:${c}"></span>`).join('')}</div>
        <div class="range-row" style="margin-bottom:14px"><span class="range-name">Custom accent</span>
          <div><input type="color" id="ap-accent-picker" value="${esc(app.accent)}"></div>
          <output>${esc(app.accent)}</output>
        </div>

        <div class="field-label">Second accent (gradients)</div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
          <input type="color" id="ap-accent2" value="${esc(app.accent2)}">
          <span class="hint" style="margin:0">Paired with the main accent in buttons and progress bars</span>
        </div>

        <div class="field-label">Background</div>
        <div class="preset-grid">${BG_PRESETS.map((g, i) => `<span class="preset-swatch ${app.bgMode === 'preset' && Number(app.bgPreset) === i ? 'active' : ''}" data-preset="${i}" style="background:${g}"></span>`).join('')}</div>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <button class="btn btn-sm ${app.bgMode === 'preset' ? 'btn-primary' : ''}" data-set="bgMode" data-val="preset">${icon('palette')} Preset</button>
          <button class="btn btn-sm ${app.bgMode === 'solid' ? 'btn-primary' : ''}" data-set="bgMode" data-val="solid">${icon('palette')} Solid</button>
          <button class="btn btn-sm ${app.bgMode === 'image' ? 'btn-primary' : ''}" data-set="bgMode" data-val="image">${icon('image')} Image URL</button>
          <label class="btn btn-sm" style="cursor:pointer">${icon('image')} Upload
            <input type="file" id="ap-upload" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
          </label>
        </div>
        <div id="ap-bg-value-wrap">
          <label class="field"><span>Solid color / image URL</span>
            <input class="input" id="ap-bg-value" placeholder="https://…  or  #0b1020">
          </label>
        </div>
      </div>

      <div>
        ${row('Card opacity', range('ap-cardOpacity', 15, 100, app.cardOpacity), 'o-cardOpacity')}
        ${row('Card blur', range('ap-cardBlur', 0, 40, app.cardBlur), 'o-cardBlur')}
        ${row('Corner radius', range('ap-radius', 4, 34, app.radius), 'o-radius')}
        ${row('Background blur', range('ap-bgBlur', 0, 40, app.bgBlur), 'o-bgBlur')}
        ${row('Background dim', range('ap-bgDim', 0, 90, app.bgDim), 'o-bgDim')}

        <label class="field"><span>Font</span>
          <select class="input" id="ap-font">
            <option value="system" ${app.font === 'system' ? 'selected' : ''}>System (Inter/Segoe)</option>
            <option value="rounded" ${app.font === 'rounded' ? 'selected' : ''}>Rounded</option>
            <option value="serif" ${app.font === 'serif' ? 'selected' : ''}>Serif</option>
            <option value="mono" ${app.font === 'mono' ? 'selected' : ''}>Monospace</option>
          </select>
        </label>
        <label class="field"><span>Dashboard columns</span>
          <select class="input" id="ap-cols">
            ${[3, 4, 5, 6].map((n) => `<option value="${n}" ${Number(app.cols) === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Icon shape</span>
          <select class="input" id="ap-iconShape">
            <option value="squircle" ${app.iconShape === 'squircle' ? 'selected' : ''}>Squircle</option>
            <option value="circle" ${app.iconShape === 'circle' ? 'selected' : ''}>Circle</option>
          </select>
        </label>
        <label class="field" style="display:flex;align-items:center;gap:10px">
          <span class="switch"><input type="checkbox" id="ap-animations" ${app.animations !== false ? 'checked' : ''}><span class="knob"></span></span>
          <span>Animations</span>
        </label>
        <label class="field" style="display:flex;align-items:center;gap:10px">
          <span class="switch"><input type="checkbox" id="ap-group" ${app.groupByCategory !== false ? 'checked' : ''}><span class="knob"></span></span>
          <span>Group services by category</span>
        </label>
        <label class="field" style="display:flex;align-items:center;gap:10px">
          <span class="switch"><input type="checkbox" id="ap-compact" ${app.compact ? 'checked' : ''}><span class="knob"></span></span>
          <span>Compact layout</span>
        </label>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:9px;margin-top:8px">
      <button class="btn btn-ghost" id="ap-reset">${icon('refresh')} Reset to defaults</button>
      ${commit ? `<button class="btn btn-primary" id="ap-save">${icon('check')} Save appearance</button>` : ''}
    </div>`;

    const updateOutputs = () => {
      for (const [id, out, fmt] of [
        ['ap-cardOpacity', 'o-cardOpacity', (v) => v + '%'],
        ['ap-cardBlur', 'o-cardBlur', (v) => v + 'px'],
        ['ap-radius', 'o-radius', (v) => v + 'px'],
        ['ap-bgBlur', 'o-bgBlur', (v) => v + 'px'],
        ['ap-bgDim', 'o-bgDim', (v) => v + '%'],
      ]) {
        const el = container.querySelector('#' + id), o = container.querySelector('#' + out);
        if (el && o) o.textContent = fmt(el.value);
      }
    };
    updateOutputs();

    const preview = () => applyTheme({ ...effectiveAppearance(), ...get() });

    const bgWrap = container.querySelector('#ap-bg-value-wrap');
    const bgInput = container.querySelector('#ap-bg-value');
    const syncBgField = () => {
      const a = get();
      bgWrap.style.display = a.bgMode === 'preset' ? 'none' : 'block';
      bgInput.value = a.bgMode === 'solid' ? (a.bgSolid || '') : (a.bgMode === 'image' ? (a.bgImage || '') : '');
      bgInput.placeholder = a.bgMode === 'solid' ? '#0e1113' : 'https://example.com/wallpaper.jpg';
    };
    syncBgField();

    container.querySelectorAll('[data-set]').forEach((btn) => {
      btn.addEventListener('click', () => {
        save({ [btn.dataset.set]: btn.dataset.val });
        renderEditor();
        preview();
      });
    });
    container.querySelectorAll('.preset-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        save({ bgMode: 'preset', bgPreset: Number(sw.dataset.preset) });
        renderEditor();
        preview();
      });
    });

    container.querySelector('#ap-accent-picker').addEventListener('input', (e) => { save({ accent: e.target.value }); preview(); });
    container.querySelector('#ap-accent2').addEventListener('input', (e) => { save({ accent2: e.target.value }); preview(); });
    bgInput.addEventListener('input', debounceLocal(() => {
      const v = bgInput.value.trim();
      save(get().bgMode === 'solid' ? { bgSolid: v } : { bgImage: v });
      preview();
    }, 300));

    container.querySelector('#ap-upload').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const res = await API.uploadBackground(file);
        save({ bgMode: 'image', bgImage: res.url });
        syncBgField();
        preview();
        toast('Background uploaded', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });

    for (const [id, key] of [['ap-cardOpacity', 'cardOpacity'], ['ap-cardBlur', 'cardBlur'], ['ap-radius', 'radius'], ['ap-bgBlur', 'bgBlur'], ['ap-bgDim', 'bgDim']]) {
      container.querySelector('#' + id).addEventListener('input', (e) => {
        save({ [key]: Number(e.target.value) });
        updateOutputs();
        preview();
      });
    }
    container.querySelector('#ap-font').addEventListener('change', (e) => { save({ font: e.target.value }); preview(); });
    container.querySelector('#ap-cols').addEventListener('change', (e) => { save({ cols: Number(e.target.value) }); preview(); });
    container.querySelector('#ap-iconShape').addEventListener('change', (e) => { save({ iconShape: e.target.value }); preview(); });
    container.querySelector('#ap-animations').addEventListener('change', (e) => { save({ animations: e.target.checked }); preview(); });
    container.querySelector('#ap-group').addEventListener('change', (e) => { save({ groupByCategory: e.target.checked }); preview(); });
    container.querySelector('#ap-compact').addEventListener('change', (e) => { save({ compact: e.target.checked }); preview(); });

    container.querySelector('#ap-reset').addEventListener('click', () => {
      save({ ...defaults(), bgPreset: 0 });
      renderEditor();
      preview();
      toast('Reset to defaults' + (commit ? ' — press Save to persist' : ''), 'success');
    });

    const saveBtn = container.querySelector('#ap-save');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await commit(get());
        onCommitted?.();
      } catch (err) {
        toast(err.message, 'error');
        saveBtn.disabled = false;
      }
    });
  }

  renderEditor();
}

function debounceLocal(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
