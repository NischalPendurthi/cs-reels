/* CS Reels: an endless-ish feed of core CS clips.
 * Data: data/index.json + data/days/<date>.json (written by the daily pipeline).
 * Progress lives in localStorage on this device. */
'use strict';

const TOPICS = {
  dbms: { name: 'DBMS', color: 'var(--dbms)' },
  cn: { name: 'Networks', color: 'var(--cn)' },
  coa: { name: 'Architecture', color: 'var(--coa)' },
  cpp: { name: 'C++', color: 'var(--cpp)' },
  aiml: { name: 'AI & ML', color: 'var(--aiml)' },
};
const STORE_KEY = 'csreels.v1';
const DAY = 86400000;
const REVISION_GAPS = [1, 3, 7, 21]; // days between revisions of a liked clip
const QUIZ_EVERY = 5;                // a quiz card after every N new reels
const REVISION_EVERY = 7;            // a due revision after every N new reels
const SEEN_AFTER_SEC = 4;

const $ = (s, el = document) => el.querySelector(s);
const feed = $('#feed');

/* ---------------- state ---------------- */
function loadState() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { s = {}; }
  return Object.assign({ seen: {}, liked: {}, reported: {}, quiz: {}, days: [], filter: 'all' }, s);
}
let S = loadState();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* private mode */ }
}
const today = () => new Date().toLocaleDateString('en-CA');

/* ---------------- data ---------------- */
let clips = [];
let byId = {};
let indexInfo = null;

async function loadData() {
  const idx = await fetch('data/index.json', { cache: 'no-cache' }).then(r => {
    if (!r.ok) throw new Error('index ' + r.status);
    return r.json();
  });
  indexInfo = idx;
  const days = await Promise.all(idx.days.map(d =>
    fetch('data/' + d.file).then(r => r.ok ? r.json() : { clips: [] }).catch(() => ({ clips: [] }))));
  clips = [];
  days.forEach(d => (d.clips || []).forEach(c => { c._ord = clips.length; clips.push(c); }));
  byId = Object.fromEntries(clips.map(c => [c.id, c]));
}

/* ---------------- queue ---------------- */
let queue = [];
let rendered = 0;

function orderUnseen(list, filter) {
  // Keep each topic in syllabus/lecture order; interleave topics in runs of 3.
  if (filter !== 'all') return list;
  const per = {};
  list.forEach(c => (per[c.topic] = per[c.topic] || []).push(c));
  const keys = Object.keys(per);
  const out = [];
  let left = list.length;
  while (left > 0) {
    for (const k of keys) {
      const q = per[k];
      for (let i = 0; i < 3 && q.length; i++) { out.push(q.shift()); left--; }
    }
  }
  return out;
}

function buildQueue() {
  const f = S.filter;
  const now = Date.now();
  const pool = clips.filter(c => !S.reported[c.id] && (f === 'all' || c.topic === f));
  const unseen = orderUnseen(pool.filter(c => !S.seen[c.id]), f);
  const due = pool.filter(c => S.liked[c.id] && S.liked[c.id].due <= now && S.seen[c.id]);

  const items = [];
  const quizPool = [];
  let n = 0, di = 0;
  for (const c of unseen) {
    items.push({ type: 'reel', clip: c });
    if (c.quiz && !(c.id in S.quiz)) quizPool.push(c);
    n++;
    if (n % REVISION_EVERY === 0 && di < due.length) items.push({ type: 'reel', clip: due[di++], revision: true });
    if (n % QUIZ_EVERY === 0 && quizPool.length) {
      const pick = quizPool.splice(Math.floor(Math.random() * quizPool.length), 1)[0];
      items.push({ type: 'quiz', clip: pick });
      quizPool.length = 0; // only quiz on what you just watched
    }
  }
  while (di < due.length) items.push({ type: 'reel', clip: due[di++], revision: true });
  items.push({ type: 'caughtup' });
  return items;
}

