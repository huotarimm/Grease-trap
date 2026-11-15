import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'traplog.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

db.exec(`
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('regulator','contractor')),
  phone TEXT, email TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('regulator','admin','tech')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY,
  site_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  municipality TEXT,
  lat REAL, lng REAL,
  contact_name TEXT, contact_phone TEXT,
  trap_type TEXT,
  trap_size_l INTEGER,
  trap_location TEXT,
  frequency_days INTEGER NOT NULL DEFAULT 90,
  contractor_org_id INTEGER REFERENCES orgs(id),
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS service_records (
  id INTEGER PRIMARY KEY,
  ref TEXT UNIQUE,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  contractor_org_id INTEGER NOT NULL REFERENCES orgs(id),
  tech_user_id INTEGER NOT NULL REFERENCES users(id),
  completed_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  lat REAL, lng REAL, gps_accuracy_m REAL, gps_distance_m REAL,
  liquid_depth_in REAL, fog_depth_in REAL, solids_depth_in REAL, pct_full REAL,
  volume_l REAL,
  condition TEXT NOT NULL CHECK (condition IN ('good','minor','deficient')),
  damage_notes TEXT,
  after_hours INTEGER NOT NULL DEFAULT 0,
  disposal_site TEXT, manifest_no TEXT,
  onsite_contact TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES service_records(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER,
  sha256 TEXT NOT NULL,
  captured_at TEXT,
  uploaded_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT, entity_id INTEGER,
  detail TEXT,
  at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_rec_fac ON service_records(facility_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_rec_org ON service_records(contractor_org_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_photo_rec ON photos(record_id);
CREATE INDEX IF NOT EXISTS idx_fac_org ON facilities(contractor_org_id);
`);

// node:sqlite rejects `undefined`; normalise to null.
const norm = (p) => p.map((v) => (v === undefined ? null : v));
export const one = (sql, ...p) => db.prepare(sql).get(...norm(p));
export const all = (sql, ...p) => db.prepare(sql).all(...norm(p));
export const run = (sql, ...p) => db.prepare(sql).run(...norm(p));

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function audit(userId, action, entity, entityId, detail) {
  run('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)',
    userId ?? null, action, entity ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null);
}
