import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { one, all, run, tx, audit, UPLOAD_DIR } from './db.js';
import { loadUser, requireAuth, isRegulator, verifyPassword, hashPassword, createSession, destroySession } from './auth.js';
import { pctFull, haversineM, PCT_FULL_THRESHOLD, GPS_FLAG_M, STATUS_LABELS, DUE_SOON_DAYS } from './compliance.js';
import { STEPS, STEP_BY_KEY, CONDITIONS } from './steps.js';
import { listFacilities, getFacility, listRecords, getRecord, sortByUrgency, municipalities, contractors } from './queries.js';
import { html, raw, layout, badge, condBadge, fmtDate, fmtDateTime, isoDay, csv, APP_NAME } from './views.js';
import { seedIfEmpty } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(loadUser);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 40 } });
const page = (req, res, opts) => res.send(layout({ user: req.user, ...opts }));
const num = (v) => (v === undefined || v === null || String(v).trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? null : String(v).trim() || null);
const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v)).toString();
const canManage = (u) => u.role === 'regulator' || u.role === 'admin';

// ---------------------------------------------------------------- auth
app.get('/login', (req, res) => {
  const next = String(req.query.next || '/');
  page(req, res, {
    title: 'Sign in',
    body: html`<div class="login card">
      <h1>${APP_NAME}</h1>
      <p class="muted">Grease trap service records with photo proof, for service companies and the regional district.</p>
      ${req.query.err ? html`<div class="flash err">Email or password is incorrect.</div>` : ''}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${next}">
        <label>Email <input name="email" type="email" autocomplete="username" required autofocus></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary wide">Sign in</button>
      </form>
      ${process.env.SEED_DEMO !== '0' ? html`<details class="demo"><summary>Demo logins</summary>
        <table class="mini"><tr><td>CRD (regulator)</td><td>crd@demo.test</td></tr>
        <tr><td>FCF office admin</td><td>admin@fcf.demo.test</td></tr>
        <tr><td>FCF technician</td><td>tech@fcf.demo.test</td></tr></table>
        <p class="muted small">Password for all: <code>demo1234</code></p></details>` : ''}
    </div>`,
  });
});

app.post('/login', (req, res) => {
  const u = one('SELECT * FROM users WHERE email = ? AND active = 1', String(req.body.email || '').trim());
  if (!u || !verifyPassword(req.body.password || '', u.pass_hash)) {
    return res.redirect('/login?err=1&next=' + encodeURIComponent(req.body.next || '/'));
  }
  createSession(res, u.id, req.secure);
  audit(u.id, 'login', 'user', u.id);
  const next = String(req.body.next || '/');
  res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
});

app.post('/logout', (req, res) => { destroySession(req, res); res.redirect('/login'); });

// ---------------------------------------------------------------- shared bits
function statusTable(rows, { showContractor = true, action } = {}) {
  if (!rows.length) return html`<p class="muted">No facilities match.</p>`;
  return html`<div class="tablewrap"><table class="list">
    <thead><tr><th>Facility</th><th>Municipality</th>${showContractor ? html`<th>Contractor</th>` : ''}
      <th>Every</th><th>Last service</th><th>Next due</th><th>Status</th>${action ? html`<th></th>` : ''}</tr></thead>
    <tbody>${rows.map((f) => html`<tr>
      <td><a href="/facilities/${f.id}"><b>${f.name}</b></a><div class="small muted">${f.address}</div></td>
      <td>${f.municipality}</td>
      ${showContractor ? html`<td>${f.contractor_name || html`<span class="muted">Unassigned</span>`}</td>` : ''}
      <td>${f.frequency_days} d</td>
      <td>${f.last_service ? fmtDate(f.last_service) : '—'}${f.last_condition === 'deficient' ? html` ${condBadge('deficient')}` : ''}</td>
      <td>${f.status.due ? fmtDate(f.status.due) : '—'}</td>
      <td>${badge(f.status.code, f.status.label)}</td>
      ${action ? html`<td>${action(f)}</td>` : ''}
    </tr>`)}</tbody></table></div>`;
}

