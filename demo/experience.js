(() => {
'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => 1 - Math.pow(1 - t, 3);
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const canvas = $('#eyeCanvas');
const context = canvas.getContext('2d');
const palette = {
  ink: getComputedStyle(document.body).backgroundColor,
  panel: getComputedStyle($('#insightPanel')).backgroundColor,
};
const state = {
  view: 'home', chapter: 1, frame: 2, choice: null, revealed: false,
  evidence: null, auto: false, tourElapsed: 0, muted: true,
  generation: 0, assembly: 0, zoom: 0, focusCell: [22, 24],
  pointer: { x: 0, y: 0, tx: 0, ty: 0 }, image: null,
};
let width = 0, height = 0, dpr = 1, lastFrameTime = 0, assemblyStart = 0;
let transitionStart = 0, transitionGeneration = 0;
let chapterFlight = null;
let hintTimer = 0, evidenceTimer = 0, frameGeneration = 0;
let wheelSum = 0, wheelTime = 0, wheelDirection = 0, wheelLock = 0;
let audioContext, masterGain;
const frameCache = new Map();
const storedHint = () => { try { return sessionStorage.getItem('courtcast-v6-hint') === 'seen'; } catch { return false; } };
const announce = text => { $('#announcement').textContent = text; };
const setIcon = (button, name) => button.querySelector('use').setAttribute('href', '#i-' + name);

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 1.5);
  width = innerWidth; height = innerHeight;
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
}
resize();
addEventListener('resize', () => { resize(); fitReplay(); });
document.fonts.ready.then(fitReplay);

function fitReplay() {
  const column = $('.replay-column'), grid = $('.workspace-grid');
  column.style.maxWidth = '';
  grid.style.maxWidth = ''; grid.style.gridTemplateColumns = '';
  if (!['work', 'entering', 'travelling'].includes(state.view) || innerWidth <= 850 || innerHeight <= 590) return;
  const frame = $('#mediaFrame');
  const panelWidth = $('#insightPanel').getBoundingClientRect().width;
  for (let i = 0; i < 2; i++) {
    const overhead = column.getBoundingClientRect().height - frame.getBoundingClientRect().height;
    const available = Math.max(180, grid.clientHeight - overhead - 4);
    column.style.maxWidth = Math.min(column.getBoundingClientRect().width, available * 16 / 9) + 'px';
  }
  const replayWidth = column.getBoundingClientRect().width;
  const gap = parseFloat(getComputedStyle(grid).columnGap);
  grid.style.gridTemplateColumns = `minmax(0, ${replayWidth}px) minmax(0, ${panelWidth}px)`;
  grid.style.maxWidth = replayWidth + panelWidth + gap + 'px';
}

function loadImage(src) {
  if (!frameCache.has(src)) {
    frameCache.set(src, new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = src;
    }));
  }
  return frameCache.get(src);
}
loadImage(DEMO.mosaic.src).then(image => {
  state.image = image;
  assemblyStart = performance.now();
  if (!image) $('#heroStatus').textContent = '眼睛拼图暂时无法加载，你仍可以进入回合分析。';
});
DEMO.frames.forEach(frame => loadImage(frame.src));
DEMO.chapters.filter(chapter => chapter.src).forEach(chapter => loadImage(chapter.src));

const scattered = [];
for (let row = 0; row < 64; row++) for (let col = 0; col < 64; col++) {
  const x = (col + .5) / 64 - .5, y = (row + .5) / 64 - .5;
  const distance = Math.hypot(x, y);
  const angle = Math.atan2(y, x);
  scattered.push({ x: Math.cos(angle) * (.25 + distance), y: Math.sin(angle) * (.25 + distance), delay: distance * .42, rotation: (col % 3 - 1) * .18 });
}

