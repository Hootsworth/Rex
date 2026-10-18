const cursor = document.getElementById('cursor');
const feed = document.getElementById('feed');
const clickables = [...document.querySelectorAll('.js-clickable')];

let pos = {
  x: window.innerWidth * 0.46,
  y: window.innerHeight * 0.58
};
let target = { ...pos };
let velocity = { x: 0, y: 0 };
let idleTicks = 0;
let lastIntentTs = performance.now();

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function addFeed(text) {
  const li = document.createElement('li');
  li.textContent = text;
  feed.prepend(li);
  while (feed.children.length > 16) feed.removeChild(feed.lastChild);
}

function pointerBurst(x, y) {
  const b = document.createElement('div');
  b.className = 'burst';
  b.style.left = `${x}px`;
  b.style.top = `${y}px`;
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 450);
}

function setCursor(x, y) {
  cursor.style.left = `${x}px`;
  cursor.style.top = `${y}px`;
}

function pickTargetElement() {
  if (!clickables.length) return null;
  const visible = clickables.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
  });
  if (!visible.length) return null;
  return visible[Math.floor(Math.random() * visible.length)];
}

function targetFromElement(el) {
  const rect = el.getBoundingClientRect();
  const jitterX = rand(-4, 4);
  const jitterY = rand(-4, 4);
  return {
    x: rect.left + rect.width / 2 + jitterX,
    y: rect.top + rect.height / 2 + jitterY
  };
}

function pickWanderPoint() {
  return {
    x: rand(60, window.innerWidth - 60),
    y: rand(70, window.innerHeight - 70)
  };
}

function queueIntent(reason) {
  const targetEl = pickTargetElement();
  if (targetEl && Math.random() > 0.28) {
    target = targetFromElement(targetEl);
    targetEl.dataset.activeIntent = '1';
    addFeed(`intent: move to "${targetEl.dataset.title || targetEl.textContent.trim()}" (${reason})`);
    return;
  }

  target = pickWanderPoint();
  addFeed(`intent: idle wander (${reason})`);
}

function clearIntentMarks() {
  clickables.forEach((el) => {
    delete el.dataset.activeIntent;
  });
}

function maybeClick() {
  const now = performance.now();
  const pending = clickables.find((el) => el.dataset.activeIntent === '1');
  if (!pending) return;

  const r = pending.getBoundingClientRect();
  const tx = r.left + r.width / 2;
  const ty = r.top + r.height / 2;
  const closeEnough = Math.hypot(tx - pos.x, ty - pos.y) < 16;
  if (!closeEnough) return;

  cursor.classList.add('clicking');
  pointerBurst(pos.x, pos.y);
  setTimeout(() => cursor.classList.remove('clicking'), 140);
  addFeed(`click: ${pending.dataset.title || pending.textContent.trim()}`);

  // Mock navigation signal without leaving page.
  pending.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(0.96)' },
      { transform: 'scale(1)' }
    ],
    { duration: 260, easing: 'ease-out' }
  );

  clearIntentMarks();
  lastIntentTs = now;
}

function tick() {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;

  // Soft spring + damping gives a more human-like acceleration curve.
  velocity.x += dx * 0.019;
  velocity.y += dy * 0.019;
  velocity.x *= 0.77;
  velocity.y *= 0.77;

  // Tiny hand jitter so movement does not look perfectly robotic.
  velocity.x += rand(-0.15, 0.15);
  velocity.y += rand(-0.15, 0.15);

  pos.x = clamp(pos.x + velocity.x, 8, window.innerWidth - 8);
  pos.y = clamp(pos.y + velocity.y, 8, window.innerHeight - 8);

  setCursor(pos.x, pos.y);
  maybeClick();

  const dist = Math.hypot(dx, dy);
  const now = performance.now();
  if (dist < 18) idleTicks += 1;
  else idleTicks = 0;

  if (idleTicks > 35 || now - lastIntentTs > rand(1700, 3200)) {
    clearIntentMarks();
    queueIntent(idleTicks > 35 ? 'settled' : 'timeout');
    idleTicks = 0;
    lastIntentTs = now;
  }

  requestAnimationFrame(tick);
}

// Prevent real navigation and keep the demo loop alive.
clickables.forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
  });
});

window.addEventListener('resize', () => {
  pos.x = clamp(pos.x, 12, window.innerWidth - 12);
  pos.y = clamp(pos.y, 12, window.innerHeight - 12);
  target = pickWanderPoint();
});

addFeed('boot: Preflight Cursor Theater initialized');
queueIntent('startup');
requestAnimationFrame(tick);