function recordTable(rows, { showContractor = true } = {}) {
  if (!rows.length) return html`<p class="muted">No service records match.</p>`;
  return html`<div class="tablewrap"><table class="list">
    <thead><tr><th>Ref</th><th>Completed</th><th>Facility</th>${showContractor ? html`<th>Contractor</th>` : ''}<th>Tech</th>
      <th>% full</th><th>Condition</th><th>Photos</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr>
      <td><a href="/records/${r.id}"><b>${r.ref}</b></a></td>
      <td>${fmtDateTime(r.completed_at)}</td>
      <td><a href="/facilities/${r.facility_id}">${r.facility_name}</a><div class="small muted">${r.municipality}</div></td>
      ${showContractor ? html`<td>${r.contractor_name}</td>` : ''}
      <td>${r.tech_name}</td>
      <td>${r.pct_full != null ? html`<span class="${r.pct_full >= PCT_FULL_THRESHOLD ? 'warn' : ''}">${r.pct_full}%</span>` : '—'}</td>
      <td>${condBadge(r.condition)}</td>
      <td>${r.photo_count}</td>
    </tr>`)}</tbody></table></div>`;
}

const options = (list, selected, blank = 'All') => html`<option value="">${blank}</option>${list.map(([v, l]) =>
  html`<option value="${v}" ${String(v) === String(selected ?? '') ? raw('selected') : ''}>${l}</option>`)}`;

function kpis(rows) {
  const c = { ok: 0, due: 0, overdue: 0, never: 0 };
  rows.forEach((f) => c[f.status.code]++);
  const deficient = rows.filter((f) => f.last_condition === 'deficient').length;
  const pct = rows.length ? Math.round((c.ok + c.due) / rows.length * 100) : 0;
  return { c, deficient, pct, total: rows.length };
}

function kpiTiles(k, base = '/facilities') {
  return html`<div class="kpis">
    <a class="kpi" href="${base}"><span>${k.total}</span>Facilities</a>
    <a class="kpi k-ok" href="${base}?status=ok"><span>${k.c.ok}</span>Compliant</a>
    <a class="kpi k-due" href="${base}?status=due"><span>${k.c.due}</span>Due ≤ ${DUE_SOON_DAYS} d</a>
    <a class="kpi k-overdue" href="${base}?status=overdue"><span>${k.c.overdue}</span>Overdue</a>
    <a class="kpi k-never" href="${base}?status=never"><span>${k.c.never}</span>Never serviced</a>
    <a class="kpi k-def" href="${base}?status=deficient"><span>${k.deficient}</span>Open deficiencies</a>
  </div>`;
}

// ---------------------------------------------------------------- home / dashboards
app.get('/', requireAuth(), (req, res) => {
  const u = req.user;
  const facs = listFacilities(u);

  if (u.role === 'tech') {
    const q = String(req.query.q || '').trim();
    const list = sortByUrgency(q ? listFacilities(u, { q }) : facs);
    return page(req, res, {
      title: 'My sites', active: '/',
      body: html`<h1>Sites</h1>
      <form class="search" method="get"><input name="q" value="${q}" placeholder="Search name, address or site code" type="search"><button class="btn">Search</button></form>
      <div class="cards">${list.map((f) => html`<div class="sitecard s-${f.status.code}">
        <div><b>${f.name}</b><div class="small muted">${f.address}, ${f.municipality}</div>
        <div class="small">${badge(f.status.code, f.status.label)} <span class="muted">Last: ${f.last_service ? fmtDate(f.last_service) : 'never'}</span></div></div>
        <a class="btn primary" href="/service/new?facility=${f.id}">Start service</a></div>`)}
      </div>${list.length ? '' : html`<p class="muted">No sites found.</p>`}`,
    });
  }

  const k = kpis(facs);
  const recent = listRecords(u, {}, 10);
  const since30 = listRecords(u, { from: isoDay(Date.now() - 30 * 864e5) }, 100000).length;
  const urgent = sortByUrgency(facs).filter((f) => f.status.code !== 'ok').slice(0, 15);

  let byMuni = '';
  if (isRegulator(u)) {
    const m = {};
    for (const f of facs) {
      const key = f.municipality || '—';
      m[key] ??= { total: 0, ok: 0, due: 0, overdue: 0, never: 0 };
      m[key].total++; m[key][f.status.code]++;
    }
    byMuni = html`<section class="card"><h2>By municipality</h2><div class="tablewrap"><table class="list">
      <thead><tr><th>Municipality</th><th>Facilities</th><th>Compliant</th><th>Due soon</th><th>Overdue</th><th>Never</th><th>Compliance</th></tr></thead>
      <tbody>${Object.entries(m).sort().map(([name, v]) => {
        const pct = Math.round((v.ok + v.due) / v.total * 100);
        return html`<tr><td><a href="/facilities?municipality=${encodeURIComponent(name)}">${name}</a></td><td>${v.total}</td><td>${v.ok}</td><td>${v.due}</td>
          <td>${v.overdue}</td><td>${v.never}</td><td><div class="bar"><i style="width:${pct}%"></i></div> ${pct}%</td></tr>`;
      })}</tbody></table></div></section>`;
  }

  page(req, res, {
    title: 'Dashboard', active: '/',
    body: html`<div class="row between"><h1>${isRegulator(u) ? 'Regional compliance' : `${u.org_name}: service book`}</h1>
      <span class="muted">${k.pct}% of facilities in compliance · ${since30} services in last 30 days</span></div>
      ${kpiTiles(k)}
      ${byMuni}
      <section class="card"><div class="row between"><h2>Needs attention</h2><a href="/facilities?status=attention">See all →</a></div>
        ${statusTable(urgent, { showContractor: isRegulator(u) })}</section>
      <section class="card"><div class="row between"><h2>Latest services</h2><a href="/records">See all →</a></div>
        ${recordTable(recent, { showContractor: isRegulator(u) })}</section>`,
  });
});

// ---------------------------------------------------------------- facilities
app.get('/facilities', requireAuth('regulator', 'admin'), (req, res) => {
  const u = req.user;
  const f = { q: str(req.query.q), status: str(req.query.status), municipality: str(req.query.municipality), contractor: isRegulator(u) ? str(req.query.contractor) : null };
  const rows = sortByUrgency(listFacilities(u, f));
  page(req, res, {
    title: 'Facilities', active: '/facilities',
    body: html`<div class="row between"><h1>Facilities</h1>
      <div class="row"><a class="btn" href="/facilities.csv?${qs(f)}">Export CSV</a><a class="btn primary" href="/facilities/new">+ Add facility</a></div></div>
      <form class="filters" method="get">
        <input name="q" type="search" placeholder="Name, address, site code" value="${f.q}">
        <select name="status">${options([...Object.entries(STATUS_LABELS), ['attention', 'Overdue + never'], ['deficient', 'Deficient on last visit']], f.status, 'Any status')}</select>
        <select name="municipality">${options(municipalities().map((m) => [m, m]), f.municipality, 'All municipalities')}</select>
        ${isRegulator(u) ? html`<select name="contractor">${options([...contractors().map((c) => [c.id, c.name]), ['none', 'Unassigned']], f.contractor, 'All contractors')}</select>` : ''}
        <button class="btn">Filter</button>
      </form>
      <p class="muted small">${rows.length} facilities</p>
      ${statusTable(rows, { showContractor: isRegulator(u) })}`,
  });
});

app.get('/facilities.csv', requireAuth('regulator', 'admin'), (req, res) => {
  const u = req.user;
  const rows = sortByUrgency(listFacilities(u, { q: str(req.query.q), status: str(req.query.status), municipality: str(req.query.municipality), contractor: isRegulator(u) ? str(req.query.contractor) : null }));
  res.type('text/csv').attachment(`facility-compliance-${isoDay(Date.now())}.csv`).send(csv(rows, [
    ['Site code', (f) => f.site_code], ['Facility', (f) => f.name], ['Address', (f) => f.address], ['Municipality', (f) => f.municipality],
    ['Contractor', (f) => f.contractor_name], ['Frequency (days)', (f) => f.frequency_days],
    ['Last service', (f) => f.last_service ? isoDay(f.last_service) : ''], ['Next due', (f) => f.status.due ? isoDay(f.status.due) : ''],
    ['Status', (f) => STATUS_LABELS[f.status.code]], ['Last condition', (f) => f.last_condition], ['Last % full', (f) => f.last_pct_full],
    ['Services on record', (f) => f.service_count],
  ]));
});

function facilityForm(f = {}, u) {
  const cs = contractors();
  return html`<form method="post" class="grid2">
    <label>Facility / business name <input name="name" required value="${f.name}"></label>
    <label>Street address <input name="address" value="${f.address}"></label>
    <label>Municipality <input name="municipality" list="munis" value="${f.municipality}"><datalist id="munis">${municipalities().map((m) => html`<option value="${m}">`)}</datalist></label>
    <label>Service frequency (days) <input name="frequency_days" type="number" min="7" max="730" value="${f.frequency_days ?? 90}" required></label>
    <label>Contact name <input name="contact_name" value="${f.contact_name}"></label>
    <label>Contact phone <input name="contact_phone" value="${f.contact_phone}"></label>
    <label>Trap type <select name="trap_type">${options([['interceptor', 'In-ground interceptor'], ['under_sink', 'Under-sink trap'], ['gravity', 'Gravity grease interceptor (large)'], ['other', 'Other']], f.trap_type, '—')}</select></label>
    <label>Trap capacity (L) <input name="trap_size_l" type="number" min="0" value="${f.trap_size_l}"></label>
    <label>Trap location on site <input name="trap_location" value="${f.trap_location}" placeholder="e.g. kitchen floor by dish pit"></label>
    ${isRegulator(u) ? html`<label>Servicing contractor <select name="contractor_org_id">${options(cs.map((c) => [c.id, c.name]), f.contractor_org_id, 'Unassigned')}</select></label>` : ''}
    <label>Latitude <input name="lat" inputmode="decimal" value="${f.lat}"></label>
    <label>Longitude <input name="lng" inputmode="decimal" value="${f.lng}"></label>
    <label class="span2">Notes <textarea name="notes" rows="3">${f.notes}</textarea></label>
    <div class="span2 row"><button class="btn primary">Save facility</button><a class="btn" href="${f.id ? `/facilities/${f.id}` : '/facilities'}">Cancel</a></div>
  </form>`;
}

function readFacilityForm(body, u) {
  const v = {
    name: str(body.name), address: str(body.address), municipality: str(body.municipality),
    frequency_days: Math.max(7, Math.min(730, num(body.frequency_days) || 90)),
    contact_name: str(body.contact_name), contact_phone: str(body.contact_phone), trap_type: str(body.trap_type),
    trap_size_l: num(body.trap_size_l), trap_location: str(body.trap_location), lat: num(body.lat), lng: num(body.lng), notes: str(body.notes),
  };
  v.contractor_org_id = isRegulator(u) ? num(body.contractor_org_id) : u.org_id;
  return v;
}

const newSiteCode = () => {
  for (;;) {
    const c = crypto.randomBytes(4).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5);
    if (c.length === 5 && !one('SELECT 1 FROM facilities WHERE site_code = ?', c)) return c;
  }
};

app.get('/facilities/new', requireAuth('regulator', 'admin'), (req, res) => {
  page(req, res, { title: 'Add facility', active: '/facilities', body: html`<h1>Add facility</h1><div class="card">${facilityForm({}, req.user)}</div>` });
});

app.post('/facilities/new', requireAuth('regulator', 'admin'), (req, res) => {
  const v = readFacilityForm(req.body, req.user);
  if (!v.name) return res.status(400).send('Name required');
  const r = run(`INSERT INTO facilities (site_code, name, address, municipality, frequency_days, contact_name, contact_phone, trap_type, trap_size_l, trap_location, lat, lng, notes, contractor_org_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, newSiteCode(), v.name, v.address, v.municipality, v.frequency_days, v.contact_name, v.contact_phone,
    v.trap_type, v.trap_size_l, v.trap_location, v.lat, v.lng, v.notes, v.contractor_org_id, req.user.id);
  audit(req.user.id, 'facility.create', 'facility', Number(r.lastInsertRowid), v);
  res.redirect(`/facilities/${r.lastInsertRowid}`);
});