/* ---------------- rendering ---------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const fmt = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const thumb = id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

function reelHTML(item) {
  const c = item.clip;
  const t = TOPICS[c.topic] || { name: c.topic };
  const liked = !!S.liked[c.id];
  return `
    <div class="bg" style="background-image:url('${thumb(c.videoId)}')"></div>
    <div class="stage">
      <div class="frame">
        <div class="thumb" style="background-image:url('${thumb(c.videoId)}')"></div>
        <div class="player"></div>
        <div class="tap"></div>
        <div class="paused-icon">▶</div>
      </div>
      <div class="progress"><i></i></div>
    </div>
    <div class="info">
      <div class="tagline">
        <span class="tag">${esc(t.name)}</span>
        <span class="tag ghost">${c.kind === 'short' ? 'Short' : 'Lecture clip'}</span>
        ${item.revision ? '<span class="tag rev">Revision</span>' : ''}
      </div>
      <h3>${esc(c.title)}</h3>
      <p class="hook">${esc(c.hook)}</p>
      <div class="meta">${esc(c.channel)} · ${fmt(c.end - c.start)}</div>
      <button class="more">more</button>
      <p class="summary">${esc(c.summary)}<br><span class="small">From: ${esc(c.videoTitle)}</span></p>
    </div>
    <div class="rail">
      <button class="like ${liked ? 'liked' : ''}" aria-label="Like">${liked ? '♥' : '♡'}</button>
      <small>${liked ? 'saved' : 'like'}</small>
      <a class="yt" href="https://www.youtube.com/watch?v=${c.videoId}&t=${c.start}s" target="_blank" rel="noopener" aria-label="Open full video on YouTube">↗</a>
      <small>full</small>
      <button class="report" aria-label="Report bad clip">⚑</button>
      <small>report</small>
    </div>`;
}

function quizHTML(item) {
  const c = item.clip, q = c.quiz;
  const t = TOPICS[c.topic] || { name: c.topic };
  return `
    <div class="card">
      <div class="kicker">Quick check · ${esc(t.name)}</div>
      <h2>${esc(q.question)}</h2>
      <div class="opts">
        ${q.options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join('')}
      </div>
      <p class="explain"></p>
      <div class="swipe-hint">From “${esc(c.title)}” · swipe up to continue</div>
    </div>`;
}

function caughtUpHTML() {
  const seenClips = clips.filter(c => S.seen[c.id] && !S.reported[c.id] && (S.filter === 'all' || c.topic === S.filter));
  const practice = seenClips.filter(c => c.quiz && S.quiz[c.id] !== true).length;
  const liked = seenClips.filter(c => S.liked[c.id]).length;
  const label = S.filter === 'all' ? 'everything' : (TOPICS[S.filter]?.name || S.filter);
  return `
    <div class="card">
      <div class="kicker">All caught up</div>
      <h2>You've watched ${esc(label)} for now 🎉</h2>
      <p>New clips get added every day. Come back tomorrow, or put the phone down. That counts as a win too.</p>
      <div class="row">
        ${practice ? `<button class="primary" data-act="practice">Practice quiz (${practice})</button>` : ''}
        ${liked ? `<button class="secondary" data-act="liked">Rewatch liked (${liked})</button>` : ''}
        ${S.filter !== 'all' ? `<button class="secondary" data-act="all">Show all topics</button>` : ''}
      </div>
    </div>`;
}

function makeSlide(item, i) {
  const el = document.createElement('section');
  el.dataset.i = i;
  if (item.type === 'reel') {
    el.className = 'slide reel' + (item.clip.vertical ? ' vertical' : '');
    el.style.setProperty('--topic', TOPICS[item.clip.topic]?.color || 'var(--accent)');
    el.innerHTML = reelHTML(item);
  } else if (item.type === 'quiz') {
    el.className = 'slide card-slide quiz';
    el.innerHTML = quizHTML(item);
  } else {
    el.className = 'slide card-slide caughtup';
    el.innerHTML = caughtUpHTML();
  }
  return el;
}

const io = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) activate(e.target);
}, { root: feed, threshold: 0.6 });

function renderMore(n) {
  const end = Math.min(queue.length, rendered + n);
  for (; rendered < end; rendered++) {
    const el = makeSlide(queue[rendered], rendered);
    feed.appendChild(el);
    io.observe(el);
  }
}

function rebuildFeed() {
  deactivate();
  queue = buildQueue();
  rendered = 0;
  feed.innerHTML = '';
  feed.scrollTop = 0;
  renderMore(6);
  renderChips();
}

function appendItems(items) {
  // Insert after the caught-up card (always the last rendered item).
  queue.push(...items, { type: 'caughtup' });
  renderMore(6);
}

/* ---------------- chips ---------------- */
function renderChips() {
  const unseen = k => clips.filter(c => !S.seen[c.id] && !S.reported[c.id] && (k === 'all' || c.topic === k)).length;
  const keys = ['all', ...Object.keys(TOPICS)];
  $('#chips').innerHTML = keys.map(k =>
    `<button class="chip" data-k="${k}" aria-pressed="${S.filter === k}">${k === 'all' ? 'All' : TOPICS[k].name}<span class="n">${unseen(k)}</span></button>`
  ).join('');
}
$('#chips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b || b.dataset.k === S.filter) return;
  S.filter = b.dataset.k;
  save();
  rebuildFeed();
});

