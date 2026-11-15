// Demo data: a fictional CRD-style regulator, three pumping contractors, ~48 fictional restaurants
// and a year of service history. All business names are made up.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, one, run, tx, UPLOAD_DIR } from './db.js';
import { hashPassword } from './auth.js';
import { pctFull, haversineM } from './compliance.js';
import { STEPS } from './steps.js';

let s = 42;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + rnd() * (b - a);

const MUNIS = {
  Victoria: [48.4284, -123.3656], Saanich: [48.4840, -123.3810], Esquimalt: [48.4320, -123.4140], 'Oak Bay': [48.4265, -123.3170],
  Langford: [48.4500, -123.5050], Colwood: [48.4236, -123.4958], 'View Royal': [48.4520, -123.4330], Sidney: [48.6500, -123.3990],
  'Central Saanich': [48.5600, -123.4100], Sooke: [48.3740, -123.7270],
};
const NAMES = ['Harbourview Noodle House', 'Blue Fern Bistro', 'Cedar & Salt', 'Tidewater Diner', 'Little Gull Café', 'Island Smokehouse', 'Copper Kettle Pub',
  'Saltspray Fish & Chips', 'Garry Oak Grill', 'Red Arbutus Pho', 'Fernwood Pizza Co.', 'Driftwood Taqueria', 'Bayside Burger Bar', 'Northwind Sushi',
  'The Rusty Anchor', 'Quarry Street Kitchen', 'Moss & Stone Eatery', 'Golden Lotus Dim Sum', 'Kelp Forest Ramen', 'Juniper Brunch House', 'Blackberry Bakery',
  'Otter Point Tavern', 'Marigold Curry House', 'Westshore Wings', 'Breakwater Bagels', 'Chinook Grill', 'Cobble Hill Creamery', 'Lantern Dumpling Bar',
  'Starboard Seafood', 'Pacific Rim Poutinerie', 'Beacon Hill Deli', 'Thistle & Thyme', 'Ferry Dock Fryhouse', 'Mount Doug Diner', 'Sooke Harbour Grill',
  'Seaglass Shawarma', 'Highland Hearth', 'Bramble Kitchen', 'Rainshadow Café', 'Spit & Spoon BBQ', 'Bluewater Banh Mi', 'Hatley Hall Catering',
  'Coho Coffee & Kitchen', 'Ironwood Steakhouse', 'Swan Lake Sandwiches', 'Peninsula Pierogi', 'Clover Point Cantina', 'Salish Sea Oyster Bar'];
const STREETS = ['Douglas St', 'Fort St', 'Yates St', 'Johnson St', 'Quadra St', 'Cook St', 'Oak Bay Ave', 'Shelbourne St', 'Goldstream Ave', 'Beacon Ave',
  'Esquimalt Rd', 'Sooke Rd', 'Burnside Rd W', 'Admirals Rd', 'Veterans Memorial Pkwy', 'Island Hwy', 'Blanshard St', 'McKenzie Ave'];
const TECH_NOTES = ['', '', '', 'Heavy FOG cap, recommend shorter interval.', 'Staff advised on scraping plates before dish pit.', 'Baffle in good shape.',
  'Outlet tee partially blocked, cleared.', 'Kitchen manager signed off.'];