app.get('/facilities/:id/edit', requireAuth('regulator', 'admin'), (req, res) => {
  const f = getFacility(req.user, req.params.id);
  if (!f) return res.status(404).send('Not found');
  page(req, res, { title: `Edit ${f.name}`, active: '/facilities', body: html`<h1>Edit facility</h1><div class="card">${facilityForm(f, req.user)}</div>` });
});

app.post('/facilities/:id/edit', requireAuth('regulator', 'admin'), (req, res) => {
  const f = getFacility(req.user, req.params.id);
  if (!f) return res.status(404).send('Not found');
  const v = readFacilityForm(req.body, req.user);
  if (!v.name) return res.status(400).send('Name required');
  run(`UPDATE facilities SET name=?, address=?, municipality=?, frequency_days=?, contact_name=?, contact_phone=?, trap_type=?, trap_size_l=?, trap_location=?, lat=?, lng=?, notes=?, contractor_org_id=? WHERE id=?`,
    v.name, v.address, v.municipality, v.frequency_days, v.contact_name, v.contact_phone, v.trap_type, v.trap_size_l, v.trap_location, v.lat, v.lng, v.notes, v.contractor_org_id, f.id);
  audit(req.user.id, 'facility.update', 'facility', f.id, v);
  res.redirect(`/facilities/${f.id}`);
});

