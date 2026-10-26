import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config, encryptSecret } from './config.js';
import { safeJsonParse } from './util.js';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
for (const file of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) {
  try { fs.chmodSync(file, 0o600); } catch { /* not created yet / Windows */ }
}
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  group_name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  totp_secret TEXT NOT NULL DEFAULT '',
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  oauth_provider TEXT NOT NULL DEFAULT '',
  oauth_sub TEXT NOT NULL DEFAULT '',
  prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  poll_interval INTEGER,
  allowed_groups TEXT NOT NULL DEFAULT '[]',
  extra TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '{}'
);
`);

// ---------------------------------------------------------------------------
// Schema migrations (PRAGMA user_version). Bump SCHEMA_VERSION and append a step
// whenever the schema changes, so existing databases upgrade in place.
// ---------------------------------------------------------------------------
const SCHEMA_VERSION = 4;
const MIGRATIONS = [
  // v1 — initial schema (the CREATE TABLE statements above). No-op for fresh DBs.
  () => {},
  // v2 — audit log + TOTP recovery codes.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        user_id INTEGER,
        username TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
      CREATE TABLE IF NOT EXISTS recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);
    `);
  },
  // v3 — per-service public fallback URL for automatic local/public switching.
  () => {
    db.exec(`
      ALTER TABLE services ADD COLUMN fallback_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE services ADD COLUMN auto_switch INTEGER NOT NULL DEFAULT 1;
    `);
  },
  // v4 — one-time pairing codes + long-lived device tokens for the Android app.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        server_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_codes(expires_at);
      CREATE TABLE IF NOT EXISTS device_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'Android app',
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        last_ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_device_user ON device_tokens(user_id);
    `);
  },
];

function schemaVersion() {
  try { return Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0; } catch { return 0; }
}

{
  const from = schemaVersion();
  for (let v = from; v < SCHEMA_VERSION; v++) {
    try { MIGRATIONS[v]?.(); } catch (err) { console.error(`[db] migration ${v} → ${v + 1} failed:`, err); throw err; }
  }
  if (from < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export const stmts = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByOauth: db.prepare('SELECT * FROM users WHERE oauth_provider = ? AND oauth_sub = ?'),
  usersAll: db.prepare('SELECT * FROM users ORDER BY id'),
  usersCount: db.prepare('SELECT COUNT(*) AS c FROM users'),
  userInsert: db.prepare(`INSERT INTO users (username, pass_hash, role, group_name, display_name, created_at)
    VALUES (:username, :pass_hash, :role, :group_name, :display_name, :created_at)`),
  userUpdate: db.prepare(`UPDATE users SET username=:username, role=:role, group_name=:group_name,
    display_name=:display_name WHERE id=:id`),
  userSetPass: db.prepare('UPDATE users SET pass_hash = :pass_hash WHERE id = :id'),
  userSetTotp: db.prepare('UPDATE users SET totp_secret = :secret, totp_enabled = :enabled WHERE id = :id'),
  userSetOauth: db.prepare('UPDATE users SET oauth_provider = :provider, oauth_sub = :sub WHERE id = :id'),
  userSetPrefs: db.prepare('UPDATE users SET prefs = :prefs WHERE id = :id'),
  userDelete: db.prepare('DELETE FROM users WHERE id = :id'),

  sessionInsert: db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (:token, :user_id, :created_at, :expires_at, :user_agent)'),
  sessionGet: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  sessionDelete: db.prepare('DELETE FROM sessions WHERE token = :token'),
  sessionDeleteUser: db.prepare('DELETE FROM sessions WHERE user_id = :user_id'),
  sessionDeleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at < :now'),

  pairingInsert: db.prepare(`INSERT INTO pairing_codes (user_id, code_hash, server_url, created_at, expires_at)
    VALUES (:user_id, :code_hash, :server_url, :created_at, :expires_at)`),
  pairingDeleteUser: db.prepare('DELETE FROM pairing_codes WHERE user_id = ?'),
  pairingByHash: db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?'),
  pairingConsume: db.prepare('UPDATE pairing_codes SET used_at = :used_at WHERE id = :id AND used_at IS NULL'),
  pairingDeleteExpired: db.prepare('DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL'),

  deviceInsert: db.prepare(`INSERT INTO device_tokens (user_id, name, token_hash, created_at, last_used_at, last_ip, user_agent)
    VALUES (:user_id, :name, :token_hash, :created_at, :last_used_at, :last_ip, :user_agent)`),
  deviceByHash: db.prepare('SELECT * FROM device_tokens WHERE token_hash = ?'),
  deviceTouch: db.prepare('UPDATE device_tokens SET last_used_at = :last_used_at, last_ip = :last_ip WHERE id = :id'),
  deviceDelete: db.prepare('DELETE FROM device_tokens WHERE id = :id AND user_id = :user_id'),
  deviceDeleteUser: db.prepare('DELETE FROM device_tokens WHERE user_id = ?'),
  devicesByUser: db.prepare('SELECT id, name, created_at, last_used_at, last_ip, user_agent FROM device_tokens WHERE user_id = ? ORDER BY created_at DESC'),

  servicesAll: db.prepare('SELECT * FROM services ORDER BY sort_order, id'),
  serviceById: db.prepare('SELECT * FROM services WHERE id = ?'),
  serviceInsert: db.prepare(`INSERT INTO services (type, name, url, fallback_url, auto_switch, api_key, username, password, category, icon_url, enabled, sort_order, poll_interval, allowed_groups, extra, created_at)
    VALUES (:type, :name, :url, :fallback_url, :auto_switch, :api_key, :username, :password, :category, :icon_url, :enabled, :sort_order, :poll_interval, :allowed_groups, :extra, :created_at)`),
  serviceUpdate: db.prepare(`UPDATE services SET type=:type, name=:name, url=:url, fallback_url=:fallback_url, auto_switch=:auto_switch,
    api_key=:api_key, username=:username,
    password=:password, category=:category, icon_url=:icon_url, enabled=:enabled, sort_order=:sort_order,
    poll_interval=:poll_interval, allowed_groups=:allowed_groups, extra=:extra WHERE id=:id`),
  serviceDelete: db.prepare('DELETE FROM services WHERE id = :id'),
  serviceMaxOrder: db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM services'),

  settingGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingSet: db.prepare(`INSERT INTO settings (key, value) VALUES (:key, :value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
};

// Upgrade TOTP secrets written by pre-v1.1.4 releases to the same AES-GCM
// envelope used for service credentials.
try {
  const rows = db.prepare("SELECT id, totp_secret FROM users WHERE totp_secret <> ''").all();
  for (const row of rows) {
    if (!String(row.totp_secret).startsWith('enc1:')) {
      db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(encryptSecret(row.totp_secret), row.id);
    }
  }
} catch { /* do not make startup fail on a legacy/corrupt row */ }

export function getUserByName(username) { return stmts.userByName.get(String(username ?? '').trim()) || null; }
export function getUserById(id) { return stmts.userById.get(id) || null; }
export function getUserPrefs(user) { return safeJsonParse(user?.prefs, {}); }
export function setSetting(key, obj) {
  stmts.settingSet.run({ key, value: JSON.stringify(obj ?? {}) });
}
export function getSetting(key, fallback = {}) {
  const row = stmts.settingGet.get(key);
  if (!row) return fallback;
  return safeJsonParse(row.value, fallback);
}
