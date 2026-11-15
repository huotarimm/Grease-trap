const DAY = 864e5;
export const DUE_SOON_DAYS = 14;
// Many FOG bylaws / codes of practice use "FOG + solids >= 25% of liquid depth" as the
// must-pump threshold. Configurable so each regulator can set its own rule.
export const PCT_FULL_THRESHOLD = Number(process.env.PCT_FULL_THRESHOLD || 25);
export const GPS_FLAG_M = Number(process.env.GPS_FLAG_M || 250);

export const STATUS_LABELS = { ok: 'Compliant', due: 'Due soon', overdue: 'Overdue', never: 'Never serviced' };

export function facilityStatus(f, now = Date.now()) {
  if (!f.last_service) return { code: 'never', label: 'No service on record', due: null, days: null };
  const due = new Date(Date.parse(f.last_service) + f.frequency_days * DAY);
  const days = Math.floor((due - now) / DAY);
  if (days < 0) return { code: 'overdue', label: `Overdue ${-days} d`, due, days };
  if (days <= DUE_SOON_DAYS) return { code: 'due', label: `Due in ${days} d`, due, days };
  return { code: 'ok', label: 'Compliant', due, days };
}

export function pctFull(liquid, fog, solids) {
  const l = Number(liquid), f = Number(fog) || 0, s = Number(solids) || 0;
  if (!l || l <= 0) return null;
  return Math.round(((f + s) / l) * 1000) / 10;
}

export function haversineM(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null || v === '' || Number.isNaN(Number(v)))) return null;
  const R = 6371000, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