function demoPhoto(step, label, hue) {
  const dir = path.join(UPLOAD_DIR, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join('demo', `${step}.svg`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},25%,38%)"/><stop offset="1" stop-color="hsl(${hue},30%,18%)"/></linearGradient></defs>
<rect width="800" height="600" fill="url(#g)"/><circle cx="400" cy="280" r="170" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="18"/>
<rect x="250" y="250" width="300" height="60" rx="8" fill="rgba(255,255,255,.12)"/>
<text x="400" y="500" font-family="sans-serif" font-size="30" fill="#fff" text-anchor="middle">DEMO PHOTO</text>
<text x="400" y="540" font-family="sans-serif" font-size="22" fill="rgba(255,255,255,.8)" text-anchor="middle">${label.replace(/&/g, '&amp;')}</text></svg>`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), svg);
  return { file, sha: crypto.createHash('sha256').update(svg).digest('hex'), bytes: Buffer.byteLength(svg) };
}

export function seed() {
  const pw = hashPassword('demo1234');
  const photos = Object.fromEntries(STEPS.map((st, i) => [st.key, demoPhoto(st.key, st.label, 160 + i * 25)]));
  tx(() => {
    const org = (name, type) => Number(run('INSERT INTO orgs (name, type) VALUES (?,?)', name, type).lastInsertRowid);
    const user = (org_id, name, email, role) => Number(run('INSERT INTO users (org_id, name, email, pass_hash, role) VALUES (?,?,?,?,?)', org_id, name, email, pw, role).lastInsertRowid);
    const crd = org('Capital Regional District (demo)', 'regulator');
    user(crd, 'CRD Source Control (demo)', 'crd@demo.test', 'regulator');
    const fcf = org('First Class Facilities', 'contractor');
    user(fcf, 'FCF Office (demo)', 'admin@fcf.demo.test', 'admin');
    const contractors = [
      { org: fcf, techs: [user(fcf, 'Demo Tech A', 'tech@fcf.demo.test', 'tech'), user(fcf, 'Demo Tech B', 'tech2@fcf.demo.test', 'tech')], share: 0.5 },
    ];
    const o2 = org('Island Pump & Vac (demo)', 'contractor');
    contractors.push({ org: o2, techs: [user(o2, 'IPV Tech (demo)', 'tech@ipv.demo.test', 'tech')], share: 0.3 });
    const o3 = org('Harbour Liquid Waste (demo)', 'contractor');
    contractors.push({ org: o3, techs: [user(o3, 'HLW Tech (demo)', 'tech@hlw.demo.test', 'tech')], share: 0.2 });

    const now = Date.now();
    let n = 0;
    for (const name of NAMES) {
      n++;
      const muni = pick(Object.keys(MUNIS));
      const [clat, clng] = MUNIS[muni];
      const lat = clat + between(-0.012, 0.012), lng = clng + between(-0.018, 0.018);
      const r = rnd();
      const c = r < 0.5 ? contractors[0] : r < 0.8 ? contractors[1] : contractors[2];
      const unassigned = n % 17 === 0;
      const freq = pick([30, 60, 90, 90, 90, 120]);
      const code = crypto.createHash('md5').update(name).digest('hex').slice(0, 5).toUpperCase();
      const fid = Number(run(`INSERT INTO facilities (site_code, name, address, municipality, lat, lng, contact_name, contact_phone, trap_type, trap_size_l, trap_location, frequency_days, contractor_org_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, code, name, `${Math.floor(between(100, 3999))} ${pick(STREETS)}`, muni, lat, lng,
        pick(['Kitchen manager', 'Owner', 'Chef']), `250-555-${String(Math.floor(between(1000, 9999)))}`, pick(['interceptor', 'interceptor', 'under_sink', 'gravity']),
        pick([95, 190, 380, 750, 1900]), pick(['Kitchen floor by dish pit', 'Under 3-compartment sink', 'Back parking lot', 'Basement mechanical room']),
        freq, unassigned ? null : c.org).lastInsertRowid);

      if (unassigned || n % 11 === 0) continue; // never serviced
      // service history over the last year; some sites stopped being serviced (overdue)
      const lapse = n % 5 === 0 ? between(1.3, 3) * freq : 0;
      let t = now - 365 * 864e5 + between(0, freq) * 864e5;
      while (t < now - lapse * 864e5) {
        const liquid = Math.round(between(28, 48));
        const fog = Math.round(between(1, freq > 60 ? 9 : 5) * 2) / 2;
        const solids = Math.round(between(2, freq > 60 ? 12 : 7) * 2) / 2;
        const cond = rnd() < 0.07 ? 'deficient' : rnd() < 0.12 ? 'minor' : 'good';
        const tech = pick(c.techs);
        const glat = lat + between(-0.0004, 0.0004) + (rnd() < 0.03 ? 0.01 : 0), glng = lng + between(-0.0004, 0.0004);
        const at = new Date(t).toISOString();
        const rid = Number(run(`INSERT INTO service_records (facility_id, contractor_org_id, tech_user_id, completed_at, submitted_at, lat, lng, gps_accuracy_m, gps_distance_m,
          liquid_depth_in, fog_depth_in, solids_depth_in, pct_full, volume_l, condition, damage_notes, after_hours, disposal_site, manifest_no, onsite_contact, notes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, fid, c.org, tech, at, at, glat, glng, Math.round(between(4, 20)), haversineM(glat, glng, lat, lng),
          liquid, fog, solids, pctFull(liquid, fog, solids), Math.round(between(80, 1600)), cond,
          cond === 'good' ? null : pick(['Cracked baffle wall', 'Lid gasket worn, odour escaping', 'Inlet tee missing', 'Lid cracked: trip hazard']),
          rnd() < 0.3 ? 1 : 0, 'Demo receiving facility', `M-${Math.floor(between(10000, 99999))}`, pick(['Sam (manager)', 'Kitchen lead', '', 'Owner']), pick(TECH_NOTES)).lastInsertRowid);
        run('UPDATE service_records SET ref = ? WHERE id = ?', `GT-${at.slice(0, 4)}-${String(rid).padStart(6, '0')}`, rid);
        for (const st of STEPS) {
          if (!st.required && !(st.key === 'damage' && cond !== 'good')) continue;
          const p = photos[st.key];
          run('INSERT INTO photos (record_id, step, filename, mime, bytes, sha256, captured_at, uploaded_at) VALUES (?,?,?,?,?,?,?,?)', rid, st.key, p.file, 'image/svg+xml', p.bytes, p.sha, at, at);
        }
        t += (freq + between(-10, 12)) * 864e5;
      }
    }
  });
}

export function seedIfEmpty() {
  if (process.env.SEED_DEMO === '0') return;
  if (!one('SELECT 1 FROM orgs LIMIT 1')) {
    seed();
    console.log('Seeded demo data (password for all demo users: demo1234)');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--reset')) {
    db.exec('DELETE FROM photos; DELETE FROM service_records; DELETE FROM sessions; DELETE FROM audit_log; DELETE FROM facilities; DELETE FROM users; DELETE FROM orgs;');
  }
  if (!one('SELECT 1 FROM orgs LIMIT 1')) { seed(); console.log('Seeded demo data.'); } else console.log('Database not empty; use --reset.');
}
