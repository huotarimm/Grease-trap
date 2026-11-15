// End-to-end smoke test against a running server: BASE=http://localhost:3000 npm run smoke
const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

async function login(email) {
  const r = await fetch(`${BASE}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ email, password: 'demo1234', next: '/' }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  ok(cookie.startsWith('sid=') && cookie.length > 10, `login ${email}`);
  return (path, opts = {}) => fetch(BASE + path, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
}

const jpeg = () => new Blob([Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')], { type: 'image/jpeg' });

const tech = await login('tech@fcf.demo.test');
const home = await (await tech('/')).text();
const fid = Number(home.match(/\/service\/new\?facility=(\d+)/)[1]);
ok(fid > 0, 'tech sees assigned sites');

// missing photos rejected
let fd = new FormData();
fd.append('facility_id', fid);
let r = await tech('/service', { method: 'POST', body: fd, headers: { 'x-requested-with': 'fetch' } });
ok(r.status === 400 && /Missing photos/.test((await r.json()).error), 'submission without photos is rejected');

// full submission
fd = new FormData();
Object.entries({ facility_id: fid, lat: '48.43', lng: '-123.37', gps_accuracy_m: '8', liquid_depth_in: '36', fog_depth_in: '4', solids_depth_in: '6',
  condition: 'good', volume_l: '400', disposal_site: 'Test site', manifest_no: 'M-1', notes: 'smoke test' }).forEach(([k, v]) => fd.append(k, v));
for (const step of ['before_closed', 'under_lid', 'full_before', 'after_clean', 'closed_after']) fd.append(`photo_${step}`, jpeg(), `${step}_${Date.now()}.jpg`);
r = await tech('/service', { method: 'POST', body: fd, headers: { 'x-requested-with': 'fetch' } });
const body = await r.json();
ok(r.status === 200 && body.url, 'complete service submitted');
const recId = body.url.match(/records\/(\d+)/)[1];

const crd = await login('crd@demo.test');
const rec = await (await crd(`/records/${recId}`)).text();
ok(/GT-\d{4}-\d{6}/.test(rec) && /SHA-256/.test(rec) && /27.8%/.test(rec), 'CRD sees the new report with photos and % full');
const photoId = rec.match(/\/photos\/(\d+)/)[1];
ok((await crd(`/photos/${photoId}`)).status === 200, 'CRD can open the photo');

const other = await login('tech@ipv.demo.test');
ok((await other(`/records/${recId}`)).status === 404, 'another contractor cannot see the report');
ok((await other(`/photos/${photoId}`)).status === 404, 'another contractor cannot see the photo');

for (const p of ['/', '/facilities', '/records', '/contractors', '/reports', `/facilities/${fid}`]) ok((await crd(p)).status === 200, `CRD page ${p}`);
const csvText = await (await crd('/records.csv')).text();
ok(csvText.startsWith('Ref,') && csvText.includes('Test site'), 'CSV export includes new record');
ok((await tech('/reports')).status === 403, 'tech cannot open regulator reports');
ok((await fetch(`${BASE}/facilities`, { redirect: 'manual' })).status === 302, 'anonymous user redirected to login');

const admin = await login('admin@fcf.demo.test');
for (const p of ['/', '/facilities', '/records', '/team', '/facilities/new']) ok((await admin(p)).status === 200, `admin page ${p}`);

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