function homeCamera(now) {
  const m = DEMO.mosaic;
  const scale = Math.max(width / m.width, height / m.height) * (motionPreference.matches ? 1.015 : 1.015 + Math.sin(now / 4200) * .003);
  return { x: m.width / 2, y: m.height / 2, scale };
}
function destinationCamera(cell = state.focusCell) {
  const rect = $('#mediaFrame').getBoundingClientRect();
  const m = DEMO.mosaic;
  const scale = rect.width / m.cellWidth;
  const cellX = (cell[0] + .5) * m.cellWidth;
  const cellY = (cell[1] + .5) * m.cellHeight;
  return { x: cellX - (rect.left + rect.width / 2 - width / 2) / scale, y: cellY - (rect.top + rect.height / 2 - height / 2) / scale, scale };
}
function mixCamera(from, to, t) {
  return { scale: Math.exp(lerp(Math.log(from.scale), Math.log(to.scale), t)), x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) };
}
function flightCamera() {
  const t = state.zoom;
  const progress = t * t * t * (10 - 15 * t + 6 * t * t);
  // 保持格子近景，镜头直接移到下一幕；轻微缩放只用于缓和移动。
  const camera = mixCamera(chapterFlight.camera, destinationCamera(), progress);
  camera.scale *= 1 - .18 * Math.sin(Math.PI * t);
  return camera;
}
function drawFrameTile(image, cell, mask, camera, ox, oy, alpha = 1) {
  if (!image) return;
  const m = DEMO.mosaic, cw = m.cellWidth * camera.scale, ch = m.cellHeight * camera.scale;
  const x = ox + cell[0] * cw, y = oy + cell[1] * ch;
  context.save(); context.globalAlpha = alpha;
  context.drawImage(image, x, y, cw, ch);
  if (mask) { context.fillStyle = palette.panel; context.fillRect(x, y + ch * .666, cw * .35, ch * .218); }
  context.restore();
}
function drawEye(now) {
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = palette.ink; context.fillRect(0, 0, width, height);
  if (!state.image) return;
  const m = DEMO.mosaic;
  const start = homeCamera(now);
  let camera = start;
  if (state.view === 'entering') {
    camera = mixCamera(start, destinationCamera(), ease(state.zoom));
  } else if (state.view === 'travelling' && chapterFlight) {
    camera = flightCamera();
  }
  const px = motionPreference.matches || state.view !== 'home' ? 0 : state.pointer.x * 5;
  const py = motionPreference.matches || state.view !== 'home' ? 0 : state.pointer.y * 4;
  const ox = width / 2 - camera.x * camera.scale + px;
  const oy = height / 2 - camera.y * camera.scale + py;
  if (state.assembly < 1 && state.view === 'home') {
    for (let row = 0, i = 0; row < 64; row++) for (let col = 0; col < 64; col++, i++) {
      const cell = scattered[i], t = ease(clamp((state.assembly - cell.delay) / (1 - cell.delay)));
      if (!t) continue;
      const cw = m.cellWidth * camera.scale, ch = m.cellHeight * camera.scale;
      const x = ox + (col + .5) * cw + cell.x * width * .35 * (1 - t);
      const y = oy + (row + .5) * ch + cell.y * height * .35 * (1 - t);
      if (x + cw < 0 || x - cw > width || y + ch < 0 || y - ch > height) continue;
      context.save(); context.globalAlpha = t; context.translate(x, y); context.rotate(cell.rotation * (1 - t));
      const imageScaleX = state.image.naturalWidth / m.width, imageScaleY = state.image.naturalHeight / m.height;
      context.drawImage(state.image, col * m.cellWidth * imageScaleX, row * m.cellHeight * imageScaleY, m.cellWidth * imageScaleX, m.cellHeight * imageScaleY, -cw / 2, -ch / 2, cw + .2, ch + .2);
      context.restore();
    }
  } else {
    context.drawImage(state.image, ox, oy, m.width * camera.scale, m.height * camera.scale);
  }
  if (state.view === 'entering' || state.view === 'travelling') {
    if (chapterFlight) drawFrameTile(chapterFlight.image, chapterFlight.cell, chapterFlight.mask, camera, ox, oy);
    drawFrameTile(activeFrameImage, state.focusCell, state.chapter === 1 && state.frame === 2, camera, ox, oy, state.view === 'entering' ? clamp(state.zoom * 2.5) : 1);
    context.save(); context.globalAlpha = clamp((state.zoom - .86) / .14) * .12;
    context.fillStyle = palette.ink;
    context.fillRect(0, 0, width, height);
    context.restore();
  }
  const gradient = context.createRadialGradient(width * .55, height * .47, height * .15, width * .5, height * .5, Math.hypot(width, height) * .65);
  gradient.addColorStop(0, 'transparent'); gradient.addColorStop(1, palette.ink);
  context.save(); context.globalAlpha = .56;
  context.fillStyle = gradient; context.fillRect(0, 0, width, height); context.restore();
}

