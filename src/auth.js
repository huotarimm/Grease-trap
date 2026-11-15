import crypto from 'node:crypto';
import { one, run } from './db.js';

const SESSION_DAYS = 30;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const hb = Buffer.from(h, 'hex');
  const c = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), hb.length);
  return crypto.timingSafeEqual(hb, c);
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(res, userId, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)', token, userId, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

export function destroySession(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) run('DELETE FROM sessions WHERE token = ?', sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

export function loadUser(req, _res, next) {
  const sid = parseCookies(req).sid;
  if (sid) {
    req.user = one(`SELECT u.id, u.name, u.email, u.role, u.org_id, o.name AS org_name, o.type AS org_type
      FROM sessions s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id
      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`, sid, Date.now());
  }
  next();
}

export const isRegulator = (u) => u?.role === 'regulator';

export function requireAuth(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).send('Not allowed');
    next();
  };
}
