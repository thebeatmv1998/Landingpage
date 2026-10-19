import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '..', '..');

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

export const config = {
  port: intEnv('PORT', 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.join(rootDir, 'data'),
  dbFile: path.join(process.env.DATA_DIR || path.join(rootDir, 'data'), 'homedeck.db'),
  uploadsDir: path.join(process.env.DATA_DIR || path.join(rootDir, 'data'), 'uploads'),
  secretFile: path.join(process.env.DATA_DIR || path.join(rootDir, 'data'), '.secret'),
  sessionTtlHours: intEnv('SESSION_TTL_HOURS', 24 * 7),
  sessionTtlRememberHours: intEnv('SESSION_TTL_REMEMBER_HOURS', 24 * 30),
  secureCookies: process.env.SECURE_COOKIES === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  version: '1.0.0',
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

// ---------------------------------------------------------------------------
// Per-install secret used to encrypt service credentials at rest (AES-256-GCM)
// ---------------------------------------------------------------------------
function loadOrCreateSecret() {
  try {
    const existing = fs.readFileSync(config.secretFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) return Buffer.from(existing, 'hex');
  } catch { /* first run */ }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(config.secretFile, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}
const secretKey = loadOrCreateSecret();
export { secretKey };

export function encryptSecret(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

export function decryptSecret(stored) {
  if (stored === undefined || stored === null || stored === '') return '';
  if (!stored.startsWith('enc1:')) return String(stored); // legacy/plain value
  try {
    const [, ivB64, tagB64, ctB64] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function maskSecret(plain) {
  if (!plain) return '';
  const s = String(plain);
  return '••••' + s.slice(-4);
}
