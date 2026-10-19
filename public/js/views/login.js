import { icon } from '../icons.js';
import { esc, h, toast } from '../ui.js';
import { API } from '../api.js';
import { state } from '../state.js';

const LOGO = '<span class="brand-logo"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 17V9.5L12 6l5 3.5V17h-3.4v-4h-3.2v4z"/></svg></span>';

function baseCard(inner) {
  return `<div class="auth-wrap"><div class="auth-card">
    <div class="auth-logo">${LOGO}</div>
    ${inner}
    <div class="auth-version">HomeDeck${state.meta?.version ? ` v${esc(state.meta.version)}` : ''}</div>
  </div></div>`;
}

export function renderLogin(root, { sso, ssoError, onDone }) {
  document.title = 'Sign in — HomeDeck';
  let totpTicket = null;

  function draw() {
    if (totpTicket) { drawTotp(); return; }
    root.innerHTML = baseCard(`
      <h1>Sign in</h1>
      <p class="auth-sub">Welcome back to your home deck</p>
      ${ssoError ? `<div class="auth-error">${icon('x')}<span>${esc(ssoError)}</span></div>` : ''}
      <div id="auth-error-slot"></div>
      <form id="login-form" autocomplete="on">
        <label class="field"><span>Username</span>
          <input class="input" id="f-user" name="username" autocomplete="username" required autofocus>
        </label>
        <label class="field"><span>Password</span>
          <input class="input" id="f-pass" name="password" type="password" autocomplete="current-password" required>
        </label>
        <button class="btn btn-primary btn-block" type="submit" id="login-btn">Sign in</button>
      </form>
      ${sso?.enabled ? `
        <div class="auth-divider">or</div>
        <a class="btn btn-block" href="/api/oauth/start" id="sso-btn">${icon('lock')} Sign in with ${esc(sso.label || 'SSO')}</a>` : ''}
    `);

    const form = root.querySelector('#login-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = root.querySelector('#login-btn');
      btn.disabled = true;
      try {
        const res = await API.login({
          username: root.querySelector('#f-user').value.trim(),
          password: root.querySelector('#f-pass').value,
        });
        if (res.totpRequired) { totpTicket = res.ticket; draw(); return; }
        onDone(res.user);
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
      }
    });
  }

  function drawTotp() {
    root.innerHTML = baseCard(`
      <h1>Two-factor</h1>
      <p class="auth-sub">Enter the 6-digit code from your authenticator</p>
      <div id="auth-error-slot"></div>
      <form id="totp-form">
        <label class="field"><span>Verification code</span>
          <input class="input otp-input" id="f-code" inputmode="numeric" maxlength="6" pattern="[0-9]*" required autofocus>
        </label>
        <button class="btn btn-primary btn-block" type="submit">Verify</button>
        <button class="btn btn-ghost btn-block" type="button" id="rec-btn" style="margin-top:8px">Use a recovery code</button>
        <button class="btn btn-ghost btn-block" type="button" id="back-btn" style="margin-top:8px">Back</button>
      </form>
    `);
    root.querySelector('#back-btn').addEventListener('click', () => { totpTicket = null; draw(); });
    root.querySelector('#rec-btn').addEventListener('click', drawRecovery);
    root.querySelector('#totp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await API.loginTotp({ ticket: totpTicket, code: root.querySelector('#f-code').value.trim() });
        onDone(res.user);
      } catch (err) {
        showError(err.message);
      }
    });
  }

  function drawRecovery() {
    root.innerHTML = baseCard(`
      <h1>Recovery code</h1>
      <p class="auth-sub">Enter one of your saved recovery codes</p>
      <div id="auth-error-slot"></div>
      <form id="rec-form">
        <label class="field"><span>Recovery code</span>
          <input class="input" id="f-rec" placeholder="XXXXX-XXXXX" autocomplete="one-time-code" required autofocus
            style="letter-spacing:.18em;font-family:var(--font-mono);font-size:16px;text-transform:uppercase">
        </label>
        <button class="btn btn-primary btn-block" type="submit">Verify</button>
        <button class="btn btn-ghost btn-block" type="button" id="back-btn" style="margin-top:8px">Back</button>
      </form>
    `);
    root.querySelector('#back-btn').addEventListener('click', () => draw());
    root.querySelector('#rec-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await API.loginRecovery({ ticket: totpTicket, code: root.querySelector('#f-rec').value.trim() });
        onDone(res.user);
      } catch (err) { showError(err.message); }
    });
  }

  function showError(msg) {
    const slot = root.querySelector('#auth-error-slot');
    if (slot) slot.innerHTML = `<div class="auth-error">${icon('x')}<span>${esc(msg)}</span></div>`;
    else toast(msg, 'error');
  }

  draw();
}

export function renderSetup(root, { onDone }) {
  document.title = 'Setup — HomeDeck';
  root.innerHTML = baseCard(`
    <h1>Welcome</h1>
    <p class="auth-sub">Create your administrator account to finish setting up HomeDeck</p>
    <div id="auth-error-slot"></div>
    <form id="setup-form">
      <label class="field"><span>Username</span>
        <input class="input" id="f-user" autocomplete="username" required autofocus>
      </label>
      <label class="field"><span>Display name <small style="color:var(--faint)">(optional)</small></span>
        <input class="input" id="f-display">
      </label>
      <label class="field"><span>Password</span>
        <input class="input" id="f-pass" type="password" autocomplete="new-password" required minlength="8">
      </label>
      <label class="field"><span>Repeat password</span>
        <input class="input" id="f-pass2" type="password" autocomplete="new-password" required>
      </label>
      <button class="btn btn-primary btn-block" type="submit">Create account</button>
    </form>
  `);
  root.querySelector('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = root.querySelector('#f-user').value.trim();
    const pass = root.querySelector('#f-pass').value;
    const pass2 = root.querySelector('#f-pass2').value;
    const slot = root.querySelector('#auth-error-slot');
    slot.innerHTML = '';
    if (pass !== pass2) {
      slot.innerHTML = `<div class="auth-error">${icon('x')}<span>Passwords do not match</span></div>`;
      return;
    }
    try {
      const res = await API.setup({ username: user, password: pass, displayName: root.querySelector('#f-display').value });
      toast('Administrator account created', 'success');
      onDone(res.user);
    } catch (err) {
      slot.innerHTML = `<div class="auth-error">${icon('x')}<span>${esc(err.message)}</span></div>`;
    }
  });
}
