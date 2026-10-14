/* 말씀 리더 — 프런트엔드 (의존성 없음) */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

async function api(path, opts = {}) {
  if (window.STATIC_API) return window.STATIC_API(path, opts);   // GitHub Pages 판: 브라우저 안에서 처리 (site.js)
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, init);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('로그인이 필요합니다'); }
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 1800);
}

/* ------------------------------------------------------------------ 상태 */
const STORE = 'bibleReader.v1';
const S = {
  book: 43, chapter: 3, layout: 2, sync: true, strong: false, fs: 18, theme: 'light', font: 'Noto Serif KR', latin: '', lh: 1.85, maxw: 900, custom: {},
  drawer: false, tab: 'info',
  panes: [
    { version: '현대인', synced: true }, { version: 'NIV2011', synced: true },
    { version: '개역개정', synced: true }, { version: '만나주석', synced: true },
  ],
  cmp: ['개역개정', '새번역', '현대인', 'ESV', 'NIV2011', 'NKJV', 'BHSSBL'],
  noteScope: 'chapter',
};
try { Object.assign(S, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch { /* 저장 불가 환경 */ }
const save = () => {
  const { book, chapter, layout, sync, strong, fs, theme, font, latin, lh, maxw, custom, drawer, tab, panes, cmp, noteScope, tts } = S;
  try { localStorage.setItem(STORE, JSON.stringify({ book, chapter, layout, sync, strong, fs, theme, font, latin, lh, maxw, custom, drawer, tab, panes, cmp, noteScope, tts })); } catch { /* 무시 */ }
};

let META = null, VERS = {}, BOOKS = [];
const R = { panes: [], highlights: [], notes: [], active: null, driver: null, sel: null };

const bookName = b => BOOKS[b - 1]?.ko || `${b}권`;
const refText = (b, c, v, ev) => `${bookName(b)} ${c}:${v}${ev && ev !== v ? '-' + ev : ''}`;

/* ------------------------------------------------------------------ 시작 */
init();
async function init() {
  META = await api('/api/meta');
  BOOKS = META.books;
  META.versions.forEach(v => (VERS[v.id] = v));
  const firstOf = lang => META.versions.find(v => v.lang === lang)?.id;
  S.panes.forEach(p => { if (!VERS[p.version]) p.version = firstOf('ko'); });
  S.cmp = S.cmp.filter(v => VERS[v]);

  // 책·장 선택기
  $('#bookSel').innerHTML = BOOKS.map(b => `<option value="${b.n}">${esc(b.ko)}</option>`).join('');
  $('#bookSel').onchange = e => goto(+e.target.value, 1);
  $('#chapSel').onchange = e => goto(S.book, +e.target.value);
  $('#prevCh').onclick = () => stepChapter(-1);
  $('#nextCh').onclick = () => stepChapter(1);
  $('#refInput').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const r = parseRef(e.target.value);
    if (r) { goto(r.b, r.c, r.v); e.target.value = ''; e.target.blur(); } else toast('구절을 인식하지 못했습니다');
  });

  // 툴바
  $$('#layoutSeg button').forEach(b => (b.onclick = () => { S.layout = +b.dataset.n; buildPanes(); save(); }));
  $('#syncBtn').onclick = () => { S.sync = !S.sync; applyToggles(); save(); };
  $('#strongBtn').onclick = () => { S.strong = !S.strong; applyToggles(); save(); };
  $('#fontUp').onclick = () => setFont(S.fs + 1);
  $('#fontDown').onclick = () => setFont(S.fs - 1);
  $('#viewBtn').onclick = () => toggleViewPanel();
  $('#drawerBtn').onclick = () => setDrawer(!S.drawer);
  $('#drawerClose').onclick = () => setDrawer(false);
  $$('.tabs button[data-tab]').forEach(b => (b.onclick = () => setTab(b.dataset.tab)));

  // 검색
  $('#searchV').innerHTML = versionOptions(v => v.kind !== 'commentary');
  $('#searchForm').onsubmit = e => { e.preventDefault(); runSearch(); };

  document.body.classList.toggle('coarse', matchMedia('(pointer: coarse)').matches);
  setupSelection();
  setupGlobalClicks();
  setupKeys();
  applyToggles();
  applyView();
  setFont(S.fs);
  setDrawer(S.drawer, S.tab);
  buildPanes();
}

function applyToggles() {
  $('#syncBtn').classList.toggle('on', S.sync);
  $('#strongBtn').classList.toggle('on', S.strong);
  document.body.classList.toggle('strong', S.strong);
  $$('#layoutSeg button').forEach(b => b.classList.toggle('on', +b.dataset.n === S.layout));
}

function setFont(n) {
  S.fs = Math.max(13, Math.min(32, n));
  keepPosition(() => document.documentElement.style.setProperty('--fs', S.fs + 'px'));
  const sl = $('#vp-fs');
  if (sl) { sl.value = S.fs; sl.nextElementSibling.textContent = S.fs + 'px'; }
  save();
}

// 글자 크기·글꼴·폭이 바뀌어도 보던 절을 유지한다
function keepPosition(fn) {
  const d = R.driver && R.driver.items.length ? R.driver : R.panes.find(p => p.items.length);
  const pos = d ? posOf(d) : null;
  fn();
  if (pos != null) R.panes.forEach(p => scrollToPos(p, pos));
}

