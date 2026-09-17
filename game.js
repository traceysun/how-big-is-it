import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const HUMAN_M = 1.7;        // reference person height in metres
const ROUNDS = 5;           // objects per game; each is worth 20, so a game is out of 100

// 14 x 39 pixel person. '#' is ink.
const HUMAN_PX = [
  '.....####.....',
  '....######....',
  '...########...',
  '...########...',
  '...########...',
  '...########...',
  '....######....',
  '.....####.....',
  '......##......',
  '....######....',
  '...########...',
  '..##.####.##..',
  '..##.####.##..',
  '..##.####.##..',
  '..##.####.##..',
  '..##.####.##..',
  '..##.####.##..',
  '..##.####.##..',
  '..##.####.##..',
  '..##.####.##..',
  '..##.####.##..',
  '.....####.....',
  '.....####.....',
  '.....####.....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '....##..##....',
  '...###..###...',
  '...###..###...',
];

// ---------- DOM ----------
const canvas = document.getElementById('view');
const nameEl = document.getElementById('object-name');
const roundEl = document.getElementById('round');
const loadingEl = document.getElementById('loading');
const hintEl = document.getElementById('hint');
const lockBtn = document.getElementById('lock');
const controlsEl = document.getElementById('controls');
let logHeight = 0;          // log10 of the guessed object height in metres
const LOG_MIN = -3, LOG_MAX = 2;
function setLogHeight(v) { logHeight = Math.min(LOG_MAX, Math.max(LOG_MIN, v)); updateGuessLabel(); }
const resultEl = document.getElementById('result');
const scoreEl = document.getElementById('score');
const detailEl = document.getElementById('detail');
const factEl = document.getElementById('fact');
const nextBtn = document.getElementById('next');
const gameoverEl = document.getElementById('gameover');
const finalEl = document.getElementById('final');
const finalDetailEl = document.getElementById('final-detail');
const againBtn = document.getElementById('again');
const bannerTrack = document.getElementById('banner-track');

// ---------- Banner ----------
// Best score today across all players, kept by a tiny Cloudflare Worker (see worker/).
// If the worker is unreachable, fall back to the best score in this browser.
const SCORE_API = 'https://how-big-is-it-scores.suntracey.workers.dev';
const todayKey = `best-${new Date().toISOString().slice(0, 10)}`;
let bannerBest = null;

function localBest() {
  try { return localStorage.getItem(todayKey); } catch { return null; }
}
function rememberLocal(score) {
  try { if (score > Number(localBest() ?? -1)) localStorage.setItem(todayKey, String(score)); } catch {}
}
async function fetchBest() {
  if (!SCORE_API) return null;
  const r = await fetch(`${SCORE_API}/top?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.statusText);
  return (await r.json()).best;
}
async function submitBest(score) {
  if (!SCORE_API) return null;
  const r = await fetch(`${SCORE_API}/score`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ score }),
  });
  if (!r.ok) throw new Error(r.statusText);
  return (await r.json()).best;
}
function renderBanner() {
  const best = bannerBest ?? localBest();
  const text = `welcome to how_big_is_it, the top score today was ${best ?? '__'}/100. thank you for stopping by, tracey xx`;
  // Two copies so the loop is seamless.
  bannerTrack.innerHTML = `<span>${text}</span><span>${text}</span>`;
}
function recordScore(score) {
  rememberLocal(score);
  renderBanner();
  submitBest(score).then((best) => { if (best != null) { bannerBest = best; renderBanner(); } }).catch(() => {});
}
renderBanner();
fetchBest().then((best) => { if (best != null) { bannerBest = best; renderBanner(); } }).catch(() => {});

// ---------- Scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0xc8c8c8, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(2, 4, 3);
scene.add(sun);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
camera.position.set(3, 2, 5);

const controls = new OrbitControls(camera, canvas);
controls.enableZoom = false;
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI / 2 + 0.15;

// Ground: a soft disc so both figures visibly stand on the same floor.


// The person is a billboard sprite so it always faces the camera as the scene spins.
const human = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeHumanTexture(), transparent: true, alphaTest: 0.5 }));
human.center.set(0.5, 0); // scale from the feet
scene.add(human);

const loader = new GLTFLoader();
let model = null;           // current object, normalised to 1 unit tall
let modelWidth = 1;         // footprint width in units (x/z extent)
let modelBox = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));

// ---------- Game state ----------
let objects = [];
let order = [];
let round = 0;
let total = 0;
let current = null;
let locked = false;


function guessedHeight() { return Math.pow(10, logHeight); }
function humanUnits() { return HUMAN_M / guessedHeight(); } // person height in object-units

function fmt(m) {
  if (m < 0.01) return `${(m * 1000).toPrecision(2)} mm`;
  if (m < 1) return `${(m * 100).toPrecision(2)} cm`;
  if (m < 10) return `${m.toFixed(1)} m`;
  return `${Math.round(m)} m`;
}

function updateGuessLabel() {} // the guess stays hidden until lock-in

// ---------- Loading ----------
async function loadObjects() {
  const res = await fetch('objects.json', { cache: 'no-cache' });
  objects = await res.json();
  // Photo cut-outs people have added (approved ones only). Skip silently if the worker is down.
  try {
    const r = await fetch(`${SCORE_API}/objects?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) {
      for (const o of await r.json()) {
        objects.push({ name: o.name, height_m: o.height_m, fact: o.fact, file: `community-${o.id}`, image: `${SCORE_API}${o.image}` });
      }
    }
  } catch {}
  order = objects.map((_, i) => i).sort(() => Math.random() - 0.5);
  // ?o=okapi starts on a specific object (handy for testing / sharing).
  const want = new URLSearchParams(location.search).get('o');
  const wi = objects.findIndex((o) => o.file.startsWith(want));
  if (want && wi >= 0) order = [wi, ...order.filter((i) => i !== wi)];
  startRound();
}

