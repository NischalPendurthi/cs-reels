/* CS Reels: an endless-ish feed of core CS clips.
 * Data: data/index.json + data/days/<date>.json (written by the daily pipeline).
 * Progress lives in localStorage on this device. */
'use strict';

const TOPICS = {
  dbms: { name: 'DBMS', color: 'var(--dbms)' },
  cn: { name: 'Networks', color: 'var(--cn)' },
  coa: { name: 'Architecture', color: 'var(--coa)' },
  cpp: { name: 'C++', color: 'var(--cpp)' },
  os: { name: 'OS', color: 'var(--os)' },
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

function orderUnseen(list) {
  // Interleave topics in runs of up to 3, keep each topic roughly in syllabus order,
  // and never put two clips from the same video next to each other: within a topic,
  // take the next clip from the earliest video that isn't the one just shown
  // (so a lecture's clips alternate with the next video's instead of coming in a row).
  // A video with more than half of the remaining clips is placed early, or it would
  // pile up at the end with nothing left to separate its clips.
  const per = {};
  list.forEach(c => {
    const t = (per[c.topic] = per[c.topic] || []);
    let v = t.find(v => v.id === c.videoId);
    if (!v) t.push((v = { id: c.videoId, topic: c.topic, clips: [] }));
    v.clips.push(c);
  });
  const keys = Object.keys(per);
  const out = [];
  let last = null, ti = 0, run = 0;
  const take = v => {
    const c = v.clips.shift();
    if (!v.clips.length) per[v.topic].splice(per[v.topic].indexOf(v), 1);
    out.push(c);
    last = c.videoId;
  };
  while (out.length < list.length) {
    const left = list.length - out.length;
    const all = keys.flatMap(k => per[k]);
    const big = all.reduce((a, v) => (v.clips.length > a.clips.length ? v : a));
    if (big.id !== last && 2 * big.clips.length > left) {
      if (big.topic !== keys[ti]) { ti = keys.indexOf(big.topic); run = 0; }
      take(big); run++;
      continue;
    }
    // next eligible clip in topic order, runs of up to 3 per topic
    let v = null;
    for (let step = 0; step <= keys.length && !v; step++) {
      if (step > 0 || run >= 3) { ti = (ti + 1) % keys.length; run = 0; }
      v = per[keys[ti]].find(v => v.id !== last);
    }
    if (!v) v = all[0]; // only one video left: back-to-back clips are unavoidable
    take(v); run++;
  }
  return out;
}

function buildQueue() {
  const f = S.filter;
  const now = Date.now();
  const pool = clips.filter(c => !S.reported[c.id] && (f === 'all' || c.topic === f));
  const unseen = orderUnseen(pool.filter(c => !S.seen[c.id]));
  const due = pool.filter(c => S.liked[c.id] && S.liked[c.id].due <= now && S.seen[c.id]);

  const items = [];
  const quizPool = [];
  let n = 0, di = 0;
  let revisionPending = false;
  unseen.forEach((c, i) => {
    items.push({ type: 'reel', clip: c });
    if (c.quiz && !(c.id in S.quiz)) quizPool.push(c);
    n++;
    if (n % REVISION_EVERY === 0) revisionPending = true;
    // slot a revision reel in, but not next to a clip from the same video
    const next = unseen[i + 1];
    if (revisionPending && di < due.length && due[di].videoId !== c.videoId &&
        (!next || due[di].videoId !== next.videoId)) {
      items.push({ type: 'reel', clip: due[di++], revision: true });
      revisionPending = false;
    }
    if (n % QUIZ_EVERY === 0 && quizPool.length) {
      const pick = quizPool.splice(Math.floor(Math.random() * quizPool.length), 1)[0];
      items.push({ type: 'quiz', clip: pick });
      quizPool.length = 0; // only quiz on what you just watched
    }
  });
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
      <div class="meta">${esc(c.channel)} · ${fmt(c.end - c.start)}${c.syllabus ? ` · ${esc(c.syllabus)}` : c.src && c.src.startsWith('prephub') ? ` · ${esc(c.subtopic)}` : ''}</div>
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

/* ---------------- player ----------------
 * ONE YouTube player for the whole feed, in a fixed layer that sits over the
 * active reel's frame. Reusing it keeps sound permission between reels, and the
 * iframe is taller than the visible box so YouTube's title bar / logo are cropped. */
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
const CROP = 70; // px of YouTube chrome hidden above and below the video
let ytReady = !!(window.YT && window.YT.Player);
let soundOn = NATIVE; // the Android app allows sound without a tap
let current = null;
let player = null;
let playerReady = false;
let playerItem = null;
let tick = null;
let watchedSec = 0;
let started = false;
let autoplayCheck = null;
const layer = $('#playerLayer');

window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  if (current) activate(current, true);
};

function placeLayer() {
  if (!current || !playerItem) return;
  const frame = $('.frame', current);
  if (!frame) return;
  const r = frame.getBoundingClientRect();
  Object.assign(layer.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
}

function showLayer(on) {
  layer.classList.toggle('on', on && started);
}

function activate(slide, force = false) {
  if (slide === current && !force) return;
  deactivate();
  current = slide;
  const i = +slide.dataset.i;
  if (i >= rendered - 3) renderMore(6);
  const item = queue[i];
  if (item?.type !== 'reel' || !ytReady) { if (item?.type !== 'reel') pausePlayer(); return; }
  load(item);
}

function deactivate() {
  clearInterval(tick);
  clearTimeout(autoplayCheck);
  tick = null;
  playerItem = null;
  started = false;
  showLayer(false);
  if (current) {
    const t = $('.thumb', current);
    if (t) t.style.opacity = 1;
    current.classList.remove('is-paused');
  }
  current = null;
}

function pausePlayer() {
  if (player && playerReady) try { player.pauseVideo(); } catch (e) { /* noop */ }
}

function load(item) {
  const c = item.clip;
  playerItem = item;
  watchedSec = 0;
  started = false;
  placeLayer();
  if (!player) {
    player = new YT.Player('ytHost', {
      videoId: c.videoId,
      width: '100%', height: '100%',
      playerVars: {
        start: c.start, end: c.end, autoplay: 1, playsinline: 1, controls: 0,
        rel: 0, modestbranding: 1, iv_load_policy: 3, disablekb: 1, fs: 0, cc_load_policy: 0,
      },
      events: {
        onReady: e => {
          playerReady = true;
          if (soundOn) e.target.unMute(); else e.target.mute();
          if (playerItem) {
            const pc = playerItem.clip;
            if (pc.videoId !== c.videoId || pc.start !== c.start) e.target.loadVideoById({ videoId: pc.videoId, startSeconds: pc.start, endSeconds: pc.end });
            else e.target.playVideo();
            armAutoplayCheck();
          }
        },
        onStateChange: onState,
        onError: () => { if (playerItem) toast('This video can’t play here. Swipe on.'); },
      },
    });
  } else if (playerReady) {
    if (soundOn) player.unMute();
    player.loadVideoById({ videoId: c.videoId, startSeconds: c.start, endSeconds: c.end });
    armAutoplayCheck();
  }
  clearInterval(tick);
  tick = setInterval(onTick, 250);
}

// Nothing playing after 2s? Either the browser blocked sound (no tap yet) or YouTube is
// showing an ad (the API reports "unstarted" during ads). Never leave a frozen thumbnail
// over audio: reveal the player. In the browser, also fall back to muted + a sound button.
// The Android app always allows sound, so it never mutes.
function armAutoplayCheck() {
  clearTimeout(autoplayCheck);
  const item = playerItem;
  autoplayCheck = setTimeout(() => {
    if (playerItem !== item || started || !player || !current) return;
    if (!NATIVE) {
      soundOn = false;
      player.mute();
      player.playVideo();
      $('#soundPill').hidden = false;
    }
    started = true;
    $('.thumb', current).style.opacity = 0;
    placeLayer();
    showLayer(!scrolling);
  }, 2000);
}

function onState(e) {
  if (!playerItem || !current) return;
  const c = playerItem.clip;
  if (e.data === YT.PlayerState.PLAYING) {
    // ignore the old video still playing for a moment after a switch
    const vid = player.getVideoData?.().video_id;
    if (vid && vid !== c.videoId) return;
    started = true;
    if (soundOn && player.isMuted()) player.unMute();
    $('.thumb', current).style.opacity = 0;
    current.classList.remove('is-paused');
    placeLayer();
    showLayer(!scrolling);
  } else if (e.data === YT.PlayerState.ENDED) {
    player.seekTo(c.start, true); // loop like a reel
    player.playVideo();
  }
}

function onTick() {
  if (!playerItem || !current || !playerReady) return;
  const c = playerItem.clip;
  let t = 0;
  try { t = player.getCurrentTime(); } catch (e) { return; }
  if (player.getVideoData?.().video_id !== c.videoId) return;
  if (player.getPlayerState() === YT.PlayerState.PLAYING) {
    watchedSec += 0.25;
    if (watchedSec >= SEEN_AFTER_SEC) markSeen(playerItem);
  }
  const frac = Math.max(0, Math.min(1, (t - c.start) / (c.end - c.start)));
  const bar = $('.progress i', current);
  if (bar) bar.style.width = (frac * 100).toFixed(1) + '%';
  if (t >= c.end - 0.4) { player.seekTo(c.start, true); player.playVideo(); }
}

// Hide the fixed player while the feed moves; show it again once the swipe settles.
let scrolling = false;
let scrollTimer = null;
function settle() {
  scrolling = false;
  placeLayer();
  showLayer(true);
}
feed.addEventListener('scroll', () => {
  if (!scrolling) { scrolling = true; showLayer(false); }
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(settle, 140);
}, { passive: true });
if ('onscrollend' in window) feed.addEventListener('scrollend', () => { clearTimeout(scrollTimer); settle(); });
window.addEventListener('resize', placeLayer);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pausePlayer();
  else if (player && playerItem && current && !current.classList.contains('is-paused')) try { player.playVideo(); } catch (e) { /* noop */ }
});