/* ------------------------------------------------------------------ 보기: 테마·글꼴·색 */
// [id, 이름, 바깥배경, 본문배경, 글자, 보조글자, 선, 강조, 강조배경, 선택절, 예수님말씀, 원어번호, 어두운테마]
const THEMES = Object.fromEntries([
  ['light', '기본', '#f4f2ee', '#fffdf9', '#23201b', '#77705f', '#e3ddd1', '#8a5a2b', '#f1e4d3', '#fff3c4', '#b3261e', '#2f6db5'],
  ['white', '순백', '#eef0f3', '#ffffff', '#1d1d1f', '#6e6e73', '#e2e4e8', '#2f5fb3', '#e3ecfa', '#fff6c8', '#c0392b', '#2f6db5'],
  ['cream', '크림 종이', '#ede6d6', '#fbf6ea', '#2e2a22', '#7a705c', '#e4dac4', '#9c4a1a', '#f1e2cc', '#f8e8a6', '#b3261e', '#2f6db5'],
  ['sepia', '세피아', '#e9dfc9', '#f6edd8', '#3b2f1e', '#7d6b4e', '#d8c9a8', '#8a5a2b', '#eadbb9', '#f3dfa0', '#a8321e', '#2f5f9a'],
  ['parchment', '양피지', '#d9c8a3', '#ecdcb8', '#3a2c18', '#6f5a3a', '#cdb68a', '#7a3e12', '#e2cc9d', '#f0d98c', '#9c2a14', '#2d5688'],
  ['olive', '올리브', '#dfe7d5', '#eef3e6', '#263022', '#5f6b57', '#cfdac2', '#4a7a3a', '#dbe8cf', '#f3efb8', '#a8321e', '#2f6db5'],
  ['sky', '하늘', '#dde8f2', '#eef5fb', '#1f2a36', '#5d6b7a', '#cbd9e7', '#2a6496', '#d9e8f6', '#fdf3c0', '#b3261e', '#2a6496'],
  ['rose', '로즈', '#f0e1e1', '#fbf1f0', '#3a2526', '#7d6061', '#e8d1d1', '#a8445a', '#f3dbe0', '#fbeec0', '#b3261e', '#2f6db5'],
  ['lavender', '라벤더', '#e6e2f0', '#f5f3fa', '#2a2638', '#6c6880', '#dcd7ea', '#6a4fa3', '#e6def5', '#fbf0c2', '#b3261e', '#4a5fc0'],
  ['dark', '어둡게', '#17181b', '#1f2125', '#e4e1da', '#9a958a', '#34363c', '#e0a96d', '#3a3127', '#3d3622', '#ff8a80', '#7fb2ff', 1],
  ['coffee', '커피', '#1e1814', '#2a221c', '#eadfce', '#a8977f', '#3d3229', '#e0a96d', '#3d2f22', '#4a3b22', '#ff9a8a', '#8fb8ff', 1],
  ['forest', '숲의 밤', '#121a16', '#18231d', '#dbe6dc', '#8fa394', '#2a3a30', '#9ed39a', '#24382b', '#3a4a2c', '#ff9a8a', '#8fc3ff', 1],
  ['midnight', '미드나잇', '#0f1626', '#16203a', '#dbe3f4', '#8d9ab5', '#26324f', '#8fb4ff', '#24345a', '#33406a', '#ff9a8f', '#9cc3ff', 1],
  ['slate', '슬레이트', '#1b1f24', '#22272e', '#cdd9e5', '#8b98a5', '#373e47', '#6cb6ff', '#2d3a4a', '#3a3a24', '#ff938a', '#6cb6ff', 1],
  ['black', '블랙', '#000000', '#000000', '#d8d8d8', '#8a8a8a', '#262626', '#ffb454', '#2a2010', '#2d2a14', '#ff8a80', '#7fb2ff', 1],
  ['contrast', '고대비', '#000000', '#000000', '#ffffff', '#d0d0d0', '#666666', '#ffd400', '#3a3200', '#3d3500', '#ff6b6b', '#66ccff', 1],
].map(([id, name, bg, paper, ink, muted, line, accent, soft, active, wj, sn, dark]) =>
  [id, { name, bg, paper, ink, muted, line, accent, soft, active, wj, sn, dark: !!dark }]));

const HL_LIGHT = { 'hl-yellow': '#ffe98a', 'hl-green': '#c5ecb0', 'hl-blue': '#c4defa', 'hl-pink': '#f9c8dc', ul: '#d23c3c' };
const HL_DARK = { 'hl-yellow': '#6b5a12', 'hl-green': '#2f5627', 'hl-blue': '#23466d', 'hl-pink': '#6a2944', ul: '#ff6b6b' };

// [CSS 이름, 표시 이름, Google Fonts 굵기('' = 기본 굵기만, null = 시스템 글꼴), 분류]
const FONTS = [
  ['Noto Serif KR', '본명조', 'wght@400;600', '명조'],
  ['Nanum Myeongjo', '나눔명조', 'wght@400;700', '명조'],
  ['Gowun Batang', '고운바탕', 'wght@400;700', '명조'],
  ['Hahmlet', '함렛', 'wght@400;600', '명조'],
  ['Song Myung', '송명', '', '명조'],
  ['Batang', '바탕 (Windows)', null, '명조'],
  ['Noto Sans KR', '본고딕', 'wght@400;500;700', '고딕'],
  ['Nanum Gothic', '나눔고딕', 'wght@400;700', '고딕'],
  ['Gowun Dodum', '고운돋움', '', '고딕'],
  ['IBM Plex Sans KR', 'IBM Plex Sans KR', 'wght@400;600', '고딕'],
  ['Malgun Gothic', '맑은 고딕 (Windows)', null, '고딕'],
  ['Nanum Pen Script', '나눔손글씨 펜', '', '손글씨'],
];
const LATIN_FONTS = [
  ['', '한글 글꼴 따름', null],
  ['EB Garamond', 'EB Garamond', 'wght@400;600'],
  ['Crimson Pro', 'Crimson Pro', 'wght@400;600'],
  ['Lora', 'Lora', 'wght@400;600'],
  ['Merriweather', 'Merriweather', 'wght@400;700'],
  ['Source Serif 4', 'Source Serif 4', 'wght@400;600'],
  ['Georgia', 'Georgia (Windows)', null],
  ['Inter', 'Inter', 'wght@400;600'],
];