function startRound() {
  current = objects[order[round % order.length]];
  locked = false;
  nameEl.textContent = current.name;
  roundEl.textContent = round === 0 ? `round 1 of ${ROUNDS}` : `round ${round + 1} of ${ROUNDS} · ${total} pts`;
  resultEl.hidden = true;
  gameoverEl.hidden = true;
  controlsEl.hidden = false;
  hintEl.hidden = false;
  setLogHeight(0);
  loadingEl.hidden = false;

  if (model) { scene.remove(model); model = null; }

  const fail = (err) => { console.error(err); loadingEl.textContent = `couldn't load ${current.name}`; };
  if (current.image) {
    // A photo cut-out: a flat card that always faces the camera, 1 unit tall.
    new THREE.TextureLoader().load(current.image, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;   // cut-outs are pixel art: keep them blocky
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      const aspect = tex.image.width / tex.image.height;
      const card = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.1 }));
      card.center.set(0.5, 0);
      card.scale.set(aspect, 1, 1);
      showModel(card, new THREE.Box3(new THREE.Vector3(-aspect / 2, 0, -0.05), new THREE.Vector3(aspect / 2, 1, 0.05)), aspect);
    }, undefined, fail);
    return;
  }
  loader.load(`models/${current.file}`, (gltf) => {
    const m = gltf.scene;
    if (current.rotation) {
      const [x, y, z] = current.rotation;
      m.rotation.set(THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z));
    }
    m.updateMatrixWorld(true);

    // Normalise: 1 unit tall, feet on the floor, centred on the origin.
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    m.scale.setScalar(1 / size.y);
    m.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(m);
    const c = box2.getCenter(new THREE.Vector3());
    m.position.set(-c.x, -box2.min.y, -c.z);
    m.updateMatrixWorld(true);
    // footprint diagonal: the camera views it at an angle
    showModel(m, new THREE.Box3().setFromObject(m), Math.hypot(box2.max.x - box2.min.x, box2.max.z - box2.min.z));
  }, undefined, fail);
}

function showModel(obj, box, width) {
  model = obj;
  modelBox = box;
  modelWidth = width;
  scene.add(model);
  loadingEl.hidden = true;
  controls.reset();
  camera.position.set(3, 2, 5);
}

// ---------- Scoring ----------
function lockIn() {
  if (locked || !model) return;
  locked = true;
  const guess = guessedHeight();
  const actual = current.height_m;
  const off = Math.abs(Math.log2(guess / actual));
  const score = Math.round(20 * Math.max(0, 1 - off / 2)); // out of 20: 2x off = 10, 4x off = 0
  total += score;

  const ratio = guess / actual;
  const way = ratio > 1 ? `${ratio.toFixed(ratio > 10 ? 0 : 1)}× too big` : `${(1 / ratio).toFixed(1 / ratio > 10 ? 0 : 1)}× too small`;
  scoreEl.textContent = `${score} / 20`;
  detailEl.textContent = off < 0.05
    ? `Spot on — the real thing is about ${fmt(actual)} tall.`
    : `You said ${fmt(guess)}. The real thing is about ${fmt(actual)} tall — your guess was ${way}.`;
  factEl.textContent = current.fact || '';
  roundEl.textContent = `round ${round + 1} of ${ROUNDS} · ${total} pts`;

  // Snap the person to the true scale so the reveal is visual too.
  setLogHeight(Math.log10(actual));
  hintEl.hidden = true;
  controlsEl.hidden = true;
  resultEl.hidden = false;
}