/* ---------------- player ---------------- */
let ytReady = !!(window.YT && window.YT.Player);
let soundOn = false;
let current = null;
let player = null;
let tick = null;
let mountToken = 0;
let watchedSec = 0;

window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  if (current && queue[+current.dataset.i]?.type === 'reel' && !player) mount(current);
};

function activate(slide) {
  if (slide === current) return;
  deactivate();
  current = slide;
  const i = +slide.dataset.i;
  if (i >= rendered - 3) renderMore(6);
  if (queue[i]?.type === 'reel' && ytReady) mount(slide);
}

function deactivate() {
  clearInterval(tick);
  tick = null;
  mountToken++;
  if (player) { try { player.destroy(); } catch (e) { /* already gone */ } }
  player = null;
  if (current) {
    const t = $('.thumb', current);
    if (t) t.style.opacity = 1;
    current.classList.remove('is-paused');
    const p = $('.player', current);
    if (p) p.innerHTML = '';
  }
  current = null;
}

function mount(slide) {
  const item = queue[+slide.dataset.i];
  const c = item.clip;
  const token = ++mountToken;
  const host = document.createElement('div');
  $('.player', slide).appendChild(host);
  watchedSec = 0;
  let started = false;

  player = new YT.Player(host, {
    videoId: c.videoId,
    width: '100%', height: '100%',
    playerVars: {
      start: c.start, end: c.end, autoplay: 1, playsinline: 1, controls: 0,
      rel: 0, modestbranding: 1, iv_load_policy: 3, disablekb: 1, fs: 0, mute: soundOn ? 0 : 1,
    },
    events: {
      onReady: e => {
        if (token !== mountToken) return;
        soundOn ? e.target.unMute() : e.target.mute();
        e.target.playVideo();
        // Browser blocked autoplay with sound? fall back to muted.
        setTimeout(() => {
          if (token !== mountToken || started) return;
          soundOn = false;
          e.target.mute();
          e.target.playVideo();
          $('#soundPill').hidden = false;
        }, 1800);
      },
      onStateChange: e => {
        if (token !== mountToken) return;
        if (e.data === YT.PlayerState.PLAYING) {
          started = true;
          $('.thumb', slide).style.opacity = 0;
          slide.classList.remove('is-paused');
        } else if (e.data === YT.PlayerState.ENDED) {
          e.target.seekTo(c.start, true); // loop like a reel
          e.target.playVideo();
        }
      },
      onError: () => {
        if (token !== mountToken) return;
        toast('This video can’t play here. Swipe on.');
      },
    },
  });

  clearInterval(tick);
  tick = setInterval(() => {
    if (token !== mountToken || !player || !player.getCurrentTime) return;
    let t = 0;
    try { t = player.getCurrentTime(); } catch (e) { return; }
    if (player.getPlayerState?.() === YT.PlayerState.PLAYING) {
      watchedSec += 0.25;
      if (watchedSec >= SEEN_AFTER_SEC) markSeen(item);
    }
    const frac = Math.max(0, Math.min(1, (t - c.start) / (c.end - c.start)));
    const bar = $('.progress i', slide);
    if (bar) bar.style.width = (frac * 100).toFixed(1) + '%';
    if (t >= c.end - 0.3) { player.seekTo(c.start, true); player.playVideo(); }
  }, 250);
}

function togglePause() {
  if (!player || !current) return;
  const st = player.getPlayerState?.();
  if (st === YT.PlayerState.PLAYING) { player.pauseVideo(); current.classList.add('is-paused'); }
  else { player.playVideo(); current.classList.remove('is-paused'); }
}

function enableSound() {
  soundOn = true;
  $('#soundPill').hidden = true;
  if (player) { try { player.unMute(); player.playVideo(); } catch (e) { /* not ready */ } }
}
$('#soundPill').addEventListener('click', enableSound);