const loadedFonts = new Set();
function loadFont(name) {
  const f = [...FONTS, ...LATIN_FONTS].find(x => x[0] === name);
  if (!f || f[2] === null || loadedFonts.has(name)) return;
  loadedFonts.add(name);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, '+')}${f[2] ? ':' + f[2] : ''}&display=swap`;
  document.head.appendChild(link);
}

function applyView() {
  const t = THEMES[S.theme] || THEMES.light;
  const c = S.custom || {};
  const root = document.documentElement.style;
  const paper = c.paper || t.paper;
  const vars = {
    bg: t.bg, paper, ink: c.ink || t.ink, muted: t.muted, line: t.line,
    accent: c.accent || t.accent, 'accent-soft': c.accent ? `color-mix(in srgb, ${c.accent} 18%, ${paper})` : t.soft,
    active: t.active, wj: t.wj, sn: t.sn,
    shadow: t.dark ? '0 6px 24px rgba(0,0,0,.55)' : '0 6px 24px rgba(40,30,10,.16)',
    ...(t.dark ? HL_DARK : HL_LIGHT),
  };
  if (c.paper) vars.bg = `color-mix(in srgb, ${c.paper} 88%, ${t.dark ? '#000' : '#776'})`;
  if (c.ink) vars.muted = `color-mix(in srgb, ${c.ink} 60%, ${paper})`;
  for (const [k, v] of Object.entries(vars)) root.setProperty('--' + k, v);
  root.colorScheme = t.dark ? 'dark' : 'light';
  loadFont(S.font);
  if (S.latin) loadFont(S.latin);
  const generic = FONTS.find(f => f[0] === S.font)?.[3] === '고딕' ? 'sans-serif' : 'serif';
  keepPosition(() => {
    root.setProperty('--serif', [S.latin && `"${S.latin}"`, `"${S.font}"`, '"Noto Serif KR"', '"Batang"', generic].filter(Boolean).join(', '));
    root.setProperty('--lh', S.lh);
    root.setProperty('--maxw', S.maxw >= 1400 ? 'none' : S.maxw + 'px');
  });
}

function toggleViewPanel(force) {
  const vp = $('#viewPanel');
  const open = force ?? vp.hidden;
  if (open === !vp.hidden) return;
  vp.hidden = !open;
  $('#viewBtn').classList.toggle('on', open);
  if (open) renderViewPanel();
}

function renderViewPanel() {
  const vp = $('#viewPanel');
  [...FONTS, ...LATIN_FONTS].forEach(f => loadFont(f[0])); // 미리보기용 — 화면에 쓰인 글자 조각만 내려받는다
  const c = S.custom || {}, t = THEMES[S.theme] || THEMES.light;
  const slider = (id, label, min, max, step, val, fmt) =>
    `<div class="slider"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${fmt(val)}</output></div>`;
  vp.innerHTML = `
    <h4>테마</h4>
    <div class="thgrid">${Object.entries(THEMES).map(([id, x]) => `
      <button class="th${id === S.theme ? ' on' : ''}" data-th="${id}" title="${esc(x.name)}">
        <span class="sw2" style="background:${x.paper};color:${x.ink}">가<span class="dot" style="background:${x.accent}"></span></span>
        <span class="nm">${esc(x.name)}</span></button>`).join('')}</div>
    <h4>본문 글꼴</h4>
    <div class="fgrid">${FONTS.map(([f, nm, , kind]) => `
      <button class="fbtn${f === S.font ? ' on' : ''}" data-font="${esc(f)}">
        <span class="s" style="font-family:'${f}'">태초에 하나님이</span><span class="nm">${esc(nm)} · ${kind}</span></button>`).join('')}</div>
    <h4>영문 글꼴 <span class="small" style="margin-left:6px;font-weight:400">영어 번역본·로마자</span></h4>
    <div class="fgrid">${LATIN_FONTS.map(([f, nm]) => `
      <button class="fbtn${f === S.latin ? ' on' : ''}" data-latin="${esc(f)}">
        <span class="s" style="font-family:${f ? `'${f}'` : 'var(--serif)'}">In the beginning</span><span class="nm">${esc(nm)}</span></button>`).join('')}</div>
    <h4>크기·간격</h4>
    ${slider('vp-fs', '글자 크기', 13, 32, 1, S.fs, v => v + 'px')}
    ${slider('vp-lh', '줄 간격', 1.3, 2.6, 0.05, S.lh, v => (+v).toFixed(2))}
    ${slider('vp-maxw', '본문 폭', 520, 1400, 20, S.maxw, v => (v >= 1400 ? '전체' : v + 'px'))}
    <h4>내 색상 <button class="link act" id="vp-reset">테마 기본값으로</button></h4>
    <div class="colors">
      <label class="${c.paper ? 'set' : ''}">배경<input type="color" data-k="paper" value="${c.paper || t.paper}"></label>
      <label class="${c.ink ? 'set' : ''}">글자<input type="color" data-k="ink" value="${c.ink || t.ink}"></label>
      <label class="${c.accent ? 'set' : ''}">강조(절 번호)<input type="color" data-k="accent" value="${c.accent || t.accent}"></label>
    </div>
    <div class="preview"><span style="color:var(--accent);font-size:.62em;font-weight:700;font-family:var(--sans)">16 </span>하나님이 세상을 무척 사랑하셔서 하나밖에 없는 외아들마저 보내 주셨으니 <span class="wj">For God so loved the world</span></div>
    <h4>데이터</h4>
    <div class="small" id="vp-bk">${META.static ? '밑줄·노트는 이 기기에 저장됩니다. 백업 파일로 내려받아 두세요.'
      : META.backup?.last ? `마지막 백업: ${esc(META.backup.last.replace('T', ' '))}` + (META.backup.error ? ` <span style="color:#c0392b">(일부 실패)</span>` : '') : '아직 백업 기록이 없습니다.'}</div>
    <div class="btnrow" style="justify-content:flex-start">
      <button class="btn" id="vp-backup">${META.static ? '노트 백업 파일 받기' : '지금 백업'}</button>
      ${META.remote || META.static ? `<button class="btn danger" id="vp-logout">${META.static ? '이 기기에서 잠그기' : '로그아웃'}</button>` : ''}
    </div>`;

  $$('.th', vp).forEach(b => (b.onclick = () => { S.theme = b.dataset.th; S.custom = {}; applyView(); save(); renderViewPanel(); }));
  const pick = (attr, key) => $$(`[data-${attr}]`, vp).forEach(b => (b.onclick = () => {
    S[key] = b.dataset[attr];
    applyView(); save();
    $$(`[data-${attr}]`, vp).forEach(x => x.classList.toggle('on', x === b));
  }));
  pick('font', 'font');
  pick('latin', 'latin');
  $('#vp-fs').oninput = e => setFont(+e.target.value);
  $('#vp-lh').oninput = e => { S.lh = +e.target.value; e.target.nextElementSibling.textContent = S.lh.toFixed(2); applyView(); save(); };
  $('#vp-maxw').oninput = e => { S.maxw = +e.target.value; e.target.nextElementSibling.textContent = S.maxw >= 1400 ? '전체' : S.maxw + 'px'; applyView(); save(); };
  $$('input[type=color]', vp).forEach(inp => (inp.oninput = () => {
    S.custom = { ...S.custom, [inp.dataset.k]: inp.value };
    inp.parentElement.classList.add('set');
    applyView(); save();
  }));
  $('#vp-reset').onclick = () => { S.custom = {}; applyView(); save(); renderViewPanel(); };
  $('#vp-backup').onclick = async () => {
    const st = await api('/api/backup', { method: 'POST', body: {} });
    if (META.static) return;
    META.backup = st;
    toast(st.error ? '백업 일부 실패 — 공유기 HDD 연결을 확인하세요' : '백업했습니다');
    renderViewPanel();
  };
  const lo = $('#vp-logout');
  if (lo) lo.onclick = async () => {
    await api('/api/logout', { method: 'POST', body: {} });
    if (META.static) location.reload(); else location.href = '/login.html';
  };
}

function setDrawer(open, tab) {
  S.drawer = open;
  $('#drawer').hidden = !open;
  $('#drawerBtn').classList.toggle('on', open);
  if (open) setTab(tab || S.tab);
  save();
}

function setTab(tab) {
  S.tab = tab;
  $$('.tabs button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.tabbody').forEach(s => s.classList.toggle('on', s.dataset.tab === tab));
  if (tab === 'notes') renderNotesTab();
  if (tab === 'maps') renderMapsTab();
  if (tab === 'search' && !$('#searchV').dataset.touched) $('#searchV').value = firstBibleVersion();
  save();
}

function versionOptions(filter = () => true, selected) {
  return META.groups.map(([lang, label]) => {
    const vs = META.versions.filter(v => v.lang === lang && filter(v));
    if (!vs.length) return '';
    return `<optgroup label="${esc(label)}">` + vs.map(v =>
      `<option value="${esc(v.id)}" title="${esc(v.desc)}"${v.id === selected ? ' selected' : ''}>${esc(v.name)}</option>`).join('') + '</optgroup>';
  }).join('');
}

const firstBibleVersion = () =>
  R.panes.map(p => p.cfg.version).find(v => ['bible', 'strong'].includes(VERS[v]?.kind)) || '개역개정';

/* ------------------------------------------------------------------ 분할 창 */
function buildPanes() {
  const host = $('#panes');
  host.className = 'n' + S.layout;
  host.innerHTML = '';
  R.panes = [];
  for (let i = 0; i < S.layout; i++) {
    const cfg = S.panes[i];
    const el = $('#paneTpl').content.firstElementChild.cloneNode(true);
    const p = { i, cfg, el, body: $('.pb', el), content: $('.pc', el), items: [], token: 0, data: null };
    const sel = $('.vsel', el);
    sel.innerHTML = versionOptions(() => true, cfg.version);
    sel.onchange = () => { cfg.version = sel.value; save(); loadPane(p).then(() => { const d = otherDriver(p); if (d) scrollToPos(p, posOf(d)); }); };
    const lock = $('.lock', el);
    lock.classList.toggle('on', cfg.synced);
    lock.onclick = () => { cfg.synced = !cfg.synced; lock.classList.toggle('on', cfg.synced); save(); };
    const drive = () => { if (R.driver !== p) { R.driver?.el.classList.remove('drive'); R.driver = p; el.classList.add('drive'); } };
    for (const ev of ['pointerenter', 'pointermove', 'pointerdown', 'wheel', 'focusin']) el.addEventListener(ev, drive, { passive: true });
    el.addEventListener('touchstart', drive, { passive: true });
    p.body.addEventListener('scroll', () => onPaneScroll(p), { passive: true });
    host.appendChild(el);
    R.panes.push(p);
  }
  R.driver = R.panes[0];
  loadChapter();
}

const otherDriver = p => R.panes.find(q => q !== p && q.items.length);

async function loadChapter(verse) {
  $('#bookSel').value = S.book;
  const n = BOOKS[S.book - 1].chapters;
  $('#chapSel').innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${i + 1}장</option>`).join('');
  $('#chapSel').value = S.chapter;
  document.title = `${refText(S.book, S.chapter, '').replace(/:$/, '')}장 — 말씀 리더`;
  R.active = null;
  R.highlights = null;
  const [hl, notes] = await Promise.all([
    api(`/api/highlights?b=${S.book}&c=${S.chapter}`),
    api(`/api/notes?b=${S.book}&c=${S.chapter}`),
    ...R.panes.map(p => loadPane(p)),
  ]);
  R.highlights = hl; R.notes = notes;
  R.panes.forEach(p => { paintAll(p); noteMarks(p); });
  if (verse) { selectVerse(verse, { scroll: true, flash: true }); }
  else R.panes.forEach(p => (p.body.scrollTop = 0));
  if (S.drawer && S.tab === 'notes') renderNotesTab();
  save();
  window.Player?.onChapterLoaded();
}

