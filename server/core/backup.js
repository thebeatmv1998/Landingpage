// Passphrase-encrypted configuration backups (services incl. secrets + settings).
import crypto from 'node:crypto';

const N = 65536, R = 8, P = 1;
const MAXMEM = 256 * 1024 * 1024;

function deriveKey(passphrase, salt, n = N) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: n, r: R, p: P, maxmem: MAXMEM });
}

export function encryptBackup(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    format: 'homedeck-backup',
    version: 2,
    createdAt: new Date().toISOString(),
    kdf: 'scrypt',
    n: N,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptBackup(obj, passphrase) {
  if (!obj || obj.format !== 'homedeck-backup' || !obj.salt || !obj.iv || !obj.tag || !obj.data) {
    throw new Error('Not a HomeDeck backup file');
  }
  try {
    // v1 backups did not store N and used 16384; accept them for migration.
    const n = Number(obj.n) || 16384;
    if (!Number.isInteger(n) || n < 16384 || n > 131072) throw new Error('unsupported KDF parameters');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveKey(passphrase, Buffer.from(obj.salt, 'base64'), n),
      Buffer.from(obj.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(obj.tag, 'base64'));
    const json = Buffer.concat([decipher.update(Buffer.from(obj.data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(json);
  } catch {
    throw new Error('Wrong passphrase or corrupted backup');
  }
}