/* ---------------- actions ---------------- */
function markSeen(item) {
  const c = item.clip;
  if (item._counted) return;
  item._counted = true;
  S.seen[c.id] = Date.now();
  const d = today();
  if (!S.days.includes(d)) S.days.push(d);
  if (item.revision && S.liked[c.id]) {
    const l = S.liked[c.id];
    l.stage = (l.stage || 0) + 1;
    l.due = l.stage < REVISION_GAPS.length ? Date.now() + REVISION_GAPS[l.stage] * DAY : Infinity;
  }
  save();
}

function toggleLike(slide, forceOn = false) {
  const item = queue[+slide.dataset.i];
  if (!item || item.type !== 'reel') return;
  const id = item.clip.id;
  const btn = $('.like', slide);
  if (S.liked[id] && !forceOn) {
    delete S.liked[id];
  } else if (!S.liked[id]) {
    S.liked[id] = { t: Date.now(), stage: 0, due: Date.now() + REVISION_GAPS[0] * DAY };
    toast('Saved. It’ll come back for revision tomorrow.');
  }
  const on = !!S.liked[id];
  btn.classList.toggle('liked', on);
  btn.textContent = on ? '♥' : '♡';
  btn.nextElementSibling.textContent = on ? 'saved' : 'like';
  save();
}

function heartPop(slide) {
  const h = document.createElement('div');
  h.className = 'heart-pop';
  h.textContent = '♥';
  h.style.color = '#ff4d6d';
  $('.frame', slide).appendChild(h);
  setTimeout(() => h.remove(), 800);
}

function report(slide) {
  const item = queue[+slide.dataset.i];
  if (!item || !confirm('Hide this clip and report it as bad/wrong?')) return;
  S.reported[item.clip.id] = Date.now();
  save();
  toast('Reported. Export feedback from the progress panel to improve the feed.');
  next();
}

function answerQuiz(slide, btn) {
  const item = queue[+slide.dataset.i];
  const q = item.clip.quiz;
  const pick = +btn.dataset.i;
  const right = pick === q.answer;
  if (!(item.clip.id in S.quiz) || S.quiz[item.clip.id] === false) S.quiz[item.clip.id] = right;
  save();
  slide.querySelectorAll('.opt').forEach((b, i) => {
    b.disabled = true;
    if (i === q.answer) b.classList.add('right');
    else if (i === pick) b.classList.add('wrong');
  });
  const ex = $('.explain', slide);
  ex.textContent = (right ? '✅ Correct. ' : '❌ Not quite. ') + q.explanation;
  $('.card', slide).classList.add('answered');
}

function next() { feed.scrollBy({ top: feed.clientHeight, behavior: 'smooth' }); }
function prev() { feed.scrollBy({ top: -feed.clientHeight, behavior: 'smooth' }); }

let tapTimer = null;
feed.addEventListener('click', e => {
  const slide = e.target.closest('.slide');
  if (!slide) return;
  if (e.target.closest('.tap')) {
    if (tapTimer) { // double tap → like
      clearTimeout(tapTimer); tapTimer = null;
      toggleLike(slide, true); heartPop(slide);
    } else {
      tapTimer = setTimeout(() => {
        tapTimer = null;
        if (!soundOn) enableSound(); else togglePause();
      }, 260);
    }
    return;
  }
  if (e.target.closest('.like')) return toggleLike(slide);
  if (e.target.closest('.report')) return report(slide);
  if (e.target.closest('.more')) {
    slide.classList.toggle('expanded');
    e.target.closest('.more').textContent = slide.classList.contains('expanded') ? 'less' : 'more';
    return;
  }
  const opt = e.target.closest('.opt');
  if (opt && !opt.disabled) return answerQuiz(slide, opt);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'all') { S.filter = 'all'; save(); return rebuildFeed(); }
  if (act === 'practice') {
    const items = clips
      .filter(c => S.seen[c.id] && c.quiz && S.quiz[c.id] !== true && !S.reported[c.id] && (S.filter === 'all' || c.topic === S.filter))
      .sort(() => Math.random() - 0.5).slice(0, 15)
      .map(c => ({ type: 'quiz', clip: c }));
    appendItems(items); next();
  }
  if (act === 'liked') {
    const items = clips.filter(c => S.liked[c.id] && !S.reported[c.id] && (S.filter === 'all' || c.topic === S.filter))
      .map(c => ({ type: 'reel', clip: c, revision: true }));
    appendItems(items); next();
  }
});

