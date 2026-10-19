// Append-only audit trail for security-relevant actions.
import { db } from './db.js';
import { nowMs } from './util.js';

const insert = db.prepare(
  'INSERT INTO audit_log (ts, user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
);
const listAll = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?');
const listFiltered = db.prepare(
  'SELECT * FROM audit_log WHERE username LIKE ? OR action LIKE ? OR detail LIKE ? OR ip LIKE ? ORDER BY id DESC LIMIT ?',
);

// Never let logging break a request.
export function audit(req, action, detail = '', user = null) {
  try {
    const u = user || req?.user || null;
    const username = u?.username || req?.body?.username || '';
    insert.run(
      nowMs(),
      u?.id ?? null,
      String(username).slice(0, 60),
      String(action).slice(0, 60),
      String(detail).slice(0, 500),
      String(req?.ip || '').slice(0, 60),
    );
  } catch { /* ignore */ }
}

export function listAudit({ limit = 200, q = '' } = {}) {
  const n = Math.min(1000, Math.max(1, Number(limit) || 200));
  const query = String(q || '').trim();
  if (!query) return listAll.all(n);
  const like = `%${query}%`;
  return listFiltered.all(like, like, like, like, n);
}

// Keep the audit log bounded: prune entries older than 90 days.
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
setInterval(() => {
  try { db.prepare('DELETE FROM audit_log WHERE ts < ?').run(Date.now() - RETENTION_MS); } catch { /* ignore */ }
}, 6 * 60 * 60 * 1000).unref();
