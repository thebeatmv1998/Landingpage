import crypto from 'node:crypto';

// Subsonic/Navidrome token authentication: t = md5(password + salt), plus a
// random salt. Used by the connector and by the authenticated cover-art proxy.
export function signSubsonic(path, username, password, params = {}) {
  const salt = crypto.randomBytes(8).toString('hex');
  const token = crypto.createHash('md5').update(`${password ?? ''}${salt}`).digest('hex');
  const sp = new URLSearchParams({
    u: String(username ?? ''),
    t: token,
    s: salt,
    v: '1.16.1',
    c: 'HomeDeck',
    f: 'json',
    ...params,
  });
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${sp.toString()}`;
}