document.addEventListener('keydown', e => {
  if (!$('#sheet').hidden || !$('#splash').hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); next(); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); prev(); }
  else if (e.key === ' ') { e.preventDefault(); soundOn ? togglePause() : enableSound(); }
  else if (e.key === 'l' && current) toggleLike(current);
});

/* ---------------- progress sheet ---------------- */
function streak() {
  const set = new Set(S.days);
  let n = 0;
  const d = new Date();
  if (!set.has(d.toLocaleDateString('en-CA'))) d.setDate(d.getDate() - 1);
  while (set.has(d.toLocaleDateString('en-CA'))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function openSheet() {
  const seenN = clips.filter(c => S.seen[c.id]).length;
  const q = Object.values(S.quiz);
  const acc = q.length ? Math.round(100 * q.filter(Boolean).length / q.length) + '%' : '–';
  const due = clips.filter(c => S.liked[c.id] && S.liked[c.id].due <= Date.now()).length;
  const rows = Object.entries(TOPICS).map(([k, t]) => {
    const all = clips.filter(c => c.topic === k && !S.reported[c.id]);
    const seen = all.filter(c => S.seen[c.id]).length;
    const pct = all.length ? Math.round(100 * seen / all.length) : 0;
    return `<div class="topic-row" style="--topic:${t.color}">
      <div class="lbl">${t.name}<span>${seen} / ${all.length}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }).join('');
  const updated = indexInfo?.updated ? new Date(indexInfo.updated).toLocaleString() : '–';
  $('#sheetBody').innerHTML = `
    <div class="stats">
      <div class="stat"><b>${seenN}</b><span>clips watched</span></div>
      <div class="stat"><b>${streak()}🔥</b><span>day streak</span></div>
      <div class="stat"><b>${acc}</b><span>quiz accuracy (${q.length})</span></div>
    </div>
    ${rows}
    <h3>Revision</h3>
    <p class="small">${Object.keys(S.liked).length} saved clips · ${due} due for revision now</p>
    <h3>Library</h3>
    <p class="small">${clips.length} clips · last updated ${esc(updated)}</p>
    <h3>Feedback</h3>
    <p class="small">${Object.keys(S.reported).length} reported clips. Export and drop the file in <code>~/cs-reels/pipeline/feedback/</code>. The next daily run removes them and blocks channels with repeated reports.</p>
    <div class="row" style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="secondary" id="exportBtn">Export feedback</button>
      <button class="secondary" id="resetBtn">Reset progress</button>
    </div>`;
  $('#sheet').hidden = false;
  if (player) try { player.pauseVideo(); } catch (e) { /* noop */ }
}
function closeSheet() {
  $('#sheet').hidden = true;
  if (player && current && !current.classList.contains('is-paused')) try { player.playVideo(); } catch (e) { /* noop */ }
}
$('#statsBtn').addEventListener('click', openSheet);
$('#sheetClose').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', e => {
  if (e.target.id === 'sheet') return closeSheet();
  if (e.target.id === 'exportBtn') exportFeedback();
  if (e.target.id === 'resetBtn' && confirm('Forget watched clips, likes, quiz answers and reports on this device?')) {
    S = Object.assign(loadState(), { seen: {}, liked: {}, reported: {}, quiz: {}, days: [] });
    save(); closeSheet(); rebuildFeed();
  }
});

function exportFeedback() {
  const data = {
    exported: new Date().toISOString(),
    reported: Object.keys(S.reported),
    liked: Object.keys(S.liked),
    seen: Object.keys(S.seen).length,
    quiz: S.quiz,
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cs-reels-feedback-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------------- misc ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ---------------- boot ---------------- */
(async function boot() {
  const info = $('#splashInfo');
  const btn = $('#startBtn');
  try {
    await loadData();
  } catch (e) {
    info.textContent = 'Couldn’t load clips. Run the pipeline first, or check your connection.';
    return;
  }
  const unseen = clips.filter(c => !S.seen[c.id] && !S.reported[c.id]).length;
  info.textContent = `${clips.length} clips in the library · ${unseen} new for you`;
  btn.disabled = false;
  queue = buildQueue();
  renderChips();
  btn.addEventListener('click', () => {
    soundOn = true; // this click is the user gesture that allows sound
    $('#splash').hidden = true;
    renderMore(6);
    feed.focus();
  });
})();