app.get('/facilities/:id', requireAuth(), async (req, res) => {
  const u = req.user;
  const f = getFacility(u, req.params.id);
  if (!f) return res.status(404).send('Not found');
  const recs = listRecords(u, { facility: f.id });
  const scanUrl = `${req.protocol}://${req.get('host')}/s/${f.site_code}`;
  const qr = await QRCode.toString(scanUrl, { type: 'svg', margin: 1, width: 160 });
  const trapTypes = { interceptor: 'In-ground interceptor', under_sink: 'Under-sink trap', gravity: 'Gravity grease interceptor', other: 'Other' };
  page(req, res, {
    title: f.name, active: '/facilities',
    body: html`<div class="row between"><div><h1>${f.name}</h1><p class="muted">${f.address}, ${f.municipality} · Site code <b>${f.site_code}</b></p></div>
      <div class="row">${u.role !== 'regulator' ? html`<a class="btn primary" href="/service/new?facility=${f.id}">Start service</a>` : ''}
      ${canManage(u) ? html`<a class="btn" href="/facilities/${f.id}/edit">Edit</a>` : ''}</div></div>
      <div class="grid3">
        <section class="card"><h2>Compliance</h2>
          <p>${badge(f.status.code, f.status.label)}</p>
          <dl><dt>Required every</dt><dd>${f.frequency_days} days</dd>
          <dt>Last service</dt><dd>${fmtDateTime(f.last_service)}</dd>
          <dt>Next due</dt><dd>${f.status.due ? fmtDate(f.status.due) : 'Now'}</dd>
          <dt>Services on record</dt><dd>${f.service_count}</dd></dl></section>
        <section class="card"><h2>Site</h2><dl>
          <dt>Contractor</dt><dd>${f.contractor_name || 'Unassigned'}</dd>
          <dt>Contact</dt><dd>${f.contact_name || '—'} ${f.contact_phone ? html`· <a href="tel:${f.contact_phone}">${f.contact_phone}</a>` : ''}</dd>
          <dt>Trap</dt><dd>${trapTypes[f.trap_type] || '—'}${f.trap_size_l ? ` · ${f.trap_size_l} L` : ''}</dd>
          <dt>Location</dt><dd>${f.trap_location || '—'}</dd></dl>
          ${f.notes ? html`<p class="small">${f.notes}</p>` : ''}</section>
        <section class="card qr"><h2>Lid sticker QR</h2>${raw(qr)}
          <p class="small muted">Print and stick near the trap. Techs scan it to open the right service form, so jobs can't be logged against the wrong restaurant.</p></section>
      </div>
      <section class="card"><h2>Service history</h2>
        ${!isRegulator(u) ? html`<p class="small muted">Showing services performed by ${u.org_name}.</p>` : ''}
        ${recordTable(recs, { showContractor: isRegulator(u) })}</section>`,
  });
});

// QR sticker entry point
app.get('/s/:code', requireAuth(), (req, res) => {
  const f = one('SELECT id FROM facilities WHERE site_code = ?', String(req.params.code).toUpperCase());
  if (!f) return res.status(404).send('Unknown site code');
  res.redirect(req.user.role === 'regulator' ? `/facilities/${f.id}` : `/service/new?facility=${f.id}&via=qr`);
});