function animationFrame(now) {
  requestAnimationFrame(animationFrame);
  const dt = Math.min(80, Math.max(0, now - (lastFrameTime || now))); lastFrameTime = now;
  if (document.hidden) return;
  state.pointer.x = lerp(state.pointer.x, state.pointer.tx, .06);
  state.pointer.y = lerp(state.pointer.y, state.pointer.ty, .06);
  if (state.image) state.assembly = motionPreference.matches ? 1 : clamp((now - assemblyStart) / 1600);
  if (state.view === 'entering' || state.view === 'travelling') {
    state.zoom = motionPreference.matches ? 1 : clamp((now - transitionStart) / (state.view === 'travelling' ? 900 : 1050));
    drawEye(now);
    if (state.zoom === 1 && transitionGeneration === state.generation) finishEntry();
  } else if (state.view === 'home') drawEye(now);
  if (state.auto && state.view === 'work') {
    state.tourElapsed += dt;
    if (state.chapter === 1 && !state.revealed && state.tourElapsed >= 8000) {
      reveal(false); state.tourElapsed = 0;
    } else if ((state.chapter !== 1 || state.revealed) && state.tourElapsed >= (state.chapter === 1 ? 9000 : 6500)) {
      changeChapter(state.chapter + 1, false);
    }
  }
}
requestAnimationFrame(animationFrame);

function createAudio() {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioContext.createGain(); masterGain.gain.value = state.muted ? 0 : 1; masterGain.connect(audioContext.destination);
    }
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  } catch { /* 页面操作不依赖声音设备。 */ }
}
function sound(kind) {
  if (state.muted || !audioContext) return;
  const t = audioContext.currentTime;
  if (kind === 'enter') {
    const buffer = audioContext.createBuffer(1, audioContext.sampleRate * .45, audioContext.sampleRate);
    const samples = buffer.getChannelData(0); for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    const source = audioContext.createBufferSource(), filter = audioContext.createBiquadFilter(), gain = audioContext.createGain();
    source.buffer = buffer; filter.type = 'bandpass'; filter.frequency.setValueAtTime(380, t); filter.frequency.exponentialRampToValueAtTime(1300, t + .45);
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(.08, t + .17); gain.gain.linearRampToValueAtTime(0, t + .45);
    source.connect(filter).connect(gain).connect(masterGain); source.start(t); return;
  }
  const frequencies = kind === 'reveal' ? [440, 660] : kind === 'complete' ? [170, 90] : [520];
  frequencies.forEach((frequency, index) => {
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain(), start = t + index * .065;
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.055, start + .008); gain.gain.exponentialRampToValueAtTime(.0001, start + .13);
    oscillator.connect(gain).connect(masterGain); oscillator.start(start); oscillator.stop(start + .15);
  });
}
function syncSound() {
  const button = $('#soundButton');
  const label = state.muted ? '开启声音' : '关闭声音';
  button.setAttribute('aria-pressed', String(!state.muted)); button.setAttribute('aria-label', label); button.dataset.tooltip = label;
  setIcon(button, state.muted ? 'mute' : 'sound');
  if (masterGain) masterGain.gain.value = state.muted ? 0 : 1;
}
$('#soundButton').addEventListener('click', () => { createAudio(); state.muted = !state.muted; syncSound(); sound('freeze'); });

