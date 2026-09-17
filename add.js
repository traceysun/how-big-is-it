const SCORE_API = 'https://how-big-is-it-scores.suntracey.workers.dev';
const MAX_PX = 1024;

// The cut-out runs on the server (Replicate, via the worker) when that's configured: nothing to
// download, a few seconds per photo. Otherwise it falls back to running a model in the browser,
// which is a large one-time download.
let serverCutout = null;   // null = unknown, true/false once probed
let browserLib = null;
let progressText = '';
const hasGPU = 'gpu' in navigator;
const cfg = (device) => ({ model: 'isnet_fp16', device, progress: (key, cur, total) => {
  if (key.startsWith('fetch') && total) progressText = `downloading model… ${Math.round((cur / total) * 100)}%`;
} });

async function probeServer() {
  if (serverCutout !== null) return serverCutout;
  try {
    const r = await fetch(`${SCORE_API}/cutout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    serverCutout = r.status === 400;       // 400 = configured (rejects the empty probe); 501/404 = not configured
  } catch { serverCutout = false; }
  if (!serverCutout) loadBrowserLib();
  return serverCutout;
}
function loadBrowserLib() {
  if (!browserLib) {
    browserLib = import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm')
      .then((m) => { m.preload(cfg(hasGPU ? 'gpu' : 'cpu')).catch(() => {}); return m; });
  }
  return browserLib;
}
probeServer();

async function cutout(file) {
  if (await probeServer()) {
    // Replicate wants small data URLs: shrink until it's under ~240 KB.
    let px = 1024, q = 0.85, dataUrl;
    do {
      dataUrl = await downscaleToDataUrl(file, px, q);
      if (q > 0.6) q -= 0.1; else px = Math.round(px * 0.8);
    } while (dataUrl.length > 240 * 1024 * 4 / 3 && px > 300);
    const r = await fetch(`${SCORE_API}/cutout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `server error ${r.status}`);
    return r.blob();
  }
  const { removeBackground } = await loadBrowserLib();
  const small = await downscale(file, MAX_PX);
  try {
    return await removeBackground(small, cfg(hasGPU ? 'gpu' : 'cpu'));
  } catch (err) {
    if (!hasGPU) throw err;
    console.warn('GPU failed, retrying on CPU', err);
    return await removeBackground(small, cfg('cpu'));
  }
}

const photo = document.getElementById('photo');
const statusEl = document.getElementById('status');
const previewWrap = document.getElementById('preview-wrap');
const preview = document.getElementById('preview');
const details = document.getElementById('details');
const done = document.getElementById('done');
let cutoutPng = null;

function say(text) { statusEl.hidden = !text; statusEl.textContent = text; }

photo.addEventListener('change', async () => {
  const file = photo.files[0];
  if (!file) return;
  details.hidden = true; done.hidden = true; previewWrap.hidden = true; cutoutPng = null;
  try {
    say('cutting out the object…');
    const ticker = setInterval(() => { if (progressText) say(progressText); }, 300);
    let blob;
    try { blob = await cutout(file); } finally { clearInterval(ticker); }
    const img = await blobToImage(blob);
    const box = opaqueBounds(img);
    if (!box) throw new Error('no object found — try a clearer photo');
    // Crop to the cut-out so its height means the object's height.
    preview.width = box.w; preview.height = box.h;
    preview.getContext('2d').drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    cutoutPng = preview.toDataURL('image/png');
    say('');
    previewWrap.hidden = false;
    details.hidden = false;
  } catch (e) {
    console.error(e);
    say(`couldn't do that: ${e.message || e}`);
  }
});

details.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!cutoutPng) return;
  const btn = document.getElementById('submit');
  btn.disabled = true; btn.textContent = 'sending…';
  const height_m = Number(document.getElementById('height').value) * Number(document.getElementById('unit').value);
  try {
    const r = await fetch(`${SCORE_API}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('name').value,
        height_m,
        fact: document.getElementById('fact').value,
        image: cutoutPng,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    details.hidden = true; previewWrap.hidden = true; done.hidden = false;
  } catch (err) {
    say(`couldn't send: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'add it';
  }
});

document.getElementById('again').addEventListener('click', () => {
  done.hidden = true; photo.value = ''; details.reset();
});

function drawSmall(img, max) {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
async function downscale(file, max) {
  const c = drawSmall(await blobToImage(file), max);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
}
async function downscaleToDataUrl(file, max, q) {
  return drawSmall(await blobToImage(file), max).toDataURL('image/jpeg', q);
}
function blobToImage(blob) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); res(img); };
    img.onerror = rej;
    img.src = URL.createObjectURL(blob);
  });
}
function opaqueBounds(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 40) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