// ---------------------------------------------------------------- service capture
app.get('/service/new', requireAuth('admin', 'tech'), (req, res) => {
  const f = getFacility(req.user, req.query.facility);
  if (!f) return res.redirect('/');
  const sites = all('SELECT DISTINCT disposal_site AS s FROM service_records WHERE contractor_org_id = ? AND disposal_site IS NOT NULL ORDER BY 1', req.user.org_id).map((r) => r.s);
  page(req, res, {
    title: `Service: ${f.name}`, active: '/',
    body: html`<div class="svc-head"><a href="/" class="small">← Sites</a><h1>${f.name}</h1>
      <p class="muted">${f.address}, ${f.municipality} · ${f.trap_location || 'trap location not recorded'}</p>
      ${req.query.via === 'qr' ? html`<p class="small ok">✓ Opened from site QR sticker</p>` : ''}</div>
    <form id="svc" method="post" action="/service" enctype="multipart/form-data" novalidate>
      <input type="hidden" name="facility_id" value="${f.id}">
      <input type="hidden" name="lat"><input type="hidden" name="lng"><input type="hidden" name="gps_accuracy_m">
      <input type="hidden" name="via_qr" value="${req.query.via === 'qr' ? '1' : ''}">
      <p id="gps" class="small muted">Getting location…</p>

      <label class="check card"><input type="checkbox" name="after_hours" value="1" id="after_hours"> After-hours / unattended service (requires locked-door photo)</label>

      ${STEPS.map((s, i) => html`<section class="card step" data-step="${s.key}" data-required="${s.required ? '1' : ''}">
        <div class="step-h"><span class="num">${i + 1}</span><div><b>${s.label}</b>${s.required ? html` <span class="req">required</span>` : ''}<div class="small muted">${s.hint}</div></div></div>
        <div class="thumbs"></div>
        <label class="btn camera"><input type="file" accept="image/*" capture="environment" multiple name="photo_${s.key}" hidden> 📷 Add photo</label>
        ${s.key === 'full_before' ? html`<div class="grid3 measure">
          <label>Liquid depth (in) <input name="liquid_depth_in" inputmode="decimal" required></label>
          <label>FOG / crust (in) <input name="fog_depth_in" inputmode="decimal" required></label>
          <label>Solids (in) <input name="solids_depth_in" inputmode="decimal" required></label>
          <p class="small muted span3" id="pct"></p></div>` : ''}
        ${s.key === 'damage' ? html`<div class="cond">
          ${Object.entries(CONDITIONS).map(([k, l]) => html`<label class="radio"><input type="radio" name="condition" value="${k}" ${k === 'good' ? raw('checked') : ''}> ${l}</label>`)}
          <textarea name="damage_notes" rows="2" placeholder="Describe damage / deficiency (required if not Good)"></textarea></div>` : ''}
      </section>`)}

      <section class="card grid2">
        <label>Volume pumped (L) <input name="volume_l" inputmode="decimal"></label>
        <label>Disposal site <input name="disposal_site" list="disp" placeholder="Where the waste went"><datalist id="disp">${sites.map((s) => html`<option value="${s}">`)}</datalist></label>
        <label>Manifest / waste ticket # <input name="manifest_no"></label>
        <label>On-site contact (name) <input name="onsite_contact"></label>
        <label class="span2">Notes <textarea name="notes" rows="2"></textarea></label>
      </section>
      <div id="err" class="flash err" hidden></div>
      <button class="btn primary wide big" id="submit">Submit service report</button>
    </form>
    <script>window.PCT_THRESHOLD=${PCT_FULL_THRESHOLD};</script>
    <script src="/static/capture.js" defer></script>`,
  });
});

app.post('/service', requireAuth('admin', 'tech'), upload.any(), (req, res) => {
  const u = req.user;
  const wantsJson = req.get('x-requested-with') === 'fetch';
  const fail = (msg, code = 400) => (wantsJson ? res.status(code).json({ error: msg }) : res.status(code).send(msg));
  const b = req.body;
  const f = getFacility(u, b.facility_id);
  if (!f) return fail('Facility not found or not assigned to your company.', 404);

  const files = {};
  for (const file of req.files || []) {
    const step = file.fieldname.replace(/^photo_/, '');
    if (!STEP_BY_KEY[step]) continue;
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)) return fail(`Unsupported file type for ${step}`);
    (files[step] ??= []).push(file);
  }
  const condition = CONDITIONS[b.condition] ? b.condition : 'good';
  const afterHours = b.after_hours === '1';
  const missing = STEPS.filter((s) => (s.required || (s.key === 'door_locked' && afterHours) || (s.key === 'damage' && condition !== 'good')) && !files[s.key]?.length);
  if (missing.length) return fail(`Missing photos: ${missing.map((s) => s.label).join('; ')}`);
  const liquid = num(b.liquid_depth_in), fog = num(b.fog_depth_in), solids = num(b.solids_depth_in);
  if (liquid == null || fog == null || solids == null) return fail('Enter liquid depth, FOG and solids measurements.');
  if (condition !== 'good' && !str(b.damage_notes)) return fail('Describe the damage / deficiency.');

  const lat = num(b.lat), lng = num(b.lng);
  const now = new Date().toISOString();
  const stored = [];
  for (const [step, list] of Object.entries(files)) {
    for (const file of list) {
      const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' }[file.mimetype] || 'jpg';
      const rel = path.join(now.slice(0, 7), `${sha.slice(0, 16)}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
      fs.mkdirSync(path.join(UPLOAD_DIR, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR, rel), file.buffer);
      // client encodes camera timestamp in the filename: <step>_<epochms>.jpg
      const ts = Number((file.originalname.match(/_(\d{12,14})\./) || [])[1]);
      stored.push({ step, rel, mime: file.mimetype, bytes: file.size, sha, captured: ts ? new Date(ts).toISOString() : null });
    }
  }

  const id = tx(() => {
    const r = run(`INSERT INTO service_records (facility_id, contractor_org_id, tech_user_id, completed_at, submitted_at, lat, lng, gps_accuracy_m, gps_distance_m,
      liquid_depth_in, fog_depth_in, solids_depth_in, pct_full, volume_l, condition, damage_notes, after_hours, disposal_site, manifest_no, onsite_contact, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    f.id, u.org_id, u.id, now, now, lat, lng, num(b.gps_accuracy_m), haversineM(lat, lng, f.lat, f.lng),
    liquid, fog, solids, pctFull(liquid, fog, solids), num(b.volume_l), condition, str(b.damage_notes), afterHours ? 1 : 0,
    str(b.disposal_site), str(b.manifest_no), str(b.onsite_contact), str(b.notes));
    const rid = Number(r.lastInsertRowid);
    run('UPDATE service_records SET ref = ? WHERE id = ?', `GT-${now.slice(0, 4)}-${String(rid).padStart(6, '0')}`, rid);
    for (const p of stored) {
      run('INSERT INTO photos (record_id, step, filename, mime, bytes, sha256, captured_at) VALUES (?,?,?,?,?,?,?)', rid, p.step, p.rel, p.mime, p.bytes, p.sha, p.captured);
    }
    audit(u.id, 'service.submit', 'service_record', rid, { facility: f.id, photos: stored.length, via_qr: b.via_qr === '1' });
    return rid;
  });
  if (wantsJson) return res.json({ ok: true, url: `/records/${id}?new=1` });
  res.redirect(`/records/${id}?new=1`);
});

