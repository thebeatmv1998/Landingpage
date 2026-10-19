// Outbound webhook alerts (ntfy, Discord, generic JSON endpoints).
import { getSetting } from './db.js';

export async function postWebhook(url, payload) {
  if (!/^https?:\/\//i.test(String(url || ''))) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function notify(event, payload = {}) {
  const cfg = getSetting('alerts', {});
  if (!cfg.enabled || !cfg.url) return false;
  const toggle = { service_down: cfg.onDown, service_up: cfg.onUp, disk_high: cfg.onDisk }[event];
  if (toggle === false) return false;
  return postWebhook(cfg.url, { app: 'HomeDeck', event, ts: Date.now(), ...payload });
}
