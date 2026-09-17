import { removeBackground } from 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';

const SCORE_API = 'https://how-big-is-it-scores.suntracey.workers.dev';
const MAX_PX = 1024;

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
    say('shrinking photo…');
    const small = await downscale(file, MAX_PX);
    say('cutting out the object… (first time downloads a ~40 MB model, then it\'s fast)');
    const blob = await removeBackground(small, {
      progress: (key, current, total) => {
        if (key.startsWith('fetch')) say(`downloading model… ${Math.round((current / total) * 100)}%`);
      },
    });
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
    btn.disabled = false; btn.textContent = 'submit for approval';
  }
});

document.getElementById('again').addEventListener('click', () => {
  done.hidden = true; photo.value = ''; details.reset();
});

async function downscale(file, max) {
  const img = await blobToImage(file);
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
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