function nextRound() {
  if (round + 1 >= ROUNDS) { endGame(); return; }
  round += 1;
  startRound();
}

function endGame() {
  locked = true;
  resultEl.hidden = true;
  gameoverEl.hidden = false;
  roundEl.textContent = 'game over';
  finalEl.textContent = `${total} / 100`;
  finalDetailEl.textContent =
    total >= 90 ? 'you have an eye for this.' :
    total >= 70 ? 'nicely judged.' :
    total >= 40 ? 'not bad — sizes are hard.' : 'everything is bigger and smaller than it looks.';
  recordScore(total);
}

function newGame() {
  round = 0;
  total = 0;
  order = objects.map((_, i) => i).sort(() => Math.random() - 0.5);
  gameoverEl.hidden = true;
  startRound();
}

// ---------- Input ----------
lockBtn.addEventListener('click', lockIn);
nextBtn.addEventListener('click', nextRound);
againBtn.addEventListener('click', newGame);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (!gameoverEl.hidden) newGame(); else if (locked) nextRound(); else lockIn();
});

// Dragging on the person resizes it; dragging anywhere else orbits (OrbitControls).
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let dragging = false;
let dragStartY = 0;
let dragStartVal = 0;

function hitsHuman(e) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(human).length > 0;
}

canvas.addEventListener('pointerdown', (e) => {
  if (locked || !hitsHuman(e)) return;
  dragging = true;
  dragStartY = e.clientY;
  dragStartVal = logHeight;
  controls.enabled = false;
  canvas.classList.add('resizing');
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    // Drag up = bigger person = smaller object. 250px per decade.
    setLogHeight(dragStartVal + (e.clientY - dragStartY) / 250);
  } else if (!locked) {
    canvas.classList.toggle('resizing', hitsHuman(e));
  }
});
function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  controls.enabled = true;
  canvas.classList.remove('resizing');
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------- Layout & render ----------

function pixelTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;   // keep the pixels crisp at any size
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

function makeHumanTexture() {
  const w = HUMAN_PX[0].length, h = HUMAN_PX.length;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#1a1a1a';
  HUMAN_PX.forEach((row, y) => {
    [...row].forEach((ch, x) => { if (ch === '#') g.fillRect(x, y, 1, 1); });
  });
  return pixelTexture(c);
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
  }
}

function layout() {
  const hu = humanUnits();
  const humanW = hu * (HUMAN_PX[0].length / HUMAN_PX.length);
  human.scale.set(humanW, hu, 1);

  // Person stands to the right of the object with a gap proportional to the bigger of the two.
  const gap = 0.12 * Math.max(1, hu);
  const hx = modelWidth / 2 + gap + humanW / 2;
  human.position.set(hx, 0, 0);

  const big = Math.max(1, hu);
  controls.target.set(hx / 2, big * 0.45, 0);
}

// Size the orthographic frustum so the object's box and the person are always fully on screen,
// whatever the viewport shape or how the scene has been spun.
const _corner = new THREE.Vector3();
function fitCamera() {
  camera.updateMatrixWorld();
  const inv = camera.matrixWorldInverse;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const add = (x, y) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? modelBox.max.x : modelBox.min.x, i & 2 ? modelBox.max.y : modelBox.min.y, i & 4 ? modelBox.max.z : modelBox.min.z);
    _corner.applyMatrix4(inv);
    add(_corner.x, _corner.y);
  }
  // The person is a billboard, so in camera space it is an upright rectangle.
  _corner.copy(human.position).applyMatrix4(inv);
  const hw = human.scale.x / 2, hh = human.scale.y;
  add(_corner.x - hw, _corner.y); add(_corner.x + hw, _corner.y + hh);

  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const margin = 1.15;
  let halfW = ((maxX - minX) / 2) * margin;
  let halfH = ((maxY - minY) / 2) * margin;
  if (halfW / halfH < aspect) halfW = halfH * aspect; else halfH = halfW / aspect;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  camera.left = cx - halfW; camera.right = cx + halfW;
  camera.top = cy + halfH; camera.bottom = cy - halfH;
  camera.updateProjectionMatrix();
}

function tick() {
  resize();
  layout();
  controls.update();
  fitCamera();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

loadObjects();
tick();