let outroAnimations = [];
function stopOutroBounce() {
  outroAnimations.forEach(animation => animation.cancel()); outroAnimations = [];
}
function startOutroBounce() {
  stopOutroBounce();
  if (motionPreference.matches) return;
  // v5 收尾节奏：成球 800ms、落地 380ms、压缩 90ms，随后弹两次（360/220ms）。
  const ball = $('#outroLaunch img'), shadow = $('#outroLaunch > span');
  const duration = 1940, radius = ball.offsetHeight / 2;
  const ballFrames = [], shadowFrames = [];
  let elapsed = 0;
  const y = -innerHeight * .18, scale = .16 / .105;
  function sample(time, offsetY, sx, sy, opacity = 1) {
    const offset = time / duration, angle = Math.PI * 2 * (offset - 1);
    ballFrames.push({ offset, transform: `translateY(${offsetY + radius * Math.max(0, 1 - sy)}px) rotate(${angle}rad) scale(${sx}, ${sy})`, opacity });
    const lift = clamp(-offsetY / (innerHeight * .15));
    shadowFrames.push({ offset, transform: `scale(${1 - lift * .3}, ${1 - lift * .4})`, opacity: .55 * (1 - lift * .6) * opacity });
  }
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    sample(t * 800, y, scale, scale, clamp((t - .25) / .45));
  }
  elapsed = 800;
  for (let i = 1; i <= 24; i++) {
    const t = i / 24, size = lerp(scale, 1, 1 - (1 - t) ** 2);
    sample(elapsed + t * 380, y * (1 - t * t), size, size);
  }
  elapsed += 380;
  for (const [height, milliseconds, strength] of [[innerHeight * .13, 360, .9], [innerHeight * .045, 220, .5]]) {
    for (let i = 1; i <= 12; i++) {
      const t = i / 12, squeeze = Math.sin(t * Math.PI) * strength;
      sample(elapsed + t * 90, 0, 1 + .12 * squeeze, 1 - .18 * squeeze);
    }
    elapsed += 90;
    for (let i = 1; i <= 24; i++) {
      const t = i / 24;
      sample(elapsed + t * milliseconds, -height * Math.sin(t * Math.PI), 1, 1);
    }
    elapsed += milliseconds;
  }
  outroAnimations = [ball.animate(ballFrames, { duration, easing: 'linear' }), shadow.animate(shadowFrames, { duration, easing: 'linear' })];
}
motionPreference.addEventListener('change', () => { if (motionPreference.matches) stopOutroBounce(); });

function setView(view) {
  state.view = view; document.body.dataset.view = view;
  document.body.scrollTop = 0; document.documentElement.scrollTop = 0;
  $('#hero').hidden = view !== 'home' && view !== 'entering'; $('#hero').inert = view !== 'home';
  $('#workspace').hidden = !['work', 'entering', 'travelling'].includes(view); $('#workspace').inert = view !== 'work';
  $('#outro').hidden = view !== 'complete'; $('#outro').inert = view !== 'complete';
  if (view === 'complete') startOutroBounce(); else stopOutroBounce();
  fitReplay();
}
function finishEntry() {
  const entering = state.view === 'entering';
  chapterFlight = null;
  setView('work'); updateNavigation(); sound('freeze');
  if (entering || document.activeElement === document.body) $('#insightPanel').focus({ preventScroll: true });
  if (entering && !storedHint()) { $('#navigationHint').hidden = false; $('#navigationHelp').setAttribute('aria-expanded', 'true'); clearTimeout(hintTimer); hintTimer = setTimeout(dismissHint, 4800); }
}
function enter(chapter = 0) {
  if (['entering', 'travelling'].includes(state.view)) return;
  chapterFlight = null;
  createAudio(); state.generation++; state.auto = false; state.zoom = 0; state.tourElapsed = 0;
  changeChapter(chapter, false);
  setView('entering'); transitionStart = performance.now(); transitionGeneration = state.generation;
  state.assembly = 1; sound('enter');
  if (motionPreference.matches || !state.image || !context) { state.zoom = 1; finishEntry(); }
}
function home() {
  state.generation++; state.auto = false; state.zoom = 0; state.evidence = null; clearTimeout(evidenceTimer); dismissHint();
  chapterFlight = null;
  wheelSum = 0; wheelLock = 0; wheelDirection = 0; setView('home'); updateNavigation();
  $('#enterExplore').focus({ preventScroll: true });
}
$('#homeButton').addEventListener('click', home);
$('#enterExplore').addEventListener('click', () => enter(0));
function dismissHint() { clearTimeout(hintTimer); $('#navigationHint').hidden = true; $('#navigationHelp').setAttribute('aria-expanded', 'false'); try { sessionStorage.setItem('courtcast-v6-hint', 'seen'); } catch {} }
$('#dismissHint').addEventListener('click', dismissHint);
$('#navigationHelp').addEventListener('click', () => { if (!$('#navigationHint').hidden) dismissHint(); else { clearTimeout(hintTimer); $('#navigationHint').hidden = false; $('#navigationHelp').setAttribute('aria-expanded', 'true'); } });

