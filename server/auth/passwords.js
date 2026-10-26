import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// 64 MiB scrypt work factor (N=2^16, r=8, p=1). Existing hashes with the
// old N=16384 still verify because N/r/p are stored in the hash string.
const N = 65536, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(String(password), salt, expected.length, {
      N: parseInt(nStr, 10), r: parseInt(rStr, 10), p: parseInt(pStr, 10), maxmem: MAXMEM,
    });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456789012', 'qwertyuiop12',
  'letmein12345', 'homedeck1234', 'admin1234567', 'changeme1234',
]);

export function passwordIssues(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Password must be at least 12 characters';
  if (pw.length > 200) return 'Password too long';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'Choose a less common passphrase';
  return null;
}
