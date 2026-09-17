import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const HUMAN_M = 1.7;        // reference person height in metres

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
const guessEl = document.getElementById('guess');
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
// A pixel stage: a low platform under both figures, tiled top and striped sides.
const stageTop = makeStageTexture('top');
const stageSide = makeStageTexture('side');
const stage = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  [stageSide, stageSide, stageTop, stageSide, stageSide, stageSide].map((map) => new THREE.MeshBasicMaterial({ map }))
);
scene.add(stage);

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

function updateGuessLabel() {
  guessEl.innerHTML = `about <b>${fmt(guessedHeight())}</b> tall`;
}

// ---------- Loading ----------
async function loadObjects() {
  const res = await fetch('objects.json');
  objects = await res.json();
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
  roundEl.textContent = round === 0 ? 'round 1' : `round ${round + 1} · ${total} pts`;
  resultEl.hidden = true;
  controlsEl.hidden = false;
  guessEl.hidden = false;
  hintEl.hidden = false;
  setLogHeight(0);
  loadingEl.hidden = false;

  if (model) { scene.remove(model); model = null; }

  loader.load(`models/${current.file}`, (gltf) => {
    model = gltf.scene;
    if (current.rotation) {
      const [x, y, z] = current.rotation;
      model.rotation.set(THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z));
    }
    model.updateMatrixWorld(true);

    // Normalise: 1 unit tall, feet on the floor, centred on the origin.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const s = 1 / size.y;
    model.scale.setScalar(s);
    model.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(model);
    const c = box2.getCenter(new THREE.Vector3());
    model.position.set(-c.x, -box2.min.y, -c.z);
    modelWidth = Math.hypot(box2.max.x - box2.min.x, box2.max.z - box2.min.z); // footprint diagonal: the camera views it at an angle
    model.updateMatrixWorld(true);
    modelBox = new THREE.Box3().setFromObject(model);

    scene.add(model);
    loadingEl.hidden = true;
    controls.reset();
    camera.position.set(3, 2, 5);
  }, undefined, (err) => {
    console.error(err);
    loadingEl.textContent = `Couldn't load ${current.file}`;
  });
}

// ---------- Scoring ----------
function lockIn() {
  if (locked || !model) return;
  locked = true;
  const guess = guessedHeight();
  const actual = current.height_m;
  const off = Math.abs(Math.log2(guess / actual));
  const score = Math.round(100 * Math.max(0, 1 - off / 2)); // 2x off = 50, 4x off = 0
  total += score;

  const ratio = guess / actual;
  const way = ratio > 1 ? `${ratio.toFixed(ratio > 10 ? 0 : 1)}× too big` : `${(1 / ratio).toFixed(1 / ratio > 10 ? 0 : 1)}× too small`;
  scoreEl.textContent = `${score} / 100`;
  detailEl.textContent = off < 0.05
    ? `Spot on — the real thing is about ${fmt(actual)} tall.`
    : `You said ${fmt(guess)}. The real thing is about ${fmt(actual)} tall — your guess was ${way}.`;
  factEl.textContent = current.fact || '';
  roundEl.textContent = `round ${round + 1} · ${total} pts`;

  // Snap the person to the true scale so the reveal is visual too.
  setLogHeight(Math.log10(actual));
  guessEl.hidden = true;
  hintEl.hidden = true;
  controlsEl.hidden = true;
  resultEl.hidden = false;
}

function nextRound() {
  round += 1;
  startRound();
}

// ---------- Input ----------
lockBtn.addEventListener('click', lockIn);
nextBtn.addEventListener('click', nextRound);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { if (locked) nextRound(); else lockIn(); }
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

function makeStageTexture(kind) {
  const n = 8;
  const c = document.createElement('canvas');
  c.width = n; c.height = n;
  const g = c.getContext('2d');
  if (kind === 'top') {
    g.fillStyle = '#ececec'; g.fillRect(0, 0, n, n);       // tile
    g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, n, 1); g.fillRect(0, 0, 1, n); // grout
  } else {
    g.fillStyle = '#b4b4b4'; g.fillRect(0, 0, n, n);
    g.fillStyle = '#8c8c8c'; g.fillRect(0, 0, n, 1); g.fillRect(0, 4, n, 1);  // stripes
  }
  const tex = pixelTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
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
  const w = (modelWidth / 2 + hx + humanW / 2) * 1.25;   // span both figures with a margin
  const d = Math.max(modelWidth, humanW) * 1.6;
  const h = 0.08 * big;
  stage.scale.set(w, h, d);
  stage.position.set((hx + humanW / 2 - modelWidth / 2) / 2, -h / 2, 0);
  const tile = 0.2 * big;                                 // tile size scales with the scene
  stageTop.repeat.set(Math.max(1, Math.round(w / tile)), Math.max(1, Math.round(d / tile)));
  stageSide.repeat.set(Math.max(1, Math.round(w / tile)), 1);

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
  // The stage too, so its edges aren't clipped.
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5);
    stage.localToWorld(_corner).applyMatrix4(inv);
    add(_corner.x, _corner.y);
  }

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