let activeFrameImage = null;
async function setFrame(index, srcOverride, altOverride) {
  const id = ++frameGeneration;
  const frame = DEMO.frames[index];
  const src = srcOverride || frame.src, alt = altOverride || frame.alt;
  state.frame = index; activeFrameImage = null; clearEvidence();
  $('#frameUnavailable').hidden = true; $('#keyframe').src = src; $('#keyframe').alt = alt;
  $('#keyframe').dataset.frame = String(index);
  $('#frameClock').textContent = frame.clock;
  $('#answerMask').hidden = !(state.chapter === 1 && index === 2);
  $('#timelineProgress').style.width = (index + 1) / 3 * 100 + '%';
  $$('#timeline button').forEach(button => {
    const active = Number(button.dataset.frame) === index;
    if (active) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  });
  $('#mediaFrame').classList.remove('frame-change');
  const image = await loadImage(src);
  if (id !== frameGeneration) return;
  activeFrameImage = image;
  $('#frameUnavailable').hidden = Boolean(image);
  if (state.view === 'work' && image) $('#mediaFrame').classList.add('frame-change');
  fitReplay();
}
$('#retryFrame').addEventListener('click', () => {
  const src = $('#keyframe').getAttribute('src'); frameCache.delete(src);
  setFrame(state.frame, src, $('#keyframe').alt);
});

