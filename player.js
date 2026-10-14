/* 말씀 리더 — 소리로 듣기 + 읽기 모드
 * - 서버가 만든 신경망 음성 mp3(장 단위)와 절별 시간표(segs)로 재생 위치 ↔ 절을 맞춘다.
 * - 서버 음성을 못 쓰면 브라우저 내장 음성(speechSynthesis)으로 대신 읽는다.
 * - 읽기 모드: 메뉴를 숨기고 본문만, 조작 막대(dock)는 3초간 조작이 없으면 사라진다.
 * app.js의 전역(S, R, META, VERS, BOOKS, $, $$, api, esc, enc, toast, save, posOf, goto, loadChapter …)을 사용한다.
 */
'use strict';

const Player = (() => {
  S.tts = Object.assign({ rate: 1, voices: {}, autoNext: true, heading: true }, S.tts || {});

  const ICON = {
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>',
    prevv: '<path d="M11 6v12l-8.5-6zM20.5 6v12L12 12z"/>',
    nextv: '<path d="M13 6v12l8.5-6zM3.5 6v12L12 12z"/>',
    prevch: '<path d="M6 6h2.2v12H6zM9.5 12l9.5 6.5v-13z"/>',
    nextch: '<path d="M15.8 6H18v12h-2.2zM14.5 12 5 18.5v-13z"/>',
    gear: '<path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zm8.3 4.6-1.7-.3a6.9 6.9 0 0 1-.6 1.5l1 1.4-1.6 1.6-1.4-1a6.9 6.9 0 0 1-1.5.6l-.3 1.7h-2.3l-.3-1.7a6.9 6.9 0 0 1-1.5-.6l-1.4 1-1.6-1.6 1-1.4a6.9 6.9 0 0 1-.6-1.5l-1.7-.3v-2.3l1.7-.3c.1-.5.3-1 .6-1.5l-1-1.4L7.9 5l1.4 1c.5-.3 1-.5 1.5-.6l.3-1.7h2.3l.3 1.7c.5.1 1 .3 1.5.6l1.4-1 1.6 1.6-1 1.4c.3.5.5 1 .6 1.5l1.7.3z"/>',
    close: '<path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/>',
    exitread: '<path d="M8 3v5H3v2h7V3zm8 0h-2v7h7V8h-5zM3 14v2h5v5h2v-7zm11 0v7h2v-5h5v-2z"/>',
    headphone: '<path d="M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z"/>',
  };
  const svg = n => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICON[n]}</svg>`;
  const RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

  const audio = new Audio();
  audio.preload = 'auto';
  const P = {
    open: false, mode: 'server', version: null, b: 0, c: 0, data: null, curV: null, token: 0,
    loading: false, prefetched: null, sleepAt: 0, sleepEoc: false, speech: null,
  };
  const cache = new Map();             // 장 음성 정보 (key → Promise)
  let reading = false, fadeTimer = 0, userScrollAt = 0, posStateAt = 0;

  /* ---------------------------------------------------------------- 공용 */
  const isText = p => p && p.data && ['bible', 'strong'].includes(p.data.kind);
  const textPanes = () => R.panes.filter(isText);
  const playing = () => P.mode === 'speech' ? !!P.speech && !P.speech.paused : !audio.paused;
  const fmt = t => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const voicePref = () => Object.values(S.tts.voices).filter(Boolean).join(',');
  const shownHere = () => S.book === P.b && S.chapter === P.c;

  function nextOf(b, c, d) {
    c += d;
    if (c < 1) { if (b === 1) return null; b--; c = BOOKS[b - 1].chapters; }
    else if (c > BOOKS[b - 1].chapters) { if (b === 66) return null; b++; c = 1; }
    return { b, c };
  }

  function chapterInfo(version, b, c) {
    const key = [version, b, c, voicePref(), S.tts.heading ? 1 : 0].join('|');
    if (!cache.has(key)) {
      const pr = api(`/api/tts/chapter?v=${enc(version)}&b=${b}&c=${c}&voice=${enc(voicePref())}&heading=${S.tts.heading ? 1 : 0}`);
      pr.catch(() => cache.delete(key));
      cache.set(key, pr);
    }
    return cache.get(key);
  }

  /* ---------------------------------------------------------------- 재생 */
  async function start(version, b, c, fromV = null) {
    const token = ++P.token;
    stopSpeech();
    Object.assign(P, { open: true, version, b, c, data: null, curV: null, loading: true, prefetched: null });
    renderDock(); poke();
    let d;
    try { d = await chapterInfo(version, b, c); }
    catch (e) { d = { error: e.message, fallback: true }; }
    if (token !== P.token) return;
    if (d.error) {
      if (/지원하지 않습니다|찾지 못했습니다/.test(d.error)) { toast(d.error); P.loading = false; return close(); }
      if (d.error !== 'static') toast('서버 음성을 쓸 수 없어 기기 음성으로 읽습니다');
      return startSpeech(version, b, c, fromV, token);
    }
    P.mode = 'server';
    P.data = d;
    S.tts.voices[d.locale] = d.voice; save();
    const url = new URL(d.url, location.href).href;
    if (audio.src !== url) audio.src = url;
    audio.defaultPlaybackRate = audio.playbackRate = S.tts.rate;
    const at = fromV != null ? (d.segs.find(s => s.v >= fromV)?.s ?? 0) : 0;
    await seekWhenReady(at);
    try { await audio.play(); }
    catch { toast('재생 버튼을 한 번 더 눌러 주세요'); }
    P.loading = false;
    media();
    renderDock();
  }

  function seekWhenReady(t) {
    return new Promise(res => {
      const go = () => { try { audio.currentTime = t; } catch { /* 무시 */ } res(); };
      if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
    });
  }

  function toggle() {
    if (!P.open) return startFromView();
    if (P.loading) return;
    if (P.mode === 'speech') {
      if (!P.speech) return;
      if (P.speech.paused) { P.speech.paused = false; speechSynthesis.resume(); } else { P.speech.paused = true; speechSynthesis.pause(); }
    } else if (audio.paused) audio.play(); else audio.pause();
    renderDock();
  }

  function startFromView(pane) {
    const p = pane || (isText(R.driver) ? R.driver : textPanes()[0]);
    if (!p) return toast('소리로 읽을 수 있는 번역본 창이 없습니다');
    let from = null;
    if (R.active && R.active.b === S.book && R.active.c === S.chapter) from = R.active.v;
    else { const pos = posOf(p); if (pos && pos >= 2) from = Math.floor(pos); }
    start(p.cfg.version, S.book, S.chapter, from);
  }

  function playFrom(pane, v) {
    if (!isText(pane)) pane = textPanes()[0];
    if (!pane) return;
    if (P.open && P.version === pane.cfg.version && P.b === S.book && P.c === S.chapter && P.data) return seekVerse(v, true);
    start(pane.cfg.version, S.book, S.chapter, v);
  }

  function seekVerse(v, resume) {
    if (P.mode === 'speech') return speakFrom(P.speech.items.findIndex(x => x.v >= v));
    const seg = P.data?.segs.find(s => s.v >= v);
    if (!seg) return;
    audio.currentTime = seg.s + 0.01;
    if (resume && audio.paused) audio.play();
    onTime();
  }

  function stepVerse(d) {
    if (!P.open) return;
    if (P.mode === 'speech') return speakFrom(Math.max(0, P.speech.i + d));
    const segs = P.data?.segs || [];
    const i = segs.findIndex(s => s.v === P.curV);
    const j = i + d;
    if (j < 0) return seekVerse(segs[0]?.v ?? 0);
    if (j >= segs.length) return stepChapter(1);
    // 절 앞부분(2초 이내)에서 '이전'을 누르면 앞 절로, 그 외에는 현재 절 처음으로
    if (d < 0 && audio.currentTime - segs[i].s > 2) return seekVerse(segs[i].v);
    seekVerse(segs[j].v);
  }

  async function stepChapter(d) {
    if (!P.open) { window.stepChapter(d); return; }   // 듣기 중이 아니면 화면만 넘김
    const n = nextOf(P.b, P.c, d);
    if (!n) return toast(d > 0 ? '마지막 장입니다' : '첫 장입니다');
    const follow = shownHere();
    start(P.version, n.b, n.c);
    if (follow) { S.book = n.b; S.chapter = n.c; await loadChapter(); }
  }

  function close() {
    P.token++;
    audio.pause();
    stopSpeech();
    Object.assign(P, { open: false, data: null, curV: null, loading: false, sleepAt: 0, sleepEoc: false, sleepKey: '0' });
    $$('.speaking').forEach(e => e.classList.remove('speaking'));
    $('#ttsPanel').hidden = true;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    renderDock();
  }

  /* 재생 위치 → 지금 읽는 절 */
  function onTime() {
    if (P.mode !== 'server' || !P.data) return;
    const t = audio.currentTime, segs = P.data.segs;
    let seg = segs[0];
    for (const s of segs) { if (s.s <= t + 0.05) seg = s; else break; }
    if (seg && seg.v !== P.curV) onVerse(seg.v);
    const bar = $('#dock .dk-bar');
    if (bar) bar.style.width = `${Math.min(100, (t / P.data.dur) * 100)}%`;
    const tm = $('#dock .dk-time');
    if (tm) tm.textContent = `${fmt(t)} / ${fmt(P.data.dur)}`;
    if (!P.prefetched && t > P.data.dur * 0.4 && S.tts.autoNext) {   // 다음 장 미리 만들기
      const n = nextOf(P.b, P.c, 1);
      P.prefetched = true;
      if (n) chapterInfo(P.version, n.b, n.c).catch(() => {});
    }
    if (P.sleepAt && Date.now() >= P.sleepAt) sleepNow();
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && Date.now() - posStateAt > 1000 && isFinite(audio.duration)) {
      posStateAt = Date.now();
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(t, audio.duration), playbackRate: audio.playbackRate }); } catch { /* 무시 */ }
    }
  }

  function onVerse(v) {
    P.curV = v;
    const title = $('#dock .dk-title');
    if (title) title.textContent = `${bookName(P.b)} ${P.c}${v ? ':' + v : '장'} · ${P.version}`;
    $$('.speaking').forEach(e => e.classList.remove('speaking'));
    if (!shownHere() || !v) return;
    for (const p of R.panes) {
      const el = $(`.verse[data-v="${v}"]`, p.content) || p.items.filter(x => x.v <= v).at(-1)?.el;
      if (el) el.classList.add('speaking');
    }
    follow(v);
  }

  /* 읽는 절이 화면 위쪽 1/4쯤 오도록 따라간다 — 사용자가 직접 스크롤하면 6초간 멈춤 */
  function follow(v) {
    if (document.hidden || Date.now() - userScrollAt < 6000) return;
    for (const p of R.panes) {
      if (p !== R.panes.find(x => x.cfg.version === P.version) && !(S.sync && p.cfg.synced)) continue;
      const el = $(`.verse[data-v="${v}"]`, p.content) || p.items.filter(x => x.v <= v).at(-1)?.el;
      if (!el) continue;
      const top = el.offsetTop - p.body.clientHeight * 0.25;
      const visible = el.offsetTop > p.body.scrollTop + 20 && el.offsetTop + Math.min(el.offsetHeight, 80) < p.body.scrollTop + p.body.clientHeight * 0.85;
      if (!visible || Math.abs(p.body.scrollTop - top) > p.body.clientHeight * 0.5) p.body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  async function onEnded() {
    if (P.sleepEoc) { P.sleepEoc = false; P.sleepKey = '0'; renderDock(); return toast('이 장까지 들었습니다 — 잠자기 타이머 종료'); }
    if (!S.tts.autoNext) return renderDock();
    stepChapter(1);
  }

  /* ---------------------------------------------------------------- 잠자기 타이머 */
  function sleepNow() {
    P.sleepAt = 0; P.sleepKey = '0';
    const v0 = audio.volume;
    let k = 0;
    const iv = setInterval(() => {           // 4초 동안 서서히 줄이고 멈춤
      k++;
      audio.volume = Math.max(0, v0 * (1 - k / 20));
      if (k >= 20) { clearInterval(iv); audio.pause(); audio.volume = v0; if (P.mode === 'speech') toggle(); renderDock(); }
    }, 200);
  }

  /* ---------------------------------------------------------------- 기기 음성(대체) */
  async function startSpeech(version, b, c, fromV, token) {
    if (!('speechSynthesis' in window)) { P.loading = false; toast('이 기기는 음성 읽기를 지원하지 않습니다'); return close(); }
    const d = await api(`/api/tts/text?v=${enc(version)}&b=${b}&c=${c}&heading=${S.tts.heading ? 1 : 0}`);
    if (token !== P.token) return;
    if (d.error) { toast(d.error); return close(); }
    audio.pause();
    P.mode = 'speech';
    P.loading = false;
    P.speech = { items: d.items.filter(x => x.t), locale: d.locale, i: 0, paused: false, gen: 0 };
    speakFrom(fromV != null ? Math.max(0, P.speech.items.findIndex(x => x.v >= fromV)) : 0);
    renderDock();
  }

  function speakFrom(i) {
    const sp = P.speech;
    if (!sp) return;
    sp.gen++;
    speechSynthesis.cancel();
    sp.i = i; sp.paused = false;
    const gen = sp.gen;
    const it = sp.items[i];
    if (!it) { P.speech = null; return onEnded(); }
    const u = new SpeechSynthesisUtterance(it.t);
    u.lang = sp.locale;
    u.rate = S.tts.rate;
    const vs = speechSynthesis.getVoices().filter(v => v.lang.replace('_', '-') === sp.locale);
    u.voice = vs.find(v => /Natural|Online|Google/.test(v.name)) || vs[0] || null;
    u.onend = () => { if (sp.gen === gen && P.speech === sp) speakFrom(i + 1); };
    onVerse(it.v);
    speechSynthesis.speak(u);
    renderDock();
  }

  function stopSpeech() {
    if (P.speech) { P.speech.gen++; P.speech = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  /* ---------------------------------------------------------------- 잠금화면·이어폰 조작 */
  function media() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${bookName(P.b)} ${P.c}장`, artist: P.version, album: '말씀 리더',
      artwork: [{ src: new URL('icon.svg', location.href).href, sizes: '512x512', type: 'image/svg+xml' }],
    });
    const h = {
      play: () => { if (audio.paused) toggle(); },
      pause: () => { if (!audio.paused) toggle(); },
      previoustrack: () => stepChapter(-1),
      nexttrack: () => stepChapter(1),
      seekbackward: () => stepVerse(-1),
      seekforward: () => stepVerse(1),
      seekto: e => { audio.currentTime = e.seekTime; },
    };
    for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch { /* 지원 안 함 */ } }
  }

  /* ---------------------------------------------------------------- 조작 막대(dock) */
  function renderDock() {
    const dock = $('#dock');
    const show = P.open || reading;
    dock.hidden = !show;
    document.body.classList.toggle('dock-on', show);
    if (!show) { $('#dockHint').hidden = true; return; }
    dock.classList.toggle('playing', P.open);
    const pl = P.loading ? '<span class="spin"></span>' : svg(playing() ? 'pause' : 'play');
    $('.dk-row', dock).innerHTML = [
      reading ? `<button data-a="exit" title="읽기 모드 끝내기 (Esc)">${svg('exitread')}</button>` : '',
      `<button data-a="prevch" title="이전 장">${svg('prevch')}</button>`,
      P.open ? `<button data-a="prevv" title="이전 절">${svg('prevv')}</button>` : '',
      `<button data-a="play" class="dk-play" title="${P.open ? '재생 / 일시정지' : '이 화면부터 소리로 듣기'}">${P.open ? pl : svg('headphone')}</button>`,
      P.open ? `<button data-a="nextv" title="다음 절">${svg('nextv')}</button>` : '',
      `<button data-a="nextch" title="다음 장">${svg('nextch')}</button>`,
      P.open ? `<button data-a="rate" class="dk-rate" title="속도 (누를 때마다 바뀜)">${S.tts.rate.toFixed(S.tts.rate % 0.1 ? 2 : 1)}×</button>` : '',
      `<button data-a="menu" title="음성 설정">${svg('gear')}</button>`,
      P.open ? `<button data-a="close" title="듣기 끝내기">${svg('close')}</button>` : '',
    ].join('');
    $('.dk-status', dock).hidden = $('.dk-prog', dock).hidden = !P.open;
    if (P.open) {
      $('.dk-title', dock).textContent = P.loading
        ? `음성 준비 중… ${bookName(P.b)} ${P.c}장 · ${P.version}`
        : `${bookName(P.b)} ${P.c}${P.curV ? ':' + P.curV : '장'} · ${P.version}${P.mode === 'speech' ? ' (기기 음성)' : ''}`
          + (P.sleepAt ? ` · ⏾ ${Math.max(1, Math.round((P.sleepAt - Date.now()) / 60000))}분` : P.sleepEoc ? ' · ⏾ 장 끝' : '');
      if (P.mode === 'speech') $('.dk-time', dock).textContent = P.speech ? `${P.speech.i + 1} / ${P.speech.items.length}` : '';
    }
  }

  // 읽기 모드에서만: 조작이 없으면 3초 뒤 사라지고, 화면 아래에 작은 손잡이만 남는다
  function setFaded(on) {
    $('#dock').classList.toggle('faded', on);
    $('#dockHint').hidden = !(on && !$('#dock').hidden);
  }
  function poke() {
    setFaded(false);
    clearTimeout(fadeTimer);
    if (!reading) return;
    fadeTimer = setTimeout(() => {
      if (!$('#ttsPanel').hidden || P.loading) return poke();
      setFaded(true);
    }, 3000);
  }

  function setupDock() {
    const dock = $('#dock');
    dock.addEventListener('click', e => {
      poke();
      const b = e.target.closest('button');
      if (b) {
        const a = b.dataset.a;
        if (a === 'play') toggle();
        else if (a === 'prevv') stepVerse(-1);
        else if (a === 'nextv') stepVerse(1);
        else if (a === 'prevch') stepChapter(-1);
        else if (a === 'nextch') stepChapter(1);
        else if (a === 'rate') { const i = RATES.indexOf(S.tts.rate); setRate(RATES[(i + 1) % RATES.length]); }
        else if (a === 'menu') togglePanel();
        else if (a === 'close') close();
        else if (a === 'exit') setReading(false);
        return;
      }
      if (e.target.closest('.dk-title') && P.open && !shownHere()) goto(P.b, P.c, P.curV || undefined);
    });
    // 진행 막대: 누른 위치로 이동
    $('.dk-prog', dock).addEventListener('click', e => {
      if (!P.data || P.mode !== 'server') return;
      const r = $('.dk-track', dock).getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * P.data.dur;
    });
    for (const ev of ['play', 'pause', 'playing', 'waiting']) audio.addEventListener(ev, renderDock);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', () => { if (P.open && P.mode === 'server' && audio.src) toast('음성을 불러오지 못했습니다'); });

    // 사용자가 직접 스크롤하면 자동 따라가기를 잠시 멈춘다
    for (const ev of ['wheel', 'touchmove', 'keydown']) document.addEventListener(ev, e => { if (e.target.closest?.('.pb') || ev === 'keydown') userScrollAt = Date.now(); }, { passive: true });
    // 읽기 모드: 본문을 톡 누르면 막대가 나타나고/사라짐, 마우스를 움직이면 나타남
    document.addEventListener('click', e => {
      if (!reading && !P.open) return;
      if (!e.target.closest('#panes')) return;
      if (e.target.closest('button, a, .vn, .cv, .nmark, mark, .sn, .sl, .num, .bref, select, input') || !getSelection().isCollapsed) return;
      if (!reading) return;
      if (dock.classList.contains('faded')) poke();
      else { clearTimeout(fadeTimer); setFaded(true); $('#ttsPanel').hidden = true; }
    });
    $('#dockHint').addEventListener('click', e => { e.stopPropagation(); poke(); });
    document.addEventListener('mousemove', () => { if (reading && !dock.hidden && !document.body.classList.contains('coarse')) poke(); }, { passive: true });
    document.addEventListener('keydown', e => {
      if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ' && (P.open || reading)) { e.preventDefault(); toggle(); poke(); }
    });
    $('#readBtn').onclick = () => setReading(!reading);
    // 창 머리의 ▶ 버튼
    document.addEventListener('click', e => {
      const b = e.target.closest('.pplay');
      if (!b) return;
      const p = R.panes.find(x => x.el.contains(b));
      if (P.open && P.version === p.cfg.version && shownHere()) toggle(); else startFromView(p);
    });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && reading && wentFullscreen) setReading(false); });
  }

  /* ---------------------------------------------------------------- 읽기 모드 */
  let wentFullscreen = false;
  async function setReading(on) {
    if (on === reading) return;
    const d = R.driver && R.driver.items.length ? R.driver : R.panes.find(p => p.items.length);
    const pos = d ? posOf(d) : null;
    reading = on;
    document.body.classList.toggle('reading', on);
    $('#readBtn').classList.toggle('on', on);
    hideFloating(); toggleViewPanel(false);
    if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); wentFullscreen = true; } catch { wentFullscreen = false; }
    } else if (!on && document.fullscreenElement) {
      wentFullscreen = false;
      try { await document.exitFullscreen(); } catch { /* 무시 */ }
    }
    if (pos != null) requestAnimationFrame(() => R.panes.forEach(p => scrollToPos(p, pos)));
    renderDock(); poke();
    if (on) toast('읽기 모드 — 본문을 누르면 조작 막대가 나타납니다');
  }

  /* ---------------------------------------------------------------- 음성 설정 패널 */
  function setRate(r) {
    S.tts.rate = Math.round(r * 100) / 100; save();
    audio.defaultPlaybackRate = audio.playbackRate = S.tts.rate;
    if (P.mode === 'speech' && P.speech) speakFrom(P.speech.i);
    renderDock();
    const sl = $('#tp-rate'); if (sl) { sl.value = S.tts.rate; sl.nextElementSibling.textContent = S.tts.rate.toFixed(2) + '×'; }
  }

  async function togglePanel(force) {
    const pn = $('#ttsPanel');
    const open = force ?? pn.hidden;
    pn.hidden = !open;
    if (open) renderPanel();
  }

  async function renderPanel() {
    const pn = $('#ttsPanel');
    const locale = P.data?.locale || P.speech?.locale || (VERS[(textPanes()[0] || {}).cfg?.version]?.lang === 'en' ? 'en-US' : 'ko-KR');
    const sleepMin = P.sleepAt ? Math.max(1, Math.round((P.sleepAt - Date.now()) / 60000)) : 0;
    pn.innerHTML = `
      <h4>목소리 <span class="small">${esc(locale)}</span></h4>
      <select id="tp-voice"><option>불러오는 중…</option></select>
      <h4>속도</h4>
      <div class="slider"><span></span><input type="range" id="tp-rate" min="0.6" max="2" step="0.05" value="${S.tts.rate}"><output>${S.tts.rate.toFixed(2)}×</output></div>
      <div class="chips">${RATES.map(r => `<button data-rate="${r}" class="${r === S.tts.rate ? 'on' : ''}">${r}×</button>`).join('')}</div>
      <h4>잠자기 타이머</h4>
      <div class="chips">${[['0', '끄기'], ['15', '15분'], ['30', '30분'], ['60', '1시간'], ['eoc', '이 장 끝까지']].map(([k, l]) =>
        `<button data-sleep="${k}" class="${(P.sleepKey || '0') === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${sleepMin ? `<div class="small">${sleepMin}분 뒤 서서히 멈춥니다</div>` : ''}
      <label class="ck"><input type="checkbox" id="tp-next" ${S.tts.autoNext ? 'checked' : ''}> 장이 끝나면 다음 장 이어 듣기</label>
      <label class="ck"><input type="checkbox" id="tp-head" ${S.tts.heading ? 'checked' : ''}> 장 제목 읽기 (예: "요한복음 3장")</label>
      <div class="small" style="margin-top:8px">절 번호를 누르면 그 절부터 읽습니다. 잠금화면·이어폰 버튼: 이전/다음 장, 길게 = 이전/다음 절.</div>`;
    $('#tp-rate', pn).oninput = e => setRate(+e.target.value);
    $$('[data-rate]', pn).forEach(b => (b.onclick = () => { setRate(+b.dataset.rate); renderPanel(); }));
    $$('[data-sleep]', pn).forEach(b => (b.onclick = () => {
      const k = b.dataset.sleep;
      P.sleepEoc = k === 'eoc';
      P.sleepAt = /^\d+$/.test(k) && k !== '0' ? Date.now() + +k * 60000 : 0;
      P.sleepKey = k;
      renderPanel(); renderDock();
      if (k !== '0') toast(k === 'eoc' ? '이 장이 끝나면 멈춥니다' : `${k}분 뒤 멈춥니다`);
    }));
    $('#tp-next', pn).onchange = e => { S.tts.autoNext = e.target.checked; save(); };
    $('#tp-head', pn).onchange = e => { S.tts.heading = e.target.checked; save(); };
    // 목소리 목록
    const d = await api(`/api/tts/voices?locale=${enc(locale)}`).catch(() => null);
    const sel = $('#tp-voice', pn);
    if (!sel) return;
    if (!d || !d.available || !d.voices.length) { sel.innerHTML = '<option>기기 음성 사용</option>'; sel.disabled = true; return; }
    const cur = S.tts.voices[locale] || d.default;
    const gender = g => (g === 'Female' ? '여성' : '남성');
    sel.innerHTML = d.voices.map(v => `<option value="${esc(v.id)}"${v.id === cur ? ' selected' : ''}>${esc(v.name)} · ${gender(v.gender)}</option>`).join('');
    sel.onchange = () => {
      S.tts.voices[locale] = sel.value; save();
      if (P.open && P.data) { const v = P.curV; start(P.version, P.b, P.c, v || null); }
    };
  }

  /* ---------------------------------------------------------------- app.js에서 부르는 훅 */
  function onPaneRendered(p) {
    const btn = $('.pplay', p.el);
    if (btn) {
      btn.hidden = !isText(p);
      btn.innerHTML = svg('headphone');
    }
    if (P.open && P.curV && shownHere()) {
      const el = $(`.verse[data-v="${P.curV}"]`, p.content) || p.items.filter(x => x.v <= P.curV).at(-1)?.el;
      el?.classList.add('speaking');
    }
  }
  function onChapterLoaded() { if (P.open && P.curV) onVerse(P.curV); renderDock(); }
  function onEscape() { if (!$('#ttsPanel').hidden) return togglePanel(false); if (reading) setReading(false); }

  setupDock();
  renderDock();
  return { isOpen: () => P.open, playFrom, onPaneRendered, onChapterLoaded, onEscape, setReading, toggle, state: P, audio };
})();

window.Player = Player;