// ---------------------------------------------------------------- records
app.get('/records', requireAuth(), (req, res) => {
  const u = req.user;
  const f = { q: str(req.query.q), from: str(req.query.from), to: str(req.query.to), municipality: str(req.query.municipality),
    contractor: isRegulator(u) ? str(req.query.contractor) : null, condition: str(req.query.condition), mine: u.role === 'tech' ? '1' : null };
  const rows = listRecords(u, f);
  page(req, res, {
    title: 'Service records', active: '/records',
    body: html`<div class="row between"><h1>${u.role === 'tech' ? 'My services' : 'Service records'}</h1><a class="btn" href="/records.csv?${qs(f)}">Export CSV</a></div>
      <form class="filters" method="get">
        <input name="q" type="search" placeholder="Facility, ref, address, manifest" value="${f.q}">
        <label class="inline">From <input type="date" name="from" value="${f.from}"></label>
        <label class="inline">To <input type="date" name="to" value="${f.to}"></label>
        <select name="municipality">${options(municipalities().map((m) => [m, m]), f.municipality, 'All municipalities')}</select>
        ${isRegulator(u) ? html`<select name="contractor">${options(contractors().map((c) => [c.id, c.name]), f.contractor, 'All contractors')}</select>` : ''}
        <select name="condition">${options(Object.entries(CONDITIONS), f.condition, 'Any condition')}</select>
        <button class="btn">Filter</button>
      </form>
      <p class="muted small">${rows.length} records${rows.length === 500 ? ' (first 500, narrow the filters or export)' : ''}</p>
      ${recordTable(rows, { showContractor: isRegulator(u) })}`,
  });
});

app.get('/records.csv', requireAuth(), (req, res) => {
  const u = req.user;
  const rows = listRecords(u, { q: str(req.query.q), from: str(req.query.from), to: str(req.query.to), municipality: str(req.query.municipality),
    contractor: isRegulator(u) ? str(req.query.contractor) : null, condition: str(req.query.condition), mine: u.role === 'tech' ? '1' : null }, 100000);
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('text/csv').attachment(`service-records-${isoDay(Date.now())}.csv`).send(csv(rows, [
    ['Ref', (r) => r.ref], ['Completed (local)', (r) => fmtDateTime(r.completed_at)], ['Completed (UTC)', (r) => r.completed_at],
    ['Site code', (r) => r.site_code], ['Facility', (r) => r.facility_name], ['Address', (r) => r.facility_address], ['Municipality', (r) => r.municipality],
    ['Contractor', (r) => r.contractor_name], ['Technician', (r) => r.tech_name],
    ['Liquid depth (in)', (r) => r.liquid_depth_in], ['FOG (in)', (r) => r.fog_depth_in], ['Solids (in)', (r) => r.solids_depth_in], ['% full', (r) => r.pct_full],
    ['Volume (L)', (r) => r.volume_l], ['Condition', (r) => r.condition], ['Damage notes', (r) => r.damage_notes],
    ['Disposal site', (r) => r.disposal_site], ['Manifest #', (r) => r.manifest_no], ['GPS distance from site (m)', (r) => r.gps_distance_m],
    ['Photos', (r) => r.photo_count], ['Report link', (r) => `${base}/records/${r.id}`],
  ]));
});

