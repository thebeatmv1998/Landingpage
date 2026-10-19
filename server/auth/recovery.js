// TOTP recovery codes — shown once, stored as SHA-256 hashes, single-use.
import crypto from 'node:crypto';
import { db } from '../core/db.js';
import { nowMs } from '../core/util.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
const COUNT = 10;

function makeCode() {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

const normalize = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code) => crypto.createHash('sha256').update(normalize(code)).digest('hex');

export function generateRecoveryCodes(userId) {
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
  const codes = [];
  for (let i = 0; i < COUNT; i++) {
    const code = makeCode();
    codes.push(code);
    ins.run(userId, hashCode(code));
  }
  return codes;
}

export function consumeRecoveryCode(userId, input) {
  if (!normalize(input)) return false;
  const row = db.prepare(
    'SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
  ).get(userId, hashCode(input));
  if (!row) return false;
  db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(nowMs(), row.id);
  return true;
}

export function remainingRecoveryCodes(userId) {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId).c) || 0;
  } catch { return 0; }
}

export function clearRecoveryCodes(userId) {
  try { db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId); } catch { /* ignore */ }
}
