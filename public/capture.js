// Service capture: GPS, client-side photo compression + evidence stamp, upload with progress.
(() => {
  const form = document.getElementById('svc');
  if (!form) return;
  const store = {}; // step -> [{blob, ts, url}]
  const gpsEl = document.getElementById('gps');
  const errEl = document.getElementById('err');
  const siteName = (document.querySelector('.svc-head h1') || {}).textContent || '';
  let pos = null;

  // ---- location
  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition((p) => {
      if (pos && p.coords.accuracy > pos.coords.accuracy) return;
      pos = p;
      form.lat.value = p.coords.latitude.toFixed(6);
      form.lng.value = p.coords.longitude.toFixed(6);
      form.gps_accuracy_m.value = Math.round(p.coords.accuracy);
      gpsEl.textContent = `📍 Location captured (±${Math.round(p.coords.accuracy)} m)`;
      gpsEl.className = 'small ok';
    }, () => {
      gpsEl.textContent = '⚠ Location unavailable: allow location access so the report shows you were on site.';
      gpsEl.className = 'small warn';
    }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
  } else gpsEl.textContent = 'Location not supported on this device.';

  // ---- photos
  async function compress(file) {
    const MAX = 1600;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0, w, h);
      // evidence stamp
      const stamp = `${siteName.trim()} · ${new Date(file.lastModified || Date.now()).toLocaleString()}${pos ? ` · ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}` : ''}`;
      const fs = Math.max(14, Math.round(w / 55));
      g.font = `${fs}px system-ui, sans-serif`;
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.fillRect(0, h - fs * 1.8, w, fs * 1.8);
      g.fillStyle = '#fff';
      g.fillText(stamp, fs * 0.6, h - fs * 0.6);
      return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.82));
    } catch {
      return file; // e.g. HEIC on a browser that can't decode it: send original
    }
  }

  function renderThumbs(section) {
    const step = section.dataset.step;
    const box = section.querySelector('.thumbs');
    box.innerHTML = '';
    (store[step] || []).forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.innerHTML = `<img src="${p.url}" alt=""><button type="button" aria-label="Remove photo">×</button>`;
      d.querySelector('button').onclick = () => { URL.revokeObjectURL(p.url); store[step].splice(i, 1); renderThumbs(section); };
      box.appendChild(d);
    });
    section.classList.toggle('done', !!(store[step] || []).length);
  }

  document.querySelectorAll('.step').forEach((section) => {
    const input = section.querySelector('input[type=file]');
    input.addEventListener('change', async () => {
      const step = section.dataset.step;
      for (const file of input.files) {
        const blob = await compress(file);
        (store[step] ??= []).push({ blob, ts: file.lastModified || Date.now(), url: URL.createObjectURL(blob) });
      }
      input.value = '';
      renderThumbs(section);
    });
  });

  // ---- conditional requirements + % full
  const stepEl = (k) => document.querySelector(`.step[data-step="${k}"]`);
  function refreshRequired() {
    const ah = document.getElementById('after_hours').checked;
    const cond = (form.querySelector('input[name=condition]:checked') || {}).value;
    stepEl('door_locked').dataset.required = ah ? '1' : '';
    stepEl('door_locked').classList.toggle('dim', !ah);
    stepEl('damage').dataset.required = cond && cond !== 'good' ? '1' : '';
  }
  form.addEventListener('change', refreshRequired);
  refreshRequired();

  const pctEl = document.getElementById('pct');
  function pct() {
    const l = parseFloat(form.liquid_depth_in.value), f = parseFloat(form.fog_depth_in.value) || 0, s = parseFloat(form.solids_depth_in.value) || 0;
    if (!l) { pctEl.textContent = ''; return; }
    const p = Math.round(((f + s) / l) * 1000) / 10;
    pctEl.textContent = `${p}% full (FOG + solids ÷ liquid depth)${p >= window.PCT_THRESHOLD ? ` ⚠ over the ${window.PCT_THRESHOLD}% rule` : ''}`;
    pctEl.className = 'small span3 ' + (p >= window.PCT_THRESHOLD ? 'warn' : 'muted');
  }
  ['liquid_depth_in', 'fog_depth_in', 'solids_depth_in'].forEach((n) => form[n].addEventListener('input', pct));

  // ---- submit
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const missing = [...document.querySelectorAll('.step')].filter((s) => s.dataset.required && !(store[s.dataset.step] || []).length)
      .map((s) => s.querySelector('b').textContent);
    const problems = [];
    if (missing.length) problems.push('Missing photos: ' + missing.join('; '));
    if (!form.liquid_depth_in.value || !form.fog_depth_in.value || !form.solids_depth_in.value) problems.push('Enter depth, FOG and solids measurements.');
    const cond = (form.querySelector('input[name=condition]:checked') || {}).value;
    if (cond !== 'good' && !form.damage_notes.value.trim()) problems.push('Describe the damage / deficiency.');
    if (problems.length) { errEl.textContent = problems.join(' '); errEl.hidden = false; errEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }

    const fd = new FormData(form);
    document.querySelectorAll('.step input[type=file]').forEach((i) => fd.delete(i.name));
    for (const [step, list] of Object.entries(store)) list.forEach((p) => fd.append(`photo_${step}`, p.blob, `${step}_${p.ts}.jpg`));

    const btn = document.getElementById('submit');
    btn.disabled = true;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', form.action);
    xhr.setRequestHeader('x-requested-with', 'fetch');
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) btn.textContent = `Uploading… ${Math.round((ev.loaded / ev.total) * 100)}%`; };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && data.url) { location.href = data.url; return; }
      errEl.textContent = data.error || `Upload failed (${xhr.status}). Your photos are still here. Try again.`;
      errEl.hidden = false; btn.disabled = false; btn.textContent = 'Submit service report';
    };
    xhr.onerror = () => {
      errEl.textContent = 'No connection. Your photos are still here. Move to better signal and tap Submit again.';
      errEl.hidden = false; btn.disabled = false; btn.textContent = 'Submit service report';
    };
    xhr.send(fd);
  });
})();