app.get('/records/:id', requireAuth(), (req, res) => {
  const r = getRecord(req.user, req.params.id);
  if (!r) return res.status(404).send('Not found');
  const byStep = {};
  r.photos.forEach((p) => (byStep[p.step] ??= []).push(p));
  const gpsFlag = r.gps_distance_m != null && r.gps_distance_m > GPS_FLAG_M;
  page(req, res, {
    title: r.ref, active: '/records',
    body: html`${req.query.new ? html`<div class="flash ok">✓ Service report submitted. ${isRegulator(req.user) ? '' : 'The regional district can now see it.'}</div>` : ''}
    <div class="row between"><div><p class="muted small">Grease interceptor service report</p><h1>${r.ref}</h1></div>
      <button class="btn noprint" onclick="window.print()">Print / PDF</button></div>
    <div class="grid3">
      <section class="card"><h2>Facility</h2><dl>
        <dt>Name</dt><dd><a href="/facilities/${r.facility_id}">${r.facility_name}</a></dd>
        <dt>Address</dt><dd>${r.facility_address}, ${r.municipality}</dd><dt>Site code</dt><dd>${r.site_code}</dd>
        <dt>On-site contact</dt><dd>${r.onsite_contact || '—'}</dd></dl></section>
      <section class="card"><h2>Service</h2><dl>
        <dt>Completed</dt><dd>${fmtDateTime(r.completed_at)}</dd>
        <dt>Contractor</dt><dd>${r.contractor_name}</dd><dt>Technician</dt><dd>${r.tech_name}</dd>
        <dt>After hours</dt><dd>${r.after_hours ? 'Yes' : 'No'}</dd>
        <dt>Location check</dt><dd>${r.lat != null ? html`<a href="https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=18/${r.lat}/${r.lng}" target="_blank" rel="noopener">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</a>
          ${r.gps_distance_m != null ? html`<div class="small ${gpsFlag ? 'warn' : 'ok'}">${gpsFlag ? '⚠' : '✓'} ${r.gps_distance_m} m from site${r.gps_accuracy_m ? ` (±${Math.round(r.gps_accuracy_m)} m)` : ''}</div>` : ''}` : html`<span class="warn">No GPS captured</span>`}</dd></dl></section>
      <section class="card"><h2>Findings</h2><dl>
        <dt>Condition</dt><dd>${condBadge(r.condition)}</dd>
        <dt>Depth / FOG / solids</dt><dd>${r.liquid_depth_in ?? '—'}″ / ${r.fog_depth_in ?? '—'}″ / ${r.solids_depth_in ?? '—'}″</dd>
        <dt>% full at arrival</dt><dd>${r.pct_full != null ? html`<b class="${r.pct_full >= PCT_FULL_THRESHOLD ? 'warn' : ''}">${r.pct_full}%</b>${r.pct_full >= PCT_FULL_THRESHOLD ? html`<div class="small warn">Over ${PCT_FULL_THRESHOLD}% rule: service interval may be too long</div>` : ''}` : '—'}</dd>
        <dt>Volume pumped</dt><dd>${r.volume_l != null ? `${r.volume_l} L` : '—'}</dd>
        <dt>Disposal</dt><dd>${r.disposal_site || '—'}${r.manifest_no ? ` · manifest ${r.manifest_no}` : ''}</dd></dl>
        ${r.damage_notes ? html`<p><b>Damage / deficiency:</b> ${r.damage_notes}</p>` : ''}
        ${r.notes ? html`<p><b>Notes:</b> ${r.notes}</p>` : ''}</section>
    </div>
    <section class="card"><h2>Photo evidence</h2>
      ${STEPS.filter((s) => byStep[s.key]).map((s) => html`<div class="photostep"><h3>${s.label}</h3><div class="photos">
        ${byStep[s.key].map((p) => html`<figure><a href="/photos/${p.id}" target="_blank"><img src="/photos/${p.id}" loading="lazy" alt="${s.label}"></a>
          <figcaption class="small muted">${p.captured_at ? `Taken ${fmtDateTime(p.captured_at)} · ` : ''}SHA-256 ${p.sha256.slice(0, 12)}…</figcaption></figure>`)}
      </div></div>`)}
      <p class="small muted">Submitted ${fmtDateTime(r.submitted_at)} · Records are locked once submitted; photo fingerprints let anyone verify an image hasn't been altered since upload.</p>
    </section>`,
  });
});

app.get('/photos/:id', requireAuth(), (req, res) => {
  const p = one('SELECT p.*, r.contractor_org_id FROM photos p JOIN service_records r ON r.id = p.record_id WHERE p.id = ?', Number(req.params.id));
  if (!p || (!isRegulator(req.user) && p.contractor_org_id !== req.user.org_id)) return res.status(404).send('Not found');
  const full = path.resolve(UPLOAD_DIR, p.filename);
  if (!full.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'private, max-age=86400').type(p.mime).sendFile(full);
});

// ---------------------------------------------------------------- regulator views
app.get('/contractors', requireAuth('regulator'), (req, res) => {
  const facs = listFacilities(req.user);
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const rows = contractors().map((c) => {
    const mine = facs.filter((f) => f.contractor_org_id === c.id);
    const k = kpis(mine);
    const r = one(`SELECT COUNT(*) n, AVG(pct_full) p, SUM(CASE WHEN lat IS NULL THEN 1 ELSE 0 END) nogps,
      SUM(CASE WHEN gps_distance_m > ? THEN 1 ELSE 0 END) far FROM service_records WHERE contractor_org_id = ? AND completed_at >= ?`, GPS_FLAG_M, c.id, since);
    return { ...c, k, r };
  });
  page(req, res, {
    title: 'Contractors', active: '/contractors',
    body: html`<h1>Licensed service contractors</h1><div class="tablewrap card"><table class="list">
      <thead><tr><th>Contractor</th><th>Facilities</th><th>In compliance</th><th>Overdue</th><th>Services (90 d)</th><th>Avg % full</th><th>GPS flags (90 d)</th></tr></thead>
      <tbody>${rows.map((c) => html`<tr><td><a href="/facilities?contractor=${c.id}"><b>${c.name}</b></a></td><td>${c.k.total}</td>
        <td><div class="bar"><i style="width:${c.k.pct}%"></i></div> ${c.k.pct}%</td><td>${c.k.c.overdue}</td>
        <td><a href="/records?contractor=${c.id}">${c.r.n}</a></td><td>${c.r.p != null ? `${Math.round(c.r.p)}%` : '—'}</td>
        <td>${(c.r.far || 0) + (c.r.nogps || 0)}</td></tr>`)}</tbody></table></div>
      <p class="small muted">GPS flags = services submitted with no location or more than ${GPS_FLAG_M} m from the facility's recorded location.</p>`,
  });
});