async function loadPane(p) {
  const token = ++p.token;
  p.content.innerHTML = '<div class="loading">불러오는 중…</div>';
  $('.ptitle', p.el).textContent = '';
  let d;
  try { d = await api(`/api/chapter?v=${enc(p.cfg.version)}&b=${S.book}&c=${S.chapter}`); }
  catch (e) { p.content.innerHTML = `<p class="empty">불러오기 실패: ${esc(e.message)}</p>`; return; }
  if (token !== p.token) return;
  p.data = d;
  renderPane(p);
  if (R.highlights) { paintAll(p); noteMarks(p); }
}

function renderPane(p) {
  const d = p.data, kind = d.kind;
  $('.ptitle', p.el).textContent = `${bookName(d.book)} ${d.chapter}장` + (VERS[d.version]?.desc ? ` · ${VERS[d.version].desc}` : '');
  let h = `<div class="chead">${esc(bookName(d.book))} ${d.chapter}장</div>`;
  if (!d.verses.length) h += '<p class="empty">이 장에 해당하는 자료가 없습니다.</p>';
  for (const x of d.verses) {
    if (kind === 'commentary') {
      h += `<div class="centry" data-v="${x.v}"><div class="cv" data-v="${x.v}">${d.chapter}:${x.v}</div><div class="ct">${x.html}</div></div>`;
    } else if (kind === 'parse') {
      h += `<div class="verse" data-v="${x.v}"><span class="vn">${x.v}</span><div class="vt nooff-all">` + parseTable(x.rows) + '</div></div>';
    } else {
      const cls = /[֐-׿]/.test(x.html) ? ' heb' : /[Ͱ-Ͽἀ-῿]/.test(x.html) ? ' grk' : '';
      h += `<div class="verse" data-v="${x.v}"><span class="vn">${x.v}</span><span class="vt${cls}">${x.html}</span></div>`;
    }
  }
  p.content.innerHTML = h;
  p.items = $$('[data-v].verse, [data-v].centry', p.content).map(el => ({ v: +el.dataset.v, el }));
  if (R.active) markActive(p);
  window.Player?.onPaneRendered(p);
}

function parseTable(rows) {
  return '<table class="ptab">' + rows.map(r => r.raw
    ? `<tr><td colspan="4">${esc(r.raw)}</td></tr>`
    : `<tr><td class="w">${esc(r.w)}</td><td><span class="sl" data-s="${r.s}">${r.s}</span> ${esc(r.lemma)} <span class="m">${esc(r.read)}</span></td><td class="m">${esc(r.morph)}</td><td class="g">${esc(r.gloss)}</td></tr>`
  ).join('') + '</table>';
}

/* 밑줄·노트 표시를 본문에 입힌다 */
const textPane = p => p.data && ['bible', 'strong'].includes(p.data.kind);
function paintAll(p) {
  if (!textPane(p)) return;
  for (const h of R.highlights.filter(h => h.version === p.cfg.version)) paintHighlight(p, h);
}
function noteMarks(p) {
  if (!textPane(p)) return;
  $$('.nmark', p.content).forEach(e => e.remove());
  const byVerse = {};
  R.notes.forEach(n => (byVerse[n.verse] = (byVerse[n.verse] || 0) + 1));
  for (const [v, cnt] of Object.entries(byVerse)) {
    const vt = $(`.verse[data-v="${v}"] .vt`, p.content);
    if (vt) vt.insertAdjacentHTML('beforeend', `<span class="nmark nooff" data-v="${v}" title="노트 ${cnt}개">✎${cnt > 1 ? cnt : ''}</span>`);
  }
}

/* ------------------------------------------------------------------ 동기 스크롤 */
// 위치를 "절 번호 + 소수"로 표현한다 → 번역본·주석 간에 길이가 달라도 같은 절을 맞춘다.
function posOf(p) {
  const it = p.items;
  if (!it.length) return null;
  const y = p.body.scrollTop + 8;
  let i = -1;
  for (let k = 0; k < it.length; k++) { if (it[k].el.offsetTop <= y) i = k; else break; }
  if (i < 0) return it[0].v;
  const a = it[i], span = (it[i + 1]?.v ?? a.v + 1) - a.v;
  const frac = Math.max(0, Math.min(1, (y - a.el.offsetTop) / (a.el.offsetHeight || 1)));
  return a.v + frac * Math.max(1, span);
}