function setAuto(value) { state.auto = value; state.tourElapsed = 0; updateNavigation(); }
function takeControl() { if (state.auto) setAuto(false); dismissHint(); }
$('#insightPanel').addEventListener('wheel', takeControl, { passive: true });
$('#sourceDetails').addEventListener('click', takeControl);
function updateNavigation() {
  $('#chapterNumber').replaceChildren();
  $('#chapterNumber').append(String(state.chapter + 1).padStart(2, '0') + ' ');
  const denominator = document.createElement('small'); denominator.textContent = '/ 05'; $('#chapterNumber').append(denominator);
  $('#chapterProgress').style.width = (state.chapter + 1) / DEMO.chapters.length * 100 + '%';
  $$('#chapterTabs button').forEach((button, index) => {
    if (index === state.chapter) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  });
  $('#prevButton').setAttribute('aria-label', state.chapter === 0 ? '返回开场首屏' : '上一个亮点');
  $('#nextButton').setAttribute('aria-label', state.chapter === 4 ? '完成探索' : '下一个亮点');
  $('#tourButton').setAttribute('aria-pressed', String(state.auto)); $('#tourButton span').textContent = state.auto ? '暂停导览' : '自动导览'; setIcon($('#tourButton'), state.auto ? 'pause' : 'play');
  $('#tourNotice').hidden = !state.auto || state.chapter !== 1 || state.revealed;
}
function paragraph(text, className) { const element = document.createElement('p'); element.textContent = text; if (className) element.className = className; return element; }
function multiline(element, text) {
  element.replaceChildren(); text.split('\n').forEach((line, i) => { if (i) element.append(document.createElement('br')); element.append(line); });
}
function changeChapter(index, user = true) {
  const reversing = state.view === 'travelling' && index === chapterFlight?.chapter;
  if (state.view === 'entering' || (state.view === 'travelling' && !reversing)) return;
  if (user) takeControl();
  if (index < 0) { home(); return; }
  if (index >= DEMO.chapters.length) {
    state.generation++; state.auto = false; updateNavigation(); setView('complete'); sound('complete'); $('#outroLaunch').focus({ preventScroll: true }); return;
  }
  const next = clamp(index, 0, DEMO.chapters.length - 1);
  if (state.view === 'work' && next === state.chapter) return;
  const fly = ['work', 'travelling'].includes(state.view) && next !== state.chapter && !motionPreference.matches && state.image && context;
  const departure = fly ? { chapter: state.chapter, camera: reversing ? flightCamera() : destinationCamera(), cell: [...state.focusCell], image: activeFrameImage, mask: state.chapter === 1 && state.frame === 2 } : null;
  state.chapter = next; state.tourElapsed = 0;
  const chapter = DEMO.chapters[state.chapter];
  state.focusCell = chapter.cell;
  $('#playTitle').textContent = chapter.title; $('#playEyebrow').textContent = chapter.eyebrow;
  $('#matchInfo').hidden = state.chapter > 1; $('#timeline').hidden = state.chapter > 1;
  $('#frameSource').textContent = state.chapter < 2 ? '球场位置示意' : '回合分析图';
  $('#frameNote').hidden = true;
  $('#frameHelp').setAttribute('aria-expanded', 'false');
  $('#contextPanel').hidden = state.chapter === 1; $('#choicePanel').hidden = state.chapter !== 1 || state.revealed; $('#resultPanel').hidden = state.chapter !== 1 || !state.revealed;
  if (state.chapter !== 1) {
    multiline($('#contextTitle'), chapter.panelTitle); $('#contextCopy').textContent = chapter.copy;
    $('#contextDetails').replaceChildren();
    chapter.details.forEach(([title, copy]) => { const card = document.createElement('div'), heading = document.createElement('h3'); heading.textContent = title; card.append(heading, paragraph(copy)); $('#contextDetails').append(card); });
  }
  $('#insightPanel').scrollTop = 0;
  setFrame(chapter.frame ?? 2, chapter.src, chapter.alt);
  updateNavigation();
  fitReplay();
  if (fly) {
    chapterFlight = departure; state.generation++; state.zoom = 0;
    transitionStart = performance.now(); transitionGeneration = state.generation;
    setView('travelling'); drawEye(transitionStart); sound('enter');
  }
  announce('亮点 ' + (state.chapter + 1) + '，' + chapter.title);
}
DEMO.chapters.forEach((chapter, index) => {
  const button = document.createElement('button'); button.textContent = chapter.label; button.addEventListener('click', () => changeChapter(index)); $('#chapterTabs').append(button);
});
$('#prevButton').addEventListener('click', () => changeChapter(state.chapter - 1)); $('#nextButton').addEventListener('click', () => changeChapter(state.chapter + 1));
$('#tourButton').addEventListener('click', () => { createAudio(); setAuto(!state.auto); dismissHint(); });

function navigate(direction) {
  if (state.view === 'home') { if (direction > 0) enter(0); }
  else if (state.view === 'complete') {
    if (direction < 0) {
      changeChapter(DEMO.chapters.length - 1); setView('work');
      $('#insightPanel').focus({ preventScroll: true });
    }
  } else if (state.view === 'work') changeChapter(state.chapter + direction);
}

