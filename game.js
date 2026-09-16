// Minimal canvas game loop: move the player, collect dots, score points.
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');

const player = { x: 320, y: 240, r: 12, speed: 220 };
const keys = new Set();
let dot = spawnDot();
let score = 0;
let last = performance.now();

function spawnDot() {
  const pad = 20;
  return {
    x: pad + Math.random() * (canvas.width - pad * 2),
    y: pad + Math.random() * (canvas.height - pad * 2),
    r: 8,
  };
}

window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

function update(dt) {
  let dx = 0, dy = 0;
  if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
  if (keys.has('arrowright') || keys.has('d')) dx += 1;
  if (keys.has('arrowup') || keys.has('w')) dy -= 1;
  if (keys.has('arrowdown') || keys.has('s')) dy += 1;
  if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }

  player.x = Math.max(player.r, Math.min(canvas.width - player.r, player.x + dx * player.speed * dt));
  player.y = Math.max(player.r, Math.min(canvas.height - player.r, player.y + dy * player.speed * dt));

  const dist = Math.hypot(player.x - dot.x, player.y - dot.y);
  if (dist < player.r + dot.r) {
    score += 1;
    scoreEl.textContent = `Score: ${score}`;
    dot = spawnDot();
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#f9e2af';
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#89b4fa';
  ctx.beginPath();
  ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2);
  ctx.fill();
}

function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
