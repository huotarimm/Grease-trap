import { STATUS_LABELS } from './compliance.js';

export const APP_NAME = process.env.APP_NAME || 'TrapLog';
const TZ = process.env.TZ_DISPLAY || 'America/Vancouver';

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const render = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('') : esc(v));
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Raw(out);
}

export const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('en-CA', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-CA', { timeZone: TZ, dateStyle: 'medium' }) : '—';
export const isoDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD

export const badge = (code, label) => html`<span class="badge b-${code}">${label || STATUS_LABELS[code] || code}</span>`;
export const condBadge = (c) => html`<span class="badge c-${c}">${{ good: 'Good', minor: 'Minor issue', deficient: 'Deficient' }[c] || c}</span>`;

function nav(user, active) {
  if (!user) return '';
  const items = user.role === 'regulator'
    ? [['/', 'Dashboard'], ['/facilities', 'Facilities'], ['/records', 'Service records'], ['/contractors', 'Contractors'], ['/reports', 'Reports']]
    : user.role === 'admin'
      ? [['/', 'Dashboard'], ['/facilities', 'Facilities'], ['/records', 'Service log'], ['/team', 'Team']]
      : [['/', 'My sites'], ['/records', 'My services']];
  return html`<nav class="nav">${items.map(([href, label]) => html`<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`)}</nav>`;
}

export function layout({ user, title, active, body, flash }) {
  return `<!doctype html>${html`<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0f3d3e">
<title>${title ? `${title} · ` : ''}${APP_NAME}</title>
<link rel="stylesheet" href="/static/app.css">
</head><body>
<header class="top">
  <a class="brand" href="/"><span class="logo">◉</span> ${APP_NAME}</a>
  ${user ? html`<div class="who"><span>${user.name} · <b>${user.org_name}</b></span>
    <form method="post" action="/logout"><button class="link">Sign out</button></form></div>` : ''}
</header>
${nav(user, active)}
<main class="wrap">
${flash ? html`<div class="flash">${flash}</div>` : ''}
${body}
</main>
<footer class="foot">${APP_NAME} · grease interceptor service records · photos are SHA-256 fingerprinted at upload</footer>
</body></html>`}`;
}

export function csv(rows, cols) {
  const q = (v) => {
    if (v == null) return '';
    const s = String(v);
    // Neutralise spreadsheet formula injection, quote when needed.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.map((c) => q(c[0])).join(','), ...rows.map((r) => cols.map((c) => q(c[1](r))).join(','))].join('\n');
}