function scrollToPos(p, pos) {
  const it = p.items;
  if (!it.length || pos == null) return;
  let i = -1;
  for (let k = 0; k < it.length; k++) { if (it[k].v <= pos) i = k; else break; }
  let target = 0;
  if (i >= 0) {
    const a = it[i], span = Math.max(1, (it[i + 1]?.v ?? a.v + 1) - a.v);
    const frac = Math.max(0, Math.min(1, (pos - a.v) / span));
    target = a.el.offsetTop + frac * a.el.offsetHeight - 8;
  }
  p.body.scrollTop = Math.max(0, target);
}

function onPaneScroll(p) {
  hideFloating();
  if (!S.sync || !p.cfg.synced || R.driver !== p) return;
  // scroll 이벤트는 브라우저가 이미 프레임 단위로 묶어 보내므로 바로 맞춘다
  const pos = posOf(p);
  R.panes.forEach(q => { if (q !== p && q.cfg.synced) scrollToPos(q, pos); });
}

/* ------------------------------------------------------------------ 이동 */
function goto(b, c, v) {
  b = Math.max(1, Math.min(66, b));
  c = Math.max(1, Math.min(BOOKS[b - 1].chapters, c || 1));
  if (b === S.book && c === S.chapter && R.panes[0]?.data) { if (v) selectVerse(v, { scroll: true, flash: true }); return; }
  S.book = b; S.chapter = c;
  loadChapter(v);
}

function stepChapter(d) {
  let b = S.book, c = S.chapter + d;
  if (c < 1) { if (b === 1) return; b--; c = BOOKS[b - 1].chapters; }
  if (c > BOOKS[b - 1].chapters) { if (b === 66) return; b++; c = 1; }
  goto(b, c);
}

function findBook(name) {
  const n = name.toLowerCase().replace(/[\s.]/g, '');
  if (!n) return null;
  const norm = s => s.toLowerCase().replace(/\s/g, '');
  let hit = BOOKS.find(b => b.ka === n || b.ko === n || norm(b.en) === n || norm(b.ea) === n);
  if (hit) return hit.n;
  hit = BOOKS.find(b => b.ko.startsWith(n)) || BOOKS.find(b => norm(b.en).startsWith(n));
  return hit ? hit.n : null;
}

function parseRef(s) {
  const m = s.trim().match(/^(\d?\s*[^\d:]+?)\s*(\d+)?(?:\s*(?:[:.]|장)\s*(\d+))?\s*(?:절)?(?:\s*[-~]\s*\d+\s*절?)?$/);
  if (!m) return null;
  const b = findBook(m[1].replace(/장$/, ''));
  if (!b) return null;
  return { b, c: +(m[2] || 1), v: m[3] ? +m[3] : null };
}

/* ------------------------------------------------------------------ 절 선택 */
function selectVerse(v, { scroll = false, flash = false, openInfo = false } = {}) {
  R.active = { b: S.book, c: S.chapter, v };
  R.panes.forEach(p => {
    markActive(p);
    if (scroll) scrollToPos(p, v);
    if (flash) $(`.verse[data-v="${v}"]`, p.content)?.classList.add('flash');
  });
  if (openInfo) setDrawer(true, 'info');
  if (S.drawer && S.tab === 'info') renderInfo();
}

function markActive(p) {
  $$('.active', p.content).forEach(e => e.classList.remove('active'));
  if (!R.active) return;
  const v = R.active.v;
  const el = $(`.verse[data-v="${v}"]`, p.content);
  if (el) return el.classList.add('active');
  const entries = p.items.filter(x => x.v <= v);
  entries.at(-1)?.el.classList.add('active');
}

/* ------------------------------------------------------------------ 절 정보 패널 */
async function renderInfo() {
  const box = $('section[data-tab="info"]');
  if (!R.active) return;
  const { b, c, v } = R.active;
  const token = (renderInfo.t = (renderInfo.t || 0) + 1);
  box.innerHTML = `
    <div class="ref-title">${esc(refText(b, c, v))}</div>
    <h3>번역 대조 <button class="link act" id="cmpCfgBtn">번역 선택</button></h3>
    <div class="cmpcfg" id="cmpCfg" hidden></div>
    <div id="cmpOut" class="loading">…</div>
    <h3>노트 <button class="link act" id="addNoteBtn">+ 노트 쓰기</button></h3>
    <div id="infoNotes"></div>
    <h3>주석 · 관주</h3><div id="commOut" class="loading">…</div>
    ${META.wiki ? `<h3>내 위키 문서 <span class="small">(${esc(bookName(b))} ${c}장 언급)</span></h3><div id="wikiOut" class="loading">…</div>` : ''}`;

  $('#cmpCfgBtn').onclick = () => {
    const cfg = $('#cmpCfg');
    cfg.hidden = !cfg.hidden;
    if (!cfg.hidden) {
      cfg.innerHTML = META.versions.filter(x => ['bible', 'strong'].includes(x.kind)).map(x =>
        `<label title="${esc(x.desc)}"><input type="checkbox" value="${esc(x.id)}"${S.cmp.includes(x.id) ? ' checked' : ''}> ${esc(x.name)}</label>`).join('');
      cfg.onchange = () => { S.cmp = $$('input:checked', cfg).map(i => i.value); save(); loadCmp(); };
    }
  };
  $('#addNoteBtn').onclick = () => openNoteEditor({ book: b, chapter: c, verse: v, everse: v, version: '', quote: '' }, $('#infoNotes'));
  renderVerseNotes();

  const loadCmp = async () => {
    const out = await api(`/api/verse?b=${b}&c=${c}&v=${v}&vs=${enc(S.cmp.join(','))}`);
    if (token !== renderInfo.t) return;
    $('#cmpOut').className = '';
    $('#cmpOut').innerHTML = out.map(x => `<div class="cmp"><b class="vl">${esc(x.version)}</b>${x.html || '<span class="small">(없음)</span>'}</div>`).join('') || '<p class="empty">대조할 번역을 선택하세요.</p>';
  };
  loadCmp();

  api(`/api/comm?b=${b}&c=${c}&v=${v}`).then(list => {
    if (token !== renderInfo.t) return;
    const o = $('#commOut'); o.className = '';
    o.innerHTML = list.map(x => `
      <div class="card collapsed">
        <div class="ctitle"><span>${esc(x.version)}</span><span class="chip">${c}:${x.verse}${x.exact ? '' : ' 단락'}</span>
          <span class="small" style="margin-left:auto">펼치기</span></div>
        <div class="cbody">${x.html}</div>
      </div>`).join('') || '<p class="empty">이 절의 주석이 없습니다.</p>';
    $$('.card .ctitle', o).forEach(t => (t.onclick = () => {
      const card = t.parentElement; card.classList.toggle('collapsed');
      $('.small', t).textContent = card.classList.contains('collapsed') ? '펼치기' : '접기';
    }));
  });

  if (META.wiki) api(`/api/wiki?b=${b}&c=${c}`).then(list => {
    if (token !== renderInfo.t) return;
    const o = $('#wikiOut'); o.className = '';
    o.innerHTML = list.map(x => `
      <div class="card"><div class="ctitle" data-path="${esc(x.path)}">📄 ${esc(x.title)}</div>
        <div class="small">${esc(x.path)}</div>
        ${x.snippets.map(s => `<div class="small" style="margin-top:4px">… ${esc(s)}</div>`).join('')}</div>`).join('')
      || '<p class="empty">이 장을 다룬 위키 문서가 없습니다.</p>';
    $$('.ctitle[data-path]', o).forEach(t => (t.onclick = () => openWiki({ path: t.dataset.path })));
  });
}

