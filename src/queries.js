import { all, one } from './db.js';
import { facilityStatus } from './compliance.js';
import { isRegulator } from './auth.js';

const FAC_SELECT = `
SELECT f.*, o.name AS contractor_name,
  (SELECT MAX(completed_at) FROM service_records r WHERE r.facility_id = f.id) AS last_service,
  (SELECT condition FROM service_records r WHERE r.facility_id = f.id ORDER BY completed_at DESC LIMIT 1) AS last_condition,
  (SELECT pct_full FROM service_records r WHERE r.facility_id = f.id ORDER BY completed_at DESC LIMIT 1) AS last_pct_full,
  (SELECT COUNT(*) FROM service_records r WHERE r.facility_id = f.id) AS service_count
FROM facilities f LEFT JOIN orgs o ON o.id = f.contractor_org_id`;

// Local (Pacific) midnight for a YYYY-MM-DD, DST-aware.
export function localMidnight(ymd) {
  for (const off of ['-08:00', '-07:00']) {
    const d = new Date(`${ymd}T00:00:00${off}`);
    const hh = d.toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour: '2-digit', hourCycle: 'h23' });
    if (hh === '00') return d;
  }
  return new Date(`${ymd}T00:00:00-08:00`);
}

const withStatus = (f) => ({ ...f, status: facilityStatus(f) });

/** Facilities visible to a user, with compliance status. Filters: q, status, municipality, contractor */
export function listFacilities(user, filters = {}) {
  const where = ['f.active = 1'];
  const p = [];
  if (!isRegulator(user)) { where.push('f.contractor_org_id = ?'); p.push(user.org_id); }
  if (filters.q) {
    where.push('(f.name LIKE ? OR f.address LIKE ? OR f.site_code LIKE ?)');
    const like = `%${filters.q}%`; p.push(like, like, like);
  }
  if (filters.municipality) { where.push('f.municipality = ?'); p.push(filters.municipality); }
  if (filters.contractor) {
    if (filters.contractor === 'none') where.push('f.contractor_org_id IS NULL');
    else { where.push('f.contractor_org_id = ?'); p.push(Number(filters.contractor)); }
  }
  let rows = all(`${FAC_SELECT} WHERE ${where.join(' AND ')} ORDER BY f.name`, ...p).map(withStatus);
  if (filters.status) rows = rows.filter((f) => f.status.code === filters.status ||
    (filters.status === 'attention' && ['overdue', 'never'].includes(f.status.code)) ||
    (filters.status === 'deficient' && f.last_condition === 'deficient'));
  return rows;
}

export function getFacility(user, id) {
  const f = one(`${FAC_SELECT} WHERE f.id = ?`, Number(id));
  if (!f) return null;
  if (!isRegulator(user) && f.contractor_org_id !== user.org_id) return null;
  return withStatus(f);
}

export const sortByUrgency = (rows) => [...rows].sort((a, b) => {
  const rank = { overdue: 0, never: 1, due: 2, ok: 3 };
  return rank[a.status.code] - rank[b.status.code] || (a.status.days ?? -1e9) - (b.status.days ?? -1e9);
});

const REC_SELECT = `
SELECT r.*, f.name AS facility_name, f.address AS facility_address, f.municipality, f.site_code,
  o.name AS contractor_name, u.name AS tech_name,
  (SELECT COUNT(*) FROM photos p WHERE p.record_id = r.id) AS photo_count
FROM service_records r
JOIN facilities f ON f.id = r.facility_id
JOIN orgs o ON o.id = r.contractor_org_id
JOIN users u ON u.id = r.tech_user_id`;

/** Service records visible to a user. Filters: from, to (YYYY-MM-DD), municipality, contractor, facility, condition, q */
export function listRecords(user, filters = {}, limit = 500) {
  const where = ['1=1'];
  const p = [];
  if (!isRegulator(user)) { where.push('r.contractor_org_id = ?'); p.push(user.org_id); }
  if (user.role === 'tech' && filters.mine) { where.push('r.tech_user_id = ?'); p.push(user.id); }
  if (filters.from) { where.push('r.completed_at >= ?'); p.push(localMidnight(filters.from).toISOString()); }
  if (filters.to) { where.push('r.completed_at < ?'); p.push(new Date(localMidnight(filters.to).getTime() + 864e5).toISOString()); }
  if (filters.municipality) { where.push('f.municipality = ?'); p.push(filters.municipality); }
  if (filters.contractor) { where.push('r.contractor_org_id = ?'); p.push(Number(filters.contractor)); }
  if (filters.facility) { where.push('r.facility_id = ?'); p.push(Number(filters.facility)); }
  if (filters.condition) { where.push('r.condition = ?'); p.push(filters.condition); }
  if (filters.q) {
    where.push('(f.name LIKE ? OR r.ref LIKE ? OR f.address LIKE ? OR r.manifest_no LIKE ?)');
    const like = `%${filters.q}%`; p.push(like, like, like, like);
  }
  return all(`${REC_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.completed_at DESC LIMIT ${Number(limit) || 500}`, ...p);
}

export function getRecord(user, id) {
  const r = one(`${REC_SELECT} WHERE r.id = ?`, Number(id));
  if (!r) return null;
  if (!isRegulator(user) && r.contractor_org_id !== user.org_id) return null;
  r.photos = all('SELECT * FROM photos WHERE record_id = ? ORDER BY id', r.id);
  return r;
}

export const municipalities = () => all("SELECT DISTINCT municipality AS m FROM facilities WHERE municipality IS NOT NULL AND municipality <> '' ORDER BY 1").map((r) => r.m);
export const contractors = () => all("SELECT id, name FROM orgs WHERE type = 'contractor' ORDER BY name");