$$('[data-choice]').forEach(button => button.addEventListener('click', () => {
  takeControl(); state.choice = button.dataset.choice;
  if (state.frame !== 2) setFrame(2);
  $$('[data-choice]').forEach(option => option.setAttribute('aria-pressed', String(option === button)));
  $('#revealButton').disabled = false; sound('freeze');
  setEvidence(state.choice === 'pass' ? 'teammate' : 'carrier', true);
  announce('你的选择：' + (state.choice === 'pass' ? '传给空位的马绍尔' : '自己突破出手'));
}));
function reveal(user = true) {
  if (user) takeControl(); state.revealed = true;
  if (state.frame !== 2) setFrame(2);
  $('#choicePanel').hidden = true; $('#resultPanel').hidden = false;
  $('#yourChoice').replaceChildren();
  $('#yourChoice').append(state.choice ? '你的选择 · ' : '决策对比 · ');
  const label = document.createElement('span'); label.textContent = state.choice === 'pass' ? '传给马绍尔' : state.choice === 'shoot' ? '自己突破出手' : '出手与传球'; $('#yourChoice').append(label);
  $('#estimateGrid').replaceChildren();
  DEMO.decision.estimates.forEach(estimate => {
    const card = document.createElement('div'); card.className = 'estimate';
    const note = document.createElement('small'), value = document.createElement('strong'), text = document.createElement('label');
    note.textContent = estimate.note; value.textContent = String(estimate.value); text.textContent = estimate.label; card.append(note, value, text); $('#estimateGrid').append(card);
  });
  const dl = document.createElement('dl'); DEMO.decision.sources.forEach(([title, copy]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = title; dd.textContent = copy; dl.append(dt, dd); }); $('#sourceCopy').replaceChildren(dl);
  $('#insightPanel').scrollTop = 0; updateNavigation(); sound('reveal');
  if (user) { $('#chooseAgain').focus({ preventScroll: true }); announce('已揭晓：自己出手约 106，传给马绍尔约 113。差距在误差内，不能判断哪种选择更优。'); }
}
$('#revealButton').addEventListener('click', () => reveal()); $('#skipChoice').addEventListener('click', () => reveal());
$('#chooseAgain').addEventListener('click', () => {
  takeControl(); state.revealed = false; state.choice = null;
  $$('[data-choice]').forEach(button => button.setAttribute('aria-pressed', 'false')); $('#revealButton').disabled = true;
  $('#sourceDetails').open = false; $('#choicePanel').hidden = false; $('#resultPanel').hidden = true; $('#insightPanel').scrollTop = 0;
  setFrame(2); updateNavigation(); $$('[data-choice]')[0].focus({ preventScroll: true });
});