function renderVerseNotes() {
  const box = $('#infoNotes');
  if (!box || !R.active) return;
  const list = R.notes.filter(n => n.verse <= R.active.v && (n.everse || n.verse) >= R.active.v);
  box.innerHTML = '';
  if (!list.length) box.innerHTML = '<p class="empty" style="padding:0">아직 노트가 없습니다.</p>';
  list.forEach(n => box.appendChild(noteCard(n)));
}

/* ------------------------------------------------------------------ 노트 */
function noteCard(n) {
  const el = document.createElement('div');
  el.className = 'card note';
  el.innerHTML = `
    <div class="ctitle goto">${esc(refText(n.book, n.chapter, n.verse, n.everse))}${n.version ? ` <span class="chip">${esc(n.version)}</span>` : ''}</div>
    ${n.quote ? `<div class="q">${esc(n.quote)}</div>` : ''}
    <div class="body">${esc(n.body)}</div>
    <div class="meta"><span>${esc((n.updated || '').replace('T', ' '))}</span><span class="sp"></span>
      <button class="link edit">편집</button><button class="link del">삭제</button></div>`;
  $('.goto', el).onclick = () => goto(n.book, n.chapter, n.verse);
  $('.edit', el).onclick = () => openNoteEditor(n, el, true);
  $('.del', el).onclick = async () => {
    if (!confirm('이 노트를 삭제할까요?')) return;
    await api(`/api/notes/${n.id}`, { method: 'DELETE' });
    R.notes = R.notes.filter(x => x.id !== n.id);
    refreshNotes();
  };
  return el;
}

function openNoteEditor(n, anchor, replace = false) {
  const ed = document.createElement('div');
  ed.className = 'card';
  ed.innerHTML = `
    <div class="ctitle">${esc(refText(n.book, n.chapter, n.verse, n.everse))}</div>
    ${n.quote ? `<div class="note"><div class="q">${esc(n.quote)}</div></div>` : ''}
    <textarea class="ed" placeholder="묵상, 질문, 설교 아이디어…  (Ctrl+Enter 저장)">${esc(n.body || '')}</textarea>
    <div class="btnrow"><button class="btn cancel">취소</button><button class="btn pri ok">저장</button></div>`;
  if (replace) anchor.replaceWith(ed); else anchor.prepend(ed);
  const ta = $('textarea', ed);
  ta.focus();
  const done = () => (replace ? refreshNotes() : ed.remove());
  $('.cancel', ed).onclick = done;
  const submit = async () => {
    const body = ta.value.trim();
    if (!body) return toast('내용을 입력하세요');
    if (n.id) {
      const u = await api(`/api/notes/${n.id}`, { method: 'PUT', body: { body } });
      R.notes = R.notes.map(x => (x.id === u.id ? u : x));
    } else {
      const c = await api('/api/notes', { method: 'POST', body: { ...n, body } });
      if (c.book === S.book && c.chapter === S.chapter) R.notes.push(c);
    }
    toast('노트를 저장했습니다');
    if (!replace) ed.remove();
    refreshNotes();
  };
  $('.ok', ed).onclick = submit;
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) submit(); if (e.key === 'Escape') done(); });
}

function refreshNotes() {
  R.panes.forEach(noteMarks);
  renderVerseNotes();
  if (S.tab === 'notes') renderNotesTab();
}

async function renderNotesTab() {
  const box = $('section[data-tab="notes"]');
  const q = $('#noteQ')?.value || '';
  box.innerHTML = `
    <div class="seg" style="margin-bottom:8px">
      <button data-s="chapter" class="${S.noteScope === 'chapter' ? 'on' : ''}">이 장</button>
      <button data-s="all" class="${S.noteScope === 'all' ? 'on' : ''}">전체</button>
    </div>
    <input id="noteQ" class="f" placeholder="노트 검색" value="${esc(q)}" ${S.noteScope === 'chapter' ? 'hidden' : ''}>
    <div class="btnrow" style="justify-content:flex-start;margin:8px 0">
      <a class="btn" href="/api/notes/export" download>⬇ 전체 노트 Markdown 내보내기</a></div>
    ${META.static ? `<div class="btnrow" style="justify-content:flex-start;margin:-2px 0 8px">
      <button class="btn" id="nbOut">노트 백업(JSON) 받기</button>
      <label class="btn">백업 가져오기<input type="file" id="nbIn" accept=".json,application/json" hidden></label></div>` : ''}
    <div id="noteList"></div>`;
  if (META.static) {
    $('#nbOut').onclick = () => SITE.exportJSON();
    $('#nbIn').onchange = async e => {
      try {
        const n = await SITE.importJSON(e.target.files[0]);
        toast(`${n}개를 가져왔습니다`);
        loadChapter();
      } catch (err) { toast(err.message); }
    };
  }
  $$('.seg button', box).forEach(b => (b.onclick = () => { S.noteScope = b.dataset.s; save(); renderNotesTab(); }));
  const list = S.noteScope === 'chapter' ? R.notes : await api(`/api/notes?q=${enc(q)}`);
  const nl = $('#noteList');
  if (!list.length) nl.innerHTML = '<p class="empty">노트가 없습니다. 본문을 드래그해 ✎ 노트를 누르거나, 절 번호를 눌러 노트를 쓰세요.</p>';
  list.forEach(n => nl.appendChild(noteCard(n)));
  const qi = $('#noteQ');
  qi.oninput = () => { clearTimeout(qi.t); qi.t = setTimeout(async () => { renderNotesTab().then(() => { const x = $('#noteQ'); x.focus(); x.setSelectionRange(x.value.length, x.value.length); }); }, 300); };
}

/* ------------------------------------------------------------------ 밑줄·형광펜 */
const SKIP = '.sn,.fn,.nmark,.nooff';

function textNodes(root) {
  const out = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (!n.parentElement.closest(SKIP)) out.push(n);
  return out;
}

function measure(vt, node, off) {
  const r = document.createRange();
  r.setStart(vt, 0);
  try { r.setEnd(node, off); } catch { return 0; }
  const frag = r.cloneContents();
  frag.querySelectorAll(SKIP).forEach(e => e.remove());
  return frag.textContent.length;
}
const fullLen = vt => textNodes(vt).reduce((s, n) => s + n.data.length, 0);

function wrapRange(vt, start, end, h) {
  let pos = 0;
  for (const n of textNodes(vt)) {
    const len = n.data.length, s = Math.max(start, pos), e = Math.min(end, pos + len);
    if (s < e) {
      let t = n;
      if (e - pos < len) t.splitText(e - pos);
      if (s - pos > 0) t = t.splitText(s - pos);
      const m = document.createElement('mark');
      m.className = `h ${h.style === 'ul' ? 'ul ' : ''}${h.color}`;
      m.dataset.hid = h.id;
      t.parentNode.insertBefore(m, t);
      m.appendChild(t);
    }
    pos += len;
  }
}