function togglePause() {
  if (!player || !current || !playerReady) return;
  const st = player.getPlayerState();
  if (st === YT.PlayerState.PLAYING) { player.pauseVideo(); current.classList.add('is-paused'); }
  else { player.playVideo(); current.classList.remove('is-paused'); }
}

function enableSound() {
  soundOn = true;
  $('#soundPill').hidden = true;
  if (player && playerReady) { try { player.unMute(); player.setVolume(100); player.playVideo(); } catch (e) { /* not ready */ } }
}
$('#soundPill').addEventListener('click', enableSound);

/* ---------------- actions ---------------- */
function markSeen(item) {
  const c = item.clip;
  if (item._counted) return;
  item._counted = true;
  S.seen[c.id] = Date.now();
  const d = today();
  if (!S.days.includes(d)) { S.days.push(d); save(); scheduleNotifications(); }
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
    ${LN ? `<h3>Reminders</h3>
    <p class="small">Morning “new clips” at ${MORNING_HOUR}:00 and a ${EVENING_HOUR}:00 streak nudge (skipped if you already watched today).</p>
    <div class="row" style="display:flex;gap:10px"><button class="secondary" id="notifyBtn">${S.notify === false ? 'Turn reminders on' : 'Turn reminders off'}</button></div>` : ''}
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
  if (e.target.id === 'notifyBtn') {
    S.notify = S.notify === false;
    save();
    scheduleNotifications();
    e.target.textContent = S.notify === false ? 'Turn reminders on' : 'Turn reminders off';
    toast(S.notify === false ? 'Reminders off' : 'Reminders on');
  }
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

/* ---------------- notifications (Android app only) ---------------- */
const LN = NATIVE ? window.Capacitor?.Plugins?.LocalNotifications : null;
const MORNING_HOUR = 8, EVENING_HOUR = 21;

async function scheduleNotifications() {
  if (!LN) return;
  try {
    const pending = await LN.getPending();
    if (pending.notifications?.length) await LN.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
    if (S.notify === false) return;
    let perm = await LN.checkPermissions();
    if (perm.display !== 'granted') perm = await LN.requestPermissions();
    if (perm.display !== 'granted') return;
    const now = new Date();
    const watchedToday = S.days.includes(today());
    const st = streak();
    const unseen = clips.filter(c => !S.seen[c.id] && !S.reported[c.id]).length;
    const topics = Object.values(TOPICS).map(t => t.name);
    const list = [];
    for (let d = 0; d < 7; d++) {
      const m = new Date(now); m.setDate(now.getDate() + d); m.setHours(MORNING_HOUR, 0, 0, 0);
      if (m > now) list.push({
        id: 100 + d, title: 'Fresh CS reels are in ☕',
        body: `${unseen}+ clips waiting. Today: ${topics[(m.getDate()) % topics.length]} and more.`,
        schedule: { at: m, allowWhileIdle: true },
      });
      const ev = new Date(now); ev.setDate(now.getDate() + d); ev.setHours(EVENING_HOUR, 0, 0, 0);
      if (ev <= now || (d === 0 && watchedToday)) continue;
      const keepStreak = (d === 0 || (d === 1 && watchedToday)) && st > 0;
      list.push({
        id: 200 + d,
        title: keepStreak ? `Keep your ${st}-day streak 🔥` : '5 minutes of CS before bed?',
        body: keepStreak ? 'One reel keeps it alive.' : 'A few deep-dive clips are waiting for you.',
        schedule: { at: ev, allowWhileIdle: true },
      });
    }
    if (list.length) await LN.schedule({ notifications: list });
  } catch (e) { console.warn('notifications', e); }
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
  const start = () => {
    soundOn = true; // in the browser this click is the gesture that allows sound
    $('#splash').hidden = true;
    renderMore(6);
    feed.focus();
  };
  if (NATIVE) {
    start();
    scheduleNotifications();
  } else {
    btn.addEventListener('click', start);
  }
})();
