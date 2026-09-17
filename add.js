const SCORE_API = 'https://how-big-is-it-scores.suntracey.workers.dev';
const MAX_PX = 1024;

// The cut-out runs in the browser (free, nothing leaves the phone). The model is a large one-time
// download; a service worker keeps it cached, and we fetch its chunks in parallel to warm that
// cache before the library asks for them one by one.
const MODEL_BASE = 'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/';
const MODEL = 'isnet_quint8';      // the small model: its rough edges vanish once the cut-out is pixelated
const PIXELS = 80;                 // longest side of the pixelated cut-out
const hasGPU = 'gpu' in navigator;
let progressText = '';
const cfg = (device) => ({ model: MODEL, device, progress: (key, cur, total) => {
  if (key.startsWith('fetch') && total) progressText = `downloading model… ${Math.round((cur / total) * 100)}%`;
} });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const lib = import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm');
const warmed = warmModel().then(() => lib).then((m) => m.preload(cfg(hasGPU ? 'gpu' : 'cpu'))).catch(() => {});

async function warmModel() {
  const res = await (await fetch(MODEL_BASE + 'resources.json')).json();
  const wanted = [`/models/${MODEL}`, hasGPU ? '/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm' : '/onnxruntime-web/ort-wasm-simd-threaded.wasm'];
  const chunks = wanted.flatMap((k) => (res[k]?.chunks || []).map((c) => c.hash));
  let done = 0;
  const worker = async () => {
    while (chunks.length) {
      await fetch(MODEL_BASE + chunks.shift()).then((r) => r.arrayBuffer()).catch(() => {});
      done++;
      progressText = `downloading model… ${Math.round((done / (done + chunks.length)) * 100)}%`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  progressText = '';
}

async function cutout(file) {
  const { removeBackground } = await lib;
  await warmed;
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
    // Crop to the cut-out so its height means the object's height, then pixelate it.
    const s = PIXELS / Math.max(box.w, box.h);
    preview.width = Math.max(1, Math.round(box.w * s));
    preview.height = Math.max(1, Math.round(box.h * s));
    const g = preview.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, preview.width, preview.height);
    // Hard alpha: every pixel is either fully there or not, like pixel art.
    const px = g.getImageData(0, 0, preview.width, preview.height);
    for (let i = 3; i < px.data.length; i += 4) px.data[i] = px.data[i] > 110 ? 255 : 0;
    g.putImageData(px, 0, 0);
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