function clearEvidence() {
  clearTimeout(evidenceTimer); state.evidence = null;
  $$('#evidenceOverlay g').forEach(group => group.classList.remove('active')); $('#passRoute').classList.remove('active'); $('#evidenceCaption').hidden = true;
  $$('[data-evidence]').forEach(button => button.setAttribute('aria-pressed', 'false'));
}
function setEvidence(target, transient = false) {
  if (state.chapter !== 1 || state.frame !== 2) return;
  clearEvidence(); state.evidence = target;
  $$('#evidenceOverlay g').forEach(group => group.classList.toggle('active', group.dataset.mark === target));
  $('#passRoute').classList.toggle('active', target === 'teammate');
  $('#evidenceCaption').hidden = false;
  $('#evidenceCaption').textContent = target === 'teammate' ? '马绍尔的位置 · 传球路线示意' : target === 'defender' ? '补防球员的位置' : '弗拉格的位置';
  $$('[data-evidence]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.evidence === target)));
  if (transient) evidenceTimer = setTimeout(clearEvidence, 3200);
}
$$('[data-evidence]').forEach(button => button.addEventListener('click', async () => {
  takeControl(); const target = button.dataset.evidence;
  if (state.evidence === target) { clearEvidence(); return; }
  if (state.frame !== 2) await setFrame(2);
  setEvidence(target);
}));
$$('#timeline button').forEach(button => button.addEventListener('click', () => {
  takeControl(); const index = Number(button.dataset.frame);
  if (index === 2) { changeChapter(1); return; }
  changeChapter(0); setFrame(index);
  $('#playEyebrow').textContent = 'PLAY 01 / ' + DEMO.frames[index].label;
  $('#playTitle').textContent = index === 0 ? '弗拉格 · 回合开始' : '弗拉格 · 面对防守';
  multiline($('#contextTitle'), index === 0 ? '先看回合开始，\n再判断选择。' : DEMO.chapters[0].panelTitle);
  $('#contextCopy').textContent = index === 0 ? '先看回合开始时的站位，再回看面对防守与决策时刻。' : DEMO.chapters[0].copy;
  announce('回看 ' + DEMO.frames[index].clock + '，' + $('#playTitle').textContent);
}));
$('#frameHelp').addEventListener('click', () => {
  takeControl(); $('#frameNote').hidden = !$('#frameNote').hidden;
  $('#frameHelp').setAttribute('aria-expanded', String(!$('#frameNote').hidden));
  $('#frameNote').textContent = state.chapter < 2 ? '通过三个关键时刻回看这一回合。球员站位采用人工标注，框线与传球路线用于说明球场位置；决策估算在右侧分析中揭晓。' : '比赛关键帧与样例分析结果一同呈现。画面中的球员、数字和位置标注对应这一回合，结合右侧解读理解出手环境、防守牵引与空间变化。';
  fitReplay();
});

addEventListener('pointermove', event => {
  if (state.view !== 'home' || event.pointerType === 'touch' || motionPreference.matches) return;
  state.pointer.tx = (event.clientX / width - .5) * 2; state.pointer.ty = (event.clientY / height - .5) * 2;
});
document.addEventListener('pointerleave', () => { state.pointer.tx = state.pointer.ty = 0; });
$$('.magnetic').forEach(button => {
  button.addEventListener('pointermove', event => {
    if (motionPreference.matches || event.pointerType === 'touch') return;
    const rect = button.getBoundingClientRect(); button.style.setProperty('--mx', clamp((event.clientX - rect.left - rect.width / 2) / 20, -3, 3) + 'px'); button.style.setProperty('--my', clamp((event.clientY - rect.top - rect.height / 2) / 14, -3, 3) + 'px');
  });
  button.addEventListener('pointerleave', () => { button.style.removeProperty('--mx'); button.style.removeProperty('--my'); });
});

addEventListener('wheel', event => {
  if (event.ctrlKey || state.view === 'entering') return;
  if (state.view === 'work' && (innerWidth <= 850 || innerHeight <= 590)) {
    takeControl();
    const atStart = document.body.scrollTop <= 1 && scrollY <= 1;
    if (!(state.chapter === 0 && atStart && event.deltaY < 0)) return;
  }
  if (event.target.closest('#insightPanel, #previewMenu, .inline-note')) return;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY) return;
  event.preventDefault();
  const now = performance.now(), direction = Math.sign(event.deltaY);
  if (state.view === 'travelling') {
    if (Math.abs(event.deltaY) >= 36 && state.chapter + direction === chapterFlight?.chapter) {
      wheelSum = 0; wheelDirection = direction; wheelTime = now; wheelLock = now + 650;
      changeChapter(chapterFlight.chapter);
    }
    return;
  }
  if (now - wheelTime > 180 || direction !== wheelDirection) { wheelSum = 0; wheelLock = 0; }
  wheelDirection = direction; wheelTime = now;
  if (now < wheelLock) return;
  wheelSum += Math.abs(event.deltaY) * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? height : 1);
  if (wheelSum < 36) return;
  wheelSum = 0; wheelLock = now + 650;
  navigate(direction);
}, { passive: false });
addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); if (state.view !== 'home') home(); return; }
  if (event.target.closest('button,a,input,select,textarea,summary,[contenteditable=true]')) return;
  const panel = event.target.closest('#insightPanel');
  if (panel && panel.scrollHeight > panel.clientHeight + 1 && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' '].includes(event.key)) {
    takeControl(); return;
  }
  if (event.repeat || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', ' '].includes(event.key)) return;
  event.preventDefault();
  const direction = ['ArrowUp', 'ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1;
  if (state.view === 'entering') { if (direction > 0) { state.zoom = 1; finishEntry(); } }
  else if (state.view === 'travelling') { if (state.chapter + direction === chapterFlight?.chapter) changeChapter(chapterFlight.chapter); }
  else navigate(direction);
});
document.addEventListener('visibilitychange', () => { document.body.classList.toggle('document-hidden', document.hidden); lastFrameTime = performance.now(); });

$('#previewMenu').hidden = new URLSearchParams(location.search).get('preview') !== '1';
syncSound(); updateNavigation();
})();