app.get('/reports', requireAuth('regulator'), (req, res) => {
  const today = isoDay(Date.now());
  const from = str(req.query.from) || isoDay(Date.now() - 90 * 864e5), to = str(req.query.to) || today;
  const municipality = str(req.query.municipality), contractor = str(req.query.contractor);
  const recs = listRecords(req.user, { from, to, municipality, contractor }, 100000);
  const facs = listFacilities(req.user, { municipality, contractor });
  const servicedIds = new Set(recs.map((r) => r.facility_id));
  const notServiced = sortByUrgency(facs.filter((f) => !servicedIds.has(f.id)));
  const over = recs.filter((r) => r.pct_full >= PCT_FULL_THRESHOLD).length;
  const def = recs.filter((r) => r.condition === 'deficient');
  const vol = recs.reduce((a, r) => a + (r.volume_l || 0), 0);
  const filt = qs({ from, to, municipality, contractor });
  page(req, res, {
    title: 'Reports', active: '/reports',
    body: html`<h1>Reports</h1>
      <form class="filters" method="get">
        <label class="inline">From <input type="date" name="from" value="${from}"></label>
        <label class="inline">To <input type="date" name="to" value="${to}"></label>
        <select name="municipality">${options(municipalities().map((m) => [m, m]), municipality, 'All municipalities')}</select>
        <select name="contractor">${options(contractors().map((c) => [c.id, c.name]), contractor, 'All contractors')}</select>
        <button class="btn">Run</button>
      </form>
      <div class="kpis">
        <div class="kpi"><span>${recs.length}</span>Services</div>
        <div class="kpi"><span>${servicedIds.size}/${facs.length}</span>Facilities serviced</div>
        <div class="kpi k-overdue"><span>${notServiced.length}</span>Not serviced in period</div>
        <div class="kpi k-due"><span>${over}</span>Arrived ≥ ${PCT_FULL_THRESHOLD}% full</div>
        <div class="kpi k-def"><span>${def.length}</span>Deficiencies found</div>
        <div class="kpi"><span>${Math.round(vol / 1000)}k L</span>Waste removed</div>
      </div>
      <div class="row noprint"><a class="btn" href="/records.csv?${filt}">Download services CSV</a><a class="btn" href="/facilities.csv?${qs({ municipality, contractor })}">Download compliance CSV</a>
        <button class="btn" onclick="window.print()">Print report</button></div>
      <section class="card"><h2>Not serviced between ${fmtDate(localDate(from))} and ${fmtDate(localDate(to))}</h2>
        <p class="small muted">Candidates for a reminder or compliance notice.</p>${statusTable(notServiced)}</section>
      <section class="card"><h2>Deficiencies reported</h2>${recordTable(def)}</section>
      <section class="card"><h2>All services in period</h2>${recordTable(recs.slice(0, 300))}${recs.length > 300 ? html`<p class="small muted">Showing 300 of ${recs.length}; download the CSV for all.</p>` : ''}</section>`,
  });
});
const localDate = (ymd) => new Date(`${ymd}T12:00:00-08:00`);

// ---------------------------------------------------------------- contractor team
app.get('/team', requireAuth('admin'), (req, res) => {
  const users = all('SELECT u.*, (SELECT COUNT(*) FROM service_records r WHERE r.tech_user_id = u.id) AS n FROM users u WHERE org_id = ? ORDER BY active DESC, name', req.user.org_id);
  page(req, res, {
    title: 'Team', active: '/team', flash: req.query.ok ? 'User added.' : req.query.err ? String(req.query.err) : null,
    body: html`<h1>Team</h1><div class="card tablewrap"><table class="list"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Services</th><th>Status</th></tr></thead>
      <tbody>${users.map((x) => html`<tr><td>${x.name}</td><td>${x.email}</td><td>${x.role === 'admin' ? 'Office admin' : 'Technician'}</td><td>${x.n}</td><td>${x.active ? 'Active' : 'Disabled'}</td></tr>`)}</tbody></table></div>
      <section class="card"><h2>Add a team member</h2><form method="post" action="/team" class="grid2">
        <label>Name <input name="name" required></label><label>Email <input name="email" type="email" required></label>
        <label>Temporary password <input name="password" minlength="8" required></label>
        <label>Role <select name="role"><option value="tech">Technician</option><option value="admin">Office admin</option></select></label>
        <div class="span2"><button class="btn primary">Add user</button></div></form></section>`,
  });
});

app.post('/team', requireAuth('admin'), (req, res) => {
  const { name, email, password, role } = req.body;
  if (!str(name) || !str(email) || String(password || '').length < 8 || !['tech', 'admin'].includes(role)) return res.redirect('/team?err=' + encodeURIComponent('Check the form: password needs 8+ characters.'));
  if (one('SELECT 1 FROM users WHERE email = ?', email.trim())) return res.redirect('/team?err=' + encodeURIComponent('That email already has an account.'));
  const r = run('INSERT INTO users (org_id, name, email, pass_hash, role) VALUES (?,?,?,?,?)', req.user.org_id, name.trim(), email.trim(), hashPassword(password), role);
  audit(req.user.id, 'user.create', 'user', Number(r.lastInsertRowid), { role });
  res.redirect('/team?ok=1');
});

// ---------------------------------------------------------------- errors / start
app.use((err, req, res, _next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: `Upload problem: ${err.message}` });
  res.status(500).send('Something went wrong.');
});

seedIfEmpty();
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`${APP_NAME} running on http://localhost:${PORT}`));