function paintHighlight(p, h) {
  for (let v = h.sv; v <= h.ev; v++) {
    const vt = $(`.verse[data-v="${v}"] .vt`, p.content);
    if (vt) wrapRange(vt, v === h.sv ? h.so : 0, v === h.ev ? h.eo : Infinity, h);
  }
}

function unpaint(id) {
  $$(`mark.h[data-hid="${id}"]`).forEach(m => { m.replaceWith(...m.childNodes); });
  $$('.vt').forEach(vt => vt.normalize());
}

function setupSelection() {
  document.addEventListener('mouseup', e => {
    if (e.target.closest('#selbar, #pop, #drawer, #top, #modal')) return;
    setTimeout(captureSelection, 0);
  });
  // 휴대폰·태블릿은 mouseup이 없으므로 선택이 멈추면 감지한다
  document.addEventListener('selectionchange', () => {
    if (!document.body.classList.contains('coarse')) return;
    clearTimeout(captureSelection.t);
    captureSelection.t = setTimeout(captureSelection, 350);
  });
  $('#selbar').addEventListener('mousedown', e => e.preventDefault()); // 선택 유지
  $('#selbar').addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn || !R.sel) return;
    const sel = R.sel;
    if (btn.dataset.c) await addHighlight(sel, btn.dataset.c, 'hl');
    else if (btn.dataset.ul) await addHighlight(sel, 'pink', 'ul');
    else if (btn.dataset.act === 'note') {
      setDrawer(true, 'info');
      selectVerse(sel.sv);
      setTimeout(() => openNoteEditor({ book: S.book, chapter: S.chapter, verse: sel.sv, everse: sel.ev, version: sel.version, quote: sel.quote }, $('#infoNotes')), 50);
    } else if (btn.dataset.act === 'copy') {
      await navigator.clipboard.writeText(`${sel.quote}\n(${refText(S.book, S.chapter, sel.sv, sel.ev)}, ${sel.version})`);
      toast('복사했습니다');
    }
    window.getSelection().removeAllRanges();
    hideFloating();
  });
}

function captureSelection() {
  const s = window.getSelection();
  if (!s.rangeCount || s.isCollapsed) { $('#selbar').hidden = true; R.sel = null; return; }
  const r = s.getRangeAt(0);
  const paneEl = (r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement).closest('.pane');
  const p = R.panes.find(x => x.el === paneEl);
  if (!p || !['bible', 'strong'].includes(p.data?.kind)) { $('#selbar').hidden = true; return; }
  const verseOf = n => (n.nodeType === 1 ? n : n.parentElement).closest('.verse');
  let sEl = verseOf(r.startContainer), eEl = verseOf(r.endContainer);
  const verses = $$('.verse', p.content);
  if (!sEl) sEl = verses[0];
  if (!eEl) eEl = verses.at(-1);
  if (!sEl || !eEl) return;
  const sVt = $('.vt', sEl), eVt = $('.vt', eEl);
  let so = sVt.contains(r.startContainer) ? measure(sVt, r.startContainer, r.startOffset) : 0;
  let ev = +eEl.dataset.v, eo;
  if (eVt.contains(r.endContainer)) eo = measure(eVt, r.endContainer, r.endOffset);
  else { // 다음 절 번호에서 끝난 경우 → 앞 절 끝까지
    const prev = verses[verses.indexOf(eEl) - 1];
    if (!prev) { $('#selbar').hidden = true; return; }
    ev = +prev.dataset.v; eo = fullLen($('.vt', prev));
  }
  const sv = +sEl.dataset.v;
  if (sv > ev || (sv === ev && so >= eo)) { $('#selbar').hidden = true; return; }
  R.sel = { pane: p, version: p.cfg.version, sv, so, ev, eo, quote: s.toString().replace(/\s+/g, ' ').trim() };
  placeFloating($('#selbar'), r.getBoundingClientRect());
}

async function addHighlight(sel, color, style) {
  const h = await api('/api/highlights', {
    method: 'POST',
    body: { version: sel.version, book: S.book, chapter: S.chapter, sv: sel.sv, so: sel.so, ev: sel.ev, eo: sel.eo, color, style, quote: sel.quote },
  });
  R.highlights.push(h);
  R.panes.filter(p => p.cfg.version === h.version).forEach(p => paintHighlight(p, h));
}

function showHighlightPop(mark) {
  const id = +mark.dataset.hid;
  const h = R.highlights.find(x => x.id === id);
  if (!h) return;
  const pop = $('#pop');
  pop.innerHTML = `
    <div class="row">
      ${['yellow', 'green', 'blue', 'pink'].map(c => `<button class="sw ${c}${h.color === c ? ' cur' : ''}" data-c="${c}"></button>`).join('')}
      <span class="sep"></span>
      <button data-st="${h.style === 'ul' ? 'hl' : 'ul'}">${h.style === 'ul' ? '형광펜으로' : '<u>밑줄로</u>'}</button>
    </div>
    <div class="row" style="margin-top:4px">
      <button data-a="note">✎ 노트</button><button data-a="copy">복사</button><button data-a="del" style="color:#c0392b">삭제</button>
    </div>`;
  placeFloating(pop, mark.getBoundingClientRect());
  pop.onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.c || b.dataset.st) {
      const u = await api(`/api/highlights/${id}`, { method: 'PUT', body: b.dataset.c ? { color: b.dataset.c } : { style: b.dataset.st } });
      Object.assign(h, u);
      $$(`mark.h[data-hid="${id}"]`).forEach(m => (m.className = `h ${h.style === 'ul' ? 'ul ' : ''}${h.color}`));
    } else if (b.dataset.a === 'del') {
      await api(`/api/highlights/${id}`, { method: 'DELETE' });
      R.highlights = R.highlights.filter(x => x.id !== id);
      unpaint(id);
    } else if (b.dataset.a === 'note') {
      setDrawer(true, 'info');
      selectVerse(h.sv);
      setTimeout(() => openNoteEditor({ book: h.book, chapter: h.chapter, verse: h.sv, everse: h.ev, version: h.version, quote: h.quote, highlight_id: h.id }, $('#infoNotes')), 50);
    } else if (b.dataset.a === 'copy') {
      await navigator.clipboard.writeText(`${h.quote}\n(${refText(h.book, h.chapter, h.sv, h.ev)}, ${h.version})`);
      toast('복사했습니다');
    }
    pop.hidden = true;
  };
}

function placeFloating(el, rect) {
  el.hidden = false;
  if (el.id === 'selbar' && document.body.classList.contains('coarse')) { el.style.top = el.style.left = ''; return; }
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let top = rect.top - hgt - 8;
  if (top < 50) top = rect.bottom + 8;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
  el.style.top = top + 'px';
  el.style.left = left + 'px';
}

function hideFloating() { $('#selbar').hidden = true; $('#pop').hidden = true; }

/* ------------------------------------------------------------------ 클릭 위임 */
function setupGlobalClicks() {
  document.addEventListener('click', e => {
    const t = e.target;
    const sn = t.closest('.sn, .sl');
    if (sn) return showLex(sn.dataset.s);
    const num = t.closest('.num');
    if (num) return showLex(num.textContent.trim());
    const bref = t.closest('.bref');
    if (bref) { const [b, c, v] = bref.dataset.ref.split('.').map(Number); return goto(b, c, v); }
    const wl = t.closest('.wl');
    if (wl) return openWiki({ name: wl.dataset.wl });
    const vn = t.closest('.vn, .cv, .nmark');
    if (vn) {
      const v = +(vn.dataset.v || vn.closest('[data-v]').dataset.v);
      // 듣기 중이면 절 번호를 누른 곳부터 읽는다
      if (window.Player?.isOpen() && !vn.classList.contains('nmark')) {
        selectVerse(v);
        return Player.playFrom(R.panes.find(x => x.el === vn.closest('.pane')), v);
      }
      return selectVerse(v, { openInfo: true });
    }
    const mark = t.closest('mark.h');
    if (mark && window.getSelection().isCollapsed) return showHighlightPop(mark);
    if (!t.closest('#pop')) $('#pop').hidden = true;
    // 패널을 다시 그리면 클릭한 버튼이 문서에서 빠지므로 isConnected로 판별
    if (t.isConnected && !t.closest('#viewPanel, #viewBtn')) toggleViewPanel(false);
  });
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('.close')) $('#modal').hidden = true; });
}

function setupKeys() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideFloating(); toggleViewPanel(false); $('#modal').hidden = true; window.Player?.onEscape(); return; }
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowLeft') stepChapter(-1);
    else if (e.key === 'ArrowRight') stepChapter(1);
    else if (e.key === '/') { e.preventDefault(); $('#refInput').focus(); }
  });
}

/* ------------------------------------------------------------------ 지도 연표 */
async function renderMapsTab() {
  const box = $('section[data-tab="maps"]');
  box.innerHTML = '<p class="loading">…</p>';
  const list = await api('/api/maps');
  // 휴대폰은 같은 화면에서 열고(뒤로 가기로 복귀), PC는 새 탭으로 연다
  const target = document.body.classList.contains('coarse') ? '_self' : '_blank';
  box.innerHTML = '<p class="small" style="margin-top:0">위키 <code>3_Shared_Assets/Maps</code>의 지도 연표입니다.</p>' +
    (list.map(m => `
      <div class="card">
        <a class="ctitle" style="text-decoration:none" href="/maps/${enc(m.name)}" target="${target}">🗺 ${esc(m.title)}</a>
        <div class="small" style="margin-top:4px">${esc(m.name)} · ${m.updated} · ${Math.round(m.size / 1024)}KB
          ${m.kml ? ` · <a href="/maps/${enc(m.kml)}" download>KML</a>` : ''}</div>
      </div>`).join('') || '<p class="empty">지도 파일이 없습니다.</p>');
}

/* ------------------------------------------------------------------ 검색 */
async function runSearch() {
  const q = $('#searchQ').value.trim();
  if (!q) return;
  const v = $('#searchV').value;
  $('#searchV').dataset.touched = 1;
  let scope = $('#searchScope').value;
  if (scope === 'book') scope = 'b' + S.book;
  const out = $('#searchOut');
  out.innerHTML = '<p class="loading">검색 중…</p>';
  const d = await api(`/api/search?v=${enc(v)}&q=${enc(q)}&scope=${scope}`);
  const words = q.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  out.innerHTML = `<p class="small">${d.total.toLocaleString()}건${d.total > d.results.length ? ` (앞 ${d.results.length}건 표시)` : ''}</p>` +
    d.results.map(r => `<div class="sres" data-b="${r.b}" data-c="${r.c}" data-v="${r.v}"><b>${esc(refText(r.b, r.c, r.v))}</b>${esc(r.t).replace(re, '<em>$1</em>')}</div>`).join('');
  $$('.sres', out).forEach(el => (el.onclick = () => goto(+el.dataset.b, +el.dataset.c, +el.dataset.v)));
}

/* ------------------------------------------------------------------ 원어사전 */
async function showLex(code) {
  if (!code) return;
  setDrawer(true, 'lex');
  const box = $('section[data-tab="lex"]');
  box.innerHTML = '<p class="loading">…</p>';
  const d = await api(`/api/lex?s=${enc(code)}`);
  const parts = [['ko', '한글 원어사전'], ['en', 'Strong / Thayer']].filter(([k]) => d.entries[k]).map(([k, label]) => `
    <h3>${label}</h3><div class="lexhead">${esc(d.entries[k].lemma)}</div><div class="lexbody">${d.entries[k].html}</div>`);
  box.innerHTML = `<div class="ref-title">${esc(d.code)}</div>` + (parts.join('') || '<p class="empty">사전 항목이 없습니다.</p>');
}

/* ------------------------------------------------------------------ 위키 문서 */
async function openWiki(q) {
  const d = await api(`/api/wikidoc?${q.path ? 'path=' + enc(q.path) : 'name=' + enc(q.name)}`).catch(() => null);
  if (!d || d.error) return toast('위키 문서를 찾지 못했습니다');
  $('#modal .mtitle').textContent = d.path;
  $('#modal .mbody').innerHTML = markdown(d.text);
  $('#modal').hidden = false;
  $('#modal .mbody').scrollTop = 0;
}

function markdown(text) {
  let fm = '';
  if (text.startsWith('---')) {
    const e = text.indexOf('\n---', 3);
    if (e > 0) { fm = text.slice(3, e).trim(); text = text.slice(e + 4); }
  }
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[\[([^\]]+)\]\]/g, (m, a) => `<span class="wl" data-wl="${a}">${a.split('|').pop()}</span>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = text.split(/\r?\n/), out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush(); const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); i++; continue;
    }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)/))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(l)) {
      flush(); const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, '').replace(/^\[!(\w+)\]\s*/, (x, t) => `[${t}] `));
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`); continue;
    }
    if (/^\s*\|/.test(l)) {
      flush(); const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      out.push('<table>' + rows.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r, k) =>
        '<tr>' + r.trim().replace(/^\||\|$/g, '').split('|').map(c => `<${k ? 'td' : 'th'}>${inline(c.trim())}</${k ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>');
      continue;
    }
    if ((m = l.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/))) {
      flush(); const items = [];
      while (i < lines.length && (m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)/))) {
        const indent = Math.min(4, Math.floor(m[1].length / 2));
        items.push(`<li style="margin-left:${indent * 1.2}em">${inline(m[3].replace(/^\[ \]/, '☐').replace(/^\[x\]/i, '☑'))}</li>`); i++;
      }
      out.push(`<ul>${items.join('')}</ul>`); continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l); i++;
  }
  flush();
  return (fm ? `<details><summary class="small">문서 정보 (frontmatter)</summary><div class="fm">${esc(fm)}</div></details>` : '') + out.join('\n');
}
